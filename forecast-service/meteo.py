# meteo.py
import requests
import pandas as pd
from datetime import datetime, timedelta

# ---------- ดึงปริมาณฝนรายวัน (ย้อนหลัง) ----------
def get_rainfall_observed_daily(lat: float, lon: float, start_date: str, end_date: str) -> pd.DataFrame:
    """
    ใช้ Open-Meteo archive: ดึง rainfall_sum รายวัน (mm/day)
    start_date, end_date: "YYYY-MM-DD"
    """
    url = (
      "https://archive-api.open-meteo.com/v1/era5?"
      f"latitude={lat}&longitude={lon}&daily=precipitation_sum&timezone=UTC"
      f"&start_date={start_date}&end_date={end_date}"
    )
    r = requests.get(url, timeout=30)
    r.raise_for_status()
    js = r.json()
    dates = js.get("daily", {}).get("time", [])
    rains = js.get("daily", {}).get("precipitation_sum", [])
    df = pd.DataFrame({"date": pd.to_datetime(dates), "rainfall": rains})
    df["date"] = df["date"].dt.date
    return df

# ---------- ดึงปริมาณฝนรายวัน (พยากรณ์ 3 วันหน้า) ----------
def get_rainfall_forecast_daily(lat: float, lon: float, horizon_days: int=3) -> pd.DataFrame:
    url = (
      "https://api.open-meteo.com/v1/forecast?"
      f"latitude={lat}&longitude={lon}&daily=precipitation_sum&timezone=UTC"
      f"&forecast_days={horizon_days}"
    )
    r = requests.get(url, timeout=30)
    r.raise_for_status()
    js = r.json()
    dates = js.get("daily", {}).get("time", [])
    rains = js.get("daily", {}).get("precipitation_sum", [])
    df = pd.DataFrame({"date": pd.to_datetime(dates), "rainfall": rains})
    df["date"] = df["date"].dt.date
    return df
