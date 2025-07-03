import os
import base64
import requests
import json
import time

class SpotifyAuthManager:
    def __init__(self, client_id, client_secret, redirect_uri, scope):
        self.client_id = client_id
        self.client_secret = client_secret
        self.redirect_uri = redirect_uri
        self.scope = scope
        self.token_info = None # Stores access_token, refresh_token, expires_at

    def get_authorize_url(self):
        params = {
            "client_id": self.client_id,
            "response_type": "code",
            "redirect_uri": self.redirect_uri,
            "scope": self.scope,
        }
        return "https://accounts.spotify.com/authorize?" + requests.compat.urlencode(params)

    def get_token(self, code):
        auth_header = base64.b64encode(f"{self.client_id}:{self.client_secret}".encode()).decode()
        headers = {
            "Authorization": f"Basic {auth_header}",
            "Content-Type": "application/x-www-form-urlencoded"
        }
        data = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": self.redirect_uri
        }
        response = requests.post("https://accounts.spotify.com/api/token", headers=headers, data=data)
        response.raise_for_status()
        self.token_info = response.json()
        self.token_info['expires_at'] = time.time() + self.token_info['expires_in']
        return self.token_info

    def refresh_token(self):
        if not self.token_info or 'refresh_token' not in self.token_info:
            raise Exception("No refresh token available.")

        auth_header = base64.b64encode(f"{self.client_id}:{self.client_secret}".encode()).decode()
        headers = {
            "Authorization": f"Basic {auth_header}",
            "Content-Type": "application/x-www-form-urlencoded"
        }
        data = {
            "grant_type": "refresh_token",
            "refresh_token": self.token_info['refresh_token']
        }
        response = requests.post("https://accounts.spotify.com/api/token", headers=headers, data=data)
        response.raise_for_status()
        new_token_info = response.json()
        self.token_info.update(new_token_info)
        self.token_info['expires_at'] = time.time() + self.token_info['expires_in']
        return self.token_info

    def get_access_token(self):
        if self.token_info and time.time() < self.token_info['expires_at']:
            return self.token_info['access_token']
        elif self.token_info and 'refresh_token' in self.token_info:
            return self.refresh_token()['access_token']
        return None