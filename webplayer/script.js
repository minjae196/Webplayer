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
let spotifySDKLoaded = false;

// Initialize configuration
async function initializeConfig() {
    try {
        const response = await fetch('/config');
        if (response.ok) {
            const backendConfig = await response.json();
            CONFIG = { ...CONFIG, ...backendConfig };
            console.log('Configuration loaded from backend:', CONFIG);
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
    console.error('Error:', message);
}

function showLoader(show = true) {
    const loader = document.getElementById('loader');
    if (loader) {
        loader.classList.toggle('d-none', !show);
    }
}

// Load Spotify SDK
function loadSpotifySDK() {
    return new Promise((resolve, reject) => {
        if (spotifySDKLoaded) {
            resolve();
            return;
        }
        
        // Check if SDK script already exists
        if (document.querySelector('script[src*="spotify-player.js"]')) {
            spotifySDKLoaded = true;
            resolve();
            return;
        }
        
        console.log('Loading Spotify Web Playback SDK...');
        const script = document.createElement('script');
        script.src = 'https://sdk.scdn.co/spotify-player.js';
        script.async = true;
        
        script.onload = () => {
            console.log('Spotify SDK script loaded');
            spotifySDKLoaded = true;
            resolve();
        };
        
        script.onerror = (error) => {
            console.error('Failed to load Spotify SDK:', error);
            reject(error);
        };
        
        document.head.appendChild(script);
    });
}

// Spotify Web Playback SDK Ready
window.onSpotifyWebPlaybackSDKReady = () => {
    console.log('Spotify Web Playback SDK is ready!');
    
    if (userSelectedMode !== 'premium') {
        console.log('Not premium mode - SDK not needed');
        return;
    }
    
    initializeSpotifyPlayer();
};

async function initializeSpotifyPlayer() {
    try {
        console.log('Initializing Spotify Player...');
        
        // Get token first
        const tokenResponse = await fetch('/spotify_sdk_token');
        if (!tokenResponse.ok) {
            throw new Error('Failed to get Spotify token');
        }
        
        const tokenData = await tokenResponse.json();
        const token = tokenData.access_token;
        
        if (!token) {
            throw new Error('No access token available');
        }
        
        console.log('Token available, creating player...');

        // Create player
        spotifyPlayer = new Spotify.Player({
            name: 'Music Recommender Web Player',
            getOAuthToken: async cb => {
                try {
                    const response = await fetch('/spotify_sdk_token');
                    if (response.ok) {
                        const data = await response.json();
                        console.log('Token refreshed for player');
                        cb(data.access_token);
                    } else {
                        console.error('Failed to refresh token');
                        cb('');
                    }
                } catch (error) {
                    console.error('Error refreshing token:', error);
                    cb('');
                }
            },
            volume: 0.5
        });

        // Error listeners
        spotifyPlayer.addListener('initialization_error', ({ message }) => {
            console.error('Spotify initialization error:', message);
            showError('Spotify Player initialization failed. Try refreshing the page.');
        });

        spotifyPlayer.addListener('authentication_error', ({ message }) => {
            console.error('Spotify authentication error:', message);
            showError('Spotify authentication failed. Please log out and log in again.');
        });

        spotifyPlayer.addListener('account_error', ({ message }) => {
            console.error('Spotify account error:', message);
            showError('Premium account required for full playback. Using preview mode instead.');
            // Fallback to preview mode
            userSelectedMode = 'general';
        });

        spotifyPlayer.addListener('playback_error', ({ message }) => {
            console.error('Spotify playback error:', message);
            // Don't show error, try preview instead
        });

        // Success listeners
        spotifyPlayer.addListener('ready', ({ device_id }) => {
            console.log('✅ Spotify Player ready! Device ID:', device_id);
            activeDeviceId = device_id;
            showMiniPlayer(true);
            
            // Show success message
            showSuccessMessage('🎵 Spotify Premium Player ready! Click any song to play full tracks.');
        });

        spotifyPlayer.addListener('not_ready', ({ device_id }) => {
            console.log('Spotify Player offline:', device_id);
            activeDeviceId = null;
        });

        spotifyPlayer.addListener('player_state_changed', (state) => {
            if (!state) return;
            updatePlayerState(state);
        });

        // Connect the player
        const connected = await spotifyPlayer.connect();
        console.log('Player connection result:', connected);
        
        if (!connected) {
            throw new Error('Failed to connect Spotify Player');
        }
        
    } catch (error) {
        console.error('Error initializing Spotify Player:', error);
        showError('Failed to initialize Spotify Player. Using preview mode instead.');
        // Fallback to preview mode
        userSelectedMode = 'general';
    }
}

function showSuccessMessage(message) {
    // Create and show success alert
    const alertDiv = document.createElement('div');
    alertDiv.className = 'alert alert-success alert-dismissible fade show position-fixed';
    alertDiv.style.cssText = 'top: 20px; right: 20px; z-index: 9999; max-width: 400px;';
    alertDiv.innerHTML = `
        ${message}
        <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
    `;
    document.body.appendChild(alertDiv);
    
    // Auto remove after 5 seconds
    setTimeout(() => {
        if (alertDiv.parentNode) {
            alertDiv.remove();
        }
    }, 5000);
}

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
    }

    showMiniPlayer(true);
}

