# ==============================================================
# pipeline.py — Smart Buoy Forecast & Evaluate (RTDB + WQI)
# ==============================================================

from __future__ import annotations
import numpy as np
import pandas as pd
from datetime import datetime, timedelta
from typing import Dict, Any, List, Tuple
from rtdb_fetch import query_history_from_rtdb

from config import (
    COLLECTION_WEEKLY_FORECASTS,
    COLLECTION_ALERTS,
    COLLECTION_EVALS,
    TRAIN_LOOKBACK_DAYS,
    FORECAST_HORIZON_DAYS,
    QC_BOUNDS,
    ICT,
    COLLECTION_BUOYS,
    PI_LOW_Q,
    PI_HIGH_Q
)

from features import make_supervised, PARAMS, PARAM_KEYS
from firestore_io import (
    write_weekly_forecast,
    write_alert,
    write_eval,
    get_buoy_latlon,
    fs,
    query_sensor_readings_from_rtdb,
)
from settings_io import load_global_settings
from wqi import from_settings, score_params, wqi_from_scores, status_from_wqi
from model_io import load_model
from scaler import load_scaler
from trainer import train_linear_model


# ---------------------------------------------------------------
# Aggregate to Daily
# ---------------------------------------------------------------
def _aggregate_daily(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return pd.DataFrame()

    d = df.copy()

    if "timestamp_ms" in d.columns:
        d["timestamp"] = pd.to_datetime(d["timestamp_ms"], unit="ms", utc=True, errors="coerce")
    elif "timestamp" in d.columns:
        d["timestamp"] = pd.to_datetime(d["timestamp"], utc=True, errors="coerce")
    else:
        raise RuntimeError("❌ ไม่มี timestamp_ms หรือ timestamp")

    d = d.dropna(subset=["timestamp"])
    d["timestamp"] = d["timestamp"].dt.tz_convert(ICT)
    d = d.sort_values("timestamp")

    pivot = d.pivot_table(index="timestamp", columns="sensor_type", values="value", aggfunc="mean")
    hourly = pivot.resample("1h").mean()
    daily_cov = ((~hourly.isna()).any(axis=1).astype(int)).resample("1D").sum() / 24.0
    daily_mean = hourly.resample("1D").mean()

    out = pd.DataFrame(index=daily_mean.index)
    for k in PARAM_KEYS:
        col = f"{k}_mean"
        if k in daily_mean.columns:
            out[col] = daily_mean[k]
        else:
            out[col] = np.nan

    out["day_coverage"] = daily_cov.reindex(out.index).fillna(0.0)
    out.index = out.index.tz_convert(ICT).normalize()
    return out


# ---------------------------------------------------------------
# Residual Bank
# ---------------------------------------------------------------
def _compute_residual_bank_safe(daily, model, scaler):
    residual_bank = {}
    train_cols = [c for c in daily.columns if c.endswith("_mean")]

    try:
        X = daily[train_cols].values.astype(float)
        Xs = scaler.transform(X)
        yhat = model.predict(Xs)

        for i, name in enumerate(PARAM_KEYS):
            col = f"{name}_mean"
            if col in daily.columns:
                actual = daily[col].values
                pred = yhat[:, i]
                res = actual - pred
                res = res[~np.isnan(res)]
                residual_bank[col] = res if len(res) > 0 else np.array([])
    except Exception as e:
        print(f"⚠️ Residual compute error: {e}")
        for name in PARAM_KEYS:
            residual_bank[f"{name}_mean"] = np.array([])

    print("✅ residual_bank ready:", {k: len(v) for k,v in residual_bank.items()})
    return residual_bank

# ---------------------------------------------------------------
# Monte Carlo Forecast
# ---------------------------------------------------------------
def _probabilities_from_mc(pred_map, residual_bank, wqi_cfg,
                           rainfall_value=None, n_draws=500,
                           alpha_low=0.10, alpha_high=0.90,
                           return_samples=False, rng_seed=1234):

    rng = np.random.default_rng(rng_seed)

    # ✅ Base predicted values
    base = {k.replace("_mean", ""): pred_map.get(k) for k in PARAMS}

    # ✅ Collect samples
    samples = {k: [] for k in PARAM_KEYS}

    for _ in range(n_draws):
        row = {}
        for name in PARAM_KEYS:
            km = f"{name}_mean"
            v = base.get(name)

            if v is None or (isinstance(v, float) and np.isnan(v)):
                val = np.nan
            else:
                if km in residual_bank and residual_bank[km].size > 0:
                    rv = float(rng.choice(residual_bank[km]))
                    val = v + rv
                else:
                    val = v

                if name in QC_BOUNDS:
                    lo, hi = QC_BOUNDS[name]
                    val = np.clip(val, lo, hi)

            row[name] = float(val)

        if rainfall_value is not None:
            row["rainfall"] = float(rainfall_value)

        for name in PARAM_KEYS:
            samples[name].append(row[name])

    # ✅ Compute WQI distribution
    wqi_arr = []
    for i in range(n_draws):
        m = {k: samples[k][i] for k in PARAM_KEYS}
        sc = score_params(m, wqi_cfg)
        wqi_arr.append(wqi_from_scores(sc, m.get("rainfall"), wqi_cfg))
    wqi_arr = np.array(wqi_arr, dtype=float)

    probs = {
        "wqi_lt_60": float((wqi_arr < 60).mean()),
        "wqi_lt_50": float((wqi_arr < 50).mean()),
        "warn_or_worse": float((wqi_arr < 70).mean())
    }

    # ✅ PI สำหรับ params
    param_pi = {}
    for name in PARAM_KEYS:
        arr = np.array(samples[name], dtype=float)
        if np.nanstd(arr) < 1e-6:
            m = float(np.nanmean(arr))
            param_pi[name] = (m * 0.95, m * 1.05)
        else:
            param_pi[name] = (
                float(np.nanquantile(arr, alpha_low)),
                float(np.nanquantile(arr, alpha_high))
            )

    # ✅ PI สำหรับ WQI
    wqi_val = float(np.nanmean(wqi_arr))
    if np.nanstd(wqi_arr) < 1e-6:
        wqi_pi_low = wqi_val * 0.95
        wqi_pi_high = wqi_val * 1.05
    else:
        wqi_pi_low = float(np.nanquantile(wqi_arr, PI_LOW_Q))
        wqi_pi_high = float(np.nanquantile(wqi_arr, PI_HIGH_Q))

    if return_samples:
        return probs, wqi_arr, param_pi

    return probs, None, param_pi


# ---------------------------------------------------------------
# Normalize Status → Severity
# ---------------------------------------------------------------
def _status_to_severity(status: str) -> str:
    s = (status or "").strip().lower()
    mapping = {
        "good": "info",
        "moderate": "warning",
        "fair": "warning",
        "poor": "critical",
        "bad": "critical",
        "very poor": "critical",
    }
    return mapping.get(s, "info")


# ---------------------------------------------------------------
# Forecast Pipeline
# ---------------------------------------------------------------
def run_pipeline_forecast(buoy_id: str):
    rows = query_history_from_rtdb(buoy_id, days=TRAIN_LOOKBACK_DAYS)
    if not rows:
        raise RuntimeError("ไม่มีข้อมูลพอสำหรับเทรน")

    df = pd.DataFrame(rows, columns=["timestamp", "sensor_type", "value"])
    daily = _aggregate_daily(df)
    if daily.empty:
        raise RuntimeError("ไม่มีข้อมูลรายวันหลัง aggregate")

    cfg = load_global_settings()["wqi_config"]
    wqi_cfg = from_settings(cfg)

    model = load_model()
    scaler = load_scaler()
    if model is None or scaler is None:
        print("⚠️ Model/Scaler not found → training new model…")
        model, scaler = train_linear_model(daily)

    today = datetime.now(ICT).date()
    forecast_dates = [(today + timedelta(days=i)).isoformat()
                      for i in range(FORECAST_HORIZON_DAYS)]
    residual_bank = _compute_residual_bank_safe(daily, model, scaler)

    latest = daily.iloc[-1]
    fallback = {k: latest.get(k) for k in [f"{p}_mean" for p in PARAM_KEYS]}

    roll = daily.copy()
    roll.index = pd.to_datetime(roll.index, errors='coerce')
    if roll.index.tz is None:
        roll.index = roll.index.tz_localize(ICT)
    else:
        roll.index = roll.index.tz_convert(ICT)
    roll.index = roll.index.normalize()

    forecast_days = []

    def predict_next(df_roll):
        train_cols = [c for c in df_roll.columns if c.endswith("_mean")]
        X_last = df_roll[train_cols].iloc[-1:].astype(float)
        try:
            Xs = scaler.transform(X_last.values)
            yhat = model.predict(Xs).reshape(-1)
        except:
            yhat = [fallback.get(f"{k}_mean") for k in PARAM_KEYS]

        clean = {}
        for name, v in zip(PARAM_KEYS, yhat):
            lo, hi = QC_BOUNDS[name]
            clean[name] = float(np.clip(v, lo, hi))
        return np.array([clean[k] for k in PARAM_KEYS], dtype=float)

    for i, dstr in enumerate(forecast_dates):
        yhat = predict_next(roll)
        pred_map = dict(zip([f"{p}_mean" for p in PARAM_KEYS], yhat))
        means = {k.replace("_mean", ""): float(pred_map[k]) for k in pred_map}

        probs, wqi_samples, per_param_pi = _probabilities_from_mc(
            pred_map, residual_bank, wqi_cfg,
            rainfall_value=means.get("rainfall"),
            n_draws=500, return_samples=True, rng_seed=1000 + i
        )

        scores = score_params(means, wqi_cfg)
        wqi_val = wqi_from_scores(scores, means.get("rainfall"), wqi_cfg)

        if np.nanstd(wqi_samples) < 1e-6:
            wqi_pi_low = wqi_val * 0.95
            wqi_pi_high = wqi_val * 1.05
        else:
            wqi_pi_low = float(np.nanquantile(wqi_samples, PI_LOW_Q))
            wqi_pi_high = float(np.nanquantile(wqi_samples, PI_HIGH_Q))

        params_block = {
            name: {
                "mean": means[name],
                "pi_low": per_param_pi[name][0],
                "pi_high": per_param_pi[name][1]
            }
            for name in PARAM_KEYS
        }

        forecast_days.append({
            "date": dstr,
            "params": params_block,
            "wqi": {
                "value": wqi_val,
                "status": status_from_wqi(wqi_val),
                "confidence": 0.80,
                "probs": probs,
                "pi": {"low": wqi_pi_low, "high": wqi_pi_high}
            }
        })

        next_row = {f"{k}_mean": means[k] for k in PARAM_KEYS}
        ts = pd.to_datetime(dstr, errors='coerce')
        if ts.tzinfo is None:
            ts = ts.tz_localize(ICT)
        else:
            ts = ts.tz_convert(ICT)
        ts = ts.normalize()
        roll.loc[ts] = next_row

    wqi_avg_3d = float(np.mean([d["wqi"]["value"] for d in forecast_days]))
    status_3d = status_from_wqi(wqi_avg_3d)

    doc = {
        "buoy_id": buoy_id,
        "daily": forecast_days,
        "wqi_avg_3d": wqi_avg_3d,
        "status_3d": status_3d,
        "forecast_date": today.isoformat(),
        "created_at": datetime.now(ICT).isoformat()
    }
    forecast_id = write_weekly_forecast(doc, COLLECTION_WEEKLY_FORECASTS)

    # ✅ Forecast Alerts
    buoy_doc = fs().collection("buoy_registry").document(buoy_id).get()
    buoy_uid = buoy_doc.to_dict().get("uid") if buoy_doc.exists else None

    for day in forecast_days:
        wqi_val = day["wqi"]["value"]
        status = day["wqi"]["status"]
        date_str = day["date"]

        severity = _status_to_severity(status)

        # ✅ No alert when good
        if severity == "info":
            continue

        message = f"พยากรณ์คุณภาพน้ำ {severity.upper()} วันที่ {date_str} (WQI={round(wqi_val,1)})"
        reason = f"Forecast WQI = {round(wqi_val,1)}, status = {status}"

        write_alert({
            "buoy_id": buoy_id,
            "uid": buoy_uid,
            "category": "forecast_wqi",
            "severity": severity,
            "parameter": None,
            "value": wqi_val,
            "message": message,
            "reason": reason,
            "origin": "forecast",
            "ref_date": date_str,
        }, COLLECTION_ALERTS)

    return forecast_id, doc


#----------------------------------
# Evaluation
# ---------------------------------------------------------------
def evaluate_for_date(buoy_id: str, date_ict=None):
    if date_ict is None:
        date_ict = datetime.now(ICT).date()

    rows = query_sensor_readings_from_rtdb(buoy_id, days=60)
    if not rows:
        raise RuntimeError(f"ไม่พบข้อมูลของ {buoy_id}")

    df = pd.DataFrame(rows, columns=["timestamp", "sensor_type", "value"])
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True, errors="coerce")
    df = df.dropna(subset=["timestamp"])
    df["timestamp"] = df["timestamp"].dt.tz_convert(ICT)
    df = df.sort_values("timestamp")
    pivot = df.pivot_table(index="timestamp", columns="sensor_type", values="value", aggfunc="mean")
    hourly = pivot.resample("1h").mean()
    daily = hourly.resample("1D").mean()
    daily.index = daily.index.tz_convert(ICT).normalize()

    target = pd.to_datetime(date_ict).tz_localize(ICT).normalize()
    if target not in daily.index:
        actual = daily.iloc[-1]
    else:
        actual = daily.loc[target]

    actual_means = {k: float(actual[k]) if k in actual else None for k in PARAM_KEYS}

    cfg = load_global_settings()["wqi_config"]
    wqi_cfg = from_settings(cfg)
    scores = score_params(actual_means, wqi_cfg)
    wqi_actual = wqi_from_scores(scores, actual_means.get("rainfall"), wqi_cfg)
    status_actual = status_from_wqi(wqi_actual)

    preds_docs = list(
        fs().collection(COLLECTION_WEEKLY_FORECASTS)
        .where("buoy_id", "==", buoy_id)
        .stream()
    )

    pred_for_day = None
    parent_id = None
    parent_doc = None

    for s in preds_docs:
        d = s.to_dict() or {}
        for e in d.get("daily", []):
            if e.get("date") == str(date_ict):
                pred_for_day = e
                parent_id = s.id
                parent_doc = d
                break
        if pred_for_day:
            break

    def _smape(a, p):
        if a is None or p is None:
            return None
        denom = (abs(a) + abs(p)) / 2.0
        if denom < 1e-9:
            return 0.0
        return abs(p - a) / denom

    def _acc_pct(sm):
        if sm is None:
            return None
        return max(0.0, min(100.0, (1 - float(sm)) * 100.0))

    by_param = {}
    sm_list = []
    for k in PARAM_KEYS:
        a = actual_means.get(k)
        p = None
        if isinstance(pred_for_day, dict):
            p = pred_for_day.get("params", {}).get(k, {}).get("mean")
        sm = _smape(a, p)
        by_param[k] = {
            "actual": a,
            "pred": p,
            "smape": sm,
            "accuracy_pct": _acc_pct(sm)
        }
        if sm is not None:
            sm_list.append(sm)

    wqi_pred = None
    if isinstance(pred_for_day, dict):
        wqi_pred = pred_for_day.get("wqi", {}).get("value")

    wqi_smape = _smape(wqi_actual, wqi_pred)
    wqi_acc = _acc_pct(wqi_smape)
    overall_smape = float(np.nanmean(sm_list)) if sm_list else None
    overall_acc = _acc_pct(overall_smape)

    eval_doc = {
        "buoy_id": buoy_id,
        "date": str(date_ict),
        "actual": {
            "params": actual_means,
            "wqi": wqi_actual,
            "status": status_actual
        },
        "prediction": {
            "found": pred_for_day is not None,
            "wqi_pred": wqi_pred
        },
        "metrics": {
            "by_param": by_param,
            "wqi": {
                "actual": wqi_actual,
                "pred": wqi_pred,
                "smape": wqi_smape,
                "accuracy_pct": wqi_acc
            },
            "overall": {
                "smape": overall_smape,
                "accuracy_pct": overall_acc
            }
        },
        "created_at": datetime.now(ICT).isoformat()
    }

    write_eval(eval_doc, COLLECTION_EVALS)

    if parent_id and parent_doc:
        daily_list = parent_doc.get("daily", [])
        for d in daily_list:
            if d.get("date") == str(date_ict):
                d.setdefault("actual", {})
                d["actual"]["params"] = actual_means
                d["actual"]["wqi"] = wqi_actual
                d["actual"]["status"] = status_actual
                d["wqi"]["accuracy_pct"] = wqi_acc
                break

        fs().collection(COLLECTION_WEEKLY_FORECASTS).document(parent_id).update({"daily": daily_list})

    print(f"✅ Evaluate Saved: {date_ict} | acc={overall_acc}")
    return eval_doc

