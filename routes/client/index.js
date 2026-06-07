const express = require("express");
const router = express.Router();
const mongo = require("../../lib/mongo");
const { authMiddleware } = require("../../lib/auth");
const { ObjectId } = require("mongodb");
const axios = require("axios");

// ── Microservice URLs ──
const SMS_API = process.env.SMS_API_URL || "http://localhost:4001";
const PAYMENT_API = process.env.PAYMENT_API_URL || "http://localhost:4002";
const EMAIL_API = process.env.EMAIL_API_URL || "http://localhost:4003";

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

// GET UI Config
router.get("/ui-config", async (req, res, next) => {
  try {
    const col = await mongo.getCollection("system_config");
    let config = await col.findOne({ _id: "ui_config" });
    if (!config) {
      config = {
        _id: "ui_config",
        mapVisibility: "before_booking",
        chatVisibility: "before_booking",
        customUiConfig: [],
      };
    }
    // Ensure customUiConfig is an array
    if (!config.customUiConfig) {
      config.customUiConfig = [];
    }
    res.status(200).json(config);
  } catch (err) {
    next(err);
  }
});

router.post("/bookings", async (req, res, next) => {
  try {
    const bookingData = req.body;

    // Validate required fields
    if (!bookingData.roomId || !bookingData.checkIn || !bookingData.checkOut) {
      return res
        .status(400)
        .json({ error: "Missing required fields: roomId, checkIn, checkOut" });
    }

    if (!bookingData.guestName || !bookingData.email || !bookingData.phone) {
      return res
        .status(400)
        .json({ error: "Missing required fields: guestName, email, phone" });
    }

    const col = await mongo.getCollection("bookings");

    const parsedCheckIn = new Date(bookingData.checkIn);
    const parsedCheckOut = new Date(bookingData.checkOut);

    const overlappingBookings = await col
      .find({
        roomId: bookingData.roomId,
        status: { $nin: ["Cancelled", "cancelled", "Checked-Out", "checked-out"] },
        "bookingDates.checkIn": { $lt: parsedCheckOut },
        "bookingDates.checkOut": { $gt: parsedCheckIn },
      })
      .toArray();

    // Enforce "Booked Online" (external blocks) constraint
    const externalBlocksCol = await mongo.getCollection("external_blocks");
    const overlappingBlocks = await externalBlocksCol
      .find({
        roomId: bookingData.roomId,
        checkIn: { $lt: parsedCheckOut },
        checkOut: { $gt: parsedCheckIn },
      })
      .toArray();

    if (overlappingBookings.length > 0 || overlappingBlocks.length > 0) {
      return res.status(409).json({
        error: "Booking conflict: The selected dates are already booked for this room",
      });
    }

    // ── Step 1: Process Payment via Payment API ──
    let paymentResult = null;
    try {
      const paymentMethod = bookingData.paymentMethod || "card";
      let apiMethod = "card";
      if (paymentMethod.toLowerCase().includes("mpesa") || paymentMethod.toLowerCase().includes("m-pesa")) apiMethod = "mpesa";
      else if (paymentMethod.toLowerCase().includes("tigo")) apiMethod = "tigopesa";
      else if (paymentMethod.toLowerCase().includes("airtel")) apiMethod = "airtelmoney";
      else if (paymentMethod.toLowerCase().includes("halo")) apiMethod = "halopesa";
      else if (paymentMethod.toLowerCase().includes("azam")) apiMethod = "azampesa";
      else if (paymentMethod.toLowerCase().includes("bank")) apiMethod = "crdb";
      else if (paymentMethod.toLowerCase().includes("mobile")) {
        // Extract network from paymentMethod string like "Mobile Money (mpesa)"
        const match = paymentMethod.match(/\((\w+)\)/i);
        apiMethod = match ? match[1].toLowerCase() : "mpesa";
      }

      const paymentPayload = {
        amount: bookingData.totalAmount || bookingData.amountPaid || 0,
        currency: "TZS",
        method: apiMethod,
        phone: bookingData.paymentPhone || bookingData.phone,
        description: `Booking ${bookingData.bookingId} — ${bookingData.accomodationName || "ReM360"}`,
        metadata: {
          bookingId: bookingData.bookingId,
          guestName: bookingData.guestName,
          roomId: bookingData.roomId,
        },
      };

      const payRes = await axios.post(`${PAYMENT_API}/api/payment/initiate`, paymentPayload, { timeout: 15000 });
      paymentResult = payRes.data;

      if (!paymentResult.success) {
        return res.status(402).json({
          error: "Payment failed. Please try again.",
          paymentError: paymentResult.error || "Unknown payment error",
        });
      }
    } catch (payErr) {
      const errMsg = payErr?.response?.data?.error || payErr.message || "Payment service unavailable";
      console.error("Payment API error:", errMsg);
      return res.status(502).json({
        error: "Payment processing failed",
        details: errMsg,
      });
    }

    // ── Step 2: Calculate fees & Save Booking ──
    const baseRoomPrice = parseFloat(bookingData.roomPrice) || 0;
    const nights = parseInt(bookingData.nights) || 1;

    let addonsTotal = 0;
    if (bookingData.addons && Array.isArray(bookingData.addons)) {
      addonsTotal = bookingData.addons.reduce((sum, addon) => sum + (Number(addon.price) || 0), 0);
    }

    let promoDiscount = 0;
    if (bookingData.promoCode) {
      try {
        const promoCol = await mongo.getCollection("promo_codes");
        const promo = await promoCol.findOne({ code: bookingData.promoCode.toUpperCase(), status: "active" });
        if (promo) {
          const subtotal = (baseRoomPrice * nights) + addonsTotal;
          if (promo.discountType === 'percentage') {
            promoDiscount = subtotal * (promo.discountValue / 100);
          } else {
            promoDiscount = promo.discountValue;
          }
          await promoCol.updateOne({ _id: promo._id }, { $inc: { usedCount: 1 } });
        }
      } catch (e) {
        console.warn("Promo calculation failed", e);
      }
    }

    // Check per-accommodation overdraft settings
    let overdraftEnabled = false;
    let overdraftPercent = 0;
    let displayPricePerNight = baseRoomPrice;

    if (bookingData.accomodationId) {
      try {
        const accCol = await mongo.getCollection("accomodations");
        const accDoc = await accCol.findOne(
          { _id: new ObjectId(bookingData.accomodationId) },
          { projection: { onlineOverdraftEnabled: 1, onlineOverdraftPercent: 1 } }
        );
        if (accDoc?.onlineOverdraftEnabled && accDoc.onlineOverdraftPercent > 0) {
          overdraftEnabled = true;
          overdraftPercent = accDoc.onlineOverdraftPercent;
          displayPricePerNight = baseRoomPrice * (1 + overdraftPercent / 100);
        }
      } catch (accErr) {
        console.warn("Failed to check accommodation overdraft:", accErr.message);
      }
    }

    let totalBookingAmount, platformFee, platformFeeRate, hostShare;

    if (overdraftEnabled) {
      // Overdraft mode: guest pays the marked-up price, markup IS the platform fee
      totalBookingAmount = (displayPricePerNight * nights) + addonsTotal - promoDiscount;
      if (totalBookingAmount < 0) totalBookingAmount = 0;
      platformFee = (baseRoomPrice * (overdraftPercent / 100)) * nights;
      platformFeeRate = overdraftPercent / 100;
      hostShare = (baseRoomPrice * nights) + addonsTotal; // host receives base price + addons
    } else {
      // Standard mode: use system-level clientFeeRate
      totalBookingAmount = (baseRoomPrice * nights) + addonsTotal - promoDiscount;
      if (totalBookingAmount < 0) totalBookingAmount = 0;
      const configCol = await mongo.getCollection("system_config");
      const feeConfig = await configCol.findOne({ _id: "platform_fees" });
      platformFeeRate = feeConfig?.clientFeeRate ?? 0.10;

      // Apply custom rate if configured for this property
      const accId = bookingData.accomodationId || bookingData.accommodationId;
      if (accId && feeConfig?.customRates && Array.isArray(feeConfig.customRates)) {
        const custom = feeConfig.customRates.find(c => c.accommodationId === accId);
        if (custom && typeof custom.managementFeeRate === 'number') {
          platformFeeRate = custom.managementFeeRate;
        }
      }

      platformFee = totalBookingAmount * platformFeeRate;
      hostShare = totalBookingAmount - platformFee;
    }

    const isRedirect = paymentResult?.status === 'redirect' && !!paymentResult?.redirectUrl;

    const newBooking = await col.insertOne({
      ...bookingData,
      checkIn: parsedCheckIn,
      checkOut: parsedCheckOut,
      bookingDates: {
        checkIn: parsedCheckIn,
        checkOut: parsedCheckOut,
      },
      source: bookingData.source || "Client",
      totalBookingAmount,
      platformFee,
      platformFeeRate,
      hostShare,
      // Overdraft snapshot (immutable — future changes won't affect this booking)
      overdraftEnabled,
      overdraftPercent: overdraftEnabled ? overdraftPercent : null,
      basePricePerNight: baseRoomPrice,
      displayPricePerNight: overdraftEnabled ? displayPricePerNight : baseRoomPrice,
      addons: bookingData.addons || [],
      addonsTotal,
      promoCode: bookingData.promoCode || null,
      promoDiscount,
      walletAction: "credit",
      // Payment API metadata
      paymentTransactionId: paymentResult?.transactionId || null,
      paymentReceiptNumber: paymentResult?.receiptNumber || null,
      paymentStatus: isRedirect ? "Pending" : (paymentResult?.status || "completed"),
      status: isRedirect ? "Pending Payment" : "Confirmed", // Set main status to pending if redirecting
      // Server-side enrichment (data the client cannot send)
      serverMeta: {
        ipAddress: req.headers['x-forwarded-for'] || req.connection?.remoteAddress || req.ip || null,
        origin: req.headers['origin'] || null,
        referer: req.headers['referer'] || null,
        acceptLanguage: req.headers['accept-language'] || null,
        serverTimestamp: new Date().toISOString(),
      },
      createdAt: new Date(),
    });


    // ── Step 3: Credit accommodation wallet (only if payment is completed immediately) ──
    if (!isRedirect && bookingData.accomodationId && hostShare > 0) {
      try {
        const col1 = await mongo.getCollection("accomodations");
        await col1.updateOne(
          { _id: new ObjectId(bookingData.accomodationId) },
          { $inc: { "wallet.credit": hostShare } },
        );
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
          paymentTransactionId: paymentResult?.transactionId || null,
          createdAt: new Date(),
        });
      } catch (walletErr) {
        console.warn("Wallet credit failed for client booking:", walletErr.message);
      }
    }

    // ── Step 4: Send Confirmation SMS (async, non-blocking) ──
    axios.post(`${SMS_API}/api/sms/booking-confirmation`, {
      phone: bookingData.phone,
      guestName: bookingData.guestName,
      bookingId: bookingData.bookingId,
      checkIn: bookingData.checkIn,
      checkOut: bookingData.checkOut,
      propertyName: bookingData.accomodationName,
      total: totalBookingAmount,
    }, { timeout: 5000 }).catch(err => {
      console.warn("SMS confirmation failed (non-critical):", err.message);
    });

    // ── Step 5: Send Confirmation Email (async, non-blocking) ──
    axios.post(`${EMAIL_API}/api/email/booking-confirmation`, {
      to: bookingData.email,
      guestName: bookingData.guestName,
      bookingId: bookingData.bookingId,
      propertyName: bookingData.accomodationName,
      roomName: bookingData.roomName,
      checkIn: bookingData.checkIn,
      checkOut: bookingData.checkOut,
      nights: bookingData.nights,
      guests: `${bookingData.adults || 1} adult(s)${bookingData.children ? `, ${bookingData.children} child(ren)` : ""}`,
      total: totalBookingAmount,
      paymentMethod: bookingData.paymentMethodUsed || bookingData.paymentMethod,
    }, { timeout: 10000 }).catch(err => {
      console.warn("Email confirmation failed (non-critical):", err.message);
    });

    res.status(201).json({
      status: "success",
      message: "Booking created successfully",
      bookingId: newBooking.insertedId,
      bookingRef: bookingData.bookingId,
      paymentTransactionId: paymentResult?.transactionId,
      paymentReceiptNumber: paymentResult?.receiptNumber,
      redirectUrl: paymentResult?.redirectUrl || null,
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
                $lookup: {
                  from: "external_blocks",
                  let: { roomId: { $toString: "$_id" } },
                  pipeline: [
                    {
                      $match: {
                        $expr: {
                          $eq: ["$roomId", "$$roomId"],
                        },
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
                            86400000,
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
                  as: "externalBlocks",
                },
              },
              {
                $addFields: {
                  bookedDates: {
                    $reduce: {
                      input: { $concatArrays: ["$bookings.dates", "$externalBlocks.dates"] },
                      initialValue: [],
                      in: { $setUnion: ["$$value", "$$this"] }
                    }
                  },
                },
              },
              {
                $project: {
                  bookings: 0,
                  externalBlocks: 0,
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
            // Compute per-room display prices with overdraft if enabled
            rooms: {
              $map: {
                input: "$rooms",
                as: "room",
                in: {
                  $mergeObjects: [
                    "$$room",
                    {
                      onlineDisplayPrice: {
                        $cond: {
                          if: { $and: [
                            { $eq: ["$onlineOverdraftEnabled", true] },
                            { $gt: [{ $ifNull: ["$onlineOverdraftPercent", 0] }, 0] }
                          ]},
                          then: {
                            $multiply: [
                              "$$room.price",
                              { $add: [1, { $divide: [{ $ifNull: ["$onlineOverdraftPercent", 0] }, 100] }] }
                            ]
                          },
                          else: "$$room.price"
                        }
                      },
                      onlineTieredPrices: {
                        $cond: {
                          if: { $and: [
                            { $eq: ["$onlineOverdraftEnabled", true] },
                            { $gt: [{ $ifNull: ["$onlineOverdraftPercent", 0] }, 0] },
                            { $ne: [{ $type: "$$room.tieredPrices" }, "missing"] }
                          ]},
                          then: {
                            $arrayToObject: {
                              $map: {
                                input: { $objectToArray: "$$room.tieredPrices" },
                                as: "tp",
                                in: {
                                  k: "$$tp.k",
                                  v: {
                                    $multiply: [
                                      "$$tp.v",
                                      { $add: [1, { $divide: [{ $ifNull: ["$onlineOverdraftPercent", 0] }, 100] }] }
                                    ]
                                  }
                                }
                              }
                            }
                          },
                          else: "$$room.tieredPrices"
                        }
                      }
                    }
                  ]
                }
              }
            }
          },
        },

        {
          $addFields: {
            lowestPrice: { $min: "$rooms.onlineDisplayPrice" },
            highestPrice: { $max: "$rooms.onlineDisplayPrice" },
          },
        },
        {
          $project: {
            idAsString: 0,
          },
        },
      ])
      .toArray();

    // Enrich with review summary data
    try {
      const reviewsCol = await mongo.getCollection("reviews");
      const reviewSummaries = await reviewsCol.aggregate([
        { $group: {
          _id: "$accommodationId",
          averageRating: { $avg: "$rating" },
          totalReviews: { $sum: 1 }
        }}
      ]).toArray();

      const summaryMap = new Map();
      for (const s of reviewSummaries) {
        summaryMap.set(s._id, { averageRating: parseFloat(s.averageRating.toFixed(1)), totalReviews: s.totalReviews });
      }

      for (const acc of accomodationData) {
        const accId = acc._id.toString();
        const summary = summaryMap.get(accId);
        acc.averageRating = summary?.averageRating || 0;
        acc.totalReviews = summary?.totalReviews || 0;
      }
    } catch (reviewErr) {
      console.warn("Failed to enrich accommodations with reviews:", reviewErr.message);
    }

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

    const accomodationData = await col.find({ adminApproval: true, blocked: { $ne: true } }).toArray();
    res.status(200).json({
      status: "success",
      accomodationData,
    });
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════════════════════════════
// FEEDBACK SUBMISSION (Public — no auth required)
// ══════════════════════════════════════════════════════════════
router.post("/feedback", async (req, res, next) => {
  try {
    const { userName, phone, email, rating, comment } = req.body;

    if (!userName || !comment) {
      return res.status(400).json({ error: "userName and comment are required" });
    }

    const col = await mongo.getCollection("feedback");
    const doc = {
      userName: userName.trim(),
      phone: (phone || "").trim() || null,
      email: (email || "").trim() || null,
      rating: Math.min(5, Math.max(1, parseInt(rating) || 5)),
      comment: comment.trim(),
      status: "new", // new | reviewed | archived
      adminNotes: null,
      createdAt: new Date(),
      userAgent: req.headers["user-agent"] || null,
      ipAddress: req.ip || req.connection?.remoteAddress || null,
    };

    await col.insertOne(doc);
    res.status(201).json({ status: "success", message: "Feedback received successfully" });
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════════════════════════════
// PROMO CODES VALIDATION
// ══════════════════════════════════════════════════════════════
router.post("/promo-codes/validate", async (req, res, next) => {
  try {
    const { code, accommodationId } = req.body;
    if (!code) return res.status(400).json({ error: "Code is required" });

    const col = await mongo.getCollection("promo_codes");
    const promo = await col.findOne({ code: code.toUpperCase(), status: "active" });

    if (!promo) {
      return res.status(404).json({ error: "Invalid or inactive promo code" });
    }

    if (promo.accommodationId && promo.accommodationId !== accommodationId) {
      return res.status(400).json({ error: "Promo code not valid for this property" });
    }

    if (promo.validFrom && new Date() < new Date(promo.validFrom)) {
      return res.status(400).json({ error: "Promo code not yet active" });
    }

    if (promo.validTo && new Date() > new Date(promo.validTo)) {
      return res.status(400).json({ error: "Promo code expired" });
    }

    if (promo.maxUses && promo.usedCount >= promo.maxUses) {
      return res.status(400).json({ error: "Promo code usage limit reached" });
    }

    res.json({
      status: "success",
      promoCode: {
        code: promo.code,
        discountType: promo.discountType,
        discountValue: promo.discountValue
      }
    });
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════════════════════════════
// FAVORITES (Client Users)
// ══════════════════════════════════════════════════════════════
router.post("/users/favorites", authMiddleware, async (req, res, next) => {
  try {
    const { accommodationId } = req.body;
    if (!accommodationId) return res.status(400).json({ error: "accommodationId is required" });

    let userDoc, collectionName;
    for (const name of ["client_users", "users", "management", "admin"]) {
      const col = await mongo.getCollection(name);
      userDoc = await col.findOne({ email: req.user.email });
      if (userDoc) { collectionName = name; break; }
    }

    if (!userDoc) return res.status(404).json({ error: "User not found" });

    const col = await mongo.getCollection(collectionName);
    const favorites = userDoc.favorites || [];
    const index = favorites.indexOf(accommodationId);

    if (index > -1) {
      favorites.splice(index, 1); // remove
    } else {
      favorites.push(accommodationId); // add
    }

    await col.updateOne({ _id: userDoc._id }, { $set: { favorites } });

    res.json({ status: "success", favorites });
  } catch (err) {
    next(err);
  }
});

router.get("/users/favorites", authMiddleware, async (req, res, next) => {
  try {
    let userDoc;
    for (const name of ["client_users", "users", "management", "admin"]) {
      const col = await mongo.getCollection(name);
      userDoc = await col.findOne({ email: req.user.email });
      if (userDoc) break;
    }

    if (!userDoc) return res.status(404).json({ error: "User not found" });

    const favoriteIds = userDoc.favorites || [];
    
    if (favoriteIds.length === 0) {
      return res.json({ status: "success", favorites: [], favoriteIds: [] });
    }

    const accCol = await mongo.getCollection("accomodations");
    const favorites = await accCol.find({
      _id: { $in: favoriteIds.map(id => { try { return new ObjectId(id); } catch(e) { return null; } }).filter(id => id) }
    }).toArray();

    // Enrich with reviews
    const reviewsCol = await mongo.getCollection("reviews");
    const summaries = await reviewsCol.aggregate([
      { $match: { accommodationId: { $in: favoriteIds } } },
      { $group: { _id: "$accommodationId", averageRating: { $avg: "$rating" }, totalReviews: { $sum: 1 } } }
    ]).toArray();

    const summaryMap = new Map(summaries.map(s => [s._id, s]));

    for (const f of favorites) {
      const summary = summaryMap.get(f._id.toString());
      f.averageRating = summary ? parseFloat(summary.averageRating.toFixed(1)) : 0;
      f.totalReviews = summary ? summary.totalReviews : 0;
    }

    res.json({ status: "success", favorites, favoriteIds });
  } catch (err) {
    next(err);
  }
});

router.use("/auth", require("./auth"));
router.use("/reviews", require("./reviews"));
router.use("/chat", require("./chat"));

module.exports = router;
