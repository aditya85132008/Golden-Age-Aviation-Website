# ============================================================================
# vAMSYS OAuth TOKEN MANAGER
# ============================================================================
# Standalone module for managing vAMSYS API Bearer tokens
# - Automatic token refresh before expiration
# - File-based persistence across restarts
# - Thread-safe token access
# - Clear logging and error handling
#
# Usage:
#   from vamsys_token import get_vamsys_token, initialize_vamsys_token
#   
#   # On startup
#   initialize_vamsys_token()
#   
#   # Get token for API calls
#   token = get_vamsys_token()
# ============================================================================

import os
import json
import time
import logging
import threading
import requests
from datetime import datetime
from typing import Optional

# ============================================================================
# CONFIGURATION
# ============================================================================

# vAMSYS OAuth Credentials
# CRITICAL: Must be set via Render environment variables
VAMSYS_CLIENT_ID = os.environ.get("VAMSYS_CLIENT_ID", "")
VAMSYS_CLIENT_SECRET = os.environ.get("VAMSYS_CLIENT_SECRET", "")
VAMSYS_OAUTH_URL = "https://vamsys.io/oauth/token"

# Token storage file path (can be overridden via environment variable)
# WARNING: Render uses ephemeral filesystem - file persists only during deployment
# Token will be refreshed on restart (valid for 7 days, so this is acceptable)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
VAMSYS_TOKEN_FILE = os.environ.get(
    "VAMSYS_TOKEN_FILE", 
    os.path.join(BASE_DIR, "vamsys_token.json")
)

# Token timing configuration
TOKEN_LIFETIME = 604800          # 7 days in seconds (vAMSYS default)
TOKEN_REFRESH_BUFFER = 86400     # Refresh 1 day before expiry
TOKEN_MIN_VALIDITY = 3600        # Minimum 1 hour validity required

# ============================================================================
# LOGGING SETUP
# ============================================================================

logger = logging.getLogger("vamsys_token")
if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter(
        "[%(asctime)s] %(levelname)s [vAMSYS Token] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S"
    ))
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)

# ============================================================================
# TOKEN STATE (Thread-Safe)
# ============================================================================

_token_lock = threading.Lock()
_token_data = {
    "access_token": None,
    "expires_at": 0,
    "refreshed_at": 0
}

# ============================================================================
# FILE PERSISTENCE
# ============================================================================

def _save_token_to_file(token_data: dict) -> bool:
    """
    Persist token data to JSON file for recovery after restart.
    
    Args:
        token_data: Dictionary containing access_token, expires_at, refreshed_at
        
    Returns:
        True on success, False on failure
    """
    try:
        with open(VAMSYS_TOKEN_FILE, "w", encoding="utf-8") as f:
            json.dump(token_data, f, indent=2)
        logger.debug("Token saved to file: %s", VAMSYS_TOKEN_FILE)
        return True
    except IOError as e:
        logger.error("Failed to save token to file: %s", e)
        return False
    except Exception as e:
        logger.exception("Unexpected error saving token: %s", e)
        return False


