from fastapi import FastAPI, Request, Response
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from urllib.parse import urlencode
import httpx
import os
from pydantic import BaseModel

app = FastAPI()

# In-memory storage for local playlists (for demonstration purposes)
# In a real application, this would be stored in a database.
local_playlists = {str(i): [] for i in range(6)} # 0 for skipped, 1-5 for ratings

# Spotify API Credentials (Replace with your actual credentials)
# You should get these from your Spotify Developer Dashboard
# For security, consider loading these from environment variables or a config file
SPOTIPY_CLIENT_ID = os.getenv("SPOTIPY_CLIENT_ID", "YOUR_SPOTIFY_CLIENT_ID")
SPOTIPY_CLIENT_SECRET = os.getenv("SPOTIPY_CLIENT_SECRET", "YOUR_SPOTIFY_CLIENT_SECRET")
SPOTIPY_REDIRECT_URI = os.getenv("SPOTIPY_REDIRECT_URI", "http://localhost:8000/callback")

# Mount static files from the 'webplayer' directory
app.mount("/webplayer", StaticFiles(directory="webplayer"), name="webplayer")

@app.get("/", response_class=HTMLResponse)
async def read_root():
    # Serve the index.html from the webplayer directory
    with open("webplayer/index.html", "r", encoding="utf-8") as f:
        return f.read()

@app.get("/login")
async def spotify_login():
    scope = "user-read-private user-read-email streaming user-modify-playback-state user-read-playback-state playlist-modify-public playlist-modify-private"
    params = {
        "response_type": "code",
        "client_id": SPOTIPY_CLIENT_ID,
        "scope": scope,
        "redirect_uri": SPOTIPY_REDIRECT_URI,
    }
    return RedirectResponse(f"https://accounts.spotify.com/authorize?{urlencode(params)}")

@app.get("/callback")
async def spotify_callback(request: Request):
    code = request.query_params.get("code")
    if not code:
        return JSONResponse(status_code=400, content={"error": "Authorization code not found"})

    token_url = "https://accounts.spotify.com/api/token"
    payload = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": SPOTIPY_REDIRECT_URI,
        "client_id": SPOTIPY_CLIENT_ID,
        "client_secret": SPOTIPY_CLIENT_SECRET,
    }
    headers = {"Content-Type": "application/x-www-form-urlencoded"}

    async with httpx.AsyncClient() as client:
        response = await client.post(token_url, data=payload, headers=headers)

    if response.status_code != 200:
        return JSONResponse(status_code=response.status_code, content=response.json())

    token_info = response.json()
    access_token = token_info.get("access_token")
    refresh_token = token_info.get("refresh_token")
    expires_in = token_info.get("expires_in")

    # In a real application, you would store these tokens securely (e.g., in a database)
    # and associate them with a user session. For this example, we'll pass them via a cookie
    # or directly to the frontend for SDK initialization.
    # For simplicity, we'll redirect back to the main page with the access token in the hash.
    # This is NOT secure for production but works for demonstration.
    response = RedirectResponse(url=f"/?access_token={access_token}&refresh_token={refresh_token}&expires_in={expires_in}#_=_")
    return response

# This endpoint is called by script.js to get the SDK token
@app.get("/spotify_sdk_token")
async def spotify_sdk_token(request: Request):
    # In a real app, you'd fetch the stored access token for the current user.
    # For this example, we'll assume the token is passed in the URL hash after login.
    # This is a simplification and not how a production app would handle it.
    # The script.js expects a JSON response with 'access_token'.
    
    # For demonstration, we'll try to get the token from the query parameters
    # (which would be set by the /callback redirect in this simplified flow).
    # In a proper setup, this would involve session management.
    access_token = request.query_params.get("access_token")
    
    if not access_token:
        # If no token in query, try to get it from a cookie or session (more robust)
        # For now, we'll return an error if not found.
        return JSONResponse(status_code=401, content={"error": "No access token available. Please log in."})

    return JSONResponse(content={"access_token": access_token})

