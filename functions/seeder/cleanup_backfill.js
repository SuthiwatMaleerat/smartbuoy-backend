// cleanup_backfill.js
// ล้างข้อมูลย้อนหลัง (Firestore: sensor_timeseries, alerts) + (RTDB: /buoys/{id}/history)
// รองรับปี พ.ศ. ใน RTDB dayKey (เช่น 2568-10-10)

import fs from "node:fs";
import process from "node:process";
import { initializeApp, applicationDefault, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getDatabase } from "firebase-admin/database";

// ---------- CLI ----------
function getArg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  if (!v || v.startsWith("--")) return true;
  return v;
}
const project = String(getArg("--project", process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "")).trim();
const buoyId  = String(getArg("--buoy", "")).trim();
const fromStr = String(getArg("--from", "")).trim();
const toStr   = String(getArg("--to", "")).trim();
const dryRun  = !!getArg("--dry-run", false);
const creds   = getArg("--creds", "");
const dbUrl   = getArg("--dbUrl", project ? `https://${project}-default-rtdb.asia-southeast1.firebasedatabase.app` : "");
const onlyArg = getArg("--only", "alerts,timeseries,history");
const ONLY    = new Set(String(onlyArg).split(",").map(s => s.trim()).filter(Boolean));

if (!project || !buoyId || !fromStr || !toStr) {
  console.error(`Usage:
  node cleanup_backfill.js \\
    --project smart-buoy-system-d96cb \\
    --buoy buoy_001 \\
    --from "2025-10-01T00:00:00+07:00" \\
    --to   "2025-10-17T23:59:59+07:00" \\
    [--dry-run] [--creds path/to/serviceAccount.json] [--dbUrl <rtdb-url>] [--only alerts,timeseries,history]
`);
  process.exit(1);
}

// ---------- Time helpers ----------
function parseMs(s) {
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new Error(`Invalid time string: ${s}`);
  return ms;
}
const startMs = parseMs(fromStr);
const endMs   = parseMs(toStr);
if (endMs < startMs) throw new Error("`--to` must be >= `--from`");