function updateSeekBar(position, duration) {
    const seekSlider = document.getElementById('seek-slider');
    const currentTime = document.getElementById('current-time');
    const totalTime = document.getElementById('total-time');

    if (seekSlider) {
        seekSlider.max = duration;
        seekSlider.value = position;
    }
    if (currentTime) currentTime.textContent = formatTime(position);
    if (totalTime) totalTime.textContent = formatTime(duration);
}

function startPlaybackUpdate() {
    stopPlaybackUpdate();
    playbackUpdateInterval = setInterval(() => {
        if (spotifyPlayer) {
            spotifyPlayer.getCurrentState().then(state => {
                if (state) {
                    updateSeekBar(state.position, state.duration);
                }
            });
        }
    }, 1000);
}

function stopPlaybackUpdate() {
    if (playbackUpdateInterval) {
        clearInterval(playbackUpdateInterval);
        playbackUpdateInterval = null;
    }
}

// Audio Preview functions for non-premium users
function playPreview(previewUrl, track) {
    console.log('Attempting to play preview for:', track.name, 'Preview URL:', previewUrl);
    
    if (!previewUrl) {
        console.warn('No preview URL available for:', track.name);
        showError(`No preview available for "${track.name}". This track cannot be previewed.`);
        return;
    }

    try {
        if (audioPreview) {
            audioPreview.pause();
            audioPreview = null;
        }

        audioPreview = new Audio(previewUrl);
        audioPreview.volume = 0.5;

        audioPreview.addEventListener('loadedmetadata', () => {
            console.log('Preview loaded for:', track.name);
            updatePreviewPlayer(track, audioPreview.duration * 1000);
        });

        audioPreview.addEventListener('timeupdate', () => {
            if (audioPreview) {
                updateSeekBar(audioPreview.currentTime * 1000, audioPreview.duration * 1000);
            }
        });

        audioPreview.addEventListener('ended', () => {
            console.log('Preview ended for:', track.name);
            const playButton = document.getElementById('mini-player-play');
            if (playButton) {
                playButton.innerHTML = '<i class="bi bi-play-fill"></i>';
            }
            playNextInPlaylist();
        });

        audioPreview.addEventListener('error', (e) => {
            console.error('Preview playback error:', e);
            showError(`Failed to play preview for "${track.name}"`);
        });

        audioPreview.play().then(() => {
            console.log('✅ Preview playing for:', track.name);
            const playButton = document.getElementById('mini-player-play');
            if (playButton) {
                playButton.innerHTML = '<i class="bi bi-pause-fill"></i>';
            }
            showMiniPlayer(true);
        }).catch(error => {
            console.error('Error playing preview:', error);
            showError(`Failed to play preview for "${track.name}"`);
        });
        
    } catch (error) {
        console.error('Error setting up preview:', error);
        showError(`Error playing preview for "${track.name}"`);
    }
}

