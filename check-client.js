const axios = require('axios');
async function run() {
  try {
    const res = await axios.get('http://localhost:5000/client/accomodations');
    const homestays = res.data.accomodationData.filter(a => a.type === 'homestay' || a.name.toLowerCase().includes('homestay') || a.name.toLowerCase().includes('home stay'));
    console.log(`Found ${homestays.length} homestays on client endpoint`);
    console.log(JSON.stringify(homestays.map(h => h.name), null, 2));
  } catch (e) {
    console.error(e.message);
  }
}
run();
