from flask import Blueprint, request, jsonify
from flask_sse import sse
from .utils import optimize_route, simulate_route, format_sse_data
import threading

route_bp = Blueprint('main', __name__)

route_bp.register_blueprint(sse, url_prefix='/realtime_feed')

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
    thread = threading.Thread(target=simulate_route, args=(data))
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