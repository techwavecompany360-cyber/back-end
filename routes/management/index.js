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
const axios = require("axios");

const SMS_API = process.env.SMS_API_URL || "http://localhost:4001";
const EMAIL_API = process.env.EMAIL_API_URL || "http://localhost:4003";

function formatPhone(phone) {
  if (!phone) return null;
  let cleaned = phone.replace(/\s+/g, "").replace(/[^0-9+]/g, "");
  if (cleaned.startsWith("0")) cleaned = "+255" + cleaned.slice(1);
  if (cleaned.startsWith("255")) cleaned = "+" + cleaned;
  if (!cleaned.startsWith("+")) cleaned = "+" + cleaned;
  return cleaned;
}

function generateOTP() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

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
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB limit
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
    fileSize: 2000 * 1024 * 1024, // 5MB
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are allowed"), false);
    }
  },
});

// Change password
router.put(
  "/change-password",
  authMiddleware,
  async (req, res, next) => {
    try {
      const { oldPassword, newPassword } = req.body;
      if (!oldPassword || !newPassword) {
        return res.status(400).json({ error: "Both old and new password are required" });
      }

      if (oldPassword === newPassword) {
        return res.status(400).json({ error: "New password cannot be the same as the old password" });
      }

      const col = await mongo.getCollection("management");
      const user = await col.findOne({ email: req.user.email });
      
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      
      const isMatch = await bcrypt.compare(oldPassword, user.passwordHash);
      if (!isMatch) {
        return res.status(401).json({ error: "Incorrect current password" });
      }
      
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(newPassword, salt);
      
      await col.updateOne({ _id: user._id }, { $set: { passwordHash } });
      
      res.json({ message: "Password updated successfully" });
    } catch (err) {
      next(err);
    }
  }
);

// Fee configuration (read-only for management UI)
router.get("/fee-config", authMiddleware, async (req, res, next) => {
  try {
    const col = await mongo.getCollection("system_config");
    const config = await col.findOne({ _id: "platform_fees" });
    res.status(200).json({
      clientFeeRate: config?.clientFeeRate ?? 0.10,
      managementFeeRate: config?.managementFeeRate ?? 0.01,
    });
  } catch (err) {
    next(err);
  }
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
      // console.error("Registration error:", error);
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
      const isHomestay = finalPayload.type && finalPayload.type.toLowerCase() === "homestay";

      const requiredFields = [
        "name",
        "description",
        "location",
        "type",
        "amenities",
        "frontImage",
        "otherImages",
        "reference",
        "mobileProvider",
        "bankName",
        "accountNumber",
        "accountName",
        "mobileNumber",
        "registerName",
        "contactPersonName",
        "contactPersonPhone",
      ];

      // Business documents are only required for non-homestay types
      if (!isHomestay) {
        requiredFields.push(
          "tinNumber",
          "businessLicenseNumber",
          "tinDocumentUrl",
          "businessLicenseDocumentUrl",
        );
      }

      const missingFields = requiredFields.filter(
        (field) => !finalPayload[field],
      );
      if (missingFields.length > 0) {
        return res.status(400).json({
          message: "Missing required fields",
          missingFields,
        });
      }

      // Validate document URLs for non-homestay types
      if (!isHomestay) {
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
        // Contact Person
        contactPersonName: finalPayload.contactPersonName,
        contactPersonPhone: finalPayload.contactPersonPhone,
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
        // House rules and Addons
        houseRules: finalPayload.houseRules,
        addons: finalPayload.addons || [],
        
        // Advanced Homestay & Checking Features
        checkInMethod: finalPayload.checkInMethod,
        checkInInstructions: finalPayload.checkInInstructions,
        digitalGuidebook: finalPayload.digitalGuidebook,

        // Homestay specifics
        ...(finalPayload.type && finalPayload.type.toLowerCase() === "homestay" && {
          hostBio: finalPayload.hostBio,
          languagesSpoken: finalPayload.languagesSpoken,
          interactionLevel: finalPayload.interactionLevel,
          neighborhoodGuide: finalPayload.neighborhoodGuide,
        }),
        // Metadata
        adminApproval: false,
        rejected: false,
        blocked: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        status: "pending", // pending approval
      };

      // Store in database
      const col = await mongo.getCollection("accomodations");
      const result = await col.insertOne(accommodationRecord);

      // Virtual Room integration for Homestays
      if (finalPayload.type && finalPayload.type.toLowerCase() === "homestay") {
        const roomsCol = await mongo.getCollection("rooms");
        await roomsCol.insertOne({
          roomName: finalPayload.spaceType || "Entire Home",
          accomodationReference: result.insertedId.toString(),
          description: `Exclusive use of the ${finalPayload.spaceType || "Entire Home"}.`,
          capacity: Number(finalPayload.maxGuests) || 1,
          price: Number(finalPayload.pricePerNight) || 0,
          cleaningFee: Number(finalPayload.cleaningFee) || 0,
          securityDeposit: Number(finalPayload.securityDeposit) || 0,
          amenities: finalPayload.amenities,
          otherImagesCount:
            finalPayload.otherImagesCount || finalPayload.otherImages.length,
          frontImage: finalPayload.frontImage,
          otherImages: finalPayload.otherImages,
          available: "Available",
          adminApproval: false,
          rejected: false,
          blocked: false,
          createdAt: new Date(),
        });
      }

      res.status(201).json({
        message: "Accommodation registered successfully",
        accommodationId: result.insertedId.toString(),
        reference: finalPayload.reference,
        status: "pending",
        adminApprovalRequired: true,
      });
    } catch (error) {
      // console.error("Accommodation registration error:", error);
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
                        status: {
                          $nin: [
                            "Cancelled",
                            "cancelled",
                            "Checked-Out",
                            "checked-out",
                          ],
                        },
                      },
                    },
                    {
                      $addFields: {
                        checkInDate: {
                          $cond: {
                            if: { $eq: [{ $type: "$checkIn" }, "date"] },
                            then: "$checkIn",
                            else: {
                              $dateFromString: {
                                dateString: { $toString: "$checkIn" },
                              },
                            },
                          },
                        },
                        checkOutDate: {
                          $cond: {
                            if: { $eq: [{ $type: "$checkOut" }, "date"] },
                            then: "$checkOut",
                            else: {
                              $dateFromString: {
                                dateString: { $toString: "$checkOut" },
                              },
                            },
                          },
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
                      in: { $setUnion: ["$$value", "$$this"] },
                    },
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

// Update accommodation coordinates
router.put(
  "/accomodation/coordinates",
  requireAuth,
  async (req, res, next) => {
    try {
      const { accommodationId, latitude, longitude } = req.body;
      if (!accommodationId || latitude == null || longitude == null) {
        return res
          .status(400)
          .json({ error: "accommodationId, latitude and longitude are required" });
      }

      const col = await mongo.getCollection("accomodations");
      const acc = await col.findOne({ _id: new ObjectId(accommodationId) });
      if (!acc) {
        return res.status(404).json({ error: "Accommodation not found" });
      }

      // Verify ownership
      if (acc.reference !== req.user.reference && req.user.role !== "admin") {
        return res.status(403).json({ error: "You do not own this accommodation" });
      }

      // Update coordinates — store both at top-level and inside location object
      const updateFields = {
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude),
      };

      // Also update inside the location object if it exists
      const locationUpdate = {};
      if (acc.location && typeof acc.location === "object") {
        locationUpdate["location.latitude"] = parseFloat(latitude);
        locationUpdate["location.longitude"] = parseFloat(longitude);
      }

      await col.updateOne(
        { _id: new ObjectId(accommodationId) },
        { $set: { ...updateFields, ...locationUpdate } }
      );

      res.status(200).json({
        status: "success",
        message: "Coordinates updated successfully",
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude),
      });
    } catch (err) {
      next(err);
    }
  },
);

