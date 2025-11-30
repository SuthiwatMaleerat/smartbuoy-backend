# config.py
from datetime import timezone, timedelta

# ==== Firestore collections (แก้ให้ตรงฐานจริงของมูน) ====
COLLECTION_SENSOR = "readings"                  # ตาราง/คอลเลกชันค่าดิบของเซ็นเซอร์
COLLECTION_WEEKLY_FORECASTS = "weekly_forecasts"
COLLECTION_EVALS = "forecast_evaluations"
COLLECTION_ALERTS = "alerts"
COLLECTION_BUOYS = "buoy_registry"                     # เก็บ lat/lon ของทุ่น
COLLECTION_SETTINGS = "system_settings"         # เอกสาร global config

# ==== รายชื่อพารามิเตอร์ที่ใช้ในโมเดล ====
SENSOR_TYPES = ["ph", "tds", "ec", "turbidity", "temperature", "rainfall"]

# ==== หน้าต่างข้อมูลและพยากรณ์ ====
TRAIN_LOOKBACK_DAYS = 60
FORECAST_HORIZON_DAYS = 3
MIN_DAY_COVERAGE = 0.30     # ต้องมีข้อมูล >=30% ของชั่วโมงในวันนั้น

# ==== ขอบเขตค่าที่สมเหตุสมผล (QC clip) ====
QC_BOUNDS = {
    "ph":(4.5, 9.5),
    "tds":(0, 1500),
    "ec":(0, 2000),
    "temperature":(0, 40),
    "turbidity":(0, 200),
    "rainfall": (0.0, 500.0),  # mm/day
}

# ==== ช่วงคาดการณ์ (Prediction Interval) สำหรับโมเดล param ====
PI_LOW_Q = 0.10
PI_HIGH_Q = 0.90

# ==== Timezone ====
ICT = timezone(timedelta(hours=7))

# ---------------- Prediction Interval Quantiles ----------------
PI_LOW_Q  = 0.10   # ขอบล่างของช่วงความเชื่อมั่น (10%)
PI_HIGH_Q = 0.90   # ขอบบนของช่วงความเชื่อมั่น (90%)


DATABASE_URL = "https://smart-buoy-system-d96cb-default-rtdb.asia-southeast1.firebasedatabase.app/"
