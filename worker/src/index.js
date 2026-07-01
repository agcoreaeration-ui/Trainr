/**
 * Trainr API — Cloudflare Worker
 *
 * Bindings expected (set in wrangler.toml / dashboard):
 *  - DB: D1 database
 *  - ANTHROPIC_API_KEY: secret, set via `wrangler secret put ANTHROPIC_API_KEY`
 *  - INGEST_TOKEN: secret, shared token the Shortcuts automation sends to authenticate
 */

const CLAUDE_MODEL = "claude-sonnet-4-6";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function cors() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

async function callClaude(env, systemPrompt, userPrompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  const textBlock = data.content.find((c) => c.type === "text");
  return textBlock ? textBlock.text : "";
}

function stripJsonFence(text) {
  return text.replace(/```json\s*|```\s*/g, "").trim();
}

// ---------- Plan generation ----------

async function generatePlan(env, goal) {
  const today = new Date();
  const targetDate = goal.target_date ? new Date(goal.target_date) : null;
  const weeksRemaining = targetDate
    ? Math.max(4, Math.round((targetDate - today) / (7 * 24 * 60 * 60 * 1000)))
    : 8;

  // Pull recent run history for context on current fitness
  const recentRuns = await env.DB.prepare(
    `SELECT start_time, distance_km, avg_pace_min_per_km, avg_hr
     FROM runs ORDER BY start_time DESC LIMIT 20`
  ).all();

  const systemPrompt = `You are an experienced running coach. You write structured, safe, progressive training plans.
Always respond with ONLY valid JSON, no markdown fences, no preamble, matching this schema:
{
  "weeks": [
    {
      "week_number": 1,
      "week_start_date": "YYYY-MM-DD",
      "sessions": [
        { "day_of_week": "MON", "session_type": "easy|tempo|interval|long|rest|race",
          "target_distance_km": 5.0, "target_pace_min_per_km": 6.0, "description": "short human description" }
      ]
    }
  ]
}
Follow standard periodization: base, build, peak, taper. Respect the runner's current fitness from their recent run history — don't prescribe volume they haven't earned. Include rest/easy days between hard sessions. If target_date implies a taper is needed, include one.`;

  const userPrompt = `Goal: ${goal.type} on ${goal.target_date || "no fixed date"}, target time: ${
    goal.target_time || "none specified"
  }.
Weeks available: ${weeksRemaining}.
Plan should start the week of: ${today.toISOString().slice(0, 10)}.

Recent run history (most recent first, may be sparse):
${JSON.stringify(recentRuns.results)}

Generate the full week-by-week plan now as JSON only.`;

  const raw = await callClaude(env, systemPrompt, userPrompt);
  const plan = JSON.parse(stripJsonFence(raw));

  // Persist
  const stmts = [];
  for (const week of plan.weeks) {
    for (const s of week.sessions) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO training_plan
           (goal_id, week_number, week_start_date, day_of_week, session_type, target_distance_km, target_pace_min_per_km, description)
           VALUES (?,?,?,?,?,?,?,?)`
        ).bind(
          goal.id,
          week.week_number,
          week.week_start_date,
          s.day_of_week,
          s.session_type,
          s.target_distance_km ?? null,
          s.target_pace_min_per_km ?? null,
          s.description ?? null
        )
      );
    }
  }
  await env.DB.batch(stmts);
  return plan;
}

// ---------- Weekly review / adjustment ----------

async function weeklyReview(env, goal) {
  const planned = await env.DB.prepare(
    `SELECT * FROM training_plan WHERE goal_id = ? AND week_start_date <= date('now') AND week_start_date > date('now', '-7 days')`
  )
    .bind(goal.id)
    .all();

  const actualRuns = await env.DB.prepare(
    `SELECT * FROM runs WHERE start_time >= date('now', '-7 days') ORDER BY start_time`
  ).all();

  const upcoming = await env.DB.prepare(
    `SELECT * FROM training_plan WHERE goal_id = ? AND week_start_date > date('now') ORDER BY week_start_date, day_of_week LIMIT 14`
  )
    .bind(goal.id)
    .all();

  const systemPrompt = `You are an experienced running coach reviewing a runner's last 7 days against their plan.
Respond with ONLY valid JSON:
{
  "feedback": "2-4 sentences, direct and specific, written to the runner",
  "adjustments": [
    { "training_plan_id": 123, "target_distance_km": 8.0, "target_pace_min_per_km": 6.2, "description": "updated description" }
  ]
}
Only include entries in "adjustments" for sessions that should change based on how the last week went (fatigue, missed sessions, pace drift, faster-than-expected progress). Leave "adjustments" empty if the plan is on track as-is. Be conservative — don't overreact to a single bad or great run.`;

  const userPrompt = `Planned sessions this past week:
${JSON.stringify(planned.results)}

Actual runs completed this past week:
${JSON.stringify(actualRuns.results)}

Upcoming planned sessions (next 2 weeks, may need adjusting):
${JSON.stringify(upcoming.results)}

Review and respond with JSON only.`;

  const raw = await callClaude(env, systemPrompt, userPrompt);
  const result = JSON.parse(stripJsonFence(raw));

  for (const adj of result.adjustments || []) {
    await env.DB.prepare(
      `UPDATE training_plan SET target_distance_km = ?, target_pace_min_per_km = ?, description = ?, status = 'adjusted' WHERE id = ?`
    )
      .bind(adj.target_distance_km ?? null, adj.target_pace_min_per_km ?? null, adj.description ?? null, adj.training_plan_id)
      .run();
  }

  await env.DB.prepare(
    `INSERT INTO coach_feedback (goal_id, feedback_text, plan_adjusted) VALUES (?,?,?)`
  )
    .bind(goal.id, result.feedback, (result.adjustments || []).length > 0 ? 1 : 0)
    .run();

  return result;
}

// ---------- Route handlers ----------

async function handleIngest(req, env) {
  const auth = req.headers.get("Authorization") || "";
  if (auth !== `Bearer ${env.INGEST_TOKEN}`) {
    return json({ error: "unauthorized" }, 401);
  }
  const body = await req.json();
  // Expected from Shortcuts: start_time, duration_sec, distance_km, avg_pace_min_per_km, avg_hr, max_hr, splits (array)
  const result = await env.DB.prepare(
    `INSERT INTO runs (start_time, duration_sec, distance_km, avg_pace_min_per_km, avg_hr, max_hr, splits_json)
     VALUES (?,?,?,?,?,?,?)`
  )
    .bind(
      body.start_time,
      body.duration_sec ?? null,
      body.distance_km ?? null,
      body.avg_pace_min_per_km ?? null,
      body.avg_hr ?? null,
      body.max_hr ?? null,
      JSON.stringify(body.splits ?? [])
    )
    .run();

  const runId = result.meta.last_row_id;

  // Try to match this run to a planned session for today
  const today = new Date(body.start_time).toISOString().slice(0, 10);
  await env.DB.prepare(
    `UPDATE training_plan SET status = 'completed', run_id = ?
     WHERE week_start_date <= ? AND status = 'planned'
     AND date(week_start_date, '+' || (CASE day_of_week
        WHEN 'MON' THEN 0 WHEN 'TUE' THEN 1 WHEN 'WED' THEN 2 WHEN 'THU' THEN 3
        WHEN 'FRI' THEN 4 WHEN 'SAT' THEN 5 WHEN 'SUN' THEN 6 END) || ' days') = ?`
  )
    .bind(runId, today, today)
    .run();

  return json({ ok: true, run_id: runId });
}

async function handleGoalsList(env) {
  const goals = await env.DB.prepare(`SELECT * FROM goals ORDER BY created_at DESC`).all();
  return json(goals.results);
}

async function handleGoalCreate(req, env, ctx) {
  const body = await req.json();
  const result = await env.DB.prepare(
    `INSERT INTO goals (type, target_date, target_time, status, notes) VALUES (?,?,?,?,?)`
  )
    .bind(body.type, body.target_date ?? null, body.target_time ?? null, "active", body.notes ?? null)
    .run();

  const goalId = result.meta.last_row_id;
  const goal = { id: goalId, ...body };

  // Generate the plan asynchronously-ish (still within request for simplicity;
  // move to a queue if this starts timing out)
  const plan = await generatePlan(env, goal);
  return json({ ok: true, goal_id: goalId, weeks_generated: plan.weeks.length });
}

async function handlePlanCurrent(env) {
  const plan = await env.DB.prepare(
    `SELECT tp.* FROM training_plan tp
     JOIN goals g ON g.id = tp.goal_id
     WHERE g.status = 'active' AND tp.week_start_date <= date('now') AND tp.week_start_date > date('now', '-7 days')
     ORDER BY tp.day_of_week`
  ).all();
  return json(plan.results);
}

async function handleRunsList(env) {
  const runs = await env.DB.prepare(`SELECT * FROM runs ORDER BY start_time DESC LIMIT 50`).all();
  return json(runs.results);
}

async function handleFeedbackList(env) {
  const feedback = await env.DB.prepare(
    `SELECT * FROM coach_feedback ORDER BY created_at DESC LIMIT 20`
  ).all();
  return json(feedback.results);
}

async function handleReviewTrigger(env) {
  const goal = await env.DB.prepare(`SELECT * FROM goals WHERE status = 'active' LIMIT 1`).first();
  if (!goal) return json({ error: "no active goal" }, 400);
  const result = await weeklyReview(env, goal);
  return json(result);
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === "OPTIONS") return cors();

    const url = new URL(req.url);
    const { pathname } = url;

    try {
      if (pathname === "/api/ingest" && req.method === "POST") return await handleIngest(req, env);
      if (pathname === "/api/goals" && req.method === "GET") return await handleGoalsList(env);
      if (pathname === "/api/goals" && req.method === "POST") return await handleGoalCreate(req, env, ctx);
      if (pathname === "/api/plan/current" && req.method === "GET") return await handlePlanCurrent(env);
      if (pathname === "/api/runs" && req.method === "GET") return await handleRunsList(env);
      if (pathname === "/api/feedback" && req.method === "GET") return await handleFeedbackList(env);
      if (pathname === "/api/review/weekly" && req.method === "POST") return await handleReviewTrigger(env);

      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },

  // Cron trigger — configure in wrangler.toml, e.g. weekly Sunday 20:00 local
  async scheduled(event, env, ctx) {
    const goal = await env.DB.prepare(`SELECT * FROM goals WHERE status = 'active' LIMIT 1`).first();
    if (goal) ctx.waitUntil(weeklyReview(env, goal));
  },
};
