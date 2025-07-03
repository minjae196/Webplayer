const client_id = 'd28df89507ca47bebaa9385ebb546e92';  // Replace this
const redirect_uri = 'http://localhost:8000/callback'; // Ensure this matches your Flask app's redirect URI
const scopes = 'streaming user-read-email user-read-private user-modify-playback-state user-read-playback-state';

let spotifyPlayer = null;
let currentTrackUri = null;
let activeDeviceId = null;
let playbackUpdateInterval = null;
let currentDisplayedRecommendations = []; // Stores the 12 currently displayed tracks
let recommendationPool = []; // Stores additional tracks for replacement
let currentSeedTrackName = ''; // To store the seed track name for feedback
let currentSeedArtistName = ''; // To store the seed artist name for feedback

let togglePlayButton, previousTrackButton, nextTrackButton, volumeSlider, seekSlider, spotifyPlayerBar;
let audioPreview; // Declare audioPreview globally
let accessToken = null; // Declare accessToken globally

let currentPlaylist = []; // Stores the currently active playlist for playback
let currentPlaylistIndex = -1; // Current index in the playlist
let currentPlaylistId = null; // Current playlist ID being played
let isShuffling = false; // Flag for shuffle mode
let isPremiumUser = false; // Flag for premium user status

// Helper function to format time
function formatTime(ms) {
    const minutes = Math.floor(ms / 60000);
    const seconds = ((ms % 60000) / 1000).toFixed(0);
    return minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
}

// Define this function at the global scope for Spotify SDK
window.onSpotifyWebPlaybackSDKReady = () => {
    console.log('Spotify Web Playback SDK is ready!');
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
                cb(''); // Pass empty token to indicate failure
            }
        },
        volume: 0.5
    });

    // Connect to the player!
    spotifyPlayer.connect();

    spotifyPlayer.addListener('ready', ({ device_id }) => {
        console.log('Ready with Device ID', device_id);
        activeDeviceId = device_id; // Store the device ID
        // Now that the player is ready, enable controls and show player bar
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
        if (!state) {
            return;
        }

        // Clear previous interval if any
        if (playbackUpdateInterval) {
            clearInterval(playbackUpdateInterval);
        }

        const { current_track: track } = state.track_window;
        if (track) {
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
            
            if (seekSlider) seekSlider.max = duration; // Set max to track duration
            if (totalTime) totalTime.textContent = formatTime(duration);

            // Update seek slider and time displays continuously if playing
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
                }, 100); // Update every 0.1 second
            } else {
                // If paused, just update once
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
                            miniPlayerBar.style.backgroundColor = '#282828'; // Fallback
                        }
                    }
                };
                // If image is already loaded (e.g., from cache), trigger onload manually
                if (albumArt.complete) {
                    albumArt.onload();
                }
            }

            // Auto-play next track in playlist if not shuffling and not last track
            if (!state.paused && state.position >= state.duration - 1000 && currentPlaylist.length > 0) { // 1 second before end
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

    // Seek slider event listener
    const seekSlider = document.getElementById('mini-player-seek-slider');
    if (seekSlider) {
        seekSlider.addEventListener('input', (event) => {
            if (isPremiumUser) {
                if (spotifyPlayer) {
                    spotifyPlayer.seek(Number(event.target.value));
                }
            } else {
                if (audioPreview) {
                    audioPreview.currentTime = Number(event.target.value) / 1000; // Convert ms to seconds
                }
            }
        });
    }

    const previousBtn = document.getElementById('mini-player-previous');
    if (previousBtn) {
        previousBtn.addEventListener('click', () => {
            if (spotifyPlayer) {
                playPreviousTrackInPlaylist();
            }
        });
    }

    const nextBtn = document.getElementById('mini-player-next');
    if (nextBtn) {
        nextBtn.addEventListener('click', () => {
            if (spotifyPlayer) {
                playNextTrackInPlaylist();
            }
        });
    }

    const closeBtn = document.getElementById('mini-player-close');
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            if (spotifyPlayer) {
                spotifyPlayer.pause(); // Pause playback
            }
            const miniPlayerBar = document.getElementById('mini-player-bar');
            if (miniPlayerBar) {
                miniPlayerBar.classList.add('d-none'); // Hide the mini player bar
            }
            currentTrackUri = null; // Clear current track
        });
    }
};

