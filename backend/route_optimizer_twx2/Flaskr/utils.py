import requests, time, random, datetime
from flask import jsonify

ORS_API_KEY = "eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6Ijc1NmU4YjBlOTFlNzQzMzliY2QyZDc3NjRmYTk0YzdjIiwiaCI6Im11cm11cjY0In0="

def optimize_route(input_data):

    if not input_data.get("destination_points"):
        return jsonify({"error": "no destination points specified."})
    
    #driver_details = supabase.table("drivers").select("*").eq("driver_id", input_data.get("driver_id")).execute().data[0]  Paset up na lang if kaya nang iconnect yung Supabase huhuh
    driver_details = input_data.get("driver_details")

    if len(input_data.get("destination_points")) == 1:
        return get_point_to_point_route(input_data.get("source_point"), input_data.get("destination_points")[0], driver_details)
    else:
        return get_multi_destination_route(input_data.get("source_point"), input_data.get("destination_points"), driver_details)



def get_point_to_point_route(source, destination, driver_details):
    #source format: {"lat": <latvalue>, "lon":<lonvalue>}
    #destination format: {"lat": <latvalue>, "lon": <lonvalue>, "payload": <int_payloadvalue>}
    #driver_details format: {"vehicle_type": <str_type>, "vehicle_capacity": <int_capacityvalue>, "maximum_distance": <int_distance_meters>}

    coordinates = [[source['lon'], source['lat']], [destination['lon'], destination['lat']]]

    print("Segment coordinates:", coordinates)

    profile_type = {
        "car": "driving-car",
        "hgv": "driving-hgv",
        "bike": "cycling-regular",
        "roadbike": "cycling-road",
        "foot": "foot-walking"
    }.get(driver_details['vehicle_type'].lower().strip(), "driving-car")

    url = f"https://api.openrouteservice.org/v2/directions/{profile_type}/geojson"
    headers = {"Authorization": ORS_API_KEY, "Content-Type": "application/json"}
    body = {"coordinates": coordinates}

    try:
        resp = requests.post(url, json=body, headers=headers)
        resp.raise_for_status()

        route_computed = resp.json()['features'][0]

        errors = []
        if destination["payload"] > driver_details["vehicle_capacity"]:
            errors.append("Distance of the destination exceeds vehicle distance threshold.")
        if route_computed["properties"]["summary"]["distance"] > driver_details["maximum_distance"]:
            errors.append("Distance of the destination exceeds vehicle distance threshold.")
        if len(errors):
            return {"error": f"Selected Delivery driver's vehicle cannot accomplish task due to: {errors}"}
    
    except requests.exceptions.HTTPError:
        print("Status code:", resp.status_code)
        print("Response:", resp.text)
        return {"error": f"error code: {resp.status_code} response: {resp.text}"}

    return resp.json()['features'][0]



def get_multi_destination_route(source, destinations, driver_details):
    #source format: {"lat": <latvalue>, "lon":<lonvalue>}
    #destination format: [{"lat": <latvalue>, "lon": <lonvalue>, "payload": <int_payloadvalue>}, {"lat": <latvalue>, "lon": <lonvalue>, "payload": <int_payloadvalue>}, ...]
    #driver_details format: {"vehicle_type": <str_type>, "vehicle_capacity": <int_capacityvalue>, "maximum_distance": <int_distance_meters>}

    #MATRIX REQUEST
    profile_type = {
        "car": "driving-car",
        "hgv": "driving-hgv",
        "bike": "cycling-regular",
        "roadbike": "cycling-road",
        "foot": "foot-walking"
    }.get(driver_details['vehicle_type'].lower().strip(), "driving-car")

    all_points = [source] + destinations
    points_coords = [[p['lon'], p['lat']] for p in all_points]

    url = f"https://api.openrouteservice.org/v2/matrix/{profile_type}"
    headers = {"Authorization": ORS_API_KEY, "Content-Type": "application/json"}
    body = {
        "locations": points_coords,
        "metrics": ["distance"],
        "units": "m"
    }

    try:
        resp = requests.post(url, json=body, headers=headers)
        resp.raise_for_status()

    except requests.exceptions.HTTPError:
        print("Status code:", resp.status_code)
        print("Response:", resp.text)
        return {"error": f"error code: {resp.status_code} response: {resp.text}"}


    #COST CALCULATION AND SORTING
    distance_matrix = resp.json()['distances']

    trips = []
    unvisited = list(range(1, len(all_points)))

    while unvisited:

        trip = [0]
        load = 0
        trip_distance = 0
        current_index = 0

        for idx in sorted(unvisited, key=lambda i: distance_matrix[current_index][i]):
            
            demand = all_points[idx].get("payload", 0)
            added_distance = distance_matrix[current_index][idx] + distance_matrix[idx][0]

            if load + demand <= driver_details['vehicle_capacity'] and trip_distance + added_distance <= driver_details["maximum_distance"]:
                trip.append(idx)
                load += demand
                trip_distance += distance_matrix[current_index][idx]
                current_index = idx

        trip.append(0)
        trips.append([all_points[i] for i in trip])
        unvisited = [i for i in unvisited if i not in trip]


    #ROUTE REQUEST
    combined_geometry = []
    combined_segments = []
    total_distance = 0
    total_duration = 0

    geometry_offset = 0

    for trip_points in trips:
        trip_coords = [[p['lon'],p['lat']] for p in trip_points]
        directions_url = f"https://api.openrouteservice.org/v2/directions/{profile_type}/geojson"
        directions_body = {"coordinates": trip_coords}

        resp = requests.post(directions_url, json=directions_body, headers=headers)
        resp.raise_for_status()
        route_data = resp.json()

        combined_geometry += route_data['features'][0]['geometry']['coordinates']
        combined_segments += route_data['features'][0]['properties']['segments']

        total_distance += route_data['features'][0]['properties']['summary']['distance']
        total_duration += route_data['features'][0]['properties']['summary']['duration']
    
    lons = [c[0] for c in combined_geometry]
    lats = [c[1] for c in combined_geometry]
    bbox = [min(lons), min(lats), max(lons), max(lats)]


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
                "trips": len(trips)
            },
        }
    }

    return combined_feature


def simulate_route(data):

    PICKUP_TIME = datetime.datetime.now()

    API_URL = 'http://127.0.0.1:5000/api/update_tracker'
    route_points = data['route_details']['geometry']['coordinates']
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
            "trips": data['route_details']['properties']['summary']['trips'],
            "pickup_time": PICKUP_TIME.isoformat()
        }
        route_points.pop(0)

        try:
            response = requests.post(API_URL, json=url_data)
            print(f"Sent: {url_data} | Response: {response.status_code}")
        except Exception as error:
            print(f"Error posting to API: {error}")

        time.sleep(random.uniform(2.0, 5.0))

def format_sse_data(data):

    pickup_time = datetime.fromisoformat(data['pickup_time'])
    completion_time = pickup_time + datetime.timedelta(seconds=data['duration'])

    response_formatted = {
        "destinations": data['destinations'],
        "remaining_routes": data['route'],
        "overall_duration": data['duration'],
        "overall_travel_distance": data['distance'],
        "overall_estimated_completion_time": completion_time.isoformat(),
        "total_trips": data['trips'],
        "assigned_driver": data['driver_name'],
        "transport_mode": data['vehicle_type'],
        "start_time": data['pickup_time']
    }

    return response_formatted