// dayKey แบบระบบ: ปี พ.ศ. + Asia/Bangkok
function thaiDayKeyFromMs(ms) {
  const d = new Date(ms);
  const parts = new Intl.DateTimeFormat("th-TH", {
    timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(d);
  const pick = (t) => parts.find(p => p.type === t)?.value || "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`; // เช่น 2568-10-10
}
// แปลง dayKey พ.ศ. → ช่วงเวลาจริง (UTC ms) ของวันนั้นในเวลาไทย
function thaiDayKeyToUtcRange(dk /* '2568-10-10' */) {
  const [thYear, mm, dd] = dk.split("-").map(s => parseInt(s, 10));
  const gregYear = thYear - 543; // พ.ศ. → ค.ศ.
  const start = Date.parse(`${gregYear}-${String(mm).padStart(2,"0")}-${String(dd).padStart(2,"0")}T00:00:00+07:00`);
  const end   = Date.parse(`${gregYear}-${String(mm).padStart(2,"0")}-${String(dd).padStart(2,"0")}T23:59:59.999+07:00`);
  return [start, end];
}

// ---------- Admin init ----------
function loadCredential() {
  if (creds && fs.existsSync(creds)) {
    const sa = JSON.parse(fs.readFileSync(creds, "utf8"));
    return cert(sa);
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
    return applicationDefault();
  }
  return applicationDefault(); // gcloud ADC
}
initializeApp({
  credential: loadCredential(),
  projectId: project,
  databaseURL: dbUrl || `https://${project}-default-rtdb.asia-southeast1.firebasedatabase.app`,
});
const firestore = getFirestore();
const rtdb      = getDatabase();

// ---------- Utils ----------
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
async function deleteDocsBatched(colQuery, filterFn = null, label = "collection") {
  const snap = await colQuery.get();
  const docs = [];
  snap.forEach(d => { if (!filterFn || filterFn(d)) docs.push(d); });
  console.log(`=== Firestore: ${label} ===`);
  if (!docs.length) { console.log(`No documents to delete in range.`); return { count: 0 }; }
  console.log(`${dryRun ? "[DRY]" : "[DO]"} ${label}: ${docs.length} document(s)`);
  if (dryRun) return { count: docs.length };

  let deleted = 0;
  for (const group of chunk(docs, 400)) {
    const b = firestore.batch();
    for (const d of group) b.delete(d.ref);
    await b.commit();
    deleted += group.length;
  }
  console.log(`Deleted ${deleted} from ${label}`);
  return { count: deleted };
}

// ลบ RTDB history โดยอิง dayKey พ.ศ.
async function deleteRTDBHistoryRange(buoy, start, end) {
  console.log(`=== RTDB: /buoys/${buoy}/history ===`);
  // สร้างชุด dayKey (พ.ศ.) ในช่วง
  const dayKeys = new Set();
  // เดินวันต่อวันในเวลาไทย
  let cur = start;
  while (cur <= end) {
    dayKeys.add(thaiDayKeyFromMs(cur));
    // ไปวันถัดไป (เพิ่ม 24h)
    cur += 24 * 60 * 60 * 1000;
  }

  let total = 0, removed = 0;
  for (const dk of dayKeys) {
    const [dayStart, dayEnd] = thaiDayKeyToUtcRange(dk);
    const subStart = Math.max(start, dayStart);
    const subEnd   = Math.min(end,   dayEnd);

    const dayRef = rtdb.ref(`/buoys/${buoy}/history/${dk}`);
    const snap = await dayRef.orderByKey()
      .startAt(String(subStart))
      .endAt(String(subEnd))
      .get();

    if (!snap.exists()) continue;

    const updates = {};
    let cnt = 0;
    snap.forEach(child => { cnt += 1; updates[child.key] = null; });
    total += cnt;

    console.log(`${dryRun ? "[DRY]" : "[DO]"} history/${dk}: ${cnt} record(s)`);
    if (!dryRun && cnt > 0) {
      await dayRef.update(updates);
      removed += cnt;
    }
  }
  if (!total) console.log(`No RTDB history records found in range.`);
  else if (!dryRun) console.log(`Deleted ${removed} RTDB history record(s).`);
  return { scanned: total, deleted: dryRun ? 0 : removed };
}

// ---------- Main ----------
(async () => {
  console.log(`Project: ${project}`);
  console.log(`Buoy:    ${buoyId}`);
  console.log(`Range:   ${new Date(startMs).toISOString()}  ..  ${new Date(endMs).toISOString()}`);
  console.log(`Mode:    ${dryRun ? "DRY RUN (จะไม่ลบจริง)" : "EXECUTE (ลบจริง)"}`);
  console.log(`Only:    ${Array.from(ONLY).join(", ") || "(none)"}\n`);

  if (ONLY.has("timeseries")) {
    try {
      const q = firestore.collection("sensor_timeseries")
        .where("buoy_id", "==", buoyId)
        .where("timestamp_ms", ">=", startMs)
        .where("timestamp_ms", "<=", endMs);
      await deleteDocsBatched(q, null, "sensor_timeseries");
    } catch (e) {
      console.warn("sensor_timeseries primary query failed. Fallback:", e?.message);
      const fb = firestore.collection("sensor_timeseries")
        .where("timestamp_ms", ">=", startMs)
        .where("timestamp_ms", "<=", endMs);
      await deleteDocsBatched(fb, d => d.get("buoy_id") === buoyId, "sensor_timeseries (fallback)");
    }
  }

  if (ONLY.has("alerts")) {
    try {
      const q = firestore.collection("alerts")
        .where("buoy_id", "==", buoyId)
        .where("timestamp_ms", ">=", startMs)
        .where("timestamp_ms", "<=", endMs);
      await deleteDocsBatched(q, null, "alerts");
    } catch (e) {
      console.warn("alerts primary query failed. Fallback:", e?.message);
      const fb = firestore.collection("alerts")
        .where("timestamp_ms", ">=", startMs)
        .where("timestamp_ms", "<=", endMs);
      await deleteDocsBatched(fb, d => d.get("buoy_id") === buoyId, "alerts (fallback)");
    }
  }

  if (ONLY.has("history")) {
    await deleteRTDBHistoryRange(buoyId, startMs, endMs);
  }

  console.log("\nDone.");
  process.exit(0);
})().catch(err => {
  console.error("Cleanup error:", err);
  process.exit(1);
});
