const client_id = 'd28df89507ca47bebaa9385ebb546e92';  // Replace this
const redirect_uri = 'http://localhost:8000/callback'; // Ensure this matches your Flask app's redirect URI
const scopes = 'streaming user-read-email user-read-private user-modify-playback-state user-read-playback-state';

    async function playTrack(trackUri, playlist = [], startIndex = -1, previewUrl = null) {
        if (isPremiumUser) {
            if (!spotifyPlayer) {
                alert('Spotify Player not ready. Please log in to Spotify.');
                return;
            }

            currentTrackUri = trackUri;
            currentPlaylist = playlist;
            currentPlaylistIndex = startIndex;

            console.log(`Attempting to play track with URI: ${trackUri}`); // Added logging

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
                        'Authorization': `Bearer ${accessToken}` // Use the freshly obtained token
                    },
                    body: JSON.stringify({
                        uris: [trackUri]
                    })
                });

                if (!response.ok) {
                    const errorData = await response.json();
                    console.error('Failed to play track:', errorData);
                    alert('Failed to play track. Make sure Spotify is open and you are logged in with a Premium account.' + (errorData.error ? ` Error: ${errorData.error.message}` : ''));
                }
            } catch (error) {
                console.error('Error playing track:', error);
                alert('Error playing track. Check console for details.');
            }
        } else { // General user, play preview
            if (audioPreview.src === previewUrl && !audioPreview.paused) {
                audioPreview.pause();
                document.getElementById('mini-player-toggle-play').innerHTML = '<i class="bi bi-play-fill"></i>';
            } else if (previewUrl) {
                audioPreview.src = previewUrl;
                audioPreview.play();
                document.getElementById('mini-player-toggle-play').innerHTML = '<i class="bi bi-pause-fill"></i>';
                document.getElementById('mini-player-bar').classList.remove('d-none');
                // Update mini-player display for preview
                const track = playlist[startIndex];
                if (track) {
                    document.getElementById('mini-player-album-art').src = track.album_cover_url;
                    document.getElementById('mini-player-track-name').textContent = track.name;
                    document.getElementById('mini-player-artist-name').textContent = track.artist;
                    document.getElementById('mini-player-seek-slider').max = audioPreview.duration * 1000; // Convert to ms
                    document.getElementById('mini-player-total-time').textContent = formatTime(audioPreview.duration * 1000);

                    // Update seek slider and time displays continuously
                    if (playbackUpdateInterval) {
                        clearInterval(playbackUpdateInterval);
                    }
                    playbackUpdateInterval = setInterval(() => {
                        document.getElementById('mini-player-seek-slider').value = audioPreview.currentTime * 1000;
                        document.getElementById('mini-player-current-time').textContent = formatTime(audioPreview.currentTime * 1000);
                        const percentage = (audioPreview.currentTime / audioPreview.duration) * 100;
                        document.getElementById('mini-player-seek-slider').style.setProperty('--seek-progress', `${percentage}%`);
                    }, 10);

                    audioPreview.onended = () => {
                        clearInterval(playbackUpdateInterval);
                        document.getElementById('mini-player-toggle-play').innerHTML = '<i class="bi bi-play-fill"></i>';
                        document.getElementById('mini-player-bar').classList.add('d-none');
                    };
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
    }

window.onSpotifyWebPlaybackSDKReady = () => {
    console.log('Spotify Web Playback SDK is ready!');
    const token = localStorage.getItem('spotify_access_token'); // Assuming token is stored here after login
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
        document.getElementById('mini-player-bar').classList.remove('d-none');
    });

    spotifyPlayer.addListener('not_ready', ({ device_id }) => {
        console.log('Device ID has gone offline', device_id);
        togglePlayerControls(false);
        document.getElementById('mini-player-bar').classList.add('d-none');
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
            document.getElementById('mini-player-album-art').src = track.album.images[0].url;
            document.getElementById('mini-player-track-name').textContent = track.name;
            document.getElementById('mini-player-artist-name').textContent = track.artists.map(artist => artist.name).join(', ');
            document.getElementById('mini-player-bar').classList.remove('d-none');
            document.getElementById('mini-player-toggle-play').innerHTML = state.paused ? '<i class="bi bi-play-fill"></i>' : '<i class="bi bi-pause-fill"></i>';

            const duration = state.duration;
            const seekSlider = document.getElementById('mini-player-seek-slider');
            seekSlider.max = duration; // Set max to track duration
            document.getElementById('mini-player-total-time').textContent = formatTime(duration);

            // Update seek slider and time displays continuously if playing
            const updateSeekSlider = (position) => {
                seekSlider.value = position;
                document.getElementById('mini-player-current-time').textContent = formatTime(position);
                const percentage = (position / duration) * 100;
                seekSlider.style.setProperty('--seek-progress', `${percentage}%`);
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
                }, 10); // Update every 0.01 second
            } else {
                // If paused, just update once
                updateSeekSlider(state.position);
            }

            // Dynamic background based on album art
            const colorThief = new ColorThief();
            document.getElementById('mini-player-album-art').onload = function() {
                try {
                    const dominantColor = colorThief.getColor(document.getElementById('mini-player-album-art'));
                    const rgbColor = `rgb(${dominantColor[0]}, ${dominantColor[1]}, ${dominantColor[2]})`;
                    document.getElementById('mini-player-bar').style.backgroundColor = rgbColor;
                } catch (e) {
                    console.error("Error getting dominant color:", e);
                    document.getElementById('mini-player-bar').style.backgroundColor = '#282828'; // Fallback
                }
            };
            // If image is already loaded (e.g., from cache), trigger onload manually
            if (document.getElementById('mini-player-album-art').complete) {
                document.getElementById('mini-player-album-art').onload();
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
            document.getElementById('mini-player-bar').classList.add('d-none');
        }
    });

    // Seek slider event listener
    document.getElementById('mini-player-seek-slider').addEventListener('input', (event) => {
        if (isPremiumUser) {
            if (spotifyPlayer) {
                spotifyPlayer.seek(Number(event.target.value));
            }
        } else {
            audioPreview.currentTime = Number(event.target.value) / 1000; // Convert ms to seconds
        }
    });

    // Helper function to format time
    function formatTime(ms) {
        const minutes = Math.floor(ms / 60000);
        const seconds = ((ms % 60000) / 1000).toFixed(0);
        return minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
    }

    document.getElementById('mini-player-previous').addEventListener('click', () => {
        if (spotifyPlayer) {
            playPreviousTrackInPlaylist();
        }
    });

    document.getElementById('mini-player-next').addEventListener('click', () => {
        if (spotifyPlayer) {
            playNextTrackInPlaylist();
        }
    });

    document.getElementById('mini-player-close').addEventListener('click', () => {
        if (spotifyPlayer) {
            spotifyPlayer.pause(); // Pause playback
        }
        document.getElementById('mini-player-bar').classList.add('d-none'); // Hide the mini player bar
        currentTrackUri = null; // Clear current track
    });
};

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
let isShuffling = false; // Flag for shuffle mode
let isPremiumUser = false; // Flag for premium user status

