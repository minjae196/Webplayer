import os
from dotenv import load_dotenv

# 환경변수 먼저 로드
load_dotenv()

# 환경변수를 직접 가져오기 (import 순서 문제 해결)
LASTFM_API_KEY = os.getenv("LASTFM_API_KEY")
SPOTIFY_CLIENT_ID = os.getenv("SPOTIFY_CLIENT_ID")
SPOTIFY_CLIENT_SECRET = os.getenv("SPOTIFY_CLIENT_SECRET")
SPOTIPY_REDIRECT_URI = os.getenv("SPOTIPY_REDIRECT_URI", "http://localhost:8000/callback")
SPOTIPY_SCOPE = "user-read-playback-state user-modify-playback-state user-read-currently-playing app-remote-control streaming user-read-email user-read-private"

# Render 배포 시 동적으로 URL 설정
if os.getenv("RENDER"):
    # Render 환경에서는 RENDER_EXTERNAL_URL 사용
    base_url = os.getenv("RENDER_EXTERNAL_URL", "https://your-app-name.onrender.com")
    SPOTIPY_REDIRECT_URI = f"{base_url}/callback"

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import RedirectResponse, JSONResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Dict, Any
import time
import uuid

# Local module imports (환경변수 로드 후에 import)
from lastfm_client import LastFMClient
from recommender import Recommender
from bandit.thompson_sampling import ThompsonSampling
from spotify_player import search_track_on_spotify
from spotify_auth import SpotifyAuthManager

# Initialize SpotifyAuthManager using variables we just loaded
spotify_auth_manager = SpotifyAuthManager(
    client_id=SPOTIFY_CLIENT_ID,
    client_secret=SPOTIFY_CLIENT_SECRET,
    redirect_uri=SPOTIPY_REDIRECT_URI,
    scope=SPOTIPY_SCOPE
)

# User session management
user_sessions = {}  # {session_id: {user_id, access_token, refresh_token, expires_at}}
user_data = {}      # {user_id: {playlists, recommender, created_at, last_active}}

def get_spotify_access_token_for_sdk():
    """
    Provides the access token for the Spotify Web Playback SDK.
    This will trigger the OAuth flow if no token is available.
    For search purposes, use Client Credentials flow.
    """
    # First try to get user token from OAuth flow
    if spotify_auth_manager.get_access_token():
        return spotify_auth_manager.get_access_token()
    
    # Fallback: Get Client Credentials token for search-only access
    try:
        import base64
        import requests
        
        # Client Credentials Flow
        auth_str = f"{SPOTIFY_CLIENT_ID}:{SPOTIFY_CLIENT_SECRET}"
        b64_auth = base64.b64encode(auth_str.encode()).decode()
        
        headers = {
            "Authorization": f"Basic {b64_auth}",
            "Content-Type": "application/x-www-form-urlencoded"
        }
        data = {"grant_type": "client_credentials"}
        
        response = requests.post("https://accounts.spotify.com/api/token", headers=headers, data=data)
        
        if response.status_code == 200:
            token_data = response.json()
            print(f"[Backend] Got Client Credentials token for search")
            return token_data.get("access_token")
        else:
            print(f"[Backend] Failed to get Client Credentials token: {response.status_code}")
            return None
            
    except Exception as e:
        print(f"[Backend] Error getting Client Credentials token: {e}")
        return None

def get_user_from_request(request: Request):
    """Extract user info from request session/token"""
    try:
        # Try to get from Authorization header first
        auth_header = request.headers.get("Authorization")
        if auth_header and auth_header.startswith("Bearer "):
            token = auth_header.split(" ")[1]
            # Find user by token
            for session_id, session_data in user_sessions.items():
                if session_data.get("access_token") == token:
                    return session_data.get("user_id")
        
        # Try to get from session cookie
        session_id = request.cookies.get("session_id")
        if session_id and session_id in user_sessions:
            return user_sessions[session_id].get("user_id")
        
        # Try to get user token from spotify_auth_manager
        if spotify_auth_manager.get_access_token():
            # This is a fallback - in production you'd want better user identification
            return "default_user"
            
        return None
    except Exception as e:
        print(f"[Backend] Error getting user from request: {e}")
        return None

