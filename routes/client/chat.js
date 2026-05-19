const express = require("express");
const router = express.Router();
const mongo = require("../../lib/mongo");
const { ObjectId } = require("mongodb");

// Get chat history for a specific accommodation and client
router.get("/history/:accommodationId", async (req, res, next) => {
  try {
    const accommodationId = req.params.accommodationId;
    const clientId = req.query.clientId;

    if (!accommodationId || !clientId) {
      return res.status(400).json({ error: "accommodationId and clientId are required" });
    }

    const room = `chat_${accommodationId}_${clientId}`;
    const messagesCol = await mongo.getCollection("messages");
    
    // Fetch last 100 messages for this room
    const messages = await messagesCol.find({ room }).sort({ createdAt: 1 }).limit(100).toArray();

    // Mark management messages as read (client is viewing them now)
    await messagesCol.updateMany(
      { room, senderType: "management", read: false },
      { $set: { read: true } }
    );

    // Get the accommodation to find the manager name
    let managerName = "Host";
    try {
      const accCol = await mongo.getCollection("accomodations");
      let acc = null;
      if (ObjectId.isValid(accommodationId)) {
        acc = await accCol.findOne({ _id: new ObjectId(accommodationId) });
      }
      if (acc && acc.reference) {
        const mgmtCol = await mongo.getCollection("management");
        const manager = await mgmtCol.findOne({ reference: acc.reference });
        if (manager) managerName = manager.name || "Host";
      }
    } catch (e) { /* ignore */ }

    res.status(200).json({ status: "success", messages, managerName });
  } catch (err) {
    next(err);
  }
});

// Send a message from client
router.post("/message", async (req, res, next) => {
  try {
    const { room, text, accommodationId, clientId, senderName } = req.body;
    if (!room || !text || !accommodationId || !clientId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const messagesCol = await mongo.getCollection("messages");
    const messageDoc = {
      room,
      accommodationId,
      clientId,
      senderType: 'client',
      senderId: clientId,
      senderName: senderName || 'Guest',
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

module.exports = router;
