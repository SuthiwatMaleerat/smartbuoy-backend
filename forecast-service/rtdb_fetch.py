import firebase_admin
from firebase_admin import credentials, db
import pandas as pd

# ✅ RTDB Config
cred = credentials.Certificate("serviceAccountKey.json")
if not firebase_admin._apps:
    firebase_admin.initialize_app(cred, {
        "databaseURL": "https://smart-buoy-system-d96cb-default-rtdb.asia-southeast1.firebasedatabase.app/"
    })

def fetch_daily_from_rtdb(buoy_id):
    root = db.reference(f"buoys/{buoy_id}/history").get()

    if not root:
        print("❌ No RTDB data found!")
        return pd.DataFrame()

    rows = []

    for date_key, samples in root.items():  # ex. "2568-10-01"
        for ts, item in samples.items():    # ex. timestamp group
            rows.append({
                "date": date_key,
                "ec": float(item.get("ec", 0)),
                "ph": float(item.get("ph", 0)),
                "rainfall": float(item.get("rainfall", 0)),
                "tds": float(item.get("tds", 0)),
                "temperature": float(item.get("temperature", 0)),
                "turbidity": float(item.get("turbidity", 0)),
                "wqi_score": float(item.get("total_score", 0)),
            })

    df = pd.DataFrame(rows)

    # ✅ Convert Buddhist year → Gregorian year
    df["date"] = df["date"].str.replace("2568", "2025")

    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    df = df.groupby("date").mean().reset_index()

    print(f"✅ fetch_daily_from_rtdb: {len(df)} days cleaned")
    return df

from datetime import datetime, timedelta
import pytz

ICT = pytz.timezone("Asia/Bangkok")

def query_history_from_rtdb(buoy_id: str, days: int = 30):
    ref = db.reference(f"buoys/{buoy_id}/history")
    snapshot = ref.get() or {}
    
    cutoff = datetime.now(ICT) - timedelta(days=days)
    rows = []

    for date_key, samples in snapshot.items():
        for ts_ms, item in samples.items():
            try:
                ts = float(ts_ms)
            except:
                continue

            dt = datetime.fromtimestamp(ts/1000, ICT)
            if dt < cutoff:
                continue

            for k in ["ph", "tds", "ec", "turbidity", "temperature", "rainfall"]:
                if k in item:
                    rows.append([dt.isoformat(), k, float(item[k])])

    print(f"✅ query_history_from_rtdb: loaded {len(rows)} rows")
    return rows