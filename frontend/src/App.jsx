import React, { useEffect, useState, useCallback } from "react";

const API_BASE = ""; // same-origin in prod behind Cloudflare Pages, proxied in dev

const SESSION_LABEL = {
  easy: "Easy",
  tempo: "Tempo",
  interval: "Intervals",
  long: "Long run",
  rest: "Rest",
  race: "Race day",
};

const DAY_ORDER = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

function fmtPace(p) {
  if (p == null) return "—";
  const min = Math.floor(p);
  const sec = Math.round((p - min) * 60);
  return `${min}:${sec.toString().padStart(2, "0")}/km`;
}

function fmtDist(d) {
  if (d == null) return "—";
  return `${d.toFixed(1)}km`;
}

async function api(path, opts) {
  const res = await fetch(`${API_BASE}/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
  return res.json();
}

function CourseLine({ goal }) {
  if (!goal) return null;
  const created = new Date(goal.created_at);
  const target = goal.target_date ? new Date(goal.target_date) : null;
  const today = new Date();
  let pct = 0;
  if (target) {
    const total = target - created;
    const elapsed = today - created;
    pct = Math.min(100, Math.max(0, (elapsed / total) * 100));
  }
  const daysLeft = target ? Math.max(0, Math.round((target - today) / 86400000)) : null;

  return (
    <div className="course-line">
      <div className="course-line__labels">
        <span className="course-line__start">START</span>
        <span className="course-line__goal">
          {(goal.type || "").toUpperCase()}
          {goal.target_date ? ` · ${target.toLocaleDateString("en-AU", { day: "numeric", month: "short" })}` : ""}
        </span>
      </div>
      <div className="course-line__track">
        <div className="course-line__fill" style={{ width: `${pct}%` }} />
        <div className="course-line__marker" style={{ left: `${pct}%` }} />
      </div>
      {daysLeft != null && <div className="course-line__days">{daysLeft} days to go</div>}
    </div>
  );
}

function WeekPlan({ sessions }) {
  const sorted = [...sessions].sort(
    (a, b) => DAY_ORDER.indexOf(a.day_of_week) - DAY_ORDER.indexOf(b.day_of_week)
  );
  if (sorted.length === 0) {
    return (
      <div className="empty-state">
        No plan loaded for this week yet. Set a goal below to have Trainr build one.
      </div>
    );
  }
  const todayAbbr = DAY_ORDER[(new Date().getDay() + 6) % 7]; // JS getDay(): Sun=0 -> map to MON..SUN
  return (
    <div className="week-plan">
      {sorted.map((s) => {
        const isToday = s.day_of_week === todayAbbr;
        return (
          <div
            key={s.id}
            className={`week-plan__row week-plan__row--${s.session_type} ${
              isToday ? "week-plan__row--today" : ""
            }`}
          >
            <div className="week-plan__lane" />
            <div className="week-plan__day">
              {s.day_of_week}
              {isToday && <span className="week-plan__today-badge">TODAY</span>}
            </div>
            <div className="week-plan__info">
              <div className="week-plan__type">{SESSION_LABEL[s.session_type] || s.session_type}</div>
              <div className="week-plan__desc">{s.description}</div>
            </div>
            <div className="week-plan__stats">
              <span>{fmtDist(s.target_distance_km)}</span>
              <span className="week-plan__pace">{fmtPace(s.target_pace_min_per_km)}</span>
            </div>
            <div className={`week-plan__status week-plan__status--${s.status}`}>{s.status}</div>
          </div>
        );
      })}
    </div>
  );
}

function RecentRuns({ runs }) {
  if (runs.length === 0) {
    return <div className="empty-state">No runs synced yet — check your Shortcuts automation is running.</div>;
  }
  return (
    <div className="runs-list">
      {runs.slice(0, 8).map((r) => (
        <div key={r.id} className="runs-list__row">
          <div className="runs-list__date">
            {new Date(r.start_time).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}
          </div>
          <div className="runs-list__dist">{fmtDist(r.distance_km)}</div>
          <div className="runs-list__pace">{fmtPace(r.avg_pace_min_per_km)}</div>
          <div className="runs-list__hr">{r.avg_hr ? `${r.avg_hr} bpm` : "—"}</div>
        </div>
      ))}
    </div>
  );
}

function CoachFeedback({ feedback }) {
  const latest = feedback[0];
  if (!latest) {
    return (
      <div className="empty-state">
        Your first weekly review lands after your first week of synced runs.
      </div>
    );
  }
  return (
    <div className="coach-card">
      <div className="coach-card__label">
        Week of {new Date(latest.created_at).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}
        {latest.plan_adjusted ? " · plan adjusted" : ""}
      </div>
      <p className="coach-card__text">{latest.feedback_text}</p>
    </div>
  );
}

function NewGoalForm({ onCreated }) {
  const [type, setType] = useState("half");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/goals", {
        method: "POST",
        body: JSON.stringify({ type, target_date: date || null, target_time: time || null }),
      });
      onCreated();
    } catch (err) {
      setError("Couldn't generate the plan — check the API is deployed and the key is set.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="goal-form" onSubmit={submit}>
      <select value={type} onChange={(e) => setType(e.target.value)}>
        <option value="5k">5K</option>
        <option value="10k">10K</option>
        <option value="half">Half marathon</option>
        <option value="full">Marathon</option>
        <option value="general">General fitness</option>
      </select>
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      <input
        type="text"
        placeholder="Target time (optional, e.g. 1:45:00)"
        value={time}
        onChange={(e) => setTime(e.target.value)}
      />
      <button type="submit" disabled={busy}>
        {busy ? "Building plan…" : "Set goal & build plan"}
      </button>
      {error && <div className="goal-form__error">{error}</div>}
    </form>
  );
}

export default function App() {
  const [goals, setGoals] = useState([]);
  const [plan, setPlan] = useState([]);
  const [runs, setRuns] = useState([]);
  const [feedback, setFeedback] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [g, p, r, f] = await Promise.all([
        api("/goals"),
        api("/plan/current"),
        api("/runs"),
        api("/feedback"),
      ]);
      setGoals(g);
      setPlan(p);
      setRuns(r);
      setFeedback(f);
    } catch (err) {
      // API likely not deployed yet — leave empty states showing
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const activeGoal = goals.find((g) => g.status === "active");

  return (
    <div className="app">
      <header className="app__header">
        <div className="wordmark">Trainr</div>
        {activeGoal && <div className="wordmark__sub">Coaching you toward the {activeGoal.type}</div>}
      </header>

      <main className="app__main">
        <section className="card card--hero">
          {activeGoal ? (
            <CourseLine goal={activeGoal} />
          ) : (
            <div className="empty-state">No active goal set yet — add one below to get started.</div>
          )}
        </section>

        <section className="card">
          <h2>This week</h2>
          {loading ? <div className="empty-state">Loading…</div> : <WeekPlan sessions={plan} />}
        </section>

        <section className="card">
          <h2>Coach notes</h2>
          <CoachFeedback feedback={feedback} />
        </section>

        <section className="card">
          <h2>Recent runs</h2>
          <RecentRuns runs={runs} />
        </section>

        <section className="card">
          <h2>{activeGoal ? "Set a new goal" : "Get started"}</h2>
          <NewGoalForm onCreated={loadAll} />
        </section>
      </main>
    </div>
  );
}