async function playTrack(trackUri, playlist = [], startIndex = -1, previewUrl = null) {
    if (isPremiumUser) {
        if (!spotifyPlayer) {
            alert('Spotify Player not ready. Please log in to Spotify.');
            return;
        }

        currentTrackUri = trackUri;
        currentPlaylist = playlist;
        currentPlaylistIndex = startIndex;

        console.log(`Attempting to play track with URI: ${trackUri}`);

        if (!trackUri || !trackUri.startsWith('spotify:track:')) {
            console.error('Invalid track URI provided:', trackUri);
            alert('Error: Invalid track URI. Cannot play this track.');
            return;
        }

        try {
            // Get the latest access token before making the play request
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
                alert('Failed to play track. Make sure Spotify is open and you are logged in with a Premium account.' + (errorData.error ? ` Error: ${errorData.error.message}` : ''));
            } else {
                // Update visual feedback if playing from playlist
                updatePlaylistVisualFeedback();
            }
        } catch (error) {
            console.error('Error playing track:', error);
            alert('Error playing track. Check console for details.');
        }
    } else { // General user, play preview
        currentPlaylist = playlist;
        currentPlaylistIndex = startIndex;
        
        if (audioPreview && audioPreview.src === previewUrl && !audioPreview.paused) {
            audioPreview.pause();
            const togglePlay = document.getElementById('mini-player-toggle-play');
            if (togglePlay) togglePlay.innerHTML = '<i class="bi bi-play-fill"></i>';
        } else if (previewUrl) {
            if (audioPreview) {
                audioPreview.src = previewUrl;
                audioPreview.play();
                const togglePlay = document.getElementById('mini-player-toggle-play');
                if (togglePlay) togglePlay.innerHTML = '<i class="bi bi-pause-fill"></i>';
                
                const miniPlayerBar = document.getElementById('mini-player-bar');
                if (miniPlayerBar) miniPlayerBar.classList.remove('d-none');
                
                // Update mini-player display for preview
                const track = playlist[startIndex];
                if (track) {
                    const albumArt = document.getElementById('mini-player-album-art');
                    const trackName = document.getElementById('mini-player-track-name');
                    const artistName = document.getElementById('mini-player-artist-name');
                    const seekSlider = document.getElementById('mini-player-seek-slider');
                    const totalTime = document.getElementById('mini-player-total-time');

                    if (albumArt) albumArt.src = track.album_cover_url;
                    if (trackName) trackName.textContent = track.name;
                    if (artistName) artistName.textContent = track.artist;
                    if (seekSlider) seekSlider.max = audioPreview.duration * 1000; // Convert to ms
                    if (totalTime) totalTime.textContent = formatTime(audioPreview.duration * 1000);

                    // Update seek slider and time displays continuously
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
                        
                        // Auto-play next track in playlist
                        if (currentPlaylist.length > 0 && currentPlaylistIndex < currentPlaylist.length - 1) {
                            playNextTrackInPlaylist();
                        } else {
                            const miniPlayerBar = document.getElementById('mini-player-bar');
                            if (miniPlayerBar) miniPlayerBar.classList.add('d-none');
                        }
                    };
                }
                
                // Update visual feedback if playing from playlist
                updatePlaylistVisualFeedback();
            }
        } else {
            alert('No preview available for this track.');
        }
    }
}

function playNextTrackInPlaylist() {
    if (currentPlaylist.length === 0) return;

    if (isShuffling) {
        playRandomTrackInPlaylist();
        return;
    }

    currentPlaylistIndex++;
    if (currentPlaylistIndex >= currentPlaylist.length) {
        currentPlaylistIndex = 0; // Loop back to start
    }
    const nextTrack = currentPlaylist[currentPlaylistIndex];
    if (isPremiumUser) {
        playTrack(nextTrack.uri, currentPlaylist, currentPlaylistIndex, nextTrack.preview_url);
    } else {
        // For general users, play the preview URL
        playTrack(null, currentPlaylist, currentPlaylistIndex, nextTrack.preview_url);
    }
    
    // Update visual feedback in playlist if current playlist is being displayed
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
        currentPlaylistIndex = currentPlaylist.length - 1; // Loop to end
    }
    const prevTrack = currentPlaylist[currentPlaylistIndex];
    if (isPremiumUser) {
        playTrack(prevTrack.uri, currentPlaylist, currentPlaylistIndex, prevTrack.preview_url);
    } else {
        // For general users, play the preview URL
        playTrack(null, currentPlaylist, currentPlaylistIndex, prevTrack.preview_url);
    }
    
    // Update visual feedback in playlist if current playlist is being displayed
    updatePlaylistVisualFeedback();
}

