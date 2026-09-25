# WatchTogether

Watch videos in sync with friends, with video/voice chat, live chat and emoji reactions.

- **client/** – React + Vite + Tailwind single-page app
- **server/** – Express + Socket.IO + Prisma (PostgreSQL)

## Features

- Synchronized playback of YouTube links, direct video URLs, local files and screen shares
- WebRTC camera/mic tiles with speaker detection, host announcements and smart volume ducking
- Private (password-protected) and public rooms; join with a short `WT-1234` code or an invite link
- "Live now" list of public rooms, room history with search, end/delete controls for hosts
- Live chat with history on join, clickable video timestamps, unread badge and a People tab
- Emoji reactions that float over the video (also visible in fullscreen)
- Friends: requests, accept/decline/cancel/unfriend, one-click room invites with in-app notifications
- Watch queue: anyone suggests links, hosts reorder / play now, auto-advances when a video ends
- Typing indicators, keyboard shortcuts (press `?` in a room)
- Host & co-host roles with automatic host migration; hosts can remove participants and edit room settings (name, privacy, password, capacity)
- Viewers without a camera or microphone can still join and see/hear everyone
- Shared subtitles (.srt / .vtt) rendered over any player, including YouTube
- Vote to skip (majority of the room) and a persisted watch queue
- Live sync status per viewer (in sync / behind / buffering / can't play) for hosts
- Friends presence: see who's online and which room they're in, with one-click join
- Scheduled watch parties with friend notifications, countdowns and calendar (.ics) export
- Profiles with display name and avatar upload; password change signs out other sessions
- Password reset by email; rate limiting on sign-in, sign-up and reset
- TURN support: the API issues short-lived credentials (see `docker compose --profile turn`)
- "Starting now" reminders for scheduled parties, sent to the host and their friends
- Synced countdown start (3/5/10s) that pauses everyone and starts playback together
- Chat moderation (delete messages, demote co-hosts), @mentions with autocomplete, highlight and a notification chime
- Recently played list with one-click re-queue
- Chat replays: rewatch a video with the room's chat appearing when it was sent, plus a chat-activity strip
- Pop-out cameras (Document Picture-in-Picture, with single-video PiP fallback)
- Audio delay compensation for Bluetooth headphones, and per-person voice volume
- Polls, including "what's next?" polls that queue the winning video
- Expiring / limited-use invite links that skip the room password
- Chat mute (timed or indefinite) and slow mode for hosts
- Friend groups with one-click group invites
- Web push notifications when the site is closed (opt-in per browser)
- Multiple API instances behind a load balancer via Redis
- Phone layout: video on top, Chat / Queue / People / Cameras tabs, and a bottom control bar; landscape goes full-screen
- Search YouTube (or browse what's popular) from the Queue tab and play or queue with one tap
- Screen sharing on desktop browsers (phone browsers don't support screen capture)
- Install it as an app (home-screen icon, opens full screen); a banner offers a reload when a new version is deployed
- A "waking up the server" notice while free hosting starts the API after a quiet period
- Paste a YouTube playlist link to queue the whole playlist (hosts); recent searches are remembered
- Phones: double-tap the left/right edge of the video to skip 10 s (hosts); new chat messages float over the video in landscape
- "Recently watched" on the dashboard, with one tap to start a new watch party on a video

> **Deploying?** See [DEPLOYMENT.md](DEPLOYMENT.md) — including how to check which build is live.

## Getting started

```bash
# 1. Database
docker compose up -d            # or point DATABASE_URL at any PostgreSQL instance

# 2. Server
cd server
cp .env.example .env            # fill in JWT_SECRET, DATABASE_URL, DIRECT_URL
npm install
npx prisma migrate deploy
npm run dev                     # http://localhost:5000

# 3. Client
cd ../client
npm install
npm run dev                     # http://localhost:5173
```

### Client environment

| Variable | Purpose |
| --- | --- |
| `VITE_API_URL` | API origin (default `http://localhost:5000`) |
| `VITE_ICE_SERVERS` | Optional JSON array of ICE servers that overrides what the API provides. Prefer server-side `TURN_*` settings so credentials rotate |

### Server environment

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL`, `DIRECT_URL` | PostgreSQL connection strings |
| `JWT_SECRET` | Secret used to sign auth tokens (required) |
| `CLIENT_URL` | Public client URL, used for invite links and CORS (comma-separate multiple origins) |
| `YOUTUBE_API_KEY` | In-room YouTube search (YouTube Data API v3). Free quota ≈ 100 searches/day; results are cached |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Email invitations and password reset. Without SMTP, reset links are printed to the server log in development |
| `TURN_URLS`, `TURN_SECRET` | TURN relay for WebRTC. With a shared secret (coturn `use-auth-secret`) the API hands out 12-hour credentials. `TURN_USERNAME`/`TURN_CREDENTIAL` work for static credentials |
| `TRUST_PROXY` | Set (e.g. `1`) behind a reverse proxy so rate limits see real client IPs |
| `REDIS_URL` | Redis 7+ for running several API instances (shared broadcasts, presence, rate limits, room ownership) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web push. Generate keys with `npx web-push generate-vapid-keys` |

### TURN relay

Some networks (symmetric NAT, many corporate and mobile networks) block direct peer connections. Run coturn with the bundled profile and point the API at it:

```bash
TURN_SECRET=$(openssl rand -hex 32) EXTERNAL_IP=<public ip> docker compose --profile turn up -d
# API: TURN_URLS=turn:<public host>:3478 TURN_SECRET=<same secret>
```

### Running several API instances

Set the same `REDIS_URL` on every instance. Socket.IO broadcasts, presence, rate limits, forced sign-outs and notifications are then shared.

Live room state (playback, participants, queue order, polls) stays in the memory of whichever instance first opened the room; a Redis lease records the owner, and another instance refuses to open a second copy (people see "This room is live on another server" with a retry). For everyone to reach the owning instance, route by room at the load balancer (for example, sticky sessions keyed on the room id) or run a single instance for rooms. Moving room state itself into Redis would remove that constraint and is the natural next step if you outgrow one room server.

## Tests

The server suites spin up a real Socket.IO server against the configured database:

```bash
cd server
npm test   # set REDIS_URL too to include the two-instance test
```

Client checks: `npm run lint` and `npm run build` in `client/`.
