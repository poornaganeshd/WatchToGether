/// <reference types="node" />
import { createServer } from "http";
import { io as Client, Socket as ClientSocket } from "socket.io-client";
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test_jwt_secret_key_12345";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createApp } = require("../app") as typeof import("../app");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { youTubeIdOf } = require("../services/watchHistory") as typeof import("../services/watchHistory");

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
  console.log("STARTING WATCH HISTORY TEST SUITE");
  console.log("==================================================");

  // Stand-in for YouTube's oEmbed endpoint (titles without an API key).
  const fake = createServer((req, res) => {
    const target = new URL(req.url!, "http://fake").searchParams.get("url") ?? "";
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ title: `Title of ${new URL(target).searchParams.get("v")}` }));
  });
  await new Promise<void>((r) => fake.listen(0, r));
  process.env.YOUTUBE_OEMBED_BASE = `http://localhost:${(fake.address() as { port: number }).port}`;

  const { httpServer, io } = createApp();
  await new Promise<void>((r) => httpServer.listen(0, r));
  const port = (httpServer.address() as { port: number }).port;
  const base = `http://localhost:${port}/api`;

  const stamp = Date.now();
  const [alice, bob] = await Promise.all(
    ["alice", "bob"].map((n) =>
      prisma.user.create({ data: { email: `wh_${n}_${stamp}@test.com`, name: n === "alice" ? "Alice" : "Bob", passwordHash: "x" } })
    )
  );
  const tokenOf = (id: string) => jwt.sign({ userId: id }, process.env.JWT_SECRET!);
  const call = async (method: string, path: string, userId: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${tokenOf(userId)}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const sockets: ClientSocket[] = [];
  const connect = (userId: string) =>
    new Promise<ClientSocket>((resolve) => {
      const s = Client(`http://localhost:${port}`, { auth: { token: tokenOf(userId) }, reconnection: false, forceNew: true });
      sockets.push(s);
      s.on("connect", () => resolve(s));
    });

  try {
    console.log("\n--- Helpers ---");
    assert(youTubeIdOf("https://youtu.be/abc123XYZ") === "abc123XYZ", "youtu.be links are recognised");
    assert(youTubeIdOf("https://www.youtube.com/shorts/abc123XYZ") === "abc123XYZ", "Shorts links are recognised");
    assert(youTubeIdOf("https://example.com/video.mp4") === null, "Other sites aren't YouTube");

    console.log("\n--- Starting a room on a chosen video ---");
    let r = await call("POST", "/rooms", alice.id, { name: "Rewatch", isPrivate: false, videoUrl: "javascript:alert(1)" });
    assert(r.status === 400, "Rooms can't start on a non-http link");
    r = await call("POST", "/rooms", alice.id, { name: "Rewatch", isPrivate: false, videoUrl: "https://www.youtube.com/watch?v=first1" });
    assert(r.status === 201 || r.status === 200, "Room is created with a starting video", r.json);
    const roomId = r.json.room.id as string;

    const aliceSocket = await connect(alice.id);
    const started: { url?: string } = {};
    aliceSocket.on("sync_response", (s: { url?: string }) => Object.assign(started, s));
    aliceSocket.emit("join_room", { roomId, userId: alice.id, userName: "Alice" });
    await wait(600);
    assert(started.url === "https://www.youtube.com/watch?v=first1", "The room opens on that video", started);

    console.log("\n--- Recording what people watch ---");
    const bobSocket = await connect(bob.id);
    bobSocket.emit("join_room", { roomId, userId: bob.id, userName: "Bob" });
    await wait(600);
    aliceSocket.emit("play_url", { roomId, url: "https://www.youtube.com/watch?v=second2" });
    await wait(800);

    r = await call("GET", "/watch-history", alice.id);
    const aliceVideos = r.json.videos as { id: string; url: string; title: string; thumbnail: string; roomName: string }[];
    assert(r.status === 200 && aliceVideos[0]?.url === "https://www.youtube.com/watch?v=second2", "Newest video comes first", aliceVideos);
    assert(aliceVideos.some((v) => v.url.endsWith("first1")), "The video playing when you joined is remembered");
    assert(aliceVideos[0]?.title === "Title of second2", "Titles are looked up", aliceVideos[0]);
    assert(aliceVideos[0]?.thumbnail === "https://i.ytimg.com/vi/second2/mqdefault.jpg" && aliceVideos[0]?.roomName === "Rewatch", "Entries carry a thumbnail and the room name", aliceVideos[0]);
    r = await call("GET", "/watch-history", bob.id);
    assert((r.json.videos as { url: string }[]).some((v) => v.url.endsWith("second2")), "Everyone in the room gets the video in their history");

    aliceSocket.emit("play_url", { roomId, url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ" });
    await wait(500);
    r = await call("GET", "/watch-history", alice.id);
    assert(!(r.json.videos as { url: string }[]).some((v) => v.url.endsWith("aqz-KE-bpKQ")), "The default placeholder video isn't recorded");

    aliceSocket.emit("play_url", { roomId, url: "https://www.youtube.com/watch?v=first1" });
    await wait(500);
    r = await call("GET", "/watch-history", alice.id);
    const again = r.json.videos as { url: string }[];
    assert(again[0].url.endsWith("first1") && again.filter((v) => v.url.endsWith("first1")).length === 1, "Rewatching moves a video to the top without duplicating it", again);

    console.log("\n--- Removing entries ---");
    const bobEntry = (await call("GET", "/watch-history", bob.id)).json.videos[0];
    r = await call("DELETE", `/watch-history/${bobEntry.id}`, alice.id);
    assert(r.status === 404, "You can't remove someone else's entry");
    const aliceEntry = (await call("GET", "/watch-history", alice.id)).json.videos[0];
    r = await call("DELETE", `/watch-history/${aliceEntry.id}`, alice.id);
    assert(r.status === 200, "You can remove one of your entries");
    r = await call("DELETE", "/watch-history", alice.id);
    const afterClear = await call("GET", "/watch-history", alice.id);
    assert(r.status === 200 && afterClear.json.videos.length === 0, "Clearing empties your list");
    assert((await call("GET", "/watch-history", bob.id)).json.videos.length > 0, "Clearing doesn't touch other people's lists");
    r = await fetch(`${base}/watch-history`).then((res) => ({ status: res.status, json: null }));
    assert(r.status === 401, "History requires sign-in");
  } finally {
    sockets.forEach((s) => s.disconnect());
    io.close();
    await new Promise<void>((r) => httpServer.close(() => r()));
    await new Promise<void>((r) => fake.close(() => r()));
    await prisma.$disconnect();
  }

  console.log("\n==================================================");
  console.log(`TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log("==================================================");
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
