# ==============================================================
# firestore_io.py — Firestore + RTDB Admin IO
# ==============================================================

import os
from datetime import datetime, timedelta

import firebase_admin
from firebase_admin import credentials, firestore
from firebase_admin import db as rtdb  # ✅ RTDB
from config import COLLECTION_BUOYS

# ---------- CONFIG ----------
DATABASE_URL = "https://smart-buoy-system-d96cb-default-rtdb.asia-southeast1.firebasedatabase.app/"

_fs = None  # Firestore client cache


# ---------- INIT ----------
def init_firebase(sa_path="serviceAccountKey.json"):
    global _fs
    if not firebase_admin._apps:
        cred = credentials.Certificate(sa_path)
        firebase_admin.initialize_app(cred, {"databaseURL": DATABASE_URL})
    if _fs is None:
        _fs = firestore.client()
    return _fs


def fs():
    if _fs is None:
        return init_firebase()
    return _fs


# --------------------------------------------------------------
# Firestore Helpers — ใช้เฉพาะ metadata + forecast
# --------------------------------------------------------------

def get_buoy_latlon(buoy_id: str, buoys_col=COLLECTION_BUOYS):
    doc = fs().collection(buoys_col).document(buoy_id).get()
    if not doc.exists:
        return None, None

    d = doc.to_dict() or {}
    lat, lon = None, None
    if isinstance(d.get("location"), dict):
        loc = d["location"]
        lat = loc.get("lat") or loc.get(" lat")
        lon = loc.get("lng") or loc.get(" lon")
    else:
        lat = d.get("lat")
        lon = d.get("lon")
    return lat, lon


def write_weekly_forecast(doc: dict, col="weekly_forecasts"):
    ref = fs().collection(col).document()
    doc["forecast_id"] = ref.id
    doc["created_at"] = datetime.utcnow().isoformat()
    ref.set(doc)
    return ref.id


def write_eval(doc: dict, col="forecast_evaluations"):
    ref = fs().collection(col).document()
    doc["created_at"] = datetime.utcnow().isoformat()
    ref.set(doc)
    return ref.id


def write_alert(doc: dict, col="alerts"):
    ref = fs().collection(col).document()
    doc["created_at"] = datetime.utcnow().isoformat()
    ref.set(doc)
    return ref.id


def get_latest_weekly_forecasts(buoy_id: str, limit_n: int = 7, col="weekly_forecasts"):
    qs = (fs().collection(col)
          .where("buoy_id", "==", buoy_id)
          .order_by("created_at", direction=firestore.Query.DESCENDING)
          .limit(limit_n)
          .stream())
    return [d.to_dict() for d in qs]


# --------------------------------------------------------------
# ✅ RTDB: sensor data only!
# --------------------------------------------------------------

def query_sensor_readings_from_rtdb(buoy_id: str, days=30):
    """
    อ่านค่าแบบที่ใช้จริงในโปรเจกต์มูน:
    rtdb / buoys/{id}/history/{date}/{ts_ms}: { ph:..., tds:..., ... }
    ✅ ค่า ts คือ key
    ✅ ค่าภายในคือ sensor_type: value
    """
    ref = rtdb.reference(f"buoys/{buoy_id}/history")
    snap = ref.get() or {}
    rows = []

    for date_key, ts_group in snap.items():
        if not isinstance(ts_group, dict):
            continue

        for ts_key, sensors in ts_group.items():
            try:
                ts_ms = float(ts_key)
            except:
                continue

            if not isinstance(sensors, dict):
                continue

            for s_type, val in sensors.items():
                try:
                    rows.append([ts_ms, s_type, float(val)])
                except:
                    pass

    return rows


# ✅ Auto Init
init_firebase()
