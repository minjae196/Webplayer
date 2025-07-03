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
else:
    # 로컬 개발 환경
    SPOTIPY_REDIRECT_URI = os.getenv("SPOTIPY_REDIRECT_URI", "http://localhost:8000/callback")

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import RedirectResponse, JSONResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

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

# --- Initialization ---
# Initialize the core components of the recommender system.
# This is now simplified and corrected.
print(f"[Backend] Initializing with LASTFM_API_KEY: {bool(LASTFM_API_KEY)}")
print(f"[Backend] SPOTIFY_CLIENT_ID: {bool(SPOTIFY_CLIENT_ID)}")
print(f"[Backend] SPOTIFY_CLIENT_SECRET: {bool(SPOTIFY_CLIENT_SECRET)}")

try:
    lastfm_client = LastFMClient()
    bandit = ThompsonSampling() # Changed to ThompsonSampling
    recommender = Recommender(lastfm_client, bandit)
    print("[Backend] Recommender system initialized successfully")
except Exception as e:
    print(f"Error during initialization: {e}")
    recommender = None

app = FastAPI()

# --- API Models ---
# Defines the request structure for the recommendation endpoint.
# It now correctly asks for a seed track and artist.
class RecommendRequest(BaseModel):
    track_name: str
    artist_name: str
    num_recommendations: int = 12

# Defines the request structure for the feedback endpoint.
class FeedbackRequest(BaseModel):
    track_id: str # Spotify track ID
    rating: float # 0.0 for skip/dislike, 0.1-1.0 for like/rating
    seed_track_name: str # Original seed track name
    seed_artist_name: str # Original seed artist name
    track_info: dict = None # Full track information

class RecommendOneRequest(BaseModel):
    seed_track_name: str
    seed_artist_name: str
    exclude_ids: list[str] = [] # New field to exclude already displayed track IDs

class DeleteTrackRequest(BaseModel):
    playlist_id: str
    track_id: str

# Global dictionary to store user playlists based on feedback
# This will be reset on server restart. For persistence, a database would be needed.
user_playlists = {
    "0": [], # Skipped/Disliked
    "1": [],
    "2": [],
    "3": [],
    "4": [],
    "5": []  # Highly liked
}

# AddTrackRequest model (from fastapi_server.py)
class AddTrackRequest(BaseModel):
    playlist_id: str
    track: dict # Assuming track is a dictionary with at least an 'id' field

@app.post("/add_track_to_local_playlist")
async def add_track_to_local_playlist(add_request: AddTrackRequest):
    playlist_id = add_request.playlist_id
    track = add_request.track

    if playlist_id not in user_playlists: # Changed from local_playlists to user_playlists
        return JSONResponse(status_code=404, content={"detail": "Playlist not found."})

    # Prevent duplicate tracks
    if any(t["id"] == track["id"] for t in user_playlists[playlist_id]): # Changed from local_playlists to user_playlists
        return JSONResponse(status_code=200, content={"message": "Track already exists in local playlist."})

    user_playlists[playlist_id].append(track) # Changed from local_playlists to user_playlists
    return JSONResponse(content={"message": "Track added successfully to local playlist."})

# --- Serve Frontend ---
# Mount the 'webplayer' directory to serve static files (HTML, CSS, JS)
WEBPLAYER_DIR = os.path.join(os.path.dirname(__file__), 'webplayer')

# Check if the directory exists
if not os.path.isdir(WEBPLAYER_DIR):
    print(f"Warning: Webplayer directory not found at {WEBPLAYER_DIR}")
    # Create empty directory structure for production
    os.makedirs(WEBPLAYER_DIR, exist_ok=True)

# Mount static files - serve webplayer directory as static files
app.mount("/static", StaticFiles(directory=WEBPLAYER_DIR), name="static")

@app.get("/")
async def read_index():
    """
    Serves the main index.html file for the frontend.
    """
    index_path = os.path.join(WEBPLAYER_DIR, 'index.html')
    if os.path.exists(index_path):
        return FileResponse(index_path)
    else:
        # Return a simple HTML if index.html not found
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

# Add a test endpoint to check static files
@app.get("/test-static")
async def test_static():
    files = []
    if os.path.isdir(WEBPLAYER_DIR):
        files = os.listdir(WEBPLAYER_DIR)
    return {"webplayer_dir": WEBPLAYER_DIR, "files": files, "exists": os.path.isdir(WEBPLAYER_DIR)}

