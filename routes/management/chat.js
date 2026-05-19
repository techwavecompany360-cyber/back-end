const express = require("express");
const router = express.Router();
const mongo = require("../../lib/mongo");
const { ObjectId } = require("mongodb");
const { verify } = require("../../lib/auth");

// Management-specific auth middleware that includes 'reference'
async function mgmtAuth(req, res, next) {
  try {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer "))
      return res.status(401).json({ error: "You need to be logged in to access this." });

    const token = auth.slice(7);
    const payload = verify(token);
    if (!payload || !payload.email)
      return res.status(401).json({ error: "You need to be logged in to access this." });

    const managementCol = await mongo.getCollection("management");
    let user = await managementCol.findOne({ email: payload.email });
    if (!user) {
      const usersCol = await mongo.getCollection("users");
      user = await usersCol.findOne({ email: payload.email });
    }
    if (!user) {
      const adminCol = await mongo.getCollection("admin");
      user = await adminCol.findOne({ email: payload.email });
    }
    if (!user)
      return res.status(401).json({ error: "You need to be logged in to access this." });

    req.user = {
      id: user._id ? user._id.toString() : user.id?.toString(),
      email: user.email,
      name: user.name,
      role: (user.role || "user").toString().toLowerCase(),
      reference: user.reference || (user._id ? user._id.toString() : undefined),
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: "You need to be logged in to access this." });
  }
}

// Get inbox (list of conversations) for the management user
router.get("/inbox", mgmtAuth, async (req, res, next) => {
  try {
    // 1. Get all accommodations owned by this user
    const accCol = await mongo.getCollection("accomodations");
    const accommodations = await accCol.find({ reference: req.user.reference }).toArray();
    const accIds = accommodations.map(acc => acc._id.toString());

    if (accIds.length === 0) {
      return res.status(200).json({ status: "success", inbox: [] });
    }

    // 2. Find all unique chat rooms for these accommodations
    const messagesCol = await mongo.getCollection("messages");
    
    // Aggregate to get the latest message for each room
    const inbox = await messagesCol.aggregate([
      { $match: { accommodationId: { $in: accIds } } },
      { $sort: { createdAt: -1 } },
      { 
        $group: { 
          _id: "$room",
          accommodationId: { $first: "$accommodationId" },
          clientId: { $first: "$clientId" },
          lastMessage: { $first: "$text" },
          lastMessageTime: { $first: "$createdAt" },
          senderType: { $first: "$senderType" },
          unreadCount: { 
            $sum: { 
              $cond: [ { $and: [ { $eq: ["$senderType", "client"] }, { $eq: ["$read", false] } ] }, 1, 0 ] 
            } 
          }
        } 
      },
      { $sort: { lastMessageTime: -1 } }
    ]).toArray();

    // Attach accommodation names and resolve client display names
    const clientUserCol = await mongo.getCollection("client_users");

    const enrichedInbox = [];
    for (const chat of inbox) {
      const acc = accommodations.find(a => a._id.toString() === chat.accommodationId);

      // Try to resolve the client name from client_users collection
      let clientName = null;
      if (chat.clientId && !chat.clientId.startsWith("guest_")) {
        try {
          const clientUser = await clientUserCol.findOne({ _id: new ObjectId(chat.clientId) });
          if (clientUser) {
            clientName = clientUser.name || clientUser.email || null;
          }
        } catch (e) { /* clientId may not be a valid ObjectId */ }
      }

      // Fallback: check if any message in this room has a senderName from the client
      if (!clientName) {
        const latestClientMsg = await messagesCol.findOne(
          { room: chat._id, senderType: "client", senderName: { $exists: true, $ne: "Guest" } },
          { sort: { createdAt: -1 } }
        );
        if (latestClientMsg && latestClientMsg.senderName) {
          clientName = latestClientMsg.senderName;
        }
      }

      // Final fallback
      if (!clientName) {
        clientName = chat.clientId && chat.clientId.startsWith("guest_")
          ? `Guest ${chat.clientId.substring(6, 10)}`
          : `Guest ${(chat.clientId || "").substring(0, 6)}`;
      }

      enrichedInbox.push({
        ...chat,
        accommodationName: acc ? acc.name : "Unknown Property",
        clientName,
      });
    }

    res.status(200).json({ status: "success", inbox: enrichedInbox });
  } catch (err) {
    next(err);
  }
});

