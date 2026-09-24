import { Router } from "express";
import { getFriends, sendFriendRequest, acceptFriendRequest, removeFriend } from "../controllers/friend";
import { authenticate, AuthRequest } from "../middlewares/authMiddleware";
import { rateLimit } from "../middlewares/rateLimit";
import { listGroups, createGroup, updateGroup, deleteGroup } from "../controllers/friendGroups";

const router = Router();

router.get("/", authenticate, getFriends);
const requestLimit = rateLimit({ name: "friend-request",
  windowMs: 60 * 60 * 1000,
  max: 30,
  key: (req) => (req as AuthRequest).userId ?? null,
  message: "You've sent a lot of friend requests. Try again later.",
});

router.post("/request", authenticate, requestLimit, sendFriendRequest);
router.get("/groups", authenticate, listGroups);
router.post("/groups", authenticate, createGroup);
router.patch("/groups/:id", authenticate, updateGroup);
router.delete("/groups/:id", authenticate, deleteGroup);
router.post("/accept/:id", authenticate, acceptFriendRequest);
router.delete("/:id", authenticate, removeFriend);

export default router;
