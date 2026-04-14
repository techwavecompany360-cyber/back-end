const { MongoClient } = require('mongodb'); 
async function run() { 
  const client = new MongoClient('mongodb://127.0.0.1:27017'); 
  await client.connect(); 
  const db = client.db('rem360'); 
  const homestays = await db.collection('accomodations').find({ type: 'homestay', adminApproval: true }).toArray(); 
  console.log('Homestays:', JSON.stringify(homestays, null, 2)); 
  const rooms = await db.collection('rooms').find({ accomodationReference: { $in: homestays.map(h => h._id.toString()) } }).toArray(); 
  console.log('Rooms:', JSON.stringify(rooms, null, 2)); 
  process.exit(0); 
} 
run().catch(console.error);
