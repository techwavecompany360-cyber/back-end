const express = require("express");
const router = express.Router();
const mongo = require("../../lib/mongo");
const bcrypt = require("bcryptjs");
const { sign, authMiddleware } = require("../../lib/auth");
const { ObjectId } = require("mongodb");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

// Multer setup for admin wallet attachment uploads
const adminUploadsFolder = path.join(__dirname, "../../public/uploads/admin");
fs.mkdirSync(adminUploadsFolder, { recursive: true });

const adminUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, adminUploadsFolder),
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(null, `admin-${uniqueSuffix}${path.extname(file.originalname)}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Only images and PDF files are allowed."));
  },
});
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
    const accomodationsCol = await mongo.getCollection("accomodations");
    const managementCol = await mongo.getCollection("management");
    const bookingsCol = await mongo.getCollection("bookings");
    
    const items = await itemsCol.countDocuments();
    const clients = await clientsCol.countDocuments();
    const accomodations = await accomodationsCol.countDocuments();
    const owners = await managementCol.countDocuments({ owner: true });
    const bookings = await bookingsCol.countDocuments();
    
    // Minimal mock time-series data for chart preview on dashboard
    const chartData = {
      labels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
      data: [12, 19, 3, 5, 2, 3, 7]
    };

    res.json({ 
      users: clients, 
      items, 
      accomodations, 
      owners, 
      bookings, 
      chartData,
      uptime: process.uptime() 
    });
  } catch (err) {
    next(err);
  }
});

router.post("/management/profile", authMiddleware, async (req, res, next) => {
  try {
    const ownerId = req.body.ownerId;
    if (!ownerId) return res.status(400).json({ error: "ownerId is required" });

    const col = await mongo.getCollection("management");
    const notes = await col.findOne({ _id: new ObjectId(ownerId) });
    res.json(notes);
  } catch (err) {
    next(err);
  }
});
router.get("/management/owners", authMiddleware, async (req, res, next) => {
  try {
    const col = await mongo.getCollection("management");
    const notes = await col.find({ owner: true }).toArray();
    res.json(notes);
  } catch (err) {
    next(err);
  }
});
router.post(
  "/management/owners/approve",
  authMiddleware,
  async (req, res, next) => {
    try {
      const { ownerId } = req.body;
      if (!ownerId)
        return res.status(400).json({ error: "ownerId is required" });

      const col = await mongo.getCollection("management");
      const result = await col.updateOne(
        { _id: new ObjectId(ownerId) },
        { $set: { adminApproval: true, approvedState: "Approved" } },
      );

      if (result.matchedCount === 0)
        return res.status(404).json({ error: "Owner not found" });

      res.status(200).json({ message: "Owner account approved successfully" });
    } catch (err) {
      next(err);
    }
  },
);
router.get(
  "/management/owner/accomodations",
  authMiddleware,
  async (req, res, next) => {
    try {
      const reference = req.query.reference;
      const col = await mongo.getCollection("accomodations");
      const accomodationData = await col.find({ reference }).toArray();
      res.status(200).json({ status: "success", accomodationData });
    } catch (err) {
      next(err);
    }
  },
);
router.get(
  "/management/accomodations/rooms",
  authMiddleware,
  async (req, res, next) => {
    try {
      const id = req.query.id;
      const col = await mongo.getCollection("rooms");
      const roomsData = await col.find({ accomodationReference: id }).toArray();
      res.status(200).json({ status: "success", roomsData });
    } catch (err) {
      next(err);
    }
  },
);
router.get("/management", authMiddleware, async (req, res, next) => {
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
      return res
        .status(400)
        .json({ error: "Please provide both email and password." });
    const col = await mongo.getCollection("admin");
    const admin = await col.findOne({ email });
    if (!admin)
      return res
        .status(401)
        .json({ error: "The email or password you entered is incorrect." });
    const ok = await bcrypt.compare(password, admin.passwordHash);
    if (!ok)
      return res
        .status(401)
        .json({ error: "The email or password you entered is incorrect." });
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

// Single accommodation detail
router.get("/accomodation/:id", authMiddleware, async (req, res, next) => {
  try {
    const id = req.params.id;
    const col = await mongo.getCollection("accomodations");
    const acc = await col.findOne({ _id: new ObjectId(id) });
    if (!acc) return res.status(404).json({ error: "Accommodation not found" });
    res.status(200).json(acc);
  } catch (err) {
    next(err);
  }
});

// Rooms for an accommodation
router.get("/accomodation/:id/rooms", authMiddleware, async (req, res, next) => {
  try {
    const id = req.params.id;
    const col = await mongo.getCollection("rooms");
    const rooms = await col.find({ accomodationReference: id }).toArray();
    res.status(200).json(rooms);
  } catch (err) {
    next(err);
  }
});

// Bookings for an accommodation
router.get("/accomodation/:id/bookings", authMiddleware, async (req, res, next) => {
  try {
    const id = req.params.id;
    const col = await mongo.getCollection("bookings");
    const bookings = await col.find({
      $or: [
        { accomodationId: id },
        { accommodationId: id }
      ]
    }).sort({ createdAt: -1 }).toArray();
    res.status(200).json(bookings);
  } catch (err) {
    next(err);
  }
});

// Wallet + transactions for an accommodation
router.get("/accomodation/:id/wallet", authMiddleware, async (req, res, next) => {
  try {
    const id = req.params.id;
    // Get wallet from accommodation
    const accCol = await mongo.getCollection("accomodations");
    const acc = await accCol.findOne({ _id: new ObjectId(id) }, { projection: { wallet: 1 } });
    // Get wallet transactions
    const txCol = await mongo.getCollection("wallet_transactions");
    const transactions = await txCol.find({ accommodationId: id }).sort({ createdAt: -1 }).limit(200).toArray();
    res.status(200).json({
      wallet: acc?.wallet || { credit: 0, debit: 0, balance: 0 },
      transactions
    });
  } catch (err) {
    next(err);
  }
});

// Analytics summary for a single accommodation
router.get("/accomodation/:id/analytics", authMiddleware, async (req, res, next) => {
  try {
    const id = req.params.id;
    const bookingsCol = await mongo.getCollection("bookings");
    const bookingMatch = {
      $or: [
        { accomodationId: id },
        { accommodationId: id }
      ]
    };
    const bookings = await bookingsCol.find(bookingMatch).toArray();
    
    let totalRevenue = 0, totalBookings = bookings.length, cancelledCount = 0;
    let totalNights = 0, onlineCount = 0, frontDeskCount = 0;
    for (const b of bookings) {
      const stat = String(b.status || "").toLowerCase();
      if (stat === "cancelled" || stat === "rejected") {
        cancelledCount++;
      } else {
        totalRevenue += Number(b.totalBookingAmount || b.totalAmount || 0);
        const nights = Number(b.nights) || 1;
        totalNights += nights;
        if (b.source && String(b.source).toLowerCase() === "management") {
          frontDeskCount++;
        } else {
          onlineCount++;
        }
      }
    }
    const cancellationRate = totalBookings > 0 ? ((cancelledCount / totalBookings) * 100).toFixed(1) : 0;

    // Monthly bookings trend
    const monthlyAgg = await bookingsCol.aggregate([
      { $match: { ...bookingMatch, createdAt: { $exists: true } } },
      { $group: { _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } }, count: { $sum: 1 } } },
      { $sort: { "_id.year": 1, "_id.month": 1 } },
      { $limit: 12 }
    ]).toArray();

    res.status(200).json({
      totalRevenue, totalBookings, cancelledCount, cancellationRate,
      totalNights, onlineCount, frontDeskCount, monthlyAgg
    });
  } catch (err) {
    next(err);
  }
});

// Single room detail
router.get("/room/:id", authMiddleware, async (req, res, next) => {
  try {
    const id = req.params.id;
    const col = await mongo.getCollection("rooms");
    const room = await col.findOne({ _id: new ObjectId(id) });
    if (!room) return res.status(404).json({ error: "Room not found" });
    res.status(200).json(room);
  } catch (err) {
    next(err);
  }
});

router.get("/accomodations", authMiddleware, async (req, res, next) => {
  try {
    const col = await mongo.getCollection("accomodations");
    const accomodations = await col.find({}).toArray();
    res.status(200).json(accomodations);
  } catch (err) {
    next(err);
  }
});

router.get("/bookings", authMiddleware, async (req, res, next) => {
  try {
    const col = await mongo.getCollection("bookings");
    const bookings = await col.find({}).toArray();
    res.status(200).json(bookings);
  } catch (err) {
    next(err);
  }
});

router.get("/clients", authMiddleware, async (req, res, next) => {
  try {
    const col = await mongo.getCollection("clients");
    const clients = await col.find({}).toArray();
    // Exclude password hashes for security
    const sanitizedClients = clients.map(client => {
      const { passwordHash, ...safeData } = client;
      return safeData;
    });
    res.status(200).json(sanitizedClients);
  } catch (err) {
    next(err);
  }
});

router.post("/accomodations/approve", async (req, res, next) => {
  try {
    const { accomodationId } = req.body;
    const col = await mongo.getCollection("accomodations");

    const acc = await col.findOne({ _id: new ObjectId(accomodationId) });
    if (!acc) {
      return res.status(404).json({ error: "Accommodation not found" });
    }

    const result = await col.updateOne(
      { _id: new ObjectId(accomodationId) },
      { $set: { adminApproval: true, rejected: false, status: "approved" } },
    );

    let message = "Accommodation approved successfully";

    // Automatically approve associated rooms ONLY for Homestays
    if (acc.type && acc.type.toLowerCase() === "homestay") {
      const roomsCol = await mongo.getCollection("rooms");
      await roomsCol.updateMany(
        { accomodationReference: accomodationId },
        { $set: { adminApproval: true, rejected: false, status: "approved" } }
      );
      message = "Accommodation and associated homestay rooms approved successfully";
    }

    res.status(200).json({
      message,
      result,
    });
  } catch (err) {
    next(err);
  }
});
router.post("/accomodations/block", async (req, res, next) => {
  try {
    const { accomodationId } = req.body;
    const col = await mongo.getCollection("accomodations");
    const result = await col.updateOne(
      { _id: new ObjectId(accomodationId) },
      { $set: { blocked: true } },
    );
    res.status(200).json({
      message: "Accommodation Currentl Blocked",
      result,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/accomodations/unblock", async (req, res, next) => {
  try {
    const { accomodationId } = req.body;
    const col = await mongo.getCollection("accomodations");
    const result = await col.updateOne(
      { _id: new ObjectId(accomodationId) },
      { $set: { blocked: false } },
    );
    res.status(200).json({
      message: "Accommodation Currentl Blocked",
      result,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/room/approve", async (req, res, next) => {
  try {
    const { roomId } = req.body;
    const col = await mongo.getCollection("rooms");
    const result = await col.updateOne(
      { _id: new ObjectId(roomId) },
      { $set: { adminApproval: true, rejected: false, status: "approved" } },
    );
    res.status(200).json({
      message: "Room approved successfully",
      result,
    });
  } catch (err) {
    next(err);
  }
});
router.post("/room/reject", async (req, res, next) => {
  try {
    const { roomId } = req.body;
    const col = await mongo.getCollection("rooms");
    const result = await col.updateOne(
      { _id: new ObjectId(roomId) },
      { $set: { rejected: true, status: "rejected" } },
    );
    res.status(200).json({
      message: "Room rejected successfully",
      result,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/room/block", async (req, res, next) => {
  try {
    const { roomId } = req.body;
    const col = await mongo.getCollection("rooms");
    const result = await col.updateOne(
      { _id: new ObjectId(roomId) },
      { $set: { blocked: true } },
    );
    res.status(200).json({
      message: "Room blocked successfully",
      result,
    });
  } catch (err) {
    next(err);
  }
});
router.post("/room/unblock", async (req, res, next) => {
  try {
    const { roomId } = req.body;
    const col = await mongo.getCollection("rooms");
    const result = await col.updateOne(
      { _id: new ObjectId(roomId) },
      { $set: { blocked: false } },
    );
    res.status(200).json({
      message: "Room unblocked successfully",
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

// ──────── System Configuration ────────
// GET current config (singleton document)
router.get("/config", authMiddleware, async (req, res, next) => {
  try {
    const col = await mongo.getCollection("system_config");
    let config = await col.findOne({ _id: "platform_fees" });
    if (!config) {
      // Seed default config if none exists
      config = {
        _id: "platform_fees",
        clientFeeRate: 0.10,
        managementFeeRate: 0.01,
        updatedAt: new Date(),
        updatedBy: null,
      };
      await col.insertOne(config);
    }
    res.status(200).json(config);
  } catch (err) {
    next(err);
  }
});

// PUT update config
router.put("/config", authMiddleware, async (req, res, next) => {
  try {
    const { clientFeeRate, managementFeeRate } = req.body;

    // Validate inputs
    const clientRate = parseFloat(clientFeeRate);
    const mgmtRate = parseFloat(managementFeeRate);
    if (isNaN(clientRate) || clientRate < 0 || clientRate > 1) {
      return res.status(400).json({ error: "clientFeeRate must be between 0 and 1 (e.g. 0.10 for 10%)" });
    }
    if (isNaN(mgmtRate) || mgmtRate < 0 || mgmtRate > 1) {
      return res.status(400).json({ error: "managementFeeRate must be between 0 and 1 (e.g. 0.01 for 1%)" });
    }

    const col = await mongo.getCollection("system_config");
    await col.updateOne(
      { _id: "platform_fees" },
      {
        $set: {
          clientFeeRate: clientRate,
          managementFeeRate: mgmtRate,
          updatedAt: new Date(),
          updatedBy: req.user?.email || "admin",
        },
      },
      { upsert: true }
    );

    const updated = await col.findOne({ _id: "platform_fees" });
    res.status(200).json({ message: "Configuration updated successfully", config: updated });
  } catch (err) {
    next(err);
  }
});

// ──────── Admin Manual Wallet Payment Processing ────────

// Process Credit Payment — deducts from wallet credit
router.post(
  "/accomodation/:id/wallet/process-credit",
  authMiddleware,
  adminUpload.single("attachment"),
  async (req, res, next) => {
    try {
      const accId = req.params.id;
      const amount = Number(req.body.amount);
      const modeOfPayment = req.body.modeOfPayment;
      const description = req.body.description || "";

      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Amount must be a positive number" });
      }
      if (!modeOfPayment) {
        return res.status(400).json({ error: "Mode of payment is required" });
      }

      const accCol = await mongo.getCollection("accomodations");
      const acc = await accCol.findOne({ _id: new ObjectId(accId) }, { projection: { wallet: 1 } });
      if (!acc) return res.status(404).json({ error: "Accommodation not found" });

      const wallet = acc.wallet || { credit: 0, debit: 0, balance: 0 };
      const currentCredit = wallet.credit || 0;

      if (amount > currentCredit) {
        return res.status(400).json({ error: `Amount (${amount}) exceeds available credit (${currentCredit})` });
      }

      const newCredit = currentCredit - amount;
      const newBalance = Math.max((wallet.balance || 0) - amount, 0);

      await accCol.updateOne(
        { _id: new ObjectId(accId) },
        { $set: { "wallet.credit": newCredit, "wallet.balance": newBalance } }
      );

      // Build attachment URL if file was uploaded
      const attachmentUrl = req.file
        ? `/public/uploads/admin/${req.file.filename}`
        : null;

      // Record transaction in wallet_transactions
      const txCol = await mongo.getCollection("wallet_transactions");
      await txCol.insertOne({
        accommodationId: accId,
        type: "admin_credit_payment",
        description: description || `Admin credit payment via ${modeOfPayment}`,
        amount: amount,
        modeOfPayment,
        attachmentUrl,
        processedBy: req.user?.email || "admin",
        source: "Admin",
        createdAt: new Date(),
      });

      // Refetch wallet transactions
      const transactions = await txCol.find({ accommodationId: accId }).sort({ createdAt: -1 }).limit(200).toArray();

      res.status(200).json({
        message: `Successfully processed credit payment of ${amount}`,
        wallet: { credit: newCredit, debit: wallet.debit || 0, balance: newBalance },
        transactions,
      });
    } catch (err) {
      next(err);
    }
  }
);

// Process Debit Payment — deducts from wallet debit
router.post(
  "/accomodation/:id/wallet/process-debit",
  authMiddleware,
  adminUpload.single("attachment"),
  async (req, res, next) => {
    try {
      const accId = req.params.id;
      const amount = Number(req.body.amount);
      const modeOfPayment = req.body.modeOfPayment;
      const description = req.body.description || "";

      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Amount must be a positive number" });
      }
      if (!modeOfPayment) {
        return res.status(400).json({ error: "Mode of payment is required" });
      }

      const accCol = await mongo.getCollection("accomodations");
      const acc = await accCol.findOne({ _id: new ObjectId(accId) }, { projection: { wallet: 1 } });
      if (!acc) return res.status(404).json({ error: "Accommodation not found" });

      const wallet = acc.wallet || { credit: 0, debit: 0, balance: 0 };
      const currentDebit = wallet.debit || 0;

      if (amount > currentDebit) {
        return res.status(400).json({ error: `Amount (${amount}) exceeds outstanding debit (${currentDebit})` });
      }

      const newDebit = currentDebit - amount;

      await accCol.updateOne(
        { _id: new ObjectId(accId) },
        { $set: { "wallet.debit": newDebit } }
      );

      // Build attachment URL if file was uploaded
      const attachmentUrl = req.file
        ? `/public/uploads/admin/${req.file.filename}`
        : null;

      // Record transaction in wallet_transactions
      const txCol = await mongo.getCollection("wallet_transactions");
      await txCol.insertOne({
        accommodationId: accId,
        type: "admin_debit_payment",
        description: description || `Admin debit payment via ${modeOfPayment}`,
        amount: amount,
        modeOfPayment,
        attachmentUrl,
        processedBy: req.user?.email || "admin",
        source: "Admin",
        createdAt: new Date(),
      });

      // Refetch wallet transactions
      const transactions = await txCol.find({ accommodationId: accId }).sort({ createdAt: -1 }).limit(200).toArray();

      res.status(200).json({
        message: `Successfully processed debit payment of ${amount}`,
        wallet: { credit: wallet.credit || 0, debit: newDebit, balance: wallet.balance || 0 },
        transactions,
      });
    } catch (err) {
      next(err);
    }
  }
);

// Update accommodation payment details (admin)
router.post(
  "/accomodation/:id/payment-details",
  authMiddleware,
  async (req, res, next) => {
    try {
      const accId = req.params.id;
      const {
        bankName, accountNumber, accountName,
        mobileProvider, mobileNumber, registerName,
      } = req.body;

      const accCol = await mongo.getCollection("accomodations");
      const acc = await accCol.findOne({ _id: new ObjectId(accId) });
      if (!acc) return res.status(404).json({ error: "Accommodation not found" });

      const updateFields = {};
      if (bankName !== undefined) updateFields["bankName"] = bankName;
      if (accountNumber !== undefined) updateFields["accountNumber"] = accountNumber;
      if (accountName !== undefined) updateFields["accountName"] = accountName;
      if (mobileProvider !== undefined) updateFields["mobileProvider"] = mobileProvider;
      if (mobileNumber !== undefined) updateFields["mobileNumber"] = mobileNumber;
      if (registerName !== undefined) updateFields["registerName"] = registerName;

      if (Object.keys(updateFields).length === 0) {
        return res.status(400).json({ error: "No fields to update" });
      }

      await accCol.updateOne(
        { _id: new ObjectId(accId) },
        { $set: updateFields }
      );

      res.status(200).json({
        message: "Payment details updated successfully",
        updated: updateFields,
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
