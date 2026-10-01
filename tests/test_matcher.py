from music_sync.format import Track
from music_sync.matcher import Candidate, match


def test_isrc_match_wins_even_with_different_title_formatting():
    track = Track(title="Breathe", creator="The Prodigy", isrc="GBAAA9700003")
    candidates = [
        Candidate(id="1", title="Breathe (Remastered)", artist="Prodigy, The", isrc="GBAAA9700003"),
        Candidate(id="2", title="Breathe", artist="The Prodigy", isrc="US1234567890"),
    ]
    result = match(track, candidates)
    assert result.method == "isrc"
    assert result.candidate.id == "1"
    assert result.confidence == 100.0


def test_fuzzy_match_falls_back_without_isrc():
    track = Track(title="Breathe", creator="The Prodigy", duration=349000)
    candidates = [
        Candidate(id="1", title="Breathe", artist="The Prodigy", duration=349000),
        Candidate(id="2", title="Firestarter", artist="The Prodigy", duration=200000),
    ]
    result = match(track, candidates)
    assert result.method == "fuzzy"
    assert result.candidate.id == "1"


def test_duration_mismatch_excludes_a_candidate():
    track = Track(title="Breathe", creator="The Prodigy", duration=349000)
    candidates = [Candidate(id="1", title="Breathe", artist="The Prodigy", duration=100000)]
    result = match(track, candidates)
    assert result.candidate is None
    assert result.method == "none"


def test_no_good_candidate_returns_none_not_a_bad_guess():
    track = Track(title="Breathe", creator="The Prodigy")
    candidates = [Candidate(id="1", title="Firestarter", artist="The Prodigy")]
    result = match(track, candidates)
    assert result.candidate is None
    assert result.method == "none"


def test_empty_candidates_is_safe():
    track = Track(title="Breathe", creator="The Prodigy")
    result = match(track, [])
    assert result.candidate is None
    assert result.confidence == 0.0
