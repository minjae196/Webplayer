// Configuration
let CONFIG = {
    spotify_client_id: 'd28df89507ca47bebaa9385ebb546e92',
    redirect_uri: 'http://localhost:8000/callback',
    scopes: 'streaming user-read-email user-read-private user-modify-playback-state user-read-playback-state'
};

// Global variables
let spotifyPlayer = null;
let currentTrackUri = null;
let activeDeviceId = null;
let playbackUpdateInterval = null;
let currentDisplayedRecommendations = [];
let recommendationPool = [];
let currentSeedTrackName = '';
let currentSeedArtistName = '';
let audioPreview = null;
let accessToken = null;
let currentPlaylist = [];
let currentPlaylistIndex = -1;
let currentPlaylistId = null;
let isShuffling = false;
let userSelectedMode = null;
let currentUser = null;

// Initialize configuration
async function initializeConfig() {
    try {
        const response = await fetch('/config');
        if (response.ok) {
            const backendConfig = await response.json();
            CONFIG = { ...CONFIG, ...backendConfig };
            console.log('Configuration loaded:', CONFIG);
        }
    } catch (error) {
        console.error('Error loading configuration:', error);
    }
}

// Helper functions
function formatTime(ms) {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function showError(message) {
    const errorElement = document.getElementById('error-message');
    if (errorElement) {
        errorElement.textContent = message;
        errorElement.classList.remove('d-none');
        setTimeout(() => errorElement.classList.add('d-none'), 5000);
    }
}

function showLoader(show = true) {
    const loader = document.getElementById('loader');
    if (loader) {
        loader.classList.toggle('d-none', !show);
    }
}

// Spotify Web Playback SDK
window.onSpotifyWebPlaybackSDKReady = () => {
    console.log('Spotify Web Playback SDK ready');
    
    if (userSelectedMode !== 'premium') {
        console.log('Not premium mode - SDK not needed');
        return;
    }
    
    const token = localStorage.getItem('spotify_access_token');
    if (!token) {
        console.warn('No Spotify token available');
        return;
    }

    spotifyPlayer = new Spotify.Player({
        name: 'Music Recommender Player',
        getOAuthToken: async cb => {
            try {
                const response = await fetch('/spotify_sdk_token');
                if (response.ok) {
                    const data = await response.json();
                    cb(data.access_token);
                } else {
                    cb('');
                }
            } catch (error) {
                console.error('Error getting SDK token:', error);
                cb('');
            }
        },
        volume: 0.5
    });

    spotifyPlayer.connect();

    spotifyPlayer.addListener('ready', ({ device_id }) => {
        console.log('Spotify Player ready with device ID:', device_id);
        activeDeviceId = device_id;
        showMiniPlayer(true);
    });

    spotifyPlayer.addListener('not_ready', ({ device_id }) => {
        console.log('Spotify Player offline:', device_id);
        showMiniPlayer(false);
    });

    spotifyPlayer.addListener('player_state_changed', (state) => {
        if (!state) return;
        updatePlayerState(state);
    });
};

// Player functions
function showMiniPlayer(show = true) {
    const miniPlayer = document.getElementById('mini-player');
    if (miniPlayer) {
        miniPlayer.classList.toggle('d-none', !show);
    }
}

function updatePlayerState(state) {
    const { current_track: track } = state.track_window;
    if (!track) return;

    // Update track info
    const albumArt = document.getElementById('mini-player-album-art');
    const trackName = document.getElementById('mini-player-track-name');
    const artistName = document.getElementById('mini-player-artist-name');
    const playButton = document.getElementById('mini-player-play');

    if (albumArt && track.album.images[0]) {
        albumArt.src = track.album.images[0].url;
    }
    if (trackName) trackName.textContent = track.name;
    if (artistName) artistName.textContent = track.artists.map(a => a.name).join(', ');
    if (playButton) {
        playButton.innerHTML = state.paused ? 
            '<i class="bi bi-play-fill"></i>' : 
            '<i class="bi bi-pause-fill"></i>';
    }

    // Update seek bar
    updateSeekBar(state.position, state.duration);
    
    if (!state.paused) {
        startPlaybackUpdate();
    } else {
        stopPlaybackUpdate();
