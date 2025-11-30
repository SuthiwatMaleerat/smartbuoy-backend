// =======================================================
// Smart Buoy System — Version A (Alert-aware Scheduler)
// - Ingest = คำนวณคะแนน + critical/warning alerts (ทุกครั้งที่มีค่าเข้า)
// - Scheduler = ตัดสิน online/offline + missing alerts (รอบละ 10 นาที หรือกำหนดใน system_settings/scheduler)
// - ใส่ timestamp_local (Asia/Bangkok) ทุกที่ที่สำคัญ
// - ไม่มี RTDB triggers เพื่อให้ระบบเรียบง่ายตามที่ตกลง
// =======================================================


const { onRequest } = require("firebase-functions/v2/https");
 const { onSchedule } = require("firebase-functions/v2/scheduler");
 const { initializeApp, getApps } = require("firebase-admin/app"); 
const { getFirestore } = require("firebase-admin/firestore"); 
const { getDatabase } = require("firebase-admin/database"); 
const { getAuth } = require("firebase-admin/auth");


// โมดูลคำนวณคะแนน (อย่าลบ/แก้ในไฟล์นี้ คุณปรับใน lib/scoring.js แล้ว)
const { calculateScore } = require("./lib/scoring");

// -------- Initialize Admin --------
if (!getApps().length) initializeApp();
const firestore = getFirestore();
firestore.settings({ ignoreUndefinedProperties: true });
const rtdb      = getDatabase();
const auth      = getAuth();

// -------- นำเข้าฟังก์ชัน auth & buoy (คงชื่อเดิม) --------
Object.assign(exports, require("./auth"));
Object.assign(exports, require("./buoy"));

// ===== Defaults / Constants =====
const DEFAULT_EXPECTED_PARAMS = ["ph", "tds", "ec", "turbidity", "temperature", "rainfall"];
const DEFAULT_MISSING_TIMEOUT_MS = 60 * 1000;          // 1 นาที (สำหรับ "missing" ภายในรอบ)
const DEFAULT_OFFLINE_AFTER_MIN  = 30;                 // 30 นาที (ตัดสิน offline)
const HARD_STOP_IF_ANY_MISSING_FOR_MS = 60 * 60 * 1000; // 1 ชม. (สำรอง policy)

// ===== Helpers (Auth/Response) =====
async function getUserFromReq(req) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) {
    const e = new Error("unauthenticated");
    e.code = 401;
    throw e;
  }
  const token = h.split("Bearer ")[1];
  return await auth.verifyIdToken(token, true);
}
const ok  = (res, payload) => res.status(200).json(payload);
const err = (res, code, message) => res.status(code).json({ error: message });