def get_or_create_user_data(user_id: str):
    """Get or create user-specific data"""
    if user_id not in user_data:
        user_data[user_id] = {
            "playlists": {str(i): [] for i in range(6)},  # 0-5 rating playlists
            "recommender": Recommender(LastFMClient(), ThompsonSampling()),
            "created_at": time.time(),
            "last_active": time.time()
        }
        print(f"[Backend] Created new user data for {user_id}")
    else:
        user_data[user_id]["last_active"] = time.time()
    
    return user_data[user_id]

def cleanup_old_users():
    """Clean up old inactive user data (call periodically)"""
    current_time = time.time()
    cutoff_time = current_time - (24 * 60 * 60)  # 24 hours
    
    old_users = [
        user_id for user_id, data in user_data.items()
        if data.get("last_active", 0) < cutoff_time
    ]
    
    for user_id in old_users:
        del user_data[user_id]
        print(f"[Backend] Cleaned up old user data for {user_id}")

# --- Initialization ---
print(f"[Backend] Initializing with LASTFM_API_KEY: {bool(LASTFM_API_KEY)}")
print(f"[Backend] SPOTIFY_CLIENT_ID: {bool(SPOTIFY_CLIENT_ID)}")
print(f"[Backend] SPOTIFY_CLIENT_SECRET: {bool(SPOTIFY_CLIENT_SECRET)}")

try:
    # Test initialization
    test_client = LastFMClient()
    test_bandit = ThompsonSampling()
    test_recommender = Recommender(test_client, test_bandit)
    print("[Backend] Recommender system components initialized successfully")
except Exception as e:
    print(f"Error during initialization: {e}")

app = FastAPI()

# --- API Models ---
class RecommendRequest(BaseModel):
    track_name: str
    artist_name: str
    num_recommendations: int = 12

class FeedbackRequest(BaseModel):
    track_id: str
    rating: float
    seed_track_name: str
    seed_artist_name: str
    track_info: dict = None

class RecommendOneRequest(BaseModel):
    seed_track_name: str
    seed_artist_name: str
    exclude_ids: list[str] = []

class DeleteTrackRequest(BaseModel):
    playlist_id: str
    track_id: str

class AddTrackRequest(BaseModel):
    playlist_id: str
    track: dict

# --- Serve Frontend ---
WEBPLAYER_DIR = os.path.join(os.path.dirname(__file__), 'webplayer')

if not os.path.isdir(WEBPLAYER_DIR):
    print(f"Warning: Webplayer directory not found at {WEBPLAYER_DIR}")
    os.makedirs(WEBPLAYER_DIR, exist_ok=True)

app.mount("/static", StaticFiles(directory=WEBPLAYER_DIR), name="static")

@app.get("/")
async def read_index():
    """Serves the main index.html file for the frontend."""
    index_path = os.path.join(WEBPLAYER_DIR, 'index.html')
    if os.path.exists(index_path):
        return FileResponse(index_path)
    else:
        return HTMLResponse("""
        <!DOCTYPE html>
        <html>
        <head><title>Music Recommender</title></head>
        <body>
            <h1>Music Recommender</h1>
            <p>Static files not found. Please check your deployment.</p>
        </body>
        </html>
        """)

@app.get("/config")
async def get_config():
    """Provide frontend configuration"""
    return {
        "spotify_client_id": SPOTIFY_CLIENT_ID,
        "redirect_uri": SPOTIPY_REDIRECT_URI,
        "scopes": SPOTIPY_SCOPE
    }

# --- Spotify OAuth Endpoints ---
@app.get("/login")
async def spotify_login():
    """Redirects to Spotify's authorization page."""
    auth_url = spotify_auth_manager.get_authorize_url()
    return RedirectResponse(auth_url)

