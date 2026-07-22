-- Trainr D1 schema

CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,              -- '5k', '10k', 'half', 'full', 'general'
  target_date TEXT,                -- ISO date, null for 'general'
  target_time TEXT,                -- e.g. '01:45:00', optional
  status TEXT NOT NULL DEFAULT 'active', -- 'active', 'completed', 'archived'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  notes TEXT
);

CREATE TABLE IF NOT EXISTS training_plan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL REFERENCES goals(id),
  week_number INTEGER NOT NULL,
  week_start_date TEXT NOT NULL,   -- ISO date, Monday of that week
  session_date TEXT,               -- exact calendar date for this session, computed by the app (not the AI)
  day_of_week TEXT NOT NULL,       -- 'MON'..'SUN'
  session_type TEXT NOT NULL,      -- 'easy', 'tempo', 'interval', 'long', 'rest', 'race'
  target_distance_km REAL,
  target_pace_min_per_km REAL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'planned', -- 'planned', 'completed', 'missed', 'adjusted'
  run_id INTEGER REFERENCES runs(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  start_time TEXT NOT NULL,        -- ISO datetime
  duration_sec INTEGER,
  distance_km REAL,
  avg_pace_min_per_km REAL,
  avg_hr INTEGER,
  max_hr INTEGER,
  splits_json TEXT,                -- raw split data from Shortcuts, JSON array
  source TEXT DEFAULT 'apple_health',
  external_id TEXT UNIQUE,         -- Health Auto Export's workout UUID, prevents duplicate inserts
  elevation_gain REAL,
  elevation_units TEXT,
  temperature REAL,
  temperature_units TEXT,
  humidity REAL,
  humidity_units TEXT,
  notes TEXT,                      -- user's own comments: injury concerns, how it felt, conditions
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS coach_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER REFERENCES goals(id),
  week_number INTEGER,
  run_id INTEGER REFERENCES runs(id),
  feedback_text TEXT NOT NULL,
  feedback_type TEXT NOT NULL DEFAULT 'weekly_review', -- 'plan_review', 'weekly_review', or 'run_review'
  plan_adjusted INTEGER DEFAULT 0, -- boolean
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_plan_goal_week ON training_plan(goal_id, week_number);
CREATE INDEX IF NOT EXISTS idx_runs_start ON runs(start_time);
CREATE INDEX IF NOT EXISTS idx_feedback_goal ON coach_feedback(goal_id, week_number);
