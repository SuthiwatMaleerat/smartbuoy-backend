from __future__ import annotations
from typing import Dict, Any
import math
import numpy as np

# ===============================
#  WQI CONFIG LOADER
# ===============================
def from_settings(cfg: Dict[str, Any]) -> Dict[str, Any]:
    return cfg


# ===============================
#  BASIC HELPERS
# ===============================
def _lin(x, x1, x2, y1, y2):
    if x1 == x2:
        return (y1 + y2) / 2.0
    t = (x - x1) / float(x2 - x1)
    return y1 + t * (y2 - y1)

def _clamp01(v):
    return max(0.0, min(100.0, float(v)))

def _good_band(cfg): return cfg["bands"]["good"]
def _mid_band(cfg): return cfg["bands"]["mid"]
def _bad_band(cfg): return cfg["bands"]["bad"]


# ===============================
#  PARAMETER SCORING FUNCTIONS
# ===============================

def _score_ph(v: float, cfg: Dict[str, Any]) -> float:
    """pH: ต่ำกว่า 6 หรือมากกว่า 9 → 0, ปานกลางค่อย ๆ ลด"""
    if v is None or math.isnan(v):
        return 0.0
    if v < 6.0 or v > 9.0:
        return 0.0
    if 6.5 <= v <= 8.5:
        return 100.0
    if 6.0 <= v < 6.5:
        return 50.0 + (v - 6.0) / (6.5 - 6.0) * 50.0
    if 8.5 < v <= 9.0:
        return 100.0 - (v - 8.5) / (9.0 - 8.5) * 50.0
    return 0.0


def _score_descending(v, lo_good, hi_good, lo_mid, hi_mid, lo_bad, hi_bad, cfg):
    """ใช้กับ TDS / EC / Turbidity: ค่าสูง = แย่"""
    goodL, goodH = _good_band(cfg)
    midL, midH = _mid_band(cfg)
    badL, badH = _bad_band(cfg)

    if v is None or math.isnan(v):
        return 0.0

    if v <= hi_good:
        return _lin(v, lo_good, hi_good, goodH, goodL)
    if lo_mid <= v <= hi_mid:
        return _lin(v, lo_mid, hi_mid, midH, midL)
    if lo_bad <= v <= hi_bad:
        return _lin(v, lo_bad, hi_bad, badH, badL)
    return badL if v > hi_bad else goodH


def _score_ascending(v, lo_good, hi_good, lo_mid, hi_mid, lo_bad, hi_bad, cfg):
    """ใช้กับ Rainfall ADC/mV: ค่าสูง = ดี"""
    goodL, goodH = _good_band(cfg)
    midL, midH = _mid_band(cfg)
    badL, badH = _bad_band(cfg)

    if v is None or math.isnan(v):
        return 0.0

    if lo_good <= v <= hi_good:
        return _lin(v, lo_good, hi_good, goodL, goodH)
    if lo_mid <= v <= hi_mid:
        return _lin(v, lo_mid, hi_mid, midL, midH)
    if lo_bad <= v <= hi_bad:
        return _lin(v, lo_bad, hi_bad, badL, badH)
    return badL if v < lo_bad else goodH


# ===============================
#  SCORE ALL PARAMETERS
# ===============================
def score_params(means: Dict[str, float], cfg: Dict[str, Any]) -> Dict[str, float]:
    r = cfg["ranges"]
    out: Dict[str, float] = {}

    # ✅ pH
    out["ph"] = _score_ph(means.get("ph"), cfg)

    # ✅ TDS / EC / Turbidity (descending)
    out["tds"] = _score_descending(
        means.get("tds"),
        r["tds"]["good"][0], r["tds"]["good"][1],
        r["tds"]["mid"][0],  r["tds"]["mid"][1],
        r["tds"]["bad"][0],  r["tds"]["bad"][1],
        cfg
    )
    out["ec"] = _score_descending(
        means.get("ec"),
        r["ec"]["good"][0], r["ec"]["good"][1],
        r["ec"]["mid"][0],  r["ec"]["mid"][1],
        r["ec"]["bad"][0],  r["ec"]["bad"][1],
        cfg
    )
    out["turbidity"] = _score_descending(
        means.get("turbidity"),
        r["turbidity"]["good"][0], r["turbidity"]["good"][1],
        r["turbidity"]["mid"][0],  r["turbidity"]["mid"][1],
        r["turbidity"]["bad"][0],  r["turbidity"]["bad"][1],
        cfg
    )

    # ✅ Temperature: ตัว U
    T = means.get("temperature")
    if T is None or math.isnan(T):
        out["temperature"] = 0.0
    else:
        g1, g2 = r["temperature"]["good"]
        ml1, ml2 = r["temperature"]["mid_lo"]
        mh1, mh2 = r["temperature"]["mid_hi"]
        bl1, bl2 = r["temperature"]["bad_lo"]
        bh1, bh2 = r["temperature"]["bad_hi"]

        if g1 <= T <= g2:
            out["temperature"] = 100.0
        elif ml1 <= T <= ml2:
            out["temperature"] = _lin(T, ml1, ml2, 70, 50)
        elif mh1 <= T <= mh2:
            out["temperature"] = _lin(T, mh1, mh2, 70, 50)
        elif bl1 <= T <= bl2:
            out["temperature"] = _lin(T, bl1, bl2, 49, 0)
        elif bh1 <= T <= bh2:
            out["temperature"] = _lin(T, bh1, bh2, 49, 0)
        else:
            out["temperature"] = 0.0

    # ✅ Rainfall: ascending
    out["rainfall"] = _score_ascending(
        means.get("rainfall"),
        r["rainfall"]["good"][0], r["rainfall"]["good"][1],
        r["rainfall"]["mid"][0],  r["rainfall"]["mid"][1],
        r["rainfall"]["bad"][0],  r["rainfall"]["bad"][1],
        cfg
    )

    # ✅ Normalize ให้เป็น 0–100
    for k, v in out.items():
        if v is None or math.isnan(v):
            out[k] = 0.0
        else:
            out[k] = v * 100 if 0 <= v <= 1 else v

    return out


# ===============================
#  WQI SUMMARY
# ===============================
def wqi_from_scores(scores: Dict[str, float], rainfall_value: float, cfg: Dict[str, Any]) -> float:
    weights = cfg.get("weights", {})
    total_w = sum(weights.values())

    # ถ้า pH หรือค่าใดต่ำกว่า 6 → WQI = 0 ทันที
    if scores.get("ph", 100) < 50:
        return 0.0

    valid_scores = {
        k: v for k, v in scores.items()
        if v is not None and not math.isnan(v) and k in weights
    }
    if not valid_scores:
        return 0.0

    wqi = sum(valid_scores[k] * weights.get(k, 0) for k in valid_scores if k in weights) / total_w

    if math.isnan(wqi):
        wqi = 0.0

    return float(np.clip(wqi, 0, 100))


def status_from_wqi(wqi: float) -> str:
    if wqi is None:
        return "unknown"
    if wqi >= 71:
        return "good"
    if wqi >= 50:
        return "moderate"
    return "poor"
