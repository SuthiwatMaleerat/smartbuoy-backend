# ==============================================================
# features.py — สร้าง Supervised Features สำหรับ ML
# ==============================================================

import numpy as np
import pandas as pd

# ✅ รายชื่อ parameter ดิบสำหรับ WQI
PARAM_KEYS = ["ph", "tds", "ec", "turbidity", "temperature", "rainfall"]

# ✅ Feature สำหรับโมเดล — ใช้ *_mean เท่านั้น
PARAMS = [
    "ph_mean", "tds_mean", "ec_mean",
    "turbidity_mean", "temperature_mean", "rainfall_mean"
]


# เติม column ที่หายไปให้ครบก่อนใช้
def ensure_columns(d: pd.DataFrame) -> pd.DataFrame:
    df = d.copy()
    for c in PARAMS:
        if c not in df.columns:
            df[c] = np.nan
    return df


# ✅ สร้าง Feature สำหรับ Machine Learning
def make_supervised(daily: pd.DataFrame, lookback: int = 7, horizon: int = 1):
    """แปลง daily → X,y เพื่อทำนายค่าพารามิเตอร์วันถัดไป"""
    if daily is None or len(daily) < lookback + horizon:
        return None

    df = ensure_columns(daily).copy()

    if not isinstance(df.index, pd.DatetimeIndex):
        df.index = pd.to_datetime(df.index)

    df.index = df.index.normalize()
    df = df.sort_index()

    # ✅ Fill missing values เพื่อให้โมเดลทำงานต่อได้
    df[PARAMS] = df[PARAMS].ffill().bfill()

    rows = []
    targets = []
    idxs = []

    for i in range(lookback, len(df) - horizon + 1):
        hist = df.iloc[i - lookback:i]
        fut = df.iloc[i + horizon - 1]

        feat = {}
        for p in PARAMS:
            vals = hist[p].values.astype(float)
            feat[f"{p}_last"] = vals[-1]
            feat[f"{p}_mean_{lookback}"] = float(np.nanmean(vals))
            feat[f"{p}_std_{lookback}"] = float(np.nanstd(vals))
            feat[f"{p}_min_{lookback}"] = float(np.nanmin(vals))
            feat[f"{p}_max_{lookback}"] = float(np.nanmax(vals))

        rows.append(feat)
        targets.append([fut[p] for p in PARAMS])
        idxs.append(fut.name)

    if not rows:
        return None

    X = pd.DataFrame(rows).astype(float)
    y = pd.DataFrame(targets, columns=PARAMS).astype(float)
    return X, y, idxs
