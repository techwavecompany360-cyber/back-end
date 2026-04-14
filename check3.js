const { MongoClient } = require('mongodb'); 
async function run() { 
  const client = new MongoClient('mongodb://127.0.0.1:27017'); 
  await client.connect(); 
  const db = client.db('rem360'); 
  const result = await db.collection('accomodations').find({ name: /four/i }).toArray();
  console.log(JSON.stringify(result.map(r => ({ name: r.name, type: r.type, id: r._id, adminApproval: r.adminApproval })), null, 2));
  process.exit(0);
}
run().catch(console.error);
