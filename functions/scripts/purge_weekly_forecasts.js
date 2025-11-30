// node scripts/purge_weekly_forecasts.js
const admin = require("firebase-admin");
admin.initializeApp();
const db = admin.firestore();

async function purge() {
  const BATCH = 400;
  while (true) {
    const snap = await db.collection("weekly_forecasts").limit(BATCH).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    console.log("deleted:", snap.size);
  }
  console.log("DONE");
}
purge().catch(e=>{console.error(e);process.exit(1);});
