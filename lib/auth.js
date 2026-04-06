const jwt = require("jsonwebtoken");
const mongo = require("./mongo");

const SECRET = process.env.JWT_SECRET || "change-this-secret";
const EXPIRY = process.env.JWT_EXPIRY || "1h";

if (!process.env.JWT_SECRET) {
  console.warn(
    "Warning: JWT_SECRET is not set. Using fallback secret is insecure. Set JWT_SECRET in your environment for production.",
  );
}

function sign(payload) {
  return jwt.sign(payload, SECRET, {
    expiresIn: EXPIRY,
    algorithm: "HS256",
  });
}

function verify(token) {
  return jwt.verify(token, SECRET, { algorithms: ["HS256"] });
}

async function authMiddleware(req, res, next) {
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

    const collections = ["admin", "admins", "management", "users"];
    let user = null;
    for (const name of collections) {
      const col = await mongo.getCollection(name);
      user = await col.findOne({ email: payload.email });
      if (user) break;
    }

    if (!user)
      return res
        .status(401)
        .json({ error: "You need to be logged in to access this." });
    req.user = {
      id: user._id ? user._id.toString() : user.id,
      email: user.email,
      name: user.name,
      role: user.role || "user",
    };
    next();
  } catch (err) {
    return res
      .status(401)
      .json({ error: "You need to be logged in to access this." });
  }
}

module.exports = { sign, verify, authMiddleware };
