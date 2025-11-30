// functions/lib/scoring.js
//
// คำนวณคะแนนคุณภาพน้ำแบบถ่วงน้ำหนัก
// รองรับ: ph, tds, ec, turbidity, temperature, rainfall
//
// เกณฑ์ (Good/Warning/Critical):
// 1) pH:           6.5–8.2 = Good, 8.3–8.5 = Warning,  <6.5 หรือ >8.5 = Critical
// 2) TDS (ppm):    ≤600 = Good, 600–900 = Warning,      >900 = Critical (ไล่ลงจน 0 ที่ 2000)
// 3) EC (µS/cm):   ≤895 = Good, 895–1343 = Warning,     >1343 = Critical (ไล่ลงจน 0 ที่ 2000)
// 4) Turbidity:    ≤5 = Good, 5–50 = Warning,           >50 = Critical (ไล่ลงจน 0 ที่ 200)
// 5) Temperature:  26–30 = Good, 23–25 หรือ 31–33 = Warning, <23 หรือ >33 = Critical (ไล่ลงจน 0 ที่ 15/39)
// 6) Rainfall:     เดิม (0→100, 50mm→0)
//
// สถานะรวมตามคะแนนถัวเฉลี่ยถ่วงน้ำหนัก (WQI):
//   >70 = "ดี", 50–70 = "Warning", <50 = "Critical"
// นโยบายพิเศษ: ถ้า pH หรือ TDS เข้าข่าย Critical (<50) → ปัด WQI = 0 และสถานะ = "Critical"
//
// น้ำหนัก (เหมือนเดิม):
//   ph:30, tds:25(แชร์กับ ec), ec:0(จะถูก set อัตโนมัติเมื่อมี ec), turbidity:20, temperature:15, rainfall:10
//
// หมายเหตุ: ถ้ามีทั้ง TDS และ EC → แบ่ง 25 เป็น 12.5/12.5
//          ถ้ามีอย่างใดอย่างหนึ่ง → ตัวนั้นได้ 25 เต็ม

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }

// === pH (อัปเดตตามเกณฑ์ใหม่) ===
// Good:     6.5–8.5  => 100
// Warning:  6.0–6.4  => 70..50 (เชิงเส้น), 8.6–9.0 => 70..50 (เชิงเส้น)
// Critical: <6.0 หรือ >9.0 => <50 (เชิงเส้นจนเป็น 0 ที่ 5.0 / 10.0)
function scorePH(ph) {
  if (ph == null || isNaN(ph)) return null;

  const GOOD_LOW = 6.5, GOOD_HIGH = 8.5;
  const WARN_LOW_L = 6.0, WARN_HIGH_L = 6.4;  // warning ซ้าย
  const WARN_LOW_R = 8.6, WARN_HIGH_R = 9.0;  // warning ขวา
  const HARD_LOW = 5.0, HARD_HIGH = 10.0;     // ค่อย ๆ ไล่ลงเป็นศูนย์ที่ปลาย

  // โซนดี
  if (ph >= GOOD_LOW && ph <= GOOD_HIGH) return 100;

  // โซนเตือน (ซ้าย: 6.0..6.4 → 70..50)
  if (ph >= WARN_LOW_L && ph <= WARN_HIGH_L) {
    const t = (ph - WARN_LOW_L) / (WARN_HIGH_L - WARN_LOW_L); // 0..1
    return Math.round(lerp(70, 50, t));
  }

  // โซนเตือน (ขวา: 8.6..9.0 → 70..50)
  if (ph >= WARN_LOW_R && ph <= WARN_HIGH_R) {
    const t = (ph - WARN_LOW_R) / (WARN_HIGH_R - WARN_LOW_R); // 0..1
    return Math.round(lerp(70, 50, t));
  }

  // โซนวิกฤต (ซ้าย: <6.0 → 0..50 แบบเชิงเส้น, ศูนย์ที่ 5.0)
  if (ph < WARN_LOW_L) {
    const t = clamp((ph - HARD_LOW) / (WARN_LOW_L - HARD_LOW), 0, 1); // 5.0..6.0 → 0..1
    return Math.round(lerp(0, 50, t));
  }

  // โซนวิกฤต (ขวา: >9.0 → 50..0 แบบเชิงเส้น, ศูนย์ที่ 10.0)
  if (ph > WARN_HIGH_R) {
    const t = clamp((HARD_HIGH - ph) / (HARD_HIGH - WARN_HIGH_R), 0, 1); // 9.0..10.0 → 1..0
    return Math.round(lerp(50, 0, 1 - t)); // หรือ Math.round(lerp(50, 0, (ph-9.0)/(10.0-9.0)))
  }

  // เผื่อกรณีหลุดเงื่อนไข (ไม่ควรเกิด)
  return 50;
}

// -------------------- TDS --------------------
function scoreTDS(tds) {
  if (tds == null || isNaN(tds)) return null;
  if (tds <= 0) return 100;
  if (tds <= 600) {
    const t = tds / 600;
    return Math.round(lerp(100, 70, t));
  }
  if (tds <= 900) {
    const t = (tds - 600) / 300;
    return Math.round(lerp(70, 50, t));
  }
  const t = clamp((tds - 900) / (2000 - 900), 0, 1);
  return Math.round(lerp(50, 0, t));
}