@app.get("/callback")
async def spotify_callback(request: Request, code: str = Query(...)):
    """Handles the callback from Spotify after user authorization."""
    try:
        token_info = spotify_auth_manager.get_token(code)
        
        # Get user profile to get user ID
        access_token = token_info["access_token"]
        from spotify_player import get_user_profile
        user_profile = get_user_profile(access_token)
        
        if not user_profile:
            raise HTTPException(status_code=500, detail="Failed to get user profile")
        
        user_id = user_profile["id"]
        
        # Create session
        session_id = str(uuid.uuid4())
        user_sessions[session_id] = {
            "user_id": user_id,
            "access_token": access_token,
            "refresh_token": token_info.get("refresh_token"),
            "expires_at": time.time() + token_info.get("expires_in", 3600),
            "user_profile": user_profile
        }
        
        # Initialize user data
        get_or_create_user_data(user_id)
        
        # Set session cookie and redirect
        response = RedirectResponse("/?logged_in=true")
        response.set_cookie("session_id", session_id, httponly=True, max_age=86400)  # 24 hours
        return response
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get Spotify tokens: {e}")

@app.get("/logout")
async def logout(request: Request):
    """Logout user and clean up session"""
    session_id = request.cookies.get("session_id")
    if session_id and session_id in user_sessions:
        del user_sessions[session_id]
    
    response = RedirectResponse("/")
    response.delete_cookie("session_id")
    return response

@app.get("/spotify_sdk_token")
async def spotify_sdk_token(request: Request):
    """Provides the Spotify Web Playback SDK token and user product type to the frontend."""
    try:
        user_id = get_user_from_request(request)
        if not user_id:
            # Try to get Client Credentials token for non-authenticated requests
            access_token = get_spotify_access_token_for_sdk()
            if not access_token:
                raise HTTPException(status_code=401, detail="Spotify access token not available. Please log in.")
            return {"access_token": access_token, "token_type": "Bearer", "expires_in": 3600, "product_type": "free"}
        
        # Get user session
        session_id = request.cookies.get("session_id")
        if not session_id or session_id not in user_sessions:
            raise HTTPException(status_code=401, detail="Invalid session. Please log in.")
        
        session_data = user_sessions[session_id]
        access_token = session_data["access_token"]
        user_profile = session_data.get("user_profile", {})
        product_type = user_profile.get('product', 'free')

        return {
            "access_token": access_token, 
            "token_type": "Bearer", 
            "expires_in": 3600, 
            "product_type": product_type
        }
    except Exception as e:
        print(f"[Backend] Error in spotify_sdk_token: {e}")
        raise HTTPException(status_code=503, detail="Spotify service temporarily unavailable")

@app.get("/user_profile")
async def user_profile_endpoint(request: Request):
    """Fetches the current user's profile information."""
    user_id = get_user_from_request(request)
    if not user_id:
        raise HTTPException(status_code=401, detail="User not authenticated")
    
    session_id = request.cookies.get("session_id")
    if not session_id or session_id not in user_sessions:
        raise HTTPException(status_code=401, detail="Invalid session")
    
    session_data = user_sessions[session_id]
    user_profile = session_data.get("user_profile", {})
    
    if not user_profile:
        raise HTTPException(status_code=500, detail="Failed to fetch user profile")
    
    return user_profile

# --- Missing Playlists Endpoint ---
@app.get("/playlists")
async def get_playlists(request: Request):
    """Get user's local playlists"""
    user_id = get_user_from_request(request)
    if not user_id:
        # Return empty playlists for non-authenticated users
        return {str(i): [] for i in range(6)}
    
    user_data_obj = get_or_create_user_data(user_id)
    return user_data_obj["playlists"]

# --- Missing Reset Bandit Endpoint ---
@app.post("/reset_bandit")
async def reset_bandit(request: Request):
    """Reset the bandit algorithm scores"""
    user_id = get_user_from_request(request)
    if not user_id:
        raise HTTPException(status_code=401, detail="User not authenticated")
    
    user_data_obj = get_or_create_user_data(user_id)
    # Reset the bandit algorithm
    user_data_obj["recommender"] = Recommender(LastFMClient(), ThompsonSampling())
    
    return {"message": "Bandit scores have been reset successfully"}

