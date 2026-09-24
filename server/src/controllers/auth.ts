import { Request, Response } from "express";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { AuthRequest, invalidateAuthCache, signAuthToken } from "../middlewares/authMiddleware";
import { escapeHtml } from "../utils/escapeHtml";
import { getClientUrl, sendMail } from "../utils/mailer";
import { disconnectUserSockets } from "../socket";

const prisma = new PrismaClient();

const passwordSchema = z.string().min(6, "Password must be at least 6 characters").max(200, "Password is too long");

const registerSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100, "Name is too long"),
  email: z.string().trim().toLowerCase().pipe(z.string().email("Invalid email address")),
  password: passwordSchema,
});

const loginSchema = z.object({
  email: z.string().trim().pipe(z.string().email("Invalid email address")),
  password: z.string().min(1, "Password is required"),
});

const publicUser = (user: { id: string; email: string; name: string; avatarUpdatedAt?: Date | null }) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  avatarVersion: user.avatarUpdatedAt ? user.avatarUpdatedAt.getTime() : null,
});

// Emails are stored lowercased now, but older accounts may have mixed case.
export const findUserByEmail = async (email: string) => {
  const trimmed = email.trim();
  return (
    (await prisma.user.findUnique({ where: { email: trimmed.toLowerCase() } })) ??
    (await prisma.user.findFirst({ where: { email: { equals: trimmed, mode: "insensitive" } } }))
  );
};

export const me = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: { id: true, email: true, name: true, avatarUpdatedAt: true },
    });
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    res.status(200).json({ user: publicUser(user) });
  } catch (error) {
    console.error("Me Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const register = async (req: Request, res: Response): Promise<void> => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }
    const { email, password, name } = parsed.data;

    const existingUser = await findUserByEmail(email);
    if (existingUser) {
      res.status(400).json({ error: "Email already in use" });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        name,
      },
    });

    res.status(201).json({ user: publicUser(user), token: signAuthToken(user.id) });
  } catch (error) {
    console.error("Register Error:", error);
    res.status(500).json({ error: "An unexpected error occurred. Please try again later." });
  }
};

export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }
    const { email, password } = parsed.data;

    const user = await findUserByEmail(email);
    if (!user) {
      res.status(400).json({ error: "Invalid credentials" });
      return;
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      res.status(400).json({ error: "Invalid credentials" });
      return;
    }

    res.status(200).json({ user: publicUser(user), token: signAuthToken(user.id) });
  } catch (error) {
    console.error("Login Error:", error);
    res.status(500).json({ error: "An unexpected error occurred. Please try again later." });
  }
};

// --- Profile ---

const profileSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100, "Name is too long"),
});

export const updateProfile = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const parsed = profileSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }
    const user = await prisma.user.update({ where: { id: req.userId! }, data: { name: parsed.data.name } });
    res.status(200).json({ user: publicUser(user) });
  } catch (error) {
    console.error("Update Profile Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

const MAX_AVATAR_BYTES = 200 * 1024;
const AVATAR_DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/;

export const uploadAvatar = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const dataUrl = typeof req.body?.dataUrl === "string" ? req.body.dataUrl : "";
    const match = dataUrl.match(AVATAR_DATA_URL);
    if (!match) {
      res.status(400).json({ error: "Avatar must be a PNG, JPEG or WebP image" });
      return;
    }
    if (Buffer.byteLength(match[2], "base64") > MAX_AVATAR_BYTES) {
      res.status(413).json({ error: "Avatar is too large (max 200 KB)" });
      return;
    }
    const user = await prisma.user.update({
      where: { id: req.userId! },
      data: { avatar: dataUrl, avatarUpdatedAt: new Date() },
    });
    res.status(200).json({ user: publicUser(user) });
  } catch (error) {
    console.error("Upload Avatar Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const removeAvatar = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = await prisma.user.update({
      where: { id: req.userId! },
      data: { avatar: null, avatarUpdatedAt: null },
    });
    res.status(200).json({ user: publicUser(user) });
  } catch (error) {
    console.error("Remove Avatar Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// Public so <img> tags can load it; ids are unguessable UUIDs.
export const getAvatar = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: String(req.params.id) },
      select: { avatar: true },
    });
    const match = user?.avatar?.match(AVATAR_DATA_URL);
    if (!match) {
      res.setHeader("Cache-Control", "public, max-age=60");
      res.status(404).end();
      return;
    }
    res.setHeader("Content-Type", match[1]);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.status(200).send(Buffer.from(match[2], "base64"));
  } catch (error) {
    console.error("Get Avatar Error:", error);
    res.status(500).end();
  }
};

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: passwordSchema,
});

