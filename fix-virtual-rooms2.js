const { MongoClient } = require('mongodb'); 
async function run() { 
  const client = new MongoClient('mongodb://127.0.0.1:27017'); 
  await client.connect(); 
  const db = client.db('rem360'); 

  // Find all homestays case-insensitive
  const query = { type: { $regex: new RegExp('^homestay$', 'i') } };
  const homestays = await db.collection('accomodations').find(query).toArray(); 
  
  let createdCount = 0;
  
  for (const h of homestays) {
    const rooms = await db.collection('rooms').find({ accomodationReference: h._id.toString() }).toArray();
    if (rooms.length === 0) {
      console.log(`Creating virtual room for ${h.name} (${h._id}) with type ${h.type}`);
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
      createdCount++;
    }
  }
  
  console.log(`Created ${createdCount} missing virtual rooms.`);
  process.exit(0); 
} 
run().catch(console.error);