function updatePreviewPlayer(track, duration) {
    const albumArt = document.getElementById('mini-player-album-art');
    const trackName = document.getElementById('mini-player-track-name');
    const artistName = document.getElementById('mini-player-artist-name');

    if (albumArt) albumArt.src = track.album_cover_url || '';
    if (trackName) trackName.textContent = track.name || 'Unknown Track';
    if (artistName) artistName.textContent = track.artist || 'Unknown Artist';

    updateSeekBar(0, duration);
}

// Play track function - IMPROVED
async function playTrack(trackUri, track, playlist = [], index = -1) {
    console.log('🎵 Playing track:', track.name, 'by', track.artist);
    console.log('User mode:', userSelectedMode, 'Premium account:', currentUser?.product);
    console.log('Track URI:', trackUri);
    console.log('Preview URL:', track.preview_url);
    
    currentPlaylist = playlist;
    currentPlaylistIndex = index;
    
    // Try Spotify Premium playback first if user has premium
    if (userSelectedMode === 'premium' && currentUser?.product === 'premium' && spotifyPlayer && activeDeviceId) {
        console.log('Attempting Spotify Premium playback...');
        
        try {
            const tokenResponse = await fetch('/spotify_sdk_token');
            if (!tokenResponse.ok) throw new Error('Failed to get token');
            
            const tokenData = await tokenResponse.json();
            
            const response = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${activeDeviceId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${tokenData.access_token}`
                },
                body: JSON.stringify({ uris: [trackUri] })
            });

            if (response.ok) {
                console.log('✅ Spotify Premium playback started');
                return;
            } else {
                const errorData = await response.text();
                console.error('Spotify API error:', response.status, errorData);
                throw new Error(`Spotify API error: ${response.status}`);
            }
        } catch (error) {
            console.error('❌ Spotify Premium playback failed:', error);
            console.log('Falling back to preview mode...');
        }
    }
    
    // Fallback to preview playback
    console.log('Using preview playback...');
    playPreview(track.preview_url, track);
}

// Playlist navigation
function playNextInPlaylist() {
    if (currentPlaylist.length === 0) return;
    
    if (isShuffling) {
        currentPlaylistIndex = Math.floor(Math.random() * currentPlaylist.length);
    } else {
        currentPlaylistIndex = (currentPlaylistIndex + 1) % currentPlaylist.length;
    }
    
    const nextTrack = currentPlaylist[currentPlaylistIndex];
    if (nextTrack) {
        playTrack(nextTrack.uri, nextTrack, currentPlaylist, currentPlaylistIndex);
    }
}

function playPreviousInPlaylist() {
    if (currentPlaylist.length === 0) return;
    
    if (isShuffling) {
        currentPlaylistIndex = Math.floor(Math.random() * currentPlaylist.length);
    } else {
        currentPlaylistIndex = currentPlaylistIndex <= 0 ? 
            currentPlaylist.length - 1 : currentPlaylistIndex - 1;
    }
    
    const prevTrack = currentPlaylist[currentPlaylistIndex];
    if (prevTrack) {
        playTrack(prevTrack.uri, prevTrack, currentPlaylist, currentPlaylistIndex);
    }
}

// User authentication
async function checkUserLoginStatus() {
    try {
        const response = await fetch('/spotify_sdk_token');
        if (response.ok) {
            const data = await response.json();
            accessToken = data.access_token;
            currentUser = { product: data.product_type || 'free' };
            
            localStorage.setItem('spotify_access_token', data.access_token);
            
            // Get user profile
            try {
                const profileResponse = await fetch('/user_profile');
                if (profileResponse.ok) {
                    const profile = await profileResponse.json();
                    currentUser = {
                        ...currentUser,
                        id: profile.id,
                        display_name: profile.display_name,
                        email: profile.email,
                        images: profile.images
                    };
                    console.log('User profile loaded:', currentUser);
                }
            } catch (e) {
                console.log('Could not fetch profile, using basic info');
            }
            
            return true;
        }
        return false;
    } catch (error) {
        console.error('Error checking login status:', error);
        return false;
    }
}

function updateUserInfoDisplay() {
    if (!currentUser) return;
    
    const userAvatar = document.getElementById('user-avatar');
    const userName = document.getElementById('user-name');
    const userMode = document.getElementById('user-mode');
    
    if (userAvatar && currentUser.images?.length > 0) {
        userAvatar.src = currentUser.images[0].url;
        userAvatar.classList.remove('d-none');
    }
    
    if (userName) {
        userName.textContent = currentUser.display_name || currentUser.email || 'User';
    }
    
    if (userMode) {
        const modeText = userSelectedMode === 'premium' ? 'Premium' : 'Preview';
        const productText = currentUser.product === 'premium' ? 'Premium' : 'Free';
        userMode.textContent = `${modeText} Mode • ${productText}`;
    }
    
    // Show product info
    const productInfo = document.getElementById('user-product-info');
    if (productInfo) {
        if (userSelectedMode === 'premium' && currentUser.product !== 'premium') {
            productInfo.className = 'alert alert-warning mb-4';
            productInfo.innerHTML = `
                <i class="bi bi-exclamation-triangle"></i>
                <strong>Notice:</strong> You selected Premium Mode but have a Spotify Free account. 
                You'll get preview playback only. 
                <a href="https://www.spotify.com/premium/" target="_blank" class="alert-link">Upgrade to Premium</a>
            `;
            productInfo.classList.remove('d-none');
        } else if (userSelectedMode === 'premium' && currentUser.product === 'premium') {
            productInfo.className = 'alert alert-success mb-4';
            productInfo.innerHTML = `
                <i class="bi bi-check-circle"></i>
                <strong>Great!</strong> Premium Mode activated with your Spotify Premium account!
            `;
            productInfo.classList.remove('d-none');
        } else {
            productInfo.classList.add('d-none');
        }
    }
}

// Recommendations
async function getRecommendations(trackName, artistName) {
    console.log(`Requesting recommendations for: ${trackName} - ${artistName}`);
    showLoader(true);
    
    try {
        const response = await fetch('/recommendations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                track_name: trackName,
                artist_name: artistName,
                num_recommendations: 16
            })
        });

        console.log('Received response from server:', response.status, response.statusText);

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Failed to get recommendations');
        }

        const data = await response.json();
        console.log('Parsed data:', data);
        
        displayRecommendations(data.recommendations);
        
    } catch (error) {
        console.error('Error getting recommendations:', error);
        showError(error.message);
    } finally {
        showLoader(false);
    }
}

function displayRecommendations(tracks) {
    const resultsContainer = document.getElementById('results');
    if (!resultsContainer) return;

    currentDisplayedRecommendations = tracks.slice(0, 12);
    recommendationPool = tracks.slice(12);

    resultsContainer.innerHTML = '';

    currentDisplayedRecommendations.forEach((track, index) => {
        const cardHTML = createTrackCard(track, index);
        resultsContainer.innerHTML += cardHTML;
    });

    // Add event listeners
    addTrackCardListeners();
}

function createTrackCard(track, index) {
    // Check if preview is available
    const hasPreview = track.preview_url && track.preview_url !== null;
    const previewBadge = hasPreview ? '' : '<span class="badge bg-warning text-dark small">No Preview</span>';
    
    return `
        <div class="col-lg-3 col-md-4 col-sm-6">
            <div class="card h-100" role="button" 
                 data-track-uri="${track.uri}" 
                 data-track-id="${track.id}"
                 data-track-index="${index}">
                <div class="position-relative">
                    <img src="${track.album_cover_url}" class="card-img-top" alt="${track.name}">
                    ${previewBadge}
                </div>
                <div class="card-body">
                    <h5 class="card-title">${track.name}</h5>
                    <p class="card-text">${track.artist}</p>
                    <div class="feedback-buttons">
                        <button class="btn btn-outline-success feedback-btn" data-rating="0">Skip</button>
                        <button class="btn btn-outline-success feedback-btn" data-rating="1">1</button>
                        <button class="btn btn-outline-success feedback-btn" data-rating="2">2</button>
                        <button class="btn btn-outline-success feedback-btn" data-rating="3">3</button>
                        <button class="btn btn-outline-success feedback-btn" data-rating="4">4</button>
                        <button class="btn btn-outline-success feedback-btn" data-rating="5">5</button>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function addTrackCardListeners() {
    // Play track on card click
    document.querySelectorAll('.card[data-track-uri]').forEach(card => {
        card.addEventListener('click', (e) => {
            if (e.target.closest('.feedback-btn')) return;
            
            const index = parseInt(card.dataset.trackIndex);
            const track = currentDisplayedRecommendations[index];
            playTrack(track.uri, track, currentDisplayedRecommendations, index);
        });
    });

    // Feedback buttons
    document.querySelectorAll('.feedback-btn').forEach(button => {
        button.addEventListener('click', (e) => {
            e.stopPropagation();
            const rating = parseInt(e.target.dataset.rating);
            const card = e.target.closest('.card[data-track-uri]');
            const index = parseInt(card.dataset.trackIndex);
            const track = currentDisplayedRecommendations[index];
            
            sendFeedback(track, rating, card);
        });
    });
}

async function sendFeedback(track, rating, cardElement) {
    try {
        const response = await fetch('/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                track_id: track.id,
                rating: rating,
                seed_track_name: currentSeedTrackName,
                seed_artist_name: currentSeedArtistName,
                track_info: track
            })
        });

        if (!response.ok) throw new Error('Failed to send feedback');

        // Replace card with new recommendation
        const newTrack = getNewRecommendationFromPool();
        if (newTrack) {
            replaceTrackCard(cardElement, newTrack);
        } else {
            cardElement.style.opacity = '0.5';
            setTimeout(() => cardElement.remove(), 500);
        }
        
        // Refresh playlists
        fetchPlaylists();
        
    } catch (error) {
        console.error('Error sending feedback:', error);
        showError('Failed to send feedback');
    }
}

function getNewRecommendationFromPool() {
    return recommendationPool.length > 0 ? recommendationPool.shift() : null;
}

function replaceTrackCard(cardElement, newTrack) {
    const container = cardElement.closest('.col-lg-3, .col-md-4, .col-sm-6');
    if (!container) return;

    const index = currentDisplayedRecommendations.length;
    currentDisplayedRecommendations.push(newTrack);

    container.style.transition = 'opacity 0.3s ease';
    container.style.opacity = '0';

    setTimeout(() => {
        container.innerHTML = createTrackCard(newTrack, index).replace(/^<div[^>]*>|<\/div>$/g, '');
        addTrackCardListeners();
        container.style.opacity = '1';
    }, 300);
}

// Playlists
async function fetchPlaylists() {
    try {
        const response = await fetch('/playlists');
        if (!response.ok) {
            console.warn('Failed to fetch playlists, using empty playlists');
            return;
        }
        
        const playlists = await response.json();
        displayPlaylists(playlists);
    } catch (error) {
        console.error('Error fetching playlists:', error);
    }
}

function displayPlaylists(playlists) {
    for (let i = 0; i <= 5; i++) {
        const tabButton = document.getElementById(`playlist-${i}-tab`);
        const tabContent = document.getElementById(`playlist-${i}`);
        
        if (!tabButton || !tabContent) continue;
        
        const tracks = playlists[i.toString()] || [];
        
        // Update tab title
        if (i === 0) {
            tabButton.textContent = `Skipped (${tracks.length})`;
        } else {
            const stars = '⭐'.repeat(i);
            tabButton.textContent = `${stars} Rating ${i} (${tracks.length})`;
        }
        
        // Update content
        if (tracks.length === 0) {
            tabContent.innerHTML = '<p class="text-muted text-center p-4">No tracks yet</p>';
        } else {
            tabContent.innerHTML = tracks.map((track, index) => 
                createPlaylistItem(track, i, index)
            ).join('');
        }
    }
    
    addPlaylistListeners();
}

function createPlaylistItem(track, playlistId, index) {
    const trackName = track.name || 'Unknown Track';
    const artistName = track.artist || 'Unknown Artist';
    const albumCover = track.album_cover_url || 'https://via.placeholder.com/60x60?text=♪';
    const rating = track.rating || 0;
    
    return `
        <div class="playlist-item" 
             data-track-uri="${track.uri || ''}"
             data-track-index="${index}"
             data-playlist-id="${playlistId}">
            <div class="d-flex align-items-center">
                <img src="${albumCover}" alt="Album" class="album-art me-3">
                <div class="flex-grow-1">
                    <h6 class="mb-1">${trackName}</h6>
                    <p class="mb-1 text-muted">${artistName}</p>
                    <small class="text-success">Rating: ${rating}/5</small>
                </div>
                <div class="d-flex gap-2">
                    <button class="btn btn-success btn-sm play-playlist-btn">
                        <i class="bi bi-play-fill"></i>
                    </button>
                    <button class="btn btn-outline-danger btn-sm remove-playlist-btn" 
                            data-track-id="${track.id}">
                        <i class="bi bi-trash"></i>
                    </button>
                </div>
            </div>
        </div>
    `;
}

function addPlaylistListeners() {
    // Play buttons
    document.querySelectorAll('.play-playlist-btn').forEach(button => {
        button.addEventListener('click', (e) => {
            e.stopPropagation();
            const item = e.target.closest('.playlist-item');
            const playlistId = item.dataset.playlistId;
            const index = parseInt(item.dataset.trackIndex);
            
            playPlaylistTrack(playlistId, index);
        });
    });

    // Remove buttons
    document.querySelectorAll('.remove-playlist-btn').forEach(button => {
        button.addEventListener('click', async (e) => {
            e.stopPropagation();
            const trackId = e.target.dataset.trackId;
            const item = e.target.closest('.playlist-item');
            const playlistId = item.dataset.playlistId;
            
            await removeFromPlaylist(playlistId, trackId);
        });
    });
}

function playPlaylistTrack(playlistId, trackIndex) {
    const tabContent = document.getElementById(`playlist-${playlistId}`);
    if (!tabContent) return;
    
    const items = tabContent.querySelectorAll('.playlist-item');
    const playlistTracks = Array.from(items).map(item => {
        const img = item.querySelector('img');
        const title = item.querySelector('h6');
        const artist = item.querySelector('p');
        
        return {
            id: item.dataset.trackId || '',
            name: title ? title.textContent : 'Unknown',
            artist: artist ? artist.textContent : 'Unknown',
            album_cover_url: img ? img.src : '',
            uri: item.dataset.trackUri || '',
            preview_url: ''
        };
    });
    
    currentPlaylist = playlistTracks;
    currentPlaylistIndex = trackIndex;
    currentPlaylistId = playlistId;
    
    const track = playlistTracks[trackIndex];
    if (track) {
        playTrack(track.uri, track, playlistTracks, trackIndex);
    }
}

async function removeFromPlaylist(playlistId, trackId) {
    try {
        const response = await fetch('/remove_local_playlist_track', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ playlist_id: playlistId, track_id: trackId })
        });

        if (response.ok) {
            fetchPlaylists();
        } else {
            throw new Error('Failed to remove track');
        }
    } catch (error) {
        console.error('Error removing track:', error);
        showError('Failed to remove track from playlist');
    }
}

