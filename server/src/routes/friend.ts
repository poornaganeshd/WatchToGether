import { Router } from "express";
import { getFriends, sendFriendRequest, acceptFriendRequest, removeFriend } from "../controllers/friend";
import { authenticate, AuthRequest } from "../middlewares/authMiddleware";
import { rateLimit } from "../middlewares/rateLimit";

const router = Router();

router.get("/", authenticate, getFriends);
const requestLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  key: (req) => (req as AuthRequest).userId ?? null,
  message: "You've sent a lot of friend requests. Try again later.",
});

router.post("/request", authenticate, requestLimit, sendFriendRequest);
router.post("/accept/:id", authenticate, acceptFriendRequest);
router.delete("/:id", authenticate, removeFriend);

export default router;
