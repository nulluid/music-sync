import { describe, expect, it } from "vitest";

import { newPlaylist, newTrack, type Service } from "../src/format.js";
import type { Candidate } from "../src/matcher.js";
import type { MusicService } from "../src/services/base.js";
import { download, sync, upload, unmatched } from "../src/sync.js";

/** In-memory stand-in for a real backend, used by every sync.ts test. */
class FakeService implements MusicService {
  readonly name: Service;
  catalog: Candidate[];
  playlists: Record<string, string[]> = {};
  titles: Record<string, string> = {};
  private nextId = 1;

  constructor(name: Service, catalog: Candidate[] = [], playlists: Record<string, string[]> = {}) {
    this.name = name;
    this.catalog = catalog;
    this.playlists = { ...playlists };
  }

  async isAuthenticated() {
    return true;
  }
  async authenticate() {}

  async search(title: string, artist: string, limit = 5) {
    return this.catalog.filter((c) => c.title === title && c.artist === artist).slice(0, limit);
  }

  async getPlaylistTracks(playlistId: string) {
    const ids = this.playlists[playlistId];
    const byId = new Map(this.catalog.map((c) => [c.id, c]));
    return ids.map((id) => byId.get(id)!);
  }

  async findPlaylistByName(name: string) {
    for (const [pid, title] of Object.entries(this.titles)) {
      if (title.toLowerCase() === name.toLowerCase()) return pid;
    }
    return null;
  }

  async createPlaylist(title: string) {
    const pid = `${this.name}-pl-${this.nextId++}`;
    this.playlists[pid] = [];
    this.titles[pid] = title;
    return pid;
  }

  async addTracks(playlistId: string, trackIds: string[]) {
    this.playlists[playlistId].push(...trackIds);
  }

  async replaceTracks(playlistId: string, trackIds: string[]) {
    this.playlists[playlistId] = [...trackIds];
  }
}

describe("upload", () => {
  it("creates a playlist and matches by isrc", async () => {
    const service = new FakeService("spotify", [
      { id: "sp1", title: "Breathe", artist: "The Prodigy", isrc: "GBAAA9700003" },
    ]);
    const playlist = newPlaylist({
      title: "Long Drives",
      tracks: [newTrack({ title: "Breathe", creator: "The Prodigy", isrc: "GBAAA9700003" })],
    });

    const report = await upload(playlist, service);

    expect(report.createdPlaylist).toBe(true);
    expect(service.playlists[report.playlistId]).toEqual(["sp1"]);
    expect(unmatched(report)).toEqual([]);
  });

  it("reuses an existing same-named playlist instead of creating a new one", async () => {
    const service = new FakeService("spotify", [], { existing: ["old-track"] });
    service.titles.existing = "Long Drives";
    const playlist = newPlaylist({ title: "Long Drives", tracks: [] });

    const report = await upload(playlist, service);

    expect(report.createdPlaylist).toBe(false);
    expect(report.playlistId).toBe("existing");
    expect(service.playlists.existing).toEqual([]); // replaced, not appended to
  });

  it("reports unmatched tracks without failing", async () => {
    const service = new FakeService("spotify", []);
    const playlist = newPlaylist({
      title: "Long Drives",
      tracks: [newTrack({ title: "Nonexistent Song", creator: "Nobody" })],
    });

    const report = await upload(playlist, service);

    expect(unmatched(report)).toHaveLength(1);
    expect(unmatched(report)[0].track.title).toBe("Nonexistent Song");
  });
});

describe("download", () => {
  it("pulls live tracks into the local format", async () => {
    const service = new FakeService(
      "ytmusic",
      [{ id: "yt1", title: "Breathe", artist: "The Prodigy", duration: 349000 }],
      { PL123: ["yt1"] }
    );

    const playlist = await download(service, "PL123", "Long Drives");

    expect(playlist.title).toBe("Long Drives");
    expect(playlist.playlistIds.ytmusic).toBe("PL123");
    expect(playlist.tracks.map((t) => t.title)).toEqual(["Breathe"]);
  });
});

describe("sync", () => {
  it("mirrors the source onto every target", async () => {
    const source = new FakeService(
      "spotify",
      [{ id: "sp1", title: "Breathe", artist: "The Prodigy", isrc: "X" }],
      { src: ["sp1"] }
    );
    source.titles.src = "Long Drives";

    const target = new FakeService("ytmusic", [
      { id: "yt1", title: "Breathe", artist: "The Prodigy", isrc: "X" },
    ]);

    const { canonical, reports } = await sync(source, "src", [target], "Long Drives");

    expect(canonical.title).toBe("Long Drives");
    expect(reports).toHaveLength(1);
    expect(target.playlists[reports[0].playlistId]).toEqual(["yt1"]);
  });

  it("completes the tracks it can match even when a target lacks one", async () => {
    const source = new FakeService(
      "spotify",
      [
        { id: "sp1", title: "Breathe", artist: "The Prodigy", isrc: "X" },
        { id: "sp2", title: "Obscure B-Side", artist: "The Prodigy", isrc: "Y" },
      ],
      { src: ["sp1", "sp2"] }
    );
    source.titles.src = "Long Drives";

    const target = new FakeService("ytmusic", [
      { id: "yt1", title: "Breathe", artist: "The Prodigy", isrc: "X" },
    ]);

    const { reports } = await sync(source, "src", [target], "Long Drives");

    const report = reports[0];
    expect(unmatched(report)).toHaveLength(1);
    expect(target.playlists[report.playlistId]).toEqual(["yt1"]);
  });
});