// ===== Time helpers =====
function toMs(anyTs) {
  if (anyTs == null) return Date.now();
  if (typeof anyTs === "number") return anyTs < 1e11 ? anyTs * 1000 : anyTs;
  if (typeof anyTs === "string") {
    const n = Number(anyTs);
    if (!Number.isNaN(n)) return n < 1e11 ? n * 1000 : n;
    const ms = Date.parse(anyTs);
    return Number.isNaN(ms) ? Date.now() : ms;
  }
  return Date.now();
}
function normalizeTs(maybeTs) {
  const ms = toMs(maybeTs);
  return { timestamp_ms: ms, timestamp_iso: new Date(ms).toISOString() };
}
function formatLocal(ms, tz = "Asia/Bangkok") {
  const d = new Date(ms);
  const dateParts = new Intl.DateTimeFormat("th-TH", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(d);
  const timeParts = new Intl.DateTimeFormat("th-TH", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).formatToParts(d);
  const get = (parts, type) => parts.find(p => p.type === type)?.value || "";
  const year  = (get(dateParts, "year") || "").padStart(4, "0");
  const month = (get(dateParts, "month") || "").padStart(2, "0");
  const day   = (get(dateParts, "day") || "").padStart(2, "0");
  const hour  = (get(timeParts, "hour") || "").padStart(2, "0");
  const min   = (get(timeParts, "minute") || "").padStart(2, "0");
  const sec   = (get(timeParts, "second") || "").padStart(2, "0");
  return {
    dayKey: `${year}-${month}-${day}`,
    localStr: `${year}-${month}-${day} ${hour}:${min}:${sec} ${tz}`,
    hhmm: `${hour}:${min}`,
  };
}

// ===== Config (rules/messages) from Firestore =====
let _cfgCache = null;
let _cfgCacheAt = 0;
async function loadConfig() {
  const now = Date.now();
  if (_cfgCache && now - _cfgCacheAt < 60 * 1000) return _cfgCache;
  try {
    const snap = await firestore.collection("system_config").doc("water_quality_rules").get();
    _cfgCache = snap.exists ? snap.data() : {};
  } catch {
    _cfgCache = {};
  }
  _cfgCacheAt = now;
  return _cfgCache;
}

// ===== Critical quick checks =====
function resolveCriticalOverride(sv) {
  if (sv?.ph != null && (sv.ph < 6.0 || sv.ph > 9.0)) {
    return { isCritical: true, parameter: "ph", reason: "pH นอกช่วงปลอดภัย (<6.0 หรือ >9.0)" };
  }
  if (sv?.tds != null && sv.tds > 900) {
    return { isCritical: true, parameter: "tds", reason: "TDS สูงกว่า 900 ppm" };
  }
  if (sv?.ec != null && sv.ec > 1343) {
    return { isCritical: true, parameter: "ec", reason: "EC สูงกว่า 1343 µS/cm" };
  }
  if (sv?.turbidity != null && sv.turbidity > 100) {
    return { isCritical: true, parameter: "turbidity", reason: "ความขุ่นสูงกว่า 100 NTU" };
  }
  if (sv?.temperature != null && (sv.temperature < 23 || sv.temperature > 33)) {
    return { isCritical: true, parameter: "temperature", reason: "อุณหภูมิผิดปกติ (<23 หรือ >33 °C)" };
  }
  if (sv?.rainfall != null && sv.rainfall >= 0 && sv.rainfall <= 341) {
    return { isCritical: true, parameter: "rainfall", reason: "ปริมาณฝน 0–341 mV — สถานการณ์รุนแรง" };
  }
  return { isCritical: false };
}

// ===== Logger =====
async function logSystemActivity(type, details) {
  try {
    await firestore.collection("system_logs").doc(`log_${Date.now()}_${type}`).set({
      type,
      timestamp: new Date().toISOString(),
      details,
      source: "cloud_functions",
    });
  } catch (e) {
    console.warn("logSystemActivity failed:", e?.message || e);
  }
}

// ===== RTDB history writer =====
async function writeRtdbHistory(buoyId, sensorData) {
  const ms  = sensorData.timestamp_ms ?? toMs(sensorData.timestamp);
  const iso = sensorData.timestamp_iso ?? new Date(ms).toISOString();
  const { dayKey, localStr, hhmm } = formatLocal(ms, "Asia/Bangkok");

  const entry = {
    timestamp_ms: ms,
    timestamp_iso: iso,
    timestamp_local: localStr,
    time_hhmm: hhmm,
  };
  ["ph","tds","ec","turbidity","temperature","rainfall","total_score"].forEach(k => {
    if (sensorData[k] != null) entry[k] = sensorData[k];
  });

  await rtdb.ref(`/buoys/${buoyId}/history/${dayKey}/${ms}`).set(entry);
}

// ===== Per-buoy settings =====
async function loadBuoySettings(buoyId) {
  const snap = await rtdb.ref(`/buoys/${buoyId}/settings`).get();
  const settings = snap.val() || {};
  const expected_params =
    Array.isArray(settings.expected_params) && settings.expected_params.length
      ? settings.expected_params
      : DEFAULT_EXPECTED_PARAMS;
  const missing_timeout_ms =
    typeof settings.missing_timeout_ms === "number" && settings.missing_timeout_ms > 0
      ? settings.missing_timeout_ms
      : DEFAULT_MISSING_TIMEOUT_MS;
  const offline_after_minutes =
    typeof settings.offline_after_minutes === "number" && settings.offline_after_minutes > 0
      ? settings.offline_after_minutes
      : DEFAULT_OFFLINE_AFTER_MIN;
  return { expected_params, missing_timeout_ms, offline_after_minutes };
}

/* ==================================================================== */
/* (0) HEALTH                                                            */
/* ==================================================================== */
exports.healthCheck = onRequest({ region: "asia-southeast1", cors: true }, async (_req, res) => {
  return ok(res, { status: "ok", ts: Date.now() });
});

/* ==================================================================== */
/* (1) INGEST: คำนวณคะแนน + บันทึกประวัติ + สร้าง Sensor Alerts ใหม่ */
/* ==================================================================== */

// ===== NEW Alert Model Writer =====
async function writeAlert({
  buoy_id,
  uid,
  category,
  severity,
  parameter = null,
  value = null,
  message,
  reason = null,
  ref_date = null,
  origin = "ingest",
}) {
  const ms = Date.now();
  const payload = {
    buoy_id,
    uid,
    category,
    severity,
    parameter,
    value,
    message,
    reason,
    ref_date,
    status: "active",
    origin,
    timestamp_ms: ms,
    timestamp_local: formatLocal(ms).localStr,
    created_at: new Date().toISOString(),
  };

  try {
    await firestore.collection("alerts").add(payload);
  } catch (err) {
    console.error("🔥 writeAlert failed:", err);
  }
}


// ===== NEW WQI Log Writer =====
async function writeWqiLog({
  buoy_id,
  uid,
  total_score,
  status,
  breakdown,
  raw_values,
  timestamp_ms,
}) {
  const payload = {
    buoy_id,
    uid,
    total_score,
    status,
    breakdown,
    raw_values,
    timestamp_ms,
    timestamp_local: formatLocal(timestamp_ms).localStr,
    created_at: new Date().toISOString(),
  };

  try {
    await firestore.collection("wqi_logs").add(payload);
  } catch (err) {
    console.error("🔥 writeWqiLog failed:", err);
  }
}


/* ==================================================================== */
async function resolveUid(buoy_id, sensors) {
  if (sensors?.uid) return sensors.uid;

  // หาใน buoy_registry
  const reg = await firestore.collection("buoy_registry").doc(buoy_id).get();
  const data = reg.data();
  return data?.uid || null; // ถ้ายังไม่มี user ผูกทุ่น ก็เก็บเป็น null ได้
}
/* ==================================================================== */
/* Ingest Function                                                      */
/* ==================================================================== */
exports.ingestSensorData = onRequest(
  { region: "asia-southeast1", cors: true },
  async (req, res) => {
    try {
      if (req.method !== "POST") return err(res, 405, "Method Not Allowed");

      const { buoy_id, sensors, device_time_ms } = req.body || {};
      if (!buoy_id || !sensors || typeof sensors !== "object") {
        return err(res, 400, "Missing buoy_id or sensors");
      }

      const { timestamp_ms, timestamp_iso } = normalizeTs(device_time_ms ?? Date.now());
      const nowLocal = formatLocal(Date.now()).localStr;

      // ===================== (1) Save current + last_seen =====================
      const payload = {
        ...sensors,
        timestamp_ms,
        timestamp_iso,
        timestamp_local: formatLocal(timestamp_ms).localStr,
        last_payload_keys: Object.keys(sensors),
        last_source: "ingest_pack",
        last_writer_at_iso: new Date().toISOString(),
        last_writer_at_local: nowLocal,
      };
      await rtdb.ref(`/buoys/${buoy_id}/sensors/current`).update(payload);

      const updates = {};
      for (const [k, v] of Object.entries(sensors)) {
        if (v != null && !Number.isNaN(v)) updates[k] = timestamp_ms;
      }
      if (Object.keys(updates).length) {
        await rtdb.ref(`/buoys/${buoy_id}/sensors/last_seen`).update(updates);
      }


      // ================= (2) Mirror into Firestore timeseries =================
      const batch = firestore.batch();
      const tsCol = firestore.collection("sensor_timeseries");
      for (const [key, val] of Object.entries(sensors)) {
        if (val != null && !Number.isNaN(val)) {
          batch.set(tsCol.doc(), {
            buoy_id,
            parameter: key,
            value: val,
            timestamp_ms,
            timestamp_iso,
            timestamp_local: formatLocal(timestamp_ms).localStr,
            created_at: timestamp_iso,
            created_at_local: nowLocal,
          });
        }
      }


      // ===================== (3) Calculate WQI Score =====================
      const cfg = await loadConfig();
      const { totalScore, details, status } = calculateScore(
        {
          ph: sensors.ph,
          tds: sensors.tds,
          ec: sensors.ec,
          turbidity: sensors.turbidity,
          temperature: sensors.temperature,
          rainfall: sensors.rainfall,
        },
        cfg
      );
      // ✅ Ensure uid exists
      const uid = await resolveUid(buoy_id, sensors);


      // ---- Write WQI Logs (Firestore) ----
      await writeWqiLog({
        buoy_id,
        uid,
        total_score: Number(totalScore.toFixed(2)),
        status,
        breakdown: details,
        raw_values: sensors,
        timestamp_ms,
      });

      // ---- Write RTDB History ----
      await writeRtdbHistory(buoy_id, {
        ...sensors,
        timestamp_ms,
        timestamp_iso,
        total_score: totalScore,
      });


      // ===================== (4) Check sensor alert levels =====================
      function judgeLevel(param, val) {
        if (val == null || Number.isNaN(val)) return null;
        switch (param) {
          case "ph":
            if (val < 6.0 || val > 9.0)
              return { severity: "critical", reason: "pH นอกช่วงปลอดภัย" };
            if (val <= 6.4 || val >= 8.6)
              return { severity: "warning", reason: "pH ระดับเตือน" };
            return null;

          case "tds":
            if (val > 900)
              return { severity: "critical", reason: "TDS สูงผิดปกติ" };
            if (val > 600)
              return { severity: "warning", reason: "TDS ควรเฝ้าระวัง" };
            return null;

          case "ec":
            if (val > 1343)
              return { severity: "critical", reason: "EC สูงผิดปกติ" };
            if (val > 895)
              return { severity: "warning", reason: "EC ควรเฝ้าระวัง" };
            return null;

          case "turbidity":
            if (val > 100)
              return { severity: "critical", reason: "ความขุ่นสูงผิดปกติ" };
            if (val > 25)
              return { severity: "warning", reason: "ความขุ่นควรเฝ้าระวัง" };
            return null;

          case "temperature":
            if (val < 23 || val > 33)
              return { severity: "critical", reason: "อุณหภูมิน้ำผิดปกติ" };
            if (val <= 25 || val >= 31)
              return { severity: "warning", reason: "อุณหภูมิ ควรเฝ้าระวัง" };
            return null;

          case "rainfall":
            if (val <= 341)
              return { severity: "critical", reason: "ฝนรุนแรง" };
            if (val <= 682)
              return { severity: "warning", reason: "ฝนมากควรระวัง" };
            return null;
        }
      }


      // ===================== (5) Create Alerts (New Standard) =====================
      const paramsToCheck = ["ph", "tds", "ec", "turbidity", "temperature", "rainfall"];

      for (const param of paramsToCheck) {
        const val = sensors[param];
        const result = judgeLevel(param, val);
        if (!result) continue;

        await writeAlert({
          buoy_id,
          uid,
          category: "sensor",
          severity: result.severity,
          parameter: param,
          value: val,
          message: `${param.toUpperCase()} ผิดปกติระดับ ${result.severity}`,
          reason: result.reason,
          origin: "ingest",
        });
      }


      // ===== Commit Batch for timeseries =====
      await batch.commit();

      return ok(res, { success: true, buoy_id, timestamp_ms });


    } catch (e) {
      console.error("🔥 ingestSensorData error:", e);
      return err(res, 500, e.message || "internal_error");
    }
  }
);



/* ==================================================================== */
/* (2) STATUS API + HISTORY                                              */
/* ==================================================================== */
exports.getBuoyStatus = onRequest({ region: "asia-southeast1", cors: true }, async (req, res) => {
  try {
    const { buoyId } = req.query;
    if (!buoyId) return err(res, 400, "Missing buoyId");

    const currentSnap = await rtdb.ref(`/buoys/${buoyId}/sensors/current`).get();
    const current = currentSnap.val();
    if (!current) return err(res, 404, "Buoy not found or no data");

    const { expected_params, offline_after_minutes } = await loadBuoySettings(buoyId);
    const lastSeenSnap = await rtdb.ref(`/buoys/${buoyId}/sensors/last_seen`).get();
    const lastSeen = lastSeenSnap.val() || {};
    const now = Date.now();
    const offline_ms = offline_after_minutes * 60 * 1000;

    const debug_missing_calc = {};
    const missing = [];
    for (const p of expected_params) {
      const hasValueInCurrent = Object.prototype.hasOwnProperty.call(current || {}, p);
      const last = (typeof lastSeen[p] === "number")
        ? lastSeen[p]
        : (hasValueInCurrent ? (current.timestamp_ms || 0) : 0);
      const age = now - last;
      const isMissing = age > offline_ms;
      debug_missing_calc[p] = {
        last_seen: lastSeen[p] ?? null,
        used_last: last,
        age_ms: age,
        age_local: formatLocal(now).localStr,
        hasValueInCurrent,
        isMissing
      };
      if (isMissing) missing.push(p);
    }

    const status = (missing.length > 0) ? "offline" : "online";

    const alertsSnap = await firestore
      .collection("alerts").where("buoy_id", "==", String(buoyId))
      .orderBy("timestamp_ms", "desc").limit(5).get();
    const recentAlerts = alertsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    ok(res, {
      buoy_id: buoyId,
      status,
      missing_params: missing,
      last_update_ms: current.timestamp_ms ?? null,
      last_update_iso: current.timestamp_iso ?? null,
      last_update_local: current.timestamp_local ?? null,
      sensor_data: current,
      recent_alerts: recentAlerts,
      settings: { expected_params, offline_after_minutes },
      debug_missing_calc
    });
  } catch (e) { err(res, 500, "Internal server error"); }
});

// Firestore timeseries (มี fallback ถ้ายังไม่มี index)
exports.getSensorHistoryFS = onRequest({ region: "asia-southeast1", cors: true }, async (req, res) => {
  try {
    const buoyId = String(req.query.buoyId || "");
    const param  = String(req.query.param || "ph");
    const limit  = Math.min(Number(req.query.limit || 200), 2000);
    if (!buoyId) return res.status(400).json({ error: "Missing buoyId" });

    const q = firestore.collection("sensor_timeseries")
      .where("buoy_id","==",buoyId)
      .where("parameter","==",param)
      .orderBy("timestamp_ms","desc")
      .limit(limit);

    try {
      const snap = await q.get();
      const items = snap.docs.map(d => ({
        ts_ms: d.get("timestamp_ms"),
        ts_iso: d.get("timestamp_iso"),
        ts_local: d.get("timestamp_local") || null,
        value: d.get("value") ?? null
      }));
      return res.json({ buoy_id: buoyId, parameter: param, count: items.length, items });
    } catch (e) {
      console.warn("getSensorHistoryFS primary query failed. Fallback path:", e?.message);
      const fallbackSnap = await firestore.collection("sensor_timeseries")
        .where("buoy_id","==",buoyId)
        .orderBy("timestamp_ms","desc")
        .limit(Math.max(limit * 3, 500))
        .get();

      const all = fallbackSnap.docs
        .filter(d => d.get("parameter") === param)
        .slice(0, limit)
        .map(d => ({
          ts_ms: d.get("timestamp_ms"),
          ts_iso: d.get("timestamp_iso"),
          ts_local: d.get("timestamp_local") || null,
          value: d.get("value") ?? null
        }));
      return res.json({ buoy_id: buoyId, parameter: param, count: all.length, items: all, fallback: true });
    }
  } catch (e) {
    console.error("getSensorHistoryFS error:", e);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/* ==================================================================== */
/* (3) SCHEDULER: ตรวจสถานะ Sensor + รวมสถานะทุ่น                      */
/* ==================================================================== */

exports.refreshBuoyStatus = onSchedule(
  {
    schedule: "every 10 minutes",
    timeZone: "Asia/Bangkok",
    region: "asia-southeast1",
  },
  async () => {

    const cfgSnap = await firestore.collection("system_settings").doc("scheduler").get();
    const cfg = cfgSnap.exists ? cfgSnap.data() : {};

    const paused = cfg.paused ?? false;
    const globalOfflineAfterMin = cfg.offline_after_minutes ?? 30;
    const cooldownMin = cfg.missing_repeat_minutes ?? 360; // default 6 hours
    const cooldownMs = cooldownMin * 60 * 1000;

    if (paused) {
      await logSystemActivity("refresh_status_paused", { cfg });
      return null;
    }

    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const nowLocal = formatLocal(now).localStr;

    // โหลด Buoy ทั้งหมดจาก Registry
    const regSnap = await firestore.collection("buoy_registry").get();
    const buoys = regSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    for (const b of buoys) {
      const buoyId = b.buoy_id || b.id;
      const uid = b.uid || null; // ✅ ให้ Scheduler ใช้ uid จาก Registry

      try {
        const [settingsSnap, currentSnap, lastSeenSnap, statusSnap] = await Promise.all([
          rtdb.ref(`/buoys/${buoyId}/settings`).get(),
          rtdb.ref(`/buoys/${buoyId}/sensors/current`).get(),
          rtdb.ref(`/buoys/${buoyId}/sensors/last_seen`).get(),
          rtdb.ref(`/buoys/${buoyId}/status`).get(),
        ]);

        const s = settingsSnap.val() || {};
        const expected = s.expected_params || ["ph", "tds", "ec", "turbidity", "temperature", "rainfall"];
        const offlineAfterMin =
          (typeof s.offline_after_minutes === "number" && s.offline_after_minutes > 0)
            ? s.offline_after_minutes
            : globalOfflineAfterMin;

        const offlineMs = offlineAfterMin * 60 * 1000;

        const current = currentSnap.val() || {};
        const lastSeen = lastSeenSnap.val() || {};
        const prev = statusSnap.val() || {};

        let missingParams = [];
        const sensorStatus = {};

        // ตรวจรายเซนเซอร์
        for (const p of expected) {
          const last = lastSeen[p] ?? 0;
          const delta = now - last;

          if (delta > offlineMs * 2) sensorStatus[p] = "offline";
          else if (delta > offlineMs) sensorStatus[p] = "delayed";
          else sensorStatus[p] = "online";

          if (sensorStatus[p] !== "online") missingParams.push(p);
        }

        const overall = missingParams.length > 0 ? "offline" : "online";
        const prevState = prev.state || "unknown";
        const lastMissingAlertMs = prev.last_missing_alert_ms || 0;

        const statusRef = rtdb.ref(`/buoys/${buoyId}/status`);

        // บันทึกสถานะลง RTDB
        await statusRef.set({
          state: overall,
          per_sensor: sensorStatus,
          missing_params: missingParams,
          last_checked_ms: now,
          last_checked_iso: nowIso,
          last_checked_local: nowLocal,
        });


        // ================= Alerts Logic =================

        // ❌ No change → skip unless cooldown
        if (prevState === overall) {
          if (overall === "offline" && now - lastMissingAlertMs >= cooldownMs) {

            await writeAlert({
              buoy_id: buoyId,
              uid,
              category: "status",
              severity: "warning",
              message: `ทุ่น ${buoyId} ยัง offline`,
              reason: missingParams.join(", "),
              origin: "scheduler",
            });

            await statusRef.update({
              last_missing_alert_ms: now,
              last_missing_alert_local: nowLocal,
            });
          }
        }

        // ✅ State changed → Create Alert
        else {
          await writeAlert({
            buoy_id: buoyId,
            uid,
            category: "status",
            severity: (overall === "offline" ? "critical" : "info"),
            message: (overall === "offline")
              ? `ทุ่น ${buoyId} offline`
              : `ทุ่น ${buoyId} online`,
            reason: (overall === "offline" ? missingParams.join(", ") : null),
            origin: "scheduler",
          });

          await statusRef.update({
            last_missing_alert_ms: (overall === "offline" ? now : null),
            last_missing_alert_local: (overall === "offline" ? nowLocal : null),
          });
        }


        // Mirror to Firestore
        await firestore.collection("buoy_registry").doc(buoyId).set({
          status: overall,
          per_sensor: sensorStatus,
          updated_at_ms: now,
          updated_at_local: nowLocal,
        }, { merge: true });


      } catch (err) {
        console.error(`[Scheduler] buoy ${buoyId} error:`, err);
      }
    }

    await logSystemActivity("refresh_status_done", {
      count: buoys.length,
      at_ms: now,
      at_iso: nowIso,
      at_local: nowLocal,
      cfg_applied: {
        offline_after_minutes: globalOfflineAfterMin,
        missing_repeat_minutes: cooldownMin,
      },
    });
  }
);





// --- Daily Forecast & Evaluation ---
exports.dailyForecastAndEvaluate = onSchedule(
  {
    schedule: "0 0 * * *",
    timeZone: "Asia/Bangkok",
    region: "asia-southeast1",
  },
  async () => {
    const BUOY_ID = "buoy_001";
    const BASE_URL = "https://forecast-service-395577249681.asia-southeast1.run.app";

    console.log("🌤️ [Scheduler] dailyForecastAndEvaluate started");

    try {
      // 1) Run forecast (POST /forecast/{buoy_id})
      const fcRes = await fetch(`${BASE_URL}/forecast/${BUOY_ID}`, { method: "POST" });
      const fcText = await fcRes.text();
      console.log("✅ Forecast response:", fcText);

      // 2) Run evaluation for yesterday (POST /evaluate/daily/{buoy_id}?date=YYYY-MM-DD)
      const y = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
      const evRes = await fetch(`${BASE_URL}/evaluate/daily/${BUOY_ID}?date=${y}`, { method: "POST" });
      const evText = await evRes.text();
      console.log("📊 Evaluation response:", evText);

      console.log("🏁 Finished daily forecast & evaluation successfully.");
    } catch (err) {
      console.error("❌ dailyForecastAndEvaluate failed:", err);
    }
  }
);

Object.assign(exports, require("./line"));
