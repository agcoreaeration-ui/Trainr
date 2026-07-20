import React, { useEffect, useState, useCallback, useRef } from "react";

const API_BASE = "https://trainr-api.agcoreaeration.workers.dev";

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

function fmtDuration(sec) {
  if (sec == null) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
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
  const [selectedId, setSelectedId] = useState(null);
  if (runs.length === 0) {
    return <div className="empty-state">No runs synced yet — check your Shortcuts automation is running.</div>;
  }
  return (
    <div className="runs-list">
      <div className="runs-list__row runs-list__row--header">
        <div></div>
        <div>KM</div>
        <div>PACE</div>
        <div>TIME</div>
        <div>AVG HR</div>
        <div>MAX HR</div>
      </div>
      {runs.slice(0, 8).map((r) => {
        const hasExtra = r.temperature != null || r.humidity != null || r.elevation_gain != null;
        return (
          <React.Fragment key={r.id}>
            <div
              className="runs-list__row"
              onClick={() => hasExtra && setSelectedId(selectedId === r.id ? null : r.id)}
              style={hasExtra ? { cursor: "pointer" } : undefined}
            >
              <div className="runs-list__date">
                {new Date(r.start_time).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}
              </div>
              <div className="runs-list__dist">{fmtDist(r.distance_km)}</div>
              <div className="runs-list__pace">{fmtPace(r.avg_pace_min_per_km)}</div>
              <div className="runs-list__time">{fmtDuration(r.duration_sec)}</div>
              <div className="runs-list__hr">{r.avg_hr ?? "—"}</div>
              <div className="runs-list__hr">{r.max_hr ?? "—"}</div>
            </div>
            {selectedId === r.id && hasExtra && (
              <div className="runs-list__extra">
                {r.temperature != null && (
                  <span>🌡️ {Math.round(r.temperature)}°{r.temperature_units === "degF" ? "F" : "C"}</span>
                )}
                {r.humidity != null && <span>💧 {Math.round(r.humidity)}%</span>}
                {r.elevation_gain != null && (
                  <span>⛰️ {Math.round(r.elevation_gain)}{r.elevation_units || "m"} gain</span>
                )}
              </div>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

const FEEDBACK_TYPE_LABEL = {
  plan_review: "NEW PLAN",
  weekly_review: "WEEK REVIEW",
  run_review: "RUN NOTE",
};

function CoachFeedback({ feedback }) {
  if (feedback.length === 0) {
    return (
      <div className="empty-state">
        Your first weekly review lands after your first week of synced runs.
      </div>
    );
  }
  return (
    <div className="coach-feed">
      {feedback.slice(0, 5).map((item) => (
        <div key={item.id} className="coach-card">
          <div className="coach-card__label">
            <span className={`coach-card__badge coach-card__badge--${item.feedback_type || "weekly_review"}`}>
              {FEEDBACK_TYPE_LABEL[item.feedback_type] || "WEEK REVIEW"}
            </span>
            <span>
              {new Date(item.created_at).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}
              {item.plan_adjusted ? " · plan adjusted" : ""}
            </span>
          </div>
          <p className="coach-card__text">{item.feedback_text}</p>
        </div>
      ))}
    </div>
  );
}

const BUILD_PROGRESS_MESSAGES = [
  "Building weeks 1-4…",
  "Building weeks 5-8…",
  "Building weeks 9-12…",
  "Building the final stretch…",
  "Almost there, finishing up…",
];

function NewGoalForm({ onCreated }) {
  const [type, setType] = useState("half");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [progressStep, setProgressStep] = useState(0);

  useEffect(() => {
    if (!busy) return;
    setProgressStep(0);
    // Roughly matches real chunk timing (~80s/chunk) — approximate, not exact,
    // just enough to signal real progress on a multi-minute wait rather than a static button.
    const interval = setInterval(() => {
      setProgressStep((s) => Math.min(s + 1, BUILD_PROGRESS_MESSAGES.length - 1));
    }, 80000);
    return () => clearInterval(interval);
  }, [busy]);

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
        {busy ? BUILD_PROGRESS_MESSAGES[progressStep] : "Set goal & build plan"}
      </button>
      {busy && (
        <div className="goal-form__hint">
          This takes a few minutes — Trainr builds your plan in batches to keep it free to run.
        </div>
      )}
      {error && <div className="goal-form__error">{error}</div>}
    </form>
  );
}

function FullPlanOverview({ fullPlan, loading }) {
  const [selectedId, setSelectedId] = useState(null);

  if (loading) return <div className="empty-state">Loading full plan…</div>;
  if (fullPlan.length === 0) {
    return <div className="empty-state">No plan generated yet — set a goal to build one.</div>;
  }

  // Local calendar date, not UTC (toISOString() would shift this in Melbourne).
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  const byWeek = {};
  for (const s of fullPlan) {
    if (!byWeek[s.week_number]) byWeek[s.week_number] = [];
    byWeek[s.week_number].push(s);
  }
  const weekNumbers = Object.keys(byWeek)
    .map(Number)
    .sort((a, b) => a - b);

  return (
    <div className="full-plan">
      {weekNumbers.map((wn) => {
        const sessions = byWeek[wn].sort(
          (a, b) => DAY_ORDER.indexOf(a.day_of_week) - DAY_ORDER.indexOf(b.day_of_week)
        );
        const totalKm = sessions.reduce((sum, s) => sum + (s.target_distance_km || 0), 0);
        const longRun = Math.max(0, ...sessions.map((s) => (s.session_type === "long" ? s.target_distance_km : 0)));
        const hasRace = sessions.some((s) => s.session_type === "race");
        const dates = sessions.map((s) => s.session_date).filter(Boolean).sort();
        const isCurrentWeek = dates.length > 0 && todayStr >= dates[0] && todayStr <= dates[dates.length - 1];
        const firstDate = sessions[0]?.session_date;
        const weekLabel = firstDate
          ? new Date(firstDate).toLocaleDateString("en-AU", { day: "numeric", month: "short" })
          : "";
        const selectedSession = sessions.find((s) => s.id === selectedId);

        return (
          <div
            key={wn}
            className={`full-plan__week ${hasRace ? "full-plan__week--race" : ""} ${
              isCurrentWeek ? "full-plan__week--current" : ""
            }`}
          >
            <div className="full-plan__week-header">
              <span className="full-plan__week-num">
                Week {wn}
                {isCurrentWeek && <span className="full-plan__current-badge">NOW</span>}
              </span>
              <span className="full-plan__week-date">{weekLabel}</span>
              <span className="full-plan__week-stats">
                {totalKm.toFixed(1)}km · long {longRun.toFixed(1)}km
              </span>
            </div>
            <div className="full-plan__pills">
              {sessions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={`full-plan__pill full-plan__pill--${s.session_type} ${
                    selectedId === s.id ? "full-plan__pill--selected" : ""
                  } ${s.status === "completed" ? "full-plan__pill--done" : ""}`}
                  title={`${s.day_of_week}: ${SESSION_LABEL[s.session_type] || s.session_type}${
                    s.target_distance_km ? ` (${s.target_distance_km}km)` : ""
                  }${s.status === "completed" ? " — completed" : ""}`}
                  onClick={() => setSelectedId(selectedId === s.id ? null : s.id)}
                >
                  {s.status === "completed" ? "✓" : s.day_of_week[0]}
                </button>
              ))}
            </div>
            {selectedSession && (
              <div className="full-plan__detail">
                <strong>
                  {selectedSession.day_of_week} · {SESSION_LABEL[selectedSession.session_type] || selectedSession.session_type}
                </strong>
                {selectedSession.target_distance_km ? (
                  <span className="full-plan__detail-stats">
                    {selectedSession.target_distance_km}km
                    {selectedSession.target_pace_min_per_km ? ` @ ${fmtPace(selectedSession.target_pace_min_per_km)}` : ""}
                  </span>
                ) : null}
                <p>{selectedSession.description}</p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function PBsView({ data, loading }) {
  if (loading) return <div className="empty-state">Loading personal bests…</div>;
  if (!data) return <div className="empty-state">No data yet — sync some runs first.</div>;

  const { pbs, longest_run, best_week, current_streak, plan_stats, plan_history } = data;
  const active = plan_stats?.active;

  return (
    <div className="pbs-view">
      <div className="pbs-stats-row">
        <div className="pbs-stat">
          <div className="pbs-stat__value">{current_streak}</div>
          <div className="pbs-stat__label">day streak</div>
        </div>
        <div className="pbs-stat">
          <div className="pbs-stat__value">{longest_run ? fmtDist(longest_run.distance_km) : "—"}</div>
          <div className="pbs-stat__label">longest run</div>
        </div>
        <div className="pbs-stat">
          <div className="pbs-stat__value">{best_week ? `${best_week.km.toFixed(1)}km` : "—"}</div>
          <div className="pbs-stat__label">best week</div>
        </div>
      </div>

      <div className="pbs-list">
        {pbs.map((pb) => (
          <div key={pb.key} className={`pbs-card ${pb.achieved ? "" : "pbs-card--empty"}`}>
            <div className="pbs-card__label">{pb.label}</div>
            {pb.achieved ? (
              <>
                <div className="pbs-card__time">{fmtDuration(pb.estimated_time_sec)}</div>
                <div className="pbs-card__meta">
                  {fmtPace(pb.avg_pace_min_per_km)} · {new Date(pb.date).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}
                  {pb.actual_distance_km ? ` · from a ${pb.actual_distance_km.toFixed(1)}km run` : ""}
                </div>
              </>
            ) : (
              <div className="pbs-card__meta">No qualifying run yet</div>
            )}
          </div>
        ))}
      </div>

      {active && (
        <div className="plan-stats">
          <div className="plan-stats__title">This plan — {active.goal_type}</div>
          <div className="plan-stats__row">
            <div className="plan-stats__item">
              <div className="plan-stats__value">{active.days_elapsed}</div>
              <div className="plan-stats__label">days elapsed</div>
            </div>
            <div className="plan-stats__item">
              <div className="plan-stats__value">{active.days_remaining ?? "—"}</div>
              <div className="plan-stats__label">days to go</div>
            </div>
            <div className="plan-stats__item">
              <div className="plan-stats__value">{active.total_km.toFixed(1)}</div>
              <div className="plan-stats__label">km run</div>
            </div>
            <div className="plan-stats__item">
              <div className="plan-stats__value">
                {active.sessions_completed}/{active.sessions_total}
              </div>
              <div className="plan-stats__label">sessions done</div>
            </div>
          </div>
        </div>
      )}

      {plan_history && plan_history.length > 0 && (
        <div className="plan-history">
          <div className="plan-stats__title">Previous plans</div>
          <div className="plan-history__table">
            <div className="plan-history__row plan-history__row--header">
              <div>Plan</div>
              <div>KM</div>
              <div>Sessions</div>
            </div>
            {plan_history.map((h) => (
              <div key={h.goal_id} className="plan-history__row">
                <div>
                  <div>
                    {h.type}
                    {h.target_date ? ` · ${new Date(h.target_date).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "2-digit" })}` : ""}
                  </div>
                  <div className="plan-history__started">
                    started {new Date(h.created_at).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}
                  </div>
                </div>
                <div>{h.total_km.toFixed(1)}km</div>
                <div>
                  {h.sessions_completed}/{h.sessions_total}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="pbs-note">
        PBs are estimated from your closest-distance runs, normalized to the exact distance by pace — not from
        in-run splits (Trainr doesn't capture GPS lap data yet).
      </div>
    </div>
  );
}

export default function App() {
  const [goals, setGoals] = useState([]);
  const [plan, setPlan] = useState([]);
  const [runs, setRuns] = useState([]);
  const [feedback, setFeedback] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("week");
  const [fullPlan, setFullPlan] = useState([]);
  const [fullPlanLoading, setFullPlanLoading] = useState(false);
  const [fullPlanLoaded, setFullPlanLoaded] = useState(false);
  const [pbData, setPbData] = useState(null);
  const [pbLoading, setPbLoading] = useState(false);
  const [pbLoaded, setPbLoaded] = useState(false);

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
      setFullPlanLoaded(false); // force a fresh full-plan fetch next time that tab opens
      setPbLoaded(false);
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

  useEffect(() => {
    if (activeTab === "full" && !fullPlanLoaded) {
      setFullPlanLoading(true);
      api("/plan/full")
        .then((data) => {
          setFullPlan(data);
          setFullPlanLoaded(true);
        })
        .catch((err) => console.error(err))
        .finally(() => setFullPlanLoading(false));
    }
    if (activeTab === "pbs" && !pbLoaded) {
      setPbLoading(true);
      Promise.all([api("/pbs"), api("/plan-stats"), api("/plan-history")])
        .then(([pbs, planStats, planHistory]) => {
          setPbData({ ...pbs, plan_stats: planStats, plan_history: planHistory });
          setPbLoaded(true);
        })
        .catch((err) => console.error(err))
        .finally(() => setPbLoading(false));
    }
  }, [activeTab, fullPlanLoaded, pbLoaded]);

  const activeGoal = goals.find((g) => g.status === "active");

  // Pull-to-refresh — built manually since this runs as a standalone PWA
  // (Add to Home Screen), where the browser's native pull-to-refresh doesn't apply.
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const touchStartY = useRef(0);
  const pulling = useRef(false);
  const activeTabRef = useRef(activeTab);
  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  const refreshFullPlan = useCallback(async () => {
    setFullPlanLoading(true);
    try {
      const data = await api("/plan/full");
      setFullPlan(data);
      setFullPlanLoaded(true);
    } catch (err) {
      console.error(err);
    } finally {
      setFullPlanLoading(false);
    }
  }, []);

  const refreshPBs = useCallback(async () => {
    setPbLoading(true);
    try {
      const [pbs, planStats, planHistory] = await Promise.all([api("/pbs"), api("/plan-stats"), api("/plan-history")]);
      setPbData({ ...pbs, plan_stats: planStats, plan_history: planHistory });
      setPbLoaded(true);
    } catch (err) {
      console.error(err);
    } finally {
      setPbLoading(false);
    }
  }, []);

  useEffect(() => {
    const PULL_THRESHOLD = 70;

    function onTouchStart(e) {
      if (window.scrollY === 0) {
        touchStartY.current = e.touches[0].clientY;
        pulling.current = true;
      } else {
        pulling.current = false;
      }
    }

    function onTouchMove(e) {
      if (!pulling.current) return;
      const distance = e.touches[0].clientY - touchStartY.current;
      if (distance > 0) {
        setPullDistance(Math.min(distance * 0.5, 90));
      }
    }

    async function onTouchEnd() {
      if (!pulling.current) return;
      pulling.current = false;
      setPullDistance((currentDistance) => {
        if (currentDistance > PULL_THRESHOLD) {
          setRefreshing(true);
          const tabRefresh =
            activeTabRef.current === "full"
              ? refreshFullPlan()
              : activeTabRef.current === "pbs"
              ? refreshPBs()
              : Promise.resolve();
          Promise.all([loadAll(), tabRefresh]).finally(() => setRefreshing(false));
        }
        return 0;
      });
    }

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("touchend", onTouchEnd);
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, [loadAll, refreshFullPlan, refreshPBs]);

  return (
    <div className="app">
      <div
        className={`pull-indicator ${refreshing ? "pull-indicator--active" : ""}`}
        style={{ height: refreshing ? 44 : pullDistance, opacity: refreshing || pullDistance > 10 ? 1 : 0 }}
      >
        <div className={`pull-indicator__spinner ${refreshing ? "pull-indicator__spinner--spin" : ""}`} />
      </div>
      <div style={{ transform: `translateY(${refreshing ? 44 : pullDistance}px)`, transition: pulling.current ? "none" : "transform 0.2s ease" }}>
      <header className="app__header">
        <div className="wordmark">Trainr</div>
        {activeGoal && <div className="wordmark__sub">Coaching you toward the {activeGoal.type}</div>}
      </header>

      <div className="tab-nav">
        <button
          className={`tab-nav__btn ${activeTab === "week" ? "tab-nav__btn--active" : ""}`}
          onClick={() => setActiveTab("week")}
        >
          This Week
        </button>
        <button
          className={`tab-nav__btn ${activeTab === "full" ? "tab-nav__btn--active" : ""}`}
          onClick={() => setActiveTab("full")}
        >
          Full Plan
        </button>
        <button
          className={`tab-nav__btn ${activeTab === "pbs" ? "tab-nav__btn--active" : ""}`}
          onClick={() => setActiveTab("pbs")}
        >
          PBs
        </button>
      </div>

      <main className="app__main">
        <section className="card card--hero">
          {activeGoal ? (
            <CourseLine goal={activeGoal} />
          ) : (
            <div className="empty-state">No active goal set yet — add one below to get started.</div>
          )}
        </section>

        {activeTab === "week" ? (
          <>
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
          </>
        ) : activeTab === "full" ? (
          <section className="card">
            <h2>Full plan overview</h2>
            <FullPlanOverview fullPlan={fullPlan} loading={fullPlanLoading} />
          </section>
        ) : (
          <section className="card">
            <h2>Personal bests</h2>
            <PBsView data={pbData} loading={pbLoading} />
          </section>
        )}
      </main>
      </div>
    </div>
  );
}