# --- Missing Playlist Management Endpoints ---
@app.post("/remove_local_playlist_track")
async def remove_local_playlist_track(request: Request, delete_request: DeleteTrackRequest):
    """Remove track from local playlist"""
    user_id = get_user_from_request(request)
    if not user_id:
        raise HTTPException(status_code=401, detail="User not authenticated")
    
    user_data_obj = get_or_create_user_data(user_id)
    playlists = user_data_obj["playlists"]
    
    playlist_id = delete_request.playlist_id
    track_id = delete_request.track_id

    if playlist_id not in playlists:
        raise HTTPException(status_code=404, detail="Playlist not found")

    initial_len = len(playlists[playlist_id])
    playlists[playlist_id] = [track for track in playlists[playlist_id] 
                             if (isinstance(track, dict) and track.get("id") != track_id) or 
                                (isinstance(track, str) and track != track_id)]

    if len(playlists[playlist_id]) < initial_len:
        return {"message": "Track removed successfully from local playlist"}
    else:
        raise HTTPException(status_code=404, detail="Track not found in local playlist")

@app.post("/add_track_to_local_playlist")
async def add_track_to_local_playlist(request: Request, add_request: AddTrackRequest):
    """Add track to local playlist"""
    user_id = get_user_from_request(request)
    if not user_id:
        raise HTTPException(status_code=401, detail="User not authenticated")
    
    user_data_obj = get_or_create_user_data(user_id)
    playlists = user_data_obj["playlists"]
    
    playlist_id = add_request.playlist_id
    track = add_request.track

    if playlist_id not in playlists:
        raise HTTPException(status_code=404, detail="Playlist not found")

    # Prevent duplicate tracks
    track_id = track.get("id") if isinstance(track, dict) else track
    existing_track_ids = []
    for existing_track in playlists[playlist_id]:
        if isinstance(existing_track, dict):
            existing_track_ids.append(existing_track.get("id"))
        else:
            existing_track_ids.append(existing_track)
    
    if track_id in existing_track_ids:
        return {"message": "Track already exists in local playlist"}

    playlists[playlist_id].append(track)
    return {"message": "Track added successfully to local playlist"}