@app.get("/playlists")
async def get_playlists():
    return JSONResponse(content=local_playlists)

# Request body for export playlist
class ExportPlaylistRequest(BaseModel):
    playlist_name: str
    track_ids: list[str]

class DeleteTrackRequest(BaseModel):
    playlist_id: str
    track_id: str

class AddTrackRequest(BaseModel):
    playlist_id: str
    track: dict # Assuming track is a dictionary with at least an 'id' field

class AddSingleTrackToSpotifyRequest(BaseModel):
    track_id: str
    track_uri: str
    access_token: str

@app.post("/export_playlist")
async def export_playlist(request: Request, export_request: ExportPlaylistRequest):
    access_token = request.query_params.get("access_token")
    if not access_token:
        return JSONResponse(status_code=401, content={"detail": "Access token not found. Please log in to Spotify."})

    # Get user ID
    async with httpx.AsyncClient() as client:
        user_profile_response = await client.get(
            "https://api.spotify.com/v1/me",
            headers={
                "Authorization": f"Bearer {access_token}"
            }
        )
        if user_profile_response.status_code != 200:
            return JSONResponse(status_code=user_profile_response.status_code, content={"detail": "Failed to get user profile from Spotify."})
        user_id = user_profile_response.json()["id"]

    # Create playlist
    async with httpx.AsyncClient() as client:
        create_playlist_response = await client.post(
            f"https://api.spotify.com/v1/users/{user_id}/playlists",
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json"
            },
            json={
                "name": export_request.playlist_name,
                "public": False, # You can make it public if you want
                "description": "Playlist exported from Music Recommender"
            }
        )
        if create_playlist_response.status_code != 201:
            return JSONResponse(status_code=create_playlist_response.status_code, content={"detail": "Failed to create playlist on Spotify."})
        playlist_id = create_playlist_response.json()["id"]

    # Add tracks to playlist
    track_uris = [f"spotify:track:{track_id}" for track_id in export_request.track_ids]
    async with httpx.AsyncClient() as client:
        add_tracks_response = await client.post(
            f"https://api.spotify.com/v1/playlists/{playlist_id}/tracks",
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json"
            },
            json={
                "uris": track_uris
            }
        )
        if add_tracks_response.status_code != 201:
            return JSONResponse(status_code=add_tracks_response.status_code, content={"detail": "Failed to add tracks to playlist."})

    return JSONResponse(content={"message": "Playlist exported successfully!", "playlist_id": playlist_id})

@app.post("/remove_local_playlist_track")
async def remove_local_playlist_track(delete_request: DeleteTrackRequest):
    playlist_id = delete_request.playlist_id
    track_id = delete_request.track_id

    if playlist_id not in local_playlists:
        return JSONResponse(status_code=404, content={"detail": "Playlist not found."})

    initial_len = len(local_playlists[playlist_id])
    local_playlists[playlist_id] = [track for track in local_playlists[playlist_id] if track["id"] != track_id]

    if len(local_playlists[playlist_id]) < initial_len:
        return JSONResponse(content={"message": "Track removed successfully from local playlist."})
    else:
        return JSONResponse(status_code=404, content={"detail": "Track not found in local playlist."})

@app.post("/add_track_to_local_playlist")
async def add_track_to_local_playlist(add_request: AddTrackRequest):
    playlist_id = add_request.playlist_id
    track = add_request.track

    if playlist_id not in local_playlists:
        return JSONResponse(status_code=404, content={"detail": "Playlist not found."})

    # Prevent duplicate tracks
    if any(t["id"] == track["id"] for t in local_playlists[playlist_id]):
        return JSONResponse(status_code=200, content={"message": "Track already exists in local playlist."})

    local_playlists[playlist_id].append(track)
    return JSONResponse(content={"message": "Track added successfully to local playlist."})

