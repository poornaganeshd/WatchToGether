/// <reference types="node" />
import { createServer } from "http";
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test_jwt_secret_key_12345";
process.env.YOUTUBE_API_KEY = "fake-key";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createApp } = require("../app") as typeof import("../app");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseIsoDuration } = require("../controllers/youtube") as typeof import("../controllers/youtube");

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

async function run() {
  console.log("==================================================");
  console.log("STARTING YOUTUBE SEARCH TEST SUITE");
  console.log("==================================================");

  // A stand-in for the YouTube Data API.
  const calls: { path: string; params: URLSearchParams }[] = [];
  let quotaExceeded = false;
  const fake = createServer((req, res) => {
    const url = new URL(req.url!, "http://fake");
    calls.push({ path: url.pathname, params: url.searchParams });
    res.setHeader("content-type", "application/json");
    if (quotaExceeded) {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: { errors: [{ reason: "quotaExceeded" }] } }));
      return;
    }
    if (url.pathname.endsWith("/search")) {
      res.end(JSON.stringify({
        nextPageToken: "PAGE2",
        items: [
          { id: { videoId: "abc123" }, snippet: { title: "Tom &amp; Jerry&#39;s Big Day", channelTitle: "Cartoons", liveBroadcastContent: "none", thumbnails: { medium: { url: "https://i.ytimg.com/abc.jpg" } } } },
          { id: { videoId: "live999" }, snippet: { title: "Live now", channelTitle: "News", liveBroadcastContent: "live", thumbnails: {} } },
        ],
      }));
      return;
    }
    if (url.pathname.endsWith("/videos") && url.searchParams.get("chart") === "mostPopular") {
      res.end(JSON.stringify({
        items: [
          { id: "pop1", snippet: { title: "Popular", channelTitle: "Chan" }, contentDetails: { duration: "PT4M5S" }, status: { embeddable: true } },
          { id: "blocked", snippet: { title: "Not embeddable" }, contentDetails: { duration: "PT1M" }, status: { embeddable: false } },
        ],
      }));
      return;
    }
    if (url.pathname.endsWith("/videos")) {
      res.end(JSON.stringify({ items: [{ id: "abc123", contentDetails: { duration: "PT1H2M3S" } }, { id: "live999", contentDetails: { duration: "P0D" } }] }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((r) => fake.listen(0, r));
  process.env.YOUTUBE_API_BASE = `http://localhost:${(fake.address() as { port: number }).port}/youtube/v3`;

  const { httpServer, io } = createApp();
  await new Promise<void>((r) => httpServer.listen(0, r));
  const base = `http://localhost:${(httpServer.address() as { port: number }).port}/api`;

  const user = await prisma.user.upsert({
    where: { email: "yt_tester@test.com" },
    update: {},
    create: { email: "yt_tester@test.com", name: "YT Tester", passwordHash: "x" },
  });
  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET!);
  const get = async (path: string, auth = true) => {
    const res = await fetch(`${base}${path}`, { headers: auth ? { authorization: `Bearer ${token}` } : {} });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  try {
    console.log("\n--- Helpers ---");
    assert(parseIsoDuration("PT1H2M3S") === 3723 && parseIsoDuration("PT45S") === 45 && parseIsoDuration("P1DT1S") === 86401, "ISO durations are parsed");
    assert(parseIsoDuration(undefined) === null, "Missing durations are null");

    console.log("\n--- Search ---");
    let r = await get("/youtube/config", false);
    assert(r.json.enabled === true, "Config reports search as enabled");
    r = await get("/youtube/search?q=cartoons", false);
    assert(r.status === 401, "Search requires sign-in");
    r = await get("/youtube/search?q=");
    assert(r.status === 400, "Empty queries are rejected");
    r = await get("/youtube/search?q=Cartoons");
    assert(r.status === 200 && r.json.results.length === 2, "Search returns results", r.json);
    const first = r.json.results[0];
    assert(first.title === "Tom & Jerry's Big Day" && first.channel === "Cartoons", "Titles are HTML-decoded", first);
    assert(first.url === "https://www.youtube.com/watch?v=abc123" && first.durationSeconds === 3723, "Results carry a playable URL and duration", first);
    assert(r.json.results[1].isLive === true, "Live streams are flagged");
    assert(r.json.nextPageToken === "PAGE2", "Paging token is passed through");
    const searchCall = calls.find((c) => c.path.endsWith("/search"))!;
    assert(searchCall.params.get("videoEmbeddable") === "true" && searchCall.params.get("type") === "video", "Only embeddable videos are requested");
    assert(searchCall.params.get("key") === "fake-key", "The API key stays on the server");

    const before = calls.length;
    r = await get("/youtube/search?q=cartoons");
    assert(r.status === 200 && calls.length === before, "Repeat searches are served from cache (case-insensitive)");

    const beforeBurst = calls.filter((c) => c.path.endsWith("/search")).length;
    const burst = await Promise.all([get("/youtube/search?q=same+time"), get("/youtube/search?q=Same+Time")]);
    assert(
      burst.every((b) => b.status === 200) && calls.filter((c) => c.path.endsWith("/search")).length === beforeBurst + 1,
      "Identical searches at the same moment share one API call"
    );

    console.log("\n--- Popular ---");
    r = await get("/youtube/popular?region=GB");
    assert(r.status === 200 && r.json.results.length === 1 && r.json.results[0].id === "pop1", "Popular feed drops non-embeddable videos", r.json);
    assert(r.json.results[0].durationSeconds === 245, "Popular results include durations");
    assert(calls.some((c) => c.params.get("regionCode") === "GB"), "Region is passed through");

    console.log("\n--- Quota ---");
    quotaExceeded = true;
    r = await get("/youtube/search?q=something+new");
    assert(r.status === 503 && /daily limit/.test(r.json.error), "Quota exhaustion gives a clear message", r.json);
  } finally {
    io.close();
    await new Promise<void>((r) => httpServer.close(() => r()));
    await new Promise<void>((r) => fake.close(() => r()));
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
