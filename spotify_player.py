import requests
import urllib.parse

def search_track_on_spotify(track_name, artist_name=None, access_token=None):
    if access_token is None:
        print("Warning: Spotify access token not provided for search. Skipping Spotify search.")
        return None

    query = f"track:{track_name} artist:{artist_name}" if artist_name else f"track:{track_name}"
    url = f"https://api.spotify.com/v1/search?q={urllib.parse.quote(query)}&type=track&limit=1"
    headers = {"Authorization": f"Bearer {access_token}"}
    response = requests.get(url, headers=headers)
    if response.status_code == 200:
        items = response.json().get("tracks", {}).get("items", [])
        if items:
            track_data = items[0]
            # Return the full track object which includes album info
            return track_data 
    return None

def get_track_preview_url(track_id, access_token):
    """
    Fetches the preview URL for a given Spotify track ID.
    """
    url = f"https://api.spotify.com/v1/tracks/{track_id}"
    headers = {"Authorization": f"Bearer {access_token}"}
    response = requests.get(url, headers=headers)
    if response.status_code == 200:
        track_data = response.json()
        return track_data.get('preview_url')
    return None

def get_user_profile(access_token):
    """
    Fetches the current user's profile information, including product type (premium/free).
    """
    url = "https://api.spotify.com/v1/me"
    headers = {"Authorization": f"Bearer {access_token}"}
    response = requests.get(url, headers=headers)
    if response.status_code == 200:
        return response.json()
    else:
        print(f"Error fetching user profile: {response.status_code} - {response.text}")
        return None

def create_spotify_playlist(user_id, playlist_name, access_token):
    """
    Creates a new Spotify playlist for the given user.
    """
    url = f"https://api.spotify.com/v1/users/{user_id}/playlists"
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json"
    }
    data = {
        "name": playlist_name,
        "public": False, # You can change this to True if you want public playlists
        "collaborative": False,
        "description": "Playlist created by Music Recommender"
    }
    response = requests.post(url, headers=headers, json=data)
    if response.status_code == 201:
        return response.json().get('id')
    else:
        print(f"Error creating playlist: {response.status_code} - {response.text}")
        return None

def add_tracks_to_playlist(playlist_id, track_uris, access_token):
    """
    Adds tracks to an existing Spotify playlist.
    """
    url = f"https://api.spotify.com/v1/playlists/{playlist_id}/tracks"
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json"
    }
    data = {
        "uris": track_uris
    }
    response = requests.post(url, headers=headers, json=data)
    if response.status_code == 201:
        return True
    else:
        print(f"Error adding tracks to playlist: {response.status_code} - {response.text}")
        return False
