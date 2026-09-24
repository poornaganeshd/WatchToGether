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

function assert(condition: boolean, testName: string, detail?: string) {
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

    console.log("\n--- Test 9: Evicting a room notifies everyone ---");
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
