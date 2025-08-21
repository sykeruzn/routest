from flask import Blueprint, request, jsonify
from flask_sse import sse
from .utils import optimize_route, simulate_route, format_sse_data
import threading, os, requests

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
REST = f"{SUPABASE_URL}/rest/v1" if SUPABASE_URL else None
HEADERS = {
    "apikey": SUPABASE_SERVICE_KEY or "",
    "Authorization": f"Bearer {SUPABASE_SERVICE_KEY or ''}",
    "Content-Type": "application/json",
    "Prefer": "return=representation",
}

route_bp = Blueprint('main', __name__)

#this route is where to call the optimized route calculator 
@route_bp.route('/request_route', methods=['POST'])
def request_route():

    #request should be:
    #{
    #   source_point: {"lat": <latvalue>, "lon":<lonvalue>}
    #   destination_points: [{"lat": <latvalue>, "lon":<lonvalue>, "payload": <int payload value>}, {"lat": <latvalue>, "lon":<lonvalue>, "payload": <int payload value>}...],
    #   driver_details: {
    #       driver_name: <str name>,
    #       vehicle_type: <str vehicle type>,    
    #       vehicle_capacity: <int capacity value>,
    #       maximum_distance: <float distance in meters> ,
    #       driver_age: <int age value>
    #   }
    #}

    data = request.get_json()
    response = optimize_route(data)

    if not response:
        return jsonify({"error": "no response acquired from the optimizer."}), 400

    return jsonify(response), 200

#this route is for simulation purposes only, remove once a gps tracking system has been properly set up
@route_bp.route('/confirm_route', methods=['POST'])
def confirm_route():

    #request should be:
    #{
    #   driver_details: {
    #       driver_name: <str name>,
    #       vehicle_type: <str vehicle type>,    
    #       vehicle_capacity: <int capacity value>,
    #       maximum_distance: <float distance in meters> 
    #       driver_age: <int age value>
    #   }
    #   route_details: <the combined feature object provided by the request_route api>
    #}

    data = request.get_json()
    thread = threading.Thread(target=simulate_route, args=(data,))
    thread.daemon = True
    thread.start()

    return jsonify({"status": "route simulation initialized."}), 200

#this route is where the real-time reading of the driver's location will be published to the sse channel of the route
@route_bp.route('/update_tracker', methods=['POST'])
def update_tracker():

    data = request.get_json()

    if not data:
        return jsonify({"error": "no data provided in the publish request."}), 400

    route_id = data.get("route_id")
    response = format_sse_data(data)

    sse.publish(response, channel=f'{route_id}')
    return jsonify({"status": "published"}), 200

@route_bp.route('/optimize_route', methods=['POST'])
def optimize_route_alias():
    payload = request.get_json(silent=True) or {}
    result = optimize_route(payload)
    if isinstance(result, dict) and result.get("error"):
        return jsonify(result), 400
    
    try:
        req_id = persist_request_and_result(payload, result)
        if req_id:
            result.setdefault("properties", {})['request_id'] = req_id
            result['properties']['saved'] = True
    except Exception as e:
        print ("Persist failed: ", e)

    return jsonify(result), 200

@route_bp.route("/ping", methods=["GET"])
def ping():
    return jsonify({"ok": True, "service": "route-optimizer"}), 200




# --- NEW: helper to persist to Supabase via PostgREST ---
def persist_request_and_result(payload: dict, feature: dict):
    """
    Inserts into route_requests and route_results.
    Returns the request_id (uuid) or None on failure.
    """
    if not (SUPABASE_URL and SUPABASE_SERVICE_KEY):
        # Not configured: skip persistence silently
        return None

    meta = payload.get("meta") or {}
    stops = {
        "destination_ids": meta.get("destination_ids") or [],
        "destination_points": payload.get("destination_points") or [],
    }
    req_row = {
        "origin_id": meta.get("origin_id"),
        "stops": stops,            # jsonb
        "status": "completed",     # or "pending" then update later
    }

    r = requests.post(f"{REST}/route_requests", headers=HEADERS, json=req_row, timeout=20)
    r.raise_for_status()
    request_id = r.json()[0]["id"]

    props = feature.get("properties", {}) or {}
    summary = props.get("summary", {}) or {}
    legs = props.get("segments", []) or []

    result_row = {
        "request_id": request_id,
        "total_distance": float(summary.get("distance") or 0),
        "total_duration": float(summary.get("duration") or 0),
        "optimized_order": props.get("optimized_order") or [],   # jsonb
        "legs": legs,                                            # jsonb
    }
    r2 = requests.post(f"{REST}/route_results", headers=HEADERS, json=result_row, timeout=20)
    r2.raise_for_status()

    return request_id