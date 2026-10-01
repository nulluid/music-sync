import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadPlaylist, newPlaylist, newTrack, playlistToJspf, savePlaylist } from "../src/format.js";

describe("track round-trips through JSPF", () => {
  it("preserves isrc and per-service ids in the extension block", () => {
    const track = newTrack({
      title: "Breathe",
      creator: "The Prodigy",
      album: "The Fat of the Land",
      duration: 349000,
      isrc: "GBAAA9700003",
      serviceIds: { spotify: "2tnVG71enUj4Yc8JEa0W5A" },
    });

    const playlist = newPlaylist({ title: "x", tracks: [track] });
    const jspf: any = playlistToJspf(playlist);
    const trackJspf = jspf.playlist.track[0];

    expect(trackJspf.extension["https://music.smathe.rs/ns#"].isrc).toBe("GBAAA9700003");
    expect(trackJspf.extension["https://music.smathe.rs/ns#"].spotify.id).toBe("2tnVG71enUj4Yc8JEa0W5A");
  });
});

describe("playlist round-trips through a file and is valid JSON", () => {
  it("saves and reloads to an equivalent playlist", () => {
    const playlist = newPlaylist({
      title: "Long Drives",
      sourceOfTruth: "spotify",
      tracks: [
        newTrack({ title: "A", creator: "Artist A" }),
        newTrack({ title: "B", creator: "Artist B" }),
      ],
    });
    playlist.playlistIds.spotify = "abc123";

    const dir = mkdtempSync(join(tmpdir(), "music-sync-test-"));
    const path = join(dir, "playlist.jspf.json");
    savePlaylist(playlist, path);

    const raw = JSON.parse(readFileSync(path, "utf-8"));
    expect(raw.playlist.title).toBe("Long Drives");
    expect(raw.playlist.track).toHaveLength(2);

    const restored = loadPlaylist(path);
    expect(restored).toEqual(playlist);
  });
});

describe("playlist without extension data", () => {
  it("omits the extension block entirely", () => {
    const playlist = newPlaylist({ title: "Bare", tracks: [newTrack({ title: "A", creator: "Artist A" })] });
    const jspf: any = playlistToJspf(playlist);
    expect(jspf.playlist.extension).toBeUndefined();
    expect(jspf.playlist.track[0].extension).toBeUndefined();
  });
});
