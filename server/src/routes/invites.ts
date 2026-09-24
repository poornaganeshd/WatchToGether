import { Router } from "express";
import { getInvite, acceptInvite } from "../controllers/inviteLinks";
import { authenticate, AuthRequest } from "../middlewares/authMiddleware";
import { rateLimit } from "../middlewares/rateLimit";

const router = Router();

// Tokens are 192-bit, but there's no reason to allow unbounded lookups.
const lookupLimit = rateLimit({ name: "invite-lookup", windowMs: 15 * 60 * 1000, max: 60, key: (req) => (req as AuthRequest).userId ?? null });

router.get("/:token", authenticate, lookupLimit, getInvite);
router.post("/:token/accept", authenticate, lookupLimit, acceptInvite);

export default router;
