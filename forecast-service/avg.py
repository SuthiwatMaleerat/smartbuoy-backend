import json
import numpy as np
from datetime import datetime
import pytz

ict = pytz.timezone("Asia/Bangkok")
data = json.load(open("history.json"))["2568-10-29"]  # ตามไฟล์ของมูน

vals = []
for ts_str, params in data.items():
    ph = params.get("ph")
    if ph is not None and 3 <= ph <= 10:
        vals.append(ph)

print("✅ Count datapoints:", len(vals))
print("✅ Avg pH:", round(np.mean(vals), 3))
print("✅ Min:", min(vals))
print("✅ Max:", max(vals))