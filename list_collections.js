const { MongoClient } = require('mongodb');

async function main() {
  const uri = "mongodb://localhost:27017/rem360";
  const client = new MongoClient(uri);

  try {
    await client.connect();
    const db = client.db('rem360');
    const collections = await db.listCollections().toArray();
    console.log("Collections:", collections.map(c => c.name).join(", "));
  } finally {
    await client.close();
  }
}
main().catch(console.error);
