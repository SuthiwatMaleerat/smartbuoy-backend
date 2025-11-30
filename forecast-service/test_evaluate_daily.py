# test_evaluate_daily.py
from datetime import date
from pipeline import evaluate_for_date

print("🔄 เริ่มเทียบค่าจริงสิ้นวัน ...")

doc = evaluate_for_date("buoy_001", date_ict=date.today())

print("\n=== Evaluation Result ===")
print("WQI actual:", doc["actual"]["wqi"])
print("WQI predicted:", doc["prediction"]["wqi_pred"])
print("Accuracy WQI:", doc["metrics"]["wqi"]["accuracy_pct"], "%")
print("Overall accuracy:", doc["metrics"]["overall"]["accuracy_pct"], "%")
print("Scores:", doc["actual"]["scores"])
