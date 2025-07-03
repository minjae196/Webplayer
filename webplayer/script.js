// Get configuration from backend
let CONFIG = {
    spotify_client_id: 'd28df89507ca47bebaa9385ebb546e92',  // Will be overridden by backend config
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

let togglePlayButton, previousTrackButton, nextTrackButton, volumeSlider, seekSlider, spotifyPlayerBar;
let audioPreview;
let accessToken = null;

let currentPlaylist = [];
let currentPlaylistIndex = -1;
let currentPlaylistId = null;
let isShuffling = false;
let userSelectedMode = null; // 'premium' or 'general'
let currentUser = null; // Store user info

// Initialize configuration from backend
async function initializeConfig() {
    try {
        const response = await fetch('/config');
        if (response.ok) {
            const backendConfig = await response.json();
            CONFIG = { ...CONFIG, ...backendConfig };
            console.log('Configuration loaded from backend:', CONFIG);
        } else {
            console.warn('Failed to load backend configuration, using defaults');
        }
    } catch (error) {
        console.error('Error loading configuration:', error);
        console.warn('Using default configuration');
    }
}

// Helper function to format time
function formatTime(ms) {
    const minutes = Math.floor(ms / 60000);
    const seconds = ((ms % 60000) / 1000).toFixed(0);
    return minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
}

// Define this function at the global scope for Spotify SDK
window.onSpotifyWebPlaybackSDKReady = () => {
    console.log('Spotify Web Playback SDK is ready!');
    
    if (userSelectedMode !== 'premium') {
        console.log('General user mode - Spotify Player not needed');
        return;
    }
    
    const token = localStorage.getItem('spotify_access_token');
    if (!token) {
        console.warn('Spotify access token not found in localStorage. Player will not initialize.');
        return;
    }

    spotifyPlayer = new Spotify.Player({
        name: 'Music Recommender Player',
        getOAuthToken: async cb => {
            try {
                const response = await fetch('/spotify_sdk_token');
                if (!response.ok) {
                    throw new Error('Failed to get fresh Spotify SDK token.');
                }
                const data = await response.json();
                cb(data.access_token);
            } catch (error) {
                console.error('Error getting fresh Spotify SDK token:', error);
                cb('');
            }
        },
        volume: 0.5
    });

    spotifyPlayer.connect();

    spotifyPlayer.addListener('ready', ({ device_id }) => {
        console.log('Ready with Device ID', device_id);
        activeDeviceId = device_id;
        togglePlayerControls(true);
        const miniPlayerBar = document.getElementById('mini-player-bar');
        if (miniPlayerBar) {
            miniPlayerBar.classList.remove('d-none');
        }
    });

    spotifyPlayer.addListener('not_ready', ({ device_id }) => {
        console.log('Device ID has gone offline', device_id);
        togglePlayerControls(false);
        const miniPlayerBar = document.getElementById('mini-player-bar');
        if (miniPlayerBar) {
            miniPlayerBar.classList.add('d-none');
        }
    });

    spotifyPlayer.addListener('player_state_changed', (state) => {
        if (!state) return;

        if (playbackUpdateInterval) {
            clearInterval(playbackUpdateInterval);
        }

        const { current_track: track } = state.track_window;
        if (track) {
            updateMiniPlayerDisplay(track, state);
            
            if (!state.paused && state.position >= state.duration - 1000 && currentPlaylist.length > 0) {
                if (isShuffling) {
                    playRandomTrackInPlaylist();
                } else {
                    playNextTrackInPlaylist();
                }
            }
        } else {
            const miniPlayerBar = document.getElementById('mini-player-bar');
            if (miniPlayerBar) {
                miniPlayerBar.classList.add('d-none');
            }
        }
    });

    // Add seek slider event listener
    const seekSlider = document.getElementById('mini-player-seek-slider');
    if (seekSlider) {
        seekSlider.addEventListener('input', (event) => {
            if (userSelectedMode === 'premium' && spotifyPlayer) {
                spotifyPlayer.seek(Number(event.target.value));
            } else if (audioPreview) {
                audioPreview.currentTime = Number(event.target.value) / 1000;
            }
        });
    }
};

// Update mini player display
function updateMiniPlayerDisplay(track, state) {
    const albumArt = document.getElementById('mini-player-album-art');
    const trackName = document.getElementById('mini-player-track-name');
    const artistName = document.getElementById('mini-player-artist-name');
    const miniPlayerBar = document.getElementById('mini-player-bar');
    const togglePlay = document.getElementById('mini-player-toggle-play');

    if (albumArt) albumArt.src = track.album.images[0].url;
    if (trackName) trackName.textContent = track.name;
    if (artistName) artistName.textContent = track.artists.map(artist => artist.name).join(', ');
    if (miniPlayerBar) miniPlayerBar.classList.remove('d-none');
    if (togglePlay) togglePlay.innerHTML = state.paused ? '<i class="bi bi-play-fill"></i>' : '<i class="bi bi-pause-fill"></i>';

    const duration = state.duration;
    const seekSlider = document.getElementById('mini-player-seek-slider');
    const totalTime = document.getElementById('mini-player-total-time');
    
    if (seekSlider) seekSlider.max = duration;
    if (totalTime) totalTime.textContent = formatTime(duration);

    const updateSeekSlider = (position) => {
        if (seekSlider) {
            seekSlider.value = position;
            const percentage = (position / duration) * 100;
            seekSlider.style.setProperty('--seek-progress', `${percentage}%`);
        }
        const currentTime = document.getElementById('mini-player-current-time');
        if (currentTime) currentTime.textContent = formatTime(position);
    };

    if (!state.paused) {
        playbackUpdateInterval = setInterval(() => {
            spotifyPlayer.getCurrentState().then(state => {
                if (state) {
                    updateSeekSlider(state.position);
                } else {
                    clearInterval(playbackUpdateInterval);
                }
            });
        }, 100);
    } else {
        updateSeekSlider(state.position);
    }

    // Dynamic background based on album art
    if (albumArt && window.ColorThief) {
        const colorThief = new ColorThief();
        albumArt.onload = function() {
            try {
                const dominantColor = colorThief.getColor(albumArt);
                const rgbColor = `rgb(${dominantColor[0]}, ${dominantColor[1]}, ${dominantColor[2]})`;
                if (miniPlayerBar) {
                    miniPlayerBar.style.backgroundColor = rgbColor;
                }
            } catch (e) {
                console.error("Error getting dominant color:", e);
                if (miniPlayerBar) {
                    miniPlayerBar.style.backgroundColor = '#282828';
                }
            }
        };
        if (albumArt.complete) {
            albumArt.onload();
        }
    }
}

// Play track function
async function playTrack(trackUri, playlist = [], startIndex = -1, previewUrl = null) {
    if (userSelectedMode === 'premium' && currentUser?.product === 'premium') {
        if (!spotifyPlayer) {
            alert('Spotify Player not ready. Please log in to Spotify.');
            return;
        }

        currentTrackUri = trackUri;
        currentPlaylist = playlist;
        currentPlaylistIndex = startIndex;

        if (!trackUri || !trackUri.startsWith('spotify:track:')) {
            console.error('Invalid track URI provided:', trackUri);
            alert('Error: Invalid track URI. Cannot play this track.');
            return;
        }

        try {
            const tokenResponse = await fetch('/spotify_sdk_token');
            if (!tokenResponse.ok) {
                throw new Error('Failed to get Spotify SDK token for playback.');
            }
            const tokenData = await tokenResponse.json();
            const accessToken = tokenData.access_token;

            const response = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${activeDeviceId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken}`
                },
                body: JSON.stringify({
                    uris: [trackUri]
                })
            });

            if (!response.ok) {
                const errorData = await response.json();
                console.error('Failed to play track:', errorData);
                alert('Failed to play track. Make sure Spotify is open and you are logged in with a Premium account.');
            } else {
                updatePlaylistVisualFeedback();
            }
        } catch (error) {
            console.error('Error playing track:', error);
            alert('Error playing track. Check console for details.');
        }
    } else {
        // Preview mode for general users or free accounts
        currentPlaylist = playlist;
        currentPlaylistIndex = startIndex;
        
        if (audioPreview && audioPreview.src === previewUrl && !audioPreview.paused) {
            audioPreview.pause();
            const togglePlay = document.getElementById('mini-player-toggle-play');
            if (togglePlay) togglePlay.innerHTML = '<i class="bi bi-play-fill"></i>';
        } else if (previewUrl) {
            playPreviewTrack(previewUrl, playlist, startIndex);
        } else {
            alert('No preview available for this track.');
        }
    }
}

// Play preview track
function playPreviewTrack(previewUrl, playlist, startIndex) {
    if (audioPreview) {
        audioPreview.src = previewUrl;
        audioPreview.play();
        
        const togglePlay = document.getElementById('mini-player-toggle-play');
        if (togglePlay) togglePlay.innerHTML = '<i class="bi bi-pause-fill"></i>';
        
        const miniPlayerBar = document.getElementById('mini-player-bar');
        if (miniPlayerBar) miniPlayerBar.classList.remove('d-none');
        
        const track = playlist[startIndex];
        if (track) {
            updatePreviewPlayerDisplay(track);
        }
        
        updatePlaylistVisualFeedback();
    }
}

// Update preview player display
function updatePreviewPlayerDisplay(track) {
    const albumArt = document.getElementById('mini-player-album-art');
    const trackName = document.getElementById('mini-player-track-name');
    const artistName = document.getElementById('mini-player-artist-name');
    const seekSlider = document.getElementById('mini-player-seek-slider');
    const totalTime = document.getElementById('mini-player-total-time');

    if (albumArt) albumArt.src = track.album_cover_url;
    if (trackName) trackName.textContent = track.name;
    if (artistName) artistName.textContent = track.artist;
    
    audioPreview.onloadedmetadata = () => {
        if (seekSlider) seekSlider.max = audioPreview.duration * 1000;
        if (totalTime) totalTime.textContent = formatTime(audioPreview.duration * 1000);
    };

    if (playbackUpdateInterval) {
        clearInterval(playbackUpdateInterval);
    }
    
    playbackUpdateInterval = setInterval(() => {
        if (seekSlider) seekSlider.value = audioPreview.currentTime * 1000;
        const currentTime = document.getElementById('mini-player-current-time');
        if (currentTime) currentTime.textContent = formatTime(audioPreview.currentTime * 1000);
        const percentage = (audioPreview.currentTime / audioPreview.duration) * 100;
        if (seekSlider) seekSlider.style.setProperty('--seek-progress', `${percentage}%`);
    }, 100);

    audioPreview.onended = () => {
        clearInterval(playbackUpdateInterval);
        const togglePlay = document.getElementById('mini-player-toggle-play');
        if (togglePlay) togglePlay.innerHTML = '<i class="bi bi-play-fill"></i>';
        
        if (currentPlaylist.length > 0 && currentPlaylistIndex < currentPlaylist.length - 1) {
            playNextTrackInPlaylist();
        } else {
            const miniPlayerBar = document.getElementById('mini-player-bar');
            if (miniPlayerBar) miniPlayerBar.classList.add('d-none');
        }
    };
}

// Playlist navigation functions
function playNextTrackInPlaylist() {
    if (currentPlaylist.length === 0) return;

    if (isShuffling) {
        playRandomTrackInPlaylist();
        return;
    }

    currentPlaylistIndex++;
    if (currentPlaylistIndex >= currentPlaylist.length) {
        currentPlaylistIndex = 0;
    }
    const nextTrack = currentPlaylist[currentPlaylistIndex];
    playTrack(nextTrack.uri, currentPlaylist, currentPlaylistIndex, nextTrack.preview_url);
    updatePlaylistVisualFeedback();
}

function playPreviousTrackInPlaylist() {
    if (currentPlaylist.length === 0) return;

    if (isShuffling) {
        playRandomTrackInPlaylist();
        return;
    }

    currentPlaylistIndex--;
    if (currentPlaylistIndex < 0) {
        currentPlaylistIndex = currentPlaylist.length - 1;
    }
    const prevTrack = currentPlaylist[currentPlaylistIndex];
    playTrack(prevTrack.uri, currentPlaylist, currentPlaylistIndex, prevTrack.preview_url);
    updatePlaylistVisualFeedback();
}

function playRandomTrackInPlaylist() {
    if (currentPlaylist.length === 0) return;
    const randomIndex = Math.floor(Math.random() * currentPlaylist.length);
    currentPlaylistIndex = randomIndex;
    const randomTrack = currentPlaylist[randomIndex];
    playTrack(randomTrack.uri, currentPlaylist, currentPlaylistIndex, randomTrack.preview_url);
    updatePlaylistVisualFeedback();
}

// Update visual feedback in playlist
function updatePlaylistVisualFeedback() {
    if (currentPlaylistId === null) return;
    
    const playlistTabContent = document.getElementById(`playlist-${currentPlaylistId}`);
    if (playlistTabContent) {
        playlistTabContent.querySelectorAll('.playlist-track-item').forEach(item => {
            item.style.border = 'none';
            const playBtn = item.querySelector('.play-playlist-track-btn i');
            if (playBtn) playBtn.className = 'bi bi-play-fill';
        });
        
        const currentTrackItem = playlistTabContent.querySelectorAll('.playlist-track-item')[currentPlaylistIndex];
        if (currentTrackItem) {
            currentTrackItem.style.border = '2px solid #1DB954';
            const playBtn = currentTrackItem.querySelector('.play-playlist-track-btn i');
            if (playBtn) playBtn.className = 'bi bi-pause-fill';
        }
    }
}

// Check user login status
async function checkUserLoginStatus() {
    try {
        const response = await fetch('/spotify_sdk_token');
        if (response.ok) {
            const data = await response.json();
            accessToken = data.access_token;
            currentUser = {
                product: data.product_type || 'free'
            };
            
            localStorage.setItem('spotify_access_token', data.access_token);
            
            // Get user profile info
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
            }
            
            return true;
        } else {
            console.warn('User not logged in to Spotify');
            return false;
        }
    } catch (error) {
        console.error('Error checking user login:', error);
        return false;
    }
}

// Update user info display
function updateUserInfoDisplay() {
    if (!currentUser) return;
    
    const userAvatar = document.getElementById('user-avatar');
    const userName = document.getElementById('user-name');
    const userMode = document.getElementById('user-mode');
    
    if (userAvatar && currentUser.images && currentUser.images.length > 0) {
        userAvatar.src = currentUser.images[0].url;
        userAvatar.style.display = 'block';
    }
    
    if (userName) {
        userName.textContent = currentUser.display_name || currentUser.email || 'Spotify User';
    }
    
    if (userMode) {
        const modeText = userSelectedMode === 'premium' ? 'Premium Mode' : 'Preview Mode';
        const productText = currentUser.product === 'premium' ? 'Premium Account' : 'Free Account';
        userMode.textContent = `${modeText} • ${productText}`;
    }
    
    // Show product type info if needed
    const productInfo = document.getElementById('user-product-info');
    if (productInfo) {
        if (userSelectedMode === 'premium' && currentUser.product !== 'premium') {
            productInfo.innerHTML = `
                <strong>Notice:</strong> You selected Premium Mode but have a Spotify Free account. 
                You'll experience preview playback only. <a href="https://www.spotify.com/premium/" target="_blank">Upgrade to Premium</a> for full song playback.
            `;
            productInfo.classList.remove('d-none');
            productInfo.className = 'alert alert-warning mb-4';
        } else if (userSelectedMode === 'premium' && currentUser.product === 'premium') {
            productInfo.innerHTML = `
                <strong>Great!</strong> You have Spotify Premium and selected Premium Mode. Enjoy full song playback!
            `;
            productInfo.classList.remove('d-none');
            productInfo.className = 'alert alert-success mb-4';
        } else {
            productInfo.classList.add('d-none');
        }
    }
}

// Helper function to toggle player controls
function togglePlayerControls(enable) {
    const controls = [
        'mini-player-toggle-play',
        'mini-player-previous', 
        'mini-player-next',
        'mini-player-volume-slider',
        'mini-player-seek-slider',
        'mini-player-shuffle'
    ];
    
    controls.forEach(id => {
        const element = document.getElementById(id);
        if (element) element.disabled = !enable;
    });
    
    if (!enable) {
        const spotifyPlayerBar = document.getElementById('mini-player-bar');
        if (spotifyPlayerBar) {
            spotifyPlayerBar.classList.add('d-none');
        }
    }
}

// Get new recommendation from pool
function getNewRecommendationFromPool() {
    if (recommendationPool.length > 0) {
        return recommendationPool.shift();
    }
    return null;
}

// Replace track card
async function replaceTrackCard(cardElement, newTrack) {
    try {
        const trackIndex = Array.from(cardElement.parentNode.children).indexOf(cardElement);
        if (trackIndex !== -1) {
            currentDisplayedRecommendations[trackIndex] = newTrack;
        }

        cardElement.style.transition = 'opacity 1.5s ease-out';
        cardElement.style.opacity = '0';

        setTimeout(() => {
            cardElement.innerHTML = createTrackCardHTML(newTrack);
            addTrackCardEventListeners(cardElement, trackIndex);
            cardElement.style.opacity = '1';
        }, 1500);

    } catch (error) {
        console.error('Error replacing track card:', error);
    }
}

// Create track card HTML
function createTrackCardHTML(track) {
    return `
        <div class="card h-100" role="button" data-track-uri="${track.uri}" data-track-id="${track.id}" data-preview-url="${track.preview_url || ''}">
            <img src="${track.album_cover_url}" class="card-img-top" alt="${track.name}">
            <div class="card-body">
                <h5 class="card-title text-truncate">${track.name}</h5>
                <p class="card-text text-truncate">${track.artist}</p>
                <div class="d-flex justify-content-between align-items-center mt-2">
                    <button class="btn btn-sm btn-outline-success feedback-btn" data-track-id="${track.id}" data-rating="0">Skip</button>
                    <div class="btn-group" role="group">
                        <button class="btn btn-sm btn-outline-success feedback-btn" data-track-id="${track.id}" data-rating="1">1</button>
                        <button class="btn btn-sm btn-outline-success feedback-btn" data-track-id="${track.id}" data-rating="2">2</button>
                        <button class="btn btn-sm btn-outline-success feedback-btn" data-track-id="${track.id}" data-rating="3">3</button>
                        <button class="btn btn-sm btn-outline-success feedback-btn" data-track-id="${track.id}" data-rating="4">4</button>
                        <button class="btn btn-sm btn-outline-success feedback-btn" data-track-id="${track.id}" data-rating="5">5</button>
                    </div>
                </div>
            </div>
        </div>
    `;
}

// Add event listeners to track card
function addTrackCardEventListeners(cardElement, trackIndex) {
    const newCard = cardElement.querySelector('.card[data-track-uri]');
    if (newCard) {
        newCard.addEventListener('click', (event) => {
            if (!event.target.closest('.feedback-btn')) {
                const trackUri = newCard.dataset.trackUri;
                const previewUrl = newCard.dataset.previewUrl;
                playTrack(trackUri, currentDisplayedRecommendations, trackIndex, previewUrl);
            }
        });
    }

    cardElement.querySelectorAll('.feedback-btn').forEach(button => {
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            const trackId = event.target.dataset.trackId;
            const rating = parseFloat(event.target.dataset.rating);
            sendFeedback(trackId, rating, event.target);
        });
    });
}

// Show error messages
function showError(message) {
    const errorMessage = document.getElementById('error-message');
    if (errorMessage) {
        errorMessage.textContent = message;
        errorMessage.classList.remove('d-none');
    }
}

// Fetch and display playlists
async function fetchAndDisplayPlaylists() {
    try {
        const response = await fetch('/playlists');
        if (!response.ok) {
            throw new Error('Failed to fetch playlists');
        }
        const playlists = await response.json();
        
        for (let i = 0; i <= 5; i++) {
            const tabButton = document.getElementById(`playlist-${i}-tab`);
            const tabContent = document.getElementById(`playlist-${i}`);
            
            if (tabButton && tabContent) {
                const tracks = playlists[i.toString()] || [];
                
                if (i === 0) {
                    tabButton.textContent = `Skipped (${tracks.length})`;
                } else {
                    tabButton.textContent = `Rating ${i} (${tracks.length})`;
                }
                
                if (tracks.length === 0) {
                    tabContent.innerHTML = '<p class="text-muted">No tracks in this playlist yet.</p>';
                } else {
                    tabContent.innerHTML = tracks.map((track, index) => {
                        return createPlaylistTrackHTML(track, i, index);
                    }).join('');
                }
            }
        }
    } catch (error) {
        console.error('Error fetching playlists:', error);
    }
}

// Create playlist track HTML
function createPlaylistTrackHTML(track, playlistId, index) {
    let trackName = track.name || 'Unknown Track';
    let artistName = track.artist || 'Unknown Artist';
    let albumCover = track.album_cover_url || 'https://via.placeholder.com/60x60?text=♪';
    let rating = track.rating || 0;
    let trackId = track.id || track;
    let trackUri = track.uri || '';
    let previewUrl = track.preview_url || '';
    
    if (typeof track === 'string') {
        trackName = track;
        artistName = 'Legacy Entry';
        albumCover = 'https://via.placeholder.com/60x60?text=♪';
        trackId = track;
        trackUri = '';
        previewUrl = '';
    }
    
    return `
        <div class="d-flex align-items-center mb-3 p-3 playlist-track-item" 
             style="background-color: #1a1a1a; border-radius: 8px; cursor: pointer; transition: all 0.2s;" 
             data-track-uri="${trackUri}" 
             data-track-id="${trackId}" 
             data-preview-url="${previewUrl}"
             data-track-name="${trackName}"
             data-artist-name="${artistName}"
             data-album-cover="${albumCover}"
             onmouseover="this.style.backgroundColor='#2a2a2a'" 
             onmouseout="this.style.backgroundColor='#1a1a1a'"
             onclick="playPlaylistItem('${playlistId}', ${index})">
            <div class="d-flex align-items-center me-3">
                <button class="btn btn-sm btn-success play-playlist-track-btn me-2" 
                        onclick="playPlaylistTrack(event, '${trackUri}', '${previewUrl}', '${trackName}', '${artistName}', '${albumCover}', '${playlistId}', ${index})"
                        title="Play track">
                    <i class="bi bi-play-fill"></i>
                </button>
                <img src="${albumCover}" alt="Album Art" class="rounded" style="width: 60px; height: 60px;">
            </div>
            <div class="flex-grow-1 ms-3">
                <div class="text-white fw-bold">${trackName}</div>
                <div class="text-muted">${artistName}</div>
                <div class="text-success small">Rating: ${rating}/5</div>
            </div>
            <div class="text-end">
                <button class="btn btn-sm btn-outline-danger" onclick="removeFromPlaylist('${playlistId}', '${trackId}'); event.stopPropagation();"
                        title="Remove from playlist">
                    <i class="bi bi-trash"></i>
                </button>
            </div>
        </div>
    `;
}

// Send feedback
async function sendFeedback(trackId, rating, buttonElement) {
    const card = buttonElement.closest('.col-md-4, .col-lg-3');
    if (!card) return;

    const trackCard = card.querySelector('.card[data-track-uri]');
    const trackName = card.querySelector('.card-title').textContent;
    const artistName = card.querySelector('.card-text').textContent;
    const albumCover = card.querySelector('.card-img-top').src;
    const trackUri = trackCard.dataset.trackUri;

    card.querySelectorAll('.feedback-btn').forEach(btn => btn.disabled = true);

    try {
        const response = await fetch('/feedback', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                track_id: trackId,
                rating: rating,
                seed_track_name: currentSeedTrackName,
                seed_artist_name: currentSeedArtistName,
                track_info: {
                    id: trackId,
                    name: trackName,
                    artist: artistName,
                    album_cover_url: albumCover,
                    uri: trackUri,
                    rating: rating
                }
            }),
        });

        if (!response.ok) {
            throw new Error('Failed to send feedback.');
        }

        console.log(`Feedback sent for ${trackId} with rating ${rating}`);

        const newTrack = getNewRecommendationFromPool();
        if (newTrack) {
            replaceTrackCard(card, newTrack);
        } else {
            card.style.transition = 'opacity 1.5s ease-out';
            card.style.opacity = '0';
            setTimeout(() => card.remove(), 1500);
            console.log('Recommendation pool is empty. No more tracks to display.');
        }
        
        fetchAndDisplayPlaylists();

    } catch (error) {
        console.error('Error sending feedback or replacing card:', error);
        card.querySelectorAll('.feedback-btn').forEach(btn => btn.disabled = false);
    }
}

// Display recommendations
function displayRecommendations(tracks) {
    if (!tracks || tracks.length === 0) {
        showError('No recommendations found for this user.');
        return;
    }

    currentDisplayedRecommendations = tracks.slice(0, 12);
    recommendationPool = tracks.slice(12);

    const resultsContainer = document.getElementById('results');
    if (resultsContainer) {
        resultsContainer.innerHTML = '';

        currentDisplayedRecommendations.forEach((track, index) => {
            const trackCard = `
                <div class="col-md-4 col-lg-3">
                    ${createTrackCardHTML(track)}
                </div>
            `;
            resultsContainer.innerHTML += trackCard;
        });

        // Add event listeners to all cards
        document.querySelectorAll('.card[data-track-uri]').forEach((card, index) => {
            card.addEventListener('click', (event) => {
                if (!event.target.closest('.feedback-btn')) {
                    const trackUri = card.dataset.trackUri;
                    const previewUrl = card.dataset.previewUrl;
                    playTrack(trackUri, currentDisplayedRecommendations, index, previewUrl);
                }
            });
        });

        document.querySelectorAll('.feedback-btn').forEach(button => {
            button.addEventListener('click', (event) => {
                event.stopPropagation();
                const trackId = event.target.dataset.trackId;
                const rating = parseFloat(event.target.dataset.rating);
                sendFeedback(trackId, rating, event.target);
            });
        });
    }
}

// Playlist functions
function playPlaylistTrack(event, trackUri, previewUrl, trackName, artistName, albumCover, playlistId, trackIndex) {
    event.stopPropagation();
    
    const playlistTabContent = document.getElementById(`playlist-${playlistId}`);
    if (playlistTabContent) {
        const trackItems = playlistTabContent.querySelectorAll('.playlist-track-item');
        currentPlaylist = Array.from(trackItems).map(item => ({
            id: item.dataset.trackId,
            name: item.dataset.trackName,
            artist: item.dataset.artistName,
            album_cover_url: item.dataset.albumCover,
            uri: item.dataset.trackUri,
            preview_url: item.dataset.previewUrl
        }));
        currentPlaylistIndex = trackIndex;
        currentPlaylistId = playlistId;
    }
    
    playTrack(trackUri, currentPlaylist, trackIndex, previewUrl);
}

function playPlaylistItem(playlistId, trackIndex) {
    const playlistTabContent = document.getElementById(`playlist-${playlistId}`);
    if (playlistTabContent) {
        const trackItems = playlistTabContent.querySelectorAll('.playlist-track-item');
        currentPlaylist = Array.from(trackItems).map(item => ({
            id: item.dataset.trackId,
            name: item.dataset.trackName,
            artist: item.dataset.artistName,
            album_cover_url: item.dataset.albumCover,
            uri: item.dataset.trackUri,
            preview_url: item.dataset.previewUrl
        }));
        currentPlaylistIndex = trackIndex;
        currentPlaylistId = playlistId;
        
        const currentTrack = currentPlaylist[trackIndex];
        if (currentTrack) {
            playTrack(currentTrack.uri, currentPlaylist, trackIndex, currentTrack.preview_url);
        }
    }
}

async function removeFromPlaylist(playlistId, trackId) {
    try {
        const response = await fetch('/remove_local_playlist_track', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                playlist_id: playlistId,
                track_id: trackId
            }),
        });

        if (response.ok) {
            fetchAndDisplayPlaylists();
        } else {
            console.error('Failed to remove track from playlist');
        }
    } catch (error) {
        console.error('Error removing track from playlist:', error);
    }
}

// Initialize app
async function initializeApp() {
    console.log('Initializing Music Recommender App...');
    
    // Load configuration first
    await initializeConfig();
    
    // Check if user is already logged in
    const isLoggedIn = await checkUserLoginStatus();
    
    if (isLoggedIn) {
        console.log('User already logged in - checking for selected mode...');
        
        // Check if we have a selected mode in URL params or localStorage
        const urlParams = new URLSearchParams(window.location.search);
        const storedMode = localStorage.getItem('selectedUserMode');
        
        if (urlParams.get('mode')) {
            userSelectedMode = urlParams.get('mode');
            localStorage.setItem('selectedUserMode', userSelectedMode);
        } else if (storedMode) {
            userSelectedMode = storedMode;
        }
        
        if (userSelectedMode) {
            // User is logged in and has selected a mode
            showMainApp();
            updateUserInfoDisplay();
            
            if (userSelectedMode === 'premium') {
                window.loadSpotifySDK();
            }
        } else {
            // User is logged in but needs to select mode
            showWelcomeScreen();
        }
    } else {
        // User not logged in
        showWelcomeScreen();
    }
}

function showWelcomeScreen() {
    document.getElementById('welcome-screen').classList.remove('d-none');
    document.getElementById('main-app').classList.add('d-none');
}

function showMainApp() {
    document.getElementById('welcome-screen').classList.add('d-none');
    document.getElementById('main-app').classList.remove('d-none');
}

// Handle mode selection from welcome screen
window.selectUserMode = function(mode) {
    userSelectedMode = mode;
    localStorage.setItem('selectedUserMode', mode);
    
    // Update step indicator
    document.getElementById('step-indicator').textContent = '2';
    
    // Hide step 1, show step 2
    document.getElementById('step-1').classList.add('d-none');
    document.getElementById('step-2').classList.remove('d-none');
    
    // Update selected mode info
    const modeInfo = document.getElementById('selected-mode-info');
    if (mode === 'premium') {
        modeInfo.innerHTML = `
            <h5><i class="bi bi-music-note-beamed text-success"></i> Premium Experience Selected</h5>
            <p class="mb-0">You'll get full song playback and advanced features. Requires Spotify Premium account.</p>
        `;
    } else {
        modeInfo.innerHTML = `
            <h5><i class="bi bi-headphones text-info"></i> Preview Mode Selected</h5>
            <p class="mb-0">You'll get 30-second previews and basic features. Works with any Spotify account.</p>
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

// Redirect to Spotify login with proper configuration
function redirectToSpotifyLogin() {
    const authUrl = `https://accounts.spotify.com/authorize?client_id=${CONFIG.spotify_client_id}&response_type=code&redirect_uri=${encodeURIComponent(CONFIG.redirect_uri)}&scope=${encodeURIComponent(CONFIG.scopes)}`;
    window.location.href = authUrl;
}

// Check if returning from Spotify login
function checkForLoginReturn() {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('logged_in') === 'true') {
        // User just logged in, show loading and then main app
        const welcomeScreen = document.getElementById('welcome-screen');
        if (!welcomeScreen.classList.contains('d-none')) {
            document.getElementById('step-indicator').textContent = '3';
            document.getElementById('step-2').classList.add('d-none');
            document.getElementById('step-3').classList.remove('d-none');
            
            setTimeout(async () => {
                await checkUserLoginStatus();
                showMainApp();
                updateUserInfoDisplay();
                
                if (userSelectedMode === 'premium') {
                    window.loadSpotifySDK();
                }
            }, 2000);
        }
        
        // Clean up URL
        window.history.replaceState({}, document.title, window.location.pathname);
    }
}

// DOM Content Loaded
document.addEventListener('DOMContentLoaded', async () => {
    console.log('DOM Content Loaded');
    
    // Initialize global variables
    audioPreview = new Audio();
    
    // Get UI elements
    spotifyPlayerBar = document.getElementById('mini-player-bar');
    togglePlayButton = document.getElementById('mini-player-toggle-play');
    previousTrackButton = document.getElementById('mini-player-previous');
    nextTrackButton = document.getElementById('mini-player-next');
    volumeSlider = document.getElementById('mini-player-volume-slider');
    seekSlider = document.getElementById('mini-player-seek-slider');
    
    // Check for login return first
    checkForLoginReturn();
    
    // Initialize app
    await initializeApp();
    
    // Set up event listeners
    setupEventListeners();
});

function setupEventListeners() {
    // Player controls
    if (togglePlayButton) {
        togglePlayButton.addEventListener('click', () => {
            if (userSelectedMode === 'premium' && currentUser?.product === 'premium' && spotifyPlayer) {
                spotifyPlayer.togglePlay();
            } else if (audioPreview) {
                if (audioPreview.paused) {
                    audioPreview.play();
                    togglePlayButton.innerHTML = '<i class="bi bi-pause-fill"></i>';
                } else {
                    audioPreview.pause();
                    togglePlayButton.innerHTML = '<i class="bi bi-play-fill"></i>';
                }
            }
        });
    }

    if (previousTrackButton) {
        previousTrackButton.addEventListener('click', () => {
            playPreviousTrackInPlaylist();
        });
    }

    if (nextTrackButton) {
        nextTrackButton.addEventListener('click', () => {
            playNextTrackInPlaylist();
        });
    }

    const shuffleButton = document.getElementById('mini-player-shuffle');
    if (shuffleButton) {
        shuffleButton.addEventListener('click', () => {
            isShuffling = !isShuffling;
            shuffleButton.classList.toggle('active', isShuffling);
            console.log('Shuffle mode:', isShuffling);
        });
    }

    // Navigation
    const showRecommendationsBtn = document.getElementById('show-recommendations');
    const showPlaylistsBtn = document.getElementById('show-playlists');
    const recommendationSection = document.getElementById('recommendation-section');
    const playlistsSection = document.getElementById('playlists-section');

    if (showRecommendationsBtn) {
        showRecommendationsBtn.addEventListener('click', (e) => {
            e.preventDefault();
            recommendationSection.classList.remove('d-none');
            playlistsSection.classList.add('d-none');
            showRecommendationsBtn.classList.add('active');
            showPlaylistsBtn.classList.remove('active');
        });
    }

    if (showPlaylistsBtn) {
        showPlaylistsBtn.addEventListener('click', (e) => {
            e.preventDefault();
            recommendationSection.classList.add('d-none');
            playlistsSection.classList.remove('d-none');
            showRecommendationsBtn.classList.remove('active');
            showPlaylistsBtn.classList.add('active');
            fetchAndDisplayPlaylists();
        });
    }

    // Reset bandit button
    const resetBanditButton = document.getElementById('reset-bandit-btn');
    if (resetBanditButton) {
        resetBanditButton.addEventListener('click', async () => {
            try {
                const response = await fetch('/reset_bandit', { method: 'POST' });
                if (response.ok) {
                    alert('Bandit scores have been reset!');
                } else {
                    throw new Error('Failed to reset bandit scores');
                }
            } catch (error) {
                console.error('Error resetting bandit:', error);
                alert('Error resetting bandit scores');
            }
        });
    }

    // Form submission
    const form = document.getElementById('recommend-form');
    const trackInput = document.getElementById('track-name');
    const artistInput = document.getElementById('artist-name');
    const resultsContainer = document.getElementById('results');
    const loader = document.getElementById('loader');
    const errorMessage = document.getElementById('error-message');

    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!trackInput || !artistInput) return;
            
            const trackName = trackInput.value.trim();
            const artistName = artistInput.value.trim();
            if (!trackName || !artistName) return;

            console.log(`Requesting recommendations for: ${trackName} - ${artistName}`);

            currentSeedTrackName = trackName;
            currentSeedArtistName = artistName;

            if (resultsContainer) resultsContainer.innerHTML = '';
            if (errorMessage) errorMessage.classList.add('d-none');
            if (loader) loader.classList.remove('d-none');

            try {
                const response = await fetch('/recommendations', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        track_name: trackName,
                        artist_name: artistName,
                        num_recommendations: 16
                    }),
                });

                console.log('Received response from server:', response.status, response.statusText);

                if (!response.ok) {
                    const errorData = await response.json();
                    throw new Error(errorData.detail || 'Failed to get recommendations.');
                }

                const data = await response.json();
                console.log('Parsed data:', data);

                displayRecommendations(data.recommendations);

            } catch (error) {
                console.error('An error occurred:', error);
                showError(error.message);
            } finally {
                if (loader) loader.classList.add('d-none');
            }
        });
    }

    // Volume slider
    if (volumeSlider) {
        volumeSlider.addEventListener('input', (event) => {
            const volume = event.target.value;
            if (userSelectedMode === 'premium' && currentUser?.product === 'premium' && spotifyPlayer) {
                spotifyPlayer.setVolume(volume);
            } else if (audioPreview) {
                audioPreview.volume = volume;
            }
            const percentage = volume * 100;
            volumeSlider.style.setProperty('--volume-progress', `${percentage}%`);
        });
    }

    // Mini player close button
    const closeBtn = document.getElementById('mini-player-close');
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            if (spotifyPlayer) {
                spotifyPlayer.pause();
            }
            if (audioPreview) {
                audioPreview.pause();
            }
            const miniPlayerBar = document.getElementById('mini-player-bar');
            if (miniPlayerBar) {
                miniPlayerBar.classList.add('d-none');
            }
            currentTrackUri = null;
        });
    }
}
