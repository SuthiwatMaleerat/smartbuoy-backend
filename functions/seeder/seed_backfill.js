// node seeder/seed_backfill.js --project <id> --region asia-southeast1 --buoy buoy_001 --from "2025-10-01T00:00:00+07:00" --to "2025-10-17T23:59:59+07:00" --rain-csv ./seeder/open-meteo-13.95N100.36E2m.csv --mode realistic-v2 --config ./seeder/profile.anchor.json --qps 6 [--dry-run]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// ใช้ fetch ใน Node18+ (ไม่มีให้ลงเพิ่ม)
const fetchFn = globalThis.fetch;

function getArg(flag, d = null) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return d;
  const v = process.argv[i + 1];
  if (!v || v.startsWith("--")) return true;
  return v;
}

const project = String(getArg("--project","")).trim();
const region  = String(getArg("--region","asia-southeast1")).trim();
const buoyId  = String(getArg("--buoy","")).trim();
const fromStr = String(getArg("--from","")).trim();
const toStr   = String(getArg("--to","")).trim();
const rainCsv = String(getArg("--rain-csv","")).trim();
const mode    = String(getArg("--mode","realistic-v2")).trim();
const cfgPath = String(getArg("--config","")).trim();
const qps     = Number(getArg("--qps", 6));
const dryRun  = !!getArg("--dry-run", false);

if (!project || !buoyId || !fromStr || !toStr) {
  console.error(`Usage: node seeder/seed_backfill.js --project <id> --region asia-southeast1 --buoy <id> --from "YYYY-MM-DDTHH:mm:+07:00" --to "..." --rain-csv ./seeder/open-meteo-XX.csv --mode realistic-v2 --config ./seeder/profile.anchor.json --qps 6 [--dry-run]`);
  process.exit(1);
}

const BASE = `https://${region}-${project}.cloudfunctions.net`;

function parseISO(s){ const ms = Date.parse(s); if(Number.isNaN(ms)) throw new Error(`Bad time: ${s}`); return ms; }
const startMs = parseISO(fromStr);
const endMs   = parseISO(toStr);

function minuteRange(msFrom, msTo, stepMin=5){
  const out=[]; for(let t=msFrom; t<=msTo; t+=stepMin*60*1000) out.push(t); return out;
}

// ---------- โหลด config anchor ----------
const cfg = cfgPath && fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath,"utf8")) : {};
const anchor = cfg.anchor || { ph: 6.6, tds: 230, ec: 340, turbidity: 30, temperature: 27.5, rainfall: 1015 };

// ---------- อ่านไฟล์ฝน (Open-Meteo hourly mm) ----------
function loadRainHour(csvPath){
  if (!csvPath || !fs.existsSync(csvPath)) return [];
  const raw = fs.readFileSync(csvPath,"utf8").trim().split(/\r?\n/);
  // หาหัวตารางของค่าชั่วโมง: มองหาแถวที่ขึ้นต้นด้วย "time"
  const hIdx = raw.findIndex(l=>/^time,/.test(l));
  if (hIdx<0) return [];
  const rows = raw.slice(hIdx);
  // header: time,rain (mm)
  const out=[];
  for (let i=1;i<rows.length;i++){
    const line = rows[i].trim();
    if (!line) continue;
    const [ts, mmStr] = line.split(","); // "2025-10-01T00:00","0.00"
    const ms = Date.parse(ts+":00+07:00"); // ตีความเป็น BKK +07
    const mm = Number(mmStr);
    if (!Number.isNaN(ms) && !Number.isNaN(mm)) out.push({ms, mm});
  }
  return out.sort((a,b)=>a.ms-b.ms);
}

const rainHourly = loadRainHour(rainCsv);

// แปลง mm รายชั่วโมง → mV ราย 5 นาที (linear ภายในชั่วโมง + mapping)
const rainMap = cfg.rain_map || { mm_at_heavy: 10, mv_at_dry: 1023, mv_drop_span: 600, noise_mv: 15 };
function mmToMv(mm){
  // ไม่มีฝน → ใกล้ 1023 mV, ยิ่งฝนหนักยิ่งลดลง (dry - span * ratio)
  const ratio = Math.max(0, Math.min(1, mm / Math.max(1, rainMap.mm_at_heavy)));
  const base = rainMap.mv_at_dry - rainMap.mv_drop_span * ratio;
  const noise = (Math.random()*2-1) * (rainMap.noise_mv||0);
  return Math.round(Math.max(0, Math.min(1023, base + noise)));
}

function rainfallSeries5Min(start, end){
  if (!rainHourly.length) {
    return minuteRange(start,end,5).map(ms=>({ms, mv: anchor.rainfall||1015}));
  }
  const points=[];
  for (let t=start; t<=end; t+=5*60*1000){
    // หา record ชั่วโมงที่ครอบคลุม
    const hr = rainHourly.findLast(r=>r.ms<=t) || rainHourly[0];
    const next = rainHourly.find(r=>r.ms>t) || hr;
    // สัดส่วนภายในชั่วโมง
    const span = Math.max(1, (next.ms - hr.ms));
    const alpha = Math.max(0, Math.min(1, (t - hr.ms) / span));
    const mm = hr.mm + (next.mm - hr.mm) * alpha;
    points.push({ ms: t, mv: mmToMv(mm), mm });
  }
  return points;
}