def _load_token_from_file() -> dict:
    """
    Load token data from JSON file if it exists and is still valid.
    
    Returns:
        Token data dictionary if valid, empty dict otherwise
    """
    try:
        if not os.path.exists(VAMSYS_TOKEN_FILE):
            logger.debug("Token file does not exist: %s", VAMSYS_TOKEN_FILE)
            return {}
            
        with open(VAMSYS_TOKEN_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        
        # Validate required fields
        if not data.get("access_token") or not data.get("expires_at"):
            logger.warning("Token file missing required fields")
            return {}
        
        # Check if token has sufficient validity remaining
        time_remaining = data["expires_at"] - time.time()
        if time_remaining > TOKEN_MIN_VALIDITY:
            logger.info(
                "Loaded valid token from file (expires in %.1f hours)",
                time_remaining / 3600
            )
            return data
        else:
            logger.info("Stored token expired or expiring soon (%.1f hours remaining)", 
                       time_remaining / 3600)
            return {}
            
    except json.JSONDecodeError as e:
        logger.error("Invalid JSON in token file: %s", e)
        return {}
    except IOError as e:
        logger.error("Failed to read token file: %s", e)
        return {}
    except Exception as e:
        logger.exception("Unexpected error loading token: %s", e)
        return {}


# ============================================================================
# TOKEN REFRESH
# ============================================================================

def refresh_vamsys_token() -> bool:
    """
    Obtain a new Bearer token from vAMSYS OAuth endpoint.
    
    Uses client_credentials grant type with configured credentials.
    Updates global token state and persists to file on success.
    
    Returns:
        True on success, False on failure
    """
    global _token_data
    
    # Validate credentials
    if not VAMSYS_CLIENT_ID or not VAMSYS_CLIENT_SECRET:
        logger.error(
            "vAMSYS OAuth credentials not configured! "
            "Set VAMSYS_CLIENT_ID and VAMSYS_CLIENT_SECRET environment variables."
        )
        return False
    
    logger.info("Refreshing vAMSYS Bearer token...")
    
    try:
        # Prepare OAuth request
        payload = {
            "grant_type": "client_credentials",
            "client_id": VAMSYS_CLIENT_ID,
            "client_secret": VAMSYS_CLIENT_SECRET,
            "scope": "*"
        }
        
        headers = {
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json"
        }
        
        # Make token request
        response = requests.post(
            VAMSYS_OAUTH_URL,
            data=payload,
            headers=headers,
            timeout=30
        )
        
        # Handle non-200 responses
        if response.status_code != 200:
            logger.error(
                "OAuth request failed with status %d: %s",
                response.status_code,
                response.text[:500]
            )
            return False
        
        # Parse response
        data = response.json()
        access_token = data.get("access_token")
        expires_in = data.get("expires_in", TOKEN_LIFETIME)
        
        if not access_token:
            logger.error("OAuth response missing access_token: %s", data)
            return False
        
        # Calculate expiration timestamp
        current_time = time.time()
        expires_at = current_time + expires_in
        
        # Update global state (thread-safe)
        new_token_data = {
            "access_token": access_token,
            "expires_at": expires_at,
            "refreshed_at": current_time
        }
        
        with _token_lock:
            _token_data = new_token_data
        
        # Persist to file
        _save_token_to_file(new_token_data)
        
        # Log success
        expires_datetime = datetime.fromtimestamp(expires_at)
        logger.info("✅ Token refreshed successfully!")
        logger.info("   Expires at: %s", expires_datetime.strftime("%Y-%m-%d %H:%M:%S"))
        logger.info("   Valid for: %.1f days", expires_in / 86400)
        
        return True
        
    except requests.exceptions.Timeout:
        logger.error("OAuth request timed out (30s)")
        return False
    except requests.exceptions.ConnectionError as e:
        logger.error("Connection error during OAuth request: %s", e)
        return False
    except requests.exceptions.RequestException as e:
        logger.error("OAuth request failed: %s", e)
        return False
    except json.JSONDecodeError as e:
        logger.error("Invalid JSON in OAuth response: %s", e)
        return False
    except Exception as e:
        logger.exception("Unexpected error during token refresh: %s", e)
        return False


# ============================================================================
# PUBLIC API
# ============================================================================

def get_vamsys_token() -> str:
    """
    Get the current valid vAMSYS Bearer token.
    
    Automatically refreshes the token if:
    - No token exists
    - Token is expired
    - Token expires within TOKEN_MIN_VALIDITY (1 hour)
    
    Thread-safe for concurrent access.
    
    Returns:
        Valid Bearer token string, or empty string if unavailable
    """
    with _token_lock:
        # Check if current token is valid
        if _token_data.get("access_token"):
            time_remaining = _token_data.get("expires_at", 0) - time.time()
            if time_remaining > TOKEN_MIN_VALIDITY:
                return _token_data["access_token"]
            else:
                logger.info("Token expiring soon (%.1f hours), refreshing...", 
                           time_remaining / 3600)
    
    # Token missing or expired - refresh it
    if refresh_vamsys_token():
        with _token_lock:
            return _token_data.get("access_token", "")
    
    # Refresh failed - return existing token as fallback (may be expired)
    with _token_lock:
        fallback = _token_data.get("access_token", "")
        if fallback:
            logger.warning("Using potentially expired token as fallback")
        return fallback


def initialize_vamsys_token() -> bool:
    """
    Initialize the vAMSYS token system on application startup.
    
    Attempts to load a valid token from file first.
    If no valid token exists, requests a fresh token.
    
    Call this once during application initialization.
    
    Returns:
        True if a valid token is available, False otherwise
    """
    global _token_data
    
    logger.info("Initializing vAMSYS token system...")
    
    # Try to load existing token from file
    saved_data = _load_token_from_file()
    if saved_data.get("access_token"):
        with _token_lock:
            _token_data = saved_data
        
        time_remaining = saved_data["expires_at"] - time.time()
        logger.info(
            "Using saved token (valid for %.1f more days)",
            time_remaining / 86400
        )
        return True
    
    # No valid saved token - get a fresh one
    logger.info("No valid saved token found, requesting new token...")
    return refresh_vamsys_token()


def get_token_status() -> dict:
    """
    Get current token status information.
    
    Useful for monitoring and debugging.
    
    Returns:
        Dictionary with token status details
    """
    with _token_lock:
        if not _token_data.get("access_token"):
            return {
                "valid": False,
                "message": "No token available"
            }
        
        current_time = time.time()
        expires_at = _token_data.get("expires_at", 0)
        refreshed_at = _token_data.get("refreshed_at", 0)
        time_remaining = expires_at - current_time
        
        return {
            "valid": time_remaining > 0,
            "expires_at": datetime.fromtimestamp(expires_at).isoformat() if expires_at else None,
            "refreshed_at": datetime.fromtimestamp(refreshed_at).isoformat() if refreshed_at else None,
            "hours_remaining": round(time_remaining / 3600, 2) if time_remaining > 0 else 0,
            "days_remaining": round(time_remaining / 86400, 2) if time_remaining > 0 else 0,
            "needs_refresh": time_remaining < TOKEN_REFRESH_BUFFER
        }


def needs_refresh() -> bool:
    """
    Check if the token needs to be refreshed.
    
    Returns:
        True if token should be refreshed, False otherwise
    """
    with _token_lock:
        if not _token_data.get("access_token"):
            return True
        time_remaining = _token_data.get("expires_at", 0) - time.time()
        return time_remaining < TOKEN_REFRESH_BUFFER


# ============================================================================
# ASYNC SUPPORT (Optional - for async applications)
# ============================================================================

async def async_get_vamsys_token() -> str:
    """
    Async wrapper for get_vamsys_token().
    
    Runs the synchronous token retrieval in a thread executor
    to avoid blocking the event loop.
    
    Returns:
        Valid Bearer token string, or empty string if unavailable
    """
    import asyncio
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, get_vamsys_token)