@app.post("/add_single_track_to_spotify_playlist")
async def add_single_track_to_spotify_playlist(add_request: AddSingleTrackToSpotifyRequest):
    access_token = add_request.access_token
    track_uri = add_request.track_uri
    track_id = add_request.track_id

    if not access_token:
        return JSONResponse(status_code=401, content={"detail": "Access token not found. Please log in to Spotify."})

    # Define a consistent playlist name for recommended tracks
    playlist_name = "My Recommended Tracks"
    user_id = None
    playlist_id = None

    async with httpx.AsyncClient() as client:
        # Get user ID
        user_profile_response = await client.get(
            "https://api.spotify.com/v1/me",
            headers={
                "Authorization": f"Bearer {access_token}"
            }
        )
        if user_profile_response.status_code != 200:
            return JSONResponse(status_code=user_profile_response.status_code, content={"detail": "Failed to get user profile from Spotify."})
        user_id = user_profile_response.json()["id"]

        # Check if playlist already exists
        playlists_response = await client.get(
            f"https://api.spotify.com/v1/users/{user_id}/playlists",
            headers={
                "Authorization": f"Bearer {access_token}"
            }
        )
        if playlists_response.status_code == 200:
            for pl in playlists_response.json()["items"]:
                if pl["name"] == playlist_name:
                    playlist_id = pl["id"]
                    break

        # If playlist doesn't exist, create it
        if not playlist_id:
            create_playlist_response = await client.post(
                f"https://api.spotify.com/v1/users/{user_id}/playlists",
                headers={
                    "Authorization": f"Bearer {access_token}",
                    "Content-Type": "application/json"
                },
                json={
                    "name": playlist_name,
                    "public": False, # Set to True if you want it public by default
                    "description": "Tracks recommended by Music Recommender"
                }
            )
            if create_playlist_response.status_code != 201:
                return JSONResponse(status_code=create_playlist_response.status_code, content={"detail": "Failed to create playlist on Spotify."})
            playlist_id = create_playlist_response.json()["id"]

        # Add track to playlist (check for duplicates first if desired, Spotify API handles duplicates by default)
        # To prevent duplicates, you would fetch playlist items and check before adding.
        # For simplicity, we'll just add it. Spotify API usually handles adding existing tracks gracefully (no error, just not added again).
        add_track_response = await client.post(
            f"https://api.spotify.com/v1/playlists/{playlist_id}/tracks",
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json"
            },
            json={
                "uris": [track_uri]
            }
        )
        if add_track_response.status_code not in [200, 201]: # 200 for success, 201 for created (sometimes returned)
            return JSONResponse(status_code=add_track_response.status_code, content={"detail": "Failed to add track to Spotify playlist."})

    return JSONResponse(content={"message": "Track added to Spotify playlist successfully!", "playlist_id": playlist_id})

@app.post("/delete_track_from_playlist")
async def delete_track_from_playlist(request: Request, delete_request: DeleteTrackRequest):
    access_token = request.query_params.get("access_token")
    if not access_token:
        return JSONResponse(status_code=401, content={"detail": "Access token not found. Please log in to Spotify."})

    track_uri = f"spotify:track:{delete_request.track_id}"

    async with httpx.AsyncClient() as client:
        response = await client.request(
            "DELETE",
            f"https://api.spotify.com/v1/playlists/{delete_request.playlist_id}/tracks",
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json"
            },
            json={
                "tracks": [{
                    "uri": track_uri
                }]
            }
        )

        if response.status_code != 200:
            return JSONResponse(status_code=response.status_code, content={"detail": "Failed to delete track from playlist."})

    return JSONResponse(content={"message": "Track deleted successfully!"})

# You might also need endpoints for recommendations and feedback if they are not handled by Streamlit
# @app.post("/recommendations")
# async def get_recommendations(request: Request):
#     # Your recommendation logic here
#     pass

