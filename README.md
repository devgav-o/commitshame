# Commit Shame

A verdict on your git history. Drop a GitHub repo, get a printed receipt of its most embarrassing commits.

**Live: <https://commitsha.me>**

> No signup. No tracking.

```
   ━━━━━━━━━━ OFFICIAL SHAME RECEIPT ━━━━━━━━━━
        REPO   torvalds/linux
       DATE   2026-05-02
    COMMITS   500 analyzed
   ─────────────────────────────────────
        ★ ★ ★  VERDICT: GUILTY  ★ ★ ★
              SHAME SCORE  87 / 100
   ─────────────────────────────────────
   ITEMIZED OFFENSES:

   #01  "fix"                          ¤87
        the one-word fix · alice · 2d

   #02  "asdfasdf"                     ¤97 ×3
        the keyboard smasher · bob

   ─────────────────────────────────────
   [download receipt] [share] [permalink]
```

## Quick start

```bash
git clone https://github.com/devgav-o/commitshame.git
cd commitshame
cp .env.example .env
# edit .env and paste your GitHub token (see below)
npm install
npm start
```

Open <http://localhost:3000>.

That's it. No build step, no bundler, no database.

## Get a GitHub token (free, takes 30 seconds)

Without a token the server is limited to **60 GitHub requests per hour, total**, across every visitor. With a token: **5,000 per hour**.

1. Go to <https://github.com/settings/tokens?type=beta>
2. Click **Generate new token** → **Fine-grained token**
3. Name it anything ("commit-shame")
4. Set expiration (90 days is fine, just rotate it later)
5. **Repository access**: Public repositories (read-only) — that's it
6. **Permissions**: leave everything at default (no scopes needed for public repos)
7. Click **Generate token**, copy it
8. Paste into `.env`:

   ```env
   GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```

9. Restart the server (`npm start`)

The token never leaves your server. Visitors don't see it, can't extract it.

## How it works

```
visitor browser  ──fetch──>  /api/commits/owner/repo
                                    │
                                    │ adds Authorization header
                                    ▼
                              api.github.com
```

- **Server** ([server.js](server.js)) — Express. Proxies GitHub, attaches your token, forwards rate-limit headers back to the client. Per-IP throttle (60 req/hr default) so one visitor can't drain the shared pool.
- **Scoring engine** ([public/scoring.js](public/scoring.js)) — pure functions, runs in the browser. Takes a commit message → returns `{ score, label }` or `null`. Pipeline:
  1. **Hard excludes** (merge commits, releases, `Initial commit`, etc.)
  2. **Signals** — ~30 regex tests like `bare_fix`, `keyboard_smash`, `please_work`, `emoji_soup`. Highest score wins.
  3. **Quality bonus** — subtracts up to 50 points for things like ticket references, conventional format, multiple words, `Signed-off-by`, single-emoji gitmoji.
  4. **Threshold** — anything below 55 isn't shameful enough; dropped.
  5. **Post-process** — late-night detection (timestamp-based), streak detection (3+ identical msgs in a row → spam committer), repeat-offender bumps.
  6. **Dedup** — adjacent identical messages collapse into `×N` rows.
- **UI** ([public/app.js](public/app.js), [public/style.css](public/style.css)) — vanilla JS, ES modules, no framework. Renders the receipt, exports a PNG share card via `<canvas>`, supports Web Share API on mobile, URL state for permalinks, Cmd/Ctrl-K to focus.

## Project structure

```
.
├── server.js              ← express server + GitHub proxy
├── package.json
├── .env.example           ← copy to .env
├── public/
│   ├── index.html         ← markup
│   ├── style.css          ← receipt styling
│   ├── scoring.js         ← scoring engine (ESM exports)
│   └── app.js             ← client logic (ESM, imports scoring)
└── README.md
```

## Endpoints

| route                              | what it does                                    |
| ---------------------------------- | ----------------------------------------------- |
| `GET /`                            | serves the app                                  |
| `GET /api/repo/:owner/:repo`       | proxies repo metadata                           |
| `GET /api/commits/:owner/:repo`    | proxies commit list (`?branch=`, `?page=1..10`) |
| `GET /api/health`                  | `{ ok, hasToken, rateLimitPerHour }`            |

All `/api/*` routes are rate-limited per IP. Owner/repo names are validated against `/^[a-zA-Z0-9_.-]+$/`.

## Environment variables

| var                    | default | what it does                                      |
| ---------------------- | ------- | ------------------------------------------------- |
| `GITHUB_TOKEN`         | _empty_ | your fine-grained PAT (see above)                 |
| `PORT`                 | `3000`  | port to listen on                                 |
| `RATE_LIMIT_PER_HOUR`  | `60`    | per-IP cap on `/api/*` (prevents pool draining)   |

## Scripts

```bash
npm start    # node server.js
npm run dev  # nodemon, restarts on file changes
```

## Deploying

Anywhere that runs Node 18+ and accepts an env var works:

- **Render / Railway / Fly.io** — point at the repo, set `GITHUB_TOKEN` in their dashboard, deploy
- **VPS** — `pm2 start server.js`, put nginx in front for TLS
- **Docker** — works as-is, just `COPY . .` and `npm ci --omit=dev`

Cloudflare Workers / Vercel Edge **won't** work without rewriting — Express is a Node-only framework. If you want edge, port the proxy to Hono or itty-router.

### Production checklist

- [ ] `GITHUB_TOKEN` set (5,000 req/hr instead of 60)
- [ ] `RATE_LIMIT_PER_HOUR` tuned for your expected traffic
- [ ] TLS in front (Render/Railway/Fly.io give you this for free; for VPS, use nginx + certbot)
- [ ] DNS pointed at your host (`commitsha.me` is the live deploy)
- [ ] Server gracefully drains on `SIGTERM` (already wired)
- [ ] Helmet sets HSTS + CSP defaults (already wired)
- [ ] Per-IP rate limit caps `/api/*` so one visitor can't drain the pool

## Contributing

PRs welcome — especially new shame signals. Fork, add to `SHAME_SIGNALS` in [public/scoring.js](public/scoring.js) with a regex, label, and score, and open a PR. Keep the regex tight (false positives are worse than missed shames).

## License

MIT. Have fun. Don't shame anyone you don't know personally.
