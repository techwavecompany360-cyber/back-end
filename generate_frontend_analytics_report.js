const { MongoClient } = require('mongodb');

async function main() {
  const uri = "mongodb://localhost:27017/rem360";
  const client = new MongoClient(uri);

  try {
    await client.connect();
    const db = client.db('rem360');
    const analytics = db.collection('site_analytics');
    
    // We want to group by userId or visitorId
    const pipeline = [
      {
        $group: {
          _id: { $ifNull: ["$userId", "$visitorId"] },
          userId: { $first: "$userId" },
          visitorId: { $first: "$visitorId" },
          browsers: { $addToSet: "$device.browser" },
          deviceTypes: { $addToSet: "$device.deviceType" },
          os: { $addToSet: "$device.os" },
          screenResolutions: { 
            $addToSet: { 
              $concat: [
                { $toString: "$screenWidth" }, "x", { $toString: "$screenHeight" }
              ] 
            } 
          },
          avgSessionDuration: { $avg: "$sessionDuration" },
          totalVisits: { $sum: 1 },
          lastActive: { $max: "$timestamp" }
        }
      },
      { $sort: { lastActive: -1 } },
      { $limit: 100 } // just top 100 recent to avoid massive report
    ];

    const results = await analytics.aggregate(pipeline).toArray();

    console.log('# User Front-End Performance & Environment Report\n');
    console.log('This report analyzes the front-end environment and performance metrics for individual users accessing the platform.\n');
    console.log('| User Identifier | Device / OS | Browsers | Screen Res | Avg Session Duration | Total Hits | Last Active |');
    console.log('|---|---|---|---|---|---|---|');

    results.forEach(stat => {
      const identifier = stat.userId ? `User: ${stat.userId.toString().substring(0,8)}...` : `Visitor: ${stat.visitorId.substring(0,8)}...`;
      const devicesOS = `${stat.deviceTypes.join(', ')} / ${stat.os.join(', ')}`;
      const browsers = stat.browsers.join(', ');
      const res = stat.screenResolutions.join(', ');
      const avgDur = stat.avgSessionDuration ? `${stat.avgSessionDuration.toFixed(1)}s` : '0s';
      const lastActive = stat.lastActive ? new Date(stat.lastActive).toLocaleString() : 'N/A';
      
      console.log(`| **${identifier}** | ${devicesOS} | ${browsers} | ${res} | ${avgDur} | ${stat.totalVisits} | ${lastActive} |`);
    });

  } finally {
    await client.close();
  }
}
main().catch(console.error);
