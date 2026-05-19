const { MongoClient } = require('mongodb');

async function main() {
  const uri = "mongodb://localhost:27017/rem360";
  const client = new MongoClient(uri);

  try {
    await client.connect();
    const db = client.db('rem360');
    const analytics = db.collection('site_analytics');
    const doc = await analytics.findOne({});
    console.log(JSON.stringify(doc, null, 2));
  } finally {
    await client.close();
  }
}
main().catch(console.error);
