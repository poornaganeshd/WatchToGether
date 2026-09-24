import { Router } from "express";
import { getFriends, sendFriendRequest, acceptFriendRequest, removeFriend } from "../controllers/friend";
import { authenticate } from "../middlewares/authMiddleware";

const router = Router();

router.get("/", authenticate, getFriends);
router.post("/request", authenticate, sendFriendRequest);
router.post("/accept/:id", authenticate, acceptFriendRequest);
router.delete("/:id", authenticate, removeFriend);

export default router;
