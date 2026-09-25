import { z } from "zod";
import { Socket } from "socket.io";

export const joinGlobalRoomSchema = z.object({
  userId: z.string().uuid(),
});

export const joinRoomSchema = z.object({
  roomId: z.string().uuid(),
  userId: z.string().uuid(),
  userName: z.string().min(1).max(100),
  password: z.string().optional(),
});

export const sendMessageSchema = z.object({
  roomId: z.string().uuid(),
  userId: z.string().uuid(),
  userName: z.string().min(1).max(100),
  content: z.string().min(1).max(1000), // Max 1000 chars for chat
});

export const roomTimeSchema = z.object({
  roomId: z.string().uuid(),
  time: z.number().min(0),
});

export const syncTimeSchema = z.object({
  roomId: z.string().uuid(),
  time: z.number().min(0),
  playing: z.boolean().optional(),
});

export const changeVideoSchema = z.object({
  roomId: z.string().uuid(),
  // Only http(s): other schemes (javascript:, data:, file:) have no business in a player.
  url: z.string().trim().max(2000).url().refine((u) => /^https?:\/\//i.test(u), "Only http(s) links are supported").or(z.literal("")),
});

export const syncResponseSchema = z.object({
  targetSocketId: z.string(),
  time: z.number().min(0),
  playing: z.boolean(),
  url: z.string(),
});

export const webrtcOfferAnswerSchema = z.object({
  offer: z.any().optional(), // WebRTC offer
  answer: z.any().optional(), // WebRTC answer
  to: z.string(),
  from: z.string(),
});

export const webrtcCandidateSchema = z.object({
  candidate: z.any(),
  to: z.string(),
  from: z.string(),
});

export const roomOnlySchema = z.object({
  roomId: z.string().uuid(),
});

export const participantStatusSchema = z.object({
  roomId: z.string().uuid(),
  cam: z.boolean(),
  mic: z.boolean(),
});

export const makeCohostSchema = z.object({
  roomId: z.string().uuid(),
  targetSocketId: z.string(),
});

export const screenShareStartSchema = z.object({
  roomId: z.string().uuid(),
  streamId: z.string(),
});

export const ALLOWED_REACTIONS = ["😂", "❤️", "🔥", "👏", "😮", "😢", "🍿", "👍"] as const;

export const reactionSchema = z.object({
  roomId: z.string().uuid(),
  emoji: z.enum(ALLOWED_REACTIONS),
});

export const targetSocketSchema = z.object({
  roomId: z.string().uuid(),
  targetSocketId: z.string().min(1).max(100),
});

export const typingSchema = z.object({
  roomId: z.string().uuid(),
  isTyping: z.boolean(),
});

export const queueAddSchema = z.object({
  roomId: z.string().uuid(),
  url: z.string().trim().url().max(2000).refine((u) => /^https?:\/\//i.test(u), "Only http(s) links are supported"),
});

export const queueAddManySchema = z.object({
  roomId: z.string().uuid(),
  urls: z
    .array(z.string().trim().url().max(2000).refine((u) => /^https?:\/\//i.test(u), "Only http(s) links are supported"))
    .min(1)
    .max(50),
});

export const queueItemSchema = z.object({
  roomId: z.string().uuid(),
  itemId: z.string().min(1).max(100),
});

export const queueMoveSchema = queueItemSchema.extend({
  direction: z.enum(["up", "down"]),
});

export const subtitlesSchema = z.object({
  roomId: z.string().uuid(),
  label: z.string().trim().min(1).max(100),
  vtt: z.string().startsWith("WEBVTT"),
});

export const playbackReportSchema = z.object({
  roomId: z.string().uuid(),
  state: z.enum(["synced", "drifting", "buffering", "error"]),
  drift: z.number().finite().min(-86400).max(86400),
});

export const countdownSchema = z.object({
  roomId: z.string().uuid(),
  seconds: z.number().int().min(3).max(10),
});

export const deleteMessageSchema = z.object({
  roomId: z.string().uuid(),
  messageId: z.string().min(1).max(100),
});

export const targetUserSchema = z.object({
  roomId: z.string().uuid(),
  targetUserId: z.string().uuid(),
});

const httpUrl = z.string().trim().url().max(2000).refine((u) => /^https?:\/\//i.test(u), "Only http(s) links are supported");

export const pollCreateSchema = z
  .object({
    roomId: z.string().uuid(),
    question: z.string().trim().min(1).max(200),
    options: z.array(z.string().trim().min(1).max(200)).min(2).max(6),
    queueWinner: z.boolean().optional(),
    durationSeconds: z.union([z.literal(0), z.literal(30), z.literal(60), z.literal(120), z.literal(300)]).optional(),
  })
  .refine((p) => !p.queueWinner || p.options.every((o) => httpUrl.safeParse(o).success), "Queue polls need a video link for every option");

export const pollVoteSchema = z.object({
  roomId: z.string().uuid(),
  pollId: z.string().uuid(),
  option: z.number().int().min(0).max(5),
});

export const pollCloseSchema = z.object({
  roomId: z.string().uuid(),
  pollId: z.string().uuid(),
});

export const slowModeSchema = z.object({
  roomId: z.string().uuid(),
  seconds: z.union([z.literal(0), z.literal(5), z.literal(10), z.literal(30), z.literal(60)]),
});

export const muteSchema = z.object({
  roomId: z.string().uuid(),
  targetUserId: z.string().uuid(),
  /** 0 unmutes; null mutes until unmuted. */
  minutes: z.union([z.literal(0), z.literal(5), z.literal(15), z.literal(60), z.null()]),
});

export const validateSocketPayload = <T>(schema: z.ZodType<T>, data: unknown, socket: Socket): T | null => {
  const result = schema.safeParse(data);
  if (!result.success) {
    console.error(`Invalid socket payload from ${socket.id}:`, result.error.format());
    socket.emit("error", { message: "Invalid payload format" });
    return null;
  }
  return result.data;
};