// Navigation
function setupNavigation() {
    const showRecommendations = document.getElementById('show-recommendations');
    const showPlaylists = document.getElementById('show-playlists');
    const recommendationSection = document.getElementById('recommendation-section');
    const playlistsSection = document.getElementById('playlists-section');

    showRecommendations?.addEventListener('click', (e) => {
        e.preventDefault();
        recommendationSection?.classList.remove('d-none');
        playlistsSection?.classList.add('d-none');
        showRecommendations.classList.add('active');
        showPlaylists?.classList.remove('active');
    });

    showPlaylists?.addEventListener('click', (e) => {
        e.preventDefault();
        recommendationSection?.classList.add('d-none');
        playlistsSection?.classList.remove('d-none');
        showPlaylists.classList.add('active');
        showRecommendations?.classList.remove('active');
        fetchPlaylists();
    });
}

// Player controls
function setupPlayerControls() {
    const playButton = document.getElementById('mini-player-play');
    const prevButton = document.getElementById('mini-player-previous');
    const nextButton = document.getElementById('mini-player-next');
    const shuffleButton = document.getElementById('mini-player-shuffle');
    const volumeSlider = document.getElementById('volume-slider');
    const seekSlider = document.getElementById('seek-slider');
    const closeButton = document.getElementById('mini-player-close');

    playButton?.addEventListener('click', () => {
        if (spotifyPlayer) {
            spotifyPlayer.togglePlay();
        } else if (audioPreview) {
            if (audioPreview.paused) {
                audioPreview.play();
                playButton.innerHTML = '<i class="bi bi-pause-fill"></i>';
            } else {
                audioPreview.pause();
                playButton.innerHTML = '<i class="bi bi-play-fill"></i>';
            }
        }
    });

    prevButton?.addEventListener('click', () => playPreviousInPlaylist());
    nextButton?.addEventListener('click', () => playNextInPlaylist());

    shuffleButton?.addEventListener('click', () => {
        isShuffling = !isShuffling;
        shuffleButton.classList.toggle('btn-success', isShuffling);
        shuffleButton.classList.toggle('btn-outline-light', !isShuffling);
        console.log('Shuffle mode:', isShuffling ? 'ON' : 'OFF');
    });

    volumeSlider?.addEventListener('input', (e) => {
        const volume = parseFloat(e.target.value);
        if (spotifyPlayer) {
            spotifyPlayer.setVolume(volume);
        } else if (audioPreview) {
            audioPreview.volume = volume;
        }
    });

    seekSlider?.addEventListener('input', (e) => {
        const position = parseInt(e.target.value);
        if (spotifyPlayer) {
            spotifyPlayer.seek(position);
        } else if (audioPreview) {
            audioPreview.currentTime = position / 1000;
        }
    });

    closeButton?.addEventListener('click', () => {
        if (spotifyPlayer) spotifyPlayer.pause();
        if (audioPreview) {
            audioPreview.pause();
            audioPreview = null;
        }
        showMiniPlayer(false);
    });
}

