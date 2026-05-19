const express = require("express");
const router = express.Router();
const mongo = require("../../lib/mongo");
const { ObjectId } = require("mongodb");
const { sign, verify } = require("../../lib/auth");
const bcrypt = require("bcryptjs");
const axios = require("axios");

const multer = require("multer");
const path = require("path");
const fs = require("fs");

const imageUploadsFolder = path.join(__dirname, "../../public/uploads/images");
fs.mkdirSync(imageUploadsFolder, { recursive: true });

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

// ── Microservice URLs ──
const SMS_API = process.env.SMS_API_URL || "http://localhost:4001";
const EMAIL_API = process.env.EMAIL_API_URL || "http://localhost:4003";

// ── Helper: Format phone (Tanzania) ──
function formatPhone(phone) {
  if (!phone) return null;
  let cleaned = phone.replace(/\s+/g, "").replace(/[^0-9+]/g, "");
  if (cleaned.startsWith("0")) cleaned = "+255" + cleaned.slice(1);
  if (cleaned.startsWith("255")) cleaned = "+" + cleaned;
  if (!cleaned.startsWith("+")) cleaned = "+" + cleaned;
  return cleaned;
}

// ── Helper: Generate 6-digit OTP ──
function generateOTP() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ── Middleware: Require client auth ──
async function requireClientAuth(req, res, next) {
  try {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer "))
      return res.status(401).json({ error: "Authentication required." });
    const token = auth.slice(7);
    const payload = verify(token);
    if (!payload || !payload.userId)
      return res.status(401).json({ error: "Invalid or expired token." });

    const col = await mongo.getCollection("client_users");
    const user = await col.findOne({ _id: new ObjectId(payload.userId) });
    if (!user)
      return res.status(401).json({ error: "Account not found." });
    if (user.blocked)
      return res.status(403).json({ error: "Your account has been suspended." });

    req.clientUser = {
      id: user._id.toString(),
      fullName: user.fullName,
      phone: user.phone,
      email: user.email || null,
      phoneVerified: !!user.phoneVerified,
      emailVerified: !!user.emailVerified,
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
}

// ══════════════════════════════════════
// POST /client/auth/register
// ══════════════════════════════════════
router.post("/register", async (req, res, next) => {
  try {
    const { fullName, phone, email, password } = req.body;

    // Validate required fields
    if (!fullName || !phone || !password) {
      return res.status(400).json({ error: "Full name, phone, and password are required." });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }

    const formattedPhone = formatPhone(phone);
    if (!formattedPhone) {
      return res.status(400).json({ error: "Invalid phone number." });
    }

    const normalizedEmail = email ? email.trim().toLowerCase() : null;
    if (normalizedEmail && !normalizedEmail.includes("@")) {
      return res.status(400).json({ error: "Invalid email address." });
    }

    const col = await mongo.getCollection("client_users");

    // Check for existing accounts
    const existingByPhone = await col.findOne({ phone: formattedPhone });
    if (existingByPhone) {
      return res.status(409).json({ error: "An account with this phone number already exists." });
    }

    if (normalizedEmail) {
      const existingByEmail = await col.findOne({ email: normalizedEmail });
      if (existingByEmail) {
        return res.status(409).json({ error: "An account with this email already exists." });
      }
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const newUser = {
      fullName: fullName.trim(),
      phone: formattedPhone,
      email: normalizedEmail,
      passwordHash,
      phoneVerified: false,
      emailVerified: false,
      blocked: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await col.insertOne(newUser);

    // Generate JWT
    const token = sign({
      userId: result.insertedId.toString(),
      phone: formattedPhone,
      email: normalizedEmail,
      role: "client",
    });

    // Send welcome email (async, non-blocking)
    if (normalizedEmail) {
      axios.post(`${EMAIL_API}/api/email/welcome`, {
        to: normalizedEmail,
        name: fullName.trim(),
      }, { timeout: 5000 }).catch(err => {
        console.warn("Welcome email failed (non-critical):", err.message);
      });
    }

    res.status(201).json({
      status: "success",
      message: "Account created successfully. Please verify your contact information.",
      token,
      user: {
        id: result.insertedId.toString(),
        fullName: newUser.fullName,
        phone: newUser.phone,
        email: newUser.email,
        phoneVerified: false,
        emailVerified: false,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════
// POST /client/auth/login
// ══════════════════════════════════════
router.post("/login", async (req, res, next) => {
  try {
    const { identifier, password } = req.body;

    if (!identifier || !password) {
      return res.status(400).json({ error: "Email/phone and password are required." });
    }

    const col = await mongo.getCollection("client_users");
    const trimmed = identifier.trim().toLowerCase();

    // Determine if identifier is email or phone
    let user = null;
    if (trimmed.includes("@")) {
      user = await col.findOne({ email: trimmed });
    } else {
      const formattedPhone = formatPhone(trimmed);
      if (formattedPhone) {
        user = await col.findOne({ phone: formattedPhone });
      }
      // Fallback: try raw match
      if (!user) {
        user = await col.findOne({ phone: trimmed });
      }
    }

    if (!user) {
      return res.status(401).json({ error: "Invalid credentials. Please check your email/phone and password." });
    }

    if (user.blocked) {
      return res.status(403).json({ error: "Your account has been suspended. Please contact support." });
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ error: "Invalid credentials. Please check your email/phone and password." });
    }

    if (user.preferences?.twoFactorEnabled) {
      // ── 2FA is Enabled ──
      const otp = generateOTP()
      const otpCol = await mongo.getCollection("otp_store")
      await otpCol.deleteMany({ userId: user._id.toString(), type: "2fa_login" })
      await otpCol.insertOne({
        userId: user._id.toString(),
        type: "2fa_login",
        otp,
        expiresAt: new Date(Date.now() + 10 * 60000), // 10 mins
        attempts: 0
      })

      // Send OTP via email or SMS (prefer email if available, else SMS)
      if (user.email) {
        axios.post(`${EMAIL_API}/api/email/otp`, {
          to: user.email,
          name: user.fullName || "User",
          otp
        }, { timeout: 5000 }).catch(e => console.warn("2FA email failed:", e.message))
      } else if (user.phone) {
        axios.post(`${SMS_API}/api/sms/send`, {
          phone: user.phone,
          message: `Your ReM360 login verification code is ${otp}. Valid for 10 minutes.`
        }, { timeout: 5000 }).catch(e => console.warn("2FA SMS failed:", e.message))
      }

      return res.json({
        status: "2fa_required",
        message: "Two-Factor Authentication required. We have sent an OTP to your email/phone.",
        identifier: user.email || user.phone
      })
    }

    const token = sign({
      userId: user._id.toString(),
      phone: user.phone,
      email: user.email,
      role: "client",
    });

    res.json({
      status: "success",
      token,
      user: {
        id: user._id.toString(),
        fullName: user.fullName,
        phone: user.phone,
        email: user.email,
        phoneVerified: !!user.phoneVerified,
        emailVerified: !!user.emailVerified,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════
// POST /client/auth/login-verify
// Verify 2FA OTP for login
// ══════════════════════════════════════
router.post("/login-verify", async (req, res, next) => {
  try {
    const { identifier, otp } = req.body;
    if (!identifier || !otp) {
      return res.status(400).json({ error: "Identifier and OTP are required." });
    }

    const col = await mongo.getCollection("client_users");
    const trimmed = identifier.trim().toLowerCase();

    let user = null;
    if (trimmed.includes("@")) {
      user = await col.findOne({ email: trimmed });
    } else {
      const formattedPhone = formatPhone(trimmed);
      if (formattedPhone) user = await col.findOne({ phone: formattedPhone });
      if (!user) user = await col.findOne({ phone: trimmed });
    }

    if (!user) return res.status(404).json({ error: "User not found." });

    const otpCol = await mongo.getCollection("otp_store");
    const stored = await otpCol.findOne({ userId: user._id.toString(), type: "2fa_login" });

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
      userId: user._id.toString(),
      phone: user.phone,
      email: user.email,
      role: "client",
    });

    res.json({
      status: "success",
      token,
      user: {
        id: user._id.toString(),
        fullName: user.fullName,
        phone: user.phone,
        email: user.email,
        phoneVerified: !!user.phoneVerified,
        emailVerified: !!user.emailVerified,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════
// POST /client/auth/send-otp
// Send OTP for phone or email verification
// ══════════════════════════════════════
router.post("/send-otp", requireClientAuth, async (req, res, next) => {
  try {
    const { type } = req.body; // "phone" or "email"
    const userId = req.clientUser.id;

    const col = await mongo.getCollection("client_users");
    const user = await col.findOne({ _id: new ObjectId(userId) });

    if (!user) {
      return res.status(404).json({ error: "Account not found." });
    }

    if (type === "phone") {
      if (!user.phone) {
        return res.status(400).json({ error: "No phone number on this account." });
      }
      if (user.phoneVerified) {
        return res.status(400).json({ error: "Phone number is already verified." });
      }

      // Delegate to SMS API
      try {
        const smsRes = await axios.post(`${SMS_API}/api/sms/otp/send`, {
          phone: user.phone,
        }, { timeout: 10000 });

        res.json({
          status: "success",
          message: "OTP sent to your phone number.",
        });
      } catch (smsErr) {
        console.error("SMS OTP send failed:", smsErr.message);
        return res.status(502).json({ error: "Failed to send SMS OTP. Please try again." });
      }

    } else if (type === "email") {
      if (!user.email) {
        return res.status(400).json({ error: "No email address on this account." });
      }
      if (user.emailVerified) {
        return res.status(400).json({ error: "Email address is already verified." });
      }

      // Generate OTP and store in DB
      const otp = generateOTP();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

      const otpCol = await mongo.getCollection("otp_store");
      await otpCol.deleteMany({ userId, type: "email" }); // Clear old OTPs
      await otpCol.insertOne({
        userId,
        type: "email",
        otp,
        expiresAt,
        attempts: 0,
        createdAt: new Date(),
      });

      // Send via Email API
      try {
        await axios.post(`${EMAIL_API}/api/email/otp`, {
          to: user.email,
          otp,
          name: user.fullName,
        }, { timeout: 10000 });

        res.json({
          status: "success",
          message: "OTP sent to your email address.",
        });
      } catch (emailErr) {
        console.error("Email OTP send failed:", emailErr.message);
        // Still return success since OTP is stored — user can retry
        res.json({
          status: "success",
          message: "OTP generated. Email delivery may be delayed.",
        });
      }

    } else {
      return res.status(400).json({ error: "Invalid type. Must be 'phone' or 'email'." });
    }
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════
// POST /client/auth/verify-otp
// Verify OTP for phone or email
// ══════════════════════════════════════
router.post("/verify-otp", requireClientAuth, async (req, res, next) => {
  try {
    const { type, otp } = req.body;
    const userId = req.clientUser.id;

    if (!type || !otp) {
      return res.status(400).json({ error: "Type and OTP are required." });
    }

    const col = await mongo.getCollection("client_users");
    const user = await col.findOne({ _id: new ObjectId(userId) });

    if (!user) {
      return res.status(404).json({ error: "Account not found." });
    }

    if (type === "phone") {
      if (user.phoneVerified) {
        return res.status(400).json({ error: "Phone number is already verified." });
      }

      // Delegate verification to SMS API
      try {
        const verifyRes = await axios.post(`${SMS_API}/api/sms/otp/verify`, {
          phone: user.phone,
          otp: otp.trim(),
        }, { timeout: 10000 });

        if (verifyRes.data.success) {
          await col.updateOne(
            { _id: new ObjectId(userId) },
            { $set: { phoneVerified: true, updatedAt: new Date() } }
          );

          const updatedUser = await col.findOne({ _id: new ObjectId(userId) });
          return res.json({
            status: "success",
            message: "Phone number verified successfully.",
            user: {
              id: updatedUser._id.toString(),
              fullName: updatedUser.fullName,
              phone: updatedUser.phone,
              email: updatedUser.email,
              phoneVerified: !!updatedUser.phoneVerified,
              emailVerified: !!updatedUser.emailVerified,
            },
          });
        }
      } catch (smsErr) {
        const errMsg = smsErr?.response?.data?.error || "OTP verification failed.";
        return res.status(400).json({ error: errMsg });
      }

    } else if (type === "email") {
      if (user.emailVerified) {
        return res.status(400).json({ error: "Email is already verified." });
      }

      // Verify from our otp_store collection
      const otpCol = await mongo.getCollection("otp_store");
      const stored = await otpCol.findOne({ userId, type: "email" });

      if (!stored) {
        return res.status(404).json({ error: "No OTP found. Please request a new one." });
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

      // Success
      await otpCol.deleteOne({ _id: stored._id });
      await col.updateOne(
        { _id: new ObjectId(userId) },
        { $set: { emailVerified: true, updatedAt: new Date() } }
      );

      const updatedUser = await col.findOne({ _id: new ObjectId(userId) });
      return res.json({
        status: "success",
        message: "Email address verified successfully.",
        user: {
          id: updatedUser._id.toString(),
          fullName: updatedUser.fullName,
          phone: updatedUser.phone,
          email: updatedUser.email,
          phoneVerified: !!updatedUser.phoneVerified,
          emailVerified: !!updatedUser.emailVerified,
        },
      });

    } else {
      return res.status(400).json({ error: "Invalid type. Must be 'phone' or 'email'." });
    }
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════
// GET /client/auth/me
// Get profile + linked bookings
// ══════════════════════════════════════
router.get("/me", requireClientAuth, async (req, res, next) => {
  try {
    const userId = req.clientUser.id;
    const col = await mongo.getCollection("client_users");
    const user = await col.findOne({ _id: new ObjectId(userId) });

    if (!user) {
      return res.status(404).json({ error: "Account not found." });
    }

    // Build booking query based on verified contact info
    const bookingsCol = await mongo.getCollection("bookings");
    const orConditions = [];

    if (user.emailVerified && user.email) {
      orConditions.push({ email: user.email });
      orConditions.push({ email: user.email.toLowerCase() });
    }
    if (user.phoneVerified && user.phone) {
      orConditions.push({ phone: user.phone });
      // Also match without country code
      const localPhone = user.phone.replace("+255", "0");
      orConditions.push({ phone: localPhone });
    }

    let bookings = [];
    if (orConditions.length > 0) {
      bookings = await bookingsCol
        .find({ $or: orConditions })
        .sort({ createdAt: -1 })
        .toArray();
    }

    res.json({
      status: "success",
      user: {
        id: user._id.toString(),
        fullName: user.fullName,
        phone: user.phone,
        email: user.email,
        phoneVerified: !!user.phoneVerified,
        emailVerified: !!user.emailVerified,
        createdAt: user.createdAt,
      },
      bookings,
    });
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════
// POST /client/auth/change-password
// ══════════════════════════════════════
router.post("/change-password", requireClientAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const userId = req.clientUser.id;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Current password and new password are required." });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: "New password must be at least 6 characters." });
    }

    const col = await mongo.getCollection("client_users");
    const user = await col.findOne({ _id: new ObjectId(userId) });

    if (!user) {
      return res.status(404).json({ error: "Account not found." });
    }

    const isMatch = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ error: "Current password is incorrect." });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(newPassword, salt);

    await col.updateOne(
      { _id: new ObjectId(userId) },
      { $set: { passwordHash, updatedAt: new Date() } }
    );

    res.json({ status: "success", message: "Password changed successfully." });
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════
// POST /client/auth/forgot-password
// Send OTP for password reset (no auth required)
// ══════════════════════════════════════
router.post("/forgot-password", async (req, res, next) => {
  try {
    const { identifier } = req.body;

    if (!identifier) {
      return res.status(400).json({ error: "Email or phone number is required." });
    }

    const col = await mongo.getCollection("client_users");
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
      // Don't reveal whether account exists
      return res.json({ status: "success", message: "If an account exists, an OTP has been sent.", type: resetType });
    }

    const otp = generateOTP();

    if (resetType === "email" && user.email) {
      // Store OTP in DB
      const otpCol = await mongo.getCollection("otp_store");
      await otpCol.deleteMany({ userId: user._id.toString(), type: "password_reset" });
      await otpCol.insertOne({
        userId: user._id.toString(),
        type: "password_reset",
        otp,
        identifier: user.email,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
        attempts: 0,
        createdAt: new Date(),
      });

      // Send via Email API
      axios.post(`${EMAIL_API}/api/email/password-reset`, {
        to: user.email,
        name: user.fullName,
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
      // Store OTP in DB (also use SMS API)
      const otpCol = await mongo.getCollection("otp_store");
      await otpCol.deleteMany({ userId: user._id.toString(), type: "password_reset" });
      await otpCol.insertOne({
        userId: user._id.toString(),
        type: "password_reset",
        otp,
        identifier: user.phone,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        attempts: 0,
        createdAt: new Date(),
      });

      // Send via SMS API
      axios.post(`${SMS_API}/api/sms/send`, {
        phone: user.phone,
        message: `Your ReM360 password reset code is: ${otp}. This code expires in 10 minutes.`,
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
// POST /client/auth/reset-password
// Verify OTP and set new password (no auth required)
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

    const col = await mongo.getCollection("client_users");
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

    // Verify OTP from otp_store
    const otpCol = await mongo.getCollection("otp_store");
    const stored = await otpCol.findOne({ userId: user._id.toString(), type: "password_reset" });

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

    // Success — update password
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

// ══════════════════════════════════════
// PUT /client/auth/profile
// Update user profile (preferences, billing)
// ══════════════════════════════════════
router.put("/profile", requireClientAuth, async (req, res, next) => {
  try {
    const { preferences, billing } = req.body;
    const col = await mongo.getCollection("client_users");
    
    const updateDoc = { $set: { updatedAt: new Date() } };
    if (preferences) updateDoc.$set.preferences = preferences;
    if (billing) updateDoc.$set.billing = billing;

    await col.updateOne(
      { _id: new ObjectId(req.clientUser.id) },
      updateDoc
    );

    const user = await col.findOne({ _id: new ObjectId(req.clientUser.id) });
    const { passwordHash, ...safeUser } = user;

    res.json({ status: "success", user: { ...safeUser, id: safeUser._id.toString() } });
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════
// POST /client/auth/avatar
// Upload profile avatar
// ══════════════════════════════════════
router.post("/avatar", requireClientAuth, upload.single("avatar"), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image file provided." });
    }

    const avatarUrl = `/public/uploads/images/${req.file.filename}`;
    const col = await mongo.getCollection("client_users");

    await col.updateOne(
      { _id: new ObjectId(req.clientUser.id) },
      { $set: { avatarUrl, updatedAt: new Date() } }
    );

    res.json({ status: "success", avatarUrl });
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════
// GET /client/auth/my-bookings
// Fetch user's bookings with search, filter, and sort
// ══════════════════════════════════════
router.get("/my-bookings", requireClientAuth, async (req, res, next) => {
  try {
    const { search, status, dateFrom, dateTo, sortBy, sortOrder } = req.query;

    const email = req.clientUser.email;
    const phone = req.clientUser.phone;

    if (!email && !phone) {
      return res.status(400).json({ error: "User has no email or phone associated." });
    }

    const col = await mongo.getCollection("bookings");

    // Base filter: bookings belong to this user
    const userMatch = [];
    if (email) userMatch.push({ email });
    if (phone) {
      userMatch.push({ phone });
      if (phone.startsWith("+255")) {
        userMatch.push({ phone: "0" + phone.slice(4) });
      } else if (phone.startsWith("255")) {
        userMatch.push({ phone: "0" + phone.slice(3) });
      } else if (phone.startsWith("0")) {
        userMatch.push({ phone: "+255" + phone.slice(1) });
      }
    }
    
    const filter = {
      $or: userMatch
    };

    // Advanced search across multiple fields
    if (search) {
      const regex = new RegExp(search, "i");
      filter.$and = filter.$and || [];
      filter.$and.push({
        $or: [
          { bookingId: regex },
          { accomodationName: regex },
          { accomodation: regex },
          { roomName: regex }
        ]
      });
    }

    // Status filter
    if (status && status !== "All") {
      filter.$and = filter.$and || [];
      // Note: adjust status matching based on how it's stored. Usually it's lowercase or titlecase.
      filter.$and.push({ status: new RegExp(`^${status}$`, "i") });
    }

    // Date range filter (using checkIn date)
    if (dateFrom || dateTo) {
      filter.$and = filter.$and || [];
      const dateFilter = {};
      if (dateFrom) {
        const dFrom = new Date(dateFrom);
        if (!isNaN(dFrom.getTime())) dateFilter.$gte = dFrom;
      }
      if (dateTo) {
        const dTo = new Date(dateTo);
        if (!isNaN(dTo.getTime())) {
          dTo.setHours(23, 59, 59, 999);
          dateFilter.$lte = dTo;
        }
      }
      if (Object.keys(dateFilter).length > 0) {
        filter.$and.push({ checkIn: dateFilter });
      }
    }

    // Determine sorting
    let sortObj = { _id: -1 }; // Default: newest first
    const order = sortOrder === "asc" ? 1 : -1;

    if (sortBy) {
      if (sortBy === "date") {
        sortObj = { checkIn: order };
      } else if (sortBy === "price") {
        sortObj = { totalAmount: order, amountPaid: order }; // Use whichever exists
      } else {
        sortObj = { [sortBy]: order };
      }
    }

    const bookings = await col.find(filter).sort(sortObj).toArray();

    res.json({ status: "success", bookings });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
