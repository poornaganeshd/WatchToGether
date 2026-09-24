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
| `VITE_ICE_SERVERS` | Optional JSON array of WebRTC ICE servers. Add a TURN server so calls work behind strict NATs, e.g. `[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]` |

### Server environment

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL`, `DIRECT_URL` | PostgreSQL connection strings |
| `JWT_SECRET` | Secret used to sign auth tokens (required) |
| `CLIENT_URL` | Public client URL, used for invite links and CORS (comma-separate multiple origins) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Optional: email invitations. In-app invites work without them |

## Tests

The server suites spin up a real Socket.IO server against the configured database:

```bash
cd server
npm test
```

Client checks: `npm run lint` and `npm run build` in `client/`.
