import os
import requests
import time
import random
import datetime as dt

# Read your ORS key from env (safer than hard-coding)
ORS_API_KEY = os.getenv("ORS_API_KEY") or os.getenv("OPENROUTESERVICE_API_KEY")

def optimize_route(input_data: dict):
    """
    Pure function: returns a Python dict (never a Flask Response).
    Shape: GeoJSON Feature on success, {"error": "..."} on failure.
    """
    if not input_data or not input_data.get("destination_points"):
        return {"error": "no destination points specified."}

    driver_details = input_data.get("driver_details") or {}
    vehicle_type = (driver_details.get("vehicle_type") or "car").lower().strip()

    # Map vehicle type to an ORS profile for now
    profile_type = {
        "car": "driving-car",
        "truck": "driving-hgv", "hgv": "driving-hgv",
        "motorcycle": "driving-car",
        "bike": "cycling-regular",
        "roadbike": "cycling-road",
        "foot": "foot-walking",
    }.get(vehicle_type, "driving-car")

    source = input_data["source_point"]
    destinations = input_data["destination_points"]

    if len(destinations) == 1:
        feature = _point_to_point(source, destinations[0], profile_type, driver_details)
        if "error" in feature:
            return feature
        p = feature.setdefault("properties", {})
        p["optimized_order"] = [0]
        p["source"] = source
        p["destinations"] = [destinations[0]]
        _annotate_common_props(feature, driver_details, vehicle_type, engine="backend:ors")
        return feature

    feature = _multi_stop(source, destinations, profile_type, driver_details)
    if "error" in feature: return feature
    _annotate_common_props(feature, driver_details, vehicle_type, engine="backend:ors")
    return feature


# ---------- helpers ----------

def _point_to_point(source, destination, profile_type, driver_details):
    coordinates = [[source['lon'], source['lat']], [destination['lon'], destination['lat']]]
    url = f"https://api.openrouteservice.org/v2/directions/{profile_type}/geojson"
    headers = {"Authorization": ORS_API_KEY, "Content-Type": "application/json"}
    body = {"coordinates": coordinates}

    try:
        resp = requests.post(url, json=body, headers=headers, timeout=30)
        resp.raise_for_status()
        feature = resp.json()['features'][0]
    except requests.RequestException as e:
        status = getattr(e.response, "status_code", "n/a")
        text = getattr(e.response, "text", str(e))
        return {"error": f"ORS directions error (status {status}): {text}"}

    # Basic feasibility checks
    payload = destination.get("payload", 0)
    cap = driver_details.get("vehicle_capacity", 999999)
    max_dist = float(driver_details.get("maximum_distance", 9e12))

    dist_m = float(feature["properties"]["summary"]["distance"])
    errors = []
    if payload > cap:
        errors.append("payload exceeds vehicle capacity")
    if dist_m > max_dist:
        errors.append("route distance exceeds maximum_distance")
    if errors:
        return {"error": " | ".join(errors)}

    return feature