function playRandomTrackInPlaylist() {
    if (currentPlaylist.length === 0) return;
    const randomIndex = Math.floor(Math.random() * currentPlaylist.length);
    currentPlaylistIndex = randomIndex;
    const randomTrack = currentPlaylist[randomIndex];
    if (isPremiumUser) {
        playTrack(randomTrack.uri, currentPlaylist, currentPlaylistIndex, randomTrack.preview_url);
    } else {
        // For general users, play the preview URL
        playTrack(null, currentPlaylist, currentPlaylistIndex, randomTrack.preview_url);
    }
    
    // Update visual feedback in playlist if current playlist is being displayed
    updatePlaylistVisualFeedback();
}

// Function to update visual feedback in playlist
function updatePlaylistVisualFeedback() {
    if (currentPlaylistId === null) return;
    
    const playlistTabContent = document.getElementById(`playlist-${currentPlaylistId}`);
    if (playlistTabContent) {
        // Remove all previous "now playing" indicators
        playlistTabContent.querySelectorAll('.playlist-track-item').forEach(item => {
            item.style.border = 'none';
            item.querySelector('.play-playlist-track-btn i').className = 'bi bi-play-fill';
        });
        
        // Add "now playing" indicator to current track
        const currentTrackItem = playlistTabContent.querySelectorAll('.playlist-track-item')[currentPlaylistIndex];
        if (currentTrackItem) {
            currentTrackItem.style.border = '2px solid #1DB954';
            currentTrackItem.querySelector('.play-playlist-track-btn i').className = 'bi bi-pause-fill';
        }
    }
}

async function fetchAndSetUserType() {
    try {
        const response = await fetch('/spotify_sdk_token');
        if (response.ok) {
            const data = await response.json();
            isPremiumUser = (data.product_type === 'premium');
            accessToken = data.access_token; // Store the access token
            localStorage.setItem('spotify_access_token', data.access_token); // Store token in localStorage
            console.log('User product type:', data.product_type, 'isPremiumUser:', isPremiumUser);
            
            const spotifyLoginSection = document.getElementById('spotify-login-section');
            const userTypeSelection = document.getElementById('user-type-selection');
            const appContent = document.getElementById('app-content');
            
            if (spotifyLoginSection) spotifyLoginSection.classList.add('d-none');
            if (userTypeSelection) userTypeSelection.classList.add('d-none');
            if (appContent) appContent.classList.remove('d-none');
            togglePlayerControls(isPremiumUser);
        } else {
            console.warn('Could not fetch Spotify SDK token, assuming general user or prompting login.');
            isPremiumUser = false;
            
            const spotifyLoginSection = document.getElementById('spotify-login-section');
            const userTypeSelection = document.getElementById('user-type-selection');
            const appContent = document.getElementById('app-content');
            
            if (spotifyLoginSection) spotifyLoginSection.classList.remove('d-none');
            if (userTypeSelection) userTypeSelection.classList.add('d-none');
            if (appContent) appContent.classList.remove('d-none');
            togglePlayerControls(false);
        }
    } catch (error) {
        console.error('Error fetching user type:', error);
        isPremiumUser = false;
        
        const spotifyLoginSection = document.getElementById('spotify-login-section');
        const userTypeSelection = document.getElementById('user-type-selection');
        const appContent = document.getElementById('app-content');
        
        if (spotifyLoginSection) spotifyLoginSection.classList.remove('d-none');
        if (userTypeSelection) userTypeSelection.classList.add('d-none');
        if (appContent) appContent.classList.remove('d-none');
        togglePlayerControls(false);
    }
}

function redirectToSpotifyLogin() {
    const authUrl = `https://accounts.spotify.com/authorize?client_id=${client_id}&response_type=code&redirect_uri=${encodeURIComponent(redirect_uri)}&scope=${encodeURIComponent(scopes)}`;
    window.location = authUrl;
}

