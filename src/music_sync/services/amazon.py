"""Amazon Music backend, via Playwright browser automation.

Amazon Music has a real Web API with a playlist-create endpoint, but it's
closed beta and only reachable through a negotiated Amazon Business
Development relationship — not self-serve (checked 2026-10, see
developer.amazon.com/docs/music/API_web_playlist.html and the Amazon
Developer Community threads on it). Soundiiz and similar tools have that
access; an individual doesn't. So this backend drives the real
music.amazon.com web UI instead.

This makes it the most fragile of the three backends: selectors below are
written from Amazon Music's documented UI structure, not verified against
a live authenticated session (playlist management is behind login, which
needs you present — see "one-time setup"). The first real run should be
`--headed` so you can confirm each selector still matches before trusting
it unattended. Expect this file to need small fixes when Amazon changes
their frontend; `playwright codegen https://music.amazon.com` is the
fastest way to re-record a broken selector.

One-time setup:

  music-sync auth amazon   # opens a real browser window, log in by hand,
                            # session is saved to config.AMAZON_STORAGE_STATE
"""

from __future__ import annotations

from music_sync import config
from music_sync.matcher import Candidate
from music_sync.services.base import AuthRequired, MusicService

AUTH_INSTRUCTIONS = "run `music-sync auth amazon` and log in in the browser window it opens"

BASE_URL = "https://music.amazon.com"


class AmazonMusicService(MusicService):
    name = "amazon"

    def __init__(self, headless: bool = True):
        self._headless = headless
        self._playwright = None
        self._browser = None
        self._context = None
        self._page = None

    def _ensure_page(self):
        if self._page is not None:
            return self._page
        if not config.AMAZON_STORAGE_STATE.exists():
            raise AuthRequired("amazon", AUTH_INSTRUCTIONS)

        from playwright.sync_api import sync_playwright

        self._playwright = sync_playwright().start()
        self._browser = self._playwright.chromium.launch(headless=self._headless)
        self._context = self._browser.new_context(
            storage_state=str(config.AMAZON_STORAGE_STATE)
        )
        self._page = self._context.new_page()
        self._page.goto(BASE_URL)
        return self._page

    def close(self) -> None:
        if self._context:
            self._context.storage_state(path=str(config.AMAZON_STORAGE_STATE))
        if self._browser:
            self._browser.close()
        if self._playwright:
            self._playwright.stop()
        self._page = None

    def authenticate(self) -> None:
        """Open a real, visible window for the user to log in by hand, then save the session."""
        from playwright.sync_api import sync_playwright

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=False)
            context = browser.new_context()
            page = context.new_page()
            page.goto(f"{BASE_URL}/login")
            page.wait_for_selector("text=Your Library", timeout=0)  # waits until logged in
            context.storage_state(path=str(config.AMAZON_STORAGE_STATE))
            browser.close()

    def is_authenticated(self) -> bool:
        if not config.AMAZON_STORAGE_STATE.exists():
            return False
        try:
            page = self._ensure_page()
            page.wait_for_selector("text=Your Library", timeout=10_000)
            return True
        except Exception:
            return False
        finally:
            self.close()

    def search(self, title: str, artist: str, limit: int = 5) -> list[Candidate]:
        page = self._ensure_page()
        page.goto(f"{BASE_URL}/search/{title} {artist}")
        page.wait_for_selector('[data-testid="search-results"]', timeout=15_000)
        rows = page.locator('[data-testid="track-row"]').all()[:limit]
        out = []
        for row in rows:
            track_id = row.get_attribute("data-track-id") or ""
            track_title = row.locator('[data-testid="track-title"]').inner_text()
            track_artist = row.locator('[data-testid="track-artist"]').inner_text()
            out.append(Candidate(id=track_id, title=track_title, artist=track_artist))
        return out

    def get_playlist_tracks(self, playlist_id: str) -> list[Candidate]:
        page = self._ensure_page()
        page.goto(f"{BASE_URL}/my/playlists/{playlist_id}")
        page.wait_for_selector('[data-testid="track-row"]', timeout=15_000)
        out = []
        for row in page.locator('[data-testid="track-row"]').all():
            track_id = row.get_attribute("data-track-id") or ""
            track_title = row.locator('[data-testid="track-title"]').inner_text()
            track_artist = row.locator('[data-testid="track-artist"]').inner_text()
            out.append(Candidate(id=track_id, title=track_title, artist=track_artist))
        return out

    def find_playlist_by_name(self, name: str) -> str | None:
        page = self._ensure_page()
        page.goto(f"{BASE_URL}/my/playlists")
        page.wait_for_selector('[data-testid="playlist-tile"]', timeout=15_000)
        for tile in page.locator('[data-testid="playlist-tile"]').all():
            if tile.locator('[data-testid="playlist-title"]').inner_text().lower() == name.lower():
                href = tile.get_attribute("href") or ""
                return href.rstrip("/").rsplit("/", 1)[-1] or None
        return None

    def create_playlist(self, title: str, description: str = "") -> str:
        page = self._ensure_page()
        page.goto(f"{BASE_URL}/my/playlists")
        page.get_by_role("button", name="New playlist").click()
        page.get_by_role("textbox", name="Playlist name").fill(title)
        if description:
            page.get_by_role("textbox", name="Description").fill(description)
        page.get_by_role("button", name="Create").click()
        page.wait_for_url(f"{BASE_URL}/my/playlists/*")
        return page.url.rstrip("/").rsplit("/", 1)[-1]

    def add_tracks(self, playlist_id: str, track_ids: list[str]) -> None:
        page = self._ensure_page()
        for track_id in track_ids:
            page.goto(f"{BASE_URL}/tracks/{track_id}")
            page.get_by_role("button", name="Add to playlist").click()
            page.get_by_role("menuitem", name=playlist_id).click()

    def replace_tracks(self, playlist_id: str, track_ids: list[str]) -> None:
        page = self._ensure_page()
        page.goto(f"{BASE_URL}/my/playlists/{playlist_id}")
        page.wait_for_selector('[data-testid="track-row"]', timeout=15_000)
        for row in page.locator('[data-testid="track-row"]').all():
            row.get_by_role("button", name="Remove from playlist").click()
        self.add_tracks(playlist_id, track_ids)
