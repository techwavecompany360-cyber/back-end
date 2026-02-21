const express = require("express");
const router = express.Router();
const mongo = require("../../lib/mongo");
const { authMiddleware } = require("../../lib/auth");
const { ObjectId } = require("mongodb");

// List clients
router.get("/", async (req, res, next) => {
  try {
    const col = await mongo.getCollection("clients");
    const docs = await col.find({}).toArray();
    res.json(docs);
  } catch (err) {
    next(err);
  }
});

// Client profile by id (numeric id field)
router.get("/profile/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const col = await mongo.getCollection("clients");
    const doc = await col.findOne({ id });
    if (!doc) return res.status(404).json({ error: "Not found" });
    res.json(doc);
  } catch (err) {
    next(err);
  }
});

// Create client
router.post("/", async (req, res, next) => {
  try {
    const { name, email } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const col = await mongo.getCollection("clients");
    const last = await col.find({}).sort({ id: -1 }).limit(1).toArray();
    const id = last.length ? last[0].id + 1 : 1;
    const doc = { id, name, email: email || null, createdAt: new Date() };
    await col.insertOne(doc);
    res.status(201).json(doc);
  } catch (err) {
    next(err);
  }
});

router.post("/bookings", async (req, res, next) => {
  try {
    const bookingData = req.body;
    console.log(bookingData);

    const col = await mongo.getCollection("bookings");
    const col1 = await mongo.getCollection("accomodations");

    const newBooking = await col.insertOne({
      ...bookingData,
      createdAt: new Date(),
    });
    await col1.updateOne(
      { _id: new ObjectId(bookingData.accomodationId) },
      {
        $inc: {
          "wallet.credit":
            parseFloat(bookingData.roomPrice) * parseInt(bookingData.nights),
        },
      },
    );
    res.status(201).json({
      status: "success",
      message: "Booking created successfully",
    });
  } catch (err) {
    next(err);
  }
});

// Protected: list clients (requires auth)
router.get("/protected", authMiddleware, async (req, res, next) => {
  try {
    const col = await mongo.getCollection("clients");
    const docs = await col.find({}).toArray();
    res.json({ user: req.user, clients: docs });
  } catch (err) {
    next(err);
  }
});

// Protected: create client
router.post("/protected", authMiddleware, async (req, res, next) => {
  try {
    const { name, email } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const col = await mongo.getCollection("clients");
    const last = await col.find({}).sort({ id: -1 }).limit(1).toArray();
    const id = last.length ? last[0].id + 1 : 1;
    const doc = {
      id,
      name,
      email: email || null,
      createdBy: req.user.email,
      createdAt: new Date(),
    };
    await col.insertOne(doc);
    res.status(201).json(doc);
  } catch (err) {
    next(err);
  }
});

router.get("/accomodations", async (req, res, next) => {
  try {
    const col = await mongo.getCollection("accomodations");

    const accomodationData = await col
      .aggregate([
        {
          $match: { adminApproval: true },
        },
        {
          $addFields: {
            idAsString: { $toString: "$_id" },
          },
        },
        {
          $lookup: {
            from: "rooms",
            localField: "idAsString",
            foreignField: "accomodationReference",
            as: "rooms",
          },
        },
        {
          $addFields: {
            lowestPrice: { $min: "$rooms.price" },
            highestPrice: { $max: "$rooms.price" },
          },
        },
        {
          $project: {
            idAsString: 0,
          },
        },
      ])
      .toArray();
    console.log(accomodationData);

    res.status(200).json({
      status: "success",
      accomodationData,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/accomodations/type", async (req, res, next) => {
  try {
    const col = await mongo.getCollection("accomodations");

    const accomodationData = await col.find({}).toArray();

    console.log(accomodationData);

    res.status(200).json({
      status: "success",
      accomodationData,
    });
  } catch (err) {
    next(err);
  }
});
module.exports = router;
