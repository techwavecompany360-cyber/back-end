const express = require("express");
const router = express.Router();
const fs = require("fs");
const mongo = require("../../lib/mongo");
const { authMiddleware, verify, sign } = require("../../lib/auth");
const multer = require("multer");
const path = require("path");
const bcrypt = require("bcryptjs");
const { body, validationResult, query } = require("express-validator");
const users = require("../../lib/users");
const rateLimit = require("express-rate-limit");
const { ObjectId } = require("mongodb");

const writeLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 });

const imageUploadsFolder = path.join(__dirname, "../../public/uploads/images");
fs.mkdirSync(imageUploadsFolder, { recursive: true });

const documentUploadsFolder = path.join(
  __dirname,
  "../../public/uploads/documents",
);
fs.mkdirSync(documentUploadsFolder, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, imageUploadsFolder);
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(null, `${uniqueSuffix}${path.extname(file.originalname)}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedMimes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type. Only images are allowed."));
    }
  },
});

function getLocalImageUrl(filename) {
  return `/public/uploads/images/${filename}`;
}

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
        adminApproval: false,
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
router.post(
  "/newUser",
  requireAuth,
  requireRole("manager"),
  async (req, res, next) => {
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
  },
);
// Management registration
router.post(
  "/accomodations",
  writeLimiter,
  requireAuth,
  async (req, res, next) => {
    try {
      const payload = req.body;
      const accomodationData = {
        ...payload,
        adminApproval: false,
        rejected: false,
        blocked: false,
        createdAt: new Date(),
      };
      const col = await mongo.getCollection("accomodations");

      await col.insertOne(accomodationData);

      res.status(200).json("Accomodation created successfully");
    } catch (err) {
      next(err);
    }
  },
);

router.get("/front-desk-users", requireAuth, async (req, res, next) => {
  const reference = req.query.reference;
  try {
    const col = await mongo.getCollection("management");
    const frontDeskUsers = await col
      .find(
        { role: "Front-Desk", reference: reference },
        {
          name: 1,
          email: 1,
          phone: 1,
          role: 1,
          reference: 1,
          primaryAccommodationId: 1,
          passwordHash: 0,
        },
      )
      .toArray();
    res.json({
      status: "success",
      users: frontDeskUsers,
    });
  } catch (err) {
    next(err);
  }
});

router.get(
  "/accomodations/front-desk-users",
  requireAuth,
  async (req, res, next) => {
    try {
      const accomodationId = req.query.accomodationId;
      const col = await mongo.getCollection("management");
      const frontDeskUsers = await col
        .find(
          { role: "Front-Desk", primaryAccommodationId: accomodationId },
          {
            name: 1,
            email: 1,
            phone: 1,
            role: 1,
            reference: 1,
            primaryAccommodationId: 1,
            passwordHash: 0,
          },
        )
        .toArray();
      res.json({ status: "success", users: frontDeskUsers });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/get-wallet",
  writeLimiter,
  requireAuth,
  async (req, res, next) => {
    try {
      const { accommodationId, ManagementId } = req.body;
      const col = await mongo.getCollection("accomodations");
      const accomodation = await col.findOne(
        { _id: new ObjectId(accommodationId) },
        { wallet: 1 },
      );

      res.status(200).json({
        status: "success",
        wallet: accomodation.wallet,
      });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/set-primary-accommodation",
  writeLimiter,
  requireAuth,
  async (req, res, next) => {
    try {
      const { accommodationId, ManagementId } = req.body;
      const col = await mongo.getCollection("management");
      await col.updateOne(
        { _id: new ObjectId(ManagementId) },
        { $set: { primaryAccommodationId: accommodationId } },
      );
      res.status(200).json({
        status: "success",
      });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/update-room-price",
  writeLimiter,
  requireAuth,
  async (req, res, next) => {
    try {
      const { roomId, newPrice } = req.body;

      const col = await mongo.getCollection("rooms");
      await col.updateOne(
        { _id: new ObjectId(roomId) },
        { $set: { price: newPrice } },
      );
      res.status(200).json({
        status: "success",
      });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/remove-primary-accommodation",
  writeLimiter,
  requireAuth,
  async (req, res, next) => {
    try {
      const { accommodationId, ManagementId } = req.body;
      const col = await mongo.getCollection("management");
      await col.updateOne(
        { _id: new ObjectId(ManagementId) },
        { $set: { primaryAccommodationId: null } },
      );
      res.status(200).json({
        status: "success",
      });
    } catch (err) {
      next(err);
    }
  },
);

// Register new accommodation with documents
router.post(
  "/accommodations/register",
  writeLimiter,
  requireAuth,
  async (req, res, next) => {
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
        adminApproval: false,
        rejected: false,
        blocked: false,
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
  },
);

router.get("/accomodations", requireAuth, async (req, res, next) => {
  try {
    const reference = req.query.reference; // get reference from URL

    const col = await mongo.getCollection("accomodations");

    let matchQuery = {};

    // if reference is provided, filter by it
    if (reference) {
      matchQuery.reference = reference;
    }

    const accomodationData = await col
      .aggregate([
        {
          $match: matchQuery,
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
                      },
                    },
                    {
                      $addFields: {
                        checkInDate: {
                          $dateFromString: { dateString: "$checkIn" },
                        },
                        checkOutDate: {
                          $dateFromString: { dateString: "$checkOut" },
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
                    $setUnion: "$bookings.dates",
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

router.get("/owner/accomodations", requireAuth, async (req, res, next) => {
  try {
    const reference = req.query.reference; // get reference from URL

    const col = await mongo.getCollection("accomodations");

    let query = {};

    // if reference is provided, filter by it
    if (reference) {
      query.reference = reference;
    }

    const accomodationData = await col
      .find({
        reference: reference,
      })
      .toArray();

    res.status(200).json({
      status: "success",
      accomodationData,
    });
  } catch (err) {
    next(err);
  }
});

router.post(
  "/accomodations/rooms",
  writeLimiter,
  requireAuth,
  async (req, res, next) => {
    try {
      const payload = req.body;
      const accomodationData = {
        ...payload,
        adminApproval: false,
        rejected: false,
        blocked: false,
        createdAt: new Date(),
      };
      const col = await mongo.getCollection("rooms");
      await col.insertOne(accomodationData);

      res.status(200).json("Accomodation created successfully");
    } catch (err) {
      next(err);
    }
  },
);

router.get("/accomodations/rooms", requireAuth, async (req, res, next) => {
  const id = req.query.id;
  try {
    const col = await mongo.getCollection("rooms");

    const roomsData = await col
      .aggregate([
        {
          $match: {
            accomodationReference: id,
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
                },
              },
              {
                $addFields: {
                  checkInDate: {
                    $dateFromString: { dateString: "$checkIn" },
                  },
                  checkOutDate: {
                    $dateFromString: { dateString: "$checkOut" },
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
              $setUnion: "$bookings.dates",
            },
          },
        },
        {
          $project: {
            bookings: 0,
          },
        },
      ])
      .toArray();
    res.status(200).json({
      status: "success",
      roomsData,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/bookings", writeLimiter, requireAuth, async (req, res, next) => {
  try {
    const bookingData = req.body;

    // Validate required fields
    if (!bookingData.roomId || !bookingData.checkIn || !bookingData.checkOut) {
      return res
        .status(400)
        .json({ error: "Missing required fields: roomId, checkIn, checkOut" });
    }

    const col = await mongo.getCollection("bookings");

    // Check for overlapping bookings
    const overlappingBookings = await col
      .find({
        roomId: bookingData.roomId,
        $or: [
          {
            checkIn: { $lt: new Date(bookingData.checkOut) },
            checkOut: { $gt: new Date(bookingData.checkIn) },
          },
        ],
      })
      .toArray();

    if (overlappingBookings.length > 0) {
      return res.status(409).json({
        error:
          "Booking conflict: The selected dates are already booked for this room",
      });
    }

    const newBooking = await col.insertOne({
      ...bookingData,
      bookingDates: {
        checkIn: new Date(bookingData.checkIn),
        checkOut: new Date(bookingData.checkOut),
      },
      createdAt: new Date(),
    });

    res.status(201).json({
      status: "success",
      message: "Booking created successfully",
      bookingId: newBooking.insertedId,
    });
  } catch (err) {
    next(err);
  }
});

router.post(
  "/booking/checkin",
  writeLimiter,
  requireAuth,
  async (req, res, next) => {
    try {
      const bookingData = req.body;
      const col = await mongo.getCollection("bookings");
      const idValue = bookingData.bookingId || bookingData.id;
      if (!idValue)
        return res.status(400).json({ error: "bookingId is required" });

      const query = ObjectId.isValid(idValue)
        ? { _id: new ObjectId(idValue) }
        : { bookingId: idValue };

      const result = await col.updateOne(query, {
        $set: {
          checkInStatus: "Checked-In",
          status: "Checked-In",
          updatedAt: new Date(),
        },
      });

      if (result.matchedCount === 0) {
        return res.status(404).json({ error: "Booking not found" });
      }

      res.status(200).json({
        status: "success",
        message: "Booking checked in successfully",
      });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/booking/checkout",
  writeLimiter,
  requireAuth,
  async (req, res, next) => {
    try {
      const bookingData = req.body;
      const col = await mongo.getCollection("bookings");
      const idValue = bookingData.bookingId || bookingData.id;
      if (!idValue)
        return res.status(400).json({ error: "bookingId is required" });

      const query = ObjectId.isValid(idValue)
        ? { _id: new ObjectId(idValue) }
        : { bookingId: idValue };

      const result = await col.updateOne(query, {
        $set: {
          checkInStatus: "Checked-Out",
          status: "Checked-Out",
          updatedAt: new Date(),
        },
      });

      if (result.matchedCount === 0) {
        return res.status(404).json({ error: "Booking not found" });
      }

      res.status(200).json({
        status: "success",
        message: "Booking checked out successfully",
      });
    } catch (err) {
      next(err);
    }
  },
);

router.get("/booking", requireAuth, async (req, res, next) => {
  const receiptReference = req.query.receiptReference;
  const accomodationReference = req.query.accomodationReference;
  try {
    const col = await mongo.getCollection("bookings");
    const bookings = await col.findOne({ bookingId: receiptReference });

    res.json({
      status: "success",
      bookings,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/wallet", requireAuth, async (req, res, next) => {
  try {
    const accommodationId = req.query.accommodationId;
    const userId = req.query.userId || req.user?.reference || req.user?.id;

    if (accommodationId) {
      const col = await mongo.getCollection("accomodations");
      const accommodationQuery = ObjectId.isValid(accommodationId)
        ? { _id: new ObjectId(accommodationId) }
        : { reference: accommodationId };

      const accommodation = await col.findOne(accommodationQuery, {
        wallet: 1,
      });
      if (!accommodation)
        return res.status(404).json({ error: "Accommodation not found" });

      const wallet = accommodation.wallet || {
        credit: 0,
        debit: 0,
        balance: 0,
      };

      return res.json({
        status: "success",
        credit: wallet.credit || 0,
        debit: wallet.debit || 0,
        balance: wallet.balance || 0,
      });
    }

    if (!userId)
      return res
        .status(400)
        .json({ error: "userId or authenticated user is required" });

    const col = await mongo.getCollection("management");
    const userIdStr = Array.isArray(userId) ? userId[0] : userId.toString();

    const query = ObjectId.isValid(userIdStr)
      ? { _id: new ObjectId(userIdStr) }
      : { reference: userIdStr };

    const dbuser = await col.findOne(query);
    if (!dbuser) return res.status(404).json({ error: "User not found" });

    const wallet = dbuser.wallet || {
      credit: dbuser.credit || 0,
      debit: dbuser.debit || 0,
      balance: 0,
    };

    res.json({
      status: "success",
      credit: wallet.credit || 0,
      debit: wallet.debit || 0,
      balance: wallet.balance || 0,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/bookings", requireAuth, async (req, res, next) => {
  try {
    const accommodationReference = req.query.accommodationReference;
    const col = await mongo.getCollection("bookings");
    const bookings = await col
      .find({ accomodationId: accommodationReference })
      .toArray();
    res.json({
      status: "success",
      bookings,
    });
  } catch (err) {
    next(err);
  }
});

router.post(
  "/wallet/deduct",
  writeLimiter,
  requireAuth,
  async (req, res, next) => {
    try {
      const { amount, accommodationId, userId, payoutMethod } = req.body;
      if (typeof amount !== "number" || amount <= 0) {
        return res
          .status(400)
          .json({ error: "Amount must be a positive number" });
      }
      if (payoutMethod && !["bank", "mobile"].includes(payoutMethod)) {
        return res.status(400).json({ error: "Invalid payout method" });
      }

      if (accommodationId) {
        const accCol = await mongo.getCollection("accomodations");
        const query = ObjectId.isValid(accommodationId)
          ? { _id: new ObjectId(accommodationId) }
          : { reference: accommodationId };
        const result = await accCol.findOne(query, { wallet: 1 });
        if (!result) {
          return res.status(404).json({ error: "Accommodation not found" });
        }

        const wallet = result.wallet || { credit: 0, debit: 0, balance: 0 };
        const newCredit = Math.max((wallet.credit || 0) - amount, 0);
        const newBalance = Math.max((wallet.balance || 0) - amount, 0);

        await accCol.updateOne(query, {
          $set: {
            "wallet.credit": newCredit,
            "wallet.balance": newBalance,
          },
        });

        return res.status(200).json({
          status: "success",
          payoutMethod: payoutMethod || null,
          wallet: {
            credit: newCredit,
            debit: wallet.debit || 0,
            balance: newBalance,
          },
        });
      }

      if (!userId)
        return res
          .status(400)
          .json({ error: "userId or accommodationId is required" });

      const mgmtCol = await mongo.getCollection("management");
      const query = ObjectId.isValid(userId)
        ? { _id: new ObjectId(userId) }
        : { reference: userId };
      const result = await mgmtCol.findOne(query, { wallet: 1 });
      if (!result) {
        return res.status(404).json({ error: "User not found" });
      }

      const wallet = result.wallet || { credit: 0, debit: 0, balance: 0 };
      const newCredit = Math.max((wallet.credit || 0) - amount, 0);
      const newBalance = Math.max((wallet.balance || 0) - amount, 0);

      await mgmtCol.updateOne(query, {
        $set: {
          "wallet.credit": newCredit,
          "wallet.balance": newBalance,
        },
      });

      res.status(200).json({
        status: "success",
        wallet: {
          credit: newCredit,
          debit: wallet.debit || 0,
          balance: newBalance,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

router.get("/analytics/summary", requireAuth, async (req, res, next) => {
  try {
    const accomodationsCol = await mongo.getCollection("accomodations");
    const bookingsCol = await mongo.getCollection("bookings");
    const managementCol = await mongo.getCollection("management");

    const totalAccommodations = await accomodationsCol.countDocuments({});
    const totalUsers = await managementCol.countDocuments({});
    const totalBookings = await bookingsCol.countDocuments({});
    const pendingApprovals = await accomodationsCol.countDocuments({
      adminApproval: false,
    });

    const topAmenitiesAgg = await accomodationsCol
      .aggregate([
        { $unwind: "$amenities" },
        {
          $group: {
            _id: "$amenities",
            count: { $sum: 1 },
          },
        },
        { $sort: { count: -1 } },
        { $limit: 8 },
      ])
      .toArray();

    const monthlyBookingsAgg = await bookingsCol
      .aggregate([
        { $match: { createdAt: { $exists: true } } },
        {
          $group: {
            _id: {
              year: { $year: "$createdAt" },
              month: { $month: "$createdAt" },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { "_id.year": 1, "_id.month": 1 } },
        { $limit: 12 },
      ])
      .toArray();

    const topAccommodationsAgg = await bookingsCol
      .aggregate([
        {
          $group: {
            _id: "$accomodationId",
            count: { $sum: 1 },
          },
        },
        { $sort: { count: -1 } },
        { $limit: 5 },
      ])
      .toArray();

    const totalRoomsResult = await accomodationsCol
      .aggregate([
        {
          $project: {
            roomsCount: { $size: { $ifNull: ["$rooms", []] } },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: "$roomsCount" },
          },
        },
      ])
      .toArray();
    const totalRooms = totalRoomsResult[0]?.total || 0;

    res.json({
      status: "success",
      totalAccommodations,
      totalRooms,
      totalBookings,
      totalUsers,
      pendingApprovals,
      topAmenities: topAmenitiesAgg.map((item) => ({
        name: item._id,
        count: item.count,
      })),
      monthlyBookings: monthlyBookingsAgg.map((item) => ({
        label: `${item._id.month}/${item._id.year}`,
        count: item.count,
      })),
      topAccommodations: topAccommodationsAgg.map((item) => ({
        name: item._id || "Unknown",
        count: item.count,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/wallet/transactions", requireAuth, async (req, res, next) => {
  try {
    const accommodationId =
      req.query.accommodationId || req.user?.primaryAccommodationId;
    const bookingsCol = await mongo.getCollection("bookings");
    const query = accommodationId ? { accomodationId: accommodationId } : {};
    const bookings = await bookingsCol
      .find(query)
      .sort({ createdAt: -1 })
      .limit(25)
      .toArray();

    const transactions = bookings.map((booking) => ({
      id: booking._id
        ? booking._id.toString()
        : booking.bookingId || String(Date.now()),
      type: booking.paymentMethod || "booking",
      amount: booking.totalPrice || booking.price || 0,
      status: booking.status || "unknown",
      reference: booking.bookingId || booking._id?.toString() || "N/A",
      guestName:
        booking.guestName || booking.customerName || booking.guest || "",
      accommodationName:
        booking.accomodationName ||
        booking.accomodation ||
        booking.accomodationId ||
        "",
      createdAt:
        booking.createdAt && booking.createdAt.toISOString
          ? booking.createdAt.toISOString()
          : String(booking.createdAt || new Date()),
    }));

    res.json({ status: "success", transactions });
  } catch (err) {
    next(err);
  }
});

router.get("/newUser", requireAuth, async (req, res, next) => {
  try {
    const userRole = (req.user.role || "").toLowerCase();
    if (!["manager", "manager"].includes(userRole)) {
      return res
        .status(403)
        .json({ error: "You don't have permission to access this." });
    }

    const reference = req.query.reference || req.user.reference;
    const col = await mongo.getCollection("management");
    const query = {};

    if (reference) {
      query.reference = reference;
    } else if (userRole === "manager") {
      query.reference = req.user.reference;
    }

    const users = await col
      .find(query, {
        passwordHash: 0,
      })
      .toArray();

    const safeUsers = users.map(({ passwordHash, ...rest }) => rest);
    res.json(safeUsers);
  } catch (err) {
    next(err);
  }
});

// PUT /management/newUser/:id (update management user)
router.put(
  "/newUser/:id",
  requireAuth,
  requireRole("manager"),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { name, email, phone, role, blocked } = req.body;

      // Validate ID - can be either numeric ID or MongoDB ObjectId
      if (!id) {
        return res.status(400).json({ error: "Invalid user ID" });
      }

      // Manual validation
      if (email && typeof email !== "string") {
        return res.status(400).json({ error: "Email must be a string" });
      }
      if (email && !email.includes("@")) {
        return res.status(400).json({ error: "Email must be valid" });
      }
      if (name && typeof name !== "string") {
        return res.status(400).json({ error: "Name must be a string" });
      }
      if (phone && typeof phone !== "string") {
        return res.status(400).json({ error: "Phone must be a string" });
      }
      if (role && typeof role !== "string") {
        return res.status(400).json({ error: "Role must be a string" });
      }
      if (typeof blocked !== "undefined" && typeof blocked !== "boolean") {
        return res.status(400).json({ error: "Blocked must be a boolean" });
      }

      const col = await mongo.getCollection("management");

      // Build query - try MongoDB ObjectId first, fall back to numeric id
      let query = {};
      if (ObjectId.isValid(id)) {
        query = { _id: new ObjectId(id) };
      } else {
        query = { id: parseInt(id) };
      }

      // Find existing user
      const user = await col.findOne(query);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Check for duplicate email (if email is being changed)
      if (email && email !== user.email) {
        const emailQuery = { email };
        if (user._id) {
          emailQuery._id = { $ne: user._id };
        } else if (user.id) {
          emailQuery.id = { $ne: user.id };
        }
        const existing = await col.findOne(emailQuery);
        if (existing) {
          return res.status(409).json({ error: "Email already in use" });
        }
      }

      // Build update object
      const updateData = {};
      if (name) updateData.name = name;
      if (email) updateData.email = email;
      if (phone) updateData.phone = phone;
      if (role) updateData.role = role;
      if (typeof blocked !== "undefined") updateData.blocked = blocked;
      updateData.updatedAt = new Date();

      // Update user in database
      const result = await col.updateOne(query, { $set: updateData });

      if (result.matchedCount === 0) {
        return res.status(404).json({ error: "User not found" });
      }

      // Fetch and return updated user (without password)
      const updatedUser = await col.findOne(query);
      const { passwordHash, ...safe } = updatedUser;

      res.json({
        message: "User updated successfully",
        user: safe,
      });
    } catch (err) {
      console.error("Error in PUT /newUser/:id:", err);
      next(err);
    }
  },
);

router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res
        .status(400)
        .json({ error: "Please provide both email and password." });
    const col = await mongo.getCollection("management");
    const admin = await col.findOne({ email });
    if (!admin)
      return res
        .status(401)
        .json({ error: "The email or password you entered is incorrect." });
    if (admin.blocked)
      return res
        .status(403)
        .json({
          error: "Your account has been suspended. Please contact support.",
        });
    if (admin.adminApproval === false)
      return res
        .status(403)
        .json({
          error: "Your account is pending approval. Please check back later.",
        });
    const ok = await bcrypt.compare(password, admin.passwordHash);
    if (!ok)
      return res
        .status(401)
        .json({ error: "The email or password you entered is incorrect." });
    const token = sign({
      email: admin.email,
      id: admin._id ? admin._id.toString() : admin.id,
      role: admin.role || "manager",
      reference: admin.owner ? admin._id.toString() : admin.reference,
    });
    const { passwordHash, ...safe } = admin;
    res.json({
      token,
      user: { ...safe },
    });
  } catch (err) {
    next(err);
  }
});

// POST /management/users (create) - admin only
router.post(
  "/users",
  requireAuth,
  requireRole("manager"),
  async (req, res, next) => {
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
  },
);

// Management root: list services + counts
router.get("/", requireAuth, async (req, res, next) => {
  try {
    const itemsCol = await mongo.getCollection("items");
    const items = await itemsCol.countDocuments();
    res.json({ area: "management", msg: "management root", items });
  } catch (err) {
    next(err);
  }
});

router.get("/overview", requireAuth, async (req, res, next) => {
  try {
    const services = ["api", "worker"];
    const status = "ok";
    res.json({ services, status });
  } catch (err) {
    next(err);
  }
});

// Create management note (demo)
router.post("/", requireAuth, async (req, res, next) => {
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
router.post(
  "/upload-image",
  requireAuth,
  upload.single("image"),
  async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No image file provided" });
      }

      const imageUrl = getLocalImageUrl(req.file.filename);

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
  },
);

// Document upload endpoint
router.post(
  "/upload-document",
  requireAuth,
  documentUpload.single("file"),
  async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No document file provided" });
      }

      const documentUrl = `/public/uploads/documents/${req.file.filename}`;

      const doc = {
        filename: req.file.filename,
        originalName: req.file.originalname,
        url: documentUrl,
        size: req.file.size,
        mimetype: req.file.mimetype,
        uploadedAt: new Date(),
      };

      const col = await mongo.getCollection("uploads");
      await col.insertOne(doc);

      res.status(201).json({
        message: "Document uploaded successfully",
        ...doc,
      });
    } catch (err) {
      next(err);
    }
  },
);

// Get image details by filename
router.get("/image/:filename", requireAuth, async (req, res, next) => {
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
router.get("/images", requireAuth, async (req, res, next) => {
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

async function requireAuth(req, res, next) {
  try {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer "))
      return res
        .status(401)
        .json({ error: "You need to be logged in to access this." });
    const token = auth.slice(7);
    const payload = verify(token);
    if (!payload || !payload.email)
      return res
        .status(401)
        .json({ error: "You need to be logged in to access this." });

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
      return res
        .status(401)
        .json({ error: "You need to be logged in to access this." });

    const blocked = !!user.blocked;
    if (blocked)
      return res
        .status(403)
        .json({
          error: "Your account has been suspended. Please contact support.",
        });
    if (user.adminApproval === false)
      return res
        .status(403)
        .json({
          error: "Your account is pending approval. Please check back later.",
        });

    const normalizedRole = (user.role || "user").toString().toLowerCase();
    req.user = {
      id: user._id ? user._id.toString() : user.id?.toString(),
      email: user.email,
      name: user.name,
      role: normalizedRole,
      reference: user.reference || (user._id ? user._id.toString() : undefined),
      owner: !!user.owner,
      blocked,
    };
    next();
  } catch (err) {
    return res
      .status(401)
      .json({ error: "You need to be logged in to access this." });
  }
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user)
      return res
        .status(401)
        .json({ error: "You need to be logged in to access this." });
    const currentRole = req.user.role.toLowerCase();
    const requiredRole = role.toLowerCase();
    if (currentRole !== requiredRole && currentRole !== "manager") {
      return res
        .status(403)
        .json({ error: "You don't have permission to access this." });
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
      const userRole = (req.user.role || "").toLowerCase();
      if (!["manager", "manager"].includes(userRole))
        return res
          .status(403)
          .json({ error: "You don't have permission to access this." });
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
    const userRole = (req.user.role || "").toLowerCase();
    if (userRole !== "manager" && req.user.id !== id)
      return res
        .status(403)
        .json({ error: "You don't have permission to access this." });
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
  body("role").optional().isIn(["user", "manager", "manager"]),
  body("blocked").optional().isBoolean(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty())
        return res.status(400).json({ errors: errors.array() });
      const id = req.params.id;

      // permission: admin or owner
      const userRole = (req.user.role || "").toLowerCase();
      console.log(
        "User role:",
        userRole,
        "User ID:",
        req.user.id,
        "Target ID:",
        id,
      );
      if (userRole !== "manager" && req.user.id !== id)
        return res
          .status(403)
          .json({ error: "You don't have permission to access this." });
      const patch = {};
      const { name, email, phone, role, blocked } = req.body;
      if (name) patch.name = name;
      if (phone) patch.phone = phone;
      if (typeof blocked !== "undefined" && userRole === "manager")
        patch.blocked = blocked;
      if (role && userRole === "manager") patch.role = role;
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
  requireRole("manager"),
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
  requireRole("manager"),
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

// Check date availability for room bookings
router.get(
  "/bookings/check-availability",
  requireAuth,
  async (req, res, next) => {
    try {
      const { roomId, checkIn, checkOut } = req.query;

      if (!roomId || !checkIn || !checkOut) {
        return res.status(400).json({
          error: "Missing required parameters: roomId, checkIn, checkOut",
        });
      }

      const col = await mongo.getCollection("bookings");

      // Find all bookings for this room that overlap with the requested dates
      const overlappingBookings = await col
        .find({
          roomId: roomId,
          $or: [
            {
              checkIn: { $lt: new Date(checkOut) },
              checkOut: { $gt: new Date(checkIn) },
            },
          ],
        })
        .toArray();

      const available = overlappingBookings.length === 0;
      res.json({ available });
    } catch (error) {
      console.error("Error checking availability:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

module.exports = router;
