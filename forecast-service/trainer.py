# ✅ trainer.py — Multi-Output Training for Water Params
import os
import joblib
import numpy as np
from sklearn.multioutput import MultiOutputRegressor
from sklearn.compose import TransformedTargetRegressor
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import SGDRegressor

from features import PARAMS

MODELS_DIR = "models"
MODEL_PATH = os.path.join(MODELS_DIR, "reg.pkl")
SCALER_PATH = os.path.join(MODELS_DIR, "scaler.pkl")

os.makedirs(MODELS_DIR, exist_ok=True)

def train_linear_model(df):
    """
    เทรนโมเดลให้ทำนายค่า PARAMS ทั้งหมด
    Input df ต้องมี *_mean ครบและผ่าน daily aggregate มาแล้ว
    """
    # ✅ Filter missing
    X = df[PARAMS].ffill().bfill().values.astype(float)

    # ✅ Target = ค่าในวันถัดไป (shift -1)
    y = np.roll(X, -1, axis=0)

    # ตัดแถวสุดท้ายที่ไม่มีอนาคต
    X = X[:-1]
    y = y[:-1]

    # ✅ Create scaler + normalize
    scaler = StandardScaler()
    Xs = scaler.fit_transform(X)

    # ✅ Create model
    base = SGDRegressor(
        loss="huber", epsilon=0.1,
        learning_rate="invscaling", eta0=0.01,
        max_iter=3000, random_state=42
    )
    model = MultiOutputRegressor(
        TransformedTargetRegressor(regressor=base, transformer=StandardScaler())
    )

    model.fit(Xs, y)

    # ✅ Save
    joblib.dump(model, MODEL_PATH)
    joblib.dump(scaler, SCALER_PATH)

    print("✅ Trained model saved!")
    print(f"➡ {MODEL_PATH}")
    print(f"➡ {SCALER_PATH}")

    return model, scaler