// Update accommodation check-in/out times
router.put(
  "/accomodation/times",
  requireAuth,
  async (req, res, next) => {
    try {
      const { accommodationId, checkInTime, checkOutTime } = req.body;
      if (!accommodationId || !checkInTime || !checkOutTime) {
        return res
          .status(400)
          .json({ error: "accommodationId, checkInTime, and checkOutTime are required" });
      }

      const col = await mongo.getCollection("accomodations");
      const acc = await col.findOne({ _id: new ObjectId(accommodationId) });
      if (!acc) {
        return res.status(404).json({ error: "Accommodation not found" });
      }

      // Verify ownership
      if (acc.reference !== req.user.reference && req.user.role !== "admin") {
        return res.status(403).json({ error: "You do not own this accommodation" });
      }

      await col.updateOne(
        { _id: new ObjectId(accommodationId) },
        { $set: { checkInTime, checkOutTime } }
      );

      res.status(200).json({
        status: "success",
        message: "Times updated successfully",
        checkInTime,
        checkOutTime,
      });
    } catch (err) {
      next(err);
    }
  },
);

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
                  status: {
                    $nin: [
                      "Cancelled",
                      "cancelled",
                      "Checked-Out",
                      "checked-out",
                    ],
                  },
                },
              },
              {
                $addFields: {
                  checkInDate: {
                    $cond: {
                      if: { $eq: [{ $type: "$checkIn" }, "date"] },
                      then: "$checkIn",
                      else: {
                        $dateFromString: {
                          dateString: { $toString: "$checkIn" },
                        },
                      },
                    },
                  },
                  checkOutDate: {
                    $cond: {
                      if: { $eq: [{ $type: "$checkOut" }, "date"] },
                      then: "$checkOut",
                      else: {
                        $dateFromString: {
                          dateString: { $toString: "$checkOut" },
                        },
                      },
                    },
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
                in: { $setUnion: ["$$value", "$$this"] },
              },
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
    // console.log(
    //   "=== INCOMING MANAGEMENT BOOKING DATA ===",
    //   JSON.stringify(bookingData, null, 2),
    // );

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
        status: {
          $nin: ["Cancelled", "cancelled", "Checked-Out", "checked-out"],
        },
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
        error:
          "Booking conflict: The selected dates are already booked for this room",
      });
    }

    // Calculate platform fee info for management bookings — rate from system config
    const totalBookingAmount =
      (parseFloat(bookingData.roomPrice) || 0) *
      (parseInt(bookingData.nights) || 1);
    const configCol = await mongo.getCollection("system_config");
    const feeConfig = await configCol.findOne({ _id: "platform_fees" });
    
    let platformFeeRate = feeConfig?.managementFeeRate ?? 0.01; // default 1%
    
    // Check for accommodation-specific custom fee
    const accId = bookingData.accommodationId || bookingData.accomodationId;
    if (accId && feeConfig?.customRates && Array.isArray(feeConfig.customRates)) {
      const custom = feeConfig.customRates.find(c => c.accommodationId === accId);
      if (custom && typeof custom.managementFeeRate === 'number') {
        platformFeeRate = custom.managementFeeRate;
      }
    }

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
      source: bookingData.source || "Management",
      totalBookingAmount,
      platformFee,
      platformFeeRate,
      hostShare,
      walletAction: "debit",
      createdBy: req.user._id,
      creatorName: req.user.name,
      createdAt: new Date(),
    });

    // Debit accommodation wallet (1% platform fee for management bookings)
    if (bookingData.accomodationId && platformFee > 0) {
      try {
        const accCol = await mongo.getCollection("accomodations");
        await accCol.updateOne(
          { _id: new ObjectId(bookingData.accomodationId) },
          {
            $inc: {
              "wallet.debit": platformFee,
            },
          },
        );
        // Record transaction
        const txCol = await mongo.getCollection("wallet_transactions");
        await txCol.insertOne({
          accommodationId: bookingData.accomodationId,
          type: "booking_debit",
          description: `Front desk booking for ${bookingData.guestName || "Guest"}`,
          amount: platformFee,
          fee: platformFee,
          feeRate: platformFeeRate,
          grossAmount: totalBookingAmount,
          source: "Management",
          bookingId: newBooking.insertedId.toString(),
          guestName: bookingData.guestName || "",
          roomName: bookingData.roomName || "",
          createdAt: new Date(),
        });
      } catch (walletErr) {
        // console.warn("Wallet debit failed for management booking:", walletErr);
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
          actualCheckIn: new Date(),
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
          actualCheckOut: new Date(),
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

// ── Folio: Add Charge ──
router.post(
  "/booking/folio/charge",
  writeLimiter,
  requireAuth,
  async (req, res, next) => {
    try {
      const { bookingId, description, amount } = req.body;
      if (
        !bookingId ||
        !description ||
        typeof amount !== "number" ||
        amount <= 0
      ) {
        return res.status(400).json({
          error: "bookingId, description and a positive amount are required",
        });
      }

      const col = await mongo.getCollection("bookings");
      const query = ObjectId.isValid(bookingId)
        ? { _id: new ObjectId(bookingId) }
        : { bookingId: bookingId };

      const result = await col.updateOne(query, {
        $push: {
          "folio.charges": {
            description,
            amount,
            addedAt: new Date(),
          },
        },
        $set: { updatedAt: new Date() },
      });

      if (result.matchedCount === 0) {
        return res.status(404).json({ error: "Booking not found" });
      }

      res.json({ status: "success", message: "Charge added to folio" });
    } catch (err) {
      next(err);
    }
  },
);

// ── Folio: Add Payment ──
router.post(
  "/booking/folio/payment",
  writeLimiter,
  requireAuth,
  async (req, res, next) => {
    try {
      const { bookingId, method, amount } = req.body;
      if (!bookingId || !method || typeof amount !== "number" || amount <= 0) {
        return res.status(400).json({
          error: "bookingId, method and a positive amount are required",
        });
      }

      const col = await mongo.getCollection("bookings");
      const query = ObjectId.isValid(bookingId)
        ? { _id: new ObjectId(bookingId) }
        : { bookingId: bookingId };

      const result = await col.updateOne(query, {
        $push: {
          "folio.payments": {
            method,
            amount,
            addedAt: new Date(),
          },
        },
        $set: { updatedAt: new Date() },
      });

      if (result.matchedCount === 0) {
        return res.status(404).json({ error: "Booking not found" });
      }

      res.json({ status: "success", message: "Payment added to folio" });
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

        // Record withdrawal transaction
        try {
          const txCol = await mongo.getCollection("wallet_transactions");
          await txCol.insertOne({
            accommodationId: accommodationId,
            type: "withdrawal",
            description: `Withdrawal via ${payoutMethod || "unknown"}`,
            amount: amount,
            payoutMethod: payoutMethod || null,
            source: "Management",
            createdAt: new Date(),
          });
        } catch (txErr) {
          // console.warn("Failed to record withdrawal transaction:", txErr);
        }

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

// Pay debit (platform fees) using credit balance
router.post(
  "/wallet/pay-debit",
  writeLimiter,
  requireAuth,
  async (req, res, next) => {
    try {
      const { accommodationId, amount } = req.body;

      if (!accommodationId) {
        return res.status(400).json({ error: "accommodationId is required" });
      }
      if (typeof amount !== "number" || amount <= 0) {
        return res
          .status(400)
          .json({ error: "Amount must be a positive number" });
      }

      const accCol = await mongo.getCollection("accomodations");
      const query = ObjectId.isValid(accommodationId)
        ? { _id: new ObjectId(accommodationId) }
        : { reference: accommodationId };

      const result = await accCol.findOne(query, { wallet: 1 });
      if (!result) {
        return res.status(404).json({ error: "Accommodation not found" });
      }

      const wallet = result.wallet || { credit: 0, debit: 0, balance: 0 };
      const currentCredit = wallet.credit || 0;
      const currentDebit = wallet.debit || 0;

      if (currentCredit <= 0) {
        return res
          .status(400)
          .json({ error: "Insufficient credit balance to pay debit" });
      }

      if (currentDebit <= 0) {
        return res.status(400).json({ error: "No outstanding debit to pay" });
      }

      // The actual amount to transfer is the min of: requested amount, available credit, outstanding debit
      const transferAmount = Math.min(amount, currentCredit, currentDebit);

      const newCredit = currentCredit - transferAmount;
      const newDebit = currentDebit - transferAmount;
      const newBalance = Math.max((wallet.balance || 0) - transferAmount, 0);

      await accCol.updateOne(query, {
        $set: {
          "wallet.credit": newCredit,
          "wallet.debit": newDebit,
          "wallet.balance": newBalance,
        },
      });

      // Record debit payment transaction
      try {
        const txCol = await mongo.getCollection("wallet_transactions");
        await txCol.insertOne({
          accommodationId: accommodationId,
          type: "debit_payment",
          description: `Platform fee payment from credit`,
          amount: transferAmount,
          source: "Management",
          createdAt: new Date(),
        });
      } catch (txErr) {
        // console.warn("Failed to record debit payment transaction:", txErr);
      }

      return res.status(200).json({
        status: "success",
        message: `Successfully paid ${transferAmount} from credit towards debit`,
        transferred: transferAmount,
        wallet: {
          credit: newCredit,
          debit: newDebit,
          balance: newBalance,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// Get all wallet transactions for an accommodation
router.get("/wallet/all-transactions", requireAuth, async (req, res, next) => {
  try {
    const accommodationId = req.query.accommodationId;
    if (!accommodationId) {
      return res.status(400).json({ error: "accommodationId is required" });
    }

    const txCol = await mongo.getCollection("wallet_transactions");
    const transactions = await txCol
      .find({ accommodationId: String(accommodationId) })
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();

    return res.status(200).json({
      status: "success",
      transactions,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/analytics/summary", requireAuth, async (req, res, next) => {
  try {
    const accomodationsCol = await mongo.getCollection("accomodations");
    const bookingsCol = await mongo.getCollection("bookings");
    const managementCol = await mongo.getCollection("management");

    const accommodationId = req.query.accommodationId;
    const startDateRaw = req.query.startDate;
    const endDateRaw = req.query.endDate;

    const userRole =
      req.user && req.user.role ? req.user.role.toLowerCase() : "";
    const isOwner = userRole === "manager" || userRole === "owner";
    const userReference = isOwner ? req.user.reference : null;

    let accMatch = {};
    if (userReference) accMatch.reference = userReference;
    if (accommodationId) {
      if (ObjectId.isValid(accommodationId)) {
        accMatch._id = new ObjectId(accommodationId);
      } else {
        accMatch.id = accommodationId;
      }
    }

    const matchedAccs = await accomodationsCol
      .find(accMatch, { projection: { _id: 1, id: 1 } })
      .toArray();
    const strIds = matchedAccs.map((a) => a._id.toString());
    const objIds = matchedAccs.map((a) => a._id);
    const numIds = matchedAccs.map((a) => a.id).filter((id) => id != null);
    const numStrIds = numIds.map((id) => String(id));

    let bookingMatch =
      userReference || accommodationId
        ? {
          $or: [
            { accomodationId: { $in: [...strIds, ...numStrIds] } },
            { accommodationId: { $in: [...strIds, ...numStrIds] } },
            { accomodationId: { $in: objIds } },
            { accommodationId: { $in: objIds } },
            { accomodationId: { $in: numIds } },
            { accommodationId: { $in: numIds } },
          ],
        }
        : {};

    // If bounded logic resulted in no matched accs, zero-out bookings match
    if ((userReference || accommodationId) && matchedAccs.length === 0) {
      bookingMatch._id = "impossible_match";
    }

    // Date Filters
    let dateMatch = {};
    if (startDateRaw || endDateRaw) {
      dateMatch.createdAt = {};
      if (startDateRaw) dateMatch.createdAt.$gte = new Date(startDateRaw);
      if (endDateRaw) {
        const d = new Date(endDateRaw);
        d.setUTCHours(23, 59, 59, 999);
        dateMatch.createdAt.$lte = d;
      }
    }

    const totalAccommodations = await accomodationsCol.countDocuments(accMatch);
    const totalUsers = isOwner ? 0 : await managementCol.countDocuments({});

    const finalBookingMatch = { ...bookingMatch, ...dateMatch };
    const totalBookings = await bookingsCol.countDocuments(finalBookingMatch);
    const pendingApprovals = await accomodationsCol.countDocuments({
      ...accMatch,
      adminApproval: false,
    });

    const topRoomsAgg = await bookingsCol
      .aggregate([
        { $match: finalBookingMatch },
        {
          $group: {
            _id: "$roomName",
            count: { $sum: 1 },
          },
        },
        { $sort: { count: -1 } },
        { $limit: 8 },
      ])
      .toArray();

    const monthlyBookingsAgg = await bookingsCol
      .aggregate([
        { $match: { ...finalBookingMatch, createdAt: { $exists: true } } },
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

    // Calculate Financial Revenue Trend
    const monthlyRevenueAgg = await bookingsCol
      .aggregate([
        {
          $match: {
            ...finalBookingMatch,
            createdAt: { $exists: true },
            status: {
              $nin: ["cancelled", "Cancelled", "rejected", "Rejected"],
            },
          },
        },
        {
          $group: {
            _id: {
              year: { $year: "$createdAt" },
              month: { $month: "$createdAt" },
            },
            revenue: { $sum: { $toDouble: { $ifNull: ["$totalAmount", 0] } } },
          },
        },
        { $sort: { "_id.year": 1, "_id.month": 1 } },
        { $limit: 12 },
      ])
      .toArray();

    const topAccommodationsAgg = await bookingsCol
      .aggregate([
        { $match: finalBookingMatch },
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
        { $match: accMatch },
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

    // Fast-calc for Total Revenue and Cancellation Rate
    const performanceBookings = await bookingsCol
      .find(finalBookingMatch, {
        projection: {
          status: 1,
          totalAmount: 1,
          source: 1,
          checkIn: 1,
          checkOut: 1,
          from: 1,
          to: 1,
          nights: 1,
          createdAt: 1,
          paymentMethodUsed: 1,
          paymentMethod: 1,
        },
      })
      .toArray();
    let totalRevenueSum = 0;
    let failedCount = 0;
    let sourceOnline = 0;
    let sourceFrontDesk = 0;
    let totalNightsSold = 0;

    let totalLeadTimeDays = 0;
    let leadTimeBookingsCount = 0;
    let paymentMethodsCount = {};

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let checkInsToday = 0;
    let checkOutsToday = 0;
    let inHouse = 0;

    for (const b of performanceBookings) {
      const stat = String(b.status).toLowerCase();
      if (stat === "cancelled" || stat === "rejected") {
        failedCount++;
      } else {
        totalRevenueSum += Number(b.totalAmount) || 0;

        if (b.source && String(b.source).toLowerCase() === "management") {
          sourceFrontDesk++;
        } else {
          sourceOnline++;
        }

        let nights = Number(b.nights) || 0;
        if (nights === 0) {
          const cInStr = b.checkIn || b.from;
          const cOutStr = b.checkOut || b.to;
          if (cInStr && cOutStr) {
            const cIn = new Date(cInStr).getTime();
            const cOut = new Date(cOutStr).getTime();
            if (!isNaN(cIn) && !isNaN(cOut) && cOut > cIn) {
              nights = Math.max(
                1,
                Math.round((cOut - cIn) / (1000 * 3600 * 24)),
              );
            }
          }
        }
        if (nights < 1 && Object.keys(b).length > 2) nights = 1; // if fully formed booking
        totalNightsSold += nights;

        // Lead Time calculations
        const cInStr = b.checkIn || b.from;
        if (b.createdAt && cInStr) {
          const createdDate = new Date(b.createdAt).getTime();
          const cInDate = new Date(cInStr).getTime();
          if (!isNaN(createdDate) && !isNaN(cInDate) && cInDate > createdDate) {
            totalLeadTimeDays += (cInDate - createdDate) / (1000 * 3600 * 24);
            leadTimeBookingsCount++;
          }
        }

        // Payment Methods tracking
        const pm = b.paymentMethodUsed || b.paymentMethod || "Unknown";
        const standardPm = String(pm).trim().toLowerCase();
        let label = "Other";
        if (standardPm.includes("card") || standardPm.includes("stripe"))
          label = "Credit / Debit";
        else if (
          standardPm.includes("mobile") ||
          standardPm.includes("m-pesa") ||
          standardPm.includes("mpesa")
        )
          label = "Mobile Money";
        else if (standardPm.includes("cash")) label = "Cash";
        else if (standardPm.includes("bank")) label = "Bank Transfer";
        else if (standardPm !== "unknown") label = String(pm);

        paymentMethodsCount[label] = (paymentMethodsCount[label] || 0) + 1;

        // Operational Load calculations
        const cOutStr = b.checkOut || b.to;
        if (cInStr && cOutStr) {
          const cInDateObj = new Date(cInStr);
          const cOutDateObj = new Date(cOutStr);
          cInDateObj.setHours(0, 0, 0, 0);
          cOutDateObj.setHours(0, 0, 0, 0);

          if (cInDateObj.getTime() === today.getTime()) checkInsToday++;
          if (cOutDateObj.getTime() === today.getTime()) checkOutsToday++;
          if (
            cInDateObj.getTime() <= today.getTime() &&
            cOutDateObj.getTime() > today.getTime()
          ) {
            inHouse++;
          }
        }
      }
    }
    const validBookingsCount = performanceBookings.length - failedCount;
    const adr = totalNightsSold > 0 ? totalRevenueSum / totalNightsSold : 0;
    const alos =
      validBookingsCount > 0 ? totalNightsSold / validBookingsCount : 0;
    const cancellationRate =
      performanceBookings.length > 0
        ? ((failedCount / performanceBookings.length) * 100).toFixed(1)
        : 0;

    // Approximation of Occupancy. For actual occupancy you'd calculate against Room Count * Days in range
    // Assuming 'Occupancy' here means "Number of valid bookings mapped out of potential capacity proxy".
    // 1 booking per room per interval base:
    const baseInterval =
      startDateRaw && endDateRaw
        ? Math.max(
          1,
          (new Date(endDateRaw).getTime() -
            new Date(startDateRaw).getTime()) /
          (1000 * 3600 * 24),
        )
        : 30; // default proxy
    let occupancyRate =
      totalRooms > 0
        ? (
          ((performanceBookings.length - failedCount) /
            (totalRooms * (baseInterval / 3))) *
          100
        ).toFixed(1)
        : 0;
    if (Number(occupancyRate) > 100) occupancyRate = "100.0"; // clamp

    const revpar = Number(adr) * (Number(occupancyRate) / 100);
    const averageLeadTime =
      leadTimeBookingsCount > 0 ? totalLeadTimeDays / leadTimeBookingsCount : 0;

    // Format payment methods for chart
    const paymentMethodsArr = Object.keys(paymentMethodsCount)
      .map((k) => ({ label: k, count: paymentMethodsCount[k] }))
      .sort((a, b) => b.count - a.count);

    res.json({
      status: "success",
      totalAccommodations,
      totalRooms,
      totalBookings,
      totalUsers,
      totalRevenue: totalRevenueSum,
      cancellationRate: Number(cancellationRate),
      occupancyRate: Number(occupancyRate),
      adr: Number(adr),
      alos: Number(alos),
      revpar: Number(revpar),
      leadTime: Number(averageLeadTime),
      operationLoad: {
        checkInsToday,
        checkOutsToday,
        inHouse,
      },
      paymentMethods: paymentMethodsArr,
      sourceOnline,
      sourceFrontDesk,
      pendingApprovals,
      topRooms: topRoomsAgg.map((item) => ({
        name: item._id || "Unknown Room",
        count: item.count,
      })),
      monthlyBookings: monthlyBookingsAgg.map((item) => ({
        label: `${item._id.month}/${item._id.year}`,
        count: item.count,
      })),
      monthlyRevenue: monthlyRevenueAgg.map((item) => ({
        label: `${item._id.month}/${item._id.year}`,
        revenue: item.revenue,
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

router.get("/analytics/advanced", requireAuth, async (req, res, next) => {
  try {
    const analyticsCol = await mongo.getCollection("site_analytics");
    const bookingsCol = await mongo.getCollection("bookings");
    const accomodationsCol = await mongo.getCollection("accomodations");

    const accommodationId = req.query.accommodationId;
    const startDateRaw = req.query.startDate;
    const endDateRaw = req.query.endDate;

    const userRole = req.user && req.user.role ? req.user.role.toLowerCase() : "";
    const isOwner = userRole === "manager" || userRole === "owner";
    const userReference = isOwner ? req.user.reference : null;

    let dateMatch = {};
    if (startDateRaw || endDateRaw) {
      dateMatch.createdAt = {};
      if (startDateRaw) dateMatch.createdAt.$gte = new Date(startDateRaw);
      if (endDateRaw) {
        const d = new Date(endDateRaw);
        d.setUTCHours(23, 59, 59, 999);
        dateMatch.createdAt.$lte = d;
      }
    }

    let matchQuery = { ...dateMatch };

    if (accommodationId) {
      const { ObjectId } = require("mongodb");
      if (ObjectId.isValid(accommodationId)) {
        matchQuery["eventMeta.propertyId"] = { $in: [accommodationId, new ObjectId(accommodationId), String(accommodationId)] };
      } else {
        matchQuery["eventMeta.propertyId"] = String(accommodationId);
      }
    } else if (userReference) {
      const matchedAccs = await accomodationsCol.find({ reference: userReference }, { projection: { _id: 1, id: 1 } }).toArray();
      const validAccIds = matchedAccs.map(a => a._id.toString()).concat(matchedAccs.map(a => a.id).filter(id => id != null).map(String));
      
      if (validAccIds.length > 0) {
        matchQuery["eventMeta.propertyId"] = { $in: validAccIds };
      } else {
        matchQuery["eventMeta.propertyId"] = "impossible_match";
      }
    }

    const events = await analyticsCol.find(matchQuery).toArray();

    let totalPageViews = 0;
    let totalSearches = 0;
    let totalPropertyViews = 0;

    const deviceTypes = { mobile: 0, desktop: 0, tablet: 0 };
    const browsers = {};
    const sources = {};
    const countries = {};
    const cities = {};
    
    const mapClusters = {};

    events.forEach(e => {
        if (e.eventType === 'pageview') totalPageViews++;
        else if (e.eventType === 'search') totalSearches++;
        else if (e.eventType === 'view_property') totalPropertyViews++;

        if (e.device && e.device.deviceType) {
            deviceTypes[e.device.deviceType] = (deviceTypes[e.device.deviceType] || 0) + 1;
        }
        if (e.device && e.device.browser) {
            browsers[e.device.browser] = (browsers[e.device.browser] || 0) + 1;
        }

        const rawSource = e.utmSource || e.referrer || 'Direct';
        let cleanSource = rawSource;
        if (rawSource.startsWith('http')) {
            try { cleanSource = new URL(rawSource).hostname } catch(err){}
        }
        // Normalize
        if (cleanSource === 'Direct' || cleanSource === '') cleanSource = 'Direct';
        if (cleanSource.includes('google')) cleanSource = 'Google';
        if (cleanSource.includes('facebook')) cleanSource = 'Facebook';
        if (cleanSource.includes('instagram')) cleanSource = 'Instagram';
        
        sources[cleanSource] = (sources[cleanSource] || 0) + 1;

        if (e.geo) {
            if (e.geo.country) countries[e.geo.country] = (countries[e.geo.country] || 0) + 1;
            if (e.geo.city) cities[e.geo.city] = (cities[e.geo.city] || 0) + 1;
            if (e.geo.ll && e.geo.ll.length === 2) {
                const key = `${e.geo.ll[0].toFixed(2)},${e.geo.ll[1].toFixed(2)}`; // cluster nearby
                if (!mapClusters[key]) {
                    mapClusters[key] = { lat: e.geo.ll[0], lng: e.geo.ll[1], count: 0, city: e.geo.city, country: e.geo.country };
                }
                mapClusters[key].count++;
            }
        }
    });

    // Bookings count for the funnel
    let bookingMatch = { ...dateMatch };
    if (accommodationId) {
        const { ObjectId } = require("mongodb");
        if (ObjectId.isValid(accommodationId)) {
            bookingMatch.accomodationId = { $in: [accommodationId, new ObjectId(accommodationId)] };
        } else {
            bookingMatch.accomodationId = accommodationId;
        }
    }
    const totalBookings = await bookingsCol.countDocuments(bookingMatch);

    res.json({
        status: "success",
        funnel: {
            pageViews: totalPageViews,
            searches: totalSearches,
            propertyViews: totalPropertyViews,
            bookings: totalBookings
        },
        devices: deviceTypes,
        browsers: Object.keys(browsers).map(k => ({ label: k, count: browsers[k] })).sort((a,b)=>b.count - a.count).slice(0, 5),
        sources: Object.keys(sources).map(k => ({ label: k, count: sources[k] })).sort((a,b)=>b.count - a.count).slice(0, 10),
        locations: {
            countries: Object.keys(countries).map(k => ({ label: k, count: countries[k] })).sort((a,b)=>b.count - a.count).slice(0, 10),
            cities: Object.keys(cities).map(k => ({ label: k, count: cities[k] })).sort((a,b)=>b.count - a.count).slice(0, 10)
        },
        mapData: Object.values(mapClusters)
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

      // Owner protections
      if (user.owner) {
        // Owner accounts can only be edited by the owner themselves
        if (req.user.id !== user._id.toString() && req.user.id !== user.id?.toString()) {
          return res.status(403).json({ error: "Owner account can only be edited by the owner themselves." });
        }
        // Owner accounts cannot be blocked
        if (typeof blocked !== "undefined" && blocked !== user.blocked) {
          return res.status(403).json({ error: "Owner account cannot be blocked." });
        }
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
      // console.error("Error in PUT /newUser/:id:", err);
      next(err);
    }
  },
);

// DELETE /management/newUser/:id
router.delete(
  "/newUser/:id",
  requireAuth,
  requireRole("manager"),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const col = await mongo.getCollection("management");

      let query = {};
      if (ObjectId.isValid(id)) {
        query = { _id: new ObjectId(id) };
      } else {
        query = { id: parseInt(id) };
      }

      const user = await col.findOne(query);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      if (user.owner) {
        return res.status(403).json({ error: "Owner account cannot be deleted." });
      }

      await col.deleteOne(query);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }
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
      return res.status(403).json({
        error: "Your account has been suspended. Please contact support.",
      });

    const ok = await bcrypt.compare(password, admin.passwordHash);
    if (!ok)
      return res
        .status(401)
        .json({ error: "The email or password you entered is incorrect." });
    if (admin.preferences?.twoFactorEnabled) {
      // ── 2FA is Enabled ──
      const otp = generateOTP()
      const otpCol = await mongo.getCollection("otp_store")
      await otpCol.deleteMany({ userId: admin._id.toString(), type: "2fa_login_manager" })
      await otpCol.insertOne({
        userId: admin._id.toString(),
        type: "2fa_login_manager",
        otp,
        expiresAt: new Date(Date.now() + 10 * 60000), // 10 mins
        attempts: 0
      })

      // Send OTP via email or SMS (prefer email if available, else SMS)
      if (admin.email) {
        axios.post(`${EMAIL_API}/api/email/otp`, {
          to: admin.email,
          name: admin.username || admin.fullName || "Manager",
          otp
        }, { timeout: 5000 }).catch(e => console.warn("Manager 2FA email failed:", e.message))
      } else if (admin.phone) {
        axios.post(`${SMS_API}/api/sms/send`, {
          phone: admin.phone,
          message: `Your ReM360 Management login code is ${otp}. Valid for 10 minutes.`
        }, { timeout: 5000 }).catch(e => console.warn("Manager 2FA SMS failed:", e.message))
      }

      return res.json({
        status: "2fa_required",
        message: "Two-Factor Authentication required. We have sent an OTP to your email/phone.",
        identifier: admin.email || admin.phone
      })
    }

    const token = sign({
      email: admin.email,
      id: admin._id ? admin._id.toString() : admin.id,
      role: admin.role || "manager",
      reference: admin.owner ? admin._id.toString() : admin.reference,
    });
    const { passwordHash, ...safe } = admin;
    res.json({
      status: "success",
      token,
      user: { ...safe },
    });
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════
// POST /management/login-verify
// Verify 2FA OTP for management login
// ══════════════════════════════════════
router.post("/login-verify", async (req, res, next) => {
  try {
    const { identifier, otp } = req.body;
    if (!identifier || !otp) {
      return res.status(400).json({ error: "Identifier and OTP are required." });
    }

    const col = await mongo.getCollection("management");
    const admin = await col.findOne({ email: identifier });

    if (!admin) return res.status(404).json({ error: "User not found." });

    const otpCol = await mongo.getCollection("otp_store");
    const stored = await otpCol.findOne({ userId: admin._id.toString(), type: "2fa_login_manager" });

    if (!stored) {
      return res.status(404).json({ error: "No 2FA OTP found. Please try logging in again." });
    }

    if (new Date() > stored.expiresAt) {
      await otpCol.deleteOne({ _id: stored._id });
      return res.status(410).json({ error: "OTP has expired. Please try logging in again." });
    }

    if (stored.attempts >= 5) {
      await otpCol.deleteOne({ _id: stored._id });
      return res.status(429).json({ error: "Too many failed attempts. Please try logging in again." });
    }

    if (stored.otp !== otp.trim()) {
      await otpCol.updateOne({ _id: stored._id }, { $inc: { attempts: 1 } });
      return res.status(401).json({
        error: "Invalid OTP.",
        attemptsRemaining: 5 - (stored.attempts + 1),
      });
    }

    // Success!
    await otpCol.deleteOne({ _id: stored._id });

    const token = sign({
      email: admin.email,
      id: admin._id ? admin._id.toString() : admin.id,
      role: admin.role || "manager",
      reference: admin.owner ? admin._id.toString() : admin.reference,
    });
    const { passwordHash, ...safe } = admin;
    res.json({
      status: "success",
      token,
      user: { ...safe },
    });
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════
// POST /management/forgot-password
// Send OTP for password reset
// ══════════════════════════════════════
router.post("/forgot-password", async (req, res, next) => {
  try {
    const { identifier } = req.body;

    if (!identifier) {
      return res.status(400).json({ error: "Email or phone number is required." });
    }

    const col = await mongo.getCollection("management");
    const trimmed = identifier.trim().toLowerCase();

    let user = null;
    let resetType = null;

    if (trimmed.includes("@")) {
      user = await col.findOne({ email: trimmed });
      resetType = "email";
    } else {
      const formattedPhone = formatPhone(trimmed);
      if (formattedPhone) {
        user = await col.findOne({ phone: formattedPhone });
      }
      if (!user) {
        user = await col.findOne({ phone: trimmed });
      }
      resetType = "phone";
    }

    if (!user) {
      return res.json({ status: "success", message: "If an account exists, an OTP has been sent.", type: resetType });
    }

    const otp = generateOTP();

    if (resetType === "email" && user.email) {
      const otpCol = await mongo.getCollection("otp_store");
      await otpCol.deleteMany({ userId: user._id.toString(), type: "management_password_reset" });
      await otpCol.insertOne({
        userId: user._id.toString(),
        type: "management_password_reset",
        otp,
        identifier: user.email,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
        attempts: 0,
        createdAt: new Date(),
      });

      axios.post(`${EMAIL_API}/api/email/password-reset`, {
        to: user.email,
        name: user.name,
        resetCode: otp,
      }, { timeout: 10000 }).catch(err => {
        console.warn("Password reset email failed:", err.message);
      });

      res.json({
        status: "success",
        message: "Password reset OTP sent to your email.",
        type: "email",
      });

    } else if (resetType === "phone" && user.phone) {
      const otpCol = await mongo.getCollection("otp_store");
      await otpCol.deleteMany({ userId: user._id.toString(), type: "management_password_reset" });
      await otpCol.insertOne({
        userId: user._id.toString(),
        type: "management_password_reset",
        otp,
        identifier: user.phone,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        attempts: 0,
        createdAt: new Date(),
      });

      axios.post(`${SMS_API}/api/sms/send`, {
        phone: user.phone,
        message: `Your ReM360 Management password reset code is: ${otp}. This code expires in 10 minutes.`,
      }, { timeout: 10000 }).catch(err => {
        console.warn("Password reset SMS failed:", err.message);
      });

      res.json({
        status: "success",
        message: "Password reset OTP sent to your phone.",
        type: "phone",
      });
    } else {
      res.json({ status: "success", message: "If an account exists, an OTP has been sent.", type: resetType });
    }
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════
// POST /management/reset-password
// Verify OTP and set new password
// ══════════════════════════════════════
router.post("/reset-password", async (req, res, next) => {
  try {
    const { identifier, otp, newPassword } = req.body;

    if (!identifier || !otp || !newPassword) {
      return res.status(400).json({ error: "Identifier, OTP, and new password are required." });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: "New password must be at least 6 characters." });
    }

    const col = await mongo.getCollection("management");
    const trimmed = identifier.trim().toLowerCase();

    let user = null;
    if (trimmed.includes("@")) {
      user = await col.findOne({ email: trimmed });
    } else {
      const formattedPhone = formatPhone(trimmed);
      if (formattedPhone) {
        user = await col.findOne({ phone: formattedPhone });
      }
      if (!user) {
        user = await col.findOne({ phone: trimmed });
      }
    }

    if (!user) {
      return res.status(404).json({ error: "Account not found." });
    }

    const otpCol = await mongo.getCollection("otp_store");
    const stored = await otpCol.findOne({ userId: user._id.toString(), type: "management_password_reset" });

    if (!stored) {
      return res.status(404).json({ error: "No reset OTP found. Please request a new one." });
    }

    if (new Date() > stored.expiresAt) {
      await otpCol.deleteOne({ _id: stored._id });
      return res.status(410).json({ error: "OTP has expired. Please request a new one." });
    }

    if (stored.attempts >= 5) {
      await otpCol.deleteOne({ _id: stored._id });
      return res.status(429).json({ error: "Too many failed attempts. Please request a new OTP." });
    }

    if (stored.otp !== otp.trim()) {
      await otpCol.updateOne({ _id: stored._id }, { $inc: { attempts: 1 } });
      return res.status(401).json({
        error: "Invalid OTP.",
        attemptsRemaining: 5 - (stored.attempts + 1),
      });
    }

    await otpCol.deleteOne({ _id: stored._id });
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(newPassword, salt);

    await col.updateOne(
      { _id: user._id },
      { $set: { passwordHash, updatedAt: new Date() } }
    );

    res.json({ status: "success", message: "Password reset successfully. You can now login." });
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
      return res.status(403).json({
        error: "Your account has been suspended. Please contact support.",
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

      const externalBlocksCol = await mongo.getCollection("external_blocks");
      const overlappingBlocks = await externalBlocksCol
        .find({
          roomId: roomId,
          checkIn: { $lt: new Date(checkOut) },
          checkOut: { $gt: new Date(checkIn) },
        })
        .toArray();

      const available = overlappingBookings.length === 0 && overlappingBlocks.length === 0;
      res.json({ available });
    } catch (error) {
      // console.error("Error checking availability:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ──────── Change Front Image (Manager) ────────

// Swap accommodation front image with one of the other images
router.post(
  "/accomodation/change-front-image",
  requireAuth,
  async (req, res, next) => {
    try {
      const { accommodationId, newFrontImage } = req.body;

      if (!accommodationId || !newFrontImage) {
        return res.status(400).json({ error: "accommodationId and newFrontImage are required" });
      }

      const col = await mongo.getCollection("accomodations");
      const acc = await col.findOne({ _id: new ObjectId(accommodationId) });
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
        { _id: new ObjectId(accommodationId) },
        { $set: { frontImage: newFrontImage, otherImages } }
      );

      res.status(200).json({
        status: "success",
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
  "/room/change-front-image",
  requireAuth,
  async (req, res, next) => {
    try {
      const { roomId, newFrontImage } = req.body;

      if (!roomId || !newFrontImage) {
        return res.status(400).json({ error: "roomId and newFrontImage are required" });
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
        status: "success",
        message: "Room front image updated successfully",
        frontImage: newFrontImage,
        otherImages,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ══════════════════════════════════════
// PUT /management/profile
// Update manager profile (preferences, etc)
// ══════════════════════════════════════
router.put("/profile", requireAuth, async (req, res, next) => {
  try {
    const { preferences } = req.body;
    const col = await mongo.getCollection("management");
    
    const updateDoc = { $set: { updatedAt: new Date() } };
    if (preferences) updateDoc.$set.preferences = preferences;

    await col.updateOne(
      { _id: new ObjectId(req.user.id) },
      updateDoc
    );

    const user = await col.findOne({ _id: new ObjectId(req.user.id) });
    const { passwordHash, ...safeUser } = user;

    res.json({ status: "success", user: { ...safeUser, id: safeUser._id.toString() } });
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════
// POST /management/avatar
// Upload manager profile avatar
// ══════════════════════════════════════
router.post("/avatar", requireAuth, upload.single("avatar"), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image file provided." });
    }

    const avatarUrl = `/uploads/images/${req.file.filename}`;
    const col = await mongo.getCollection("management");

    await col.updateOne(
      { _id: new ObjectId(req.user.id) },
      { $set: { avatarUrl, updatedAt: new Date() } }
    );

    res.json({ status: "success", avatarUrl });
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════════════════════════════
// PHOTO MANAGEMENT & CONTENT EDITING (Manager Self-Service)
// ══════════════════════════════════════════════════════════════

// ──────── Upload Photos (Accommodation) → pendingImages (requires admin approval) ────────
router.post(
  "/accomodation/:id/upload-photos",
  requireAuth,
  upload.array("images", 10),
  async (req, res, next) => {
    try {
      const accId = req.params.id;
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: "No images provided" });
      }

      const col = await mongo.getCollection("accomodations");
      const acc = await col.findOne({ _id: new ObjectId(accId) });
      if (!acc) return res.status(404).json({ error: "Accommodation not found" });

      const pendingEntries = req.files.map((file) => ({
        url: getLocalImageUrl(file.filename),
        originalName: file.originalname,
        uploadedAt: new Date(),
        uploadedBy: req.user?.email || req.user?.name || "manager",
      }));

      await col.updateOne(
        { _id: new ObjectId(accId) },
        { $push: { pendingImages: { $each: pendingEntries } } }
      );

      res.status(201).json({
        status: "success",
        message: `${pendingEntries.length} photo(s) uploaded and awaiting admin approval`,
        pendingImages: pendingEntries,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ──────── Upload Photos (Room) → pendingImages (requires admin approval) ────────
router.post(
  "/room/:id/upload-photos",
  requireAuth,
  upload.array("images", 10),
  async (req, res, next) => {
    try {
      const roomId = req.params.id;
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: "No images provided" });
      }

      const col = await mongo.getCollection("rooms");
      const room = await col.findOne({ _id: new ObjectId(roomId) });
      if (!room) return res.status(404).json({ error: "Room not found" });

      const pendingEntries = req.files.map((file) => ({
        url: getLocalImageUrl(file.filename),
        originalName: file.originalname,
        uploadedAt: new Date(),
        uploadedBy: req.user?.email || req.user?.name || "manager",
      }));

      await col.updateOne(
        { _id: new ObjectId(roomId) },
        { $push: { pendingImages: { $each: pendingEntries } } }
      );

      res.status(201).json({
        status: "success",
        message: `${pendingEntries.length} photo(s) uploaded and awaiting admin approval`,
        pendingImages: pendingEntries,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ──────── Delete Photo (Accommodation) — No admin approval needed ────────
router.delete(
  "/accomodation/:id/delete-photo",
  requireAuth,
  async (req, res, next) => {
    try {
      const accId = req.params.id;
      const { imageUrl } = req.body;
      if (!imageUrl) return res.status(400).json({ error: "imageUrl is required" });

      const col = await mongo.getCollection("accomodations");
      const acc = await col.findOne({ _id: new ObjectId(accId) });
      if (!acc) return res.status(404).json({ error: "Accommodation not found" });

      const updateFields = {};
      let otherImages = Array.isArray(acc.otherImages) ? [...acc.otherImages] : [];

      if (acc.frontImage === imageUrl) {
        // Deleting front image → promote first otherImage
        updateFields.frontImage = otherImages.length > 0 ? otherImages.shift() : null;
        updateFields.otherImages = otherImages;
      } else {
        const idx = otherImages.indexOf(imageUrl);
        if (idx === -1) return res.status(404).json({ error: "Image not found in accommodation photos" });
        otherImages.splice(idx, 1);
        updateFields.otherImages = otherImages;
      }

      await col.updateOne({ _id: new ObjectId(accId) }, { $set: updateFields });

      // Try deleting the file from disk
      try {
        const filename = imageUrl.split("/").pop();
        const filePath = path.join(__dirname, "../../public/uploads/images", filename);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (e) {
        console.warn("Could not delete file from disk:", e.message);
      }

      res.json({
        status: "success",
        message: "Photo deleted successfully",
        frontImage: updateFields.frontImage !== undefined ? updateFields.frontImage : acc.frontImage,
        otherImages: updateFields.otherImages || otherImages,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ──────── Delete Photo (Room) — No admin approval needed ────────
router.delete(
  "/room/:id/delete-photo",
  requireAuth,
  async (req, res, next) => {
    try {
      const roomId = req.params.id;
      const { imageUrl } = req.body;
      if (!imageUrl) return res.status(400).json({ error: "imageUrl is required" });

      const col = await mongo.getCollection("rooms");
      const room = await col.findOne({ _id: new ObjectId(roomId) });
      if (!room) return res.status(404).json({ error: "Room not found" });

      const updateFields = {};
      let otherImages = Array.isArray(room.otherImages) ? [...room.otherImages] : [];

      if (room.frontImage === imageUrl) {
        updateFields.frontImage = otherImages.length > 0 ? otherImages.shift() : null;
        updateFields.otherImages = otherImages;
      } else {
        const idx = otherImages.indexOf(imageUrl);
        if (idx === -1) return res.status(404).json({ error: "Image not found in room photos" });
        otherImages.splice(idx, 1);
        updateFields.otherImages = otherImages;
      }

      await col.updateOne({ _id: new ObjectId(roomId) }, { $set: updateFields });

      // Try deleting the file from disk
      try {
        const filename = imageUrl.split("/").pop();
        const filePath = path.join(__dirname, "../../public/uploads/images", filename);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (e) {
        console.warn("Could not delete file from disk:", e.message);
      }

      res.json({
        status: "success",
        message: "Photo deleted successfully",
        frontImage: updateFields.frontImage !== undefined ? updateFields.frontImage : room.frontImage,
        otherImages: updateFields.otherImages || otherImages,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ──────── Edit Accommodation Details — No admin approval needed ────────
router.put(
  "/accomodation/:id/edit-details",
  requireAuth,
  async (req, res, next) => {
    try {
      if (req.user.role !== "manager") {
        return res.status(403).json({ error: "Only managers can edit accommodation details." });
      }
      const accId = req.params.id;
      const { name, description, amenities, contactPersonName, contactPersonPhone } = req.body;

      const col = await mongo.getCollection("accomodations");
      const acc = await col.findOne({ _id: new ObjectId(accId) });
      if (!acc) return res.status(404).json({ error: "Accommodation not found" });

      const updateFields = { updatedAt: new Date() };
      if (name !== undefined && name.trim()) updateFields.name = name.trim();
      if (description !== undefined) updateFields.description = description;
      if (amenities !== undefined && Array.isArray(amenities)) updateFields.amenities = amenities;
      if (contactPersonName !== undefined) updateFields.contactPersonName = contactPersonName.trim();
      if (contactPersonPhone !== undefined) updateFields.contactPersonPhone = contactPersonPhone.trim();

      await col.updateOne({ _id: new ObjectId(accId) }, { $set: updateFields });

      const updated = await col.findOne({ _id: new ObjectId(accId) });
      res.json({
        status: "success",
        message: "Accommodation details updated successfully",
        accommodation: updated,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ──────── Edit Room Details — No admin approval needed ────────
router.put(
  "/room/:id/edit-details",
  requireAuth,
  async (req, res, next) => {
    try {
      if (req.user.role !== "manager") {
        return res.status(403).json({ error: "Only managers can edit room details." });
      }
      const roomId = req.params.id;
      const { roomName, description, amenities, capacity, tieredPrices } = req.body;

      const col = await mongo.getCollection("rooms");
      const room = await col.findOne({ _id: new ObjectId(roomId) });
      if (!room) return res.status(404).json({ error: "Room not found" });

      const updateFields = { updatedAt: new Date() };
      if (roomName !== undefined && roomName.trim()) updateFields.roomName = roomName.trim();
      if (description !== undefined) updateFields.description = description;
      if (amenities !== undefined && Array.isArray(amenities)) updateFields.amenities = amenities;
      if (capacity !== undefined) updateFields.capacity = parseInt(capacity) || 0;
      if (tieredPrices !== undefined) updateFields.tieredPrices = tieredPrices;

      await col.updateOne({ _id: new ObjectId(roomId) }, { $set: updateFields });

      const updated = await col.findOne({ _id: new ObjectId(roomId) });
      res.json({
        status: "success",
        message: "Room details updated successfully",
        room: updated,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ══════════════════════════════════════════════════════════════
// PROMO CODES
// ══════════════════════════════════════════════════════════════
router.get("/promo-codes", requireAuth, async (req, res, next) => {
  try {
    const col = await mongo.getCollection("promo_codes");
    let filter = {};
    if (req.user.role !== "Admin") {
       filter = { createdBy: req.user.email };
    }
    const codes = await col.find(filter).sort({ createdAt: -1 }).toArray();
    res.json({ status: "success", promoCodes: codes });
  } catch (err) {
    next(err);
  }
});

router.post("/promo-codes", writeLimiter, requireAuth, async (req, res, next) => {
  try {
    const { code, discountType, discountValue, validFrom, validTo, maxUses, accommodationId } = req.body;
    if (!code || !discountType || !discountValue) {
      return res.status(400).json({ error: "Code, discount type, and value are required" });
    }
    
    const col = await mongo.getCollection("promo_codes");
    const existing = await col.findOne({ code: code.toUpperCase() });
    if (existing) {
      return res.status(409).json({ error: "Promo code already exists" });
    }

    const doc = {
      code: code.toUpperCase(),
      discountType, // 'percentage' or 'fixed'
      discountValue: Number(discountValue),
      validFrom: validFrom ? new Date(validFrom) : new Date(),
      validTo: validTo ? new Date(validTo) : null,
      maxUses: maxUses ? Number(maxUses) : null,
      usedCount: 0,
      accommodationId: accommodationId || null,
      status: "active",
      createdBy: req.user.email,
      createdAt: new Date()
    };

    await col.insertOne(doc);
    res.status(201).json({ status: "success", promoCode: doc });
  } catch (err) {
    next(err);
  }
});

router.put("/promo-codes/:id/status", requireAuth, async (req, res, next) => {
  try {
    const { status } = req.body;
    const col = await mongo.getCollection("promo_codes");
    await col.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status, updatedAt: new Date() } });
    res.json({ status: "success", message: "Status updated" });
  } catch (err) {
    next(err);
  }
});

router.delete("/promo-codes/:id", requireAuth, async (req, res, next) => {
  try {
    const col = await mongo.getCollection("promo_codes");
    await col.deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ status: "success", message: "Promo code deleted" });
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════════════════════════════
// HOUSEKEEPING
// ══════════════════════════════════════════════════════════════
router.get("/housekeeping", requireAuth, async (req, res, next) => {
  try {
    const { accommodationId } = req.query;
    let matchQuery = {};
    if (accommodationId) {
      matchQuery.accomodationReference = accommodationId;
    }
    const col = await mongo.getCollection("rooms");
    const rooms = await col.find(matchQuery).toArray();
    
    const bookingsCol = await mongo.getCollection("bookings");
    const today = new Date();
    today.setHours(0,0,0,0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const activeBookings = await bookingsCol.find({
      roomId: { $in: rooms.map(r => r._id.toString()) },
      status: { $nin: ["Cancelled", "cancelled"] }
    }).toArray();

    const enrichedRooms = rooms.map(room => {
      const roomBookings = activeBookings.filter(b => b.roomId === room._id.toString());
      
      const checkInToday = roomBookings.find(b => {
        const ci = new Date(b.checkIn);
        return ci >= today && ci < tomorrow;
      });
      
      const checkOutToday = roomBookings.find(b => {
        const co = new Date(b.checkOut);
        return co >= today && co < tomorrow;
      });

      const currentlyOccupied = roomBookings.find(b => {
        const ci = new Date(b.checkIn);
        const co = new Date(b.checkOut);
        const now = new Date();
        return ci <= now && co >= now && b.status !== 'Checked-Out';
      });

      return {
        ...room,
        housekeepingStatus: room.housekeepingStatus || 'Clean',
        checkInToday: !!checkInToday,
        checkOutToday: !!checkOutToday,
        isOccupied: !!currentlyOccupied,
        currentBooking: currentlyOccupied || checkInToday || null
      };
    });

    res.json({ status: "success", rooms: enrichedRooms });
  } catch (err) {
    next(err);
  }
});

router.put("/housekeeping/:id", requireAuth, async (req, res, next) => {
  try {
    const { status } = req.body;
    const validStatuses = ['Clean', 'Dirty', 'Cleaning in Progress', 'Maintenance'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }
    const col = await mongo.getCollection("rooms");
    await col.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { housekeepingStatus: status, housekeepingUpdatedAt: new Date() } });
    res.json({ status: "success", message: "Status updated" });
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════════════════════════════
// EXTERNAL BOOKING BLOCKS  (indicator only – no revenue impact)
// ══════════════════════════════════════════════════════════════

// GET all blocks for an accommodation
router.get("/accomodation/:id/external-blocks", requireAuth, async (req, res, next) => {
  try {
    const col = await mongo.getCollection("external_blocks");
    const blocks = await col.find({ accommodationId: req.params.id }).toArray();
    res.json({ status: "success", blocks });
  } catch (err) { next(err); }
});

// POST create a block for a specific room
router.post("/room/:roomId/external-block", requireAuth, async (req, res, next) => {
  try {
    const { checkIn, checkOut, label, accommodationId } = req.body;
    if (!checkIn || !checkOut) return res.status(400).json({ error: "checkIn and checkOut are required" });
    if (new Date(checkIn) >= new Date(checkOut)) return res.status(400).json({ error: "checkIn must be before checkOut" });
    const col = await mongo.getCollection("external_blocks");
    const result = await col.insertOne({
      roomId: req.params.roomId,
      accommodationId: accommodationId || null,
      checkIn: new Date(checkIn),
      checkOut: new Date(checkOut),
      label: (label || "External Booking").toString().trim().slice(0, 80),
      isExternal: true,
      createdAt: new Date(),
    });
    res.json({ status: "success", blockId: result.insertedId });
  } catch (err) { next(err); }
});

// DELETE remove a block by its id
router.delete("/external-block/:blockId", requireAuth, async (req, res, next) => {
  try {
    const col = await mongo.getCollection("external_blocks");
    await col.deleteOne({ _id: new ObjectId(req.params.blockId) });
    res.json({ status: "success", message: "Block removed" });
  } catch (err) { next(err); }
});

router.use("/chat", require("./chat"));

module.exports = router;

