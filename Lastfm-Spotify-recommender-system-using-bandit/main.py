from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
import os

# Local module imports
from lastfm_client import LastFMClient
from recommender import Recommender
from bandit.thompson_sampling import ThompsonSampling
from spotify_player import search_track_on_spotify
from spotify_auth import SpotifyAuthManager
from config import SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIPY_REDIRECT_URI, SPOTIPY_SCOPE

# Initialize SpotifyAuthManager using variables from config.py
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
    """
    if not spotify_auth_manager.get_access_token():
        # In a real web app, you'd redirect the user to spotify_auth_manager.get_authorize_url()
        # For this CLI context, we'll just return None and expect the frontend to handle the redirect.
        return None
    return spotify_auth_manager.get_access_token()

# --- Initialization ---
# Initialize the core components of the recommender system.
# This is now simplified and corrected.
try:
    lastfm_client = LastFMClient()
    bandit = ThompsonSampling() # Changed to ThompsonSampling
    recommender = Recommender(lastfm_client, bandit)
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

class RecommendOneRequest(BaseModel):
    seed_track_name: str
    seed_artist_name: str
    exclude_ids: list[str] = [] # New field to exclude already displayed track IDs

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
    raise RuntimeError(f"Webplayer directory not found at {WEBPLAYER_DIR}")

app.mount("/static", StaticFiles(directory=WEBPLAYER_DIR), name="static")

@app.get("/")
async def read_index():
    """
    Serves the main index.html file for the frontend.
    """
    return FileResponse(os.path.join(WEBPLAYER_DIR, 'index.html'))

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
    access_token = get_spotify_access_token_for_sdk()
    if not access_token:
        raise HTTPException(status_code=401, detail="Spotify access token not available. Please log in.")
    
    user_profile = get_user_profile(access_token)
    product_type = user_profile.get('product', 'free') if user_profile else 'free'

    return {"access_token": access_token, "token_type": "Bearer", "expires_in": 3600, "product_type": product_type}

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
    print(f"[Backend] Received recommendation request for track: {request.track_name}, artist: {request.artist_name}") # <-- LOG 1

    if not recommender:
        raise HTTPException(status_code=503, detail="Recommender system is not initialized.")

    try:
        # 1. Get track recommendations from the recommender module
        lastfm_tracks = recommender.recommend_bulk(
            mode="track", # or "artist", "tag"
            track_name=request.track_name,
            artist_name=request.artist_name,
            limit=request.num_recommendations
        )
        print(f"[Backend] Last.fm returned {len(lastfm_tracks)} tracks.") # <-- LOG 2

        if not lastfm_tracks:
            raise HTTPException(status_code=404, detail="Could not generate recommendations from Last.fm.")

        # 2. Enrich the recommendations with Spotify data
        spotify_recommendations = []
        for track in lastfm_tracks:
            artist = track.get('artist', {}).get('name', 'Unknown Artist')
            track_name = track.get('name', 'Unknown Track')

            # Search on Spotify to get ID, album art, etc.
            # Search on Spotify to get ID, album art, etc.
            spotify_info = search_track_on_spotify(track_name, artist, access_token=get_spotify_access_token_for_sdk())
            print(f"[Backend] Spotify search for '{track_name}' by '{artist}' returned: {spotify_info is not None}") # <-- LOG 3

            if spotify_info and spotify_info.get('id'):
                # Get album cover from Spotify's response if available
                album_cover_url = "https://i.scdn.co/image/ab67616d0000b273b44de2c935f87a4734a09153" # Default
                if spotify_info.get('album', {}).get('images'):
                    album_cover_url = spotify_info['album']['images'][0]['url']

                preview_url = get_track_preview_url(spotify_info['id'], access_token=get_spotify_access_token_for_sdk())
                spotify_recommendations.append({
                    "id": spotify_info['id'],
                    "name": track_name,
                    "artist": artist,
                    "album_cover_url": album_cover_url,
                    "uri": spotify_info['uri'], # Add URI here
                    "preview_url": preview_url, # Add preview URL here
                    "seed_track_name": request.track_name, # Add seed info
                    "seed_artist_name": request.artist_name # Add seed info
                })
        
        print(f"[Backend] Final Spotify recommendations count: {len(spotify_recommendations)}") # <-- LOG 4

        # Limit the number of results as requested
        final_recommendations = spotify_recommendations[:request.num_recommendations]

        if not final_recommendations:
            raise HTTPException(status_code=404, detail="Could find the recommended tracks on Spotify.")

        return {"recommendations": final_recommendations}

    except Exception as e:
        print(f"An error occurred: {e}") # Log the error for debugging
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/feedback")
def post_feedback(request: FeedbackRequest):
    """
    Receives user feedback (rating) for a recommended track
    and updates the bandit algorithm.
    """
    if not recommender:
        raise HTTPException(status_code=503, detail="Recommender system is not initialized.")
    
    try:
        # The track_id from frontend is Spotify ID, but bandit uses Last.fm format
        # We need to convert it back or ensure consistency.
        # For simplicity, let's assume track_id from frontend is already in the format
        # "Track Name - Artist Name" which is what the bandit expects.
        # If not, a lookup would be needed here.
        
        # For the purpose of demonstrating feedback, we'll use the Spotify ID directly
        # as the item_id for the bandit. This means the bandit will learn based on Spotify IDs.
        # If you want the bandit to learn on Last.fm track names, you'd need to pass that.
        
        # Convert rating (0-5) to a reward (0.0-1.0)
        # 0: 0.0 (skip/dislike)
        # 1-5: 0.2-1.0 (linear scale)
        reward = request.rating / 5.0 if request.rating > 0 else 0.0
        
        recommender.give_feedback(request.track_id, reward)
        print(f"[Backend] Received feedback for {request.track_id} with rating {request.rating} (reward: {reward})")

        # Store in user_playlists
        # Find the track in the current recommendations to get its full info
        # This assumes the track_id is unique enough to identify the track
        # In a real app, you'd fetch the track details from Spotify or a database
        # For simplicity, we'll just store the provided info and seed info
        track_info = {
            "id": request.track_id,
            "rating": request.rating,
            "seed_track_name": request.seed_track_name,
            "seed_artist_name": request.seed_artist_name
        }
        # Ensure the rating is an integer key for the dictionary
        rating_key = str(int(request.rating))
        if rating_key not in user_playlists:
            user_playlists[rating_key] = []
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

@app.get("/playlists")
def get_playlists():
    """
    Returns the user's playlists based on feedback.
    """
    return user_playlists


# This is the entry point for running the FastAPI application with Uvicorn.
# To run this application, you would typically use: uvicorn main:app --reload
# The host and port can be configured as needed.
# For local development, you might use: uvicorn main:app --host 0.0.0.0 --port 8000
