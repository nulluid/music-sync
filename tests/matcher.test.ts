import { describe, expect, it } from "vitest";

import { newTrack } from "../src/format.js";
import { match, type Candidate } from "../src/matcher.js";

describe("match", () => {
  it("prefers an isrc match even with different title formatting", () => {
    const track = newTrack({ title: "Breathe", creator: "The Prodigy", isrc: "GBAAA9700003" });
    const candidates: Candidate[] = [
      { id: "1", title: "Breathe (Remastered)", artist: "Prodigy, The", isrc: "GBAAA9700003" },
      { id: "2", title: "Breathe", artist: "The Prodigy", isrc: "US1234567890" },
    ];
    const result = match(track, candidates);
    expect(result.method).toBe("isrc");
    expect(result.candidate?.id).toBe("1");
    expect(result.confidence).toBe(100);
  });

  it("falls back to fuzzy matching without an isrc", () => {
    const track = newTrack({ title: "Breathe", creator: "The Prodigy", duration: 349000 });
    const candidates: Candidate[] = [
      { id: "1", title: "Breathe", artist: "The Prodigy", duration: 349000 },
      { id: "2", title: "Firestarter", artist: "The Prodigy", duration: 200000 },
    ];
    const result = match(track, candidates);
    expect(result.method).toBe("fuzzy");
    expect(result.candidate?.id).toBe("1");
  });

  it("excludes a candidate whose duration doesn't match", () => {
    const track = newTrack({ title: "Breathe", creator: "The Prodigy", duration: 349000 });
    const candidates: Candidate[] = [{ id: "1", title: "Breathe", artist: "The Prodigy", duration: 100000 }];
    const result = match(track, candidates);
    expect(result.candidate).toBeNull();
    expect(result.method).toBe("none");
  });

  it("returns none rather than a bad guess", () => {
    const track = newTrack({ title: "Breathe", creator: "The Prodigy" });
    const candidates: Candidate[] = [{ id: "1", title: "Firestarter", artist: "The Prodigy" }];
    const result = match(track, candidates);
    expect(result.candidate).toBeNull();
  });

  it("handles an empty candidate list safely", () => {
    const track = newTrack({ title: "Breathe", creator: "The Prodigy" });
    const result = match(track, []);
    expect(result.candidate).toBeNull();
    expect(result.confidence).toBe(0);
  });
});
