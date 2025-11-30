from __future__ import annotations
from typing import Dict, Any
from config import COLLECTION_SETTINGS
from firestore_io import fs, init_firebase

# ==========================================================
# DEFAULT CONFIG (WQI)
# ==========================================================
DEFAULT_WQI_CFG: Dict[str, Any] = {
    "weights": {
        "ph": 0.30,
        "tds": 0.125,
        "ec": 0.125,
        "turbidity": 0.20,
        "temperature": 0.15,
        "rainfall": 0.10,
    },
    "rain_unit": "adc",
    "bands": {"good": [71.0, 100.0], "mid": [50.0, 70.0], "bad": [0.0, 49.0]},
    "ranges": {
        "ph": {
            "good": [6.5, 8.5],
            "mid_lo": [6.0, 6.4],
            "mid_hi": [8.6, 9.0],
            "bad_lo": [0.0, 5.9],
            "bad_hi": [9.1, 14.0],
        },
        "tds": {"good": [0, 599], "mid": [600, 900], "bad": [901, 1500]},
        "ec": {"good": [0, 894], "mid": [895, 1343], "bad": [1344, 2240]},
        "turbidity": {"good": [0, 25], "mid": [26, 100], "bad": [101, 1000]},
        "temperature": {
            "good": [26, 30],
            "mid_lo": [23, 25],
            "mid_hi": [31, 33],
            "bad_lo": [-100, 22],
            "bad_hi": [34, 100],
        },
        "rainfall": {"good": [683, 1023], "mid": [342, 682], "bad": [0, 341]},
    },
    "pi_confidence": 0.80,
}


# ==========================================================
# MERGE HELPER
# ==========================================================
def _deep_merge(base: dict, override: dict) -> dict:
    merged = dict(base)
    for k, v in (override or {}).items():
        if isinstance(v, dict) and isinstance(merged.get(k), dict):
            merged[k] = _deep_merge(merged[k], v)
        else:
            merged[k] = v
    return merged


# ==========================================================
# MAIN FUNCTION
# ==========================================================
def load_global_settings() -> Dict[str, Any]:
    """โหลด global settings จาก Firestore"""
    init_firebase()

    ref = fs().collection(COLLECTION_SETTINGS).document("global")
    snap = ref.get()

    if not snap.exists:
        print("⚠️ ไม่มี system_settings/global — ใช้ค่า DEFAULT_WQI_CFG แทน")
        return {"wqi_config": DEFAULT_WQI_CFG.copy()}

    data = snap.to_dict() or {}
    user_wqi = data.get("wqi_config") or {}
    merged = _deep_merge(DEFAULT_WQI_CFG, user_wqi)
    return {"wqi_config": merged}
