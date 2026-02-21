const jwt = require("jsonwebtoken");
const mongo = require("./mongo");

const SECRET = process.env.JWT_SECRET || "change-this-secret";
const EXPIRY = process.env.JWT_EXPIRY || "1h";

function sign(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRY });
}

function verify(token) {
  return jwt.verify(token, SECRET);
}

async function authMiddleware(req, res, next) {
  try {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer "))
      return res.status(401).json({ error: "Unauthorized" });
    const token = auth.slice(7);
    const payload = verify(token);
    // optional: fetch user from DB
    if (payload && payload.email) {
      const col = await mongo.getCollection("admins");
      const user = await col.findOne({ email: payload.email });
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      req.user = { id: user.id, email: user.email, name: user.name };
    } else {
      req.user = payload;
    }
    next();
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

module.exports = { sign, verify, authMiddleware };
