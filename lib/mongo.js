const { MongoClient } = require("mongodb");

const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/rem360";
let client;

async function connect() {
  if (client && client.topology && client.topology.isConnected()) return client;
  client = new MongoClient(uri, { useUnifiedTopology: true });
  await client.connect();
  return client;
}

async function getDb() {
  if (!client) await connect();
  return client.db();
}

async function getCollection(name) {
  const db = await getDb();
  return db.collection(name);
}

async function close() {
  if (client) {
    await client.close();
    client = null;
  }
}

module.exports = { connect, getDb, getCollection, close };
