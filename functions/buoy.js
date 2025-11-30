// ====== buoy.js ======
const { onRequest } = require("firebase-functions/v2/https");
const { getApps, initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

if (!getApps().length) initializeApp();
const db = getFirestore();

// เพิ่มทุ่นใหม่
exports.addBuoy = onRequest({ region: "asia-southeast1", cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

    const { buoy_id, name, location, owner_uid } = req.body || {};
    if (!buoy_id || !name || !location || !owner_uid)
      return res.status(400).json({ error: "Missing required fields" });

    const ref = db.collection("buoys").doc(buoy_id);
    if ((await ref.get()).exists)
      return res.status(400).json({ error: "Buoy already exists" });

    await ref.set({
      buoy_id,
      name,
      location,
      owner_uid,
      status: "active",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    res.json({ success: true, message: "Buoy added successfully", buoy_id });
  } catch (err) {
    console.error("addBuoy error:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

// ดึงทุ่นทั้งหมดของผู้ใช้
exports.getBuoysByUser = onRequest({ region: "asia-southeast1", cors: true }, async (req, res) => {
  try {
    if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

    const uid = req.query.uid;
    if (!uid) return res.status(400).json({ error: "Missing uid" });

    const snapshot = await db.collection("buoys").where("owner_uid", "==", uid).get();
    const buoys = snapshot.docs.map((d) => d.data());
    res.json({ success: true, count: buoys.length, buoys });
  } catch (err) {
    console.error("getBuoysByUser error:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

// ดูรายละเอียดทุ่น
exports.getBuoyDetail = onRequest({ region: "asia-southeast1", cors: true }, async (req, res) => {
  try {
    if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

    const buoy_id = req.query.buoy_id;
    if (!buoy_id) return res.status(400).json({ error: "Missing buoy_id" });

    const doc = await db.collection("buoys").doc(buoy_id).get();
    if (!doc.exists) return res.status(404).json({ error: "Buoy not found" });

    res.json({ success: true, data: doc.data() });
  } catch (err) {
    console.error("getBuoyDetail error:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

// ===== เพิ่มต่อท้ายไฟล์ buoy.js =====

// อัปเดตข้อมูลทุ่น (name/location/note/status)
exports.updateBuoy = onRequest({ region: "asia-southeast1", cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

    const { buoy_id, name, location, note, status } = req.body || {};
    if (!buoy_id) return res.status(400).json({ error: "Missing buoy_id" });

    const ref = db.collection("buoys").doc(buoy_id);
    const patch = { updated_at: new Date().toISOString() };
    if (name !== undefined) patch.name = String(name || "");
    if (location !== undefined) patch.location = location || null;
    if (note !== undefined) patch.note = String(note || "");
    if (status !== undefined) patch.status = String(status || "active");

    await ref.set(patch, { merge: true });
    res.json({ success: true, message: "Buoy updated", buoy_id, patch });
  } catch (err) {
    console.error("updateBuoy error:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

// ลบทุ่น
exports.deleteBuoy = onRequest({ region: "asia-southeast1", cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

    const { buoy_id } = req.body || {};
    if (!buoy_id) return res.status(400).json({ error: "Missing buoy_id" });

    await db.collection("buoys").doc(buoy_id).delete();
    // หมายเหตุ: ถ้าต้องการลบข้อมูลใน RTDB/Firestore อื่น ๆ เพิ่มเติม ให้ไปลบใน index.js ที่เคยทำไว้
    res.json({ success: true, message: "Buoy deleted", buoy_id });
  } catch (err) {
    console.error("deleteBuoy error:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

// ตั้ง expected sensors / timeouts ลง RTDB (สำหรับการตรวจ missing)
const { getDatabase } = require("firebase-admin/database");
const rtdb = getDatabase();

exports.setExpectedSensors = onRequest({ region: "asia-southeast1", cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

    const { buoy_id, expected_params, hard_missing_ms, missing_timeout_ms } = req.body || {};
    if (!buoy_id) return res.status(400).json({ error: "Missing buoy_id" });

    const patch = { updated_at_ms: Date.now() };
    if (Array.isArray(expected_params)) patch.expected_params = expected_params.map(String);
    if (hard_missing_ms !== undefined) patch.hard_missing_ms = Number(hard_missing_ms) || 3600000;
    if (missing_timeout_ms !== undefined) patch.missing_timeout_ms = Number(missing_timeout_ms) || 600000;

    await rtdb.ref(`/buoys/${buoy_id}/settings`).update(patch);
    res.json({ success: true, message: "Settings updated", buoy_id, applied: patch });
  } catch (err) {
    console.error("setExpectedSensors error:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

// ลิสต์ทุ่น (รองรับค้นด้วย q ที่ชื่อ/ไอดี)
exports.listBuoys = onRequest({ region: "asia-southeast1", cors: true }, async (req, res) => {
  try {
    if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

    const q = String(req.query.q || "").toLowerCase();
    const snap = await db.collection("buoys").orderBy("updated_at", "desc").limit(200).get();
    const items = snap.docs
      .map(d => d.data())
      .filter(d =>
        !q ||
        (String(d.name || "").toLowerCase().includes(q)) ||
        (String(d.buoy_id || "").toLowerCase().includes(q))
      );

    res.json({ success: true, count: items.length, items });
  } catch (err) {
    console.error("listBuoys error:", err);
    res.status(500).json({ error: "internal_error" });
  }
});