# @app.post("/feedback")
# async def send_feedback(request: Request):
#     # Your feedback logic here
#     pass
    access_token = add_request.access_token
    track_uri = add_request.track_uri
    track_id = add_request.track_id

    if not access_token:
        return JSONResponse(status_code=401, content={"detail": "Access token not found. Please log in to Spotify."})

    # Define a consistent playlist name for recommended tracks
    playlist_name = "My Recommended Tracks"
    user_id = None
    playlist_id = None

    async with httpx.AsyncClient() as client:
        # Get user ID
        user_profile_response = await client.get(
            "https://api.spotify.com/v1/me",
            headers={
                "Authorization": f"Bearer {access_token}"
            }
        )
        if user_profile_response.status_code != 200:
            return JSONResponse(status_code=user_profile_response.status_code, content={"detail": "Failed to get user profile from Spotify."})
        user_id = user_profile_response.json()["id"]

        # Check if playlist already exists
        playlists_response = await client.get(
            f"https://api.spotify.com/v1/users/{user_id}/playlists",
            headers={
                "Authorization": f"Bearer {access_token}"
            }
        )
        if playlists_response.status_code == 200:
            for pl in playlists_response.json()["items"]:
                if pl["name"] == playlist_name:
                    playlist_id = pl["id"]
                    break

        # If playlist doesn't exist, create it
        if not playlist_id:
            create_playlist_response = await client.post(
                f"https://api.spotify.com/v1/users/{user_id}/playlists",
                headers={
                    "Authorization": f"Bearer {access_token}",
                    "Content-Type": "application/json"
                },
                json={
                    "name": playlist_name,
                    "public": False, # Set to True if you want it public by default
                    "description": "Tracks recommended by Music Recommender"
                }
            )
            if create_playlist_response.status_code != 201:
                return JSONResponse(status_code=create_playlist_response.status_code, content={"detail": "Failed to create playlist on Spotify."})
            playlist_id = create_playlist_response.json()["id"]

        # Add track to playlist (check for duplicates first if desired, Spotify API handles duplicates by default)
        # To prevent duplicates, you would fetch playlist items and check before adding.
        # For simplicity, we'll just add it. Spotify API usually handles adding existing tracks gracefully (no error, just not added again).
        add_track_response = await client.post(
            f"https://api.spotify.com/v1/playlists/{playlist_id}/tracks",
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json"
            },
            json={
                "uris": [track_uri]
            }
        )
        if add_track_response.status_code not in [200, 201]: # 200 for success, 201 for created (sometimes returned)
            return JSONResponse(status_code=add_track_response.status_code, content={"detail": "Failed to add track to Spotify playlist."})

    return JSONResponse(content={"message": "Track added to Spotify playlist successfully!", "playlist_id": playlist_id})

@app.post("/delete_track_from_playlist")
async def delete_track_from_playlist(request: Request, delete_request: DeleteTrackRequest):
    access_token = request.query_params.get("access_token")
    if not access_token:
        return JSONResponse(status_code=401, content={"detail": "Access token not found. Please log in to Spotify."})

    track_uri = f"spotify:track:{delete_request.track_id}"

    async with httpx.AsyncClient() as client:
        response = await client.request(
            "DELETE",
            f"https://api.spotify.com/v1/playlists/{delete_request.playlist_id}/tracks",
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json"
            },
            json={
                "tracks": [{
                    "uri": track_uri
                }]
            }
        )

        if response.status_code != 200:
            return JSONResponse(status_code=response.status_code, content={"detail": "Failed to delete track from playlist."})

    return JSONResponse(content={"message": "Track deleted successfully!"})

# You might also need endpoints for recommendations and feedback if they are not handled by Streamlit
# @app.post("/recommendations")
# async def get_recommendations(request: Request):
#     # Your recommendation logic here
#     pass

# @app.post("/feedback")
# async def send_feedback(request: Request):
#     # Your feedback logic here
#     pass