// ---------- สร้างค่าพารามิเตอร์อื่นแบบ realistic ----------
const diurnal = cfg.diurnal || { temp_mean: 28.5, temp_amp: 2.8, temp_peak_hour: 15 };
const turbCfg = cfg.turbidity_response || { base_min: 2, base_max: 6, rise_coeff: 0.6, lag_min_min:30, lag_max_min:90, half_life_hours: 3.5 };
const ecCfg   = cfg.ec_tds || { ec_base: 800, dilution_max_frac: 0.15, recovery_hours: 30, tds_factor: 0.65, tds_noise: 30 };
const phCfg   = cfg.ph_response || { base: 7.5, rain_drop_per_10mm: 0.18, recovery_hours: 8, noise: 0.06 };

function hourOfDayBKK(ms){
  const d=new Date(ms); return (d.getUTCHours()+7)%24;
}
function diurnalTemp(ms){
  const h = hourOfDayBKK(ms);
  const rad = 2*Math.PI*(h - diurnal.temp_peak_hour)/24;
  const v = diurnal.temp_mean - diurnal.temp_amp*Math.cos(rad);
  return v + (Math.random()*0.2 - 0.1);
}

function simulateSeries(start, end){
  const rain5 = rainfallSeries5Min(start,end);
  let lastTurb = anchor.turbidity ?? 5;
  let lastEc   = anchor.ec ?? 350;
  let lastPh   = anchor.ph ?? 7.2;

  const out = [];
  let lastRainBurstAt = null;

  for (const r of rain5){
    const ms = r.ms;
    const temp = diurnalTemp(ms);

    // ฝนหนัก? คิดเป็น mm ใน 5 นาที: จาก mm/hour ~ กระจาย 12 ช่วง
    const mm5 = (r.mm || 0)/12;
    const heavy = mm5 >= 0.8; // ~>= 10 mm/hr

    // Turbidity: base + spikes หลังฝน (lag) แล้วค่อย decay
    if (heavy) lastRainBurstAt = ms + (turbCfg.lag_min_min*60*1000) + Math.random()*((turbCfg.lag_max_min-turbCfg.lag_min_min)*60*1000);
    const baseTurb = turbCfg.base_min + Math.random()*(turbCfg.base_max - turbCfg.base_min);
    if (lastRainBurstAt && ms >= lastRainBurstAt) {
      const hrs = (ms - lastRainBurstAt)/ (60*60*1000);
      const peak = 100 * turbCfg.rise_coeff; // peak ชั่วคราว
      const decay = Math.exp(-hrs / turbCfg.half_life_hours);
      lastTurb = baseTurb + peak*decay + (Math.random()*3-1.5);
    } else {
      lastTurb = baseTurb + (Math.random()*2-1);
    }
    lastTurb = Math.max(0, lastTurb);

    // EC/TDS: ฝน → dilution ลดลง แล้วค่อยฟื้น
    const targetEcDry = anchor.ec ?? 350;
    const dilute = Math.min(ecCfg.dilution_max_frac, (r.mm||0)/20); // 0..~0.5
    const ecNow = targetEcDry * (1 - dilute);
    lastEc += (ecNow - lastEc) * (1/ (ecCfg.recovery_hours*12)); // smooth
    const tdsNow = lastEc * (ecCfg.tds_factor||0.65) + (Math.random()*ecCfg.tds_noise - ecCfg.tds_noise/2);

    // pH: ฝน → pH ลด แล้วค่อยฟื้น
    const phDrop = (r.mm||0)/10 * (phCfg.rain_drop_per_10mm||0.15);
    const phTarget = (phCfg.base||7.3) - phDrop;
    lastPh += (phTarget - lastPh) * (1/(phCfg.recovery_hours*12));
    lastPh += (Math.random()*phCfg.noise - phCfg.noise/2);

    // rainfall เป็น mV จาก mapping ข้างบน
    const payload = {
      ph: Number(lastPh.toFixed(2)),
      ec: Math.max(0, Math.round(lastEc)),
      tds: Math.max(0, Math.round(tdsNow)),
      turbidity: Number(lastTurb.toFixed(2)),
      temperature: Number(temp.toFixed(1)),
      rainfall: r.mv
    };
    out.push({ ms, sensors: payload });
  }
  return out;
}

// ---------- ส่งไป ingest ----------
async function postOne(baseUrl, buoy, ms, sensors){
  const body = {
    buoy_id: buoy,
    sensors,
    device_time_ms: ms
  };
  const url = `${baseUrl}/ingestSensorData`;
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HTTP ${res.status}: ${txt}`);
  }
}

(async () => {
  console.log(`Project: ${project}`);
  console.log(`Region:  ${region}`);
  console.log(`BASE:    ${BASE}`);
  console.log(`Buoy:    ${buoyId}`);
  console.log(`Range:   ${new Date(startMs).toISOString()} .. ${new Date(endMs).toISOString()} (every 5 min)`);
  console.log(`Mode:    ${mode}  | QPS=${qps}`);
  console.log(`Rain:    ${rainCsv || "(none)"}`);
  console.log(`Config:  ${cfgPath || "(default)"}`);
  console.log(dryRun ? "DRY RUN" : "EXECUTE");
  console.log("");

  const series = simulateSeries(startMs, endMs);
  console.log(`Generated points: ${series.length}`);

  if (dryRun) {
    const samp = series.slice(0,3).map(x=>({ ts:x.ms, sensors:x.sensors }));
    console.log("Sample:", JSON.stringify(samp, null, 2));
    return;
  }

  // QPS throttle
  const delayMs = Math.max(0, Math.floor(1000/Math.max(1,qps)));
  for (const p of series) {
    await postOne(BASE, buoyId, p.ms, p.sensors);
    if (delayMs) await new Promise(r=>setTimeout(r, delayMs));
  }
  console.log("DONE.");
})().catch(e=>{
  console.error("Seed error:", e);
  process.exit(1);
});
