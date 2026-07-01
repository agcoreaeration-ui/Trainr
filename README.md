# Trainr

AI running coach — pulls your Apple Watch run data in via Shortcuts, has Claude
build and adjust your training plan week to week. Same stack as GardenOps/Life Org:
React + Vite frontend, Cloudflare Workers API, D1 database.

## 1. Deploy the Worker

```
cd worker
npx wrangler d1 create trainr-db
```

Copy the `database_id` it prints into `wrangler.toml`.

```
npx wrangler d1 execute trainr-db --file=./schema.sql --remote
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put INGEST_TOKEN     # make up any long random string
npx wrangler deploy
```

Note the URL it deploys to, e.g. `trainr-api.<your-subdomain>.workers.dev`.

## 2. Deploy the frontend

Push `frontend/` to a GitHub repo, connect it in Cloudflare Pages same as your
other apps (build command `npm run build`, output dir `dist`). In production,
point API calls at your Worker URL — either:

- add a Pages Function/route that proxies `/api/*` to the Worker, or
- set `API_BASE` in `App.jsx` directly to the full Worker URL.

Protect it behind Cloudflare Access the same way as GardenOps if you want it
private.

## 3. Set up the Shortcuts automation (Apple Watch → Trainr)

On your iPhone, in the **Shortcuts** app:

1. Go to **Automation** → **+** → **Create Personal Automation**.
2. Choose **Workout** → **Workout Ends** → **Type: Running** (or leave "Any").
3. Turn off "Ask Before Running" so it fires automatically.
4. Add these actions:
   - **Find Health Samples** (or use the built-in workout variables available
     right after "Workout Ends") to get: Start Date, Duration, Distance,
     Average Heart Rate, Average Pace.
   - **Get Contents of URL**:
     - URL: `https://trainr-api.<your-subdomain>.workers.dev/api/ingest`
     - Method: POST
     - Headers: `Authorization: Bearer <the INGEST_TOKEN you set above>`
     - Request Body (JSON):
       ```json
       {
         "start_time": "Start Date",
         "duration_sec": "Duration in seconds",
         "distance_km": "Distance in km",
         "avg_pace_min_per_km": "Average Pace",
         "avg_hr": "Average Heart Rate",
         "splits": []
       }
       ```
       (map each value to the corresponding Shortcuts variable — exact field
       names differ slightly by iOS version, so check what's available in the
       "Workout Ends" action's output variables when you build this.)

Test it by finishing an outdoor run — check `/api/runs` on your Worker URL to
confirm it landed.

## 4. Set your goal

Open the deployed frontend, fill in the "Set a new goal" form (half marathon,
Oct date). Trainr calls Claude once to generate the full week-by-week plan and
stores it in D1.

## 5. Weekly review

The Worker's cron trigger (see `wrangler.toml`, defaults to Sunday) runs
automatically and adjusts next week's plan based on what you actually ran.
You can also trigger it manually any time by POSTing to `/api/review/weekly`.

## Notes / next steps

- Splits: currently ingested as-is if your Shortcuts flow can extract them;
  otherwise leave `splits: []` — coaching still works off distance/pace/HR.
- Multiple goals: the schema already supports several `goals` rows; the UI
  currently shows whichever is `status = 'active'`. A goal switcher is a
  natural next addition once you've used it for a bit.
- If you decide later you do want live in-run pace cues, that's a separate
  watchOS build — the data/plan side here doesn't need to change for it.
