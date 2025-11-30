// functions/lib/weather.js
// ใช้ Open-Meteo (ฟรี) ดึงปริมาณฝนรายวัน 3 วันข้างหน้า
async function getRainForecast(lat, lng, tz = "Asia/Bangkok") {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
                `&daily=precipitation_sum&forecast_days=4&timezone=${encodeURIComponent(tz)}`;
  
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`weather http ${resp.status}`);
    const j = await resp.json();
  
    const p = j?.daily?.precipitation_sum || [];
    // index 0 = วันนี้ → ใช้ 1..3 = พรุ่งนี้ถึงอีก 3 วัน
    return {
      D1: { rain_mm: (typeof p[1] === "number") ? p[1] : null },
      D2: { rain_mm: (typeof p[2] === "number") ? p[2] : null },
      D3: { rain_mm: (typeof p[3] === "number") ? p[3] : null },
    };
  }
  
  module.exports = { getRainForecast };
  