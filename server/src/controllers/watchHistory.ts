import { Response } from "express";
import { PrismaClient } from "@prisma/client";
import { AuthRequest } from "../middlewares/authMiddleware";
import { listWatched } from "../services/watchHistory";

const prisma = new PrismaClient();

export const getWatchHistory = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    res.status(200).json({ videos: await listWatched(req.userId!) });
  } catch (err) {
    console.error("Failed to load watch history:", err);
    res.status(500).json({ error: "Couldn't load your recently watched videos" });
  }
};

export const deleteWatchHistoryItem = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    // Scoped to the caller, so nobody can remove someone else's entries.
    const { count } = await prisma.watchedVideo.deleteMany({ where: { id: String(req.params.id), userId: req.userId! } });
    res.status(count ? 200 : 404).json(count ? { ok: true } : { error: "Not found" });
  } catch (err) {
    console.error("Failed to delete watch history item:", err);
    res.status(500).json({ error: "Couldn't remove that video" });
  }
};

export const clearWatchHistory = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await prisma.watchedVideo.deleteMany({ where: { userId: req.userId! } });
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Failed to clear watch history:", err);
    res.status(500).json({ error: "Couldn't clear your recently watched videos" });
  }
};