// Welcome screen functions (global scope)
window.selectUserMode = function(mode) {
    userSelectedMode = mode;
    localStorage.setItem('selectedUserMode', mode);
    
    document.getElementById('step-indicator').textContent = '2';
    document.getElementById('step-1').classList.add('d-none');
    document.getElementById('step-2').classList.remove('d-none');
    
    const modeInfo = document.getElementById('selected-mode-info');
    if (mode === 'premium') {
        modeInfo.className = 'alert alert-success mb-4';
        modeInfo.innerHTML = `
            <h5><i class="bi bi-music-note-beamed"></i> Premium Experience Selected</h5>
            <p class="mb-0">Full song playback and advanced features. Requires Spotify Premium.</p>
        `;
    } else {
        modeInfo.className = 'alert alert-info mb-4';
        modeInfo.innerHTML = `
            <h5><i class="bi bi-headphones"></i> Preview Mode Selected</h5>
            <p class="mb-0">30-second previews and basic features. Works with any account.</p>
        `;
    }
};

window.goBackToStep1 = function() {
    document.getElementById('step-indicator').textContent = '1';
    document.getElementById('step-2').classList.add('d-none');
    document.getElementById('step-1').classList.remove('d-none');
};

window.logoutUser = function() {
    if (confirm('Are you sure you want to logout?')) {
        localStorage.clear();
        sessionStorage.clear();
        window.location.href = '/logout';
    }
};

