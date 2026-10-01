import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { newTrack } from "../src/format.js";

let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "music-sync-cache-test-"));
  process.env.MUSIC_SYNC_CONFIG_DIR = dir;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.MUSIC_SYNC_CONFIG_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("match cache", () => {
  it("returns undefined for a track that's never been cached", async () => {
    const { getCached } = await import("../src/matchCache.js");
    const track = newTrack({ title: "Breathe", creator: "The Prodigy" });
    expect(getCached(track, "spotify")).toBeUndefined();
  });

  it("round-trips a positive match", async () => {
    const { getCached, setCached } = await import("../src/matchCache.js");
    const track = newTrack({ title: "Breathe", creator: "The Prodigy", isrc: "GBAAA9700003" });
    setCached(track, "spotify", "2tnVG71enUj4Yc8JEa0W5A");
    expect(getCached(track, "spotify")).toBe("2tnVG71enUj4Yc8JEa0W5A");
  });

  it("round-trips a fresh negative match as null, not undefined", async () => {
    const { getCached, setCached } = await import("../src/matchCache.js");
    const track = newTrack({ title: "Totally Obscure B-Side", creator: "Nobody" });
    setCached(track, "ytmusic", null);
    expect(getCached(track, "ytmusic")).toBeNull();
  });

  it("expires a negative match after the TTL so it gets retried", async () => {
    const { getCached, setCached } = await import("../src/matchCache.js");
    const track = newTrack({ title: "Maybe Released Since", creator: "Some Artist" });
    setCached(track, "ytmusic", null);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000); // 25h later, past the 24h TTL
    try {
      expect(getCached(track, "ytmusic")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keys by ISRC rather than title/artist when both tracks share one", async () => {
    const { getCached, setCached } = await import("../src/matchCache.js");
    const original = newTrack({ title: "Breathe", creator: "The Prodigy", isrc: "GBAAA9700003" });
    setCached(original, "spotify", "abc123");

    const renamedSameRecording = newTrack({
      title: "Breathe (Remastered)",
      creator: "Prodigy, The",
      isrc: "GBAAA9700003",
    });
    expect(getCached(renamedSameRecording, "spotify")).toBe("abc123");
  });

  it("keeps each service's cache entry independent", async () => {
    const { getCached, setCached } = await import("../src/matchCache.js");
    const track = newTrack({ title: "Breathe", creator: "The Prodigy", isrc: "GBAAA9700003" });
    setCached(track, "spotify", "sp-id");
    expect(getCached(track, "ytmusic")).toBeUndefined();
    expect(getCached(track, "spotify")).toBe("sp-id");
  });
});
