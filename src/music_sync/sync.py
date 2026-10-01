"""Upload, download, and sync orchestration.

These functions only depend on the MusicService interface (services/base.py)
and the Playlist/Track model (format.py), never on a specific backend, so
they're the same code path for Spotify, YouTube Music, and Amazon Music.
"""

from __future__ import annotations

from dataclasses import dataclass

from music_sync.format import Playlist, Track
from music_sync.matcher import Candidate, match
from music_sync.services.base import MusicService


@dataclass
class TrackResult:
    track: Track
    service: str
    status: str  # "matched" | "fuzzy_matched" | "unmatched"
    confidence: float
    service_track_id: str | None


@dataclass
class ServiceReport:
    service: str
    playlist_id: str
    created_playlist: bool
    results: list[TrackResult]

    @property
    def unmatched(self) -> list[TrackResult]:
        return [r for r in self.results if r.status == "unmatched"]


def _resolve_track_id(service: MusicService, track: Track) -> TrackResult:
    existing = track.service_ids.get(service.name)
    if existing:
        return TrackResult(track, service.name, "matched", 100.0, existing)

    candidates = service.search(track.title, track.creator)
    result = match(track, candidates)
    if result.candidate is None:
        return TrackResult(track, service.name, "unmatched", result.confidence, None)
    status = "matched" if result.method == "isrc" else "fuzzy_matched"
    return TrackResult(track, service.name, status, result.confidence, result.candidate.id)


def upload(playlist: Playlist, service: MusicService) -> ServiceReport:
    """Create (or reuse an existing, same-named) playlist on `service` and fill it."""
    playlist_id = playlist.playlist_ids.get(service.name) or service.find_playlist_by_name(
        playlist.title
    )
    created = False
    if not playlist_id:
        playlist_id = service.create_playlist(playlist.title, playlist.annotation or "")
        created = True

    results = [_resolve_track_id(service, t) for t in playlist.tracks]
    track_ids = [r.service_track_id for r in results if r.service_track_id]
    if created:
        service.add_tracks(playlist_id, track_ids)
    else:
        service.replace_tracks(playlist_id, track_ids)

    return ServiceReport(service.name, playlist_id, created, results)


def download(service: MusicService, playlist_id: str, title: str | None = None) -> Playlist:
    """Pull a playlist's current contents from `service` into the local format."""
    candidates = service.get_playlist_tracks(playlist_id)
    tracks = [_track_from_candidate(c) for c in candidates]
    playlist = Playlist(title=title or playlist_id, tracks=tracks)
    playlist.playlist_ids.set(service.name, playlist_id)
    return playlist


def _track_from_candidate(c: Candidate) -> Track:
    track = Track(title=c.title, creator=c.artist, album=c.album, duration=c.duration, isrc=c.isrc)
    return track


def sync(
    source_service: MusicService,
    source_playlist_id: str,
    target_services: list[MusicService],
    title: str | None = None,
) -> tuple[Playlist, list[ServiceReport]]:
    """Mirror `source_service`'s playlist onto every service in `target_services`.

    The source is read fresh from the live service on every call — it is
    the source of truth, so there is nothing to merge, only to overwrite
    the targets with.
    """
    canonical = download(source_service, source_playlist_id, title=title)
    reports = [upload(canonical, target) for target in target_services]
    return canonical, reports
