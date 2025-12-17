# ============================================================================
# GOLDEN AGE AVIATION - Backend API Proxy Server v2.0
# ============================================================================
# Features:
#   - vAMSYS flight data proxy
#   - SimBrief route integration via pilot ID mapping
#   - Automatic fallback when SimBrief data unavailable
#
# Usage:
#   Development: python server.py
#   Production:  gunicorn server:app
# ============================================================================

import os
import json
import logging
from flask import Flask, jsonify, request
#from flask_cors import CORS
from dotenv import load_dotenv

# Import token manager
from vamsys_token import (
    initialize_vamsys_token,
    get_vamsys_token,
    get_token_status,
    start_background_refresh
)

# Load environment variables from .env file
load_dotenv()

# ============================================================================
# CONFIGURATION
# ============================================================================

DEBUG = os.environ.get("DEBUG", "false").lower() == "true"
PORT = int(os.environ.get("PORT", 20591))
HOST = os.environ.get("HOST", "0.0.0.0")

# CORS origins - explicit list for Cloudflare proxy compatibility
ALLOWED_ORIGINS = [
    "https://www.goldenageaviation.org",
    "https://goldenageaviation.org",
]
# vAMSYS API endpoint
VAMSYS_FLIGHT_MAP_URL = "https://vamsys.io/api/v3/operations/flight-map"

# SimBrief Pilot ID mapping file (shared with Discord bot)
SIMBRIEF_PILOT_IDS_FILE = os.environ.get("SIMBRIEF_PILOT_IDS_FILE", "simbrief_pilot_ids.json")

# ============================================================================
# LOGGING SETUP
# ============================================================================

