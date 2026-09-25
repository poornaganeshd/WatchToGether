import { Router } from "express";
import {
  register, login, me, updateProfile, uploadAvatar, removeAvatar, changePassword, forgotPassword, resetPassword,
} from "../controllers/auth";
import { authenticate, AuthRequest } from "../middlewares/authMiddleware";
import { rateLimit, clientIp, emailKey } from "../middlewares/rateLimit";

const router = Router();

const FIFTEEN_MIN = 15 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

// Per account+IP to stop password guessing, plus a looser per-IP cap against spraying.
const loginPerAccount = rateLimit({ name: "login-account", windowMs: FIFTEEN_MIN, max: 10, key: emailKey });
const loginPerIp = rateLimit({ name: "login-ip", windowMs: FIFTEEN_MIN, max: 50, key: clientIp });
const registerPerIp = rateLimit({ name: "register-ip", windowMs: HOUR, max: 10, key: clientIp, message: "Too many accounts created from this network. Try again later." });
const forgotPerAccount = rateLimit({ name: "forgot-account", windowMs: FIFTEEN_MIN, max: 3, key: emailKey });
const forgotPerIp = rateLimit({ name: "forgot-ip", windowMs: HOUR, max: 20, key: clientIp });
const resetPerIp = rateLimit({ name: "reset-ip", windowMs: FIFTEEN_MIN, max: 20, key: clientIp });
const passwordChangePerUser = rateLimit({ name: "password-change", windowMs: FIFTEEN_MIN, max: 10, key: (req) => (req as AuthRequest).userId ?? clientIp(req) });

router.post("/register", registerPerIp, register);
router.post("/login", loginPerIp, loginPerAccount, login);
router.post("/forgot-password", forgotPerIp, forgotPerAccount, forgotPassword);
router.post("/reset-password", resetPerIp, resetPassword);
router.get("/me", authenticate, me);
router.patch("/me", authenticate, updateProfile);
router.put("/me/avatar", authenticate, uploadAvatar);
router.delete("/me/avatar", authenticate, removeAvatar);
router.post("/me/password", authenticate, passwordChangePerUser, changePassword);

export default router;
