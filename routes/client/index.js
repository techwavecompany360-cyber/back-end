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
    // console.log("=== INCOMING BOOKING DATA ===", JSON.stringify(bookingData, null, 2));
    // Validate required fields
    if (!bookingData.roomId || !bookingData.checkIn || !bookingData.checkOut) {
      return res
        .status(400)
        .json({ error: "Missing required fields: roomId, checkIn, checkOut" });
    }

    const col = await mongo.getCollection("bookings");

    const parsedCheckIn = new Date(bookingData.checkIn);
    const parsedCheckOut = new Date(bookingData.checkOut);

    // Check for overlapping bookings using Date-typed fields
    // Exclude cancelled and checked-out bookings from overlap check
    const overlappingBookings = await col
      .find({
        roomId: bookingData.roomId,
        status: { $nin: ["Cancelled", "cancelled", "Checked-Out", "checked-out"] },
        "bookingDates.checkIn": { $lt: parsedCheckOut },
        "bookingDates.checkOut": { $gt: parsedCheckIn },
      })
      .toArray();

    if (overlappingBookings.length > 0) {
      return res.status(409).json({
        error:
          "Booking conflict: The selected dates are already booked for this room",
      });
    }

    // Calculate platform fee info for online bookings
    const totalBookingAmount = (parseFloat(bookingData.roomPrice) || 0) * (parseInt(bookingData.nights) || 1);
    const platformFeeRate = 0.10; // 10% for client/online bookings
    const platformFee = totalBookingAmount * platformFeeRate;
    const hostShare = totalBookingAmount - platformFee;

    const newBooking = await col.insertOne({
      ...bookingData,
      checkIn: parsedCheckIn,
      checkOut: parsedCheckOut,
      bookingDates: {
        checkIn: parsedCheckIn,
        checkOut: parsedCheckOut,
      },
      // Fee & wallet metadata
      source: bookingData.source || "Client",
      totalBookingAmount,
      platformFee,
      platformFeeRate,
      hostShare,
      walletAction: "credit",
      createdAt: new Date(),
    });
    // Credit accommodation wallet (90% of booking value — 10% platform fee for online bookings)
    if (bookingData.accomodationId && hostShare > 0) {
      try {
        const col1 = await mongo.getCollection("accomodations");
        await col1.updateOne(
          { _id: new ObjectId(bookingData.accomodationId) },
          {
            $inc: {
              "wallet.credit": hostShare,
            },
          },
        );
        // Record transaction
        const txCol = await mongo.getCollection("wallet_transactions");
        await txCol.insertOne({
          accommodationId: bookingData.accomodationId,
          type: "booking_credit",
          description: `Online booking by ${bookingData.guestName || "Guest"}`,
          amount: hostShare,
          fee: platformFee,
          feeRate: platformFeeRate,
          grossAmount: totalBookingAmount,
          source: "Client",
          bookingId: newBooking.insertedId.toString(),
          guestName: bookingData.guestName || "",
          roomName: bookingData.roomName || "",
          createdAt: new Date(),
        });
      } catch (walletErr) {
        // console.warn("Wallet credit failed for client booking:", walletErr);
      }
    }
    res.status(201).json({
      status: "success",
      message: "Booking created successfully",
      bookingId: newBooking.insertedId,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/bookings", async (req, res, next) => {
  try {
    const bookingId = req.query.bookingId ? String(req.query.bookingId) : "";
    const email = req.query.email ? String(req.query.email).toLowerCase() : "";
    const phone = req.query.phone ? String(req.query.phone) : "";

    if (!bookingId && !email && !phone) {
      return res
        .status(400)
        .json({ error: "bookingId, email, or phone is required" });
    }

    const col = await mongo.getCollection("bookings");
    const filter = {};

    if (bookingId) {
      filter.bookingId = bookingId;
    } else if (email && phone) {
      filter.$or = [{ email }, { phone }];
    } else if (email) {
      filter.email = email;
    } else if (phone) {
      filter.phone = phone;
    }

    const bookings = await col.find(filter).toArray();
    if (!bookings.length) {
      return res.status(404).json({ error: "Booking not found" });
    }

    res.json({ status: "success", bookings });
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
          $match: { adminApproval: true, blocked: false },
        },
        {
          $addFields: {
            idAsString: { $toString: "$_id" },
          },
        },
        {
          $lookup: {
            from: "rooms",
            let: { accId: "$idAsString" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $eq: ["$accomodationReference", "$$accId"],
                  },
                  adminApproval: true,
                  blocked: false,
                },
              },
              // Add booked dates for each room
              {
                $lookup: {
                  from: "bookings",
                  let: { roomId: { $toString: "$_id" } },
                  pipeline: [
                    {
                      $match: {
                        $expr: {
                          $eq: ["$roomId", "$$roomId"],
                        },
                        status: { $nin: ["Cancelled", "cancelled", "Checked-Out", "checked-out"] },
                      },
                    },
                    {
                      $addFields: {
                        checkInDate: {
                          $cond: {
                            if: { $eq: [{ $type: "$checkIn" }, "date"] },
                            then: "$checkIn",
                            else: { $dateFromString: { dateString: { $toString: "$checkIn" } } }
                          }
                        },
                        checkOutDate: {
                          $cond: {
                            if: { $eq: [{ $type: "$checkOut" }, "date"] },
                            then: "$checkOut",
                            else: { $dateFromString: { dateString: { $toString: "$checkOut" } } }
                          }
                        },
                      },
                    },
                    {
                      $addFields: {
                        daysDifference: {
                          $divide: [
                            { $subtract: ["$checkOutDate", "$checkInDate"] },
                            86400000, // milliseconds in a day
                          ],
                        },
                      },
                    },
                    {
                      $addFields: {
                        dateRange: {
                          $map: {
                            input: {
                              $range: [0, { $add: ["$daysDifference", 1] }],
                            },
                            as: "dayOffset",
                            in: {
                              $dateToString: {
                                format: "%Y-%m-%d",
                                date: {
                                  $dateAdd: {
                                    startDate: "$checkInDate",
                                    unit: "day",
                                    amount: "$$dayOffset",
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                    {
                      $project: {
                        _id: 0,
                        dates: "$dateRange",
                      },
                    },
                  ],
                  as: "bookings",
                },
              },
              {
                $addFields: {
                  bookedDates: {
                    $reduce: {
                      input: "$bookings.dates",
                      initialValue: [],
                      in: { $setUnion: ["$$value", "$$this"] }
                    }
                  },
                },
              },
              {
                $project: {
                  bookings: 0,
                },
              },
            ],
            as: "rooms",
          },
        },

        // REMOVE accommodations with no valid rooms
        {
          $match: {
            rooms: { $ne: [] },
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
    res.status(200).json({
      status: "success",
      accomodationData,
    });
  } catch (err) {
    next(err);
  }
});

router.use("/reviews", require("./reviews"));

module.exports = router;