# --- Spotify OAuth Endpoints ---
@app.get("/login")
async def spotify_login():
    """
    Redirects to Spotify's authorization page.
    """
    auth_url = spotify_auth_manager.get_authorize_url()
    return RedirectResponse(auth_url)

@app.get("/callback")
async def spotify_callback(code: str = Query(...)):
    """
    Handles the callback from Spotify after user authorization.
    Exchanges the authorization code for access and refresh tokens.
    """
    try:
        token_info = spotify_auth_manager.get_token(code)
        # You might want to store token_info securely (e.g., in a session or database)
        # For this example, it's stored in the global spotify_auth_manager instance.
        return RedirectResponse("/") # Redirect back to the main page
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get Spotify tokens: {e}")

from spotify_player import search_track_on_spotify, get_track_preview_url, get_user_profile

@app.get("/spotify_sdk_token")
async def spotify_sdk_token():
    """
    Provides the Spotify Web Playback SDK token and user product type to the frontend.
    """
    try:
        access_token = get_spotify_access_token_for_sdk()
        if not access_token:
            raise HTTPException(status_code=401, detail="Spotify access token not available. Please log in.")
        
        user_profile = get_user_profile(access_token)
        product_type = user_profile.get('product', 'free') if user_profile else 'free'

        return {"access_token": access_token, "token_type": "Bearer", "expires_in": 3600, "product_type": product_type}
    except Exception as e:
        print(f"[Backend] Error in spotify_sdk_token: {e}")
        raise HTTPException(status_code=503, detail="Spotify service temporarily unavailable")

@app.get("/user_profile")
async def user_profile_endpoint():
    """
    Fetches the current user's profile information, including product type (premium/free).
    """
    access_token = get_spotify_access_token_for_sdk()
    if not access_token:
        raise HTTPException(status_code=401, detail="Spotify access token not available. Please log in.")
    
    user_profile = get_user_profile(access_token)
    if not user_profile:
        raise HTTPException(status_code=500, detail="Failed to fetch user profile from Spotify.")
    
    return user_profile

# --- API Endpoints ---
@app.post("/recommendations")
def get_recommendations_api(request: RecommendRequest):
    """
    The main recommendation endpoint.
    Takes a seed track and artist, gets recommendations from Last.fm,
    enriches them with Spotify data, and returns them.
    """
    print(f"[Backend] Received recommendation request for track: {request.track_name}, artist: {request.artist_name}")

    if not recommender:
        raise HTTPException(status_code=503, detail="Recommender system is not initialized.")

    try:
        # 1. Get track recommendations from the recommender module
        lastfm_tracks = recommender.recommend_bulk(
            mode="track",
            track_name=request.track_name,
            artist_name=request.artist_name,
            limit=request.num_recommendations
        )
        print(f"[Backend] Last.fm returned {len(lastfm_tracks)} tracks.")

        if not lastfm_tracks:
            print("[Backend] No tracks from Last.fm, trying fallback...")
            # Fallback: try with just artist name
            lastfm_tracks = recommender.recommend_bulk(
                mode="artist",
                track_name="",
                artist_name=request.artist_name,
                limit=request.num_recommendations
            )
            
        if not lastfm_tracks:
            raise HTTPException(status_code=404, detail="Could not generate recommendations from Last.fm. Try different track/artist names.")

        # 2. Enrich the recommendations with Spotify data
        spotify_recommendations = []
        access_token = get_spotify_access_token_for_sdk()
        
        if not access_token:
            print("[Backend] No Spotify access token available - trying to get one...")
            # Try to get Client Credentials token
            access_token = get_spotify_access_token_for_sdk()
        
        print(f"[Backend] Using Spotify token: {bool(access_token)}")
        
        for track in lastfm_tracks:
            try:
                artist = track.get('artist', {})
                if isinstance(artist, dict):
                    artist_name = artist.get('name', 'Unknown Artist')
                else:
                    artist_name = str(artist) if artist else 'Unknown Artist'
                    
                track_name = track.get('name', 'Unknown Track')

                # Search on Spotify
                if access_token:
                    spotify_info = search_track_on_spotify(track_name, artist_name, access_token=access_token)
                    print(f"[Backend] Spotify search for '{track_name}' by '{artist_name}': {spotify_info is not None}")
                else:
                    print(f"[Backend] No access token - skipping Spotify search for '{track_name}'")
                    spotify_info = None

                if spotify_info and spotify_info.get('id'):
                    # Get album cover from Spotify's response if available
                    album_cover_url = "https://i.scdn.co/image/ab67616d0000b273b44de2c935f87a4734a09153"  # Default
                    if spotify_info.get('album', {}).get('images') and len(spotify_info['album']['images']) > 0:
                        album_cover_url = spotify_info['album']['images'][0]['url']

                    preview_url = None
                    try:
                        preview_url = get_track_preview_url(spotify_info['id'], access_token=access_token)
                    except Exception as e:
                        print(f"[Backend] Could not get preview for {track_name}: {e}")
                        
                    spotify_recommendations.append({
                        "id": spotify_info['id'],
                        "name": track_name,
                        "artist": artist_name,
                        "album_cover_url": album_cover_url,
                        "uri": spotify_info['uri'],
                        "preview_url": preview_url,
                        "seed_track_name": request.track_name,
                        "seed_artist_name": request.artist_name
                    })
                else:
                    print(f"[Backend] Could not find '{track_name}' by '{artist_name}' on Spotify")
                    
            except Exception as e:
                print(f"[Backend] Error processing track {track}: {e}")
                continue
        
        print(f"[Backend] Final Spotify recommendations count: {len(spotify_recommendations)}")

        # Limit the number of results as requested
        final_recommendations = spotify_recommendations[:request.num_recommendations]

        if not final_recommendations:
            raise HTTPException(status_code=404, detail="Could not find any of the recommended tracks on Spotify. Try different search terms.")

        return {"recommendations": final_recommendations}

    except HTTPException:
        # Re-raise HTTP exceptions
        raise
    except Exception as e:
        print(f"[Backend] Unexpected error: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")