// Get chat history for a specific room
router.get("/history/:room", mgmtAuth, async (req, res, next) => {
  try {
    const room = req.params.room;
    const messagesCol = await mongo.getCollection("messages");
    
    // Verify the manager has access to this room by checking if they own the accommodation
    // Room format: chat_{accommodationId}_{clientId}
    const parts = room.split('_');
    const accId = parts.length >= 2 ? parts[1] : null;
    if (accId) {
      try {
        const accCol = await mongo.getCollection("accomodations");
        const acc = await accCol.findOne({ _id: new mongo.ObjectId(accId), reference: req.user.reference });
        if (!acc && req.user.role !== 'admin') {
          return res.status(403).json({ error: "Access denied to this chat" });
        }
      } catch (e) { /* accId might not be a valid ObjectId */ }
    }

    // Mark as read where senderType is 'client'
    await messagesCol.updateMany(
      { room, senderType: "client", read: false },
      { $set: { read: true } }
    );

    const messages = await messagesCol.find({ room }).sort({ createdAt: 1 }).limit(100).toArray();

    res.status(200).json({ status: "success", messages });
  } catch (err) {
    next(err);
  }
});

// Send a message from management
router.post("/message", mgmtAuth, async (req, res, next) => {
  try {
    const { room, text, accommodationId, clientId } = req.body;
    if (!room || !text || !accommodationId || !clientId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const messagesCol = await mongo.getCollection("messages");
    const messageDoc = {
      room,
      accommodationId,
      clientId,
      senderType: 'management',
      senderId: req.user.reference || req.user.id,
      senderName: req.user.name || 'Host',
      text,
      createdAt: new Date(),
      read: false,
      delivered: true
    };
    await messagesCol.insertOne(messageDoc);

    res.status(201).json({ status: "success", message: messageDoc });
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════════════════════════════
// ADMIN ↔ MANAGEMENT CHANNEL
// Collection: "admin_messages"
// Room format: "admin_mgmt_{managementUserId}"
// ══════════════════════════════════════════════════════════════

// Management inbox for admin conversations
router.get("/admin-inbox", mgmtAuth, async (req, res, next) => {
  try {
    const room = `admin_mgmt_${req.user.id}`;
    const msgCol = await mongo.getCollection("admin_messages");

    // Mark admin-sent messages as delivered when management polls
    await msgCol.updateMany(
      { room, senderType: "admin", status: "sent" },
      { $set: { status: "delivered" } }
    );

    const messages = await msgCol.find({ room }).sort({ createdAt: -1 }).limit(1).toArray();
    const lastMsg = messages[0] || null;

    const unreadCount = await msgCol.countDocuments({
      room,
      senderType: "admin",
      status: { $ne: "read" },
    });

    res.json({
      status: "success",
      room,
      lastMessage: lastMsg ? lastMsg.text : null,
      lastMessageTime: lastMsg ? lastMsg.createdAt : null,
      senderType: lastMsg ? lastMsg.senderType : null,
      unreadCount,
      adminName: lastMsg?.senderName || "Admin",
    });
  } catch (err) {
    next(err);
  }
});

// Chat history for admin↔management channel
router.get("/admin-history/:room", mgmtAuth, async (req, res, next) => {
  try {
    const room = req.params.room;
    const msgCol = await mongo.getCollection("admin_messages");

    // Mark admin messages as read when management opens the chat
    await msgCol.updateMany(
      { room, senderType: "admin", status: { $ne: "read" } },
      { $set: { status: "read" } }
    );

    const messages = await msgCol.find({ room }).sort({ createdAt: 1 }).limit(200).toArray();

    res.json({ status: "success", messages });
  } catch (err) {
    next(err);
  }
});

// Send message from management to admin
router.post("/admin-message", mgmtAuth, async (req, res, next) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: "text is required" });

    const room = `admin_mgmt_${req.user.id}`;
    const msgCol = await mongo.getCollection("admin_messages");

    const messageDoc = {
      room,
      managementUserId: req.user.id,
      senderType: "management",
      senderId: req.user.id,
      senderName: req.user.name || "Manager",
      senderRole: req.user.role || "manager",
      senderRef: req.user.reference || "",
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

module.exports = router;
