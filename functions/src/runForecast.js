// functions/src/runForecast.js
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
const { getFirestore } = require("firebase-admin/firestore");
const { GoogleAuth } = require("google-auth-library");
const { buildFeaturesForBuoy } = require("../lib/feature-engineering");
const { getRainForecast } = require("../lib/weather");

const REGION = "asia-southeast1";
const TIMEZONE = "Asia/Bangkok";
const firestore = getFirestore();

// ใช้ URL ของ Cloud Run โดยตรง (ถ้าอยากปลอดภัยค่อยเปลี่ยนเป็น secret ทีหลัง)
const FORECAST_URL = "https://forecast-service-395577249681.asia-southeast1.run.app";

// Fallback พิกัด (Kasetsart)
const FALLBACK_LAT = 13.935940312670471;
const FALLBACK_LNG = 100.37948661190558;

// ----------------- helpers: local time (TH) -----------------
function fmtLocal(dt, withTime = true) {
  // คืนค่า string ภาษาไทย timeZone=Asia/Bangkok
  return withTime
    ? dt.toLocaleString("th-TH", { timeZone: TIMEZONE, hour12: false })
    : dt.toLocaleDateString("th-TH", { timeZone: TIMEZONE });
}
function toLocalDateOnlyISO(dt) {
  // date ISO (YYYY-MM-DD) ตามเวลาไทย
  const bkk = new Date(dt.toLocaleString("en-US", { timeZone: TIMEZONE }));
  const y = bkk.getFullYear();
  const m = String(bkk.getMonth() + 1).padStart(2, "0");
  const d = String(bkk.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
// ------------------------------------------------------------

async function callPredict(runUrl, features) {
  try {
    // แบบมีไอดีโทเคน (กรณีตั้งเป็น private)
    const client = await new GoogleAuth().getIdTokenClient(runUrl);
    const res = await client.request({
      url: `${runUrl}/predict`,
      method: "POST",
      data: { features },
    });
    return res.data;
  } catch {
    // fallback สำหรับ public access
    const res = await fetch(`${runUrl}/predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ features }),
    });
    if (!res.ok) throw new Error(`predict http ${res.status}`);
    return await res.json();
  }
}

async function runOnce() {
  const now = new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const nowLocal = fmtLocal(now); // เวลาไทยอ่านง่าย

  const buoys = await firestore.collection("buoy_registry").where("active", "==", true).get();
  if (buoys.empty) return;

  for (const doc of buoys.docs) {
    const buoyId = doc.id;
    const data = doc.data() || {};
    const { lat, lng } = (data.location || {});
    const LAT = typeof lat === "number" ? lat : FALLBACK_LAT;
    const LNG = typeof lng === "number" ? lng : FALLBACK_LNG;

    // 1) features ล่าสุด
    let features = {};
    try {
      features = await buildFeaturesForBuoy(buoyId);
    } catch (e) {
      console.error(`[${buoyId}] feature error:`, e?.message || e);
      continue;
    }

    // 2) เรียก ML
    let preds = {}, version = null;
    try {
      const out = await callPredict(FORECAST_URL, features);
      preds   = out?.predictions || {};
      version = out?.model_version || null;
    } catch (e) {
      console.error(`[${buoyId}] predict error:`, e?.message || e);
      continue;
    }

    // 3) พยากรณ์ฝน 3 วัน ตามพิกัดทุ่น (เวลาไทย)
    let rains = { D1:{rain_mm:null}, D2:{rain_mm:null}, D3:{rain_mm:null} };
    try {
      rains = await getRainForecast(LAT, LNG, TIMEZONE);
    } catch (e) {
      console.error(`[${buoyId}] weather error:`, e?.message || e);
    }

    // 4) เขียน weekly_forecasts
    const days = ["D1", "D2", "D3"];
    const batch = firestore.batch();

    for (const [i, h] of days.entries()) {
      // วันที่เป้าหมาย (D+1..D+3) โดยยึด “เวลาไทย”
      const d = new Date(now);
      d.setDate(d.getDate() + i + 1);

      const dateIsoUTC = d.toISOString().slice(0, 10);     // YYYY-MM-DD (ตาม UTC)
      const dateIsoTH  = toLocalDateOnlyISO(d);            // YYYY-MM-DD (ตามเวลาไทย)
      const dateLocal  = fmtLocal(d, false);               // 23/10/2568 (ไทย)

      const row = {
        buoy_id: buoyId,

        // --- วันเป้าหมาย ---
        date: dateIsoUTC,                    // เดิมไว้ก่อน (หากมี consumer ใช้)
        date_local_iso: dateIsoTH,          // YYYY-MM-DD ตามเวลาไทย
        date_local_text: dateLocal,         // รูปแบบไทยอ่านง่าย

        // --- ค่าพยากรณ์ ---
        predicted_ph:          preds[h]?.ph ?? null,
        predicted_tds:         preds[h]?.tds ?? null,
        predicted_ec:          preds[h]?.ec ?? null,
        predicted_turbidity:   preds[h]?.turbidity ?? null,
        predicted_temperature: preds[h]?.temperature ?? null,

        // --- ข้อมูลภายนอก ---
        external: { rain_mm: rains[h]?.rain_mm ?? null },

        // --- สถานะ/เมตา ---
        forecast_status: "ดี",
        model_version: version,
        source: "ml",

        // --- เวลาระบบ (UTC และ Local) ---
        created_at: new Date(nowIso),     // Firestore Timestamp (UTC)
        updated_at: new Date(nowIso),
        created_at_ms: nowMs,
        updated_at_ms: nowMs,
        created_at_iso: nowIso,
        updated_at_iso: nowIso,
        created_at_local: nowLocal,       // 22/10/2568 17:37:46
        updated_at_local: nowLocal,
      };

      const ref = firestore.collection("weekly_forecasts").doc(`${buoyId}_${dateIsoTH}`);
      batch.set(ref, row, { merge: true });
    }

    await batch.commit();
    console.log(`[${buoyId}] forecasts written (TH local time ready).`);
  }
}

// === Scheduler & Manual trigger ===
exports.runForecast = onSchedule(
  { region: REGION, schedule: "0 10 * * *", timeZone: TIMEZONE },
  async () => { await runOnce(); }
);

exports.runForecastNow = onRequest(
  { region: REGION },
  async (req, res) => {
    try {
      await runOnce();
      return res.json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok:false, error:String(e) });
    }
  }
);

async function runOnce() {
    const now = new Date();
    const buoys = await firestore.collection("buoy_registry").where("active", "==", true).get();
    if (buoys.empty) return;
  
    for (const doc of buoys.docs) {
      const buoyId = doc.id;
      const data = doc.data() || {};
      const { lat, lng } = (data.location || {});
      const LAT = typeof lat === "number" ? lat : FALLBACK_LAT;
      const LNG = typeof lng === "number" ? lng : FALLBACK_LNG;
  
      let features = {};
      try { features = await buildFeaturesForBuoy(buoyId); } catch { continue; }
  
      let preds = {}, ints = {}, version = null;
      try {
        const out = await callPredict(FORECAST_URL, features);
        preds = out?.predictions || {};
        ints  = out?.intervals || {};
        version = out?.model_version || null;
      } catch (e) {
        console.error(`[${buoyId}] predict error:`, e?.message || e);
        continue;
      }
  
      let rains = { D1:{rain_mm:null}, D2:{rain_mm:null}, D3:{rain_mm:null} };
      try { rains = await getRainForecast(LAT, LNG, TIMEZONE); } catch {}
  
      const days = ["D1", "D2", "D3"];
      const batch = firestore.batch();
      for (const [i, h] of days.entries()) {
        const d = new Date(now); d.setDate(d.getDate() + i + 1);
        const dateStr = d.toISOString().slice(0,10);
  
        const p = preds[h] || {};
        const it = ints[h]  || {};
  
        const row = {
          buoy_id: buoyId,
          date: dateStr,
  
          // ค่าทำนาย
          predicted_ph:          p.ph ?? null,
          predicted_tds:         p.tds ?? null,
          predicted_ec:          p.ec ?? null,
          predicted_turbidity:   p.turbidity ?? null,
          predicted_temperature: p.temperature ?? null,
  
          // ช่วง/ความมั่นใจ (% โอกาสอยู่ในแถบ ±TOL)
          predicted_ph_low:            it.ph?.lower ?? null,
          predicted_ph_high:           it.ph?.upper ?? null,
          predicted_ph_prob_pct:       it.ph?.prob_pct ?? null,
  
          predicted_tds_low:           it.tds?.lower ?? null,
          predicted_tds_high:          it.tds?.upper ?? null,
          predicted_tds_prob_pct:      it.tds?.prob_pct ?? null,
  
          predicted_ec_low:            it.ec?.lower ?? null,
          predicted_ec_high:           it.ec?.upper ?? null,
          predicted_ec_prob_pct:       it.ec?.prob_pct ?? null,
  
          predicted_turbidity_low:     it.turbidity?.lower ?? null,
          predicted_turbidity_high:    it.turbidity?.upper ?? null,
          predicted_turbidity_prob_pct:it.turbidity?.prob_pct ?? null,
  
          predicted_temperature_low:   it.temperature?.lower ?? null,
          predicted_temperature_high:  it.temperature?.upper ?? null,
          predicted_temperature_prob_pct: it.temperature?.prob_pct ?? null,
  
          external: { rain_mm: rains[h]?.rain_mm ?? null },
          forecast_status: "ดี",
          model_version: version,
          created_at: now, updated_at: now, source: "ml",
        };
  
        const ref = firestore.collection("weekly_forecasts").doc(`${buoyId}_${dateStr}`);
        batch.set(ref, row, { merge: true });
      }
      await batch.commit();
    }
  }