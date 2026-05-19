const express = require("express");
const router = express.Router();
const mongo = require("../../lib/mongo");
const { ObjectId } = require("mongodb");
const { authMiddleware } = require("../../lib/auth");

// ══════════════════════════════════════════════════════════════
// ADMIN ↔ MANAGEMENT INTERNAL CHAT
// Collection: "admin_messages"
// Room format: "admin_mgmt_{managementUserId}"
// ══════════════════════════════════════════════════════════════

// List all management users (for starting a conversation)
router.get("/management-users", authMiddleware, async (req, res, next) => {
  try {
    const col = await mongo.getCollection("management");
    const users = await col
      .find({})
      .project({ name: 1, email: 1, role: 1, reference: 1, phone: 1 })
      .toArray();

    res.json({ status: "success", users });
  } catch (err) {
    next(err);
  }
});

// Admin inbox — list of conversations with management users
router.get("/inbox", authMiddleware, async (req, res, next) => {
  try {
    const msgCol = await mongo.getCollection("admin_messages");

    const inbox = await msgCol
      .aggregate([
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: "$room",
            managementUserId: { $first: "$managementUserId" },
            lastMessage: { $first: "$text" },
            lastMessageTime: { $first: "$createdAt" },
            senderType: { $first: "$senderType" },
            unreadCount: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$senderType", "management"] },
                      { $ne: ["$status", "read"] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
        { $sort: { lastMessageTime: -1 } },
      ])
      .toArray();

    // Enrich with management user info
    const mgmtCol = await mongo.getCollection("management");
    const enriched = [];

    for (const chat of inbox) {
      let userInfo = null;
      if (chat.managementUserId) {
        try {
          userInfo = await mgmtCol.findOne(
            { _id: new ObjectId(chat.managementUserId) },
            { projection: { name: 1, email: 1, role: 1, reference: 1 } }
          );
        } catch (e) {
          /* invalid ObjectId */
        }
      }

      enriched.push({
        ...chat,
        userName: userInfo?.name || "Unknown User",
        userRole: userInfo?.role || "manager",
        userRef: userInfo?.reference || "",
        userEmail: userInfo?.email || "",
      });
    }

    res.json({ status: "success", inbox: enriched });
  } catch (err) {
    next(err);
  }
});

// Chat history for a specific room
router.get("/history/:room", authMiddleware, async (req, res, next) => {
  try {
    const room = req.params.room;
    const msgCol = await mongo.getCollection("admin_messages");

    // Mark management messages as read
    await msgCol.updateMany(
      { room, senderType: "management", status: { $ne: "read" } },
      { $set: { status: "read" } }
    );

    const messages = await msgCol
      .find({ room })
      .sort({ createdAt: 1 })
      .limit(200)
      .toArray();

    res.json({ status: "success", messages });
  } catch (err) {
    next(err);
  }
});

// Send a message from admin
router.post("/message", authMiddleware, async (req, res, next) => {
  try {
    const { room, text, managementUserId } = req.body;
    if (!room || !text || !managementUserId) {
      return res.status(400).json({ error: "room, text, and managementUserId are required" });
    }

    const msgCol = await mongo.getCollection("admin_messages");
    const messageDoc = {
      room,
      managementUserId,
      senderType: "admin",
      senderId: "admin",
      senderName: "Admin",
      senderRole: "admin",
      senderRef: "system",
      text,
      createdAt: new Date(),
      status: "sent",
    };

    await msgCol.insertOne(messageDoc);
    res.status(201).json({ status: "success", message: messageDoc });
  } catch (err) {
    next(err);
  }
});

// Mark messages as delivered (called when management polls inbox)
router.put("/mark-delivered", authMiddleware, async (req, res, next) => {
  try {
    const { room } = req.body;
    if (!room) return res.status(400).json({ error: "room is required" });

    const msgCol = await mongo.getCollection("admin_messages");
    await msgCol.updateMany(
      { room, senderType: "admin", status: "sent" },
      { $set: { status: "delivered" } }
    );

    res.json({ status: "success" });
  } catch (err) {
    next(err);
  }
});

// Mark messages as read (called when management opens a chat)
router.put("/mark-read", authMiddleware, async (req, res, next) => {
  try {
    const { room } = req.body;
    if (!room) return res.status(400).json({ error: "room is required" });

    const msgCol = await mongo.getCollection("admin_messages");
    await msgCol.updateMany(
      { room, senderType: "admin", status: { $ne: "read" } },
      { $set: { status: "read" } }
    );

    res.json({ status: "success" });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
