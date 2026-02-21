const mongo = require("./mongo");
const { ObjectId } = require("mongodb");

async function ensureIndexes() {
  const col = await mongo.getCollection("users");
  await col.createIndex({ email: 1 }, { unique: true, background: true });
}

async function findByEmail(email) {
  const col = await mongo.getCollection("users");
  return await col.findOne({ email });
}

async function findById(id) {
  const col = await mongo.getCollection("users");
  try {
    return await col.findOne({ _id: new ObjectId(id) });
  } catch (e) {
    return null;
  }
}

async function createUser(user) {
  const col = await mongo.getCollection("users");
  const now = new Date();
  const doc = Object.assign(
    {
      name: "",
      email: "",
      passwordHash: "",
      phone: "",
      role: "user",
      blocked: false,
      createdAt: now,
      updatedAt: now,
    },
    user
  );
  const res = await col.insertOne(doc);
  doc._id = res.insertedId;
  return doc;
}

async function updateUser(id, patch) {
  const col = await mongo.getCollection("users");
  patch.updatedAt = new Date();
  try {
    const result = await col.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: patch },
      { returnDocument: "after" }
    );
    return result.value;
  } catch (e) {
    return null;
  }
}

async function deleteUser(id) {
  const col = await mongo.getCollection("users");
  try {
    const result = await col.findOneAndDelete({ _id: new ObjectId(id) });
    return result.value;
  } catch (e) {
    return null;
  }
}

async function listUsers({ page = 1, limit = 25, q, role, blocked }) {
  const col = await mongo.getCollection("users");
  const filter = {};
  if (q) {
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ name: re }, { email: re }];
  }
  if (role) filter.role = role;
  if (typeof blocked !== "undefined") filter.blocked = blocked;

  const skip = (page - 1) * limit;
  const total = await col.countDocuments(filter);
  const items = await col
    .find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .toArray();
  return { items, total };
}

module.exports = {
  ensureIndexes,
  findByEmail,
  findById,
  createUser,
  updateUser,
  deleteUser,
  listUsers,
};
