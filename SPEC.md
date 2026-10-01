# Playlist format

music-sync stores every playlist as JSPF (JSON Playlist Format, the JSON
sibling of the XSPF standard: https://www.xspf.org/jspf/). JSPF already
covers title, creator, track order, duration, and per-track `identifier`
URIs, which is most of what a cross-service sync needs.

It has no field for "this track's ID on three different streaming
services", so each track carries one additional namespaced extension block,
which is exactly what the JSPF spec's `extension` field is for.

## Example

```json
{
  "playlist": {
    "title": "Long Drives",
    "creator": "jason",
    "date": "2026-10-01T00:00:00Z",
    "extension": {
      "https://music.smathe.rs/ns#": {
        "sourceOfTruth": "spotify",
        "serviceIds": {
          "spotify": "37i9dQZF1DXcBWIGoYBM5M",
          "ytmusic": "PLrAl6rYgs4IvGFBDEaVGFCoYFjjXK1DIB",
          "amazon": "f571a2b3-...-playlist"
        }
      }
    },
    "track": [
      {
        "title": "Breathe",
        "creator": "The Prodigy",
        "album": "The Fat of the Land",
        "duration": 349000,
        "identifier": [
          "urn:isrc:GBAAA9700003",
          "spotify:track:2tnVG71enUj4Yc8JEa0W5A"
        ],
        "extension": {
          "https://music.smathe.rs/ns#": {
            "isrc": "GBAAA9700003",
            "spotify": { "id": "2tnVG71enUj4Yc8JEa0W5A" },
            "ytmusic": { "id": "k0BWlvnBmIE" }
          }
        }
      }
    ]
  }
}
```

## Why ISRC is the primary match key

Title/artist string matching is what breaks in every playlist-transfer tool
(remasters, "feat." formatting, live versions). An ISRC is the one
cross-service identifier that means the same recording everywhere.
`matcher.ts` tries ISRC first and falls back to normalized title + artist +
duration-within-3-seconds only when a service doesn't expose ISRC in search
results. Spotify's Web API returns ISRC directly, so Spotify round-trips are
reliable. YouTube Music playlists are managed through the official YouTube
Data API v3 (search.list never returns ISRC) and Amazon Music through
browser automation against the web UI (no ISRC either), so both are always
fuzzy matches — the weak link in any sync.

## File extension

`.jspf.json` on disk, so editors and `file(1)` get the JSON hint without
losing the JSPF name.
