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
    const clientsCol = await mongo.getCollection("client_users");
    const accomodationsCol = await mongo.getCollection("accomodations");
    const managementCol = await mongo.getCollection("management");
    const bookingsCol = await mongo.getCollection("bookings");
    const analyticsCol = await mongo.getCollection("site_analytics");
    
    const items = await itemsCol.countDocuments();
    const clients = await clientsCol.countDocuments();
    const accomodations = await accomodationsCol.countDocuments();
    const owners = await managementCol.countDocuments({ owner: true });
    const bookings = await bookingsCol.countDocuments();

    // Analytics counts
    const totalPageViews = await analyticsCol.countDocuments();
    const uniqueVisitorsAgg = await analyticsCol.aggregate([
      { $group: { _id: "$visitorId" } },
      { $count: "count" }
    ]).toArray();
    const uniqueVisitors = uniqueVisitorsAgg[0]?.count || 0;

    // Today's page views
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayPageViews = await analyticsCol.countDocuments({
      createdAt: { $gte: todayStart }
    });

    // Real traffic data for last 7 days
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    const dailyTraffic = await analyticsCol.aggregate([
      { $match: { createdAt: { $gte: sevenDaysAgo } } },
      {
        $group: {
          _id: {
            year: { $year: "$createdAt" },
            month: { $month: "$createdAt" },
            day: { $dayOfMonth: "$createdAt" }
          },
          views: { $sum: 1 }
        }
      },
      { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } }
    ]).toArray();

    // Build labels and data for chart
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const chartLabels = [];
    const chartValues = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      chartLabels.push(dayNames[d.getDay()]);
      const match = dailyTraffic.find(
        t => t._id.year === d.getFullYear() && t._id.month === d.getMonth() + 1 && t._id.day === d.getDate()
      );
      chartValues.push(match ? match.views : 0);
    }

    const chartData = {
      labels: chartLabels,
      data: chartValues,
    };

    res.json({ 
      users: clients, 
      items, 
      accomodations, 
      owners, 
      bookings, 
      chartData,
      totalPageViews,
      uniqueVisitors,
      todayPageViews,
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

router.post(
  "/management/owner/:id/reset-password",
  authMiddleware,
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { password } = req.body;

      if (!password) {
        return res.status(400).json({ error: "Password is required" });
      }

      const col = await mongo.getCollection("management");
      const owner = await col.findOne({ _id: new ObjectId(id), owner: true });

      if (!owner) {
        return res.status(404).json({ error: "Owner not found" });
      }

      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(password, salt);

      await col.updateOne(
        { _id: new ObjectId(id) },
        { $set: { passwordHash, updatedAt: new Date() } }
      );

      res.status(200).json({ message: "Password reset successfully" });
    } catch (err) {
      next(err);
    }
  }
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

// Admin forgot password -> sends OTP
router.post("/forgot-password", async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    const col = await mongo.getCollection("admin");
    const adminUser = await col.findOne({ email });

    // Send generic response to prevent email enumeration
    if (!adminUser) {
      return res.json({ status: "success", message: "If an account exists, an OTP has been sent." });
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpCol = await mongo.getCollection("otps");
    
    await otpCol.deleteMany({ userId: adminUser._id.toString(), type: "admin_password_reset" });

    await otpCol.insertOne({
      userId: adminUser._id.toString(),
      otp: otp,
      type: "admin_password_reset",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 10 * 60000) // 10 minutes
    });

    const axios = require("axios");
    const EMAIL_API = process.env.EMAIL_API || "http://localhost:3004";
    
    try {
      await axios.post(`${EMAIL_API}/api/email/password-reset`, {
        email: adminUser.email,
        resetCode: otp,
      });
    } catch (err) {
      console.warn("Password reset email failed:", err.message);
    }

    res.json({ 
      status: "success", 
      message: "Password reset OTP sent to your email." 
    });
  } catch (err) {
    next(err);
  }
});

