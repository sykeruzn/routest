import os, pickle, datetime as dt
import pandas as pd

_model = None

def _model_path():
    return os.getenv("ETA_MODEL_PATH") or os.path.join(
        os.path.dirname(__file__), "..", "xgb_eta_model.pkl"
    )

def _load_model():
    global _model
    if _model is not None:
        return _model
    path = _model_path()
    try:
        with open(path, "rb") as f:
            _model = pickle.load(f)
    except Exception as e:
        _model = f"ERROR:{e}"
    return _model

def predict_eta_minutes(*, weather: str, traffic: str, distance_m: float, pickup_time, driver_age: float = 30.0):
    model = _load_model()
    if not hasattr(model, "predict"):
        return None, None

    if isinstance(pickup_time, str):
        pickup_dt = dt.datetime.fromisoformat(pickup_time)
    elif isinstance(pickup_time, dt.datetime):
        pickup_dt = pickup_time
    else:
        pickup_dt = dt.datetime.now()

    feats = {
        "weather_Cloudy": (weather == "Cloudy"),
        "weather_Stormy": (weather == "Stormy"),
        "weather_Sunny":  (weather == "Sunny"),
        "weather_Windy":  (weather == "Windy"),
        "traffic_High":   (traffic == "High"),
        "traffic_Jam":    (traffic == "Jam"),
        "traffic_Low":    (traffic == "Low"),
        "traffic_Medium": (traffic == "Medium"),
        "weekday_ordered": pickup_dt.weekday(),
        "hour_ordered":    pickup_dt.hour,
        "distance_km":     float(distance_m or 0) / 1000.0,
        "driver_age":      float(driver_age or 30.0),
    }

    import pandas as pd  # ensure import even if optimized
    df = pd.DataFrame([feats])
    try:
        eta_minutes = float(model.predict(df)[0])
    except Exception:
        return None, None

    eta_ts = (pickup_dt + dt.timedelta(minutes=eta_minutes)).isoformat()
    return eta_minutes, eta_ts