import { Router, Request } from "express";
import { createRoom, getRooms, getRoomById, deleteRoom, inviteRoom, joinRoom, getRoomHistory, removeRoomHistory, endRoom, updateRoom, getUpcomingRooms, getRoomBans, unbanUser, inviteGroup, listReplays, getReplay } from "../controllers/room";
import { authenticate, AuthRequest } from "../middlewares/authMiddleware";
import { rateLimit } from "../middlewares/rateLimit";
import { createInviteLink, listInviteLinks, revokeInviteLink } from "../controllers/inviteLinks";

const router = Router();

const HOUR = 60 * 60 * 1000;
const byUser = (req: Request) => (req as AuthRequest).userId ?? null;

// Room passwords are short and guessable, so throttle attempts per user and room.
const joinAttempts = rateLimit({ name: "room-join",
  windowMs: 15 * 60 * 1000,
  max: 10,
  key: (req) => {
    const userId = (req as AuthRequest).userId;
    const roomId = typeof req.body?.roomId === "string" ? req.body.roomId.trim().toUpperCase() : "";
    return userId && roomId ? `${userId}|${roomId}` : null;
  },
  message: "Too many attempts to join this room. Try again in a few minutes.",
});
const createLimit = rateLimit({ name: "room-create", windowMs: HOUR, max: 30, key: byUser, message: "You're creating rooms too quickly. Try again later." });
const inviteLimit = rateLimit({ name: "room-invite", windowMs: HOUR, max: 30, key: byUser, message: "You've sent a lot of invitations. Try again later." });

router.post("/", authenticate, createLimit, createRoom);
router.post("/join", authenticate, joinAttempts, joinRoom);
router.get("/", authenticate, getRooms);
router.get("/history", authenticate, getRoomHistory);
router.get("/upcoming", authenticate, getUpcomingRooms);
router.delete("/history/:id", authenticate, removeRoomHistory);
router.get("/:id", authenticate, getRoomById);
router.patch("/:id", authenticate, updateRoom);
router.delete("/:id", authenticate, deleteRoom);
router.post("/:id/invite", authenticate, inviteLimit, inviteRoom);
router.post("/:id/invite-group", authenticate, inviteLimit, inviteGroup);
router.post("/:id/end", authenticate, endRoom);
router.get("/:id/bans", authenticate, getRoomBans);
router.get("/:id/replays", authenticate, listReplays);
router.get("/:id/replay", authenticate, getReplay);
router.get("/:id/invite-links", authenticate, listInviteLinks);
router.post("/:id/invite-links", authenticate, inviteLimit, createInviteLink);
router.delete("/:id/invite-links/:linkId", authenticate, revokeInviteLink);
router.delete("/:id/bans/:userId", authenticate, unbanUser);

export default router;
