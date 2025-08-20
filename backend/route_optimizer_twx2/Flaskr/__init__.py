from flask import Flask
from .routes import route_bp
#from flask_cors import CORS    uncomment this for the CORS function

def create_app():
    app = Flask(__name__)

    # Uncomment this and add the frontend port within origins and Access-Control if frontend encounters CORS blocking

    #CORS(app, resources={r"/*": {"origins": "http://localhost:8000"}})     

    app.config["REDIS_URL"] = "redis://localhost:6379"
    app.register_blueprint(route_bp, url_prefix="/api")

    #@app.after_request
    #def add_sse_headers(response):
    #    if request.path.startswith("/stream"):
    #        response.headers["Access-Control-Allow-Origin"] = "http://localhost:8000"      put the actual port where your specific frontend is using
    #        response.headers["Access-Control-Allow-Credentials"] = "true"
    #        response.headers["Cache-Control"] = "no-cache"
    #    return response

    #If SSE still gets blocked, move the @app.after_request within the routes.py blueprint right after the sse blueprint is registered

    return app