// Helper function to toggle player controls and visibility
function togglePlayerControls(enable) {
    const togglePlayButton = document.getElementById('mini-player-toggle-play');
    const previousTrackButton = document.getElementById('mini-player-previous');
    const nextTrackButton = document.getElementById('mini-player-next');
    const volumeSlider = document.getElementById('mini-player-volume-slider');
    const seekSlider = document.getElementById('mini-player-seek-slider');
    const spotifyPlayerBar = document.getElementById('mini-player-bar');
    const shuffleButton = document.getElementById('mini-player-shuffle');

    if (togglePlayButton) togglePlayButton.disabled = !enable;
    if (previousTrackButton) previousTrackButton.disabled = !enable;
    if (nextTrackButton) nextTrackButton.disabled = !enable;
    if (volumeSlider) volumeSlider.disabled = !enable;
    if (seekSlider) seekSlider.disabled = !enable;
    if (shuffleButton) shuffleButton.disabled = !enable;
    
    if (!enable && spotifyPlayerBar) {
        spotifyPlayerBar.classList.add('d-none');
    }
}

// Helper function to get new recommendation from pool
function getNewRecommendationFromPool() {
    if (recommendationPool.length > 0) {
        return recommendationPool.shift(); // Remove and return the first track from the pool
    }
    return null; // No more tracks in the pool
}

// Helper function to replace a track card
async function replaceTrackCard(cardElement, newTrack) {
    try {
        // Add the new track to current displayed recommendations
        const trackIndex = Array.from(cardElement.parentNode.children).indexOf(cardElement);
        if (trackIndex !== -1) {
            currentDisplayedRecommendations[trackIndex] = newTrack;
        }

        // Fade out the old card
        cardElement.style.transition = 'opacity 1.5s ease-out';
        cardElement.style.opacity = '0';

        setTimeout(() => {
            // Replace the card content
            cardElement.innerHTML = `
                <div class="card h-100" role="button" data-track-uri="${newTrack.uri}" data-track-id="${newTrack.id}" data-preview-url="${newTrack.preview_url || ''}">
                    <img src="${newTrack.album_cover_url}" class="card-img-top" alt="${newTrack.name}">
                    <div class="card-body">
                        <h5 class="card-title text-truncate">${newTrack.name}</h5>
                        <p class="card-text text-truncate">${newTrack.artist}</p>
                        <div class="d-flex justify-content-between align-items-center mt-2">
                            <button class="btn btn-sm btn-outline-success feedback-btn" data-track-id="${newTrack.id}" data-rating="0">Skip</button>
                            <div class="btn-group" role="group">
                                <button class="btn btn-sm btn-outline-success feedback-btn" data-track-id="${newTrack.id}" data-rating="1">1</button>
                                <button class="btn btn-sm btn-outline-success feedback-btn" data-track-id="${newTrack.id}" data-rating="2">2</button>
                                <button class="btn btn-sm btn-outline-success feedback-btn" data-track-id="${newTrack.id}" data-rating="3">3</button>
                                <button class="btn btn-sm btn-outline-success feedback-btn" data-track-id="${newTrack.id}" data-rating="4">4</button>
                                <button class="btn btn-sm btn-outline-success feedback-btn" data-track-id="${newTrack.id}" data-rating="5">5</button>
                            </div>
                        </div>
                    </div>
                </div>
            `;

            // Add event listeners to the new card
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

            // Add event listeners to feedback buttons
            cardElement.querySelectorAll('.feedback-btn').forEach(button => {
                button.addEventListener('click', (event) => {
                    event.stopPropagation();
                    const trackId = event.target.dataset.trackId;
                    const rating = parseFloat(event.target.dataset.rating);
                    sendFeedback(trackId, rating, event.target);
                });
            });

            // Fade in the new card
            cardElement.style.opacity = '1';
        }, 1500);

    } catch (error) {
        console.error('Error replacing track card:', error);
    }
}

// Helper function to show error messages
function showError(message) {
    const errorMessage = document.getElementById('error-message');
    if (errorMessage) {
        errorMessage.textContent = message;
        errorMessage.classList.remove('d-none');
    }
}

