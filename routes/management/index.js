const express = require("express");
const router = express.Router();
const mongo = require("../../lib/mongo");
const { authMiddleware, verify, sign } = require("../../lib/auth");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const { body, validationResult, query } = require("express-validator");
const users = require("../../lib/users");
const rateLimit = require("express-rate-limit");
const { ObjectId } = require("mongodb");

// Ensure indexes on startup for users collection
users.ensureIndexes().catch(() => {});

// Configure multer for image uploads
const uploadDir = path.join(__dirname, "../../public/uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedMimes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    if (true) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type. Only images are allowed."));
    }
  },
});

// Configure multer for document uploads
const documentStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, "../../public/uploads/documents"));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(
      null,
      file.fieldname + "-" + uniqueSuffix + path.extname(file.originalname),
    );
  },
});

const documentUpload = multer({
  storage: documentStorage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are allowed"), false);
    }
  },
});

// Management registration
router.post(
  "/register",
  documentUpload.fields([
    // { name: "tinDocument", maxCount: 1 },
    // { name: "businessLicenseDocument", maxCount: 1 },
    { name: "idDocument", maxCount: 1 },
  ]),
  async (req, res, next) => {
    try {
      const userData = req.body;
      const files = req.files;

      // Validate required fields
      const requiredFields = [
        "name",
        "email",
        "password",
        "confirmPassword",
        "phone",
        "nationality",
        // "tinNumber",
        // "businessLicenseNumber",
        "idNumber",
        // "paymentMethod",
      ];

      for (const field of requiredFields) {
        if (!userData[field]) {
          return res.status(400).json({ message: `${field} is required` });
        }
      }

      // // Validate payment method
      // if (!["bank", "mobile"].includes(userData.paymentMethod)) {
      //   return res.status(400).json({ message: "Invalid payment method" });
      // }

      // Validate payment details based on method
      /*
      if (userData.paymentMethod === "bank") {
        const bankFields = ["bankType", "accountName", "accountNumber"];
        for (const field of bankFields) {
          if (!userData[field]) {
            return res
              .status(400)
              .json({ message: `${field} is required for bank payment` });
          }
        }
        if (!["CRDB", "NMB"].includes(userData.bankType)) {
          return res.status(400).json({ message: "Invalid bank type" });
        }
      } else if (userData.paymentMethod === "mobile") {
        const mobileFields = [
          "mobileProvider",
          "registeredName",
          "mobilePhone",
        ];
        for (const field of mobileFields) {
          if (!userData[field]) {
            return res
              .status(400)
              .json({ message: `${field} is required for mobile payment` });
          }
        }
        if (
          !["Mpesa", "Mixx by YAS", "Airtel Money"].includes(
            userData.mobileProvider,
          )
        ) {
          return res.status(400).json({ message: "Invalid mobile provider" });
        }
        // Validate mobile phone: 10 digits
        if (!/^\d{10}$/.test(userData.mobilePhone)) {
          return res
            .status(400)
            .json({ message: "Mobile phone must be exactly 10 digits" });
        }
      }
*/
      // Validate password match
      if (userData.password !== userData.confirmPassword) {
        return res.status(400).json({ message: "Passwords do not match" });
      }

      // Validate phone: 10 digits
      if (!/^\d{10}$/.test(userData.phone)) {
        return res
          .status(400)
          .json({ message: "Phone must be exactly 10 digits" });
      }

      // Validate files
      if (!files.idDocument) {
        return res
          .status(400)
          .json({ message: "All document files are required" });
      }

      const col = await mongo.getCollection("management");
      const existing = await col.findOne({ email: userData.email });
      if (existing) {
        return res.status(409).json({ message: "User already exists" });
      }

      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(userData.password, salt);
      const reference = "REF" + Date.now();

      const user = {
        name: userData.name,
        email: userData.email,
        passwordHash,
        phone: userData.phone,
        nationality: userData.nationality,
        // tinNumber: userData.tinNumber,
        // businessLicenseNumber: userData.businessLicenseNumber,
        idNumber: userData.idNumber,
        // tinDocument: files.tinDocument[0].filename,
        // businessLicenseDocument: files.businessLicenseDocument[0].filename,
        idDocument: files.idDocument[0].filename,
        // paymentMethod: userData.paymentMethod,
        // ...(userData.paymentMethod === "bank" && {
        //   bankType: userData.bankType,
        //   accountName: userData.accountName,
        //   accountNumber: userData.accountNumber,
        // }),
        // ...(userData.paymentMethod === "mobile" && {
        //   mobileProvider: userData.mobileProvider,
        //   registeredName: userData.registeredName,
        //   mobilePhone: userData.mobilePhone,
        // }),
        role: "Manager",
        approved: false,
        approvedState: "Pending",
        owner: true,
        reference,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await col.insertOne(user);
      const { passwordHash: _, createdAt, updatedAt, ...safe } = user;
      res.json({
        message: "Registration successful",
        user: {
          _id: user._id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          role: user.role,
          owner: user.owner,
          reference: user.reference,
        },
      });
    } catch (error) {
      console.error("Registration error:", error);
      res.status(500).json({
        message: error.message || "Registration failed",
      });
    }
  },
);

// Management registration
router.post("/newUser", async (req, res, next) => {
  try {
    const { name, phone, email, password, role, reference } = req.body;
    if (!name || !email || !password)
      return res
        .status(400)
        .json({ error: "name, email and password are required" });

    const col = await mongo.getCollection("management");
    const existing = await col.findOne({ email });
    if (existing)
      return res.status(409).json({ error: "email already in use" });

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    const last = await col.find({}).sort({ id: -1 }).limit(1).toArray();
    const id = last.length ? last[0].id + 1 : 1;
    const admin = {
      name,
      email,
      phone,
      passwordHash,
      role,
      createdAt: new Date(),
      owner: false,
      reference,
      blocked: false,
    };

    await col.insertOne(admin);
    const { passwordHash: _, createdAt, ...safe } = admin;
    res.status(201).json(safe);
  } catch (err) {
    next(err);
  }
});
// Management registration
router.post("/accomodations", async (req, res, next) => {
  try {
    const payload = req.body;
    const accomodationData = {
      ...payload,
      createdAt: new Date(),
    };
    const col = await mongo.getCollection("accomodations");

    console.log(accomodationData);
    await col.insertOne(accomodationData);

    res.status(200).json("Accomodation created successfully");
  } catch (err) {
    next(err);
  }
});

// Register new accommodation with documents
router.post("/accommodations/register", async (req, res, next) => {
  try {
    const finalPayload = req.body;

    // Validate required fields
    const requiredFields = [
      "name",
      "description",
      "location",
      "type",
      "amenities",
      "frontImage",
      "otherImages",
      "reference",
      "tinNumber",
      "businessLicenseNumber",
      "tinDocumentUrl",
      "businessLicenseDocumentUrl",
      "mobileProvider",
      "bankName",
      "accountNumber",
      "accountName",
      "mobileNumber",
      "registerName",
    ];

    const missingFields = requiredFields.filter(
      (field) => !finalPayload[field],
    );
    if (missingFields.length > 0) {
      return res.status(400).json({
        message: "Missing required fields",
        missingFields,
      });
    }

    // Validate document URLs are provided
    if (
      !finalPayload.tinDocumentUrl ||
      !finalPayload.businessLicenseDocumentUrl
    ) {
      return res.status(400).json({
        message: "Document URLs are required",
      });
    }

    // Validate URLs point to PDF documents (basic check)
    const pdfUrlPattern = /\.(pdf)$/i;
    if (
      !pdfUrlPattern.test(finalPayload.tinDocumentUrl) ||
      !pdfUrlPattern.test(finalPayload.businessLicenseDocumentUrl)
    ) {
      return res.status(400).json({
        message: "Document URLs must point to valid PDF files",
      });
    }

    // Validate wallet structure
    const wallet = finalPayload.wallet || {
      credit: 0,
      debit: 0,
      balance: 0,
    };

    // Validate amenities is an array
    if (!Array.isArray(finalPayload.amenities)) {
      return res.status(400).json({
        message: "Amenities must be an array",
      });
    }

    // Validate otherImages is an array
    if (!Array.isArray(finalPayload.otherImages)) {
      return res.status(400).json({
        message: "Other images must be an array",
      });
    }

    // Create accommodation record
    const accommodationRecord = {
      name: finalPayload.name,
      description: finalPayload.description,
      location: finalPayload.location,
      type: finalPayload.type,
      amenities: finalPayload.amenities,
      otherImagesCount:
        finalPayload.otherImagesCount || finalPayload.otherImages.length,
      frontImage: finalPayload.frontImage,
      otherImages: finalPayload.otherImages,
      adminApproval: false, // Always false for new accommodations
      reference: finalPayload.reference,
      isNew: true,
      // Business verification documents
      tinNumber: finalPayload.tinNumber,
      businessLicenseNumber: finalPayload.businessLicenseNumber,
      tinDocumentUrl: finalPayload.tinDocumentUrl,
      businessLicenseDocumentUrl: finalPayload.businessLicenseDocumentUrl,
      // Payment information
      mobileProvider: finalPayload.mobileProvider,
      bankName: finalPayload.bankName,
      accountNumber: finalPayload.accountNumber,
      accountName: finalPayload.accountName,
      mobileNumber: finalPayload.mobileNumber,
      registerName: finalPayload.registerName,
      // Wallet
      wallet,
      // Metadata
      createdAt: new Date(),
      updatedAt: new Date(),
      status: "pending", // pending approval
    };

    // Store in database
    const col = await mongo.getCollection("accommodations");
    const result = await col.insertOne(accommodationRecord);

    res.status(201).json({
      message: "Accommodation registered successfully",
      accommodationId: result.insertedId.toString(),
      reference: finalPayload.reference,
      status: "pending",
      adminApprovalRequired: true,
    });
  } catch (error) {
    console.error("Accommodation registration error:", error);
    res.status(500).json({
      message: error.message || "Accommodation registration failed",
    });
  }
});

router.get("/accomodations", async (req, res, next) => {
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

router.post("/accomodations/rooms", async (req, res, next) => {
  try {
    const payload = req.body;
    const accomodationData = {
      ...payload,
      createdAt: new Date(),
    };
    const col = await mongo.getCollection("rooms");
    console.log(accomodationData);
    await col.insertOne(accomodationData);

    res.status(200).json("Accomodation created successfully");
  } catch (err) {
    next(err);
  }
});

router.get("/accomodations/rooms", async (req, res, next) => {
  const id = req.query.id;
  console.log("hellow", id);
  try {
    const col = await mongo.getCollection("rooms");

    const roomsData = await col
      .find({
        accomodationReference: id,
      })
      .toArray();
    console.log(roomsData);
    res.status(200).json({
      status: "success",
      roomsData,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/users", async (req, res, next) => {
  const reference = req.query;
  try {
    const col = await mongo.getCollection("management");
    const users = await col.find({ reference: reference }).toArray();
    const safeUsers = users.map(({ passwordHash, ...rest }) => rest);
    res.json(safeUsers);
  } catch (err) {
    next(err);
  }
});

router.post("/bookings", async (req, res, next) => {
  try {
    const bookingData = req.body;
    console.log("bookingData", bookingData);

    const col = await mongo.getCollection("bookings");
    const col1 = await mongo.getCollection("accomodations");
    // console.log(bookingData.totalPrice - bookingData.totalPrice * (100 / 105));

    const newBooking = await col.insertOne({
      ...bookingData,
      createdAt: new Date(),
    });
    // const a = await col1.updateOne(
    //   { _id: new ObjectId(bookingData.accommodationId) },
    //   {
    //     $inc: {
    //       "wallet.debit":
    //         bookingData.totalPrice - bookingData.totalPrice * (100 / 105),
    //     },
    //   },
    // );
    console.log("a", a);
    res.status(201).json({
      status: "success",
      message: "Booking created successfully",
    });
  } catch (err) {
    next(err);
  }
});

router.post("/booking/checkin", async (req, res, next) => {
  try {
    const bookingData = req.body;
    console.log("bookingData", bookingData);

    const col = await mongo.getCollection("bookings");

    const a = await col.updateOne(
      { bookingId: bookingData.bookingId },
      {
        $set: {
          checkInStatus: "Checked-In",
        },
      },
    );
    console.log("a", a);
    res.status(201).json({
      status: "success",
      message: "Booking created successfully",
    });
  } catch (err) {
    next(err);
  }
});

router.get("/booking", async (req, res, next) => {
  const receiptReference = req.query.receiptReference;
  console.log("receiptReference dededed", receiptReference);
  try {
    const col = await mongo.getCollection("bookings");
    const bookings = await col.findOne({ bookingId: receiptReference });
    console.log("bookings", bookings);

    res.json({
      status: "success",
      bookings,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/wallet", async (req, res, next) => {
  const userId = req.query.userId;

  try {
    const col = await mongo.getCollection("management");
    const dbuser = await col.findOne({ _id: new ObjectId(userId) });
    const account = {
      credit: dbuser.credit || 0,
      debit: dbuser.debit || 0,
    };

    res.json({
      status: "success",
      ...account,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/bookings", async (req, res, next) => {
  try {
    const col = await mongo.getCollection("bookings");
    const bookings = await col.find({}).toArray();
    res.json({
      status: "success",
      bookings,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/wallet/deduct", async (req, res, next) => {
  try {
    const bookingData = req.body;
    console.log("bookingData", bookingData);

    // const col = await mongo.getCollection("bookings");
    // const col1 = await mongo.getCollection("management");
    // // console.log(bookingData.totalPrice - bookingData.totalPrice * (100 / 105));

    // const newBooking = await col.insertOne({
    //   ...bookingData,
    //   createdAt: new Date(),
    // });
    // const a = await col1.updateOne(
    //   { _id: new ObjectId(bookingData.reference) },
    //   {
    //     $inc: {
    //       debit: bookingData.totalPrice - bookingData.totalPrice * (100 / 105),
    //     },
    //   }
    // );
    // console.log("a", a);
    res.status(201).json({
      status: "success",
      message: "Booking created successfully",
    });
  } catch (err) {
    next(err);
  }
});

router.get("/newUser", async (req, res, next) => {
  console.log("welcome to", req.query.reference);
  try {
    const col = await mongo.getCollection("management");
    const users = await col.find({ reference: req.query.reference }).toArray();
    const safeUsers = users.map(({ passwordHash, ...rest }) => rest);
    res.json(safeUsers);
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
    const col = await mongo.getCollection("management");
    const admin = await col.findOne({ email });
    console.log(admin);
    if (!admin) return res.status(401).json({ error: "invalid credentials" });
    const ok = await bcrypt.compare(password, admin.passwordHash);
    console.log(ok);
    if (!ok) return res.status(401).json({ error: "invalid credentials" });
    const token = sign({
      email: admin.email,
      id: admin.id,
      role: "admin",
      reference: admin.owner ? admin._id : admin.reference,
    });
    const { passwordHash, ...safe } = admin;
    res.json({
      token,
      user: { ...safe, reference: admin.owner ? admin._id : admin.reference },
    });
  } catch (err) {
    next(err);
  }
});

// POST /management/users (create) - admin only
router.post("/users", async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });
    const { name, email, password, phone, role } = req.body;
    const existing = await users.findByEmail(email);
    if (existing)
      return res.status(409).json({ error: "email already in use" });
    const saltRounds = parseInt(process.env.SALT_ROUNDS || "10");
    const salt = await bcrypt.genSalt(saltRounds);
    const passwordHash = await bcrypt.hash(password, salt);
    const created = await users.createUser({
      name,
      email,
      passwordHash,
      phone,
      role: role || "user",
    });
    res.status(201).json(sanitizeUserForResponse(created));
  } catch (err) {
    next(err);
  }
});

// Management root: list services + counts
router.get("/", async (req, res, next) => {
  try {
    const itemsCol = await mongo.getCollection("items");
    const items = await itemsCol.countDocuments();
    res.json({ area: "management", msg: "management root", items });
  } catch (err) {
    next(err);
  }
});

router.get("/overview", async (req, res, next) => {
  try {
    const services = ["api", "worker"];
    const status = "ok";
    res.json({ services, status });
  } catch (err) {
    next(err);
  }
});

// Create management note (demo)
router.post("/", async (req, res, next) => {
  try {
    const { note } = req.body;
    if (!note) return res.status(400).json({ error: "note is required" });
    const col = await mongo.getCollection("management_notes");
    const last = await col.find({}).sort({ id: -1 }).limit(1).toArray();
    const id = last.length ? last[0].id + 1 : 1;
    const doc = { id, note, createdAt: new Date() };
    await col.insertOne(doc);
    res.status(201).json(doc);
  } catch (err) {
    next(err);
  }
});

// Protected: management overview
router.get("/protected", authMiddleware, async (req, res, next) => {
  try {
    const itemsCol = await mongo.getCollection("items");
    const items = await itemsCol.countDocuments();
    res.json({ user: req.user, services: ["api", "worker"], items });
  } catch (err) {
    next(err);
  }
});

// Protected: create management note
router.post("/protected", authMiddleware, async (req, res, next) => {
  try {
    const { note } = req.body;
    if (!note) return res.status(400).json({ error: "note is required" });
    const col = await mongo.getCollection("management_notes");
    const last = await col.find({}).sort({ id: -1 }).limit(1).toArray();
    const id = last.length ? last[0].id + 1 : 1;
    const doc = { id, note, createdBy: req.user.email, createdAt: new Date() };
    await col.insertOne(doc);
    res.status(201).json(doc);
  } catch (err) {
    next(err);
  }
});

// Image upload endpoint
router.post("/upload-image", upload.single("image"), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image file provided" });
    }

    const imageUrl = `/public/uploads/${req.file.filename}`;
    const doc = {
      filename: req.file.filename,
      originalName: req.file.originalname,
      url: imageUrl,
      size: req.file.size,
      mimetype: req.file.mimetype,
      uploadedAt: new Date(),
    };

    // Store metadata in MongoDB
    const col = await mongo.getCollection("uploads");
    await col.insertOne(doc);

    res.status(201).json({
      message: "Image uploaded successfully",
      ...doc,
    });
  } catch (err) {
    next(err);
  }
});

// Get image details by filename
router.get("/image/:filename", async (req, res, next) => {
  try {
    const col = await mongo.getCollection("uploads");
    const doc = await col.findOne({ filename: req.params.filename });
    if (!doc) {
      return res.status(404).json({ error: "Image not found" });
    }
    res.json(doc);
  } catch (err) {
    next(err);
  }
});

// List all uploaded images
router.get("/images", async (req, res, next) => {
  try {
    const col = await mongo.getCollection("uploads");
    const images = await col.find({}).sort({ uploadedAt: -1 }).toArray();
    res.json(images);
  } catch (err) {
    next(err);
  }
});

// -----------------------------
// /management/users endpoints
// -----------------------------

// Simple rate limiter for write endpoints
const writeLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 });

async function requireAuth(req, res, next) {
  try {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer "))
      return res.status(401).json({ error: "Unauthorized" });
    const token = auth.slice(7);
    const payload = verify(token);
    if (!payload || !payload.email)
      return res.status(401).json({ error: "Unauthorized" });
    const col = await mongo.getCollection("users");
    const user = await col.findOne({ email: payload.email });
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    req.user = {
      id: user._id.toString(),
      email: user.email,
      name: user.name,
      role: user.role,
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    if (req.user.role !== role && req.user.role !== "admin") {
      return res.status(403).json({ error: "Forbidden" });
    }
    next();
  };
}

function sanitizeUserForResponse(u) {
  if (!u) return null;
  const { passwordHash, ...rest } = u;
  if (rest._id) rest.id = rest._id.toString();
  delete rest._id;
  return rest;
}

// GET /management/users
router.get(
  "/users",
  requireAuth,
  query("page").optional().toInt(),
  query("limit").optional().toInt(),
  async (req, res, next) => {
    try {
      // allow managers and admins to list
      if (!["manager", "admin"].includes(req.user.role))
        return res.status(403).json({ error: "Forbidden" });
      const page =
        req.query.page && req.query.page > 0 ? parseInt(req.query.page) : 1;
      const limit =
        req.query.limit && req.query.limit > 0 ? parseInt(req.query.limit) : 25;
      const q = req.query.q;
      const role = req.query.role;
      let blocked;
      if (typeof req.query.blocked !== "undefined") {
        blocked = req.query.blocked === "true" || req.query.blocked === true;
      }
      const { items, total } = await users.listUsers({
        page,
        limit,
        q,
        role,
        blocked,
      });
      const safe = items.map(sanitizeUserForResponse);
      res.json({ data: safe, meta: { page, limit, total } });
    } catch (err) {
      next(err);
    }
  },
);

// GET /management/users/:id
router.get("/users/:id", requireAuth, async (req, res, next) => {
  try {
    const id = req.params.id;
    const u = await users.findById(id);
    if (!u) return res.status(404).json({ error: "Not found" });
    // only admin or owner can view full profile
    if (req.user.role !== "admin" && req.user.id !== id)
      return res.status(403).json({ error: "Forbidden" });
    res.json({ user: sanitizeUserForResponse(u) });
  } catch (err) {
    next(err);
  }
});

// PUT /management/users/:id (partial update)
router.put(
  "/users/:id",
  writeLimiter,
  requireAuth,
  body("name").optional().isString().notEmpty(),
  body("email").optional().isEmail(),
  body("phone").optional().isString(),
  body("role").optional().isIn(["user", "manager", "admin"]),
  body("blocked").optional().isBoolean(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
      const id = req.params.id;
      // permission: admin or owner
      if (req.user.role !== "admin" && req.user.id !== id)
        return res.status(403).json({ error: "Forbidden" });
      const patch = {};
      const { name, email, phone, role, blocked } = req.body;
      if (name) patch.name = name;
      if (phone) patch.phone = phone;
      if (typeof blocked !== "undefined" && req.user.role === "admin")
        patch.blocked = blocked;
      if (role && req.user.role === "admin") patch.role = role;
      if (email) {
        const existing = await users.findByEmail(email);
        if (existing && existing._id.toString() !== id)
          return res.status(409).json({ error: "email already in use" });
        patch.email = email;
      }
      const updated = await users.updateUser(id, patch);
      if (!updated) return res.status(404).json({ error: "Not found" });
      res.json(sanitizeUserForResponse(updated));
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /management/users/:id (admin only)
router.delete(
  "/users/:id",
  writeLimiter,
  requireAuth,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const id = req.params.id;
      const deleted = await users.deleteUser(id);
      if (!deleted) return res.status(404).json({ error: "Not found" });
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /management/users/:id/block
router.patch(
  "/users/:id/block",
  writeLimiter,
  requireAuth,
  requireRole("admin"),
  body("blocked").isBoolean(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
      const id = req.params.id;
      const { blocked } = req.body;
      const updated = await users.updateUser(id, { blocked });
      if (!updated) return res.status(404).json({ error: "Not found" });
      res.json(sanitizeUserForResponse(updated));
    } catch (err) {
      next(err);
    }
  },
);

module.exports = router;