// Load Spotify SDK for premium users
window.loadSpotifySDK = function() {
    if (userSelectedMode === 'premium') {
        console.log('Loading Spotify SDK for Premium user...');
        loadSpotifySDK().then(() => {
            console.log('Spotify SDK loaded successfully');
        }).catch(error => {
            console.error('Failed to load Spotify SDK:', error);
            showError('Failed to load Spotify Player. Using preview mode.');
        });
    }
};

function showWelcomeScreen() {
    document.getElementById('welcome-screen')?.classList.remove('d-none');
    document.getElementById('main-app')?.classList.add('d-none');
}

function showMainApp() {
    document.getElementById('welcome-screen')?.classList.add('d-none');
    document.getElementById('main-app')?.classList.remove('d-none');
}

// Initialize app
async function initializeApp() {
    console.log('Initializing Music Recommender App...');
    
    await initializeConfig();
    
    const isLoggedIn = await checkUserLoginStatus();
    
    if (isLoggedIn) {
        console.log('User already logged in - checking for selected mode...');
        
        const urlParams = new URLSearchParams(window.location.search);
        const storedMode = localStorage.getItem('selectedUserMode');
        
        if (urlParams.get('mode')) {
            userSelectedMode = urlParams.get('mode');
            localStorage.setItem('selectedUserMode', userSelectedMode);
        } else if (storedMode) {
            userSelectedMode = storedMode;
        }
        
        if (userSelectedMode) {
            console.log('User mode:', userSelectedMode);
            showMainApp();
            updateUserInfoDisplay();
            
            // Load Spotify SDK for premium users
            if (userSelectedMode === 'premium') {
                console.log('Loading Spotify SDK for premium user...');
                try {
                    await loadSpotifySDK();
                    // SDK will initialize when ready via onSpotifyWebPlaybackSDKReady
                } catch (error) {
                    console.error('Failed to load Spotify SDK:', error);
                    showError('Failed to load Spotify Player. Using preview mode.');
                }
            }
        } else {
            showWelcomeScreen();
        }
    } else {
        showWelcomeScreen();
    }
}

