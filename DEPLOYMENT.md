# Deploying WatchTogether

WatchTogether has two parts that deploy separately:

| Part | Folder | Where | What it needs |
| --- | --- | --- | --- |
| Web app | `client/` | Vercel (static site) | `VITE_API_URL` |
| API + realtime server | `server/` | Any Node host that supports WebSockets (Render, Railway, Fly.io, a VPS…) | PostgreSQL, env vars below |

**Deploy both whenever you merge to `main`.** If only the web app updates, new screens will call server features that don't exist yet (and vice versa).

## Check what's live

Open **Settings** in the app. The footer shows:

```
App build abc1234 · built <date> · Server def5678
```

Both hashes should match the latest commit on `main` (`git log -1 --oneline origin/main`, or the commit list on GitHub).
You can also open `https://<your-api>/api/health` directly.

If the app hash is old, the web app didn't redeploy. If the server hash is old (or "unreachable"), the server didn't.

## Web app on Vercel

In the Vercel dashboard → your project → **Settings**:

1. **General → Root Directory:** `client`
2. **Build & Development:** Framework *Vite*, build command `npm run build`, output directory `dist` (the defaults).
3. **Git → Production Branch:** `main`. Every push to `main` then deploys automatically.
4. **Environment Variables:** `VITE_API_URL` = your server's public URL, e.g. `https://watchtogether-api.onrender.com` (no trailing slash, no `/api`).
   *Changing an env var needs a redeploy to take effect* (Deployments → ⋯ → Redeploy).

To force a deploy of the latest `main`: **Deployments** → the newest entry → **⋯ → Redeploy**. Check its commit hash matches GitHub.

## Server

Settings for any Node host:

- **Root directory:** `server`
- **Build command:** `npm install && npm run build`
- **Start command:** `npm run start:migrate` (applies database migrations, then starts). Every deploy that includes a new migration needs this; skipping it breaks new features with database errors.
- **Health check path:** `/api/health`
- WebSockets must be allowed (they are by default on Render, Railway and Fly.io).

### Environment variables

Required:

| Variable | Value |
| --- | --- |
| `DATABASE_URL`, `DIRECT_URL` | PostgreSQL connection strings (Neon: pooled URL and direct URL) |
| `JWT_SECRET` | A long random string (`openssl rand -hex 32`). Changing it signs everyone out. |
| `CLIENT_URL` | Your Vercel URL, e.g. `https://watch-to-gether.vercel.app` (used for CORS and links in emails) |
| `TRUST_PROXY` | `1` on Render/Railway/Fly/behind nginx, so rate limits see real visitor IPs |

Optional features:

| Feature | Variables |
| --- | --- |
| YouTube search in rooms | `YOUTUBE_API_KEY` — Google Cloud Console → *APIs & Services* → enable **YouTube Data API v3** → *Credentials* → *Create API key*. Restrict the key to that API. Free quota ≈ 100 searches/day (results are cached). |
| Email (invites, password reset) | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` |
| Push notifications | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (`npx web-push generate-vapid-keys`) |
| Calls behind strict networks | `TURN_URLS`, `TURN_SECRET` (see README → TURN relay) |
| Several server instances | `REDIS_URL` (see README → Running several API instances) |

## After deploying

1. Settings footer shows the new hashes for both app and server.
2. Create a room, open it on a second device, press play — both should stay in sync.
3. If you set `YOUTUBE_API_KEY`: Queue → *Find videos* shows "Popular now".

## Troubleshooting: "I merged, but the site hasn't changed"

Work through these in order. The first one is the most common.

1. **Vercel blocked the deploy.** Open the Vercel project → **Deployments**.
   If recent deployments say *Blocked* or *Canceled* ("commit author does not have access", "Git author must have access to the team"), your Vercel plan only deploys commits made by the project owner.
   Hobby (free) projects connected to a private repository do this for commits by anyone else, including merges done by another account and commits by bots.
   Fixes, easiest first:
   - Redeploy manually: **Deployments → ⋯ → Redeploy** (or *Create Deployment* and pick `main`). The owner triggering it is allowed.
   - Make the GitHub repository public. Vercel's Hobby plan deploys any author's commits on public repos.
   - Import the repository into the Vercel account of the person who owns the GitHub repository.
   - Use a Pro team and add the other people as members.
2. **Vercel isn't watching this repository.** Settings → Git should show *this* repository (`poornaganeshd/WatchToGether`). If it shows a different one (for example an older copy or fork), connect this one instead.
   When the connection works, Vercel comments a preview link on every pull request. If none of the pull requests have one, the project isn't connected.
3. **Wrong branch or folder.** Settings → Git → Production Branch must be `main`; Settings → General → Root Directory must be `client`.
4. **The build failed.** Open the newest deployment and read the build log. The client builds with `npm run build` on Node 20.19 or newer (Settings → General → Node.js Version).
5. **Your browser is showing an old copy.** Reload the page (on a phone, close the tab and open the link again).

Then check the Settings footer in the app: the app build code should match the newest commit on `main`.