// -------------------- EC --------------------
function scoreEC(ec) {
  if (ec == null || isNaN(ec)) return null;
  if (ec <= 0) return 100;
  if (ec <= 895) {
    const t = ec / 895;
    return Math.round(lerp(100, 70, t));
  }
  if (ec <= 1343) {
    const t = (ec - 895) / (1343 - 895);
    return Math.round(lerp(70, 50, t));
  }
  const t = clamp((ec - 1343) / (2000 - 1343), 0, 1);
  return Math.round(lerp(50, 0, t));
}

// -------------------- Turbidity --------------------
function scoreTurbidity(ntu) {
  if (ntu == null || isNaN(ntu)) return null;
  // เกณฑ์ใหม่:
  // - ≤25 NTU (Good)     → 100..70
  // - 25..100 NTU (Warn) → 70..50
  // - >100 NTU (Crit)    → 50..0  (ลากถึง 0 ที่ 300 NTU)
  if (ntu <= 0) return 100;
  if (ntu <= 25) {
    const t = ntu / 25; // 0..1
    return Math.round(lerp(100, 70, t));
  }
  if (ntu <= 100) {
    const t = (ntu - 25) / 75; // 0..1
    return Math.round(lerp(70, 50, t));
  }
  // >100 : 50 -> 0 (ค่อยๆ แย่ลงถึง 300)
  const t = clamp((ntu - 100) / (300 - 100), 0, 1);
  return Math.round(lerp(50, 0, t));
}

// -------------------- Temperature --------------------
function scoreTemperature(t) {
  if (t == null || isNaN(t)) return null;
  const goodLow = 26, goodHigh = 30;
  const warnLow = 23, warnHigh = 33;
  const hardLow = 15, hardHigh = 39;

  if (t >= goodLow && t <= goodHigh) return 100;
  if (t >= warnLow && t < goodLow) {
    const k = (t - warnLow) / (goodLow - warnLow);
    return Math.round(lerp(50, 100, k));
  }
  if (t > goodHigh && t <= warnHigh) {
    const k = (t - goodHigh) / (warnHigh - goodHigh);
    return Math.round(lerp(100, 50, k));
  }
  if (t < warnLow) {
    const k = clamp((t - hardLow) / (warnLow - hardLow), 0, 1);
    return Math.round(lerp(0, 49, k));
  }
  if (t > warnHigh) {
    const k = clamp((t - warnHigh) / (hardHigh - warnHigh), 0, 1);
    return Math.round(lerp(49, 0, k));
  }
  return 0;
}

// -------------------- Rainfall (NEW RANGE) --------------------
// Good: 683–1023 → 100..70
// Warning: 342–682 → 70..50
// Critical: 0–341 → 50..0
function scoreRainfall(mm) {
  if (mm == null || isNaN(mm)) return null;
  if (mm <= 0) return 0;
  if (mm <= 341) {
    const t = mm / 341;
    return Math.round(lerp(0, 50, t));
  }
  if (mm <= 682) {
    const t = (mm - 341) / (682 - 341);
    return Math.round(lerp(50, 70, t));
  }
  if (mm <= 1023) {
    const t = (mm - 682) / (1023 - 682);
    return Math.round(lerp(70, 100, t));
  }
  return 100;
}

// -------------------- Weights --------------------
const DEFAULT_WEIGHTS = {
  ph: 30,
  tds: 25,
  ec: 0,
  turbidity: 20,
  temperature: 15,
  rainfall: 10
};

// -------------------- Calculate Total --------------------
function calculateScore(values, cfg) {
  const base = (cfg && cfg.weights) ? { ...DEFAULT_WEIGHTS, ...cfg.weights } : { ...DEFAULT_WEIGHTS };

  const details = {
    ph:          scorePH(values.ph),
    tds:         scoreTDS(values.tds),
    ec:          scoreEC(values.ec),
    turbidity:   scoreTurbidity(values.turbidity),
    temperature: scoreTemperature(values.temperature),
    rainfall:    scoreRainfall(values.rainfall)
  };

  const hasEC  = details.ec != null;
  const hasTDS = details.tds != null;
  const effectiveWeights = { ...base };
  if (hasEC && hasTDS) {
    const combined = base.tds || 25;
    effectiveWeights.tds = combined / 2;
    effectiveWeights.ec  = combined / 2;
  } else if (hasEC && !hasTDS) {
    const combined = base.tds || 25;
    effectiveWeights.tds = 0;
    effectiveWeights.ec  = combined;
  } else {
    effectiveWeights.ec = 0;
  }

  let sum = 0, wsum = 0;
  for (const k of Object.keys(details)) {
    const sc = details[k];
    const w  = effectiveWeights[k] || 0;
    if (typeof sc === "number" && !isNaN(sc) && w > 0) {
      sum += sc * w;
      wsum += w;
    }
  }
  let totalScore = wsum > 0 ? Number((sum / wsum).toFixed(2)) : 0;
  let status = (totalScore > 70) ? "ดี" : (totalScore >= 50) ? "Warning" : "Critical";

  // 🔴 ถ้า pH หรือ TDS แย่ → น้ำเสีย
  if ((details.ph != null && details.ph < 50) ||
      (details.tds != null && details.tds < 50)) {
    totalScore = 0;
    status = "Critical";
  }

  return { totalScore, details, status, effectiveWeights };
}

module.exports = { calculateScore };