// Helper function to fetch and display playlists
async function fetchAndDisplayPlaylists() {
    try {
        const response = await fetch('/playlists');
        if (!response.ok) {
            throw new Error('Failed to fetch playlists');
        }
        const playlists = await response.json();
        
        // Update playlist tabs and content
        for (let i = 0; i <= 5; i++) {
            const tabButton = document.getElementById(`playlist-${i}-tab`);
            const tabContent = document.getElementById(`playlist-${i}`);
            
            if (tabButton && tabContent) {
                const tracks = playlists[i.toString()] || [];
                
                // Update tab title with count
                if (i === 0) {
                    tabButton.textContent = `Skipped (${tracks.length})`;
                } else {
                    tabButton.textContent = `Rating ${i} (${tracks.length})`;
                }
                
                // Update tab content
                if (tracks.length === 0) {
                    tabContent.innerHTML = '<p class="text-muted">No tracks in this playlist yet.</p>';
                } else {
                    tabContent.innerHTML = tracks.map((track, index) => {
                        // Handle both old format (just ID) and new format (full track info)
                        let trackName = track.name || 'Unknown Track';
                        let artistName = track.artist || 'Unknown Artist';
                        let albumCover = track.album_cover_url || 'https://via.placeholder.com/60x60?text=♪';
                        let rating = track.rating || 0;
                        let trackId = track.id || track;
                        let trackUri = track.uri || '';
                        let previewUrl = track.preview_url || '';
                        
                        // If track is just a string (old format), display as is but mark as legacy
                        if (typeof track === 'string') {
                            trackName = track;
                            artistName = 'Legacy Entry';
                            albumCover = 'https://via.placeholder.com/60x60?text=♪';
                            trackId = track;
                            trackUri = '';
                            previewUrl = '';
                        }
                        
                        return `
                            <div class="d-flex align-items-center mb-3 p-3 playlist-track-item" style="background-color: #1a1a1a; border-radius: 8px; cursor: pointer; transition: all 0.2s;" 
                                 data-track-uri="${trackUri}" 
                                 data-track-id="${trackId}" 
                                 data-preview-url="${previewUrl}"
                                 data-track-name="${trackName}"
                                 data-artist-name="${artistName}"
                                 data-album-cover="${albumCover}"
                                 onmouseover="this.style.backgroundColor='#2a2a2a'" 
                                 onmouseout="this.style.backgroundColor='#1a1a1a'"
                                 onclick="playPlaylistItem('${i}', ${index})">
                                <div class="d-flex align-items-center me-3">
                                    <button class="btn btn-sm btn-success play-playlist-track-btn me-2" 
                                            onclick="playPlaylistTrack(event, '${trackUri}', '${previewUrl}', '${trackName}', '${artistName}', '${albumCover}', '${i}', ${index})"
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
                                    <button class="btn btn-sm btn-outline-danger" onclick="removeFromPlaylist('${i}', '${trackId}'); event.stopPropagation();"
                                            title="Remove from playlist">
                                        <i class="bi bi-trash"></i>
                                    </button>
                                </div>
                            </div>
                        `;
                    }).join('');
                    
                    // No need for additional click listeners since onclick is in HTML
                }
            }
        }
    } catch (error) {
        console.error('Error fetching playlists:', error);
    }
}

// Send Feedback function
async function sendFeedback(trackId, rating, buttonElement) {
    const card = buttonElement.closest('.col-md-4, .col-lg-3');
    if (!card) return;

    // Get track information from the card
    const trackCard = card.querySelector('.card[data-track-uri]');
    const trackName = card.querySelector('.card-title').textContent;
    const artistName = card.querySelector('.card-text').textContent;
    const albumCover = card.querySelector('.card-img-top').src;
    const trackUri = trackCard.dataset.trackUri;

    // Disable all feedback buttons on this card
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
                // Include full track information
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
            // If no more tracks, just fade out and remove the card
            card.style.transition = 'opacity 1.5s ease-out';
            card.style.opacity = '0';
            setTimeout(() => card.remove(), 1500);
            console.log('Recommendation pool is empty. No more tracks to display.');
        }
        // After sending feedback, refresh playlists
        fetchAndDisplayPlaylists();

    } catch (error) {
        console.error('Error sending feedback or replacing card:', error);
        // Re-enable buttons if there was an error and no replacement happened
        card.querySelectorAll('.feedback-btn').forEach(btn => btn.disabled = false);
    }
}

