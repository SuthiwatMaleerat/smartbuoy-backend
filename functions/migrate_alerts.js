// Run with: node migrate_alerts.js

const admin = require("firebase-admin");
admin.initializeApp();
const firestore = admin.firestore();

async function migrateAlerts() {
  console.log("🚚 Start migrating alerts → alerts_old ...");

  const BATCH_SIZE = 300;
  const alertsRef = firestore.collection("alerts");
  const oldRef = firestore.collection("alerts_old");

  let total = 0;
  let moved = 0;

  const snapshot = await alertsRef.get();
  total = snapshot.size;
  console.log(`Total alerts to migrate: ${total}`);

  let batch = firestore.batch();
  let count = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data() || {};
    const docId = doc.id;

    batch.set(oldRef.doc(docId), {
      ...data,
      migrated_at: new Date().toISOString(),
      legacy: true,
    });

    batch.delete(alertsRef.doc(docId));

    count++;
    moved++;

    if (count >= BATCH_SIZE) {
      await batch.commit();
      batch = firestore.batch();
      count = 0;
      console.log(`✅ Migrated ${moved}/${total}`);
    }
  }

  if (count > 0) await batch.commit();
  console.log(`🎉 Migration done: ${moved}/${total}`);
}

migrateAlerts().catch(console.error);
