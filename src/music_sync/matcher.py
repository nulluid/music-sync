"""Match a Track against a service's search results.

ISRC match is exact and wins outright. Falling back to fuzzy title/artist
is necessary because YouTube Music's public search does not return ISRCs
(see SPEC.md).
"""

from __future__ import annotations

from dataclasses import dataclass

from rapidfuzz import fuzz

from music_sync.format import Track

DURATION_TOLERANCE_MS = 3000
FUZZY_ACCEPT_THRESHOLD = 85


@dataclass
class Candidate:
    id: str
    title: str
    artist: str
    album: str | None = None
    duration: int | None = None  # milliseconds
    isrc: str | None = None


@dataclass
class MatchResult:
    candidate: Candidate | None
    confidence: float  # 0-100
    method: str  # "isrc" | "fuzzy" | "none"


def _normalize(text: str) -> str:
    return " ".join(text.lower().replace("feat.", "feat").split())


def match(track: Track, candidates: list[Candidate]) -> MatchResult:
    if track.isrc:
        for c in candidates:
            if c.isrc and c.isrc == track.isrc:
                return MatchResult(candidate=c, confidence=100.0, method="isrc")

    best: Candidate | None = None
    best_score = 0.0
    target_title = _normalize(track.title)
    target_artist = _normalize(track.creator)

    for c in candidates:
        if track.duration is not None and c.duration is not None:
            if abs(track.duration - c.duration) > DURATION_TOLERANCE_MS:
                continue
        title_score = fuzz.token_sort_ratio(target_title, _normalize(c.title))
        artist_score = fuzz.token_sort_ratio(target_artist, _normalize(c.artist))
        score = 0.6 * title_score + 0.4 * artist_score
        if score > best_score:
            best_score = score
            best = c

    if best is not None and best_score >= FUZZY_ACCEPT_THRESHOLD:
        return MatchResult(candidate=best, confidence=best_score, method="fuzzy")

    return MatchResult(candidate=None, confidence=best_score, method="none")
