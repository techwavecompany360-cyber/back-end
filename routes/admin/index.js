const express = require("express");
const router = express.Router();
const mongo = require("../../lib/mongo");
const bcrypt = require("bcryptjs");
const { sign, authMiddleware } = require("../../lib/auth");
const { ObjectId } = require("mongodb");
// Admin root with items count
router.get("/", async (req, res, next) => {
  try {
    const col = await mongo.getCollection("items");
    const itemsCount = await col.countDocuments();
    res.json({ area: "admin", msg: "admin root", itemsCount });
  } catch (err) {
    next(err);
  }
});

// Stats: counts for collections
router.get("/stats", async (req, res, next) => {
  try {
    const itemsCol = await mongo.getCollection("items");
    const clientsCol = await mongo.getCollection("clients");
    const items = await itemsCol.countDocuments();
    const clients = await clientsCol.countDocuments();
    res.json({ users: clients, items, uptime: process.uptime() });
  } catch (err) {
    next(err);
  }
});

router.post("/management/profile", async (req, res, next) => {
  try {
    const ownerId = req.body.ownerId;
    console.log("Owner ID:", ownerId);
    if (!ownerId) return res.status(400).json({ error: "ownerId is required" });

    const col = await mongo.getCollection("management");
    const notes = await col.findOne({ _id: new ObjectId(ownerId) });
    res.json(notes);
  } catch (err) {
    next(err);
  }
});

router.get("/management", async (req, res, next) => {
  try {
    const col = await mongo.getCollection("management");
    const notes = await col.find({}).toArray();
    res.json(notes);
  } catch (err) {
    next(err);
  }
});

// Create admin note (for demo purposes)
router.post("/", async (req, res, next) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: "message is required" });
    const col = await mongo.getCollection("admin_notes");
    const last = await col.find({}).sort({ id: -1 }).limit(1).toArray();
    const id = last.length ? last[0].id + 1 : 1;
    const doc = { id, message, createdAt: new Date() };
    await col.insertOne(doc);
    res.status(201).json(doc);
  } catch (err) {
    next(err);
  }
});

// Admin registration
router.post("/register", async (req, res, next) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password)
      return res
        .status(400)
        .json({ error: "name, email and password are required" });

    const col = await mongo.getCollection("admin");
    const existing = await col.findOne({ email });
    if (existing)
      return res.status(409).json({ error: "email already in use" });

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    const last = await col.find({}).sort({ id: -1 }).limit(1).toArray();
    const id = last.length ? last[0].id + 1 : 1;
    const admin = { id, name, email, passwordHash, createdAt: new Date() };
    await col.insertOne(admin);
    const { passwordHash: _, ...safe } = admin;
    res.status(201).json(safe);
  } catch (err) {
    next(err);
  }
});

// Admin login -> issues JWT
router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "email and password required" });
    const col = await mongo.getCollection("admin");
    const admin = await col.findOne({ email });
    console.log(admin);
    if (!admin) return res.status(401).json({ error: "invalid credentials" });
    const ok = await bcrypt.compare(password, admin.passwordHash);
    if (!ok) return res.status(401).json({ error: "invalid credentials" });
    const token = sign({ email: admin.email, id: admin.id, role: "admin" });
    res.json({ token });
  } catch (err) {
    next(err);
  }
});

// Protected GET example
router.get("/protected", authMiddleware, async (req, res, next) => {
  try {
    res.json({ msg: "protected admin data", user: req.user });
  } catch (err) {
    next(err);
  }
});

router.post("/accomodations/approve", async (req, res, next) => {
  try {
    const { accomodationId } = req.body;
    console.log("Approving accommodation with ID:", accomodationId);
    const col = await mongo.getCollection("accomodations");
    const result = await col.updateOne(
      { _id: new ObjectId(accomodationId) },
      { $set: { adminApproval: true, status: "approved" } },
    );
    res.status(200).json({
      message: "Accommodation approved successfully",
      result,
    });
  } catch (err) {
    next(err);
  }
});

// Protected POST example
router.post("/protected", authMiddleware, async (req, res, next) => {
  try {
    const { note } = req.body;
    if (!note) return res.status(400).json({ error: "note is required" });
    const col = await mongo.getCollection("admin_notes");
    const last = await col.find({}).sort({ id: -1 }).limit(1).toArray();
    const id = last.length ? last[0].id + 1 : 1;
    const doc = { id, note, createdBy: req.user.email, createdAt: new Date() };
    await col.insertOne(doc);
    res.status(201).json(doc);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
