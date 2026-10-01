from music_sync.services.amazon import AmazonMusicService
from music_sync.services.base import AuthRequired, MusicService
from music_sync.services.spotify import SpotifyService
from music_sync.services.ytmusic import YTMusicService

REGISTRY: dict[str, type[MusicService]] = {
    "spotify": SpotifyService,
    "ytmusic": YTMusicService,
    "amazon": AmazonMusicService,
}


def get_service(name: str) -> MusicService:
    try:
        return REGISTRY[name]()
    except KeyError:
        raise ValueError(f"unknown service {name!r}, choose from {list(REGISTRY)}") from None


__all__ = ["AuthRequired", "MusicService", "REGISTRY", "get_service"]