function checkForLoginReturn() {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('logged_in') === 'true') {
        const welcomeScreen = document.getElementById('welcome-screen');
        if (!welcomeScreen?.classList.contains('d-none')) {
            document.getElementById('step-indicator').textContent = '3';
            document.getElementById('step-2')?.classList.add('d-none');
            document.getElementById('step-3')?.classList.remove('d-none');
            
            setTimeout(async () => {
                await checkUserLoginStatus();
                showMainApp();
                updateUserInfoDisplay();
                
                if (userSelectedMode === 'premium') {
                    try {
                        await loadSpotifySDK();
                    } catch (error) {
                        console.error('Failed to load Spotify SDK:', error);
                    }
                }
            }, 2000);
        }
        
        window.history.replaceState({}, document.title, window.location.pathname);
    }
}

// DOM Content Loaded
document.addEventListener('DOMContentLoaded', async () => {
    console.log('DOM Content Loaded');
    
    checkForLoginReturn();
    await initializeApp();
    
    setupNavigation();
    setupPlayerControls();
    
    // Form submission
    const form = document.getElementById('recommend-form');
    form?.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const trackInput = document.getElementById('track-name');
        const artistInput = document.getElementById('artist-name');
        
        const trackName = trackInput?.value.trim();
        const artistName = artistInput?.value.trim();
        
        if (!trackName || !artistName) {
            showError('Please enter both track and artist names');
            return;
        }
        
        currentSeedTrackName = trackName;
        currentSeedArtistName = artistName;
        
        await getRecommendations(trackName, artistName);
    });
    
    // Reset bandit button
    const resetButton = document.getElementById('reset-bandit-btn');
    resetButton?.addEventListener('click', async () => {
        try {
            const response = await fetch('/reset_bandit', { method: 'POST' });
            if (response.ok) {
                showSuccessMessage('Algorithm scores reset successfully!');
                document.getElementById('results').innerHTML = '';
            } else {
                throw new Error('Failed to reset scores');
            }
        } catch (error) {
            console.error('Error resetting bandit:', error);
            showError('Failed to reset algorithm scores');
        }
    });
});