@app.post("/feedback")
def post_feedback(request: FeedbackRequest):
    """
    Receives user feedback (rating) for a recommended track
    and updates the bandit algorithm.
    """
    if not recommender:
        raise HTTPException(status_code=503, detail="Recommender system is not initialized.")
    
    try:
        # Convert rating (0-5) to a reward (0.0-1.0)
        reward = request.rating / 5.0 if request.rating > 0 else 0.0
        
        recommender.give_feedback(request.track_id, reward)
        print(f"[Backend] Received feedback for {request.track_id} with rating {request.rating} (reward: {reward})")

        # Store in user_playlists with full track information
        rating_key = str(int(request.rating))
        if rating_key not in user_playlists:
            user_playlists[rating_key] = []
        
        # Use track_info if provided, otherwise create basic info
        if request.track_info:
            track_info = request.track_info
            track_info["rating"] = request.rating
        else:
            track_info = {
                "id": request.track_id,
                "name": "Unknown Track",
                "artist": "Unknown Artist", 
                "album_cover_url": "https://via.placeholder.com/60x60?text=♪",
                "rating": request.rating,
                "seed_track_name": request.seed_track_name,
                "seed_artist_name": request.seed_artist_name
            }
        
        # Prevent duplicate tracks in playlist
        if not any(t.get("id") == request.track_id for t in user_playlists[rating_key]):
            user_playlists[rating_key].append(track_info)
            print(f"[Backend] Stored track {request.track_id} in playlist {rating_key}")

        return {"message": "Feedback received and bandit updated."}
    except Exception as e:
        print(f"[Backend] Error processing feedback: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/reset_bandit")
def reset_bandit_scores():
    """
    Resets the bandit algorithm's learned scores.
    """
    global recommender # Access the global recommender instance
    if not recommender:
        raise HTTPException(status_code=503, detail="Recommender system is not initialized.")
    
    try:
        # Re-initialize the bandit to reset its state
        recommender.bandit = ThompsonSampling() # Or EpsilonGreedy() if that was the original choice
        print("[Backend] Bandit scores have been reset.")
        return {"message": "Bandit scores reset successfully."}
    except Exception as e:
        print(f"[Backend] Error resetting bandit: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/recommend_one")