// Display Recommendations function
function displayRecommendations(tracks) {
    if (!tracks || tracks.length === 0) {
        showError('No recommendations found for this user.');
        return;
    }

    // Store all 16 tracks, display first 12, keep rest in pool
    currentDisplayedRecommendations = tracks.slice(0, 12);
    recommendationPool = tracks.slice(12);

    const resultsContainer = document.getElementById('results');
    if (resultsContainer) {
        resultsContainer.innerHTML = ''; // Clear previous recommendations

        currentDisplayedRecommendations.forEach((track, index) => {
            const trackCard = `
                <div class="col-md-4 col-lg-3">
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
                </div>
            `;
            resultsContainer.innerHTML += trackCard;
        });

        // Add click listeners to new cards
        document.querySelectorAll('.card[data-track-uri]').forEach((card, index) => {
            card.addEventListener('click', (event) => {
                if (!event.target.closest('.feedback-btn')) {
                    const trackUri = card.dataset.trackUri;
                    const previewUrl = card.dataset.previewUrl;
                    playTrack(trackUri, currentDisplayedRecommendations, index, previewUrl);
                }
            });
        });

        // Add click listeners to feedback buttons
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

// Function to play track from playlist
function playPlaylistTrack(event, trackUri, previewUrl, trackName, artistName, albumCover, playlistId, trackIndex) {
    event.stopPropagation(); // Prevent the row click event
    
    // Get current playlist data from the DOM
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

// Function to play track when clicking on playlist item (not button)
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

// Function to remove track from playlist
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
            fetchAndDisplayPlaylists(); // Refresh the playlist display
        } else {
            console.error('Failed to remove track from playlist');
        }
    } catch (error) {
        console.error('Error removing track from playlist:', error);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    // Assign global player element variables
    spotifyPlayerBar = document.getElementById('mini-player-bar');
    togglePlayButton = document.getElementById('mini-player-toggle-play');
    previousTrackButton = document.getElementById('mini-player-previous');
    nextTrackButton = document.getElementById('mini-player-next');
    volumeSlider = document.getElementById('mini-player-volume-slider');
    seekSlider = document.getElementById('mini-player-seek-slider');
    audioPreview = new Audio(); // Initialize audioPreview once

    // Form and other general elements
    const form = document.getElementById('recommend-form');
    const trackInput = document.getElementById('track-name');
    const artistInput = document.getElementById('artist-name');
    const resultsContainer = document.getElementById('results');
    const loader = document.getElementById('loader');
    const errorMessage = document.getElementById('error-message');
    const playlistsSection = document.getElementById('playlists-section');
    const playlistTabs = document.getElementById('playlist-tabs');
    const recommendationSection = document.getElementById('recommendation-section');
    const showRecommendationsBtn = document.getElementById('show-recommendations');
    const showPlaylistsBtn = document.getElementById('show-playlists');
    const resetBanditButton = document.getElementById('reset-bandit-btn');

    // User type selection buttons
    const premiumUserBtn = document.getElementById('premium-user-btn');
    const generalUserBtn = document.getElementById('general-user-btn');
    const userTypeSelection = document.getElementById('user-type-selection');
    const appContent = document.getElementById('app-content');
    const spotifyLoginSection = document.getElementById('spotify-login-section');

    // Handle user type selection
    if (premiumUserBtn) {
        premiumUserBtn.addEventListener('click', () => {
            isPremiumUser = true;
            userTypeSelection.classList.add('d-none');
            appContent.classList.remove('d-none');
            spotifyLoginSection.classList.remove('d-none');
            togglePlayerControls(false); // Will be enabled when player is ready
        });
    }

    if (generalUserBtn) {
        generalUserBtn.addEventListener('click', () => {
            isPremiumUser = false;
            userTypeSelection.classList.add('d-none');
            appContent.classList.remove('d-none');
            spotifyLoginSection.classList.add('d-none');
            togglePlayerControls(true); // Enable basic controls for preview playback
        });
    }

    // Add event listeners for player controls
    if (togglePlayButton) {
        togglePlayButton.addEventListener('click', () => {
            if (isPremiumUser) {
                if (spotifyPlayer) {
                    spotifyPlayer.togglePlay();
                }
            } else {
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

    // Navigation between recommendations and playlists
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
            fetchAndDisplayPlaylists(); // Load playlists when showing
        });
    }

    // Reset bandit button
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

    // Initial display state: Hide app content until user type is determined
    if (appContent) appContent.classList.add('d-none');
    if (recommendationSection) recommendationSection.classList.remove('d-none');
    if (playlistsSection) playlistsSection.classList.add('d-none');
    if (showRecommendationsBtn) showRecommendationsBtn.classList.add('active');
    if (showPlaylistsBtn) showPlaylistsBtn.classList.remove('active');

    // Call fetchAndSetUserType on page load
    fetchAndSetUserType();

    // Form submission
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

    // Volume slider event listener
    if (volumeSlider) {
        volumeSlider.addEventListener('input', (event) => {
            const volume = event.target.value;
            if (isPremiumUser && spotifyPlayer) {
                spotifyPlayer.setVolume(volume);
            } else if (audioPreview) {
                audioPreview.volume = volume;
            }
            // Update volume progress indicator
            const percentage = volume * 100;
            volumeSlider.style.setProperty('--volume-progress', `${percentage}%`);
        });
    }
});
