import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { startReminderScheduler } from "./managers/ReminderScheduler";
import { initRedis } from "./infra/redis";

dotenv.config();

if (!process.env.JWT_SECRET) {
  console.error("FATAL ERROR: JWT_SECRET environment variable is not defined.");
  process.exit(1);
}

// Imported after dotenv so modules see the configured environment.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createApp } = require("./app") as typeof import("./app");


const start = async () => {
  // Live sessions are held in memory, so nobody can be "in" a room when the server starts.
  // Clear participant rows left behind by a crash or restart so rooms don't look live forever.
  const prisma = new PrismaClient();
  try {
    const { count } = await prisma.participant.deleteMany({});
    if (count > 0) console.log(`Cleared ${count} stale room participant(s) from a previous run`);
  } catch (err) {
    console.error("Failed to clear stale participants:", err);
  } finally {
    await prisma.$disconnect();
  }

  const redis = await initRedis();
  const { httpServer, io } = createApp({ redis });
  startReminderScheduler(io);
  const PORT = process.env.PORT || 5000;

  httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
};

start();
