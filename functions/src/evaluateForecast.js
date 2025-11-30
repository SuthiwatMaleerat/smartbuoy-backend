// functions/src/evaluateForecast.js
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
const { getFirestore } = require("firebase-admin/firestore");

const REGION = "asia-southeast1";
const TIMEZONE = "Asia/Bangkok";
const db = getFirestore();

const TOL = { ph: 0.1, tds: 10, ec: 10, turbidity: 0.5, temperature: 0.5 };

function localDayRangeMs(dateStr, tz = TIMEZONE) {
  const s = new Date(`${dateStr}T00:00:00`);
  const e = new Date(`${dateStr}T23:59:59.999`);
  const toUtcMs = (d) => new Date(d.toLocaleString("en-US", { timeZone: tz })).getTime();
  return { startMs: toUtcMs(s), endMs: toUtcMs(e) };
}
function todayLocalISO() {
  const loc = new Date(new Date().toLocaleString("en-US", { timeZone: TIMEZONE }));
  const y = loc.getFullYear();
  const m = String(loc.getMonth() + 1).padStart(2, "0");
  const d = String(loc.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
async function fetchActualDaily(buoyId, dateStr) {
  const { startMs, endMs } = localDayRangeMs(dateStr);
  const qs = await db.collection("sensor_timeseries")
    .where("buoy_id", "==", buoyId)
    .where("timestamp_ms", ">=", startMs)
    .where("timestamp_ms", "<=", endMs)
    .get();
  if (qs.empty) return {};
  const agg = {};
  qs.forEach(doc => {
    const r = doc.data();
    const p = r.parameter, v = Number(r.value);
    if (!isFinite(v)) return;
    if (!agg[p]) agg[p] = { sum: 0, count: 0 };
    agg[p].sum += v; agg[p].count += 1;
  });
  const out = {};
  Object.keys(agg).forEach(k => out[k] = agg[k].sum / agg[k].count);
  return out;
}
function calcPerParam(preds, actuals) {
  const params = ["ph", "tds", "ec", "turbidity", "temperature"];
  const per = {}; let hit = 0, total = 0;
  for (const p of params) {
    const pred = preds?.[p] ?? null, act = actuals?.[p] ?? null;
    if (pred == null || act == null) continue;
    total += 1;
    const absErr = Math.abs(act - pred);
    const tol = TOL[p] ?? 1;
    const hitTol = absErr <= tol;
    const accPct = Math.max(0, Math.min(1, 1 - absErr / tol)) * 100;
    if (hitTol) hit += 1;
    per[p] = {
      actual: Number(act.toFixed(3)),
      predicted: Number(pred.toFixed(3)),
      abs_err: Number(absErr.toFixed(3)),
      tol, hit_tol: hitTol, accuracy_pct: Math.round(accPct),
    };
  }
  return { per, hitRatePct: total ? Math.round((hit / total) * 100) : null, compared: total };
}

// ----- ฟังก์ชันกลาง ใช้ได้ทั้ง scheduler และ HTTP -----
async function evaluateOnce({ dateTH, onlyBuoyId } = {}) {
  const dateStr = dateTH || todayLocalISO();
  const nowLocalText = new Date().toLocaleString("th-TH", { timeZone: TIMEZONE, hour12: false });

  // หาเอกสาร forecast ของวันนั้น (หรือกรองเฉพาะ buoy)
  let q = db.collection("weekly_forecasts").where("date_local_iso", "==", dateStr);
  if (onlyBuoyId) q = q.where("buoy_id", "==", onlyBuoyId);
  const qs = await q.get();
  if (qs.empty) return { date: dateStr, updated: 0, message: "no forecasts" };

  let updated = 0;
  for (const doc of qs.docs) {
    const f = doc.data();
    const buoyId = f.buoy_id;
    const preds = {
      ph: f.predicted_ph ?? null,
      tds: f.predicted_tds ?? null,
      ec: f.predicted_ec ?? null,
      turbidity: f.predicted_turbidity ?? null,
      temperature: f.predicted_temperature ?? null,
    };

    const actuals = await fetchActualDaily(buoyId, dateStr);
    const ev = calcPerParam(preds, actuals);

    const flat = {};
    ["ph","tds","ec","turbidity","temperature"].forEach(p => {
      const r = ev.per[p]; if (!r) return;
      flat[`actual_${p}`] = r.actual;
      flat[`predicted_${p}`] = r.predicted;
      flat[`abs_err_${p}`] = r.abs_err;
      flat[`accuracy_${p}_pct`] = r.accuracy_pct;
      flat[`hit_${p}_tol`] = r.hit_tol;
      flat[`tol_${p}`] = r.tol;
    });

    await doc.ref.set({
      ...flat,
      eval_details: ev.per,
      hit_rate_pct: ev.hitRatePct,
      compared_params: ev.compared,
      evaluated_at: new Date(),
      evaluated_at_local: nowLocalText,
    }, { merge: true });

    updated += 1;
    console.log(`[${buoyId}] ${dateStr} | hit_rate=${ev.hitRatePct}% params=${ev.compared}`);
  }
  return { date: dateStr, updated };
}

// ----- Scheduler (อัตโนมัติทุกวัน 22:30 ไทย) -----
exports.evaluateForecast = onSchedule(
  { region: REGION, schedule: "30 22 * * *", timeZone: TIMEZONE },
  async () => { await evaluateOnce(); }
);

// ----- HTTP manual trigger (วิธีทดสอบ) -----
// รองรับ query: ?date=YYYY-MM-DD&buoy_id=buoy_001
exports.evaluateForecastNow = onRequest(
  { region: REGION },
  async (req, res) => {
    try {
      const dateTH = typeof req.query.date === "string" ? req.query.date : undefined;
      const onlyBuoyId = typeof req.query.buoy_id === "string" ? req.query.buoy_id : undefined;
      const out = await evaluateOnce({ dateTH, onlyBuoyId });
      res.json({ ok: true, ...out });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: String(e) });
    }
  }
);
