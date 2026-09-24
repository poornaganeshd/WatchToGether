import { z } from "zod";
import { Socket } from "socket.io";

export const joinGlobalRoomSchema = z.object({
  userId: z.string().uuid(),
});

export const joinRoomSchema = z.object({
  roomId: z.string().uuid(),
  userId: z.string().uuid(),
  userName: z.string().min(1).max(50),
  password: z.string().optional(),
});

export const sendMessageSchema = z.object({
  roomId: z.string().uuid(),
  userId: z.string().uuid(),
  userName: z.string().min(1).max(50),
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
  url: z.string().url().or(z.literal("")),
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

export const validateSocketPayload = <T>(schema: z.ZodType<T>, data: unknown, socket: Socket): T | null => {
  const result = schema.safeParse(data);
  if (!result.success) {
    console.error(`Invalid socket payload from ${socket.id}:`, result.error.format());
    socket.emit("error", { message: "Invalid payload format" });
    return null;
  }
  return result.data;
};
