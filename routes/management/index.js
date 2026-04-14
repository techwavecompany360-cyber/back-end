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
        // Homestay specifics
        ...(finalPayload.type && finalPayload.type.toLowerCase() === "homestay" && {
          hostBio: finalPayload.hostBio,
          languagesSpoken: finalPayload.languagesSpoken,
          houseRules: finalPayload.houseRules,
          interactionLevel: finalPayload.interactionLevel,
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
      const col = await mongo.getCollection("accommodations");
      const result = await col.insertOne(accommodationRecord);

      // Virtual Room integration for Homestays
      if (finalPayload.type && finalPayload.type.toLowerCase() === "homestay") {
        const roomsCol = await mongo.getCollection("rooms");
        await roomsCol.insertOne({
          roomName: "Entire Home",
          accomodationReference: result.insertedId.toString(),
          description: "Exclusive use of the entire homestay.",
          capacity: Number(finalPayload.maxGuests) || 1,
          price: Number(finalPayload.pricePerNight) || 0,
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

    if (overlappingBookings.length > 0) {
      return res.status(409).json({
        error:
          "Booking conflict: The selected dates are already booked for this room",
      });
    }

    // Calculate platform fee info for management bookings
    const totalBookingAmount =
      (parseFloat(bookingData.roomPrice) || 0) *
      (parseInt(bookingData.nights) || 1);
    const platformFeeRate = 0.01; // 1% for management bookings
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
      // console.error("Error in PUT /newUser/:id:", err);
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
      return res.status(403).json({
        error: "Your account has been suspended. Please contact support.",
      });
    if (admin.adminApproval === false)
      return res.status(403).json({
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
      return res.status(403).json({
        error: "Your account has been suspended. Please contact support.",
      });
    if (user.adminApproval === false)
      return res.status(403).json({
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
      // console.error("Error checking availability:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

module.exports = router;
