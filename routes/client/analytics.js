const express = require("express");
const router = express.Router();
const mongo = require("../../lib/mongo");
const geoip = require("geoip-lite");

// ── Simple in-memory rate limiter ──
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 100; // max requests per window per IP

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || "unknown";
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now - entry.start > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(ip, { start: now, count: 1 });
    return next();
  }

  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: "Too many requests" });
  }
  next();
}

// Clean up rate limit map every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.start > RATE_LIMIT_WINDOW * 2) {
      rateLimitMap.delete(ip);
    }
  }
}, 5 * 60 * 1000);

// ── Helper: Parse user agent into structured data ──
function parseUserAgent(ua) {
  if (!ua) return { browser: "Unknown", os: "Unknown", deviceType: "desktop" };

  let browser = "Unknown";
  let os = "Unknown";
  let deviceType = "desktop";

  // Browser detection
  if (ua.includes("Firefox/")) browser = "Firefox";
  else if (ua.includes("Edg/")) browser = "Edge";
  else if (ua.includes("OPR/") || ua.includes("Opera")) browser = "Opera";
  else if (ua.includes("Chrome/") && !ua.includes("Edg/")) browser = "Chrome";
  else if (ua.includes("Safari/") && !ua.includes("Chrome")) browser = "Safari";
  else if (ua.includes("MSIE") || ua.includes("Trident/")) browser = "IE";

  // OS detection
  if (ua.includes("Windows NT")) os = "Windows";
  else if (ua.includes("Mac OS X")) os = "macOS";
  else if (ua.includes("Android")) os = "Android";
  else if (ua.includes("iPhone") || ua.includes("iPad")) os = "iOS";
  else if (ua.includes("Linux")) os = "Linux";
  else if (ua.includes("CrOS")) os = "ChromeOS";

  // Device type detection
  if (ua.includes("Mobile") || ua.includes("Android") && !ua.includes("Tablet")) {
    deviceType = "mobile";
  } else if (ua.includes("iPad") || ua.includes("Tablet")) {
    deviceType = "tablet";
  }

  return { browser, os, deviceType };
}

// ══════════════════════════════════════
// POST /client/analytics/track
// Receive tracking events from the frontend
// ══════════════════════════════════════
router.post("/track", rateLimit, async (req, res) => {
  try {
    const {
      visitorId,
      sessionId,
      page,
      pageName,
      referrer,
      screenWidth,
      screenHeight,
      language,
      visitCount,
      sessionStart,
      utmSource,
      utmMedium,
      utmCampaign,
      userId,
      timestamp,
      eventType,
      eventMeta,
    } = req.body;

    // Basic validation
    if (!visitorId) {
      return res.status(400).json({ error: "visitorId is required" });
    }

    // Get IP and geo-location (server-side, no external API needed)
    const clientIp = req.headers["x-forwarded-for"]
      ? req.headers["x-forwarded-for"].split(",")[0].trim()
      : req.ip || req.connection.remoteAddress || "";

    // Strip ::ffff: prefix for IPv4-mapped IPv6 addresses
    const cleanIp = clientIp.replace(/^::ffff:/, "");

    let geo = null;
    const geoLookup = geoip.lookup(cleanIp);
    if (geoLookup) {
      geo = {
        country: geoLookup.country || null,
        region: geoLookup.region || null,
        city: geoLookup.city || null,
        ll: geoLookup.ll || null, // [lat, lng]
        timezone: geoLookup.timezone || null,
      };
    }

    // Parse user agent
    const userAgent = req.headers["user-agent"] || "";
    const device = parseUserAgent(userAgent);

    const event = {
      visitorId,
      sessionId: sessionId || null,
      page,
      pageName: pageName || null,
      referrer: referrer || null,
      ip: cleanIp,
      geo,
      device,
      userAgent,
      screenWidth: screenWidth || null,
      screenHeight: screenHeight || null,
      language: language || null,
      visitCount: visitCount || 1,
      sessionStart: sessionStart ? new Date(sessionStart) : null,
      utmSource: utmSource || null,
      utmMedium: utmMedium || null,
      utmCampaign: utmCampaign || null,
      userId: userId || null,
      timestamp: timestamp ? new Date(timestamp) : new Date(),
      eventType: eventType || "pageview",
      eventMeta: eventMeta || null,
      createdAt: new Date(),
    };

    const col = await mongo.getCollection("site_analytics");
    await col.insertOne(event);

    // Fast response — don't block the user
    res.status(204).send();
  } catch (err) {
    // Silently fail — analytics should never break the user experience
    console.warn("Analytics track error:", err.message);
    res.status(204).send();
  }
});

// ══════════════════════════════════════
// POST /client/analytics/session-end
// Record session duration when user leaves
// ══════════════════════════════════════
router.post("/session-end", rateLimit, async (req, res) => {
  try {
    const { visitorId, sessionId, duration } = req.body;

    if (!visitorId || !sessionId) {
      return res.status(204).send();
    }

    const col = await mongo.getCollection("site_analytics");
    // Update all events in this session with the duration
    await col.updateMany(
      { visitorId, sessionId },
      { $set: { sessionDuration: duration || 0 } }
    );

    res.status(204).send();
  } catch (err) {
    console.warn("Analytics session-end error:", err.message);
    res.status(204).send();
  }
});

module.exports = router;
