import os, requests, time, random, datetime, pickle
from flask import jsonify
import numpy as np
import pandas as pd

ORS_API_KEY = os.getenv("ORS_API_KEY") or os.getenv("OPENROUTESERVICE_API_KEY")

with open("xgb_eta_model.pkl", "rb") as f:
    model = pickle.load(f)

def optimize_route(input_data: dict):
    """
    Pure function: returns a Python dict (never a Flask Response).
    Shape: GeoJSON Feature on success, {"error": "..."} on failure.
    """

    if not input_data or not input_data.get("destination_points"):
        return {"error": "no destination points specified."}

    driver_details = input_data.get("driver_details") or {}
    vehicle_type = (driver_details.get("vehicle_type") or "car").lower().strip()

    profile_type = {
        "car": "driving-car",
        "truck": "driving-hgv", 
        "hgv": "driving-hgv",
        "motorcycle": "driving-car",
        "bike": "cycling-regular",
        "roadbike": "cycling-road",
        "foot": "foot-walking",
    }.get(vehicle_type, "driving-car")

    source = input_data['source_point']
    destinations = input_data['destination_points']

    if len(destinations) == 1:
        feature = _point_to_point(source, destinations[0], profile_type, driver_details)
        if "error" in feature:
            return feature
        p = feature.setdefault("properties", {})
        p['optimized_order'] = [0]
        p['source'] = source
        p['destinations'] = [destinations[0]]
        _annotate_common_props(feature, driver_details, vehicle_type, engine="backend:ors")
        return feature

    feature = _multi_stop(source, destinations, profile_type, driver_details)
    if "error" in feature:
        return feature
    
    _annotate_common_props(feature, driver_details, vehicle_type, engine="backend:ors")
    return feature



def _point_to_point(source, destination, profile_type, driver_details):
    
    coordinates = [[source['lon'], source['lat']], [destination['lon'], destination['lat']]]
    
    url = f"https://api.openrouteservice.org/v2/directions/{profile_type}/geojson"
    headers = {"Authorization": ORS_API_KEY, "Content-Type": "application/json"}
    body = {"coordinates": coordinates}

    try:
        resp = requests.post(url, json=body, headers=headers)
        resp.raise_for_status()
        feature = resp.json()['features'][0]
    except requests.RequestException as e:
        status = getattr(e.response, "status_code", "n/a")
        text = getattr(e.response, "text", str(e))
        return {"error": f"ORS directions error (status {status}): {text}"}
    
    payload = destination.get("payload", 0)
    cap = driver_details.get("vehicle_capacity", 999999)
    max_dist = float(driver_details.get("maximum_distance", 9e12))

    dist_m = float(feature['properties']['summary']['distance'])
    
    errors = []
    if payload > cap:
        errors.append("payload exceeds vehicle capacity")
    if dist_m > max_dist:
        errors.append("route distance exceeds maximum distance")
    
    if errors:
        return {"error": " | ".join(errors)}
    
    return feature

def _multi_stop(source, destinations, profile_type, driver_details):
    """
    Simple capacity-aware greedy routing over ORS Matrix, then fetch polylines per trip.
    Returns a single GeoJSON Feature with concatenated geometry and segments.
    Also emits properties.optimized_order as indexes into destinations[].
    """

    #MATRIX REQUEST
    all_points = [source] + destinations
    points_coords = [[p['lon'], p['lat']] for p in all_points]

    url = f"https://api.openrouteservice.org/v2/matrix/{profile_type}"
    headers = {"Authorization": ORS_API_KEY, "Content-Type": "application/json"}
    body = {"locations": points_coords, "metrics": ["distance"], "units": "m"}

    try:
        mresp = requests.post(url, json=body, headers=headers, timeout=30)
        mresp.raise_for_status()
        distance_matrix = mresp.json().get('distances')
        if not distance_matrix:
            return {"error": "ORS matrix returned no distances"}

    except requests.exceptions.HTTPError as e:
        status = getattr(e.response, "status_code", "n/a")
        text = getattr(e.response, "text", str(e))
        return {"error": f"ORS matrix error (status {status}): {text}"}

    #COST CALCULATION AND SORTING
    cap = float(driver_details.get("vehicle_capacity", 9e12))
    max_dist = float(driver_details.get("maximum_distance", 9e12))

    trips_indices = []
    unvisited = list(range(1, len(all_points)))

    while unvisited:

        trip = [0]
        load = 0.0
        trip_distance = 0.0
        current_index = 0

        for idx in sorted(unvisited, key=lambda i: distance_matrix[current_index][i]):
            
            demand = float(all_points[idx].get("payload", 0))
            added_distance = distance_matrix[current_index][idx] + distance_matrix[idx][0]

            if load + demand <= cap and trip_distance + added_distance <= max_dist:
                trip.append(idx)
                load += demand
                trip_distance += distance_matrix[current_index][idx]
                current_index = idx

        trip.append(0)
        trips_indices.append(trip)
        visited = set(trip[1:-1])
        unvisited = [i for i in unvisited if i not in visited]

    #ROUTE REQUEST
    combined_geometry = []
    combined_segments = []
    total_distance = 0.0
    total_duration = 0.0

    for trip in trips_indices:
        trip_points = [all_points[i] for i in trip]
        trip_coords = [[p['lon'], p['lat']] for p in trip_points]

        directions_url = f"https://api.openrouteservice.org/v2/directions/{profile_type}/geojson"
        directions_body = {"coordinates": trip_coords}

        try:
            dresp = requests.post(directions_url, json=directions_body, headers=headers, timeout=30)
            dresp.raise_for_status()
            feature = dresp.json()['features'][0]
        except requests.RequestException as e:
            status = getattr(e.response, "status_code", "n/a")
            text = getattr(e.response, "text", str(e))
            return {"error": f"ORS directions error (status {status}): {text}"}

        combined_geometry += feature['geometry']['coordinates']
        combined_segments += feature['properties'].get('segments', [])
        total_distance += float(feature['properties']['summary']['distance'])
        total_duration += float(feature['properties']['summary']['duration'])
    
    lons = [c[0] for c in combined_geometry]
    lats = [c[1] for c in combined_geometry]
    bbox = [min(lons), min(lats), max(lons), max(lats)]

    optimized_order = []
    for trip in trips_indices:
        for idx in trip[1:-1]:
            optimized_order.append(idx - 1)

    combined_feature = {
        "bbox": bbox,
        "type": "Feature",
        "geometry": {
            "type": "LineString",
            "coordinates": combined_geometry
        },
        "properties": {
            "source": source,
            "destinations": destinations,
            "segments": combined_segments,
            "summary": {
                "distance": total_distance,
                "duration": total_duration,
                "trips": len(trips_indices)
            },
        }
    }

    return combined_feature

