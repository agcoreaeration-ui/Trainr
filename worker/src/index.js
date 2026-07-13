/**
 * Trainr API — Cloudflare Worker
 *
 * Bindings expected (set in wrangler.toml / dashboard):
 *  - DB: D1 database
 *  - ANTHROPIC_API_KEY: secret, set via `wrangler secret put ANTHROPIC_API_KEY`
 *  - INGEST_TOKEN: secret, shared token the Shortcuts automation sends to authenticate
 */

const CLAUDE_MODEL = "claude-sonnet-5";

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

async function callClaude(env, systemPrompt, userPrompt, maxTokens = 4000) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
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

const WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// Llama does the heavy lifting (free, within Workers AI's daily quota) — full plan
// generation and weekly analysis both go through here, with JSON Mode enforcing
// a schema so we don't get the "invalid JSON" failures we used to get from free-text output.
async function callWorkersAI(env, systemPrompt, userPrompt, jsonSchema, maxTokens = 4096) {
  const attempt = async () => {
    const response = await env.AI.run(WORKERS_AI_MODEL, {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_schema", json_schema: jsonSchema },
      max_tokens: maxTokens,
    });
    let raw = response?.response ?? response;
    if (typeof raw === "string") {
      return JSON.parse(stripJsonFence(raw));
    }
    return raw;
  };

  // Workers AI occasionally throws transient internal/upstream errors — retry a
  // couple of times with a short backoff before giving up, rather than failing
  // the whole plan generation on a one-off platform blip.
  const MAX_ATTEMPTS = 3;
  let lastErr;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    try {
      return await attempt();
    } catch (e) {
      lastErr = e;
      console.error(`Workers AI call failed (attempt ${i + 1}/${MAX_ATTEMPTS}):`, e.message);
      if (i < MAX_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)));
      }
    }
  }
  throw new Error(`Workers AI (Llama) failed after ${MAX_ATTEMPTS} attempts: ${lastErr.message}`);
}

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    weeks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          week_number: { type: "integer" },
          sessions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                day_of_week: { type: "string", enum: ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] },
                session_type: { type: "string", enum: ["easy", "tempo", "interval", "long", "rest", "race"] },
                target_distance_km: { type: "number" },
                target_pace_min_per_km: { type: "number" },
                description: { type: "string" },
              },
              required: ["day_of_week", "session_type", "target_distance_km", "target_pace_min_per_km", "description"],
            },
          },
        },
        required: ["week_number", "sessions"],
      },
    },
  },
  required: ["weeks"],
};

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    feedback_draft: { type: "string" },
    adjustments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          training_plan_id: { type: "integer" },
          target_distance_km: { type: "number" },
          target_pace_min_per_km: { type: "number" },
          description: { type: "string" },
        },
        required: ["training_plan_id"],
      },
    },
  },
  required: ["feedback_draft", "adjustments"],
};

const RUN_COMMENT_SCHEMA = {
  type: "object",
  properties: { comment: { type: "string" } },
  required: ["comment"],
};

async function generateRunComment(env, run, matchedSession) {
  const systemPrompt = `You are a supportive, direct running coach. Write one short comment (1-2 sentences) on a single completed run. Compare it to the planned session if one is given. Be specific — reference the actual pace/distance/effort — and honest, not just generic encouragement.`;
  const sessionContext = matchedSession
    ? `Planned session: ${matchedSession.session_type}, target ${matchedSession.target_distance_km}km @ ${matchedSession.target_pace_min_per_km} min/km — "${matchedSession.description}"`
    : `This run wasn't matched to a specific planned session (may be an extra or unplanned run).`;
  const userPrompt = `Completed run:
Distance: ${run.distance_km != null ? run.distance_km.toFixed(2) : "?"}km
Duration: ${run.duration_sec ?? "?"}s
Avg pace: ${run.avg_pace_min_per_km != null ? run.avg_pace_min_per_km.toFixed(2) : "?"} min/km
Avg HR: ${run.avg_hr ?? "not recorded"}
Max HR: ${run.max_hr ?? "not recorded"}

${sessionContext}

Give a short, specific coach's comment on this run now.`;
  const result = await callWorkersAI(env, systemPrompt, userPrompt, RUN_COMMENT_SCHEMA, 300);
  return result?.comment ? result.comment.trim() : null;
}

