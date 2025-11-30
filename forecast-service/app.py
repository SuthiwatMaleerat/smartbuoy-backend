# ==============================================================
# app.py — SmartBuoy Forecast Service (Final Version)
# ==============================================================

from fastapi import FastAPI, HTTPException, Query
from datetime import datetime, timedelta
from pydantic import BaseModel
import os
import uvicorn


from config import ICT
from pipeline import run_pipeline_forecast, evaluate_for_date
from firestore_io import init_firebase, fs

app = FastAPI(title="SmartBuoy Forecast Service")

@app.on_event("startup")
def startup_event():
    try:
        init_firebase()
        print("✅ Firebase initialized on startup")
    except Exception as e:
        print("⚠ Firebase init failed:", e)
# ---------------------------------------------------------------
# Models (Response Schemas)
# ---------------------------------------------------------------
class ForecastResponse(BaseModel):
    forecast_id: str
    summary_status: str
    wqi_avg_3d: float


class EvaluateResponse(BaseModel):
    buoy_id: str
    date: str
    overall_smape: float | None


# ---------------------------------------------------------------
# Health Check
# ---------------------------------------------------------------
@app.get("/health")
def health():
    return {"ok": True}


# ---------------------------------------------------------------
# Forecast API
# ---------------------------------------------------------------
@app.post("/forecast/{buoy_id}", response_model=ForecastResponse)
def forecast(buoy_id: str):
    """
    พยากรณ์คุณภาพน้ำล่วงหน้า (3 วัน)
    """
    try:
        forecast_id, doc = run_pipeline_forecast(buoy_id)
        return ForecastResponse(
            forecast_id=forecast_id,
            summary_status=doc.get("status_3d"),
            wqi_avg_3d=doc.get("wqi_avg_3d")
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


# ---------------------------------------------------------------
# Evaluate Daily API
# ---------------------------------------------------------------
@app.post("/evaluate/daily/{buoy_id}", response_model=EvaluateResponse)
def evaluate_daily(
    buoy_id: str,
    date: str | None = Query(default=None, description="YYYY-MM-DD (ICT)")
):
    """
    ประเมินผลการพยากรณ์ของวันเป้าหมาย (เทียบค่าจริง)
    """
    try:
        date_obj = datetime.strptime(date, "%Y-%m-%d").date() if date else datetime.now(ICT).date()
        result = evaluate_for_date(buoy_id, date_obj)

        acc = None
        if result.get("metrics") and result["metrics"].get("overall"):
            acc = result["metrics"]["overall"].get("accuracy_pct", 0) or 0

        return EvaluateResponse(
            buoy_id=buoy_id,
            date=result["date"],
            overall_smape=acc
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


# ---------------------------------------------------------------
# Run Forecast + Evaluate (All Buoys)
# ---------------------------------------------------------------
@app.post("/run/daily-forecast-and-evaluate")
def run_daily_forecast_and_evaluate():
    """
    เรียกครั้งเดียวให้ทุกทุ่น:
    - พยากรณ์คุณภาพน้ำ
    - ประเมินผล (ของเมื่อวาน)
    """
    try:
        db = fs()
        buoys = db.collection("buoy_registry").stream()
        results = []

        for b in buoys:
            buoy_id = b.id

            # (1) Forecast
            forecast_id, forecast_doc = run_pipeline_forecast(buoy_id)

            # (2) Evaluate ของวันก่อนหน้า
            date_obj = (datetime.now(ICT) - timedelta(days=1)).date()
            eval_result = evaluate_for_date(buoy_id, date_obj)

            acc = 0
            if eval_result.get("metrics") and eval_result["metrics"].get("overall"):
                acc = eval_result["metrics"]["overall"].get("accuracy_pct", 0) or 0

            results.append({
                "buoy_id": buoy_id,
                "forecast_id": forecast_id,
                "status": forecast_doc.get("status_3d"),
                "wqi_avg_3d": forecast_doc.get("wqi_avg_3d"),
                "eval_smape": acc
            })

        return {"ok": True, "results": results}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------
# Run Server (for local test)
# ---------------------------------------------------------------
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    uvicorn.run(
        "app:app",
        host="0.0.0.0",
        port=port,
        reload=False
    )
