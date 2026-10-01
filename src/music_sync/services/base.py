"""Common interface every service backend implements.

sync.py and cli.py only talk to this interface, never to a specific
backend, so adding a fourth service later is a new services/*.py file and
one line in services/__init__.py.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from music_sync.matcher import Candidate


class AuthRequired(Exception):
    """Raised when a service needs the user to complete interactive auth.

    Carries the exact command to run so the CLI can print it and stop,
    instead of failing deep inside a sync with a stack trace.
    """

    def __init__(self, service: str, instructions: str):
        self.service = service
        self.instructions = instructions
        super().__init__(f"{service} needs auth: {instructions}")


class MusicService(ABC):
    name: str

    @abstractmethod
    def is_authenticated(self) -> bool:
        """Check cheaply (no network call that can hang) whether stored auth exists."""

    @abstractmethod
    def search(self, title: str, artist: str, limit: int = 5) -> list[Candidate]:
        """Search the service's catalog for a track."""

    @abstractmethod
    def get_playlist_tracks(self, playlist_id: str) -> list[Candidate]:
        """Return every track currently in a playlist, in order."""

    @abstractmethod
    def find_playlist_by_name(self, name: str) -> str | None:
        """Return a playlist id for an exact (case-insensitive) title match, else None."""

    @abstractmethod
    def create_playlist(self, title: str, description: str = "") -> str:
        """Create an empty playlist and return its id."""

    @abstractmethod
    def add_tracks(self, playlist_id: str, track_ids: list[str]) -> None:
        """Append tracks (service-native ids, as returned by search/get_playlist_tracks)."""

    @abstractmethod
    def replace_tracks(self, playlist_id: str, track_ids: list[str]) -> None:
        """Replace a playlist's contents with exactly this ordered list."""
