// functions/scripts/seed-rtdb.js
const { initializeApp, cert } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const sa = require('../serviceAccountKey.json'); // << ต้องมีไฟล์นี้ใน functions/

initializeApp({
  credential: cert(sa),
  databaseURL: 'https://smart-buoy-system-d96cb-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: sa.project_id,
});

// ✅ ลืมบรรทัดนี้ไม่ได้!
const db = getDatabase();

const now = () => Math.floor(Date.now() / 1000);

async function seedBuoyInfo() {
  const ref = db.ref('/buoys/buoy_001/info');
  await ref.set({
    name: 'KPS Pond 1',
    owner_id: 'user_001',
    status: 'active'
    // ตามที่ตกลง: ตัดพิกัดจุดออก ไม่เก็บ lat/lng ใน RTDB
  });
  console.log('✅ RTDB: /buoys/buoy_001/info');
}

async function seedCurrent() {
  const ref = db.ref('/buoys/buoy_001/sensors/current');
  await ref.set({
    ph: 6.95,
    tds: 690,
    ec: 1028,
    temperature: 28,
    turbidity: 5,
    rainfall: 0,
    timestamp: now()
  });
  console.log('✅ RTDB: /buoys/buoy_001/sensors/current');
}

function pad2(n){ return (n<10?'0':'')+n; }
function dateKey(ts){
  const d = new Date(ts*1000);
  const y=d.getUTCFullYear(), m=pad2(d.getUTCMonth()+1), dd=pad2(d.getUTCDate());
  const hh=pad2(d.getUTCHours()), mm=pad2(d.getUTCMinutes());
  return { day: `${y}-${m}-${dd}`, time: `${hh}:${mm}` };
}

async function seedHistory() {
  const base = now();
  const points = [];
  for (let i = 19; i >= 0; i--) {
    const t = base - i * 300; // ทุก 5 นาที
    points.push({
      t,
      ph: +(6.9 + Math.random()*0.4).toFixed(2),
      tds: 650 + Math.round(Math.random()*60),
      ec:  980 + Math.round(Math.random()*60),
      temperature: 28,
      turbidity: 5,
      rainfall: 0
    });
  }

  for (const p of points) {
    const k = dateKey(p.t);
    await db.ref(`/buoys/buoy_001/history/${k.day}/${k.time}`).set({
      ph: p.ph,
      tds: p.tds,
      ec:  p.ec,
      temperature: p.temperature,
      turbidity: p.turbidity,
      rainfall: p.rainfall
    });
  }
  console.log(`✅ RTDB: history entries = ${points.length}`);
}

async function seedSensorReadings() {
  // ตัวอย่าง event 3 ชุด เพื่อให้ Cloud Function rollup/mirror ทำงาน
  const readings = [
    { buoy_id:'buoy_001', sensor_type:'ph',  value: 7.02, timestamp: now()-60 },
    { buoy_id:'buoy_001', sensor_type:'tds', value: 680,  timestamp: now()-30 },
    { buoy_id:'buoy_001', sensor_type:'ec',  value: 1015, timestamp: now() }
  ];
  const ref = db.ref('/sensor_readings');
  for (const r of readings) {
    await ref.push(r);
  }
  console.log('✅ RTDB: sensor_readings (3 events)');
}

(async () => {
  try {
    await seedBuoyInfo();
    await seedCurrent();
    await seedHistory();
    await seedSensorReadings();
    console.log('🎉 Seed RTDB done.');
    process.exit(0);
  } catch (e) {
    console.error('❌ Seed RTDB failed:', e);
    process.exit(1);
  }
})();
