from flask import Blueprint, request, jsonify
from flask_sse import sse
from .utils import optimize_route, simulate_route, format_sse_data
import threading
import time
import redis
import os, requests
import datetime as dt
from .ml import predict_eta_minutes

ORS_API_KEY = os.getenv("ORS_API_KEY")
REDIS_URL = os.getenv("REDIS_URL")

# --- imports & Supabase REST config ---
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
    payload = request.get_json(silent=True) or {}
    result = optimize_route(payload)
    if isinstance(result, dict) and result.get("error"):
        return jsonify(result), 400

    # --- Optional ML ETA when requested (compute BEFORE persisting) ---
    if payload.get("use_ml_eta"):
        props = result.setdefault("properties", {}) or {}
        summary = props.get("summary", {}) or {}
        distance_m = float(summary.get("distance") or 0)

        ctx = payload.get("context") or {}
        weather = ctx.get("weather", "Sunny")
        traffic = ctx.get("traffic", "Low")
        driver_age = float((payload.get("driver_details") or {}).get("driver_age", 30))

        eta_min, eta_iso = predict_eta_minutes(
            weather=weather,
            traffic=traffic,
            distance_m=distance_m,
            pickup_time=dt.datetime.now(),
            driver_age=driver_age,
        )
        if eta_min is not None:
            props["eta_minutes_ml"] = eta_min
            props["eta_completion_time_ml"] = eta_iso

    # --- best-effort persistence (now includes engine + ML fields) ---
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
    driver = payload.get("driver_details") or {}
    engine = "ml" if payload.get("use_ml_eta") else "default"

    stops = {
        "destination_ids": meta.get("destination_ids") or [],
        "destination_points": payload.get("destination_points") or [],
    }

    # --- route_requests row ---
    req_row = {
        "origin_id": meta.get("origin_id"),
        "stops": stops,                        # jsonb NOT NULL
        "status": "completed",
        "engine": engine,
        "vehicle_id": driver.get("driver_name"),
        "driver_age": driver.get("driver_age"),
    }
    r = requests.post(f"{REST}/route_requests", headers=HEADERS, json=req_row, timeout=20)
    if not r.ok:
        print("route_requests insert failed:", r.status_code, r.text)
        r.raise_for_status()
    request_id = r.json()[0]["id"]

    props   = (feature or {}).get("properties", {}) or {}
    summary = props.get("summary", {}) or {}
    legs    = props.get("segments", []) or []

    # --- route_results row (with ML fields if present) ---
    result_row = {
        "request_id": request_id,
        "total_distance": float(summary.get("distance") or 0),
        "total_duration": float(summary.get("duration") or 0),
        "optimized_order": props.get("optimized_order") or [],
        "legs": legs,
        "geometry": feature.get("geometry") or None,
        "eta_minutes_ml": props.get("eta_minutes_ml"),
        "eta_completion_time_ml": props.get("eta_completion_time_ml"),
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

    params = {
        "select": (
            "id,request_time,origin_id,stops,engine,vehicle_id,driver_age,"
            "route_results(id,total_distance,total_duration,optimized_order,created_at,eta_minutes_ml,eta_completion_time_ml)"
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
            "created_at": rr.get("request_time"),
            "origin_id": rr.get("origin_id"),
            "dest_count": len(dest_ids),
            "total_distance": first.get("total_distance"),
            "total_duration": first.get("total_duration"),
            "optimized": bool(first.get("optimized_order") or []),
            "engine": rr.get("engine") or "default",
            "vehicle_id": rr.get("vehicle_id"),
            "eta_minutes_ml": first.get("eta_minutes_ml"),
            "eta_completion_time_ml": first.get("eta_completion_time_ml"),
        })

    return jsonify({"items": items}), 200

# --- History detail ----------------------------------------------------------
@route_bp.route("/history/<req_id>", methods=["GET"])
def history_detail(req_id):
    if not (REST and SUPABASE_SERVICE_KEY):
        return jsonify({"error": "history disabled: SUPABASE not configured"}), 503

    try:
        r = requests.get(
            f"{REST}/route_requests",
            headers=HEADERS,
            params={
                "select": (
                    "id,origin_id,stops,status,request_time,engine,vehicle_id,driver_age,"
                    "route_results(id,total_distance,total_duration,optimized_order,legs,created_at,eta_minutes_ml,eta_completion_time_ml,geometry)"
                ),
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
                "engine": req.get("engine") or "default",
                "vehicle_id": req.get("vehicle_id"),
                "driver_age": req.get("driver_age"),
            },
            "result": res
        }), 200

    except requests.RequestException as e:
        status = getattr(e.response, "status_code", "n/a")
        text = getattr(e.response, "text", str(e))
        return jsonify({"error": f"supabase fetch failed (status {status}): {text}"}), 500

