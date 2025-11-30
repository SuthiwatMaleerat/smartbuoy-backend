import argparse
from rtdb_fetch import fetch_daily_from_rtdb
from trainer import train_linear_model

def train_model_from_rtdb(buoy_id, skip_start=None, skip_end=None):
    print(f"🚀 เทรนโมเดลจาก RTDB: {buoy_id}")
    daily = fetch_daily_from_rtdb(buoy_id)
    print(f"📊 มีข้อมูลทั้งหมด = {len(daily)} วัน")

    if skip_start and skip_end:
        daily = daily[(daily['date'] < skip_start) | (daily['date'] > skip_end)]
        print(f"✂️ หลัง skip = {len(daily)} วัน")

    if len(daily) <= 10:
        raise RuntimeError("❌ ข้อมูลไม่พอเทรน (ต้อง > 10 วัน)")

    train_linear_model(daily, buoy_id)
    print("✅ เทรนสำเร็จและบันทึกโมเดลไว้ใน /models")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--buoy", required=True)
    parser.add_argument("--skip-start")
    parser.add_argument("--skip-end")
    args = parser.parse_args()

    train_model_from_rtdb(args.buoy, args.skip_start, args.skip_end)
