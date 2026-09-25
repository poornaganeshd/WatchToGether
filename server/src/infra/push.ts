import webpush from "web-push";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
let configured: boolean | null = null;

/** Web push needs VAPID keys (generate with `npx web-push generate-vapid-keys`). */
export const isPushEnabled = () => {
  if (configured !== null) return configured;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    configured = false;
    return false;
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@watchtogether.app", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  configured = true;
  return true;
};

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

/** Sends to every device the user subscribed. Dead subscriptions are removed. */
export const sendPushToUser = async (userId: string, payload: PushPayload): Promise<number> => {
  if (!isPushEnabled()) return 0;
  const subs = await prisma.pushSubscription.findMany({ where: { userId } });
  let delivered = 0;
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload),
          { TTL: 60 * 60 }
        );
        delivered++;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await prisma.pushSubscription.deleteMany({ where: { id: sub.id } });
        } else {
          console.error("Push delivery failed:", status ?? err);
        }
      }
    })
  );
  return delivered;
};