def get_one_recommendation(request: RecommendOneRequest):
    """
    Gets a single new recommendation based on a seed track and artist.
    """
    if not recommender:
        raise HTTPException(status_code=503, detail="Recommender system is not initialized.")

    try:
        lastfm_tracks = recommender.recommend_bulk(
            mode="track",
            track_name=request.seed_track_name,
            artist_name=request.seed_artist_name,
            limit=1, # Request only one recommendation
            exclude_ids=request.exclude_ids # Pass excluded IDs
        )

        if not lastfm_tracks:
            raise HTTPException(status_code=404, detail="Could not generate a new recommendation from Last.fm.")

        track = lastfm_tracks[0] # Take the first recommendation
        artist = track.get('artist', {}).get('name', 'Unknown Artist')
        track_name = track.get('name', 'Unknown Track')

        spotify_info = search_track_on_spotify(track_name, artist, access_token=get_spotify_access_token_for_sdk())

        if spotify_info and spotify_info.get('id'):
            album_cover_url = "https://i.scdn.co/image/ab67616d0000b273b44de2c935f87a4734a09153"
            if spotify_info.get('album', {}).get('images'):
                album_cover_url = spotify_info['album']['images'][0]['url']

            return {
                "id": spotify_info['id'],
                "name": track_name,
                "artist": artist,
                "album_cover_url": album_cover_url,
                "uri": spotify_info['uri'],
                "preview_url": get_track_preview_url(spotify_info['id'], access_token=get_spotify_access_token_for_sdk())
            }
        else:
            raise HTTPException(status_code=404, detail="Could not find the recommended track on Spotify.")

    except Exception as e:
        print(f"An error occurred while getting one recommendation: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/debug/config")
def debug_config():
    """
    Debug endpoint to check API configuration
    """
    return {
        "lastfm_api_key_exists": bool(LASTFM_API_KEY),
        "spotify_client_id_exists": bool(SPOTIFY_CLIENT_ID),
        "spotify_client_secret_exists": bool(SPOTIFY_CLIENT_SECRET),
        "lastfm_api_key_length": len(LASTFM_API_KEY) if LASTFM_API_KEY else 0,
        "spotify_client_id_length": len(SPOTIFY_CLIENT_ID) if SPOTIFY_CLIENT_ID else 0,
        "recommender_initialized": recommender is not None
    }

@app.get("/debug/test-lastfm")
def test_lastfm():
    """
    Test Last.fm API connection
    """
    try:
        if not lastfm_client:
            return {"error": "LastFM client not initialized"}
        
        # Simple test call
        tracks = lastfm_client.get_similar_tracks("Gravity", "John Mayer", limit=3)
        return {
            "success": True,
            "tracks_found": len(tracks),
            "sample_track": tracks[0] if tracks else None
        }
    except Exception as e:
        return {"error": str(e), "success": False}

@app.get("/debug/test-spotify")
def test_spotify():
    """
    Test Spotify API connection
    """
    try:
        access_token = get_spotify_access_token_for_sdk()
        if not access_token:
            return {"error": "No Spotify access token available"}
        
        # Test search
        from spotify_player import search_track_on_spotify
        result = search_track_on_spotify("Gravity", "John Mayer", access_token)
        return {
            "success": True,
            "token_exists": bool(access_token),
            "search_result": bool(result),
            "track_found": result.get("name") if result else None
        }
    except Exception as e:
        return {"error": str(e), "success": False}

@app.get("/playlists")
def get_playlists():
    """
    Returns the user's playlists based on feedback.
    """
    return user_playlists

@app.post("/remove_local_playlist_track")
async def remove_local_playlist_track(delete_request: DeleteTrackRequest):
    playlist_id = delete_request.playlist_id
    track_id = delete_request.track_id

    if playlist_id not in user_playlists:
        return JSONResponse(status_code=404, content={"detail": "Playlist not found."})

    initial_len = len(user_playlists[playlist_id])
    user_playlists[playlist_id] = [track for track in user_playlists[playlist_id] if track.get("id") != track_id]

    if len(user_playlists[playlist_id]) < initial_len:
        return JSONResponse(content={"message": "Track removed successfully from local playlist."})
    else:
        return JSONResponse(status_code=404, content={"detail": "Track not found in local playlist."})

# This is the entry point for running the FastAPI application with Uvicorn.
# To run this application, you would typically use: uvicorn main:app --reload
# The host and port can be configured as needed.
# For local development, you might use: uvicorn main:app --host 0.0.0.0 --port 8000
