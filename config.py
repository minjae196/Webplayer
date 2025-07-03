import os
from dotenv import load_dotenv

load_dotenv()

LASTFM_API_KEY = os.getenv("LASTFM_API_KEY")
SPOTIFY_CLIENT_ID = os.getenv("SPOTIFY_CLIENT_ID")
SPOTIFY_CLIENT_SECRET = os.getenv("SPOTIFY_CLIENT_SECRET")

# Render 배포 시 동적으로 URL 설정
if os.getenv("RENDER"):
    # Render 환경에서는 고정 URL 사용
    SPOTIPY_REDIRECT_URI = "https://webplayer-gog9.onrender.com/callback"
else:
    # 로컬 개발 환경
    SPOTIPY_REDIRECT_URI = os.getenv("SPOTIPY_REDIRECT_URI", "http://localhost:8000/callback")

SPOTIPY_SCOPE = "user-read-playback-state user-modify-playback-state user-read-currently-playing app-remote-control streaming user-read-email user-read-private"
