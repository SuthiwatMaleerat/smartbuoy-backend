const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const sa = require('../serviceAccountKey.json'); // ← เช่นเดียวกัน

initializeApp({
  credential: cert(sa),
  projectId: sa.project_id,
});

const db = getFirestore();
const now = () => Math.floor(Date.now() / 1000);

// helper: upsert
async function upsert(ref, data) { await ref.set(data, { merge: true }); }

async function seedUsers() {
  const users = [
    {
      uid: 'user_001', name: 'Sutivut', surname: 'Maleerat',
      email: 'moon@example.com', phone: '0812345678',
      line1: '123/45 หมู่ 7', district: 'กำแพงแสน', province: 'นครปฐม',
      postal_code: '73140', role: 'staff',
    },
    {
      uid: 'user_002', name: 'Front', surname: 'End',
      email: 'frontend@example.com', phone: '0800000002',
      line1: '22/7', district: 'บางเขน', province: 'กรุงเทพฯ',
      postal_code: '10220', role: 'user',
    },
    {
      uid: 'admin_001', name: 'Admin', surname: 'SmartBuoy',
      email: 'admin@example.com', phone: '0800000001',
      line1: 'สำนักงานใหญ่', district: 'ห้วยขวาง', province: 'กรุงเทพฯ',
      postal_code: '10310', role: 'admin',
    },
  ];
  for (const u of users) {
    await upsert(db.collection('users').doc(u.uid), { ...u, created_at: now(), updated_at: now() });
  }
  console.log(`✅ users: ${users.length}`);
}

async function seedBuoyRegistry() {
  const items = [
    {
      buoy_id: 'buoy_001', name: 'KPS Pond 1', serial_no: 'SN-BUOY-001',
      owner_uid: 'user_001', owner_email: 'moon@example.com', surname: 'Maleerat',
      install_address: { label: 'ตำแหน่งทุ่น', line1: 'Kasetsart University', district: 'Kamphaeng Saen', province: 'Nakhon Pathom', postal_code: '73140', note: 'บ่อหน้าบ้าน' },
      active: true,
    },
    {
      buoy_id: 'buoy_002', name: 'KPS Pond 2', serial_no: 'SN-BUOY-002',
      owner_uid: 'user_002', owner_email: 'frontend@example.com', surname: 'End',
      install_address: { label: 'ตำแหน่งทุ่น', line1: 'Kasetsart University', district: 'Kamphaeng Saen', province: 'Nakhon Pathom', postal_code: '73140', note: 'บ่อด้านข้าง' },
      active: true,
    },
  ];
  for (const b of items) {
    await upsert(db.collection('buoy_registry').doc(b.buoy_id), { ...b, created_at: now(), updated_at: now() });
  }
  console.log(`✅ buoy_registry: ${items.length}`);
}

async function seedSensorTimeseries() {
  const ts = db.collection('sensor_timeseries');
  const base = now();
  const rows = [];
  for (let i = 19; i >= 0; i--) {
    const t = base - i * 60;
    rows.push(
      { buoy_id: 'buoy_001', parameter: 'ph',  value: +(6.9 + Math.random()*0.4).toFixed(2), timestamp: t },
      { buoy_id: 'buoy_001', parameter: 'tds', value: 650 + Math.round(Math.random()*80), timestamp: t },
      { buoy_id: 'buoy_001', parameter: 'ec',  value: 980 + Math.round(Math.random()*80), timestamp: t },
    );
  }
  for (const r of rows) await ts.add(r);
  console.log(`✅ sensor_timeseries: ${rows.length}`);
}

async function seedAlerts() {
  const alerts = db.collection('alerts');
  const t = now();
  await alerts.add({
    buoy_id: 'buoy_001', type: 'warning', parameters: ['tds'], parameter: 'tds', value: 720,
    message: 'Water quality warning — params: tds', reason: 'param_score_below_70',
    status: 'active', timestamp: t - 300, created_by: 'system',
  });
  await alerts.add({
    buoy_id: 'buoy_001', type: 'critical', parameter: 'ph', value: 6.2,
    message: 'pH critical (6.2) — out of acceptable range [6.5, 8.5]',
    reason: 'pH out of [6.5, 8.5]', status: 'active', timestamp: t - 120, created_by: 'system',
  });
  console.log('✅ alerts: 2');
}

(async () => {
  await seedUsers();
  await seedBuoyRegistry();
  await seedSensorTimeseries();
  await seedAlerts();
  console.log('🎉 Seed Firestore done.');
  process.exit(0);
})();
