#Execute this file at the root folder and just do 'python tests/test_model.py' in the terminal

import pandas as pd
import pickle, datetime

with open("xgb_eta_model.pkl", "rb") as f:
    model = pickle.load(f)

weather = "Cloudy"

is_cloudy = weather == "Cloudy"
is_stormy = weather == "Stormy"
is_sunny = weather == "Sunny"
is_windy = weather == "Windy"

traffic = "High"

is_high = traffic == "High"
is_jam = traffic == "Jam"
is_low = traffic == "Low"
is_medium = traffic == "Medium"

eta_feature_inputs = {
    "weather_Cloudy": is_cloudy,
    "weather_Stormy": is_stormy,
    "weather_Sunny": is_sunny,
    "weather_Windy": is_windy,
    "traffic_High": is_high,
    "traffic_Jam": is_jam,
    "traffic_Low": is_low,
    "traffic_Medium": is_medium,
    "weekday_ordered": datetime.datetime.now().weekday(),
    "hour_ordered": datetime.datetime.now().hour,
    "distance_km": 20000/1000,
    "driver_age": 27
}

eta = model.predict(pd.DataFrame([eta_feature_inputs]))[0]

print(eta)