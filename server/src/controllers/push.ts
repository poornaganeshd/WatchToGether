import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { AuthRequest } from "../middlewares/authMiddleware";
import { isPushEnabled } from "../infra/push";

const prisma = new PrismaClient();

export const getPushConfig = (_req: Request, res: Response): void => {
  res.status(200).json({ enabled: isPushEnabled(), publicKey: isPushEnabled() ? process.env.VAPID_PUBLIC_KEY : null });
};

const subscriptionSchema = z.object({
  endpoint: z.string().url().max(2000).refine((u) => u.startsWith("https://"), "Push endpoints must be https"),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
});

export const subscribePush = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!isPushEnabled()) {
      res.status(503).json({ error: "Push notifications aren't configured on this server" });
      return;
    }
    const parsed = subscriptionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }
    const { endpoint, keys } = parsed.data;
    // An endpoint belongs to one browser; re-subscribing moves it to the current account.
    await prisma.pushSubscription.upsert({
      where: { endpoint },
      update: { userId: req.userId!, p256dh: keys.p256dh, auth: keys.auth },
      create: { userId: req.userId!, endpoint, p256dh: keys.p256dh, auth: keys.auth },
    });
    res.status(201).json({ message: "Subscribed" });
  } catch (error) {
    console.error("Push Subscribe Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const unsubscribePush = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const endpoint = typeof req.body?.endpoint === "string" ? req.body.endpoint : "";
    await prisma.pushSubscription.deleteMany({ where: { endpoint, userId: req.userId! } });
    res.status(200).json({ message: "Unsubscribed" });
  } catch (error) {
    console.error("Push Unsubscribe Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};
