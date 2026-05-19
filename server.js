require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

const helmet = require("helmet");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const port = process.env.PORT || 3001;
const server = http.createServer(app);

// Initialize Socket.io
const io = new Server(server, {
  cors: {
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    credentials: true,
  },
});

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

app.use(express.json());
app.use(morgan("dev"));

// Serve static files from public directory
app.use("/public", express.static(path.join(__dirname, "public")));

app.get("/view-pdf/:filename", (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, "public/uploads/documents", filename);

  // console.log("Serving PDF file from:", filePath);

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
const analyticsRouter = require("./routes/client/analytics");

app.use("/admin", adminRouter);
app.use("/client", clientRouter);
app.use("/client/analytics", analyticsRouter);
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

// --- Socket.io Chat Implementation ---
io.on("connection", (socket) => {
  // console.log("Client connected to socket:", socket.id);

  socket.on("join_room", (room) => {
    socket.join(room);
    // console.log(`Socket ${socket.id} joined room ${room}`);
  });

  socket.on("send_message", async (data) => {
    const { room, senderType, senderId, text, accommodationId, clientId } = data;
    if (!room || !text || !senderType) return;

    try {
      const messagesCol = await mongo.getCollection("messages");
      const messageDoc = {
        room,
        accommodationId,
        clientId,
        senderType, // 'client' or 'management'
        senderId,
        text,
        createdAt: new Date(),
        read: false
      };
      await messagesCol.insertOne(messageDoc);
      
      // Broadcast to everyone in the room (client + manager looking at this room)
      io.to(room).emit("receive_message", messageDoc);
      
      // Notify the management inbox generally so it updates unread counts
      if (accommodationId && senderType === 'client') {
          io.to(`management_${accommodationId}`).emit("new_inbox_message", messageDoc);
      }
    } catch (err) {
      console.error("Error saving message:", err);
    }
  });

  // --- Admin ↔ Management Chat ---
  socket.on("join_admin_room", (room) => {
    socket.join(room);
  });

  socket.on("send_admin_message", async (data) => {
    const { room, senderType, senderId, senderName, senderRole, senderRef, text, managementUserId } = data;
    if (!room || !text || !senderType) return;

    try {
      const messagesCol = await mongo.getCollection("admin_messages");
      const messageDoc = {
        room,
        managementUserId,
        senderType,
        senderId,
        senderName: senderName || (senderType === "admin" ? "Admin" : "Manager"),
        senderRole: senderRole || senderType,
        senderRef: senderRef || "",
        text,
        createdAt: new Date(),
        status: "sent",
      };
      await messagesCol.insertOne(messageDoc);

      io.to(room).emit("receive_admin_message", messageDoc);
    } catch (err) {
      console.error("Error saving admin message:", err);
    }
  });

  // Mark messages as delivered
  socket.on("admin_msg_delivered", async (data) => {
    const { room, senderType } = data;
    if (!room) return;
    try {
      const messagesCol = await mongo.getCollection("admin_messages");
      await messagesCol.updateMany(
        { room, senderType, status: "sent" },
        { $set: { status: "delivered" } }
      );
      io.to(room).emit("admin_status_update", { room, senderType, newStatus: "delivered" });
    } catch (err) {
      console.error("Error marking delivered:", err);
    }
  });

  // Mark messages as read
  socket.on("admin_msg_read", async (data) => {
    const { room, senderType } = data;
    if (!room) return;
    try {
      const messagesCol = await mongo.getCollection("admin_messages");
      await messagesCol.updateMany(
        { room, senderType, status: { $ne: "read" } },
        { $set: { status: "read" } }
      );
      io.to(room).emit("admin_status_update", { room, senderType, newStatus: "read" });
    } catch (err) {
      console.error("Error marking read:", err);
    }
  });

  socket.on("disconnect", () => {
    // console.log("Client disconnected:", socket.id);
  });
});

if (require.main === module) {
  server.listen(port, () => {
    // console.log(`Server listening on http://localhost:${port}`);
  });
}

module.exports = { app, server, io };
