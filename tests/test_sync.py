from music_sync.format import Playlist, Track
from music_sync.matcher import Candidate
from music_sync.services.base import MusicService
from music_sync.sync import download, sync, upload


class FakeService(MusicService):
    """In-memory stand-in for a real backend, used by every sync.py test."""

    def __init__(self, name, catalog=None, playlists=None):
        self.name = name
        self.catalog = catalog or []  # list[Candidate] searchable by title/artist
        self.playlists: dict[str, list[str]] = dict(playlists or {})  # id -> track ids
        self.titles: dict[str, str] = {}
        self._next_id = 1

    def is_authenticated(self):
        return True

    def search(self, title, artist, limit=5):
        return [c for c in self.catalog if c.title == title and c.artist == artist][:limit]

    def get_playlist_tracks(self, playlist_id):
        ids = self.playlists[playlist_id]
        by_id = {c.id: c for c in self.catalog}
        return [by_id[i] for i in ids]

    def find_playlist_by_name(self, name):
        for pid, title in self.titles.items():
            if title.lower() == name.lower():
                return pid
        return None

    def create_playlist(self, title, description=""):
        pid = f"{self.name}-pl-{self._next_id}"
        self._next_id += 1
        self.playlists[pid] = []
        self.titles[pid] = title
        return pid

    def add_tracks(self, playlist_id, track_ids):
        self.playlists[playlist_id].extend(track_ids)

    def replace_tracks(self, playlist_id, track_ids):
        self.playlists[playlist_id] = list(track_ids)


def test_upload_creates_playlist_and_matches_by_isrc():
    service = FakeService(
        "spotify",
        catalog=[Candidate(id="sp1", title="Breathe", artist="The Prodigy", isrc="GBAAA9700003")],
    )
    playlist = Playlist(
        title="Long Drives",
        tracks=[Track(title="Breathe", creator="The Prodigy", isrc="GBAAA9700003")],
    )

    report = upload(playlist, service)

    assert report.created_playlist is True
    assert service.playlists[report.playlist_id] == ["sp1"]
    assert report.unmatched == []


def test_upload_reuses_existing_same_named_playlist():
    service = FakeService("spotify", playlists={"existing": ["old-track"]})
    service.titles["existing"] = "Long Drives"
    playlist = Playlist(title="Long Drives", tracks=[])

    report = upload(playlist, service)

    assert report.created_playlist is False
    assert report.playlist_id == "existing"
    assert service.playlists["existing"] == []  # replaced, not appended to


def test_upload_reports_unmatched_tracks_without_failing():
    service = FakeService("spotify", catalog=[])
    playlist = Playlist(
        title="Long Drives", tracks=[Track(title="Nonexistent Song", creator="Nobody")]
    )

    report = upload(playlist, service)

    assert len(report.unmatched) == 1
    assert report.unmatched[0].track.title == "Nonexistent Song"


def test_download_pulls_live_tracks_into_local_format():
    service = FakeService(
        "ytmusic",
        catalog=[Candidate(id="yt1", title="Breathe", artist="The Prodigy", duration=349000)],
        playlists={"PL123": ["yt1"]},
    )

    playlist = download(service, "PL123", title="Long Drives")

    assert playlist.title == "Long Drives"
    assert playlist.playlist_ids.ytmusic == "PL123"
    assert [t.title for t in playlist.tracks] == ["Breathe"]


def test_sync_mirrors_source_onto_every_target():
    source = FakeService(
        "spotify",
        catalog=[Candidate(id="sp1", title="Breathe", artist="The Prodigy", isrc="X")],
        playlists={"src": ["sp1"]},
    )
    source.titles["src"] = "Long Drives"

    target = FakeService(
        "ytmusic",
        catalog=[Candidate(id="yt1", title="Breathe", artist="The Prodigy", isrc="X")],
    )

    canonical, reports = sync(source, "src", [target], title="Long Drives")

    assert canonical.title == "Long Drives"
    assert len(reports) == 1
    assert target.playlists[reports[0].playlist_id] == ["yt1"]


def test_sync_target_with_no_catalog_match_still_completes_other_tracks():
    source = FakeService(
        "spotify",
        catalog=[
            Candidate(id="sp1", title="Breathe", artist="The Prodigy", isrc="X"),
            Candidate(id="sp2", title="Obscure B-Side", artist="The Prodigy", isrc="Y"),
        ],
        playlists={"src": ["sp1", "sp2"]},
    )
    source.titles["src"] = "Long Drives"

    target = FakeService(
        "ytmusic",
        catalog=[Candidate(id="yt1", title="Breathe", artist="The Prodigy", isrc="X")],
    )

    _, reports = sync(source, "src", [target], title="Long Drives")

    report = reports[0]
    assert len(report.unmatched) == 1
    assert target.playlists[report.playlist_id] == ["yt1"]