# ── tiny helpers ────────────────────────────────────────────────────────────────
def _check_redis():
    if not REDIS_URL:
        return {"status": "skipped", "latency_ms": 0, "reason": "REDIS_URL not set"}
    t0 = time.time()
    try:
        # NOTE: TLS is inferred from rediss:// — do not pass ssl= for redis-py 6.x
        r = redis.Redis.from_url(
            REDIS_URL,
            socket_timeout=2,
            socket_connect_timeout=2,
        )
        r.ping()
        return {"status": "ok", "latency_ms": int((time.time() - t0) * 1000)}
    except Exception as e:
        return {"status": "error", "latency_ms": int((time.time() - t0) * 1000), "error": str(e)[:200]}

def _check_routing_engine():
    """Treat any HTTP response from ORS as reachable; only network errors are 'error'."""
    t0 = time.time()
    try:
        head = requests.head("https://api.openrouteservice.org", timeout=2)
        # If you have a key, make a lightweight GET to confirm authenticated path reachability.
        code = head.status_code
        status = "ok" if 200 <= code < 400 else "degraded"
        if ORS_API_KEY:
            try:
                r = requests.get(
                    "https://api.openrouteservice.org/health",
                    headers={"Authorization": ORS_API_KEY},
                    timeout=2,
                )
                # 2xx => ok; 401/403/404 => degraded but reachable
                status = "ok" if 200 <= r.status_code < 300 else "degraded"
                code = r.status_code
            except Exception:
                # keep prior reachability result
                pass
        return {
            "status": status,
            "latency_ms": int((time.time() - t0) * 1000),
            "engine": "ors",
            "code": code,
        }
    except Exception as e:
        return {"status": "error", "latency_ms": int((time.time() - t0) * 1000), "engine": "ors", "error": str(e)[:200]}

def _check_supabase_rest():
    if not (REST and SUPABASE_SERVICE_KEY):
        return {"status": "skipped", "latency_ms": 0, "reason": "SUPABASE not configured"}
    t0 = time.time()
    try:
        r = requests.get(f"{REST}/route_requests", headers=HEADERS, params={"select": "id", "limit": "1"}, timeout=3)
        return {"status": "ok" if 200 <= r.status_code < 300 else "degraded",
                "latency_ms": int((time.time() - t0) * 1000), "code": r.status_code}
    except Exception as e:
        return {"status": "error", "latency_ms": int((time.time() - t0) * 1000), "error": str(e)[:200]}

@route_bp.route("/health", methods=["GET"])
def health():
    redis_res = _check_redis()
    engine_res = _check_routing_engine()
    db_res = _check_supabase_rest()

    parts = (redis_res["status"], engine_res["status"], db_res["status"])
    if any(s == "error" for s in parts):
        overall = "degraded"   # keep HTTP 200 for Render probes
    elif any(s == "degraded" for s in parts):
        overall = "degraded"
    else:
        overall = "ok"

    payload = {
        "backend": True,
        "checks": {"engine": engine_res, "redis": redis_res, "supabase": db_res},
        "db": db_res["status"] == "ok",
        "osrm": engine_res["status"] in ("ok", "degraded"),
        "redis": redis_res["status"] == "ok",
        "tiles": True,
        "status": overall,
        "version": os.getenv("RENDER_GIT_COMMIT") or os.getenv("GIT_COMMIT_SHA"),
    }
    return jsonify(payload), 200

@route_bp.route("/predict_eta", methods=["POST"])
def predict_eta_endpoint():
    body = request.get_json(silent=True) or {}
    summary = body.get("summary") or {}
    pickup = body.get("pickup_time") or dt.datetime.now().isoformat()
    driver_age = float(body.get("driver_age", 30))
    weather = body.get("weather", "Sunny")
    traffic = body.get("traffic", "Low")

    eta_min, eta_iso = predict_eta_minutes(
        weather=weather,
        traffic=traffic,
        distance_m=float(summary.get("distance") or 0),
        pickup_time=pickup,
        driver_age=driver_age,
    )
    if eta_min is None:
        return jsonify({"error": "model unavailable"}), 503
    return jsonify({"eta_minutes_ml": eta_min, "eta_completion_time_ml": eta_iso}), 200

# DELETE /history/<request_id>  — remove one saved route (FK cascade to route_results)
@route_bp.route("/history/<req_id>", methods=["DELETE"])
def delete_history(req_id):
    if not (REST and SUPABASE_SERVICE_KEY):
        return jsonify({"error": "history disabled: SUPABASE not configured"}), 503

    try:
        headers = dict(HEADERS)       # avoid asking PostgREST to return the deleted rows
        headers.pop("Prefer", None)
        r = requests.delete(
            f"{REST}/route_requests",
            headers=headers,
            params={"id": f"eq.{req_id}"},
            timeout=10,
        )
        if r.status_code not in (200, 204):
            return jsonify({"error": f"delete failed: {r.status_code} {r.text}"}), 500
        return ("", 204)
    except requests.RequestException as e:
        status = getattr(e.response, "status_code", "n/a")
        text = getattr(e.response, "text", str(e))
        return jsonify({"error": f"supabase delete failed (status {status}): {text}"}), 500