// ---------- Plan generation ----------

async function generatePlan(env, goal) {
  const today = todayMelbourne();
  const targetDate = goal.target_date ? new Date(goal.target_date + "T00:00:00Z") : null;

  const RACE_DISTANCE_KM = { "5k": 5, "10k": 10, half: 21.1, full: 42.2 };

  // Compute exactly which week_number and day_of_week the race actually falls on,
  // by comparing calendar Mondays — deterministic, not left for the AI to calculate
  // (LLMs are unreliable at multi-step date arithmetic, especially split across chunks).
  let weeksRemaining;
  let raceWeekNumber = null;
  let raceDayOfWeek = null;
  if (targetDate) {
    const planStartMonday = mondayOf(today);
    const targetMonday = mondayOf(targetDate);
    const weeksBetweenMondays = Math.round((targetMonday - planStartMonday) / (7 * 24 * 60 * 60 * 1000));
    raceWeekNumber = Math.max(1, weeksBetweenMondays + 1);
    raceDayOfWeek = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][targetDate.getUTCDay()];
    weeksRemaining = Math.max(4, raceWeekNumber);
  } else {
    weeksRemaining = 8;
  }
  const raceDistanceKm = RACE_DISTANCE_KM[goal.type] ?? null;

  // Pull recent run history for context on current fitness
  const recentRuns = await env.DB.prepare(
    `SELECT start_time, distance_km, avg_pace_min_per_km, avg_hr
     FROM runs ORDER BY start_time DESC LIMIT 20`
  ).all();

  const todayDow = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][today.getDay()];
  const remainingDaysThisWeek = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"].slice(
    ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"].indexOf(todayDow)
  );

  // Generate a few weeks at a time rather than the whole plan in one call — a full
  // 12-14 week structured/schema-validated response is slow enough to hit Workers AI's
  // internal request timeout. Smaller chunks finish comfortably and get stitched together.
  const CHUNK_SIZE = 4;
  const allWeeks = [];
  let progressSoFar = "This is the first chunk — no prior weeks generated yet.";

  for (let chunkStart = 1; chunkStart <= weeksRemaining; chunkStart += CHUNK_SIZE) {
    const chunkEnd = Math.min(chunkStart + CHUNK_SIZE - 1, weeksRemaining);
    const isFirstChunk = chunkStart === 1;

    const weekConstraint = isFirstChunk
      ? `Week 1 is a partial week starting today, not a full Monday-Sunday week. Week 1 must contain a session entry for EXACTLY these days, in this order, and no others: ${remainingDaysThisWeek.join(
          ", "
        )}. Do not include any day before today in week 1. Every other week in this batch (weeks ${chunkStart + 1}-${chunkEnd}) must be a complete Monday-through-Sunday week.`
      : `Every week in this batch (weeks ${chunkStart}-${chunkEnd}) must be a complete Monday-through-Sunday week, all 7 days.`;

    const raceInThisChunk = raceWeekNumber != null && raceWeekNumber >= chunkStart && raceWeekNumber <= chunkEnd;
    const raceConstraint = raceInThisChunk
      ? `CRITICAL — the race falls in week ${raceWeekNumber}, on ${raceDayOfWeek}, in THIS batch. Week ${raceWeekNumber} must include exactly one session with session_type "race" on ${raceDayOfWeek}${
          raceDistanceKm ? ` with target_distance_km exactly ${raceDistanceKm}` : ""
        }. This is the final week of the entire plan — do not generate any weeks after ${raceWeekNumber}. The days in week ${raceWeekNumber} before ${raceDayOfWeek} should be a short taper (easy/rest only, no hard sessions).`
      : `Do not include any session with session_type "race" in this batch — the race is not in these weeks.`;

    const systemPrompt = `You are an experienced running coach. You write structured, safe, progressive training plans, one batch of weeks at a time.
Follow standard periodization: base, build, peak, taper. If the runner states their current weekly volume or fitness in the notes, trust that over sparse run history — don't default to a conservative "beginner" template just because logged history is thin. The peak long run across the whole plan should reach roughly 75-85% of the race distance (e.g. ~16-18km for a half marathon) unless the runner's notes indicate that's unsafe. Include rest/easy days between hard sessions, use a 3:1 build:recovery week pattern.

${weekConstraint}
${raceConstraint}
Generate ONLY weeks with week_number ${chunkStart} through ${chunkEnd} — no other weeks.`;

    const userPrompt = `Goal: ${goal.type} on ${goal.target_date || "no fixed date"}, target time: ${
      goal.target_time || "none specified"
    }.
Total plan length: ${weeksRemaining} weeks (week ${raceWeekNumber ?? weeksRemaining} is race week). This batch covers weeks ${chunkStart}-${chunkEnd} only.
Today is ${todayDow}, ${today.toISOString().slice(0, 10)}.

Runner's own notes on current fitness (trust this over sparse logged history if they conflict):
${goal.notes || "none provided"}

Recent run history in Trainr (most recent first, may be sparse/incomplete — don't treat a short list as the runner's full fitness picture):
${JSON.stringify(recentRuns.results)}

Progress so far in this plan: ${progressSoFar}

Generate weeks ${chunkStart}-${chunkEnd} now.`;

    const chunkPlan = await callWorkersAI(env, systemPrompt, userPrompt, PLAN_SCHEMA);
    if (!chunkPlan || !Array.isArray(chunkPlan.weeks) || chunkPlan.weeks.length === 0) {
      throw new Error(`Llama returned an empty or malformed plan for weeks ${chunkStart}-${chunkEnd}`);
    }
    allWeeks.push(...chunkPlan.weeks);

    const lastWeek = chunkPlan.weeks[chunkPlan.weeks.length - 1];
    const lastWeekKm = lastWeek.sessions.reduce((sum, s) => sum + (s.target_distance_km || 0), 0);
    const lastWeekLong = Math.max(
      0,
      ...lastWeek.sessions.map((s) => (s.session_type === "long" ? s.target_distance_km : 0))
    );
    progressSoFar = `Through week ${lastWeek.week_number}: ~${lastWeekKm.toFixed(1)}km that week, longest run ${lastWeekLong.toFixed(
      1
    )}km. Continue progressing sensibly from there.`;
  }

  let plan = { weeks: allWeeks };

  // Safety net — Llama doesn't always perfectly follow instructions. Force-correct
  // two things we know deterministically from code: no race session outside the
  // real race week, and no weeks generated past it.
  if (raceWeekNumber != null) {
    plan.weeks = plan.weeks
      .filter((w) => w.week_number <= raceWeekNumber)
      .map((w) => {
        if (w.week_number === raceWeekNumber) return w;
        // Not race week — demote any stray "race" session type to "long" so it doesn't
        // silently vanish, just stops being mislabeled as the race.
        return {
          ...w,
          sessions: w.sessions.map((s) => (s.session_type === "race" ? { ...s, session_type: "long" } : s)),
        };
      });
  }

  // Persist — delete any existing not-yet-run sessions for this goal and insert the
  // fresh plan in ONE atomic batch, so two overlapping requests can't race each other.
  const planStartMonday = mondayOf(today);

  const existingCompleted = await env.DB.prepare(
    `SELECT session_date FROM training_plan WHERE goal_id = ? AND status = 'completed'`
  )
    .bind(goal.id)
    .all();
  const completedDates = new Set(existingCompleted.results.map((r) => r.session_date));

  const stmts = [
    env.DB.prepare(`DELETE FROM training_plan WHERE goal_id = ? AND status = 'planned'`).bind(goal.id),
  ];
  for (const week of plan.weeks) {
    const weekMonday = addDays(planStartMonday, (week.week_number - 1) * 7);
    const weekStartDateStr = toYMD(weekMonday);
    for (const s of week.sessions) {
      const offset = DAY_OFFSET[s.day_of_week] ?? 0;
      const sessionDateStr = toYMD(addDays(weekMonday, offset));
      if (completedDates.has(sessionDateStr)) continue; // already actually run — don't overlay a planned duplicate
      stmts.push(
        env.DB.prepare(
          `INSERT INTO training_plan
           (goal_id, week_number, week_start_date, session_date, day_of_week, session_type, target_distance_km, target_pace_min_per_km, description)
           VALUES (?,?,?,?,?,?,?,?,?)`
        ).bind(
          goal.id,
          week.week_number,
          weekStartDateStr,
          sessionDateStr,
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

  // Small Claude pass: NOT the full plan, just a condensed per-week summary,
  // so this stays a handful of cents at most rather than a full-plan-sized call.
  try {
    const weekSummaries = plan.weeks.map((w) => {
      const totalKm = w.sessions.reduce((sum, s) => sum + (s.target_distance_km || 0), 0);
      const longRun = Math.max(0, ...w.sessions.map((s) => (s.session_type === "long" ? s.target_distance_km : 0)));
      return `Week ${w.week_number}: ${totalKm.toFixed(1)}km total, longest run ${longRun.toFixed(1)}km`;
    });
    const reviewPrompt = `A training plan was just drafted for a runner. Goal: ${goal.type} on ${
      goal.target_date || "no fixed date"
    }. Runner's notes: ${goal.notes || "none"}.

Week-by-week summary:
${weekSummaries.join("\n")}

In 2-3 sentences, give a direct coach's take: confirm this looks appropriately scaled for the goal, or flag one specific concern (e.g. volume too low/high, peak long run too short relative to race distance, missing taper) if something looks off.`;
    const coachNote = await callClaude(
      env,
      "You are a concise, direct running coach reviewing a colleague's drafted plan.",
      reviewPrompt,
      300
    );
    // A new plan replaces the old one, so its review should too — an old "plan review"
    // describing numbers that no longer exist is actively misleading, not just clutter.
    await env.DB.prepare(`DELETE FROM coach_feedback WHERE goal_id = ? AND feedback_type = 'plan_review'`)
      .bind(goal.id)
      .run();
    await env.DB.prepare(
      `INSERT INTO coach_feedback (goal_id, feedback_text, feedback_type, plan_adjusted) VALUES (?,?,'plan_review',0)`
    )
      .bind(goal.id, coachNote.trim())
      .run();
  } catch (e) {
    // Non-fatal — the plan itself already saved successfully, the coach's note is a bonus
    console.error("Coach review pass failed (non-fatal):", e.message);
  }

  return plan;
}

// ---------- Weekly review / adjustment ----------

async function weeklyReview(env, goal) {
  const today = todayMelbourne();
  const thisMonday = mondayOf(today);
  const lastMonday = addDays(thisMonday, -7);
  const lastSunday = addDays(thisMonday, -1);
  const upcomingEnd = addDays(thisMonday, 20);

  const planned = await env.DB.prepare(
    `SELECT * FROM training_plan WHERE goal_id = ? AND session_date BETWEEN ? AND ?`
  )
    .bind(goal.id, toYMD(lastMonday), toYMD(lastSunday))
    .all();

  const actualRuns = await env.DB.prepare(
    `SELECT * FROM runs WHERE start_time >= ? ORDER BY start_time`
  )
    .bind(toYMD(lastMonday))
    .all();

  const upcoming = await env.DB.prepare(
    `SELECT * FROM training_plan WHERE goal_id = ? AND session_date > ? AND session_date <= ? ORDER BY session_date`
  )
    .bind(goal.id, toYMD(today), toYMD(upcomingEnd))
    .all();

  const systemPrompt = `You are an experienced running coach reviewing a runner's last 7 days against their plan.
Write a draft of 2-4 sentences of direct, specific feedback for the runner in "feedback_draft". Only include entries in "adjustments" for sessions that should change based on how the last week went (fatigue, missed sessions, pace drift, faster-than-expected progress). Leave "adjustments" empty if the plan is on track as-is. Be conservative — don't overreact to a single bad or great run.`;

  const userPrompt = `Planned sessions this past week:
${JSON.stringify(planned.results)}

Actual runs completed this past week:
${JSON.stringify(actualRuns.results)}

Upcoming planned sessions (next 2 weeks, may need adjusting):
${JSON.stringify(upcoming.results)}

Review and respond now.`;

  const result = await callWorkersAI(env, systemPrompt, userPrompt, REVIEW_SCHEMA);
  if (!result || typeof result.feedback_draft !== "string") {
    throw new Error("Llama returned an empty or malformed weekly review");
  }

  for (const adj of result.adjustments || []) {
    await env.DB.prepare(
      `UPDATE training_plan SET target_distance_km = ?, target_pace_min_per_km = ?, description = ?, status = 'adjusted' WHERE id = ?`
    )
      .bind(adj.target_distance_km ?? null, adj.target_pace_min_per_km ?? null, adj.description ?? null, adj.training_plan_id)
      .run();
  }

  // Small Claude pass: just polish the draft text itself, not re-analyze the raw data —
  // tiny input/output, a fraction of a cent, not a full-context call.
  let finalFeedback = result.feedback_draft;
  try {
    finalFeedback = await callClaude(
      env,
      "You are a running coach. Rewrite the following draft feedback to be tighter, warmer, and more direct — 2-4 sentences, same substance, better delivery. Return only the rewritten text, nothing else.",
      result.feedback_draft,
      250
    );
    finalFeedback = finalFeedback.trim();
  } catch (e) {
    console.error("Claude polish pass failed (non-fatal, using Llama's draft):", e.message);
  }

  await env.DB.prepare(
    `INSERT INTO coach_feedback (goal_id, feedback_text, feedback_type, plan_adjusted) VALUES (?,?,'weekly_review',?)`
  )
    .bind(goal.id, finalFeedback, (result.adjustments || []).length > 0 ? 1 : 0)
    .run();

  return { feedback: finalFeedback, adjustments: result.adjustments || [] };
}

// ---------- Route handlers ----------

function haeQty(field) {
  if (field == null) return null;
  if (typeof field === "number") return field;
  if (typeof field === "object" && typeof field.qty === "number") return field.qty;
  return null;
}

function haeDateToIso(dateStr) {
  // "2026-07-01 13:13:46 +1000" -> "2026-07-01T13:13:46+10:00"
  if (!dateStr) return null;
  const m = dateStr.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/);
  if (!m) return dateStr;
  return `${m[1]}T${m[2]}${m[3]}:${m[4]}`;
}

const DAY_OFFSET = { MON: 0, TUE: 1, WED: 2, THU: 3, FRI: 4, SAT: 5, SUN: 6 };

// Cloudflare Workers run on UTC. Melbourne is UTC+10/+11, so naively using `new Date()`
// for "today" would be wrong for part of every morning (Worker still thinks it's
// yesterday). This returns a Date whose Y/M/D matches Melbourne's actual calendar day.
function todayMelbourne() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(new Date());
  const y = parts.find((p) => p.type === "year").value;
  const m = parts.find((p) => p.type === "month").value;
  const d = parts.find((p) => p.type === "day").value;
  return new Date(`${y}-${m}-${d}T00:00:00Z`);
}

function mondayOf(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function toYMD(date) {
  return date.toISOString().slice(0, 10);
}

async function handleIngest(req, env) {
  const auth = req.headers.get("Authorization") || "";
  if (auth !== `Bearer ${env.INGEST_TOKEN}`) {
    return json({ error: "unauthorized" }, 401);
  }
  const body = await req.json();
  const workouts = body?.data?.workouts || body?.workouts || (Array.isArray(body) ? body : []);

  let inserted = 0;
  let skipped = 0;

  for (const w of workouts) {
    const name = (w.name || "").toLowerCase();
    if (!name.includes("run")) {
      skipped++;
      continue;
    }

    const distanceKm = haeQty(w.distance);
    const durationSec = typeof w.duration === "number" ? Math.round(w.duration) : null;
    const avgHrRaw = haeQty(w.avgHeartRate);
    const maxHrRaw = haeQty(w.maxHeartRate);
    const avgHr = avgHrRaw != null ? Math.round(avgHrRaw) : null;
    const maxHr = maxHrRaw != null ? Math.round(maxHrRaw) : null;

    if (avgHr == null || maxHr == null) {
      // Temporary diagnostic — log every key on the workout whose name suggests it's
      // heart-rate related, so we can see the actual field name/shape without guessing.
      const hrLikeKeys = Object.keys(w).filter((k) => k.toLowerCase().includes("heart"));
      const hrLikeValues = {};
      for (const k of hrLikeKeys) hrLikeValues[k] = w[k];
      console.error(
        `HR MISSING for workout "${w.name}" (${w.start}): avgHeartRate=${JSON.stringify(
          w.avgHeartRate
        )}, maxHeartRate=${JSON.stringify(w.maxHeartRate)}, all HR-like keys:`,
        JSON.stringify(hrLikeValues).slice(0, 1500)
      );
    }

    const paceMinPerKm =
      distanceKm && distanceKm > 0 && durationSec ? durationSec / 60 / distanceKm : null;
    const startTime = haeDateToIso(w.start);
    const externalId = w.id || null;

    const result = await env.DB.prepare(
      `INSERT OR IGNORE INTO runs
       (start_time, duration_sec, distance_km, avg_pace_min_per_km, avg_hr, max_hr, splits_json, external_id)
       VALUES (?,?,?,?,?,?,?,?)`
    )
      .bind(startTime, durationSec, distanceKm, paceMinPerKm, avgHr, maxHr, "[]", externalId)
      .run();

    if (result.meta.changes > 0) {
      inserted++;
      const runId = result.meta.last_row_id;
      const dayOnly = startTime ? startTime.slice(0, 10) : null;
      let matchedSession = null;
      if (dayOnly) {
        // Only match against the currently active goal's plan — a missing filter here
        // meant any goal (even archived ones) with a matching session_date could get
        // marked completed, not just the one actually in use.
        matchedSession = await env.DB.prepare(
          `SELECT tp.* FROM training_plan tp
           JOIN goals g ON g.id = tp.goal_id
           WHERE g.status = 'active' AND tp.session_date = ? AND tp.status = 'planned'`
        )
          .bind(dayOnly)
          .first();
        if (matchedSession) {
          await env.DB.prepare(
            `UPDATE training_plan SET status = 'completed', run_id = ? WHERE id = ?`
          )
            .bind(runId, matchedSession.id)
            .run();
        }
      }

      // Small Workers AI (free) pass: a short coach's comment on this specific run.
      try {
        const runRow = await env.DB.prepare(`SELECT * FROM runs WHERE id = ?`).bind(runId).first();
        const comment = await generateRunComment(env, runRow, matchedSession);
        if (comment) {
          const activeGoal = await env.DB.prepare(`SELECT id FROM goals WHERE status = 'active' LIMIT 1`).first();
          await env.DB.prepare(
            `INSERT INTO coach_feedback (goal_id, run_id, feedback_text, feedback_type, plan_adjusted) VALUES (?,?,?,'run_review',0)`
          )
            .bind(activeGoal?.id ?? null, runId, comment)
            .run();
        }
      } catch (e) {
        console.error("Run comment generation failed (non-fatal):", e.message);
      }
    } else {
      skipped++; // already existed (duplicate external_id)
    }
  }

  return json({ ok: true, inserted, skipped, totalReceived: workouts.length });
}

async function handleGoalsList(env) {
  const goals = await env.DB.prepare(`SELECT * FROM goals ORDER BY created_at DESC`).all();
  return json(goals.results);
}

async function handleGoalCreate(req, env, ctx) {
  const body = await req.json();

  // Only one goal should be active at a time — archive any existing active goals first
  await env.DB.prepare(`UPDATE goals SET status = 'archived' WHERE status = 'active'`).run();

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

async function handleGoalRegenerate(req, env, goalId) {
  const body = await req.json().catch(() => ({}));
  const goal = await env.DB.prepare(`SELECT * FROM goals WHERE id = ?`).bind(goalId).first();
  if (!goal) return json({ error: "goal not found" }, 404);

  if (typeof body.notes === "string") {
    await env.DB.prepare(`UPDATE goals SET notes = ? WHERE id = ?`).bind(body.notes, goalId).run();
    goal.notes = body.notes;
  }

  const plan = await generatePlan(env, goal);
  return json({ ok: true, weeks_generated: plan.weeks.length });
}

async function handlePlanCurrent(env) {
  const monday = mondayOf(todayMelbourne());
  const sunday = addDays(monday, 6);
  const plan = await env.DB.prepare(
    `SELECT tp.* FROM training_plan tp
     JOIN goals g ON g.id = tp.goal_id
     WHERE g.status = 'active'
     AND tp.session_date BETWEEN ? AND ?
     ORDER BY tp.session_date`
  )
    .bind(toYMD(monday), toYMD(sunday))
    .all();
  return json(plan.results);
}

async function handlePlanFull(env) {
  const plan = await env.DB.prepare(
    `SELECT tp.* FROM training_plan tp
     JOIN goals g ON g.id = tp.goal_id
     WHERE g.status = 'active'
     ORDER BY tp.session_date`
  ).all();
  return json(plan.results);
}

async function handleRunsList(env) {
  const runs = await env.DB.prepare(`SELECT * FROM runs ORDER BY start_time DESC LIMIT 50`).all();
  return json(runs.results);
}

async function handlePBs(env) {
  const allRuns = await env.DB.prepare(`SELECT * FROM runs ORDER BY start_time ASC`).all();
  const runs = allRuns.results;

  // PBs are computed from whole runs close to the target distance, with time normalized
  // to the exact distance via pace — this is how most PB trackers work, and it's what's
  // actually derivable from whole-run summary data (no lap/split-level GPS data captured yet,
  // so true "fastest 1km/mile within a longer run" isn't supported).
  const DISTANCE_TARGETS = [
    { key: "5k", label: "5K", target: 5, tolerance: 0.08 },
    { key: "10k", label: "10K", target: 10, tolerance: 0.05 },
    { key: "half", label: "Half Marathon", target: 21.1, tolerance: 0.03 },
  ];

  const pbs = DISTANCE_TARGETS.map((d) => {
    const candidates = runs.filter(
      (r) =>
        r.distance_km != null &&
        r.avg_pace_min_per_km != null &&
        r.distance_km >= d.target * (1 - d.tolerance) &&
        r.distance_km <= d.target * (1 + d.tolerance)
    );
    if (candidates.length === 0) {
      return { key: d.key, label: d.label, achieved: false };
    }
    const best = candidates.reduce((a, b) => (a.avg_pace_min_per_km < b.avg_pace_min_per_km ? a : b));
    return {
      key: d.key,
      label: d.label,
      achieved: true,
      run_id: best.id,
      date: best.start_time,
      actual_distance_km: best.distance_km,
      avg_pace_min_per_km: best.avg_pace_min_per_km,
      estimated_time_sec: Math.round(best.avg_pace_min_per_km * d.target * 60),
    };
  });

  let longestRun = null;
  for (const r of runs) {
    if (r.distance_km != null && (!longestRun || r.distance_km > longestRun.distance_km)) {
      longestRun = r;
    }
  }

  const weekTotals = {};
  for (const r of runs) {
    if (r.distance_km == null) continue;
    const wk = toYMD(mondayOf(new Date(r.start_time.slice(0, 10) + "T00:00:00Z")));
    weekTotals[wk] = (weekTotals[wk] || 0) + r.distance_km;
  }
  let bestWeek = null;
  for (const [wk, km] of Object.entries(weekTotals)) {
    if (!bestWeek || km > bestWeek.km) bestWeek = { week_start: wk, km };
  }

  const runDates = new Set(runs.map((r) => r.start_time.slice(0, 10)));
  let streak = 0;
  let cursor = todayMelbourne();
  if (!runDates.has(toYMD(cursor))) {
    cursor = addDays(cursor, -1); // no run yet today doesn't break an ongoing streak
  }
  while (runDates.has(toYMD(cursor))) {
    streak++;
    cursor = addDays(cursor, -1);
  }

  return json({ pbs, longest_run: longestRun, best_week: bestWeek, current_streak: streak });
}

async function handleFeedbackList(env) {
  const feedback = await env.DB.prepare(
    `SELECT cf.* FROM coach_feedback cf
     JOIN goals g ON g.id = cf.goal_id
     WHERE g.status = 'active'
     ORDER BY cf.created_at DESC LIMIT 20`
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
      if (pathname.match(/^\/api\/goals\/\d+\/regenerate$/) && req.method === "POST") {
        const goalId = parseInt(pathname.split("/")[3], 10);
        return await handleGoalRegenerate(req, env, goalId);
      }
      if (pathname === "/api/plan/current" && req.method === "GET") return await handlePlanCurrent(env);
      if (pathname === "/api/plan/full" && req.method === "GET") return await handlePlanFull(env);
      if (pathname === "/api/runs" && req.method === "GET") return await handleRunsList(env);
      if (pathname === "/api/feedback" && req.method === "GET") return await handleFeedbackList(env);
      if (pathname === "/api/pbs" && req.method === "GET") return await handlePBs(env);
      if (pathname === "/api/review/weekly" && req.method === "POST") return await handleReviewTrigger(env);

      return json({ error: "not found" }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: err.message }, 500);
    }
  },

  // Cron trigger — configure in wrangler.toml, e.g. weekly Sunday 20:00 local
  async scheduled(event, env, ctx) {
    const goal = await env.DB.prepare(`SELECT * FROM goals WHERE status = 'active' LIMIT 1`).first();
    if (goal) ctx.waitUntil(weeklyReview(env, goal));
  },
};
