# Flaskr/__init__.py
from flask import Flask
from flask_cors import CORS
from dotenv import load_dotenv
import os, re

from .routes import route_bp
from flask_sse import sse

def create_app():
    app = Flask(__name__)
    load_dotenv()

    CORS(
        app,
        resources={r"/api/*": {"origins": [
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            re.compile(r"https://.*\.vercel\.app"),
        ]}},
        supports_credentials=True,
    )

    # Upstash/Redis (TLS)
    app.config["REDIS_URL"] = os.getenv("REDIS_URL")

    app.register_blueprint(route_bp, url_prefix="/api")
    app.register_blueprint(sse, url_prefix="/api/realtime_feed")
    return app
