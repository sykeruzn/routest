import requests

URL_REQUEST_BODY = {
    "source_point": {"lat": 14.584630, "lon": 121.056885},
    "destination_points": [{"lat": 14.544145, "lon": 121.056617, "payload": 4}, {"lat": 14.557855, "lon": 121.066139, "payload": 4}],
    "driver_details": {
        "driver_name": "John Doe",
        "vehicle_type": "car",
        "vehicle_capacity": 5,
        "maximum_distance": 50000
    }
}

response = requests.post("http://127.0.0.1:5000/api/request_route", json=URL_REQUEST_BODY)

print("Status Code:", response.status_code)
try:
    print("Response JSON:", response.json())
except Exception:
    print("Raw Response:", response.text)