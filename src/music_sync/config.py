"""Where credentials and session state live.

Nothing under here is ever committed — see .gitignore. Each service gets
its own file so revoking one service's access doesn't touch the others.
"""

from __future__ import annotations

import os
from pathlib import Path

CONFIG_DIR = Path(os.environ.get("MUSIC_SYNC_CONFIG_DIR", Path.home() / ".config" / "music-sync"))


def config_dir() -> Path:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    return CONFIG_DIR


def path_for(filename: str) -> Path:
    return config_dir() / filename


SPOTIFY_CACHE = path_for("spotify_token_cache")
SPOTIFY_ENV = path_for("spotify.env")  # SPOTIFY_CLIENT_ID=..., SPOTIFY_REDIRECT_URI=...
YTMUSIC_OAUTH = path_for("ytmusic_oauth.json")
AMAZON_STORAGE_STATE = path_for("amazon_storage_state.json")
DEFAULT_BACKUP_DIR = path_for("backups")
