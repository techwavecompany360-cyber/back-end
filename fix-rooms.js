const { MongoClient } = require('mongodb'); 
async function run() { 
  const client = new MongoClient('mongodb://127.0.0.1:27017'); 
  await client.connect(); 
  const db = client.db('rem360'); 
  const approvedAccomodations = await db.collection('accomodations').find({ adminApproval: true }).toArray(); 
  const accIds = approvedAccomodations.map(h => h._id.toString());
  const updateResult = await db.collection('rooms').updateMany({ accomodationReference: { $in: accIds } }, { $set: { adminApproval: true, rejected: false, status: 'approved' } });
  console.log('Fixed', updateResult.modifiedCount, 'rooms.');
  process.exit(0); 
} 
run().catch(console.error);