def _multi_stop(source, destinations, profile_type, driver_details):
    """
    Simple capacity-aware greedy routing over ORS Matrix, then fetch polylines per trip.
    Returns a single GeoJSON Feature with concatenated geometry and segments.
    Also emits properties.optimized_order as indexes into destinations[].
    """
    headers = {"Authorization": ORS_API_KEY, "Content-Type": "application/json"}

    # ORS Matrix over [origin + all stops]
    all_points = [source] + destinations
    points_coords = [[p['lon'], p['lat']] for p in all_points]

    matrix_url = f"https://api.openrouteservice.org/v2/matrix/{profile_type}"
    matrix_body = {"locations": points_coords, "metrics": ["distance"], "units": "m"}

    try:
        mresp = requests.post(matrix_url, json=matrix_body, headers=headers, timeout=30)
        mresp.raise_for_status()
        distance_matrix = mresp.json().get('distances')
        if not distance_matrix:
            return {"error": "ORS matrix returned no distances"}
    except requests.RequestException as e:
        status = getattr(e.response, "status_code", "n/a")
        text = getattr(e.response, "text", str(e))
        return {"error": f"ORS matrix error (status {status}): {text}"}

    # Greedy nearest-neighbor with capacity + max_distance constraints
    cap = float(driver_details.get("vehicle_capacity", 9e12))
    max_dist = float(driver_details.get("maximum_distance", 9e12))

    trips_indices = []  # list of trips, each is list of indices into all_points (0 is origin)
    unvisited = list(range(1, len(all_points)))  # 1..N

    while unvisited:
        trip = [0]  # start at origin
        load = 0.0
        trip_dist = 0.0
        current = 0

        # try nearest neighbors first
        for idx in sorted(unvisited, key=lambda i: distance_matrix[current][i]):
            demand = float(all_points[idx].get("payload", 0))
            # distance added if we go current->idx and then return to origin
            added_if_accept = distance_matrix[current][idx] + distance_matrix[idx][0]
            if (load + demand) <= cap and (trip_dist + added_if_accept) <= max_dist:
                trip.append(idx)
                load += demand
                trip_dist += distance_matrix[current][idx]
                current = idx

        trip.append(0)  # return to origin
        trips_indices.append(trip)
        # remove visited (excluding the origin 0 added twice)
        visited = set(trip[1:-1])
        unvisited = [i for i in unvisited if i not in visited]

    # Build directions per trip and combine
    combined_geometry = []
    combined_segments = []
    total_distance = 0.0
    total_duration = 0.0

    for trip in trips_indices:
        trip_points = [all_points[i] for i in trip]
        trip_coords = [[p['lon'], p['lat']] for p in trip_points]

        dir_url = f"https://api.openrouteservice.org/v2/directions/{profile_type}/geojson"
        dir_body = {"coordinates": trip_coords}
        try:
            dresp = requests.post(dir_url, json=dir_body, headers=headers, timeout=30)
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

    # optimized order as indexes into the original destinations[] (exclude origin 0)
    optimized_order = []
    for trip in trips_indices:
        for idx in trip[1:-1]:
            optimized_order.append(idx - 1)  # shift because destinations start at 0

    combined_feature = {
        "bbox": bbox,
        "type": "Feature",
        "geometry": {"type": "LineString", "coordinates": combined_geometry},
        "properties": {
            "source": source,
            "destinations": destinations,
            "optimized_order": optimized_order,
            "segments": combined_segments,   # each has steps[] your UI reads
            "summary": {
                "distance": total_distance,
                "duration": total_duration,
                "trips": len(trips_indices),
            },
        },
    }
    return combined_feature


def _annotate_common_props(feature: dict, driver_details: dict, vehicle_type: str, engine: str):
    # annotate useful metadata
    p = feature.setdefault("properties", {})
    p["vehicle_type"] = vehicle_type
    p["driver_name"] = driver_details.get("driver_name")
    p["engine"] = engine


# ---------- SSE helpers ----------

def simulate_route(data):
    PICKUP_TIME = dt.datetime.now()

    api_url = 'http://127.0.0.1:5000/api/update_tracker'
    route_points = list(data['route_details']['geometry']['coordinates'])
    destinations = data['route_details']['properties']['destinations']
    

    while route_points:
        url_data = {
            "route_id": data['driver_details']['driver_name'],
            "route": route_points,
            "destinations": destinations,
            "driver_name": data['driver_details']['driver_name'],
            "vehicle_type": data['driver_details']['vehicle_type'],
            "duration": data['route_details']['properties']['summary']['duration'],
            "distance": data['route_details']['properties']['summary']['distance'],
            "trips": data['route_details']['properties']['summary'].get('trips', 1),
            "pickup_time": PICKUP_TIME.isoformat(),
        }
        route_points.pop(0)
        try:
            response = requests.post(api_url, json=url_data, timeout=10)
            print(f"Sent: (points left={len(route_points)}) | Response: {response.status_code}")
        except Exception as error:
            print(f"Error posting to API: {error}")
        time.sleep(random.uniform(2.0, 5.0))


def format_sse_data(data):
    # FIX: use dt.datetime.fromisoformat (we import datetime as dt)
    pickup_time = dt.datetime.fromisoformat(data['pickup_time'])
    completion_time = pickup_time + dt.timedelta(seconds=float(data['duration']))
    return {
        "destinations": data['destinations'],
        "remaining_routes": data['route'],
        "overall_duration": data['duration'],
        "overall_travel_distance": data['distance'],
        "overall_estimated_completion_time": completion_time.isoformat(),
        "total_trips": data.get('trips', 1),
        "assigned_driver": data['driver_name'],
        "transport_mode": data['vehicle_type'],
        "start_time": data['pickup_time'],
    }