logging.basicConfig(
    level=logging.DEBUG if DEBUG else logging.INFO,
    format="[%(asctime)s] %(levelname)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
logger = logging.getLogger(__name__)

# ============================================================================
# SIMBRIEF PILOT ID MAPPING
# ============================================================================

def load_simbrief_pilot_ids():
    """
    Load SimBrief Pilot ID mappings from JSON file.
    File format: { "GAA0001": "1064508", "GAA0002": "462080", ... }
    """
    try:
        if os.path.exists(SIMBRIEF_PILOT_IDS_FILE):
            with open(SIMBRIEF_PILOT_IDS_FILE, 'r') as f:
                data = json.load(f)
                logger.debug(f"Loaded {len(data)} SimBrief pilot ID mappings")
                return data
        else:
            logger.warning(f"SimBrief pilot IDs file not found: {SIMBRIEF_PILOT_IDS_FILE}")
            return {}
    except Exception as e:
        logger.error(f"Failed to load SimBrief pilot IDs: {e}")
        return {}


def get_simbrief_id_for_pilot(va_pilot_id):
    """
    Look up SimBrief User ID for a VA Pilot ID.
    
    Args:
        va_pilot_id: VA pilot ID like "GAA0001", "1", "0001"
    
    Returns:
        SimBrief user ID string, or None if not found
    """
    # Reload mappings each time to pick up changes
    mappings = load_simbrief_pilot_ids()
    
    pilot_id_str = str(va_pilot_id).strip()
    
    # Direct match
    if pilot_id_str in mappings:
        return mappings[pilot_id_str]
    
    # Try with GAA prefix (e.g., "1" -> "GAA0001")
    if not pilot_id_str.startswith("GAA"):
        gaa_format = f"GAA{pilot_id_str.zfill(4)}"
        if gaa_format in mappings:
            return mappings[gaa_format]
    
    # Try without GAA prefix (e.g., "GAA0001" -> "0001" -> "1")
    if pilot_id_str.startswith("GAA"):
        numeric = pilot_id_str[3:].lstrip("0") or "0"
        if numeric in mappings:
            return mappings[numeric]
        # Also try with leading zeros
        padded = pilot_id_str[3:]
        if padded in mappings:
            return mappings[padded]
    
    logger.debug(f"No SimBrief mapping found for pilot: {va_pilot_id}")
    return None


# ============================================================================
# FLASK APP SETUP
# ============================================================================

app = Flask(__name__)

# ============================================================================
# CORS CONFIGURATION - Cloudflare Proxy Compatible
# ============================================================================
# Do NOT use flask-cors with @after_request - they conflict.
# Use manual CORS handling for full control behind reverse proxy.

@app.before_request
def handle_preflight():
    """Handle CORS preflight OPTIONS requests."""
    if request.method == "OPTIONS":
        response = app.make_default_options_response()
        origin = request.headers.get("Origin", "")
        
        if origin in ALLOWED_ORIGINS:
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
            response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, Accept"
            response.headers["Access-Control-Max-Age"] = "86400"
        
        return response


@app.after_request
def add_cors_headers(response):
    """Add CORS headers to all responses."""
    origin = request.headers.get("Origin", "")
    
    # Only add CORS headers if origin is in allowed list
    if origin in ALLOWED_ORIGINS:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, Accept"
    
    # Prevent caching issues with Cloudflare
    response.headers["Vary"] = "Origin"
    
    return response
# ============================================================================
# API ROUTES
# ============================================================================

@app.route("/")
def home():
    """Health check endpoint."""
    return jsonify({
        "status": "ok",
        "service": "Golden Age Aviation API Proxy",
        "version": "2.0.0"
    })


@app.route("/api/flights")
def get_flights():
    """
    Proxy endpoint for vAMSYS flight map data.
    """
    import requests
    
    try:
        token = get_vamsys_token()
        
        if not token:
            logger.error("No valid vAMSYS token available")
            return jsonify({"error": "API token unavailable", "data": []}), 503
        
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {token}"
        }
        
        response = requests.get(VAMSYS_FLIGHT_MAP_URL, headers=headers, timeout=30)
        
        if response.status_code == 200:
            data = response.json()
            logger.debug("Fetched %d flights from vAMSYS", len(data.get("data", [])))
            return jsonify(data)
        
        elif response.status_code == 401:
            logger.error("vAMSYS returned 401 - token may be expired")
            from vamsys_token import refresh_vamsys_token
            if refresh_vamsys_token():
                token = get_vamsys_token()
                headers["Authorization"] = f"Bearer {token}"
                response = requests.get(VAMSYS_FLIGHT_MAP_URL, headers=headers, timeout=30)
                if response.status_code == 200:
                    return jsonify(response.json())
            return jsonify({"error": "Authentication failed", "data": []}), 401
        
        else:
            logger.error("vAMSYS API error: %d", response.status_code)
            return jsonify({"error": f"vAMSYS API error: {response.status_code}", "data": []}), response.status_code
            
    except requests.exceptions.Timeout:
        logger.error("vAMSYS API request timed out")
        return jsonify({"error": "Request timed out", "data": []}), 504
    except requests.exceptions.RequestException as e:
        logger.exception("Request to vAMSYS failed: %s", e)
        return jsonify({"error": "Failed to fetch flight data", "data": []}), 500
    except Exception as e:
        logger.exception("Unexpected error: %s", e)
        return jsonify({"error": "Internal server error", "data": []}), 500


# ============================================================================
# FLIGHT ROUTE ENDPOINT (SimBrief + Fallback)
# ============================================================================

