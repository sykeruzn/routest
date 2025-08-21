from flask import Blueprint, request, jsonify
from flask_sse import sse
from .utils import optimize_route, simulate_route, format_sse_data
import threading


# --- imports & Supabase REST config ---
import os, requests
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
    #       maximum_distance: <float distance in meters> 
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
    #   }
    #   route_details: <the combined feature object provided by the request_route api>
    #}

    data = request.get_json()
    thread = threading.Thread(target=simulate_route, args=(data,))  # note the trailing comma
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
    # same behavior as /request_route for the frontend “later” switch, but now we persist
    payload = request.get_json(silent=True) or {}
    result = optimize_route(payload)
    if isinstance(result, dict) and result.get("error"):
        return jsonify(result), 400

    # --- NEW: persist best-effort (don’t fail the API if DB write fails)
    try:
        req_id = persist_request_and_result(payload, result)
        if req_id:
            result.setdefault("properties", {})["request_id"] = req_id
            result["properties"]["saved"] = True
    except Exception as e:
        print("Persist failed:", e)

    return jsonify(result), 200

@route_bp.route("/ping", methods=["GET"])
def ping():
    return jsonify({"ok": True, "service": "route-optimizer"}), 200


# --- helper to persist to Supabase via PostgREST ---
def persist_request_and_result(payload: dict, feature: dict):
    if not (SUPABASE_URL and SUPABASE_SERVICE_KEY):
        return None

    meta = payload.get("meta") or {}
    stops = {
        "destination_ids": meta.get("destination_ids") or [],
        "destination_points": payload.get("destination_points") or [],
    }
    req_row = {
        "origin_id": meta.get("origin_id"),
        "stops": stops,            # jsonb NOT NULL
        "status": "completed",
    }

    r = requests.post(f"{REST}/route_requests", headers=HEADERS, json=req_row, timeout=20)
    if not r.ok:
        print("route_requests insert failed:", r.status_code, r.text)   # <— show body
        r.raise_for_status()
    request_id = r.json()[0]["id"]

    props = (feature or {}).get("properties", {}) or {}
    summary = props.get("summary", {}) or {}
    legs = props.get("segments", []) or []

    result_row = {
        "request_id": request_id,
        "total_distance": float(summary.get("distance") or 0),
        "total_duration": float(summary.get("duration") or 0),
        "optimized_order": props.get("optimized_order") or [],
        "legs": legs,
        "geometry": feature.get("geometry") or None,
    }
    r2 = requests.post(f"{REST}/route_results", headers=HEADERS, json=result_row, timeout=20)
    if not r2.ok:
        print("route_results insert failed:", r2.status_code, r2.text)
        r2.raise_for_status()

    return request_id

# --- route history ---
@route_bp.route("/history", methods=["GET"])
def history():
    try:
        limit = int(request.args.get("limit", 20))
    except ValueError:
        limit = 20
    limit = max(1, min(limit, 100))

    # Your schema: id, origin_id, stops, request_time, status
    # route_results has created_at, totals, optimized_order
    params = {
        "select": (
            "id,request_time,origin_id,stops,"
            "route_results(id,total_distance,total_duration,optimized_order,created_at)"
        ),
        "order": "request_time.desc",
        "limit": str(limit),
    }

    try:
        r = requests.get(f"{REST}/route_requests", headers=HEADERS, params=params, timeout=20)
        r.raise_for_status()
        rows = r.json()
    except requests.RequestException as e:
        status = getattr(e.response, "status_code", "n/a")
        text = getattr(e.response, "text", str(e))
        return jsonify({"error": f"supabase fetch failed (status {status}): {text}"}), 500

    items = []
    for rr in rows:
        res = rr.get("route_results") or []
        first = res[0] if res else {}
        stops = rr.get("stops") or {}
        dest_ids = stops.get("destination_ids") or []
        items.append({
            "request_id": rr["id"],
            "created_at": rr.get("request_time"),   # <- from your schema
            "origin_id": rr.get("origin_id"),
            "dest_count": len(dest_ids),
            "total_distance": first.get("total_distance"),
            "total_duration": first.get("total_duration"),
            "optimized": bool(first.get("optimized_order") or []),
        })

    return jsonify({"items": items}), 200

# --- History detail ----------------------------------------------------------
@route_bp.route("/history/<req_id>", methods=["GET"])
def history_detail(req_id):
    """
    Returns one saved route request + its (first) result.
    Shape:
    {
      "request": { id, origin_id, stops, status, request_time },
      "result":  { total_distance, total_duration, optimized_order, legs, created_at }
    }
    """
    if not (REST and SUPABASE_SERVICE_KEY):
        return jsonify({"error": "history disabled: SUPABASE not configured"}), 503

    try:
        r = requests.get(
            f"{REST}/route_requests",
            headers=HEADERS,
            params={
                # include the embedded 1:N results as an array `route_results`
                "select": "id,origin_id,stops,status,request_time,"
                          "route_results(id,total_distance,total_duration,optimized_order,legs,created_at)",
                "id": f"eq.{req_id}",
                "limit": "1",
            },
            timeout=20,
        )
        r.raise_for_status()
        rows = r.json()
        if not rows:
            return jsonify({"error": "not found"}), 404

        req = rows[0]
        results = req.get("route_results") or []
        res = results[0] if results else None

        return jsonify({
            "request": {
                "id": req["id"],
                "origin_id": req.get("origin_id"),
                "stops": req.get("stops") or {},
                "status": req.get("status"),
                "request_time": req.get("request_time"),
            },
            "result": res
        }), 200

    except requests.RequestException as e:
        status = getattr(e.response, "status_code", "n/a")
        text = getattr(e.response, "text", str(e))
        return jsonify({"error": f"supabase fetch failed (status {status}): {text}"}), 500