# --- API Endpoints ---
@app.post("/recommendations")
def get_recommendations_api(request: Request, recommend_request: RecommendRequest):
    """The main recommendation endpoint."""
    user_id = get_user_from_request(request)
    if not user_id:
        raise HTTPException(status_code=401, detail="User not authenticated")
    
    user_data_obj = get_or_create_user_data(user_id)
    recommender = user_data_obj["recommender"]
    
    print(f"[Backend] User {user_id} requested recommendations for: {recommend_request.track_name} - {recommend_request.artist_name}")

    try:
        # Get track recommendations from the recommender module
        lastfm_tracks = recommender.recommend_bulk(
            mode="track",
            track_name=recommend_request.track_name,
            artist_name=recommend_request.artist_name,
            limit=recommend_request.num_recommendations
        )
        print(f"[Backend] Last.fm returned {len(lastfm_tracks)} tracks for user {user_id}")

        if not lastfm_tracks:
            print(f"[Backend] No tracks from Last.fm for user {user_id}, trying fallback...")
            lastfm_tracks = recommender.recommend_bulk(
                mode="artist",
                track_name="",
                artist_name=recommend_request.artist_name,
                limit=recommend_request.num_recommendations
            )
            
        if not lastfm_tracks:
            raise HTTPException(status_code=404, detail="Could not generate recommendations from Last.fm. Try different track/artist names.")

        # Enrich with Spotify data
        spotify_recommendations = []
        access_token = get_spotify_access_token_for_sdk()
        
        # Try to get user's token if available
        session_id = request.cookies.get("session_id")
        if session_id and session_id in user_sessions:
            user_token = user_sessions[session_id].get("access_token")
            if user_token:
                access_token = user_token
        
        print(f"[Backend] Using Spotify token for user {user_id}: {bool(access_token)}")
        
        for track in lastfm_tracks:
            try:
                artist = track.get('artist', {})
                if isinstance(artist, dict):
                    artist_name = artist.get('name', 'Unknown Artist')
                else:
                    artist_name = str(artist) if artist else 'Unknown Artist'
                    
                track_name = track.get('name', 'Unknown Track')

                if access_token:
                    spotify_info = search_track_on_spotify(track_name, artist_name, access_token=access_token)
                    print(f"[Backend] Spotify search for '{track_name}' by '{artist_name}': {spotify_info is not None}")
                else:
                    print(f"[Backend] No access token - skipping Spotify search for '{track_name}'")
                    spotify_info = None

                if spotify_info and spotify_info.get('id'):
                    album_cover_url = "https://i.scdn.co/image/ab67616d0000b273b44de2c935f87a4734a09153"
                    if spotify_info.get('album', {}).get('images') and len(spotify_info['album']['images']) > 0:
                        album_cover_url = spotify_info['album']['images'][0]['url']

                    preview_url = spotify_info.get('preview_url')  # Get preview URL directly from Spotify
                        
                    spotify_recommendations.append({
                        "id": spotify_info['id'],
                        "name": track_name,
                        "artist": artist_name,
                        "album_cover_url": album_cover_url,
                        "uri": spotify_info['uri'],
                        "preview_url": preview_url,
                        "seed_track_name": recommend_request.track_name,
                        "seed_artist_name": recommend_request.artist_name
                    })
                else:
                    print(f"[Backend] Could not find '{track_name}' by '{artist_name}' on Spotify")
                    
            except Exception as e:
                print(f"[Backend] Error processing track {track}: {e}")
                continue
        
        print(f"[Backend] Final Spotify recommendations count for user {user_id}: {len(spotify_recommendations)}")

        final_recommendations = spotify_recommendations[:recommend_request.num_recommendations]

        if not final_recommendations:
            raise HTTPException(status_code=404, detail="Could not find any of the recommended tracks on Spotify. Try different search terms.")

        return {"recommendations": final_recommendations}

    except HTTPException:
        raise
    except Exception as e:
        print(f"[Backend] Unexpected error for user {user_id}: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")

@app.post("/feedback")
def post_feedback(request: Request, feedback_request: FeedbackRequest):
    """Receives user feedback and updates the bandit algorithm."""
    user_id = get_user_from_request(request)
    if not user_id:
        raise HTTPException(status_code=401, detail="User not authenticated")
    
    user_data_obj = get_or_create_user_data(user_id)
    recommender = user_data_obj["recommender"]
    playlists = user_data_obj["playlists"]
    
    try:
        # Convert rating (0-5) to a reward (0.0-1.0)
        reward = feedback_request.rating / 5.0 if feedback_request.rating > 0 else 0.0
        
        recommender.give_feedback(feedback_request.track_id, reward)
        print(f"[Backend] User {user_id} gave feedback for {feedback_request.track_id} with rating {feedback_request.rating} (reward: {reward})")

        # Store in user's playlists
        rating_key = str(int(feedback_request.rating))
        if rating_key not in playlists:
            playlists[rating_key] = []
        
        if feedback_request.track_info:
            track_info = feedback_request.track_info.copy()
            track_info["rating"] = feedback_request.rating
            
            # Check for duplicates
            track_id = track_info.get("id")
            existing_track_ids = []
            for existing_track in playlists[rating_key]:
                if isinstance(existing_track, dict):
                    existing_track_ids.append(existing_track.get("id"))
                else:
                    existing_track_ids.append(existing_track)
            
            if track_id not in existing_track_ids:
                playlists[rating_key].append(track_info)
        
        return {"message": "Feedback processed successfully"}
    except Exception as e:
        print(f"[Backend] Error in post_feedback: {e}")
        raise HTTPException(status_code=500, detail=str(e))
