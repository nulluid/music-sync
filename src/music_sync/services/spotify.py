"""Spotify backend, via spotipy against the real Spotify Web API.

Auth is Authorization Code + PKCE, so only a client ID is needed (no
client secret to protect) and the one-time setup is:

  1. Create an app at https://developer.spotify.com/dashboard
     (redirect URI: http://127.0.0.1:8765/callback)
  2. export SPOTIFY_CLIENT_ID=<app client id>
  3. music-sync auth spotify   # opens a browser, one-time consent

Everything after that is unattended: spotipy refreshes the token itself
and caches it at config.SPOTIFY_CACHE.
"""

from __future__ import annotations

import os

from dotenv import load_dotenv

from music_sync import config
from music_sync.matcher import Candidate
from music_sync.services.base import AuthRequired, MusicService

SCOPES = "playlist-read-private playlist-modify-private playlist-modify-public"
REDIRECT_URI = "http://127.0.0.1:8765/callback"

AUTH_INSTRUCTIONS = (
    "1) create an app at https://developer.spotify.com/dashboard with redirect URI "
    f"{REDIRECT_URI}, 2) export SPOTIFY_CLIENT_ID=<id>, 3) run `music-sync auth spotify`"
)


def _client_id() -> str | None:
    load_dotenv(config.SPOTIFY_ENV)
    return os.environ.get("SPOTIFY_CLIENT_ID")


class SpotifyService(MusicService):
    name = "spotify"

    def __init__(self, open_browser: bool = True):
        self._open_browser = open_browser
        self._client = None

    def _spotipy(self):
        if self._client is not None:
            return self._client
        import spotipy
        from spotipy.oauth2 import SpotifyPKCE

        client_id = _client_id()
        if not client_id:
            raise AuthRequired("spotify", AUTH_INSTRUCTIONS)

        auth_manager = SpotifyPKCE(
            client_id=client_id,
            redirect_uri=REDIRECT_URI,
            scope=SCOPES,
            cache_path=str(config.SPOTIFY_CACHE),
            open_browser=self._open_browser,
        )
        if not auth_manager.get_cached_token():
            if not self._open_browser:
                raise AuthRequired("spotify", AUTH_INSTRUCTIONS)
        self._client = spotipy.Spotify(auth_manager=auth_manager)
        return self._client

    def is_authenticated(self) -> bool:
        if not _client_id() or not config.SPOTIFY_CACHE.exists():
            return False
        try:
            self._spotipy().current_user()
            return True
        except Exception:
            return False

    def authenticate(self) -> None:
        self._spotipy().current_user()

    @staticmethod
    def _candidate(item: dict) -> Candidate:
        return Candidate(
            id=item["id"],
            title=item["name"],
            artist=", ".join(a["name"] for a in item["artists"]),
            album=item.get("album", {}).get("name"),
            duration=item.get("duration_ms"),
            isrc=item.get("external_ids", {}).get("isrc"),
        )

    def search(self, title: str, artist: str, limit: int = 5) -> list[Candidate]:
        sp = self._spotipy()
        results = sp.search(q=f"track:{title} artist:{artist}", type="track", limit=limit)
        return [self._candidate(item) for item in results["tracks"]["items"]]

    def get_playlist_tracks(self, playlist_id: str) -> list[Candidate]:
        sp = self._spotipy()
        out: list[Candidate] = []
        results = sp.playlist_items(playlist_id, additional_types=["track"])
        while results:
            for item in results["items"]:
                track = item.get("track")
                if track and track.get("id"):
                    out.append(self._candidate(track))
            results = sp.next(results) if results.get("next") else None
        return out

    def find_playlist_by_name(self, name: str) -> str | None:
        sp = self._spotipy()
        results = sp.current_user_playlists(limit=50)
        while results:
            for p in results["items"]:
                if p["name"].lower() == name.lower():
                    return p["id"]
            results = sp.next(results) if results.get("next") else None
        return None

    def create_playlist(self, title: str, description: str = "") -> str:
        sp = self._spotipy()
        user_id = sp.current_user()["id"]
        playlist = sp.user_playlist_create(
            user_id, title, public=False, description=description
        )
        return playlist["id"]

    def add_tracks(self, playlist_id: str, track_ids: list[str]) -> None:
        sp = self._spotipy()
        uris = [f"spotify:track:{tid}" for tid in track_ids]
        for i in range(0, len(uris), 100):
            sp.playlist_add_items(playlist_id, uris[i : i + 100])

    def replace_tracks(self, playlist_id: str, track_ids: list[str]) -> None:
        sp = self._spotipy()
        uris = [f"spotify:track:{tid}" for tid in track_ids]
        sp.playlist_replace_items(playlist_id, uris[:100])
        for i in range(100, len(uris), 100):
            sp.playlist_add_items(playlist_id, uris[i : i + 100])
