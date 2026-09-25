import { io as Client, Socket as ClientSocket } from "socket.io-client";
import crypto from "crypto";
import { PrismaClient } from "@prisma/client";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test_jwt_secret_key_12345";
process.env.TURN_URLS = "turn:turn.example.com:3478";
process.env.TURN_SECRET = "turn-test-secret";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const vapid = (require("web-push") as typeof import("web-push")).generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
process.env.VAPID_PRIVATE_KEY = vapid.privateKey;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createApp } = require("../app") as typeof import("../app");

const prisma = new PrismaClient();
let passed = 0;
let failed = 0;
const assert = (cond: boolean, name: string, detail?: unknown) => {
  if (cond) {
    console.log(`  [PASS] ${name}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${name}${detail !== undefined ? ` - ${JSON.stringify(detail)}` : ""}`);
    failed++;
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run() {
  console.log("==================================================");
  console.log("STARTING HTTP FEATURES TEST SUITE");
  console.log("==================================================");

  const { httpServer, io } = createApp({ gracePeriodMs: 300 });
  await new Promise<void>((r) => httpServer.listen(0, r));
  const base = `http://localhost:${(httpServer.address() as { port: number }).port}`;
  const stamp = Date.now();

  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* binary or empty */ }
    return { status: res.status, json, headers: res.headers };
  };

  const register = async (name: string) => {
    const r = await call("POST", "/auth/register", { name, email: `${name.toLowerCase()}${stamp}@test.com`, password: "Secret123!" });
    return r.json as { user: { id: string; email: string }; token: string };
  };

  const sockets: ClientSocket[] = [];
  const connect = (token: string) =>
    new Promise<ClientSocket>((resolve, reject) => {
      const s = Client(base, { auth: { token }, reconnection: false, forceNew: true });
      sockets.push(s);
      s.on("connect", () => resolve(s));
      s.on("connect_error", reject);
    });

  try {
    const alice = await register("Alice");
    const bob = await register("Bob");

    console.log("\n--- Profile & avatar ---");
    let r = await call("PATCH", "/auth/me", { name: "  Alice Cooper " }, alice.token);
    assert(r.status === 200 && r.json.user.name === "Alice Cooper", "Name can be updated and is trimmed");
    const png = crypto.randomBytes(64).toString("base64");
    r = await call("PUT", "/auth/me/avatar", { dataUrl: `data:image/png;base64,${png}` }, alice.token);
    assert(r.status === 200 && typeof r.json.user.avatarVersion === "number", "Avatar upload returns a version");
    r = await call("GET", `/users/${alice.user.id}/avatar`);
    assert(r.status === 200 && r.headers.get("content-type") === "image/png", "Avatar is served as an image");
    r = await call("PUT", "/auth/me/avatar", { dataUrl: "data:image/svg+xml;base64,PHN2Zz4=" }, alice.token);
    assert(r.status === 400, "SVG avatars (script risk) are rejected");
    r = await call("PUT", "/auth/me/avatar", { dataUrl: `data:image/png;base64,${crypto.randomBytes(250 * 1024).toString("base64")}` }, alice.token);
    assert(r.status === 413 || r.status === 400, "Oversized avatars are rejected", r.status);
    r = await call("GET", `/users/${bob.user.id}/avatar`);
    assert(r.status === 404, "Users without an avatar return 404");

    console.log("\n--- Password change invalidates old tokens ---");
    r = await call("POST", "/auth/me/password", { currentPassword: "wrong", newPassword: "NewSecret1" }, bob.token);
    assert(r.status === 400, "Wrong current password is rejected");
    await wait(1100); // tokens have second precision
    r = await call("POST", "/auth/me/password", { currentPassword: "Secret123!", newPassword: "NewSecret1" }, bob.token);
    assert(r.status === 200 && typeof r.json.token === "string", "Password change returns a fresh token");
    const bobNewToken = r.json.token as string;
    r = await call("GET", "/auth/me", undefined, bob.token);
    assert(r.status === 401, "Tokens issued before the change stop working");
    r = await call("GET", "/auth/me", undefined, bobNewToken);
    assert(r.status === 200, "The fresh token works");
    bob.token = bobNewToken;

    console.log("\n--- Password reset ---");
    r = await call("POST", "/auth/forgot-password", { email: "nobody-here@test.com" });
    assert(r.status === 200, "Unknown emails get the same generic response");
    r = await call("POST", "/auth/forgot-password", { email: alice.user.email });
    assert(r.status === 200, "Reset requested for a real account");
    const tokenRow = await prisma.passwordResetToken.findFirst({ where: { userId: alice.user.id, usedAt: null } });
    assert(!!tokenRow && tokenRow.tokenHash.length === 64, "Only a hash of the reset token is stored");
    // Recreate a known token to exercise the reset endpoint.
    const rawToken = crypto.randomBytes(32).toString("base64url");
    await prisma.passwordResetToken.update({
      where: { id: tokenRow!.id },
      data: { tokenHash: crypto.createHash("sha256").update(rawToken).digest("hex") },
    });
    r = await call("POST", "/auth/reset-password", { token: rawToken, password: "Reset1234" });
    assert(r.status === 200, "Valid token resets the password");
    r = await call("POST", "/auth/reset-password", { token: rawToken, password: "Again1234" });
    assert(r.status === 400, "Reset tokens are single-use");
    r = await call("POST", "/auth/login", { email: alice.user.email, password: "Reset1234" });
    assert(r.status === 200, "New password signs in");
    alice.token = r.json.token;

    console.log("\n--- Login rate limiting ---");
    const target = `ratelimit${stamp}@test.com`;
    let lastStatus = 0;
    for (let i = 0; i < 11; i++) {
      lastStatus = (await call("POST", "/auth/login", { email: target, password: "nope" })).status;
    }
    assert(lastStatus === 429, "11th failed login for the same account is throttled", lastStatus);
    r = await call("POST", "/auth/login", { email: alice.user.email, password: "Reset1234" });
    assert(r.status === 200, "Other accounts are unaffected");

    console.log("\n--- TURN credentials ---");
    r = await call("GET", "/rtc/ice-servers", undefined, alice.token);
    const turn = r.json.iceServers.find((s: { urls: string[] }) => s.urls.includes("turn:turn.example.com:3478"));
    const expected = crypto.createHmac("sha1", "turn-test-secret").update(turn?.username ?? "").digest("base64");
    assert(!!turn && turn.credential === expected && turn.username.endsWith(`:${alice.user.id}`), "Issues HMAC time-limited TURN credentials");
    r = await call("GET", "/rtc/ice-servers");
    assert(r.status === 401, "ICE servers require authentication");

    console.log("\n--- Scheduling ---");
    await call("POST", "/friends/request", { email: bob.user.email }, alice.token);
    const friends = await call("GET", "/friends", undefined, bob.token);
    await call("POST", `/friends/accept/${friends.json.friends[0].id}`, undefined, bob.token);

    const bobSocket = await connect(bob.token);
    bobSocket.emit("join_global_room", { userId: bob.user.id });
    const notes: any[] = [];
    bobSocket.on("notification", (n) => notes.push(n));
    await wait(200);

    r = await call("POST", "/rooms", { name: "Past", scheduledFor: new Date(Date.now() - 3600_000).toISOString() }, alice.token);
    assert(r.status === 400, "Scheduling in the past is rejected");
    const when = new Date(Date.now() + 2 * 3600_000).toISOString();
    r = await call("POST", "/rooms", { name: "Premiere", isPrivate: false, scheduledFor: when }, alice.token);
    assert(r.status === 201 && r.json.room.scheduledFor === when, "Room can be scheduled");
    const roomId = r.json.room.id as string;
    await wait(300);
    assert(notes.some((n) => n.roomId === roomId && n.scheduledFor === when), "Friends are notified about the schedule");
    r = await call("GET", "/rooms/upcoming", undefined, bob.token);
    assert(r.json.rooms.some((room: { id: string }) => room.id === roomId), "Friends see it under upcoming");

    console.log("\n--- Presence ---");
    const aliceSocket = await connect(alice.token);
    aliceSocket.emit("join_room", { roomId, userId: alice.user.id, userName: "Alice" });
    await wait(500);
    r = await call("GET", "/friends", undefined, bob.token);
    const aliceEntry = r.json.friends.find((f: any) => f.user.id === alice.user.id);
    assert(aliceEntry?.online === true, "Online friends are marked online");
    assert(aliceEntry?.room?.id === roomId, "Friends can see which room you're in");
    assert(typeof aliceEntry?.user.avatarVersion === "number", "Friend list includes avatar version");

    console.log("\n--- Bans persist ---");
    const bobInRoom = await connect(bob.token);
    bobInRoom.emit("join_room", { roomId, userId: bob.user.id, userName: "Bob" });
    await wait(500);
    const kicked = new Promise((res) => bobInRoom.once("kicked", res));
    aliceSocket.emit("kick_participant", { roomId, targetSocketId: bobInRoom.id });
    await kicked;
    r = await call("GET", `/rooms/${roomId}/bans`, undefined, alice.token);
    assert(r.json.bans?.some((b: any) => b.user.id === bob.user.id), "Host can list removed participants");
    r = await call("GET", `/rooms/${roomId}/bans`, undefined, bob.token);
    assert(r.status === 403, "Only the host can see the ban list");
    r = await call("DELETE", `/rooms/${roomId}/bans/${bob.user.id}`, undefined, alice.token);
    assert(r.status === 200, "Host can let a removed participant back in");
    const rejoinErrors: any[] = [];
    bobInRoom.on("error", (e) => rejoinErrors.push(e));
    bobInRoom.emit("join_room", { roomId, userId: bob.user.id, userName: "Bob" });
    await wait(500);
    assert(!rejoinErrors.some((e) => /removed/.test(e.message)), "Unbanned user can rejoin", rejoinErrors);

    console.log("\n--- Invites require room membership ---");
    const carol = await register("Carol");
    r = await call("POST", `/rooms/${roomId}/invite`, { email: bob.user.email }, carol.token);
    assert(r.status === 403, "Strangers can't send invites for a room", r.status);
    r = await call("POST", `/rooms/${roomId}/invite`, { email: bob.user.email }, alice.token);
    assert(r.status === 200, "The host can invite", r.json);

    console.log("\n--- Live list only shows rooms with people ---");
    r = await call("POST", "/rooms", { name: "Empty Public", isPrivate: false }, alice.token);
    const emptyId = r.json.room.id;
    r = await call("GET", "/rooms", undefined, carol.token);
    assert(!r.json.rooms.some((room: { id: string }) => room.id === emptyId), "Empty rooms aren't listed as live");
    assert(r.json.rooms.some((room: { id: string }) => room.id === roomId), "Occupied public rooms are listed");

    console.log("\n--- Start-time reminders ---");
    const { runReminderSweep } = await import("../managers/ReminderScheduler");
    const dueRoom = await prisma.room.create({
      data: { name: "Due Now", hostId: alice.user.id, scheduledFor: new Date(Date.now() - 60_000) },
    });
    const staleRoom = await prisma.room.create({
      data: { name: "Long Gone", hostId: alice.user.id, scheduledFor: new Date(Date.now() - 3 * 3600_000) },
    });
    const before = notes.length;
    const notified = await runReminderSweep(io);
    await wait(300);
    assert(notified.includes(dueRoom.id), "Due rooms get a reminder");
    assert(!notified.includes(staleRoom.id), "Parties that started long ago are skipped");
    assert(notes.slice(before).some((n) => n.roomId === dueRoom.id && /starting now/.test(n.body)), "Friends are told it's starting");
    const again = await runReminderSweep(io);
    assert(!again.includes(dueRoom.id), "Reminders are only sent once");
    r = await call("PATCH", `/rooms/${dueRoom.id}`, { scheduledFor: new Date(Date.now() + 3600_000).toISOString() }, alice.token);
    const rescheduled = await prisma.room.findUnique({ where: { id: dueRoom.id } });
    assert(r.status === 200 && rescheduled?.reminderSentAt === null, "Rescheduling re-arms the reminder");

    console.log("\n--- Password change drops other sessions ---");
    const carolPhone = await connect(carol.token);
    const carolLaptop = await connect(carol.token);
    const phoneDropped = new Promise((res) => carolPhone.once("disconnect", (reason) => res(reason)));
    await wait(1100);
    const res = await fetch(`${base}/api/auth/me/password`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${carol.token}`, "x-socket-id": carolLaptop.id! },
      body: JSON.stringify({ currentPassword: "Secret123!", newPassword: "Changed123" }),
    });
    assert(res.status === 200, "Password changed");
    assert((await Promise.race([phoneDropped, wait(2000).then(() => "timeout")])) === "io server disconnect", "Other devices are disconnected");
    await wait(300);
    assert(carolLaptop.connected, "The requesting device stays connected");
    const reconnect = await new Promise<string>((resolve) => {
      const s = Client(base, { auth: { token: carol.token }, reconnection: false, forceNew: true });
      sockets.push(s);
      s.on("connect", () => resolve("connected"));
      s.on("connect_error", (e) => resolve(e.message));
    });
    assert(reconnect.startsWith("Authentication error"), "Old tokens can't open new connections", reconnect);

    console.log("\n--- Room join attempts are throttled ---");
    const privateRoom = await call("POST", "/rooms", { name: "Locked", isPrivate: true, password: "right" }, alice.token);
    let status = 0;
    for (let i = 0; i < 11; i++) {
      status = (await call("POST", "/rooms/join", { roomId: privateRoom.json.room.id, password: `wrong${i}` }, bob.token)).status;
    }
    assert(status === 429, "11th join attempt for the same room is throttled", status);

    console.log("\n--- Expiring invite links ---");
    const dave = await register("Dave");
    const erin = await register("Erin");
    const locked = privateRoom.json.room.id as string;
    r = await call("POST", `/rooms/${locked}/invite-links`, { expiresInHours: 24, maxUses: 1 }, dave.token);
    assert(r.status === 403, "Only hosts/co-hosts create invite links");
    r = await call("POST", `/rooms/${locked}/invite-links`, { expiresInHours: 24, maxUses: 1 }, alice.token);
    assert(r.status === 201 && /\/invite\/[\w-]{20,}$/.test(r.json.link.url), "Host creates a link", r.json);
    const token = (r.json.link.url as string).split("/invite/")[1];
    const stored = await prisma.roomInviteLink.findFirst({ where: { roomId: locked } });
    assert(!!stored && !stored.tokenHash.includes(token), "Only a hash of the link token is stored");
    r = await call("GET", `/invites/${token}`, undefined, dave.token);
    assert(r.status === 200 && r.json.valid === true && r.json.room.name === "Locked", "Anyone signed in can preview the link");
    r = await call("POST", "/rooms/join", { roomId: locked }, dave.token);
    assert(r.status === 403, "Without the link, the password is still required");
    r = await call("POST", `/invites/${token}/accept`, undefined, dave.token);
    assert(r.status === 200 && r.json.roomId === locked, "Accepting the link grants access");
    r = await call("POST", "/rooms/join", { roomId: locked }, dave.token);
    assert(r.status === 200, "Link holders skip the password");
    r = await call("GET", `/rooms/${locked}`, undefined, dave.token);
    assert(r.json.room.canSkipPassword === true, "Room details tell the client to skip the prompt");
    const daveSocket = await connect(dave.token);
    const daveErrors: any[] = [];
    daveSocket.on("error", (e) => daveErrors.push(e));
    const daveJoined = new Promise((res) => daveSocket.once("room_state", res));
    daveSocket.emit("join_room", { roomId: locked, userId: dave.user.id, userName: "Dave" });
    assert((await Promise.race([daveJoined.then(() => "joined"), wait(2000).then(() => "timeout")])) === "joined", "Link holders join the private room over the socket", daveErrors);
    r = await call("POST", `/invites/${token}/accept`, undefined, erin.token);
    assert(r.status === 410, "Single-use links are used up after one person", r.json);
    r = await call("POST", `/rooms/${locked}/invite-links`, { expiresInHours: 1 }, alice.token);
    const second = r.json.link;
    r = await call("GET", `/rooms/${locked}/invite-links`, undefined, alice.token);
    assert(r.json.links.length === 1 && r.json.links[0].id === second.id, "Active links are listed (used-up ones drop off)");
    await call("DELETE", `/rooms/${locked}/invite-links/${second.id}`, undefined, alice.token);
    r = await call("POST", `/invites/${(second.url as string).split("/invite/")[1]}/accept`, undefined, erin.token);
    assert(r.status === 410 && /revoked/.test(r.json.error), "Revoked links stop working");
    await prisma.roomInviteLink.updateMany({ where: { roomId: locked }, data: { revokedAt: null, expiresAt: new Date(Date.now() - 1000), uses: 0 } });
    r = await call("POST", `/invites/${token}/accept`, undefined, erin.token);
    assert(r.status === 410 && /expired/.test(r.json.error), "Expired links stop working");

    console.log("\n--- Friend groups ---");
    // alice & bob are friends; carol is not alice's friend
    r = await call("POST", "/friends/groups", { name: "Movie crew", memberIds: [bob.user.id, erin.user.id] }, alice.token);
    assert(r.status === 201 && r.json.group.members.length === 1 && r.json.group.members[0].id === bob.user.id, "Groups only keep accepted friends");
    const groupId = r.json.group.id as string;
    r = await call("PATCH", `/friends/groups/${groupId}`, { name: "Crew" }, alice.token);
    assert(r.status === 200 && r.json.group.name === "Crew", "Groups can be renamed");
    r = await call("PATCH", `/friends/groups/${groupId}`, { name: "Hijack" }, bob.token);
    assert(r.status === 404, "Others can't edit your groups");
    const bobInvites: any[] = [];
    const bobSocket2 = await connect(bob.token);
    bobSocket2.on("notification", (n) => bobInvites.push(n));
    await wait(200);
    r = await call("POST", `/rooms/${roomId}/invite-group`, { groupId }, alice.token);
    await wait(300);
    assert(r.status === 200 && r.json.invited === 1 && bobInvites.some((n) => n.roomId === roomId), "Inviting a group notifies its members", r.json);
    r = await call("GET", "/friends/groups", undefined, alice.token);
    assert(r.json.groups.length === 1, "Groups are listed");
    await call("DELETE", `/friends/groups/${groupId}`, undefined, alice.token);
    r = await call("GET", "/friends/groups", undefined, alice.token);
    assert(r.json.groups.length === 0, "Groups can be deleted");

    console.log("\n--- Chat replays ---");
    await prisma.message.createMany({
      data: [
        { roomId, userId: alice.user.id, content: "late", videoUrl: "https://example.com/film.mp4", videoTime: 90 },
        { roomId, userId: bob.user.id, content: "early", videoUrl: "https://example.com/film.mp4", videoTime: 5 },
      ],
    });
    r = await call("GET", `/rooms/${roomId}/replays`, undefined, alice.token);
    assert(r.json.replays?.some((x: any) => x.videoUrl === "https://example.com/film.mp4" && x.messageCount === 2), "Replays are listed per video", r.json);
    r = await call("GET", `/rooms/${roomId}/replay?url=${encodeURIComponent("https://example.com/film.mp4")}`, undefined, alice.token);
    assert(r.json.messages?.map((m: any) => m.content).join() === "early,late", "Replay messages are ordered by video time");
    r = await call("GET", `/rooms/${roomId}/replays`, undefined, erin.token);
    assert(r.status === 403, "Non-members can't read a room's replays");

    console.log("\n--- Push subscriptions ---");
    r = await call("GET", "/push/config");
    assert(r.json.enabled === true && r.json.publicKey === vapid.publicKey, "Push config exposes the public key");
    const sub = { endpoint: `https://push.example.test/${stamp}`, keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } };
    r = await call("POST", "/push/subscribe", { endpoint: "http://insecure.test/x", keys: sub.keys }, alice.token);
    assert(r.status === 400, "Only https push endpoints are accepted");
    r = await call("POST", "/push/subscribe", sub, alice.token);
    assert(r.status === 201 && !!(await prisma.pushSubscription.findUnique({ where: { endpoint: sub.endpoint } })), "Subscriptions are stored");
    r = await call("DELETE", "/push/subscribe", { endpoint: sub.endpoint }, alice.token);
    assert(!(await prisma.pushSubscription.findUnique({ where: { endpoint: sub.endpoint } })), "Unsubscribing removes it");
  } finally {
    sockets.forEach((s) => s.disconnect());
    io.close();
    await new Promise<void>((r) => httpServer.close(() => r()));
    await prisma.$disconnect();
  }

  console.log("\n==================================================");
  console.log(`TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log("==================================================");
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
