import json

from music_sync.format import Playlist, Track


def test_track_round_trips_through_jspf():
    track = Track(
        title="Breathe",
        creator="The Prodigy",
        album="The Fat of the Land",
        duration=349000,
        isrc="GBAAA9700003",
    )
    track.service_ids.spotify = "2tnVG71enUj4Yc8JEa0W5A"

    jspf = track.to_jspf()
    assert jspf["extension"]["https://music.smathe.rs/ns#"]["isrc"] == "GBAAA9700003"
    assert jspf["extension"]["https://music.smathe.rs/ns#"]["spotify"]["id"] == (
        "2tnVG71enUj4Yc8JEa0W5A"
    )

    restored = Track.from_jspf(jspf)
    assert restored == track


def test_playlist_round_trips_and_is_valid_json(tmp_path):
    playlist = Playlist(
        title="Long Drives",
        source_of_truth="spotify",
        tracks=[Track(title="A", creator="Artist A"), Track(title="B", creator="Artist B")],
    )
    playlist.playlist_ids.spotify = "abc123"

    path = tmp_path / "playlist.jspf.json"
    playlist.save(path)

    raw = json.loads(path.read_text())
    assert raw["playlist"]["title"] == "Long Drives"
    assert len(raw["playlist"]["track"]) == 2

    restored = Playlist.load(path)
    assert restored == playlist


def test_playlist_without_extension_data_omits_extension_block():
    playlist = Playlist(title="Bare", tracks=[Track(title="A", creator="Artist A")])
    jspf = playlist.to_jspf()
    assert "extension" not in jspf["playlist"]
    assert "extension" not in jspf["playlist"]["track"][0]
