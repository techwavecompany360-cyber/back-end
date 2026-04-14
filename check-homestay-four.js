const { MongoClient } = require('mongodb'); 
async function run() { 
  const client = new MongoClient('mongodb://127.0.0.1:27017'); 
  await client.connect(); 
  const db = client.db('rem360'); 
  const nameRegex = new RegExp('home stay four', 'i');
  
  const homestay = await db.collection('accomodations').findOne({ name: nameRegex });
  if (!homestay) {
    console.log('Homestay not found.');
  } else {
    console.log('Homestay found:');
    console.log(JSON.stringify(homestay, null, 2));

    const rooms = await db.collection('rooms').find({ accomodationReference: homestay._id.toString() }).toArray();
    console.log(`Associated rooms (${rooms.length}):`);
    console.log(JSON.stringify(rooms, null, 2));
  }
  
  process.exit(0); 
} 
run().catch(console.error);