@app.route("/api/flight-route/<pilot_id>")
def get_flight_route(pilot_id):
    """
    Get route for a pilot's flight with automatic fallback.
    
    LOGIC:
    1. Look up SimBrief User ID from simbrief_pilot_ids.json
    2. If found: Fetch and parse SimBrief OFP waypoints
    3. If NOT found: Return fallback data for great-circle line
    
    This endpoint NEVER errors - always returns usable data.
    
    Query params (for fallback):
        dep_lat, dep_lon, dep_icao - Departure coordinates
        arr_lat, arr_lon, arr_icao - Arrival coordinates
    """
    import requests
    import xml.etree.ElementTree as ET
    
    # Get fallback coordinates from query params
    dep_lat = request.args.get('dep_lat', type=float)
    dep_lon = request.args.get('dep_lon', type=float)
    arr_lat = request.args.get('arr_lat', type=float)
    arr_lon = request.args.get('arr_lon', type=float)
    dep_icao = request.args.get('dep_icao', '')
    arr_icao = request.args.get('arr_icao', '')
    
    # Build fallback data (always available)
    fallback_data = None
    if dep_lat and dep_lon and arr_lat and arr_lon:
        fallback_data = {
            "departure": {"icao": dep_icao, "lat": dep_lat, "lon": dep_lon},
            "arrival": {"icao": arr_icao, "lat": arr_lat, "lon": arr_lon}
        }
    
    # Step 1: Look up SimBrief User ID
    simbrief_user_id = get_simbrief_id_for_pilot(pilot_id)
    
    if not simbrief_user_id:
        logger.info(f"No SimBrief mapping for pilot {pilot_id} - using fallback")
        return jsonify({
            "has_simbrief": False,
            "waypoints": [],
            "flight_info": None,
            "fallback": fallback_data,
            "message": "No SimBrief ID linked"
        })
    
    # Step 2: Fetch SimBrief OFP
    try:
        simbrief_url = f"https://www.simbrief.com/api/xml.fetcher.php?userid={simbrief_user_id}"
        logger.info(f"Fetching SimBrief OFP for pilot {pilot_id} (SimBrief: {simbrief_user_id})")
        
        response = requests.get(simbrief_url, timeout=15)
        
        if response.status_code != 200:
            logger.warning(f"SimBrief returned {response.status_code}")
            return jsonify({
                "has_simbrief": False,
                "waypoints": [],
                "flight_info": None,
                "fallback": fallback_data,
                "message": "SimBrief OFP not available"
            })
        
        # Step 3: Parse XML
        root = ET.fromstring(response.content)
        
        # Check for errors
        fetch_status = root.findtext('.//fetch/status')
        if fetch_status and fetch_status.lower() == 'error':
            error_msg = root.findtext('.//fetch/status_message', 'Unknown error')
            logger.warning(f"SimBrief fetch error: {error_msg}")
            return jsonify({
                "has_simbrief": False,
                "waypoints": [],
                "flight_info": None,
                "fallback": fallback_data,
                "message": f"SimBrief: {error_msg}"
            })
        
        # Extract waypoints
        waypoints = []
        
        # Origin airport
        origin = root.find('.//origin')
        if origin is not None:
            origin_lat = origin.findtext('pos_lat')
            origin_lon = origin.findtext('pos_long')
            if origin_lat and origin_lon:
                waypoints.append({
                    "ident": origin.findtext('icao_code', 'ORIG'),
                    "name": origin.findtext('name', ''),
                    "lat": float(origin_lat),
                    "lon": float(origin_lon),
                    "type": "airport",
                    "is_origin": True
                })
        
        # Navlog fixes
        navlog = root.find('.//navlog')
        if navlog is not None:
            for fix in navlog.findall('fix'):
                ident = fix.findtext('ident', '').strip()
                
                # Skip TOC, TOD, empty, and procedure names
                if not ident or ident.upper() in ['TOC', 'TOD', 'T/C', 'T/D']:
                    continue
                if len(ident) > 7:
                    continue
                
                lat_str = fix.findtext('pos_lat')
                lon_str = fix.findtext('pos_long')
                
                if lat_str and lon_str:
                    try:
                        waypoints.append({
                            "ident": ident,
                            "name": fix.findtext('name', ident),
                            "lat": float(lat_str),
                            "lon": float(lon_str),
                            "type": fix.findtext('type', 'wpt'),
                            "via_airway": fix.findtext('via_airway', ''),
                            "altitude": fix.findtext('altitude_feet', '')
                        })
                    except ValueError:
                        continue
        
        # Destination airport
        destination = root.find('.//destination')
        if destination is not None:
            dest_lat = destination.findtext('pos_lat')
            dest_lon = destination.findtext('pos_long')
            if dest_lat and dest_lon:
                waypoints.append({
                    "ident": destination.findtext('icao_code', 'DEST'),
                    "name": destination.findtext('name', ''),
                    "lat": float(dest_lat),
                    "lon": float(dest_lon),
                    "type": "airport",
                    "is_destination": True
                })
        
        # Flight info
        general = root.find('.//general')
        flight_info = {
            "flight_number": general.findtext('flight_number', '') if general else '',
            "route": root.findtext('.//route', ''),
            "cruise_altitude": general.findtext('cruise_altitude', '') if general else '',
            "distance": root.findtext('.//distance', ''),
            "aircraft": root.findtext('.//aircraft/icaocode', '')
        }
        
        logger.info(f"Parsed {len(waypoints)} waypoints for pilot {pilot_id}")
        
        # Return waypoints if we have enough
        if len(waypoints) >= 2:
            return jsonify({
                "has_simbrief": True,
                "waypoints": waypoints,
                "flight_info": flight_info,
                "fallback": None,
                "message": None
            })
        else:
            logger.warning(f"Only {len(waypoints)} waypoints - using fallback")
            return jsonify({
                "has_simbrief": False,
                "waypoints": [],
                "flight_info": None,
                "fallback": fallback_data,
                "message": "SimBrief route incomplete"
            })
        
    except ET.ParseError as e:
        logger.error(f"Failed to parse SimBrief XML: {e}")
    except requests.exceptions.Timeout:
        logger.warning("SimBrief request timed out")
    except requests.exceptions.RequestException as e:
        logger.error(f"SimBrief request failed: {e}")
    except Exception as e:
        logger.exception(f"Unexpected error: {e}")
    
    # Any error -> return fallback
    return jsonify({
        "has_simbrief": False,
        "waypoints": [],
        "flight_info": None,
        "fallback": fallback_data,
        "message": "SimBrief unavailable"
    })


