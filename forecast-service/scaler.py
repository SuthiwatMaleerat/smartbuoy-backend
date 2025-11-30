# scaler.py (fixed)
import os
import joblib
from sklearn.preprocessing import StandardScaler

MODELS_DIR = "models"
SCALER_PATH = os.path.join(MODELS_DIR, "scaler.pkl")

os.makedirs(MODELS_DIR, exist_ok=True)

def save_scaler(scaler):
    joblib.dump(scaler, SCALER_PATH)

def load_scaler():
    if os.path.exists(SCALER_PATH):
        return joblib.load(SCALER_PATH)
    return None
