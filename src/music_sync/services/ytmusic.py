"""YouTube Music backend, via the unofficial ytmusicapi library.

There is no official write API for YouTube Music (see the chat history in
this project for why) — ytmusicapi replays the web client's own requests
using an OAuth token issued for a "TV and limited input device" client.
That is against YouTube's terms of service in the strict sense (nothing
here is a documented, supported integration path) even though it is the
same technique every playlist-transfer tool in this space uses. Treat
tokens as revocable without notice and don't be surprised if this backend
needs fixing after a YouTube Music web client change.

One-time setup:

  1. Google Cloud Console -> new OAuth client, type "TVs and Limited Input
     devices" -> note the client ID and secret.
  2. export YTMUSIC_CLIENT_ID=... YTMUSIC_CLIENT_SECRET=...
  3. music-sync auth ytmusic   # device-code flow, one-time consent
"""

from __future__ import annotations

import os

from dotenv import load_dotenv

from music_sync import config
from music_sync.matcher import Candidate
from music_sync.services.base import AuthRequired, MusicService

AUTH_INSTRUCTIONS = (
    "1) create a Google Cloud OAuth client of type 'TVs and Limited Input devices', "
    "2) export YTMUSIC_CLIENT_ID and YTMUSIC_CLIENT_SECRET, "
    "3) run `music-sync auth ytmusic`"
)


def _credentials() -> tuple[str, str] | None:
    load_dotenv(config.SPOTIFY_ENV.parent / "ytmusic.env")
    client_id = os.environ.get("YTMUSIC_CLIENT_ID")
    client_secret = os.environ.get("YTMUSIC_CLIENT_SECRET")
    if client_id and client_secret:
        return client_id, client_secret
    return None


def _duration_ms(track: dict) -> int | None:
    seconds = track.get("duration_seconds")
    if seconds is not None:
        return seconds * 1000
    duration = track.get("duration")
    if not duration:
        return None
    parts = [int(p) for p in duration.split(":")]
    seconds = 0
    for p in parts:
        seconds = seconds * 60 + p
    return seconds * 1000


class YTMusicService(MusicService):
    name = "ytmusic"

    def __init__(self):
        self._client = None

    def _yt(self):
        if self._client is not None:
            return self._client
        from ytmusicapi import OAuthCredentials, YTMusic

        creds = _credentials()
        if not creds or not config.YTMUSIC_OAUTH.exists():
            raise AuthRequired("ytmusic", AUTH_INSTRUCTIONS)
        client_id, client_secret = creds
        self._client = YTMusic(
            str(config.YTMUSIC_OAUTH),
            oauth_credentials=OAuthCredentials(client_id=client_id, client_secret=client_secret),
        )
        return self._client

    def is_authenticated(self) -> bool:
        if not _credentials() or not config.YTMUSIC_OAUTH.exists():
            return False
        try:
            self._yt().get_library_playlists(limit=1)
            return True
        except Exception:
            return False

    def authenticate(self) -> None:
        """Run the device-code flow and write config.YTMUSIC_OAUTH."""
        from ytmusicapi import OAuthCredentials
        from ytmusicapi.auth.oauth import OAuthToken
        from ytmusicapi.setup import setup_oauth

        creds = _credentials()
        if not creds:
            raise AuthRequired("ytmusic", AUTH_INSTRUCTIONS)
        client_id, client_secret = creds
        setup_oauth(
            filepath=str(config.YTMUSIC_OAUTH),
            client_id=client_id,
            client_secret=client_secret,
            open_browser=True,
        )

    @staticmethod
    def _candidate(track: dict) -> Candidate:
        artists = track.get("artists") or []
        return Candidate(
            id=track.get("videoId", ""),
            title=track.get("title", ""),
            artist=", ".join(a.get("name", "") for a in artists),
            album=(track.get("album") or {}).get("name"),
            duration=_duration_ms(track),
            isrc=None,  # ytmusicapi search results don't carry ISRC
        )

    def search(self, title: str, artist: str, limit: int = 5) -> list[Candidate]:
        yt = self._yt()
        results = yt.search(f"{title} {artist}", filter="songs", limit=limit)
        return [self._candidate(r) for r in results if r.get("videoId")]

    def get_playlist_tracks(self, playlist_id: str) -> list[Candidate]:
        yt = self._yt()
        playlist = yt.get_playlist(playlist_id, limit=None)
        return [self._candidate(t) for t in playlist.get("tracks", []) if t.get("videoId")]

    def find_playlist_by_name(self, name: str) -> str | None:
        yt = self._yt()
        for p in yt.get_library_playlists(limit=200):
            if p["title"].lower() == name.lower():
                return p["playlistId"]
        return None

    def create_playlist(self, title: str, description: str = "") -> str:
        yt = self._yt()
        return yt.create_playlist(title, description, privacy_status="PRIVATE")

    def add_tracks(self, playlist_id: str, track_ids: list[str]) -> None:
        yt = self._yt()
        yt.add_playlist_items(playlist_id, track_ids, duplicates=False)

    def replace_tracks(self, playlist_id: str, track_ids: list[str]) -> None:
        yt = self._yt()
        existing = yt.get_playlist(playlist_id, limit=None).get("tracks", [])
        if existing:
            yt.remove_playlist_items(playlist_id, existing)
        if track_ids:
            yt.add_playlist_items(playlist_id, track_ids, duplicates=False)
