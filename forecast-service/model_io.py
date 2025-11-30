# model_io.py (fixed)
import os
import joblib

MODELS_DIR = "models"
MODEL_PATH = os.path.join(MODELS_DIR, "reg.pkl")

os.makedirs(MODELS_DIR, exist_ok=True)

def save_model(model):
    joblib.dump(model, MODEL_PATH)

def load_model():
    if os.path.exists(MODELS_DIR) and os.path.exists(MODEL_PATH):
        return joblib.load(MODEL_PATH)
    return None
