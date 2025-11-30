import firebase_admin
from firebase_admin import credentials, firestore
import pandas as pd
import numpy as np
from datetime import datetime
from config import ICT

cred = credentials.Certificate("serviceAccountKey.json")

try:
    firebase_admin.get_app()
except ValueError:
    firebase_admin.initialize_app(cred)

db = firestore.client()

SENSOR_PARAMS = ["ph", "tds", "ec", "turbidity", "temperature", "rainfall"]


def fetch_daily_from_firestore(buoy_id, skip_start=None, skip_end=None):
    print(f"\n📥 Firestore → Collecting sensor_timeseries for: {buoy_id}")

    docs = (
        db.collection("sensor_timeseries")
        .where("buoy_id", "==", buoy_id)
        .order_by("timestamp_ms")
        .stream()
    )

    rows = []

    for doc in docs:
        d = doc.to_dict()
        ts = d.get("timestamp_ms")
        param = d.get("parameter")
        value = d.get("value")

        if ts is None or param not in SENSOR_PARAMS:
            continue

        dt = datetime.fromtimestamp(ts / 1000, ICT)

        rows.append({
            "date": dt.date(),
            "parameter": param,
            "value": float(value)
        })

    if len(rows) == 0:
        print("❌ No sensor data found!")
        return pd.DataFrame()

    df = pd.DataFrame(rows)

    # Pivot to daily mean table
    daily = df.pivot_table(
        index="date",
        columns="parameter",
        values="value",
        aggfunc=np.mean
    ).reset_index()

    print(f"📊 Total days before skip: {len(daily)}")

    # Skip range if requested
    if skip_start and skip_end:
        skip_start = pd.to_datetime(skip_start).date()
        skip_end = pd.to_datetime(skip_end).date()
        daily = daily[
            ~((daily["date"] >= skip_start) & (daily["date"] <= skip_end))
        ]
        print(f"✂️ After skip: {len(daily)}")

    daily = daily.dropna()
    print(f"🧹 After drop NaN: {len(daily)} days")

    daily = daily.sort_values("date")
    daily = daily.reset_index(drop=True)

    print("✅ Done fetch & clean")
    return daily
