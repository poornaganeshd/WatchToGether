import { createServer } from "http";
import { Server } from "socket.io";
import { io as Client, Socket as ClientSocket } from "socket.io-client";
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";
import { setupSocketHandlers } from "../socket";
import { RoomManager } from "../managers/RoomManager";
import { hashRoomPassword, verifyRoomPassword } from "../utils/roomPassword";
import { escapeHtml } from "../utils/escapeHtml";

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || "test_jwt_secret_key_12345";
process.env.JWT_SECRET = JWT_SECRET;

let testsPassed = 0;
let testsFailed = 0;

function assert(condition: boolean, testName: string, rawDetail?: unknown) {
  const detail = rawDetail === undefined || typeof rawDetail === "string" ? rawDetail : JSON.stringify(rawDetail);
  if (condition) {
    console.log(`  [PASS] ${testName}`);
    testsPassed++;
  } else {
    console.error(`  [FAIL] ${testName}${detail ? ` - ${detail}` : ""}`);
    testsFailed++;
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

class TestClient {
  public socket!: ClientSocket;
  public events: Record<string, any[]> = {};

  constructor(public userId: string, public userName: string, private url: string, private token: string) {}

  connect(): Promise<void> {
    return new Promise((resolve) => {
      this.socket = Client(this.url, { auth: { token: this.token }, reconnection: false, forceNew: true });
      this.socket.onAny((event, payload) => {
        (this.events[event] ||= []).push(payload);
      });
      this.socket.on("connect", () => resolve());
    });
  }

  join(roomId: string, password?: string, userName = this.userName) {
    this.socket.emit("join_room", { roomId, userId: this.userId, userName, password });
    return wait(400);
  }

  last(event: string) {
    const list = this.events[event] || [];
    return list[list.length - 1];
  }

  disconnect() {
    this.socket.disconnect();
  }
}

async function runTests() {
  console.log("==================================================");
  console.log("STARTING ROOM FEATURES TEST SUITE");
  console.log("==================================================");

  console.log("\n--- Test 1: Room password hashing ---");
  const hashed = await hashRoomPassword("secret");
  assert(hashed !== "secret", "Password is not stored in plain text");
  assert(await verifyRoomPassword(hashed, "secret"), "Hashed password verifies");
  assert(!(await verifyRoomPassword(hashed, "wrong")), "Wrong password is rejected");
  assert(await verifyRoomPassword("legacy", "legacy"), "Legacy plain-text password still verifies");
  assert(!(await verifyRoomPassword("legacy", undefined)), "Missing password is rejected");
  assert(await verifyRoomPassword(null, undefined), "Rooms without a password accept anyone");

  console.log("\n--- Test 2: HTML escaping for invite emails ---");
  assert(escapeHtml(`<b>"Tom" & 'Jerry'</b>`) === "&lt;b&gt;&quot;Tom&quot; &amp; &#39;Jerry&#39;&lt;/b&gt;", "Special characters are escaped");

  const httpServer = createServer();
  const io = new Server(httpServer, { cors: { origin: "*" } });
  const roomManager = new RoomManager(io, 500);
  setupSocketHandlers(io, roomManager);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const url = `http://localhost:${(httpServer.address() as any).port}`;

  const hostId = "45454545-4545-4545-a545-454545454545";
  const guestId = "56565656-5656-4565-a565-565656565656";
  const outsiderId = "67676767-6767-4676-a676-676767676767";
  for (const [id, email, name] of [
    [hostId, "features_host@test.com", "Host Person"],
    [guestId, "features_guest@test.com", "Guest Person"],
    [outsiderId, "features_outsider@test.com", "Outsider"],
  ]) {
    await prisma.user.upsert({ where: { email }, update: { id, name }, create: { id, email, name, passwordHash: "hash" } });
  }

  const privateRoomId = "88888888-8888-4888-a888-000000000001";
  const otherRoomId = "88888888-8888-4888-a888-000000000002";
  await prisma.message.deleteMany({ where: { roomId: { in: [privateRoomId, otherRoomId] } } });
  await prisma.roomCoHost.deleteMany({ where: { roomId: { in: [privateRoomId, otherRoomId] } } });
  // Queue items and bans are persisted, so clear leftovers from earlier runs.
  await prisma.roomQueueItem.deleteMany({ where: { roomId: { in: [privateRoomId, otherRoomId] } } });
  await prisma.roomBan.deleteMany({ where: { roomId: { in: [privateRoomId, otherRoomId] } } });
  await prisma.room.upsert({
    where: { id: privateRoomId },
    update: { isActive: true, hostId, password: hashed, isPrivate: true },
    create: { id: privateRoomId, name: "Private", hostId, password: hashed, isPrivate: true },
  });
  await prisma.room.upsert({
    where: { id: otherRoomId },
    update: { isActive: true, hostId: outsiderId },
    create: { id: otherRoomId, name: "Other", hostId: outsiderId },
  });

  const host = new TestClient(hostId, "Host Person", url, jwt.sign({ userId: hostId }, JWT_SECRET));
  const guest = new TestClient(guestId, "Guest Person", url, jwt.sign({ userId: guestId }, JWT_SECRET));
  const outsider = new TestClient(outsiderId, "Outsider", url, jwt.sign({ userId: outsiderId }, JWT_SECRET));

  try {
    await Promise.all([host.connect(), guest.connect(), outsider.connect()]);

    console.log("\n--- Test 3: Socket join enforces hashed room passwords ---");
    await host.join(privateRoomId);
    assert(!!host.last("room_state"), "Host joins private room without password");

    await guest.join(privateRoomId, "wrong");
    assert(guest.last("error")?.message === "Incorrect password", "Guest with wrong password is rejected");
    assert(!guest.last("room_state"), "Rejected guest receives no room state");

    await guest.join(privateRoomId, "secret", "Spoofed Name");
    assert(!!guest.last("room_state"), "Guest with correct password joins");

    console.log("\n--- Test 4: Participant roster uses account names ---");
    const roster = guest.last("room_participants") as { userName: string; userId: string }[];
    assert(Array.isArray(roster) && roster.length === 2, "Joiner receives full participant roster", JSON.stringify(roster));
    assert(roster.some((p) => p.userId === guestId && p.userName === "Guest Person"), "Client-supplied name is replaced by account name");
    assert(host.last("user_joined")?.userName === "Guest Person", "user_joined carries the account name");

    console.log("\n--- Test 5: Chat messages are persisted and replayed ---");
    host.socket.emit("send_message", { roomId: privateRoomId, userId: hostId, userName: "Host Person", content: "  hello there  " });
    await wait(400);
    const received = guest.last("receive_message");
    assert(received?.content === "hello there", "Message content is trimmed and broadcast");
    assert(typeof received?.id === "string" && received.id.length === 36, "Broadcast message uses the database id");

    guest.socket.emit("send_message", { roomId: otherRoomId, userId: guestId, userName: "Guest Person", content: "leak" });
    await wait(300);
    assert(guest.last("receive_message")?.content !== "leak", "Messages to rooms the sender is not in are dropped");

    const lateJoiner = new TestClient(hostId, "Host Person", url, jwt.sign({ userId: hostId }, JWT_SECRET));
    await lateJoiner.connect();
    await lateJoiner.join(privateRoomId);
    const history = lateJoiner.last("chat_history") as { content: string }[];
    assert(Array.isArray(history) && history.some((m) => m.content === "hello there"), "Chat history is sent on join");
    lateJoiner.disconnect();

    console.log("\n--- Test 6: Chat rate limiting ---");
    for (let i = 0; i < 12; i++) {
      guest.socket.emit("send_message", { roomId: privateRoomId, userId: guestId, userName: "Guest Person", content: `spam ${i}` });
    }
    await wait(600);
    assert((guest.events["chat_rate_limited"] || []).length > 0, "Flooding the chat triggers the rate limiter");

    console.log("\n--- Test 7: Reactions ---");
    guest.socket.emit("send_reaction", { roomId: privateRoomId, emoji: "🔥" });
    await wait(300);
    assert(host.last("reaction")?.emoji === "🔥" && host.last("reaction")?.userName === "Guest Person", "Reaction is broadcast with sender name");
    const before = (host.events["reaction"] || []).length;
    guest.socket.emit("send_reaction", { roomId: privateRoomId, emoji: "<script>" });
    await wait(300);
    assert((host.events["reaction"] || []).length === before, "Unknown reaction emoji is rejected");

    console.log("\n--- Test 8: Co-host promotion is limited to room members ---");
    await outsider.join(otherRoomId);
    host.socket.emit("make_cohost", { roomId: privateRoomId, targetSocketId: outsider.socket.id });
    await wait(400);
    const outsiderPromoted = await prisma.roomCoHost.findUnique({ where: { roomId_userId: { roomId: privateRoomId, userId: outsiderId } } });
    assert(!outsiderPromoted, "Host cannot promote a socket from another room");

    host.socket.emit("make_cohost", { roomId: privateRoomId, targetSocketId: guest.socket.id });
    await wait(400);
    assert(guest.last("new_cohost")?.userId === guestId, "Host can promote a participant in the room");

    console.log("\n--- Test 9: Notification channels are private ---");
    guest.socket.emit("join_global_room", { userId: hostId });
    await wait(300);
    assert(guest.last("error")?.message === "Unauthorized userId mismatch", "Cannot subscribe to another user's notifications");

    console.log("\n--- Test 10: Typing indicator ---");
    guest.socket.emit("typing", { roomId: privateRoomId, isTyping: true });
    await wait(300);
    assert(host.last("user_typing")?.isTyping === true && host.last("user_typing")?.userName === "Guest Person", "Typing state is relayed with name");

    console.log("\n--- Test 11: Watch queue ---");
    guest.socket.emit("queue_add", { roomId: privateRoomId, url: "https://example.com/a.mp4" });
    guest.socket.emit("queue_add", { roomId: privateRoomId, url: "https://example.com/b.mp4" });
    guest.socket.emit("queue_add", { roomId: privateRoomId, url: "javascript:alert(1)" });
    await wait(400);
    let queue = host.last("queue_updated") as { id: string; url: string; addedByName: string }[];
    assert(queue?.length === 2 && queue[0].addedByName === "Guest Person", "Participants can add http(s) links to the queue", JSON.stringify(queue));

    outsider.socket.emit("queue_remove", { roomId: privateRoomId, itemId: queue[0].id });
    await wait(300);
    assert(roomManager.getQueue(privateRoomId).length === 2, "Outsiders cannot remove queue items");

    host.socket.emit("queue_move", { roomId: privateRoomId, itemId: queue[1].id, direction: "up" });
    await wait(300);
    queue = host.last("queue_updated");
    assert(queue[0].url === "https://example.com/b.mp4", "Host can reorder the queue");

    host.socket.emit("queue_next", { roomId: privateRoomId });
    await wait(400);
    assert(guest.last("change_video")?.url === "https://example.com/b.mp4", "queue_next plays the first item for everyone");
    assert(host.last("change_video")?.url === "https://example.com/b.mp4", "The host also receives the queued change");
    assert(roomManager.getRoom(privateRoomId)?.playback.url === "https://example.com/b.mp4", "Server playback state follows the queue");
    assert(roomManager.getQueue(privateRoomId).length === 1, "Played item leaves the queue");

    console.log("\n--- Test 12: Session start time is shared ---");
    const startedAt = guest.last("room_state")?.startedAt;
    assert(typeof startedAt === "number" && Date.now() - startedAt < 60000, "room_state includes when the session started");

    console.log("\n--- Test 13: Kicking participants ---");
    await outsider.join(privateRoomId, "secret");
    const outsiderSocketId = outsider.socket.id!;
    guest.socket.emit("kick_participant", { roomId: privateRoomId, targetSocketId: host.socket.id });
    await wait(300);
    assert(!!roomManager.getRoom(privateRoomId)?.participants.has(host.socket.id!), "Nobody can kick the host");

    host.socket.emit("kick_participant", { roomId: privateRoomId, targetSocketId: outsiderSocketId });
    await wait(500);
    assert(outsider.last("kicked")?.roomId === privateRoomId, "Kicked user is told they were removed");
    assert(host.last("participant_kicked")?.userId === outsiderId, "Room is told who was removed");
    assert(!roomManager.getRoom(privateRoomId)?.participants.has(outsiderSocketId), "Kicked socket leaves the room");

    await outsider.join(privateRoomId, "secret");
    assert(outsider.last("error")?.message === "You were removed from this room by the host", "Kicked user cannot rejoin the session");

    console.log("\n--- Test 14: Room capacity ---");
    roomManager.updateSettings(privateRoomId, { maxParticipants: 2 });
    const third = new TestClient(outsiderId, "Outsider", url, jwt.sign({ userId: outsiderId }, JWT_SECRET));
    roomManager.getRoom(privateRoomId)!.bannedUserIds.clear();
    await third.connect();
    await third.join(privateRoomId, "secret");
    assert(third.last("error")?.message === "Room is full", "Joining a full room is rejected");
    third.disconnect();

    console.log("\n--- Test 15: Accurate saved playback position ---");
    const now = Date.now();
    const pos = roomManager.getCurrentPlaybackTime({ playing: true, time: 10, url: "", lastUpdatedAt: now - 5000 });
    assert(pos >= 14.9 && pos <= 15.5, "Playing position is extrapolated from the last update", String(pos));
    assert(roomManager.getCurrentPlaybackTime({ playing: false, time: 10, url: "", lastUpdatedAt: now - 5000 }) === 10, "Paused position is unchanged");

    console.log("\n--- Test 16: Subtitles ---");
    // The outsider was removed earlier, so it is no longer in the room.
    outsider.socket.emit("subtitles_set", { roomId: privateRoomId, label: "Nope", vtt: "WEBVTT\n\n" });
    await wait(300);
    assert(!roomManager.getRoom(privateRoomId)?.subtitles, "People outside the room cannot set subtitles");
    host.socket.emit("subtitles_set", { roomId: privateRoomId, label: "English", vtt: "WEBVTT\n\n00:00.000 --> 00:02.000\nHello" });
    await wait(300);
    assert(guest.last("subtitles_updated")?.label === "English", "Subtitles are shared with the room");

    console.log("\n--- Test 17: Viewer sync reports ---");
    guest.socket.emit("playback_report", { roomId: privateRoomId, state: "buffering", drift: 2.345 });
    await wait(300);
    const report = host.last("viewer_sync");
    assert(report?.socketId === guest.socket.id && report.state === "buffering" && report.drift === 2.3, "Host receives rounded sync reports", report);

    console.log("\n--- Test 18: Vote to skip ---");
    for (const item of [...roomManager.getQueue(privateRoomId)]) {
      host.socket.emit("queue_remove", { roomId: privateRoomId, itemId: item.id });
    }
    await wait(300);
    host.socket.emit("queue_add", { roomId: privateRoomId, url: "https://example.com/next.mp4" });
    await wait(300);
    const persistedQueue = await (async () => {
      await new Promise((r) => setTimeout(r, 200));
      return prisma.roomQueueItem.findMany({ where: { roomId: privateRoomId } });
    })();
    assert(persistedQueue.some((q) => q.url === "https://example.com/next.mp4"), "Queue items are saved to the database");

    // host + guest in the room -> 2 votes needed
    guest.socket.emit("vote_skip", { roomId: privateRoomId });
    await wait(300);
    const votes = host.last("skip_votes");
    assert(votes?.count === 1 && votes.needed === 2, "Votes are counted against a majority", votes);
    guest.socket.emit("vote_skip", { roomId: privateRoomId });
    await wait(300);
    assert(host.last("skip_votes")?.count === 0, "Voting again withdraws the vote");
    guest.socket.emit("vote_skip", { roomId: privateRoomId });
    host.socket.emit("vote_skip", { roomId: privateRoomId });
    await wait(400);
    const nextUrl = roomManager.getRoom(privateRoomId)?.playback.url;
    assert(!!guest.last("skip_passed") && nextUrl === "https://example.com/next.mp4", "Majority vote plays the next queued video");
    assert(guest.last("subtitles_updated") === null, "Changing video clears subtitles");
    assert(host.last("skip_votes")?.count === 0, "Votes reset for the new video");
    guest.socket.emit("vote_skip", { roomId: privateRoomId });
    await wait(300);
    assert(guest.last("error")?.message === "Nothing is queued to skip to", "Can't vote to skip with an empty queue");

    console.log("\n--- Test 19: Recently played ---");
    const recent = host.last("recently_played") as { url: string }[];
    assert(Array.isArray(recent) && recent[0]?.url === "https://example.com/next.mp4", "Video changes are recorded as recently played", recent);

    console.log("\n--- Test 20: Only http(s) video URLs ---");
    host.socket.emit("change_video", { roomId: privateRoomId, url: "javascript:alert(1)" });
    await wait(300);
    assert(roomManager.getRoom(privateRoomId)?.playback.url === "https://example.com/next.mp4", "javascript: URLs are rejected");

    console.log("\n--- Test 21: Countdown start ---");
    guest.socket.emit("start_countdown", { roomId: privateRoomId, seconds: 3 }); // guest is a co-host here
    await wait(300);
    const cd = host.last("countdown");
    assert(typeof cd?.endsAt === "number" && cd.endsAt - Date.now() > 2000, "Co-host can start a countdown everyone sees", cd);
    assert(host.last("pause_video") !== undefined && roomManager.getRoom(privateRoomId)?.playback.playing === false, "Countdown pauses everyone first");
    host.socket.emit("start_countdown", { roomId: privateRoomId, seconds: 3 });
    await wait(200);
    assert(host.last("error")?.message === "A countdown is already running", "Only one countdown at a time");
    await wait(3000);
    assert(host.last("countdown") === null && guest.last("play_video") !== undefined, "Playback starts for everyone when it ends");
    assert(roomManager.getRoom(privateRoomId)?.playback.playing === true, "Server state is playing after the countdown");

    host.socket.emit("start_countdown", { roomId: privateRoomId, seconds: 5 });
    await wait(200);
    host.socket.emit("cancel_countdown", { roomId: privateRoomId });
    await wait(300);
    assert(guest.last("countdown") === null && roomManager.getCountdownEndsAt(privateRoomId) === null, "Countdowns can be cancelled");

    console.log("\n--- Test 22: Deleting chat messages ---");
    host.socket.emit("send_message", { roomId: privateRoomId, userId: hostId, userName: "Host Person", content: "delete me" });
    await wait(400);
    const toDelete = guest.last("receive_message");
    // Wait out the chat limiter from the flood test before the guest posts again.
    await wait(5000);
    guest.socket.emit("send_message", { roomId: privateRoomId, userId: guestId, userName: "Guest Person", content: "mine" });
    await wait(400);
    const guestMsg = host.last("receive_message");
    host.socket.emit("delete_message", { roomId: privateRoomId, messageId: toDelete.id });
    guest.socket.emit("delete_message", { roomId: privateRoomId, messageId: guestMsg.id });
    await wait(400);
    const deletedIds = (guest.events["message_deleted"] || []).map((e: { id: string }) => e.id);
    assert(deletedIds.includes(toDelete.id) && deletedIds.includes(guestMsg.id), "Hosts and authors can delete messages");
    assert(!(await prisma.message.findUnique({ where: { id: toDelete.id } })), "Deleted messages are removed from the database");

    console.log("\n--- Test 23: Removing a co-host ---");
    guest.socket.emit("remove_cohost", { roomId: privateRoomId, targetUserId: guestId });
    await wait(400);
    assert(host.last("cohost_removed")?.userId === guestId && !roomManager.isAuthorized(privateRoomId, guestId), "Co-hosts can step down");
    const stillCo = await prisma.roomCoHost.findUnique({ where: { roomId_userId: { roomId: privateRoomId, userId: guestId } } });
    assert(!stillCo, "Co-host removal is saved");
    guest.socket.emit("delete_message", { roomId: privateRoomId, messageId: "x".repeat(10) });
    guest.socket.emit("start_countdown", { roomId: privateRoomId, seconds: 3 });
    await wait(300);
    assert(roomManager.getCountdownEndsAt(privateRoomId) === null, "Former co-hosts lose host controls");

    console.log("\n--- Test 24: Long display names can join ---");
    const longName = "L".repeat(90);
    await prisma.user.update({ where: { id: outsiderId }, data: { name: longName } });
    roomManager.getRoom(privateRoomId)!.bannedUserIds.clear();
    roomManager.updateSettings(privateRoomId, { maxParticipants: 10 });
    const longClient = new TestClient(outsiderId, longName, url, jwt.sign({ userId: outsiderId }, JWT_SECRET));
    await longClient.connect();
    await longClient.join(privateRoomId, "secret");
    assert(!!longClient.last("room_state"), "A 90-character name can join", longClient.last("error"));

    console.log("\n--- Test 25: A socket is only in one room ---");
    await longClient.join(otherRoomId);
    assert(!roomManager.getRoom(privateRoomId)?.participants.has(longClient.socket.id!), "Joining another room leaves the first");
    assert(roomManager.getRoom(otherRoomId)?.participants.has(longClient.socket.id!) === true, "…and joins the second");
    longClient.disconnect();

    console.log("\n--- Test 26: Room password attempts are throttled ---");
    const guesser = new TestClient(outsiderId, longName, url, jwt.sign({ userId: outsiderId }, JWT_SECRET));
    await guesser.connect();
    for (let i = 0; i < 10; i++) {
      guesser.socket.emit("join_room", { roomId: privateRoomId, userId: outsiderId, userName: "x", password: `guess${i}` });
    }
    await wait(1500);
    await guesser.join(privateRoomId, "secret");
    assert(guesser.last("error")?.message?.startsWith("Too many password attempts"), "Even the right password is refused after 10 wrong guesses", guesser.last("error"));
    guesser.disconnect();

    console.log("\n--- Test 27: Chat replay capture ---");
    await wait(5000); // let the chat limiter window pass
    const playing = roomManager.getRoom(privateRoomId)!;
    roomManager.updatePlayback(privateRoomId, { url: "https://example.com/replay.mp4", time: 42, playing: false });
    host.socket.emit("send_message", { roomId: privateRoomId, userId: hostId, userName: "Host Person", content: "at 42s" });
    await wait(500);
    const replayMsg = await prisma.message.findFirst({ where: { roomId: privateRoomId, content: "at 42s" } });
    assert(replayMsg?.videoUrl === "https://example.com/replay.mp4" && replayMsg.videoTime === 42, "Messages record the video and position", replayMsg);
    void playing;

    console.log("\n--- Test 28: Polls ---");
    host.socket.emit("poll_create", { roomId: privateRoomId, question: "Next?", options: ["https://example.com/p1.mp4", "https://example.com/p2.mp4"], queueWinner: true });
    await wait(300);
    const poll = guest.last("poll_updated");
    assert(poll?.question === "Next?" && poll.counts.join() === "0,0" && !poll.closed, "Host can start a poll everyone sees", poll);
    host.socket.emit("poll_create", { roomId: privateRoomId, question: "Again", options: ["a", "b"] });
    await wait(300);
    assert(host.last("error")?.message === "Close the current poll before starting another", "Only one open poll at a time");
    guest.socket.emit("poll_create", { roomId: privateRoomId, question: "Mine", options: ["a", "b"] });
    await wait(200);
    assert(host.last("poll_updated")?.question === "Next?", "Viewers can't start polls");
    guest.socket.emit("poll_vote", { roomId: privateRoomId, pollId: poll.id, option: 1 });
    host.socket.emit("poll_vote", { roomId: privateRoomId, pollId: poll.id, option: 1 });
    await wait(300);
    assert(host.last("poll_updated")?.counts.join() === "0,2", "Votes are counted", host.last("poll_updated"));
    assert(guest.last("poll_my_vote") === 1, "Voters learn their own choice");
    guest.socket.emit("poll_vote", { roomId: privateRoomId, pollId: poll.id, option: 0 });
    await wait(300);
    assert(host.last("poll_updated")?.counts.join() === "1,1" && host.last("poll_updated")?.totalVotes === 2, "Changing a vote moves it");
    host.socket.emit("poll_vote", { roomId: privateRoomId, pollId: poll.id, option: 0 });
    await wait(200);
    host.socket.emit("poll_close", { roomId: privateRoomId, pollId: poll.id });
    await wait(400);
    const closedPoll = guest.last("poll_updated");
    assert(closedPoll?.closed === true && closedPoll.winner === 0, "Closing picks the winner", closedPoll);
    assert(roomManager.getQueue(privateRoomId).some((q) => q.url === "https://example.com/p1.mp4"), "Queue polls add the winner to the queue");
    host.socket.emit("poll_create", { roomId: privateRoomId, question: "Bad", options: ["not a link", "x"], queueWinner: true });
    await wait(200);
    assert(guest.last("poll_updated")?.id === poll.id, "Queue polls require links");

    console.log("\n--- Test 29: Mute and slow mode ---");
    host.socket.emit("mute_user", { roomId: privateRoomId, targetUserId: guestId, minutes: 5 });
    await wait(300);
    const settings = guest.last("chat_settings");
    assert(settings?.muted?.some((m: { userId: string; until: number }) => m.userId === guestId && m.until > Date.now()), "Muted users are listed with an expiry", settings);
    guest.socket.emit("send_message", { roomId: privateRoomId, userId: guestId, userName: "Guest Person", content: "can you hear me" });
    await wait(300);
    assert(/muted/.test(guest.last("chat_rate_limited")?.message ?? "") && host.last("receive_message")?.content !== "can you hear me", "Muted users can't chat");
    host.socket.emit("mute_user", { roomId: privateRoomId, targetUserId: guestId, minutes: 0 });
    host.socket.emit("set_slow_mode", { roomId: privateRoomId, seconds: 10 });
    await wait(300);
    assert(guest.last("chat_settings")?.slowModeSeconds === 10 && guest.last("chat_settings")?.muted.length === 0, "Unmute and slow mode are broadcast");
    guest.socket.emit("send_message", { roomId: privateRoomId, userId: guestId, userName: "Guest Person", content: "first" });
    await wait(300);
    guest.socket.emit("send_message", { roomId: privateRoomId, userId: guestId, userName: "Guest Person", content: "second" });
    await wait(300);
    assert(host.last("receive_message")?.content === "first" && /Slow mode/.test(guest.last("chat_rate_limited")?.message ?? ""), "Slow mode spaces out viewer messages");
    host.socket.emit("send_message", { roomId: privateRoomId, userId: hostId, userName: "Host Person", content: "host1" });
    await wait(200);
    host.socket.emit("send_message", { roomId: privateRoomId, userId: hostId, userName: "Host Person", content: "host2" });
    await wait(300);
    assert(guest.last("receive_message")?.content === "host2", "Hosts aren't slowed down");
    guest.socket.emit("mute_user", { roomId: privateRoomId, targetUserId: hostId, minutes: 5 });
    await wait(200);
    assert(roomManager.getChatSettings(privateRoomId).muted.length === 0, "Viewers can't mute anyone");
    host.socket.emit("set_slow_mode", { roomId: privateRoomId, seconds: 0 });

    console.log("\n--- Test 30: Evicting a room notifies everyone ---");
    roomManager.evictRoom(privateRoomId);
    await wait(300);
    assert(guest.last("room_ended")?.roomId === privateRoomId, "Participants receive room_ended");
    assert(roomManager.getRoom(privateRoomId) === undefined, "In-memory room is removed");
  } finally {
    host.disconnect();
    guest.disconnect();
    outsider.disconnect();
    io.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await prisma.$disconnect();
  }

  console.log("\n==================================================");
  console.log(`TEST RESULTS: ${testsPassed} PASSED, ${testsFailed} FAILED`);
  console.log("==================================================");

  if (testsFailed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