async def async_refresh_vamsys_token() -> bool:
    """
    Async wrapper for refresh_vamsys_token().
    
    Returns:
        True on success, False on failure
    """
    import asyncio
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, refresh_vamsys_token)


# ============================================================================
# BACKGROUND REFRESH LOOP (For long-running applications)
# ============================================================================

_refresh_thread: Optional[threading.Thread] = None
_stop_refresh_event = threading.Event()


def start_background_refresh(check_interval: int = 21600) -> None:
    """
    Start a background thread that periodically checks and refreshes the token.
    
    Args:
        check_interval: Seconds between refresh checks (default: 6 hours)
    """
    global _refresh_thread
    
    if _refresh_thread and _refresh_thread.is_alive():
        logger.warning("Background refresh already running")
        return
    
    _stop_refresh_event.clear()
    
    def refresh_loop():
        logger.info("Background token refresh started (check interval: %d hours)", 
                   check_interval / 3600)
        while not _stop_refresh_event.wait(timeout=check_interval):
            if needs_refresh():
                logger.info("Background refresh: Token expiring soon, refreshing...")
                refresh_vamsys_token()
        logger.info("Background token refresh stopped")
    
    _refresh_thread = threading.Thread(target=refresh_loop, daemon=True)
    _refresh_thread.start()


def stop_background_refresh() -> None:
    """Stop the background refresh thread."""
    _stop_refresh_event.set()
    if _refresh_thread:
        _refresh_thread.join(timeout=5)
        logger.info("Background refresh thread stopped")


# ============================================================================
# MODULE INITIALIZATION
# ============================================================================

if __name__ == "__main__":
    # Example usage when run directly
    logging.basicConfig(level=logging.INFO)
    
    print("vAMSYS Token Manager")
    print("=" * 50)
    
    # Check for credentials
    if not VAMSYS_CLIENT_ID or not VAMSYS_CLIENT_SECRET:
        print("\n⚠️  Credentials not set!")
        print("Set environment variables:")
        print("  export VAMSYS_CLIENT_ID='your_client_id'")
        print("  export VAMSYS_CLIENT_SECRET='your_client_secret'")
    else:
        # Initialize and display status
        initialize_vamsys_token()
        status = get_token_status()
        
        print("\nToken Status:")
        for key, value in status.items():
            print(f"  {key}: {value}")
