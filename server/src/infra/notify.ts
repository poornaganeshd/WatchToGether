import { Server } from "socket.io";
import { presence } from "../managers/PresenceManager";
import { getClientUrl } from "../utils/mailer";
import { sendPushToUser } from "./push";

export interface AppNotification {
  title: string;
  body: string;
  roomId?: string;
  scheduledFor?: string;
}

/**
 * Delivers a notification in-app when the user is connected anywhere, and as a web push
 * (to devices that opted in) when they aren't, so alerts arrive even with the site closed.
 */
export const notifyUser = async (io: Server | undefined, userId: string, notification: AppNotification) => {
  io?.to(`user_${userId}`).emit("notification", notification);
  try {
    if (await presence.isOnline(userId)) return;
    await sendPushToUser(userId, {
      title: notification.title,
      body: notification.body,
      url: notification.roomId ? `${getClientUrl()}/room/${notification.roomId}` : `${getClientUrl()}/dashboard`,
      tag: notification.roomId ? `room-${notification.roomId}` : undefined,
    });
  } catch (err) {
    console.error("Push notification failed:", err);
  }
};