# ============================================================================
# LEGACY SIMBRIEF ENDPOINTS
# ============================================================================

@app.route("/api/simbrief/route/demo")
def get_demo_route():
    """Demo route for testing."""
    demo_waypoints = [
        {"ident": "KJFK", "name": "John F Kennedy Intl", "lat": 40.6398, "lon": -73.7789, "type": "airport", "is_origin": True},
        {"ident": "HAPIE", "lat": 40.9833, "lon": -72.6333, "type": "wpt"},
        {"ident": "YAHOO", "lat": 41.3667, "lon": -71.0333, "type": "wpt"},
        {"ident": "JOOPY", "lat": 42.5000, "lon": -68.0000, "type": "wpt"},
        {"ident": "CYMON", "lat": 44.5000, "lon": -60.0000, "type": "wpt"},
        {"ident": "CARPE", "lat": 47.0000, "lon": -50.0000, "type": "wpt"},
        {"ident": "LIMRI", "lat": 50.0000, "lon": -40.0000, "type": "wpt"},
        {"ident": "DINIM", "lat": 52.0000, "lon": -30.0000, "type": "wpt"},
        {"ident": "MALOT", "lat": 53.0000, "lon": -20.0000, "type": "wpt"},
        {"ident": "EGLL", "name": "London Heathrow", "lat": 51.4706, "lon": -0.4619, "type": "airport", "is_destination": True}
    ]
    return jsonify({
        "has_simbrief": True,
        "waypoints": demo_waypoints,
        "flight_info": {"route": "KJFK ... EGLL", "cruise_altitude": "FL390"},
        "fallback": None
    })


@app.route("/api/token-status")
def token_status():
    """Token status (debug only)."""
    if not DEBUG:
        return jsonify({"error": "Not available"}), 403
    return jsonify(get_token_status())


# ============================================================================
# ERROR HANDLERS
# ============================================================================

@app.errorhandler(404)
def not_found(e):
    return jsonify({"error": "Endpoint not found"}), 404

@app.errorhandler(500)
def internal_error(e):
    return jsonify({"error": "Internal server error"}), 500


# ============================================================================
# STARTUP
# ============================================================================

def initialize():
    """Initialize the application on startup."""
    logger.info("=" * 60)
    logger.info("Golden Age Aviation API Proxy v2.0")
    logger.info("=" * 60)
    
    # Initialize vAMSYS token
    logger.info("Initializing vAMSYS token...")
    if initialize_vamsys_token():
        logger.info("✅ Token initialized successfully")
        start_background_refresh()
        logger.info("✅ Background token refresh started")
    else:
        logger.warning("⚠️  Token initialization failed")
    
    # Load SimBrief mappings
    mappings = load_simbrief_pilot_ids()
    logger.info(f"✅ Loaded {len(mappings)} SimBrief pilot mappings")
    
    logger.info("-" * 60)
    logger.info("Server ready on http://%s:%d", HOST, PORT)
    logger.info("Endpoints: /api/flights, /api/flight-route/<pilot_id>")
    logger.info("-" * 60)


initialize()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 20591))
    app.run(host="0.0.0.0", port=port)