async function fetchAndSetUserType() {
    try {
        const response = await fetch('/spotify_sdk_token');
        if (response.ok) {
            const data = await response.json();
            isPremiumUser = (data.product_type === 'premium');
            accessToken = data.access_token; // Store the access token
            localStorage.setItem('spotify_access_token', data.access_token); // Store token in localStorage
            console.log('User product type:', data.product_type, 'isPremiumUser:', isPremiumUser);
            // initializeSpotifyPlayer(); // Removed: Player initialization now handled by onSpotifyWebPlaybackSDKReady
            document.getElementById('spotify-login-section').classList.add('d-none');
            document.getElementById('user-type-selection').classList.add('d-none');
            document.getElementById('app-content').classList.remove('d-none');
            togglePlayerControls(isPremiumUser);
        } else {
            // If token not available or error, assume general user for now or prompt login
            console.warn('Could not fetch Spotify SDK token, assuming general user or prompting login.');
            isPremiumUser = false;
            document.getElementById('spotify-login-section').classList.remove('d-none');
            document.getElementById('user-type-selection').classList.add('d-none');
            document.getElementById('app-content').classList.remove('d-none');
            togglePlayerControls(false);
        }
    } catch (error) {
        console.error('Error fetching user type:', error);
        isPremiumUser = false;
        document.getElementById('spotify-login-section').classList.remove('d-none');
        document.getElementById('user-type-selection').classList.add('d-none');
        document.getElementById('app-content').classList.remove('d-none');
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

    togglePlayButton.disabled = !enable;
    previousTrackButton.disabled = !enable;
    nextTrackButton.disabled = !enable;
    volumeSlider.disabled = !enable;
    seekSlider.disabled = !enable;
    document.getElementById('mini-player-shuffle').disabled = !enable;
    if (!enable) {
        spotifyPlayerBar.classList.add('d-none');
    }
}

async function initializeSpotifyPlayer() {
    console.log('initializeSpotifyPlayer: Starting...');
    if (!isPremiumUser) {
        console.log('Not a premium user, skipping Spotify Player initialization.');
        return;
    }
    try {
        const response = await fetch('/spotify_sdk_token');
        console.log('initializeSpotifyPlayer: /spotify_sdk_token response.ok =', response.ok);
        if (!response.ok) {
            // If token is not available, show login section and return
            document.getElementById('spotify-login-section').classList.remove('d-none');
            console.error('Spotify SDK token not available. Please log in.');
            return; // Exit the function
        }

        // If token is available, hide login section
        document.getElementById('spotify-login-section').classList.add('d-none');

        // The Spotify Player will be initialized by the onSpotifyWebPlaybackSDKReady callback
        // which is triggered when the SDK script loads.
        // We just need to ensure the SDK script is loaded.
        // This is typically done in index.html with <script src="https://sdk.scdn.co/spotify-player.js"></script>

    } catch (error) {
        console.error('Error initializing Spotify Player:', error);
        document.getElementById('spotify-login-section').classList.remove('d-none');
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

    // Add event listeners for player controls
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

    previousTrackButton.addEventListener('click', () => {
        playPreviousTrackInPlaylist();
    });

    nextTrackButton.addEventListener('click', () => {
        playNextTrackInPlaylist();
    });

    const shuffleButton = document.getElementById('mini-player-shuffle');
    if (shuffleButton) {
        shuffleButton.addEventListener('click', () => {
            isShuffling = !isShuffling;
            shuffleButton.classList.toggle('active', isShuffling);
            console.log('Shuffle mode:', isShuffling);
        });
    }

    // ... rest of DOMContentLoaded code ...
    // Initial display state: Hide app content until user type is determined
    document.getElementById('app-content').classList.add('d-none');
    recommendationSection.classList.remove('d-none'); // Ensure recommendation section is visible within app-content
    playlistsSection.classList.add('d-none');
    showRecommendationsBtn.classList.add('active');
    showPlaylistsBtn.classList.remove('active');

    // Call fetchAndSetUserType on page load
    fetchAndSetUserType();

    // Handle Spotify Login Button
    const loginButton = document.getElementById('login-btn');
    if (loginButton) {
        loginButton.onclick = () => redirectToSpotifyLogin();
    }

    // Check for token in URL on page load
    // This part is now handled by fetchAndSetUserType().
    // const token = getTokenFromUrl();
    // if (token) {
    //     // If token is present, hide login section and proceed with player initialization
    //     // This part is now handled by the user type selection.
    //     // If a token is present on page load, it means the user has already logged in.
    //     // We should assume they are a premium user for now, or prompt them again.
    //     // For simplicity, if a token is present, we'll automatically set to premium mode.
    //     isPremiumUser = true;
    //     userTypeSelection.classList.add('d-none');
    //     appContent.classList.remove('d-none');
    //     spotifyLoginSection.classList.add('d-none'); // Hide login section if token exists
    //     togglePlayerControls(true); // Enable player controls
    // } else {
    //     // If no token, ensure user type selection is visible
    //     userTypeSelection.classList.remove('d-none');
    //     appContent.classList.add('d-none');
    // }

    // --- Form Submission ---
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const trackName = trackInput.value.trim();
        const artistName = artistInput.value.trim();
        if (!trackName || !artistName) return;

        console.log(`Requesting recommendations for: ${trackName} - ${artistName}`);

        currentSeedTrackName = trackName; // Store seed track name
        currentSeedArtistName = artistName; // Store seed artist name

        resultsContainer.innerHTML = '';
        errorMessage.classList.add('d-none');
        loader.classList.remove('d-none');

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
            loader.classList.add('d-none');
        }
    });

    // --- Display Recommendations ---
    function displayRecommendations(tracks) {
        if (!tracks || tracks.length === 0) {
            showError('No recommendations found for this user.');
            return;
        }

        // Store all 16 tracks, display first 12, keep rest in pool
        currentDisplayedRecommendations = tracks.slice(0, 12);
        recommendationPool = tracks.slice(12);

        resultsContainer.innerHTML = ''; // Clear previous recommendations

        currentDisplayedRecommendations.forEach(track => {
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

        // Remove click listeners to play buttons on cards (as they are removed)
        // document.querySelectorAll('.play-track-btn').forEach(button => {
        //     button.addEventListener('click', (event) => {
        //         event.stopPropagation();
        //         const trackUri = button.dataset.trackUri;
        //         playTrack(trackUri);
        //     });
        // });

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

    // --- Play Track with SDK ---
    

    // --- Send Feedback ---
    async function sendFeedback(trackId, rating, buttonElement) {
        const card = buttonElement.closest('.col-md-4, .col-lg-3'); // Get the parent column div
        if (!card) return;

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
                    rating: rating
                }),
            });

            if (!response.ok) {
                throw new Error('Failed to send feedback.');
            }

            console.log(`Feedback sent for ${trackId} with rating ${rating}`);

            const newTrack = getNewRecommendationFromPool();
            if (newTrack) {
                replaceTrackCard(card, newTrack); // Pass the card element directly
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
    } // Missing closing brace for sendFeedback function




