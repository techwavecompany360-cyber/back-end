const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

const helmet = require("helmet");
const path = require("path");
const app = express();
const port = process.env.PORT || 3001;

// Middleware
app.use(
  cors({
    // reflect request origin — allows any front-end URL while still
    // supporting credentials by echoing the incoming Origin header
    origin: true,
    methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);

// Ensure preflight OPTIONS requests are handled for all routes
app.options('*', cors({ origin: true, credentials: true }));

// Fallback: ensure CORS headers are present on all responses.
// Useful when a reverse proxy strips or handles headers inconsistently.
app.use((req, res, next) => {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());
app.use(morgan("dev"));

// Serve static files from public directory
app.use("/public", express.static(path.join(__dirname, "public")));

app.get("/view-pdf/:filename", (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, "public/uploads/documents", filename);

  console.log("Serving PDF file from:", filePath);

  res.sendFile(filePath, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": "inline", // This tells the browser to OPEN, not download
    },
  });
});
// Basic security headers
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        // Allow your Vue app (e.g., localhost:5173) to frame this server
        "frame-ancestors": [
          "'self'",
          "http://localhost:5173",
          "https://rem360.co.tz",
          "https://admin.rem360.co.tz/",
        ],
      },
    },
  }),
);

// Simple in-memory store for demo
// Mongo DB will store items; legacy in-memory removed
const mongo = require("./lib/mongo");

// Ensure DB connects when server starts
mongo.connect().catch((err) => {
  console.error("Failed to connect to MongoDB:", err);
});

// Health
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// Routers (mounted at top-level)
const adminRouter = require("./routes/admin/index");
const clientRouter = require("./routes/client/index");
const managementRouter = require("./routes/management/index");

app.use("/admin", adminRouter);
app.use("/client", clientRouter);
app.use("/management", managementRouter);

// mount users router under management
// API
// Mongo-backed CRUD for /api/items
app.get("/api/items", async (req, res, next) => {
  try {
    const col = await mongo.getCollection("items");
    const docs = await col.find({}).toArray();
    res.json(docs);
  } catch (err) {
    next(err);
  }
});

app.get("/api/items/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const col = await mongo.getCollection("items");
    const doc = await col.findOne({ id });
    if (!doc) return res.status(404).json({ error: "Not found" });
    res.json(doc);
  } catch (err) {
    next(err);
  }
});

app.post("/api/items", async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const col = await mongo.getCollection("items");
    // generate simple numeric id
    const last = await col.find({}).sort({ id: -1 }).limit(1).toArray();
    const id = last.length ? last[0].id + 1 : 1;
    const newItem = { id, name };
    await col.insertOne(newItem);
    res.status(201).json(newItem);
  } catch (err) {
    next(err);
  }
});

app.put("/api/items/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { name } = req.body;
    const col = await mongo.getCollection("items");
    const result = await col.findOneAndUpdate(
      { id },
      { $set: { name } },
      { returnDocument: "after" },
    );
    if (!result.value) return res.status(404).json({ error: "Not found" });
    res.json(result.value);
  } catch (err) {
    next(err);
  }
});

app.delete("/api/items/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const col = await mongo.getCollection("items");
    const result = await col.findOneAndDelete({ id });
    if (!result.value) return res.status(404).json({ error: "Not found" });
    res.json(result.value);
  } catch (err) {
    next(err);
  }
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal Server Error" });
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
  });
}

module.exports = app;
