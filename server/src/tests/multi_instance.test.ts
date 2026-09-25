/// <reference types="node" />
/**
 * Runs two API processes against one Redis and checks that everything meant to be shared
 * across instances is: presence, notifications, rate limits, forced sign-out and room ownership.
 * Requires REDIS_URL (skipped otherwise).
 */
import { spawn, ChildProcess } from "child_process";
import path from "path";
import { io as Client, Socket as ClientSocket } from "socket.io-client";

const REDIS_URL = process.env.REDIS_URL;
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

const startInstance = (port: number, instanceId: string) =>
  new Promise<ChildProcess>((resolve, reject) => {
    const child = spawn(process.execPath, [require.resolve("ts-node/dist/bin"), path.join(__dirname, "..", "index.ts")], {
      env: { ...process.env, PORT: String(port), INSTANCE_ID: instanceId, JWT_SECRET: "multi-instance-secret", REDIS_URL },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => reject(new Error(`instance ${instanceId} did not start`)), 60000);
    child.stdout!.on("data", (chunk) => {
      if (String(chunk).includes("Server running")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr!.on("data", (chunk) => process.stderr.write(`[${instanceId}] ${chunk}`));
  });

async function run() {
  if (!REDIS_URL) {
    console.log("REDIS_URL not set; skipping multi-instance tests");
    return;
  }
  console.log("==================================================");
  console.log("STARTING MULTI-INSTANCE TEST SUITE");
  console.log("==================================================");

  const [a, b] = await Promise.all([startInstance(5101, "instance-a"), startInstance(5102, "instance-b")]);
  const A = "http://localhost:5101";
  const B = "http://localhost:5102";
  const stamp = Date.now();
  const sockets: ClientSocket[] = [];

  const call = async (base: string, method: string, p: string, body?: unknown, token?: string) => {
    const res = await fetch(`${base}/api${p}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const connect = (base: string, token: string) =>
    new Promise<ClientSocket>((resolve, reject) => {
      const s = Client(base, { auth: { token }, reconnection: false, forceNew: true, transports: ["websocket"] });
      sockets.push(s);
      s.on("connect", () => resolve(s));
      s.on("connect_error", reject);
    });

  try {
    const reg = async (base: string, name: string) =>
      (await call(base, "POST", "/auth/register", { name, email: `${name.toLowerCase()}${stamp}@multi.test`, password: "Secret123!" })).json;
    const xena = await reg(A, "Xena");
    const yuri = await reg(B, "Yuri");

    console.log("\n--- Notifications cross instances ---");
    const xOnA = await connect(A, xena.token);
    const notes: any[] = [];
    xOnA.on("notification", (n) => notes.push(n));
    await wait(300);
    const req = await call(B, "POST", "/friends/request", { email: xena.user.email }, yuri.token);
    await wait(500);
    assert(notes.some((n) => /friend request/i.test(n.title)), "A socket on instance A gets a notification raised on B", notes);
    const list = await call(A, "GET", "/friends", undefined, xena.token);
    await call(A, "POST", `/friends/accept/${list.json.friends[0].id}`, undefined, xena.token);
    void req;

    console.log("\n--- Presence is shared ---");
    let friends = await call(B, "GET", "/friends", undefined, yuri.token);
    assert(friends.json.friends[0]?.online === true, "B sees a user connected to A as online", friends.json);

    const room = (await call(A, "POST", "/rooms", { name: "Shared", isPrivate: false }, xena.token)).json.room;
    const joined = new Promise((res) => xOnA.once("room_state", res));
    xOnA.emit("join_room", { roomId: room.id, userId: xena.user.id, userName: "Xena" });
    await joined;
    await wait(300);
    friends = await call(B, "GET", "/friends", undefined, yuri.token);
    assert(friends.json.friends[0]?.room?.id === room.id, "B sees which room they're in on A", friends.json.friends[0]);

    console.log("\n--- Room ownership ---");
    const yOnB = await connect(B, yuri.token);
    const yErrors: any[] = [];
    yOnB.on("error", (e) => yErrors.push(e));
    yOnB.emit("join_room", { roomId: room.id, userId: yuri.user.id, userName: "Yuri" });
    await wait(800);
    assert(yErrors.some((e) => /another server/.test(e.message)), "A room live on A can't be forked on B", yErrors);
    const yOnA = await connect(A, yuri.token);
    const yJoinedA = new Promise((res) => yOnA.once("room_state", res));
    yOnA.emit("join_room", { roomId: room.id, userId: yuri.user.id, userName: "Yuri" });
    assert((await Promise.race([yJoinedA.then(() => "ok"), wait(3000).then(() => "timeout")])) === "ok", "Joining on the owning instance works");

    console.log("\n--- Rate limits are shared ---");
    const target = `victim${stamp}@multi.test`;
    let status = 0;
    for (let i = 0; i < 11; i++) {
      status = (await call(i % 2 ? A : B, "POST", "/auth/login", { email: target, password: "nope" })).status;
    }
    assert(status === 429, "Failed logins spread across instances still hit the limit", status);

    console.log("\n--- Forced sign-out crosses instances ---");
    const xOnB = await connect(B, xena.token);
    const dropped = new Promise((res) => xOnA.once("disconnect", (reason) => res(reason)));
    await wait(1100);
    const change = await fetch(`${B}/api/auth/me/password`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${xena.token}`, "x-socket-id": xOnB.id! },
      body: JSON.stringify({ currentPassword: "Secret123!", newPassword: "Changed123" }),
    });
    assert(change.status === 200, "Password changed on B");
    assert((await Promise.race([dropped, wait(3000).then(() => "timeout")])) === "io server disconnect", "The session on A is disconnected");
    assert(xOnB.connected, "The requesting socket on B stays connected");

    console.log("\n--- Offline propagates ---");
    xOnB.disconnect();
    await wait(800);
    friends = await call(A, "GET", "/friends", undefined, yuri.token);
    assert(friends.json.friends[0]?.online === false, "Once every socket is gone, the user is offline everywhere", friends.json.friends[0]);
  } finally {
    sockets.forEach((s) => s.disconnect());
    a.kill();
    b.kill();
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
