const { MongoClient } = require('mongodb');

async function main() {
  const uri = "mongodb://localhost:27017/rem360";
  const client = new MongoClient(uri);

  try {
    await client.connect();
    const database = client.db('rem360');
    const bookings = database.collection('bookings');

    const cursor = bookings.find({});
    
    const agentStats = {};

    await cursor.forEach((booking) => {
      let agentName = 'Online / Direct';
      if (booking.source === 'Management') {
        agentName = booking.creatorName || 'Unknown Agent';
      } else if (booking.source === 'Client') {
        agentName = 'Online Booking';
      } else {
        agentName = booking.creatorName || booking.source || 'Unknown';
      }

      if (!agentStats[agentName]) {
        agentStats[agentName] = { name: agentName, count: 0, revenue: 0, uncollected: 0 };
      }
      
      agentStats[agentName].count += 1;
      agentStats[agentName].revenue += Number(booking.totalAmount) || 0;
      
      const uncollected = Math.max(0, (Number(booking.totalAmount) || 0) - (Number(booking.amountPaid) || 0));
      agentStats[agentName].uncollected += uncollected;
    });

    const sortedStats = Object.values(agentStats).sort((a, b) => b.revenue - a.revenue);

    console.log('# User Performance Report\n');
    console.log('| Agent / Source | Bookings Count | Total Revenue Generated (TZS) | Uncollected Balance (TZS) |');
    console.log('|---|---|---|---|');
    sortedStats.forEach(stat => {
      console.log(`| **${stat.name}** | ${stat.count} | ${stat.revenue.toLocaleString()} | ${stat.uncollected.toLocaleString()} |`);
    });

  } finally {
    await client.close();
  }
}

main().catch(console.error);
