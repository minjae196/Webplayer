# security.py - Add this to your project

from fastapi import Request, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
import time
import jwt
import os
from typing import Optional

# Security configuration
SECRET_KEY = os.getenv("SECRET_KEY", "your-secret-key-change-in-production")
JWT_SECRET = os.getenv("JWT_SECRET", "your-jwt-secret-change-in-production")
ENVIRONMENT = os.getenv("ENVIRONMENT", "development")

# Rate limiting storage (in production, use Redis)
rate_limit_storage = {}

class RateLimiter:
    def __init__(self, max_requests: int = 100, window_seconds: int = 3600):
        self.max_requests = max_requests
        self.window_seconds = window_seconds
    
    def is_allowed(self, identifier: str) -> bool:
        current_time = time.time()
        window_start = current_time - self.window_seconds
        
        if identifier not in rate_limit_storage:
            rate_limit_storage[identifier] = []
        
        # Clean old requests
        rate_limit_storage[identifier] = [
            req_time for req_time in rate_limit_storage[identifier] 
            if req_time > window_start
        ]
        
        # Check if under limit
        if len(rate_limit_storage[identifier]) >= self.max_requests:
            return False
        
        # Add current request
        rate_limit_storage[identifier].append(current_time)
        return True

# Create rate limiter instance
rate_limiter = RateLimiter(max_requests=1000, window_seconds=3600)  # 1000 requests per hour

def add_security_middleware(app):
    """Add security middleware to FastAPI app"""
    
    # CORS middleware
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"] if ENVIRONMENT == "development" else [
            "https://your-domain.com",
            "https://your-app-name.onrender.com"
        ],
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=["*"],
    )
    
    # Trusted host middleware (only in production)
    if ENVIRONMENT == "production":
        app.add_middleware(
            TrustedHostMiddleware,
            allowed_hosts=["your-domain.com", "your-app-name.onrender.com"]
        )

def get_client_ip(request: Request) -> str:
    """Get client IP address for rate limiting"""
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host

async def rate_limit_middleware(request: Request, call_next):
    """Rate limiting middleware"""
    client_ip = get_client_ip(request)
    
    # Skip rate limiting for static files
    if request.url.path.startswith("/static/"):
        response = await call_next(request)
        return response
    
    if not rate_limiter.is_allowed(client_ip):
        raise HTTPException(
            status_code=429, 
            detail="Too many requests. Please try again later."
        )
    
    response = await call_next(request)
    return response

def generate_session_token(user_id: str, user_data: dict) -> str:
    """Generate a secure session token"""
    payload = {
        "user_id": user_id,
        "user_data": user_data,
        "exp": time.time() + 86400,  # 24 hours
        "iat": time.time()
    }
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")

def verify_session_token(token: str) -> Optional[dict]:
    """Verify and decode session token"""
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
        if payload["exp"] < time.time():
            return None
        return payload
    except jwt.InvalidTokenError:
        return None

class TokenRefreshError(Exception):
    pass

async def refresh_spotify_token(refresh_token: str) -> dict:
    """Refresh Spotify access token"""
    import httpx
    import base64
    
    auth_str = f"{os.getenv('SPOTIFY_CLIENT_ID')}:{os.getenv('SPOTIFY_CLIENT_SECRET')}"
    b64_auth = base64.b64encode(auth_str.encode()).decode()
    
    headers = {
        "Authorization": f"Basic {b64_auth}",
        "Content-Type": "application/x-www-form-urlencoded"
    }
    data = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token
    }
    
    async with httpx.AsyncClient() as client:
        response = await client.post("https://accounts.spotify.com/api/token", headers=headers, data=data)
    
    if response.status_code != 200:
        raise TokenRefreshError("Failed to refresh Spotify token")
    
    return response.json()

def sanitize_user_input(text: str, max_length: int = 100) -> str:
    """Sanitize user input"""
    if not text:
        return ""
    
    # Remove potentially dangerous characters
    text = text.strip()
    text = text[:max_length]
    
    # Basic HTML escaping
    text = text.replace("<", "&lt;").replace(">", "&gt;")
    text = text.replace("&", "&amp;").replace('"', "&quot;")
    text = text.replace("'", "&#x27;").replace("/", "&#x2F;")
    
    return text

def validate_track_data(track_data: dict) -> dict:
    """Validate and sanitize track data"""
    if not isinstance(track_data, dict):
        raise ValueError("Track data must be a dictionary")
    
    sanitized = {}
    
    # Required fields
    required_fields = ["id", "name", "artist"]
    for field in required_fields:
        if field not in track_data:
            raise ValueError(f"Missing required field: {field}")
        sanitized[field] = sanitize_user_input(str(track_data[field]))
    
    # Optional fields
    optional_fields = ["album_cover_url", "uri", "preview_url", "rating"]
    for field in optional_fields:
        if field in track_data:
            if field == "rating":
                try:
                    rating = float(track_data[field])
                    if 0 <= rating <= 5:
                        sanitized[field] = rating
                    else:
                        sanitized[field] = 0
                except (ValueError, TypeError):
                    sanitized[field] = 0
            else:
                sanitized[field] = sanitize_user_input(str(track_data[field]), max_length=500)
    
    return sanitized

# Add this to main.py:
"""
from security import add_security_middleware, rate_limit_middleware, sanitize_user_input, validate_track_data

# Add after app = FastAPI()
add_security_middleware(app)
app.middleware("http")(rate_limit_middleware)

# Update your API endpoints to use sanitization:
@app.post("/recommendations")
def get_recommendations_api(request: Request, recommend_request: RecommendRequest):
    # Sanitize inputs
    track_name = sanitize_user_input(recommend_request.track_name)
    artist_name = sanitize_user_input(recommend_request.artist_name)
    
    # Rest of your code...
"""