// Admin reset password -> validates OTP and updates password
router.post("/reset-password", async (req, res, next) => {
  try {
    const { email, code, newPassword } = req.body;

    if (!email || !code || !newPassword) {
      return res.status(400).json({ error: "Email, code, and new password are required." });
    }

    const col = await mongo.getCollection("admin");
    const adminUser = await col.findOne({ email });

    if (!adminUser) {
      return res.status(404).json({ error: "User not found." });
    }

    const otpCol = await mongo.getCollection("otps");
    const stored = await otpCol.findOne({ userId: adminUser._id.toString(), type: "admin_password_reset" });

    if (!stored) {
      return res.status(404).json({ error: "No reset OTP found. Please request a new one." });
    }

    if (stored.otp !== String(code).trim()) {
      return res.status(400).json({ error: "Invalid OTP code." });
    }

    if (new Date() > stored.expiresAt) {
      return res.status(400).json({ error: "OTP has expired. Please request a new one." });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(newPassword, salt);

    await col.updateOne({ _id: adminUser._id }, { $set: { passwordHash } });
    await otpCol.deleteOne({ _id: stored._id });

    res.json({ status: "success", message: "Password reset successfully. You can now login." });
  } catch (err) {
    next(err);
  }
});


// Admin change password
router.post("/change-password", authMiddleware, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Current and new password are required" });
    }
    const col = await mongo.getCollection("admin");
    const admin = await col.findOne({ id: req.user.id });
    if (!admin) return res.status(404).json({ error: "Admin not found" });

    const ok = await bcrypt.compare(currentPassword, admin.passwordHash);
    if (!ok) return res.status(400).json({ error: "Incorrect current password." });

    if (newPassword.length < 6) return res.status(400).json({ error: "New password must be at least 6 characters." });

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(newPassword, salt);
    await col.updateOne({ id: req.user.id }, { $set: { passwordHash } });

    res.json({ message: "Password updated successfully." });
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

// Update room details (name, capacity, description)
router.put("/room/:id", authMiddleware, async (req, res, next) => {
  try {
    const { roomName, capacity, description } = req.body;
    const col = await mongo.getCollection("rooms");

    const updateFields = { updatedAt: new Date() };
    if (roomName !== undefined) updateFields.roomName = roomName.trim();
    if (capacity !== undefined) updateFields.capacity = parseInt(capacity) || 0;
    if (description !== undefined) updateFields.description = description.trim();

    await col.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: updateFields }
    );

    const updated = await col.findOne({ _id: new ObjectId(req.params.id) });
    res.json({ status: "success", message: "Room updated successfully.", room: updated });
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
    const col = await mongo.getCollection("client_users");
    const clients = await col.find({}).toArray();
    // Exclude password hashes for security
    const sanitizedClients = clients.map(client => {
      const { passwordHash, ...safeData } = client;
      safeData.name = safeData.fullName || safeData.name;
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

// ══════════════════════════════════════════════════════════════
// PENDING PHOTO APPROVALS (Admin)
// ══════════════════════════════════════════════════════════════

// Get all pending photos across accommodations and rooms
router.get("/pending-photos", authMiddleware, async (req, res, next) => {
  try {
    const accCol = await mongo.getCollection("accomodations");
    const roomCol = await mongo.getCollection("rooms");

    const accsWithPending = await accCol
      .find({ pendingImages: { $exists: true, $ne: [] } })
      .project({ name: 1, pendingImages: 1, type: 1 })
      .toArray();

    const roomsWithPending = await roomCol
      .find({ pendingImages: { $exists: true, $ne: [] } })
      .project({ roomName: 1, pendingImages: 1, accomodationReference: 1 })
      .toArray();

    const pendingList = [];

    for (const acc of accsWithPending) {
      for (const img of acc.pendingImages || []) {
        pendingList.push({
          ...img,
          entityType: "accommodation",
          entityId: acc._id.toString(),
          entityName: acc.name || "Unnamed",
        });
      }
    }

    for (const room of roomsWithPending) {
      for (const img of room.pendingImages || []) {
        pendingList.push({
          ...img,
          entityType: "room",
          entityId: room._id.toString(),
          entityName: room.roomName || "Unnamed Room",
          accommodationRef: room.accomodationReference || null,
        });
      }
    }

    // Sort by upload date, newest first
    pendingList.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));

    res.json({ status: "success", pendingPhotos: pendingList, total: pendingList.length });
  } catch (err) {
    next(err);
  }
});

// Approve a pending photo → move from pendingImages to otherImages
router.post("/approve-photo", authMiddleware, async (req, res, next) => {
  try {
    const { entityType, entityId, imageUrl } = req.body;
    if (!entityType || !entityId || !imageUrl) {
      return res.status(400).json({ error: "entityType, entityId, and imageUrl are required" });
    }

    const collectionName = entityType === "room" ? "rooms" : "accomodations";
    const col = await mongo.getCollection(collectionName);
    const doc = await col.findOne({ _id: new ObjectId(entityId) });
    if (!doc) return res.status(404).json({ error: `${entityType} not found` });

    // Remove from pendingImages
    const pendingImages = (doc.pendingImages || []).filter((img) => img.url !== imageUrl);

    // Add to otherImages
    const otherImages = Array.isArray(doc.otherImages) ? [...doc.otherImages] : [];
    otherImages.push(imageUrl);

    await col.updateOne(
      { _id: new ObjectId(entityId) },
      { $set: { pendingImages, otherImages } }
    );

    res.json({
      status: "success",
      message: "Photo approved and added to gallery",
      otherImages,
      pendingImages,
    });
  } catch (err) {
    next(err);
  }
});

// Reject a pending photo → remove from pendingImages
router.post("/reject-photo", authMiddleware, async (req, res, next) => {
  try {
    const { entityType, entityId, imageUrl } = req.body;
    if (!entityType || !entityId || !imageUrl) {
      return res.status(400).json({ error: "entityType, entityId, and imageUrl are required" });
    }

    const collectionName = entityType === "room" ? "rooms" : "accomodations";
    const col = await mongo.getCollection(collectionName);
    const doc = await col.findOne({ _id: new ObjectId(entityId) });
    if (!doc) return res.status(404).json({ error: `${entityType} not found` });

    // Remove from pendingImages
    const pendingImages = (doc.pendingImages || []).filter((img) => img.url !== imageUrl);

    await col.updateOne(
      { _id: new ObjectId(entityId) },
      { $set: { pendingImages } }
    );

    // Try deleting the file from disk
    try {
      const path = require("path");
      const fs = require("fs");
      const filename = imageUrl.split("/").pop();
      const filePath = path.join(__dirname, "../../public/uploads/images", filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) {
      console.warn("Could not delete rejected file:", e.message);
    }

    res.json({
      status: "success",
      message: "Photo rejected and removed",
      pendingImages,
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

// ══════════════════════════════════════════════════════════════
// ROOM PHOTO MANAGEMENT (Admin)
// ══════════════════════════════════════════════════════════════
const roomImagesFolder = path.join(__dirname, "../../public/uploads/images");
fs.mkdirSync(roomImagesFolder, { recursive: true });

const roomImageUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, roomImagesFolder),
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(null, `room-${uniqueSuffix}${path.extname(file.originalname)}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Only image files are allowed."));
  },
});

// Upload photos to a room (admin — directly to otherImages, no approval needed)
router.post(
  "/room/:id/upload-photos",
  authMiddleware,
  roomImageUpload.array("images", 10),
  async (req, res, next) => {
    try {
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: "No images provided" });
      }

      const col = await mongo.getCollection("rooms");
      const room = await col.findOne({ _id: new ObjectId(req.params.id) });
      if (!room) return res.status(404).json({ error: "Room not found" });

      const newUrls = req.files.map(
        (file) => `/public/uploads/images/${file.filename}`
      );

      await col.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $push: { otherImages: { $each: newUrls } } }
      );

      const updated = await col.findOne({ _id: new ObjectId(req.params.id) });

      res.status(201).json({
        status: "success",
        message: `${newUrls.length} photo(s) uploaded successfully.`,
        otherImages: updated.otherImages || [],
        frontImage: updated.frontImage,
      });
    } catch (err) {
      next(err);
    }
  }
);

// Delete a room photo
router.post("/room/:id/delete-photo", authMiddleware, async (req, res, next) => {
  try {
    const { imageUrl } = req.body;
    if (!imageUrl) return res.status(400).json({ error: "imageUrl is required" });

    const col = await mongo.getCollection("rooms");
    const room = await col.findOne({ _id: new ObjectId(req.params.id) });
    if (!room) return res.status(404).json({ error: "Room not found" });

    const isFront = room.frontImage === imageUrl;

    if (isFront) {
      // Move first otherImage to front, or clear front
      const others = room.otherImages || [];
      const newFront = others.length > 0 ? others[0] : null;
      const newOthers = others.length > 0 ? others.slice(1) : [];
      await col.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { frontImage: newFront, otherImages: newOthers } }
      );
    } else {
      await col.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $pull: { otherImages: imageUrl } }
      );
    }

    // Delete from disk
    try {
      const filename = imageUrl.split("/").pop();
      if (filename) {
        const filePath = path.join(roomImagesFolder, filename);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
    } catch (e) { /* ignore file deletion errors */ }

    const updated = await col.findOne({ _id: new ObjectId(req.params.id) });

    res.json({
      status: "success",
      message: isFront ? "Front image removed." : "Photo removed.",
      frontImage: updated.frontImage,
      otherImages: updated.otherImages || [],
    });
  } catch (err) {
    next(err);
  }
});

// Change front image (swap)
router.post("/room/:id/change-front-image", authMiddleware, async (req, res, next) => {
  try {
    const { newFrontImage } = req.body;
    if (!newFrontImage) return res.status(400).json({ error: "newFrontImage is required" });

    const col = await mongo.getCollection("rooms");
    const room = await col.findOne({ _id: new ObjectId(req.params.id) });
    if (!room) return res.status(404).json({ error: "Room not found" });

    const oldFront = room.frontImage;
    const others = (room.otherImages || []).filter((img) => img !== newFrontImage);
    if (oldFront) others.push(oldFront);

    await col.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { frontImage: newFrontImage, otherImages: others } }
    );

    res.json({
      status: "success",
      message: "Front image updated.",
      frontImage: newFrontImage,
      otherImages: others,
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
        customRates: [],
        updatedAt: new Date(),
        updatedBy: null,
      };
      await col.insertOne(config);
    }
    // Ensure customRates is an array
    if (!config.customRates) {
      config.customRates = [];
    }
    res.status(200).json(config);
  } catch (err) {
    next(err);
  }
});

// PUT update config
router.put("/config", authMiddleware, async (req, res, next) => {
  try {
    const { clientFeeRate, managementFeeRate, customRates } = req.body;

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
          customRates: Array.isArray(customRates) ? customRates : [],
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

// GET ui config
router.get("/ui-config", authMiddleware, async (req, res, next) => {
  try {
    const col = await mongo.getCollection("system_config");
    let config = await col.findOne({ _id: "ui_config" });
    if (!config) {
      config = {
        _id: "ui_config",
        mapVisibility: "before_booking",
        chatVisibility: "before_booking",
        customUiConfig: [],
        updatedAt: new Date(),
        updatedBy: null,
      };
      await col.insertOne(config);
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

// PUT update ui config
router.put("/ui-config", authMiddleware, async (req, res, next) => {
  try {
    const { mapVisibility, chatVisibility, customUiConfig } = req.body;
    
    if (!["before_booking", "after_booking"].includes(mapVisibility)) {
      return res.status(400).json({ error: "Invalid mapVisibility value" });
    }
    if (!["before_booking", "after_booking"].includes(chatVisibility)) {
      return res.status(400).json({ error: "Invalid chatVisibility value" });
    }

    const col = await mongo.getCollection("system_config");
    await col.updateOne(
      { _id: "ui_config" },
      {
        $set: {
          mapVisibility,
          chatVisibility,
          customUiConfig: Array.isArray(customUiConfig) ? customUiConfig : [],
          updatedAt: new Date(),
          updatedBy: req.user?.email || "admin",
        },
      },
      { upsert: true }
    );

    const updated = await col.findOne({ _id: "ui_config" });
    res.status(200).json({ message: "UI Configuration updated successfully", config: updated });
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

// ──────── Per-Accommodation Online Overdraft Configuration ────────
router.put(
  "/accomodation/:id/overdraft",
  authMiddleware,
  async (req, res, next) => {
    try {
      const accId = req.params.id;
      const { onlineOverdraftEnabled, onlineOverdraftPercent } = req.body;

      const accCol = await mongo.getCollection("accomodations");
      const acc = await accCol.findOne({ _id: new ObjectId(accId) });
      if (!acc) return res.status(404).json({ error: "Accommodation not found" });

      const updateFields = {};

      // Toggle
      if (typeof onlineOverdraftEnabled === "boolean") {
        updateFields.onlineOverdraftEnabled = onlineOverdraftEnabled;
      }

      // Percentage (validate 0–100)
      if (onlineOverdraftPercent !== undefined) {
        const pct = parseFloat(onlineOverdraftPercent);
        if (isNaN(pct) || pct < 0 || pct > 100) {
          return res.status(400).json({ error: "Overdraft percent must be between 0 and 100" });
        }
        updateFields.onlineOverdraftPercent = pct;
      }

      if (Object.keys(updateFields).length === 0) {
        return res.status(400).json({ error: "No valid fields to update" });
      }

      updateFields.overdraftUpdatedAt = new Date();
      updateFields.overdraftUpdatedBy = req.user?.email || "admin";

      await accCol.updateOne(
        { _id: new ObjectId(accId) },
        { $set: updateFields }
      );

      const updated = await accCol.findOne({ _id: new ObjectId(accId) });
      res.status(200).json({
        message: "Overdraft configuration updated successfully",
        accommodation: updated,
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

// ──────── Change Front Image ────────

// Swap accommodation front image with one of the other images
router.post(
  "/accomodation/:id/change-front-image",
  authMiddleware,
  async (req, res, next) => {
    try {
      const accId = req.params.id;
      const { newFrontImage } = req.body;

      if (!newFrontImage) {
        return res.status(400).json({ error: "newFrontImage is required" });
      }

      const col = await mongo.getCollection("accomodations");
      const acc = await col.findOne({ _id: new ObjectId(accId) });
      if (!acc) return res.status(404).json({ error: "Accommodation not found" });

      const otherImages = Array.isArray(acc.otherImages) ? [...acc.otherImages] : [];
      const oldFrontImage = acc.frontImage || null;

      // Remove the selected image from otherImages
      const idx = otherImages.indexOf(newFrontImage);
      if (idx === -1) {
        return res.status(400).json({ error: "Selected image not found in other images" });
      }
      otherImages.splice(idx, 1);

      // Put the old front image into otherImages (if it exists)
      if (oldFrontImage) {
        otherImages.unshift(oldFrontImage);
      }

      await col.updateOne(
        { _id: new ObjectId(accId) },
        { $set: { frontImage: newFrontImage, otherImages } }
      );

      res.status(200).json({
        message: "Front image updated successfully",
        frontImage: newFrontImage,
        otherImages,
      });
    } catch (err) {
      next(err);
    }
  }
);

// Swap room front image with one of the other images
router.post(
  "/room/:id/change-front-image",
  authMiddleware,
  async (req, res, next) => {
    try {
      const roomId = req.params.id;
      const { newFrontImage } = req.body;

      if (!newFrontImage) {
        return res.status(400).json({ error: "newFrontImage is required" });
      }

      const col = await mongo.getCollection("rooms");
      const room = await col.findOne({ _id: new ObjectId(roomId) });
      if (!room) return res.status(404).json({ error: "Room not found" });

      const otherImages = Array.isArray(room.otherImages) ? [...room.otherImages] : [];
      const oldFrontImage = room.frontImage || null;

      // Remove the selected image from otherImages
      const idx = otherImages.indexOf(newFrontImage);
      if (idx === -1) {
        return res.status(400).json({ error: "Selected image not found in other images" });
      }
      otherImages.splice(idx, 1);

      // Put the old front image into otherImages (if it exists)
      if (oldFrontImage) {
        otherImages.unshift(oldFrontImage);
      }

      await col.updateOne(
        { _id: new ObjectId(roomId) },
        { $set: { frontImage: newFrontImage, otherImages } }
      );

      res.status(200).json({
        message: "Room front image updated successfully",
        frontImage: newFrontImage,
        otherImages,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ──────── Site Analytics Endpoints ────────

// GET /admin/analytics/summary — Full analytics dashboard data
router.get("/analytics/summary", authMiddleware, async (req, res, next) => {
  try {
    const col = await mongo.getCollection("site_analytics");
    const days = parseInt(req.query.days) || 30;

    // Support custom date range (from/to) or fallback to days-based
    let startDate, endDate;
    if (req.query.from && req.query.to) {
      startDate = new Date(req.query.from);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(req.query.to);
      endDate.setHours(23, 59, 59, 999);
    } else {
      startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date();
    }

    const dateFilter = { createdAt: { $gte: startDate, $lte: endDate } };

    // Previous period for comparison (same duration, ending right before startDate)
    const periodMs = endDate.getTime() - startDate.getTime();
    const prevStart = new Date(startDate.getTime() - periodMs);
    const prevEnd = new Date(startDate.getTime() - 1);
    const prevDateFilter = { createdAt: { $gte: prevStart, $lte: prevEnd } };

    // Total page views in period
    const totalPageViews = await col.countDocuments(dateFilter);

    // Unique visitors
    const uniqueVisitorsAgg = await col.aggregate([
      { $match: dateFilter },
      { $group: { _id: "$visitorId" } },
      { $count: "count" }
    ]).toArray();
    const uniqueVisitors = uniqueVisitorsAgg[0]?.count || 0;

    // Returning visitors (visitCount > 1)
    const returningAgg = await col.aggregate([
      { $match: dateFilter },
      { $group: { _id: "$visitorId", maxVisits: { $max: "$visitCount" } } },
      { $match: { maxVisits: { $gt: 1 } } },
      { $count: "count" }
    ]).toArray();
    const returningVisitors = returningAgg[0]?.count || 0;
    const returningRate = uniqueVisitors > 0 ? ((returningVisitors / uniqueVisitors) * 100).toFixed(1) : 0;

    // Average session duration
    const durationAgg = await col.aggregate([
      { $match: { ...dateFilter, sessionDuration: { $exists: true, $gt: 0 } } },
      { $group: { _id: "$sessionId", avgDuration: { $avg: "$sessionDuration" } } },
      { $group: { _id: null, avg: { $avg: "$avgDuration" } } }
    ]).toArray();
    const avgSessionDuration = Math.round(durationAgg[0]?.avg || 0);

    // Bounce rate (sessions with only 1 page view)
    const sessionPagesAgg = await col.aggregate([
      { $match: dateFilter },
      { $group: { _id: "$sessionId", pageCount: { $sum: 1 } } },
      { $group: {
        _id: null,
        totalSessions: { $sum: 1 },
        bounceSessions: { $sum: { $cond: [{ $eq: ["$pageCount", 1] }, 1, 0] } }
      }}
    ]).toArray();
    const totalSessions = sessionPagesAgg[0]?.totalSessions || 0;
    const bounceSessions = sessionPagesAgg[0]?.bounceSessions || 0;
    const bounceRate = totalSessions > 0 ? ((bounceSessions / totalSessions) * 100).toFixed(1) : 0;

    // Daily trend
    const dailyTrend = await col.aggregate([
      { $match: dateFilter },
      {
        $group: {
          _id: {
            year: { $year: "$createdAt" },
            month: { $month: "$createdAt" },
            day: { $dayOfMonth: "$createdAt" }
          },
          views: { $sum: 1 },
          uniqueVisitors: { $addToSet: "$visitorId" }
        }
      },
      {
        $project: {
          _id: 1,
          views: 1,
          uniqueVisitors: { $size: "$uniqueVisitors" }
        }
      },
      { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } }
    ]).toArray();

    // Top pages
    const topPages = await col.aggregate([
      { $match: dateFilter },
      { $group: { _id: "$page", views: { $sum: 1 }, pageName: { $first: "$pageName" } } },
      { $sort: { views: -1 } },
      { $limit: 15 }
    ]).toArray();

    // Top countries
    const topCountries = await col.aggregate([
      { $match: { ...dateFilter, "geo.country": { $exists: true, $ne: null } } },
      { $group: { _id: "$geo.country", views: { $sum: 1 }, visitors: { $addToSet: "$visitorId" } } },
      { $project: { _id: 1, views: 1, visitors: { $size: "$visitors" } } },
      { $sort: { views: -1 } },
      { $limit: 20 }
    ]).toArray();

    // Top cities (with coordinates for map)
    const topCities = await col.aggregate([
      { $match: { ...dateFilter, "geo.city": { $exists: true, $ne: null, $ne: "" }, "geo.ll": { $exists: true, $ne: null } } },
      { $group: { _id: { city: "$geo.city", country: "$geo.country" }, views: { $sum: 1 }, lat: { $first: { $arrayElemAt: ["$geo.ll", 0] } }, lng: { $first: { $arrayElemAt: ["$geo.ll", 1] } }, visitors: { $addToSet: "$visitorId" } } },
      { $project: { _id: 1, views: 1, lat: 1, lng: 1, visitors: { $size: "$visitors" } } },
      { $sort: { views: -1 } },
      { $limit: 30 }
    ]).toArray();

    // Device type breakdown
    const deviceTypes = await col.aggregate([
      { $match: dateFilter },
      { $group: { _id: "$device.deviceType", count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]).toArray();

    // Browser breakdown
    const browsers = await col.aggregate([
      { $match: dateFilter },
      { $group: { _id: "$device.browser", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]).toArray();

    // OS breakdown
    const operatingSystems = await col.aggregate([
      { $match: dateFilter },
      { $group: { _id: "$device.os", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]).toArray();

    // Hourly heatmap (hour of day distribution)
    const hourlyHeatmap = await col.aggregate([
      { $match: dateFilter },
      { $group: { _id: { $hour: "$createdAt" }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]).toArray();

    // UTM campaign breakdown
    const utmCampaigns = await col.aggregate([
      { $match: { ...dateFilter, utmSource: { $exists: true, $ne: null } } },
      {
        $group: {
          _id: { source: "$utmSource", medium: "$utmMedium", campaign: "$utmCampaign" },
          views: { $sum: 1 },
          visitors: { $addToSet: "$visitorId" }
        }
      },
      { $project: { _id: 1, views: 1, visitors: { $size: "$visitors" } } },
      { $sort: { views: -1 } },
      { $limit: 20 }
    ]).toArray();

    // Referrer breakdown
    const referrers = await col.aggregate([
      { $match: { ...dateFilter, referrer: { $exists: true, $ne: null, $ne: "" } } },
      { $group: { _id: "$referrer", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 15 }
    ]).toArray();

    // ── Funnel metrics ──
    const propertyViews = await col.countDocuments({ ...dateFilter, eventType: "view_property" });
    const bookingStarts = await col.countDocuments({ ...dateFilter, eventType: "start_booking" });
    const bookingCompletes = await col.countDocuments({ ...dateFilter, eventType: "complete_booking" });

    // ── Top search queries ──
    const topSearches = await col.aggregate([
      { $match: { ...dateFilter, eventType: "search", "eventMeta.query": { $exists: true, $ne: "" } } },
      { $group: { _id: "$eventMeta.query", count: { $sum: 1 }, avgResults: { $avg: "$eventMeta.resultCount" } } },
      { $sort: { count: -1 } },
      { $limit: 20 }
    ]).toArray();

    // ── Most viewed properties ──
    const topProperties = await col.aggregate([
      { $match: { ...dateFilter, eventType: "view_property", "eventMeta.propertyId": { $exists: true } } },
      { $group: { _id: "$eventMeta.propertyId", name: { $first: "$eventMeta.propertyName" }, views: { $sum: 1 }, visitors: { $addToSet: "$visitorId" } } },
      { $project: { _id: 1, name: 1, views: 1, visitors: { $size: "$visitors" } } },
      { $sort: { views: -1 } },
      { $limit: 15 }
    ]).toArray();

    // ── JS errors ──
    const jsErrors = await col.aggregate([
      { $match: { ...dateFilter, eventType: "js_error" } },
      { $group: { _id: "$eventMeta.message", count: { $sum: 1 }, lastSeen: { $max: "$createdAt" }, source: { $first: "$eventMeta.source" } } },
      { $sort: { count: -1 } },
      { $limit: 20 }
    ]).toArray();
    const totalErrors = await col.countDocuments({ ...dateFilter, eventType: "js_error" });

    // ── Revenue Metrics ──
    const revenueAgg = await col.aggregate([
      { $match: { ...dateFilter, eventType: "complete_booking", "eventMeta.total": { $exists: true } } },
      { $group: { _id: null, totalRevenue: { $sum: "$eventMeta.total" }, bookingCount: { $sum: 1 } } }
    ]).toArray();
    const totalRevenue = revenueAgg[0]?.totalRevenue || 0;
    const aov = revenueAgg[0]?.bookingCount ? totalRevenue / revenueAgg[0].bookingCount : 0;

    // Daily revenue trend
    const dailyRevenueTrend = await col.aggregate([
      { $match: { ...dateFilter, eventType: "complete_booking", "eventMeta.total": { $exists: true } } },
      {
        $group: {
          _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" }, day: { $dayOfMonth: "$createdAt" } },
          revenue: { $sum: "$eventMeta.total" }
        }
      },
      { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } }
    ]).toArray();

    // Revenue by UTM Campaign
    const revenueByUtm = await col.aggregate([
      { $match: { ...dateFilter, eventType: "complete_booking", "eventMeta.total": { $exists: true }, utmSource: { $exists: true, $ne: null } } },
      { $group: { _id: { source: "$utmSource", campaign: "$utmCampaign" }, revenue: { $sum: "$eventMeta.total" } } },
      { $sort: { revenue: -1 } },
      { $limit: 10 }
    ]).toArray();

    // Revenue by Device Type
    const revenueByDevice = await col.aggregate([
      { $match: { ...dateFilter, eventType: "complete_booking", "eventMeta.total": { $exists: true } } },
      { $group: { _id: "$device.deviceType", revenue: { $sum: "$eventMeta.total" } } },
      { $sort: { revenue: -1 } }
    ]).toArray();

    // ── Behavior Metrics ──
    // Top clicked elements
    const topClicks = await col.aggregate([
      { $match: { ...dateFilter, eventType: "click", "eventMeta.element": { $exists: true } } },
      { $group: { _id: "$eventMeta.element", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 20 }
    ]).toArray();

    // Average scroll depth by page
    const scrollDepthByPage = await col.aggregate([
      { $match: { ...dateFilter, eventType: "scroll_depth", "eventMeta.depth": { $exists: true } } },
      { $group: { _id: "$page", avgDepth: { $avg: "$eventMeta.depth" }, maxDepth: { $max: "$eventMeta.depth" }, count: { $sum: 1 } } },
      { $sort: { avgDepth: -1 } },
      { $limit: 20 }
    ]).toArray();

    // ── Period Comparison (previous period KPIs) ──
    const prevPageViews = await col.countDocuments(prevDateFilter);
    const prevVisitorsAgg = await col.aggregate([
      { $match: prevDateFilter },
      { $group: { _id: "$visitorId" } },
      { $count: "count" }
    ]).toArray();
    const prevUniqueVisitors = prevVisitorsAgg[0]?.count || 0;

    const prevRevenueAgg = await col.aggregate([
      { $match: { ...prevDateFilter, eventType: "complete_booking", "eventMeta.total": { $exists: true } } },
      { $group: { _id: null, totalRevenue: { $sum: "$eventMeta.total" }, bookingCount: { $sum: 1 } } }
    ]).toArray();
    const prevRevenue = prevRevenueAgg[0]?.totalRevenue || 0;
    const prevBookings = prevRevenueAgg[0]?.bookingCount || 0;

    const prevSessionAgg = await col.aggregate([
      { $match: { ...prevDateFilter, sessionDuration: { $exists: true, $gt: 0 } } },
      { $group: { _id: "$sessionId", avgDuration: { $avg: "$sessionDuration" } } },
      { $group: { _id: null, avg: { $avg: "$avgDuration" } } }
    ]).toArray();
    const prevAvgSession = Math.round(prevSessionAgg[0]?.avg || 0);

    function calcChange(current, previous) {
      if (previous === 0) return current > 0 ? 100 : 0;
      return parseFloat(((current - previous) / previous * 100).toFixed(1));
    }

    // ── Property Performance Ranking ──
    const propertyPerformance = await col.aggregate([
      { $match: { ...dateFilter, eventType: { $in: ["view_property", "start_booking", "complete_booking"] } } },
      {
        $group: {
          _id: "$eventMeta.propertyId",
          name: { $first: "$eventMeta.propertyName" },
          views: { $sum: { $cond: [{ $eq: ["$eventType", "view_property"] }, 1, 0] } },
          bookingStarts: { $sum: { $cond: [{ $eq: ["$eventType", "start_booking"] }, 1, 0] } },
          bookingCompletes: { $sum: { $cond: [{ $eq: ["$eventType", "complete_booking"] }, 1, 0] } },
          revenue: { $sum: { $cond: [{ $eq: ["$eventType", "complete_booking"] }, { $ifNull: ["$eventMeta.total", 0] }, 0] } },
          uniqueVisitors: { $addToSet: "$visitorId" }
        }
      },
      {
        $project: {
          _id: 1, name: 1, views: 1, bookingStarts: 1, bookingCompletes: 1, revenue: 1,
          uniqueVisitors: { $size: "$uniqueVisitors" },
          conversionRate: {
            $cond: [{ $gt: ["$views", 0] }, { $multiply: [{ $divide: ["$bookingCompletes", "$views"] }, 100] }, 0]
          }
        }
      },
      { $sort: { revenue: -1 } },
      { $limit: 20 }
    ]).toArray();

    res.json({
      period: { days, from: startDate, to: endDate },
      kpis: {
        totalPageViews,
        uniqueVisitors,
        totalSessions,
        returningVisitors,
        returningRate: parseFloat(returningRate),
        avgSessionDuration,
        bounceRate: parseFloat(bounceRate),
      },
      comparison: {
        prevPeriod: { from: prevStart, to: prevEnd },
        pageViewsChange: calcChange(totalPageViews, prevPageViews),
        visitorsChange: calcChange(uniqueVisitors, prevUniqueVisitors),
        revenueChange: calcChange(totalRevenue, prevRevenue),
        bookingsChange: calcChange(bookingCompletes, prevBookings),
        sessionChange: calcChange(avgSessionDuration, prevAvgSession),
        prev: { pageViews: prevPageViews, visitors: prevUniqueVisitors, revenue: prevRevenue, bookings: prevBookings, avgSession: prevAvgSession }
      },
      funnel: {
        propertyViews,
        bookingStarts,
        bookingCompletes,
        viewToStartRate: propertyViews > 0 ? parseFloat(((bookingStarts / propertyViews) * 100).toFixed(1)) : 0,
        startToCompleteRate: bookingStarts > 0 ? parseFloat(((bookingCompletes / bookingStarts) * 100).toFixed(1)) : 0,
        overallConversion: uniqueVisitors > 0 ? parseFloat(((bookingCompletes / uniqueVisitors) * 100).toFixed(2)) : 0,
      },
      dailyTrend,
      topPages,
      topCountries,
      topCities,
      deviceTypes,
      browsers,
      operatingSystems,
      hourlyHeatmap,
      utmCampaigns,
      referrers,
      topSearches,
      topProperties,
      propertyPerformance,
      jsErrors,
      totalErrors,
      revenue: {
        totalRevenue,
        aov,
        dailyRevenueTrend,
        revenueByUtm,
        revenueByDevice
      },
      behavior: {
        topClicks,
        scrollDepthByPage
      }
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/analytics/visitors — Paginated visitor list
router.get("/analytics/visitors", authMiddleware, async (req, res, next) => {
  try {
    const col = await mongo.getCollection("site_analytics");
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
    const skip = (page - 1) * limit;
    const search = req.query.search || "";

    let matchFilter = {};
    if (search) {
      matchFilter = {
        $or: [
          { "geo.country": { $regex: search, $options: "i" } },
          { "geo.city": { $regex: search, $options: "i" } },
          { "device.browser": { $regex: search, $options: "i" } },
          { page: { $regex: search, $options: "i" } },
          { visitorId: { $regex: search, $options: "i" } },
        ]
      };
    }

    // Aggregate by visitor
    const visitors = await col.aggregate([
      { $match: matchFilter },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$visitorId",
          lastSeen: { $first: "$createdAt" },
          firstSeen: { $last: "$createdAt" },
          totalViews: { $sum: 1 },
          visitCount: { $max: "$visitCount" },
          country: { $first: "$geo.country" },
          city: { $first: "$geo.city" },
          browser: { $first: "$device.browser" },
          os: { $first: "$device.os" },
          deviceType: { $first: "$device.deviceType" },
          lastPage: { $first: "$page" },
          userId: { $first: "$userId" },
          sessionDuration: { $avg: "$sessionDuration" },
        }
      },
      { $sort: { lastSeen: -1 } },
      {
        $facet: {
          data: [{ $skip: skip }, { $limit: limit }],
          total: [{ $count: "count" }]
        }
      }
    ]).toArray();

    const data = visitors[0]?.data || [];
    const total = visitors[0]?.total[0]?.count || 0;

    res.json({
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) }
    });
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════════════════════════════════
// GET /admin/analytics/booking-intelligence
// Aggregates enriched booking data for decision-making insights
// ══════════════════════════════════════════════════════════════════
router.get("/analytics/booking-intelligence", authMiddleware, async (req, res, next) => {
  try {
    const col = await mongo.getCollection("bookings");
    const days = parseInt(req.query.days) || 30;

    let startDate, endDate;
    if (req.query.from && req.query.to) {
      startDate = new Date(req.query.from); startDate.setHours(0,0,0,0);
      endDate = new Date(req.query.to); endDate.setHours(23,59,59,999);
    } else {
      startDate = new Date(); startDate.setDate(startDate.getDate() - days); startDate.setHours(0,0,0,0);
      endDate = new Date();
    }

    const dateFilter = { createdAt: { $gte: startDate, $lte: endDate } };

    // ── KPIs ──
    const totalBookings = await col.countDocuments(dateFilter);
    const confirmedBookings = await col.countDocuments({ ...dateFilter, status: { $in: ["Confirmed", "Checked-In", "Checked-Out"] } });

    const revenueAgg = await col.aggregate([
      { $match: dateFilter },
      { $group: { _id: null, totalRevenue: { $sum: "$totalBookingAmount" }, totalFees: { $sum: "$platformFee" }, totalHostShare: { $sum: "$hostShare" }, avgNights: { $avg: "$nights" }, count: { $sum: 1 } } }
    ]).toArray();
    const totals = revenueAgg[0] || {};

    // ── Guest Demographics: Nationality ──
    const nationalityBreakdown = await col.aggregate([
      { $match: { ...dateFilter, nationality: { $exists: true, $ne: null, $ne: "" } } },
      { $group: { _id: "$nationality", count: { $sum: 1 }, revenue: { $sum: "$totalBookingAmount" }, avgNights: { $avg: "$nights" } } },
      { $sort: { count: -1 } },
      { $limit: 25 }
    ]).toArray();

    // Domestic vs International
    const domesticCount = nationalityBreakdown.find(n => n._id === "Tanzanian")?.count || 0;
    const intlCount = nationalityBreakdown.filter(n => n._id !== "Tanzanian").reduce((sum, n) => sum + n.count, 0);

    // ── Gender ──
    const genderBreakdown = await col.aggregate([
      { $match: { ...dateFilter, gender: { $exists: true, $ne: null, $ne: "" } } },
      { $group: { _id: "$gender", count: { $sum: 1 }, revenue: { $sum: "$totalBookingAmount" } } },
      { $sort: { count: -1 } }
    ]).toArray();

    // ── Purpose of Visit ──
    const purposeBreakdown = await col.aggregate([
      { $match: { ...dateFilter, purposeOfVisit: { $exists: true, $ne: null, $ne: "" } } },
      { $group: { _id: "$purposeOfVisit", count: { $sum: 1 }, revenue: { $sum: "$totalBookingAmount" }, avgNights: { $avg: "$nights" } } },
      { $sort: { count: -1 } }
    ]).toArray();

    // ── Arrival Method ──
    const arrivalBreakdown = await col.aggregate([
      { $match: { ...dateFilter, arrivalMethod: { $exists: true, $ne: null, $ne: "" } } },
      { $group: { _id: "$arrivalMethod", count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]).toArray();

    // ── Lead Time Analysis ──
    const leadTimeAgg = await col.aggregate([
      { $match: { ...dateFilter, "meta.leadTimeDays": { $exists: true } } },
      { $group: {
        _id: null,
        avgLeadTime: { $avg: "$meta.leadTimeDays" },
        minLeadTime: { $min: "$meta.leadTimeDays" },
        maxLeadTime: { $max: "$meta.leadTimeDays" },
        lastMinuteCount: { $sum: { $cond: [{ $lte: ["$meta.leadTimeDays", 1] }, 1, 0] } },
        sameWeekCount: { $sum: { $cond: [{ $and: [{ $gt: ["$meta.leadTimeDays", 1] }, { $lte: ["$meta.leadTimeDays", 7] }] }, 1, 0] } },
        advanceCount: { $sum: { $cond: [{ $gte: ["$meta.leadTimeDays", 14] }, 1, 0] } },
        total: { $sum: 1 }
      }}
    ]).toArray();
    const leadTime = leadTimeAgg[0] || {};

    // ── Booking Duration (time spent filling form) ──
    const bookingDurationAgg = await col.aggregate([
      { $match: { ...dateFilter, "meta.bookingDurationSeconds": { $exists: true, $gt: 0 } } },
      { $group: { _id: null, avg: { $avg: "$meta.bookingDurationSeconds" }, min: { $min: "$meta.bookingDurationSeconds" }, max: { $max: "$meta.bookingDurationSeconds" } } }
    ]).toArray();
    const formDuration = bookingDurationAgg[0] || {};

    // ── Device Type (from booking meta) ──
    const bookingDeviceBreakdown = await col.aggregate([
      { $match: dateFilter },
      { $group: {
        _id: {
          $cond: [
            { $eq: [{ $ifNull: ["$meta.isMobile", false] }, true] }, "Mobile",
            { $cond: [{ $eq: [{ $ifNull: ["$meta.isTablet", false] }, true] }, "Tablet", "Desktop"] }
          ]
        },
        count: { $sum: 1 },
        revenue: { $sum: "$totalBookingAmount" }
      }},
      { $sort: { count: -1 } }
    ]).toArray();

    // ── Payment Method Popularity ──
    const paymentMethodBreakdown = await col.aggregate([
      { $match: { ...dateFilter, paymentMethodUsed: { $exists: true, $ne: null } } },
      { $group: { _id: "$paymentMethodUsed", count: { $sum: 1 }, revenue: { $sum: "$totalBookingAmount" } } },
      { $sort: { count: -1 } }
    ]).toArray();

    // ── Revenue by Accommodation Type ──
    const revenueByAccomType = await col.aggregate([
      { $match: { ...dateFilter, accomodationType: { $exists: true, $ne: null } } },
      { $group: { _id: "$accomodationType", count: { $sum: 1 }, revenue: { $sum: "$totalBookingAmount" }, avgNights: { $avg: "$nights" } } },
      { $sort: { revenue: -1 } }
    ]).toArray();

    // ── Top Accommodations by Revenue ──
    const topAccommodations = await col.aggregate([
      { $match: dateFilter },
      { $group: { _id: "$accomodationId", name: { $first: "$accomodationName" }, count: { $sum: 1 }, revenue: { $sum: "$totalBookingAmount" }, avgNights: { $avg: "$nights" } } },
      { $sort: { revenue: -1 } },
      { $limit: 15 }
    ]).toArray();

    // ── Peak Booking Hours ──
    const bookingHourly = await col.aggregate([
      { $match: dateFilter },
      { $group: { _id: { $hour: "$createdAt" }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]).toArray();

    // ── Day of Week Pattern ──
    const dayOfWeekPattern = await col.aggregate([
      { $match: dateFilter },
      { $group: { _id: { $dayOfWeek: "$createdAt" }, count: { $sum: 1 }, revenue: { $sum: "$totalBookingAmount" } } },
      { $sort: { _id: 1 } }
    ]).toArray();

    // ── Daily Booking Trend ──
    const dailyBookingTrend = await col.aggregate([
      { $match: dateFilter },
      { $group: {
        _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" }, day: { $dayOfMonth: "$createdAt" } },
        bookings: { $sum: 1 },
        revenue: { $sum: "$totalBookingAmount" }
      }},
      { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } }
    ]).toArray();

    // ── Guest Count Distribution ──
    const guestCountDist = await col.aggregate([
      { $match: dateFilter },
      { $group: {
        _id: null,
        avgAdults: { $avg: "$adults" },
        avgChildren: { $avg: "$children" },
        avgTotalGuests: { $avg: "$totalGuests" },
        maxGuests: { $max: "$totalGuests" },
        withChildrenCount: { $sum: { $cond: [{ $gt: [{ $ifNull: ["$children", 0] }, 0] }, 1, 0] } },
        total: { $sum: 1 }
      }}
    ]).toArray();
    const guestStats = guestCountDist[0] || {};

    // ── Estimated Arrival Time Distribution ──
    const arrivalTimeDistribution = await col.aggregate([
      { $match: { ...dateFilter, estimatedArrivalTime: { $exists: true, $ne: null, $ne: "" } } },
      { $group: { _id: "$estimatedArrivalTime", count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]).toArray();

    // ── Pricing Breakdown ──
    const pricingAgg = await col.aggregate([
      { $match: dateFilter },
      { $group: {
        _id: null,
        totalCleaningFees: { $sum: { $ifNull: ["$cleaningFee", 0] } },
        totalSecurityDeposits: { $sum: { $ifNull: ["$securityDeposit", 0] } },
        avgRoomPrice: { $avg: "$basePricePerNight" },
        avgDisplayPrice: { $avg: "$displayPricePerNight" },
      }}
    ]).toArray();
    const pricing = pricingAgg[0] || {};

    // ── Special Requests Analysis ──
    const withSpecialRequests = await col.countDocuments({ ...dateFilter, specialRequests: { $exists: true, $ne: "", $ne: null } });

    // ── Logged-in vs Guest Bookings ──
    const loggedInCount = await col.countDocuments({ ...dateFilter, "meta.isLoggedIn": true });
    const guestBookingCount = totalBookings - loggedInCount;

    // ── Language Distribution ──
    const languageDist = await col.aggregate([
      { $match: { ...dateFilter, "meta.language": { $exists: true, $ne: null } } },
      { $group: { _id: "$meta.language", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]).toArray();

    // ── Timezone Distribution ──
    const timezoneDist = await col.aggregate([
      { $match: { ...dateFilter, "meta.timezone": { $exists: true, $ne: null } } },
      { $group: { _id: "$meta.timezone", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]).toArray();

    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

    res.json({
      period: { days, from: startDate, to: endDate },
      kpis: {
        totalBookings,
        confirmedBookings,
        totalRevenue: totals.totalRevenue || 0,
        totalPlatformFees: totals.totalFees || 0,
        totalHostShare: totals.totalHostShare || 0,
        avgOrderValue: totals.count ? Math.round((totals.totalRevenue || 0) / totals.count) : 0,
        avgNights: Math.round((totals.avgNights || 0) * 10) / 10,
      },
      demographics: {
        nationalityBreakdown,
        domesticCount,
        internationalCount: intlCount,
        domesticRate: totalBookings > 0 ? parseFloat(((domesticCount / totalBookings) * 100).toFixed(1)) : 0,
        genderBreakdown,
      },
      travelBehavior: {
        purposeBreakdown,
        arrivalBreakdown,
        leadTime: {
          avgDays: Math.round((leadTime.avgLeadTime || 0) * 10) / 10,
          minDays: leadTime.minLeadTime || 0,
          maxDays: leadTime.maxLeadTime || 0,
          lastMinuteCount: leadTime.lastMinuteCount || 0,
          sameWeekCount: leadTime.sameWeekCount || 0,
          advanceCount: leadTime.advanceCount || 0,
          lastMinuteRate: leadTime.total ? parseFloat(((leadTime.lastMinuteCount / leadTime.total) * 100).toFixed(1)) : 0,
        },
        arrivalTimeDistribution,
      },
      bookingBehavior: {
        avgFormDurationSeconds: Math.round(formDuration.avg || 0),
        bookingDeviceBreakdown,
        paymentMethodBreakdown,
        bookingHourly,
        dayOfWeekPattern: dayOfWeekPattern.map(d => ({ ...d, dayName: dayNames[d._id - 1] || "?" })),
        loggedInBookings: loggedInCount,
        guestBookings: guestBookingCount,
        withSpecialRequests,
        specialRequestRate: totalBookings > 0 ? parseFloat(((withSpecialRequests / totalBookings) * 100).toFixed(1)) : 0,
      },
      revenue: {
        revenueByAccomType,
        topAccommodations,
        dailyBookingTrend,
      },
      guests: {
        avgAdults: Math.round((guestStats.avgAdults || 0) * 10) / 10,
        avgChildren: Math.round((guestStats.avgChildren || 0) * 10) / 10,
        avgTotalGuests: Math.round((guestStats.avgTotalGuests || 0) * 10) / 10,
        maxGuests: guestStats.maxGuests || 0,
        withChildrenRate: guestStats.total ? parseFloat(((guestStats.withChildrenCount / guestStats.total) * 100).toFixed(1)) : 0,
      },
      pricing: {
        totalCleaningFees: pricing.totalCleaningFees || 0,
        totalSecurityDeposits: pricing.totalSecurityDeposits || 0,
        avgRoomPrice: Math.round(pricing.avgRoomPrice || 0),
        avgDisplayPrice: Math.round(pricing.avgDisplayPrice || 0),
      },
      locale: { languageDist, timezoneDist },
    });
  } catch (err) {
    next(err);
  }
});

// POST /admin/analytics/send-weekly-report — Trigger weekly email report
router.post("/analytics/send-weekly-report", authMiddleware, async (req, res, next) => {
  try {
    const col = await mongo.getCollection("site_analytics");
    const adminEmail = req.body.email || req.user?.email;
    if (!adminEmail) return res.status(400).json({ error: "Admin email is required" });

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 7);
    startDate.setHours(0, 0, 0, 0);
    const dateFilter = { createdAt: { $gte: startDate } };

    const totalPageViews = await col.countDocuments(dateFilter);
    const uniqueVisitorsAgg = await col.aggregate([{ $match: dateFilter }, { $group: { _id: "$visitorId" } }, { $count: "count" }]).toArray();
    const uniqueVisitors = uniqueVisitorsAgg[0]?.count || 0;
    const bookingsCount = await col.countDocuments({ ...dateFilter, eventType: "complete_booking" });
    const revenueAgg = await col.aggregate([{ $match: { ...dateFilter, eventType: "complete_booking", "eventMeta.total": { $exists: true } } }, { $group: { _id: null, total: { $sum: "$eventMeta.total" } } }]).toArray();
    const totalRevenue = revenueAgg[0]?.total || 0;
    const errorsCount = await col.countDocuments({ ...dateFilter, eventType: "js_error" });

    // Top 5 properties by views
    const topProps = await col.aggregate([{ $match: { ...dateFilter, eventType: "view_property" } }, { $group: { _id: "$eventMeta.propertyName", views: { $sum: 1 } } }, { $sort: { views: -1 } }, { $limit: 5 }]).toArray();

    const EMAIL_API = process.env.EMAIL_API_URL || "http://localhost:4003";
    const now = new Date();
    const weekStart = new Date(startDate).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const weekEnd = now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

    const topPropsHtml = topProps.length > 0 ? topProps.map((p, i) => `<tr><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;color:#0f172a;font-size:14px;font-weight:600;">${i + 1}. ${p._id || 'Unknown'}</td><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;text-align:right;color:#6366f1;font-weight:700;">${p.views} views</td></tr>`).join("") : '<tr><td colspan="2" style="padding:12px 0;color:#94a3b8;text-align:center;">No property views yet</td></tr>';

    const htmlBody = `
      <h2 style="color:#0f172a;font-size:22px;margin:0 0 8px;">Weekly Analytics Report 📊</h2>
      <p style="color:#64748b;font-size:15px;line-height:1.6;margin:0 0 24px;">
        Here's your ReM360 platform performance summary for <strong>${weekStart} — ${weekEnd}</strong>
      </p>

      <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
        <tr>
          <td style="padding:16px;background:#f0fdf4;border-radius:12px 0 0 12px;text-align:center;width:33%;">
            <div style="color:#059669;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:0.1em;">Page Views</div>
            <div style="color:#064e3b;font-size:28px;font-weight:900;margin-top:4px;">${totalPageViews.toLocaleString()}</div>
          </td>
          <td style="padding:16px;background:#eef2ff;text-align:center;width:34%;">
            <div style="color:#4338ca;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:0.1em;">Unique Visitors</div>
            <div style="color:#1e1b4b;font-size:28px;font-weight:900;margin-top:4px;">${uniqueVisitors.toLocaleString()}</div>
          </td>
          <td style="padding:16px;background:#fffbeb;border-radius:0 12px 12px 0;text-align:center;width:33%;">
            <div style="color:#b45309;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:0.1em;">Revenue</div>
            <div style="color:#78350f;font-size:28px;font-weight:900;margin-top:4px;">TZS ${totalRevenue.toLocaleString()}</div>
          </td>
        </tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
        <tr>
          <td style="padding:12px 0;border-bottom:1px solid #f1f5f9;">
            <span style="color:#94a3b8;font-size:12px;font-weight:700;text-transform:uppercase;">Bookings Completed</span><br/>
            <span style="color:#0f172a;font-size:16px;font-weight:700;">${bookingsCount}</span>
          </td>
        </tr>
        <tr>
          <td style="padding:12px 0;border-bottom:1px solid #f1f5f9;">
            <span style="color:#94a3b8;font-size:12px;font-weight:700;text-transform:uppercase;">JS Errors</span><br/>
            <span style="color:${errorsCount > 0 ? '#ef4444' : '#10b981'};font-size:16px;font-weight:700;">${errorsCount}</span>
          </td>
        </tr>
      </table>

      <h3 style="color:#0f172a;font-size:16px;margin:24px 0 12px;">Top Properties by Views</h3>
      <table width="100%" cellpadding="0" cellspacing="0">
        ${topPropsHtml}
      </table>

      <div style="text-align:center;margin:32px 0;">
        <a href="${process.env.ADMIN_URL || 'https://admin.rem360.co.tz'}/analytics" style="display:inline-block;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#ffffff;padding:14px 36px;border-radius:12px;text-decoration:none;font-weight:700;font-size:14px;">View Full Dashboard</a>
      </div>
    `;

    const axios = require("axios");
    await axios.post(`${EMAIL_API}/api/email/send`, {
      to: adminEmail,
      subject: `📊 ReM360 Weekly Report — ${weekStart} to ${weekEnd}`,
      html: htmlBody
    });

    res.json({ success: true, sentTo: adminEmail, period: { from: startDate, to: now } });
  } catch (err) {
    console.error("Weekly report error:", err.message);
    next(err);
  }
});

// ══════════════════════════════════════════════════════════════
// PENDING PHOTO APPROVAL (Admin)
// ══════════════════════════════════════════════════════════════

// Get all pending photos across accommodations and rooms
router.get("/pending-photos", authMiddleware, async (req, res, next) => {
  try {
    const accCol = await mongo.getCollection("accomodations");
    const roomsCol = await mongo.getCollection("rooms");

    const accsWithPending = await accCol.find({ "pendingImages.0": { $exists: true } }).toArray();
    const roomsWithPending = await roomsCol.find({ "pendingImages.0": { $exists: true } }).toArray();

    const pending = [];
    for (const acc of accsWithPending) {
      for (const img of (acc.pendingImages || [])) {
        pending.push({ ...img, entityType: "accommodation", entityId: acc._id.toString(), entityName: acc.name || "Unnamed" });
      }
    }
    for (const room of roomsWithPending) {
      for (const img of (room.pendingImages || [])) {
        pending.push({ ...img, entityType: "room", entityId: room._id.toString(), entityName: room.roomName || "Unnamed Room" });
      }
    }

    pending.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    res.json({ status: "success", pending, total: pending.length });
  } catch (err) {
    next(err);
  }
});

// Approve a pending photo — move from pendingImages to otherImages
router.post("/approve-photo", authMiddleware, async (req, res, next) => {
  try {
    const { entityType, entityId, imageUrl } = req.body;
    if (!entityType || !entityId || !imageUrl) return res.status(400).json({ error: "entityType, entityId, and imageUrl are required" });

    const colName = entityType === "room" ? "rooms" : "accomodations";
    const col = await mongo.getCollection(colName);

    await col.updateOne(
      { _id: new ObjectId(entityId) },
      { $pull: { pendingImages: { url: imageUrl } }, $push: { otherImages: imageUrl } }
    );

    res.json({ status: "success", message: "Photo approved and added to gallery." });
  } catch (err) {
    next(err);
  }
});

// Reject a pending photo — remove from pendingImages and delete file from disk
router.post("/reject-photo", authMiddleware, async (req, res, next) => {
  try {
    const { entityType, entityId, imageUrl } = req.body;
    if (!entityType || !entityId || !imageUrl) return res.status(400).json({ error: "entityType, entityId, and imageUrl are required" });

    const colName = entityType === "room" ? "rooms" : "accomodations";
    const col = await mongo.getCollection(colName);

    await col.updateOne(
      { _id: new ObjectId(entityId) },
      { $pull: { pendingImages: { url: imageUrl } } }
    );

    // Attempt to delete the file from disk
    try {
      const filename = imageUrl.split("/").pop();
      if (filename) {
        const filePath = path.join(__dirname, "../../public/uploads/images", filename);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
    } catch (e) { /* ignore file deletion errors */ }

    res.json({ status: "success", message: "Photo rejected and removed." });
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════════════════════════════
// FEEDBACK MANAGEMENT (Admin)
// ══════════════════════════════════════════════════════════════

// Get all feedback with summary stats
router.get("/feedback", authMiddleware, async (req, res, next) => {
  try {
    const col = await mongo.getCollection("feedback");
    const feedback = await col.find({}).sort({ createdAt: -1 }).toArray();

    // Compute summary stats
    const total = feedback.length;
    const newCount = feedback.filter((f) => f.status === "new").length;
    const reviewedCount = feedback.filter((f) => f.status === "reviewed").length;
    const archivedCount = feedback.filter((f) => f.status === "archived").length;

    const ratings = feedback.filter((f) => f.rating).map((f) => f.rating);
    const avgRating = ratings.length > 0 ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1) : "0.0";

    const ratingDistribution = [0, 0, 0, 0, 0]; // index 0 = 1 star, index 4 = 5 stars
    ratings.forEach((r) => { if (r >= 1 && r <= 5) ratingDistribution[r - 1]++; });

    res.json({
      status: "success",
      feedback,
      stats: {
        total,
        newCount,
        reviewedCount,
        archivedCount,
        avgRating: parseFloat(avgRating),
        ratingDistribution,
      },
    });
  } catch (err) {
    next(err);
  }
});

// Update feedback status and/or admin notes
router.put("/feedback/:id", authMiddleware, async (req, res, next) => {
  try {
    const { status, adminNotes } = req.body;
    const col = await mongo.getCollection("feedback");

    const updateFields = { updatedAt: new Date() };
    if (status) updateFields.status = status;
    if (adminNotes !== undefined) updateFields.adminNotes = adminNotes;

    await col.updateOne({ _id: new ObjectId(req.params.id) }, { $set: updateFields });

    const updated = await col.findOne({ _id: new ObjectId(req.params.id) });
    res.json({ status: "success", feedback: updated });
  } catch (err) {
    next(err);
  }
});

// Delete feedback
router.delete("/feedback/:id", authMiddleware, async (req, res, next) => {
  try {
    const col = await mongo.getCollection("feedback");
    await col.deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ status: "success", message: "Feedback deleted" });
  } catch (err) {
    next(err);
  }
});

router.use("/chat", require("./chat"));

module.exports = router;