export const changePassword = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const parsed = changePasswordSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }
    const user = await prisma.user.findUnique({ where: { id: req.userId! } });
    if (!user || !(await bcrypt.compare(parsed.data.currentPassword, user.passwordHash))) {
      res.status(400).json({ error: "Current password is incorrect" });
      return;
    }
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(parsed.data.newPassword, 10), passwordChangedAt: new Date() },
    });
    invalidateAuthCache(user.id);
    // Live connections authenticated with old tokens must go too, except the requesting
    // device's own socket (it just proved the password and receives a fresh token below).
    const ownSocketId = typeof req.headers["x-socket-id"] === "string" ? req.headers["x-socket-id"] : undefined;
    disconnectUserSockets(req.app.get("io"), user.id, ownSocketId);
    // Other sessions are signed out; hand this one a fresh token.
    res.status(200).json({ message: "Password updated", token: signAuthToken(user.id) });
  } catch (error) {
    console.error("Change Password Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// --- Password reset ---

const RESET_TTL_MS = 60 * 60 * 1000;
const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

export const forgotPassword = async (req: Request, res: Response): Promise<void> => {
  // Same response whether or not the account exists, so emails can't be enumerated.
  const genericResponse = { message: "If that email has an account, a reset link is on its way." };
  try {
    const email = typeof req.body?.email === "string" ? req.body.email : "";
    if (!z.string().email().safeParse(email.trim()).success) {
      res.status(400).json({ error: "Invalid email address" });
      return;
    }
    const user = await findUserByEmail(email);
    if (!user) {
      res.status(200).json(genericResponse);
      return;
    }

    const token = crypto.randomBytes(32).toString("base64url");
    await prisma.$transaction([
      prisma.passwordResetToken.deleteMany({ where: { userId: user.id, usedAt: null } }),
      prisma.passwordResetToken.create({
        data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) },
      }),
    ]);

    const link = `${getClientUrl()}/reset-password?token=${token}`;
    const sent = await sendMail({
      to: user.email,
      subject: "Reset your WatchTogether password",
      text: `Hi ${user.name},\n\nReset your password here (valid for 1 hour): ${link}\n\nIf you didn't ask for this, you can ignore this email.`,
      html: `
        <div style="font-family: sans-serif; padding: 32px; background: #f4f4f5; border-radius: 8px;">
          <h2 style="color: #18181b;">Reset your password</h2>
          <p style="color: #52525b;">Hi ${escapeHtml(user.name)}, click below to choose a new password. The link is valid for 1 hour.</p>
          <a href="${link}" style="display: inline-block; background: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Reset password</a>
          <p style="color: #71717a; font-size: 12px; margin-top: 24px;">If you didn't ask for this, you can ignore this email.</p>
        </div>`,
    }).catch((err) => {
      console.error("Reset email failed:", err);
      return false;
    });

    if (!sent && process.env.NODE_ENV !== "production") {
      console.log(`[dev] SMTP not configured. Password reset link for ${user.email}: ${link}`);
    }
    res.status(200).json(genericResponse);
  } catch (error) {
    console.error("Forgot Password Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

const resetSchema = z.object({
  token: z.string().min(20, "Invalid reset link"),
  password: passwordSchema,
});

export const resetPassword = async (req: Request, res: Response): Promise<void> => {
  try {
    const parsed = resetSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }
    const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(parsed.data.token) } });
    if (!record || record.usedAt || record.expiresAt.getTime() < Date.now()) {
      res.status(400).json({ error: "This reset link is invalid or has expired" });
      return;
    }

    const now = new Date();
    await prisma.$transaction([
      prisma.user.update({
        where: { id: record.userId },
        data: { passwordHash: await bcrypt.hash(parsed.data.password, 10), passwordChangedAt: now },
      }),
      prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: now } }),
      prisma.passwordResetToken.deleteMany({ where: { userId: record.userId, usedAt: null } }),
    ]);
    invalidateAuthCache(record.userId);
    disconnectUserSockets(req.app.get("io"), record.userId);

    res.status(200).json({ message: "Password reset. You can sign in now." });
  } catch (error) {
    console.error("Reset Password Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};
