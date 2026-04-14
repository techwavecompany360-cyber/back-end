const { MongoClient, ObjectId } = require('mongodb'); 
async function run() { 
  const client = new MongoClient('mongodb://127.0.0.1:27017'); 
  await client.connect(); 
  const db = client.db('rem360'); 
  const idStr = "69dd4f71514aaee0b74d9566";
  
  await db.collection('accomodations').updateOne({ _id: new ObjectId(idStr) }, { $set: { type: 'homestay' } });
  
  const h = await db.collection('accomodations').findOne({ _id: new ObjectId(idStr) });
  
  await db.collection('rooms').insertOne({
    roomName: "Entire Home",
    accomodationReference: h._id.toString(),
    description: "Exclusive use of the entire homestay.",
    capacity: Number(h.maxGuests) || 1,
    price: Number(h.pricePerNight) || 0,
    amenities: h.amenities || [],
    otherImagesCount: h.otherImagesCount || (h.otherImages ? h.otherImages.length : 0),
    frontImage: h.frontImage,
    otherImages: h.otherImages || [],
    available: "Available",
    adminApproval: h.adminApproval || false,
    rejected: h.rejected || false,
    blocked: h.blocked || false,
    status: h.status || "approved",
    createdAt: new Date(),
  });
  console.log("Fixed home stay four and generated its virtual room.");
  process.exit(0);
}
run().catch(console.error);
