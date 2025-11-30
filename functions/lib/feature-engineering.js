// functions/lib/feature-engineering.js
const { getFirestore } = require("firebase-admin/firestore");
const db = getFirestore();

// ดึงค่าล่าสุดของ 5 พารามิเตอร์ + ฟีเจอร์เวลา (sin/cos)
async function buildFeaturesForBuoy(buoyId) {
  const params = ["ph", "tds", "ec", "turbidity", "temperature"];
  const result = {};

  // คิวรีล่าสุดทีละ parameter (แน่นอนสุด)
  await Promise.all(params.map(async (p) => {
    const snap = await db.collection("sensor_timeseries")
      .where("buoy_id", "==", buoyId)
      .where("parameter", "==", p)
      .orderBy("timestamp_ms", "desc")
      .limit(1)
      .get();
    if (!snap.empty) {
      result[p] = Number(snap.docs[0].data().value);
      // เก็บเวลาเพื่อทำ time-features
      if (!result.__ts) result.__ts = snap.docs[0].data().timestamp_ms;
    } else {
      result[p] = null;
    }
  }));

  // ฟีเจอร์เวลา (ใช้เวลาของข้อมูลล่าสุด หากไม่มี ใช้เวลาปัจจุบัน)
  const t = result.__ts ? new Date(result.__ts) : new Date();
  const hour = t.getHours();
  const dow  = t.getDay(); // 0=Sun

  result.hour_sin = Math.sin((2 * Math.PI * hour) / 24);
  result.hour_cos = Math.cos((2 * Math.PI * hour) / 24);
  result.dow_sin  = Math.sin((2 * Math.PI * dow) / 7);
  result.dow_cos  = Math.cos((2 * Math.PI * dow) / 7);

  delete result.__ts;
  return result;
}

module.exports = { buildFeaturesForBuoy };