def _annotate_common_props(feature: dict, driver_details: dict, vehicle_type: str, engine: str):
    p = feature.setdefault("properties", {})
    p['vehicle_type'] = vehicle_type
    p['driver_name'] = driver_details.get("driver_name")
    p['engine'] = engine


def simulate_route(data):

    roll_traffic = random.randint(1, 100)
    roll_weather = random.randint(1, 100)

    PICKUP_TIME = datetime.datetime.now()
    TRAFFIC = "Jam" if roll_traffic > 90 else ("High" if roll_traffic > 70 and roll_traffic <= 90 else ('Medium' if roll_traffic > 40 and roll_traffic <= 70 else 'Low'))
    WEATHER = "Stormy" if roll_weather > 90 else ("Windy" if roll_weather > 70 and roll_weather <= 90 else ('Cloudy' if roll_weather > 40 and roll_weather <= 70 else 'Sunny'))

    API_URL = 'http://127.0.0.1:5000/api/update_tracker'

    route_points = list(data['route_details']['geometry']['coordinates'])
    destinations = data['route_details']['properties']['destinations']
    distance = data['route_details']['properties']['summary']['distance']

    while route_points:

        url_data = {
            "route_id": data['driver_details']['driver_name'],
            "route": route_points,
            "destinations": destinations,
            "driver_name": data['driver_details']['driver_name'],
            "driver_age": data['driver_details']['driver_age'],
            "vehicle_type": data['driver_details']['vehicle_type'],
            "duration": data['route_details']['properties']['summary']['duration'],
            "distance": distance,
            "traffic": TRAFFIC,
            "weather": WEATHER,
            "trips": data['route_details']['properties']['summary'].get('trips', 1),
            "pickup_time": PICKUP_TIME.isoformat()
        }

        distance -= haversine_distance(route_points[0][1], route_points[0][0], route_points[1][1], route_points[1][0])
        route_points.pop(0)

        try:
            response = requests.post(API_URL, json=url_data, timeout=10)
            print(f"Sent: (points left={len(route_points)}) | Response: {response.status_code}")
        except Exception as error:
            print(f"Error posting to API: {error}")

        time.sleep(random.uniform(2.0, 5.0))

def haversine_distance(lat1, lon1, lat2, lon2):
    R = 6371000
    lat1, lon1, lat2, lon2 = map(np.radians, [lat1, lon1, lat2, lon2])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = np.sin(dlat / 2)**2 + np.cos(lat1) * np.cos(lat2) * np.sin(dlon / 2)**2
    c = 2 * np.arcsin(np.sqrt(a))
    return R * c

def format_sse_data(data):

    pickup_time = datetime.datetime.fromisoformat(data['pickup_time'])

    eta_feature_inputs = {
        "weather_Cloudy": data['weather'] == "Cloudy",
        "weather_Stormy": data['weather'] == "Stormy",
        "weather_Sunny": data['weather'] == "Sunny",
        "weather_Windy": data['weather'] == "Windy",
        "traffic_High": data['traffic'] == "High",
        "traffic_Jam": data['traffic'] == "Jam",
        "traffic_Low": data['traffic'] == "Low",
        "traffic_Medium": data['traffic'] == "Medium",
        "weekday_ordered": pickup_time.weekday(),
        "hour_ordered": pickup_time.hour,
        "distance_km": data['distance']/1000,
        "driver_age": data['driver_age']
    }

    eta = model.predict(pd.DataFrame([eta_feature_inputs]))[0]

    response_formatted = {
        "destinations": data['destinations'],
        "remaining_routes": data['route'],
        "overall_duration": data['duration'],
        "remaining_travel_distance": data['distance'],
        "estimated_completion_time": eta,
        "total_trips": data.get('trips', 1),
        "assigned_driver": data['driver_name'],
        "transport_mode": data['vehicle_type'],
        "start_time": data['pickup_time']
    }

    return response_formatted