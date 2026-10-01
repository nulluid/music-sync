/**
 * Match a Track against a service's search results.
 *
 * ISRC match is exact and wins outright. Falling back to fuzzy title/artist
 * is necessary because free-text search (YouTube Data API v3, and Amazon
 * Music's search UI) doesn't return ISRCs — see SPEC.md.
 */

import type { Track } from "./format.js";

export const DURATION_TOLERANCE_MS = 3000;
export const FUZZY_ACCEPT_THRESHOLD = 85;

export interface Candidate {
  id: string;
  title: string;
  artist: string;
  album?: string;
  duration?: number; // milliseconds
  isrc?: string;
}

export interface MatchResult {
  candidate: Candidate | null;
  confidence: number; // 0-100
  method: "isrc" | "fuzzy" | "none";
}

const NOISE_WORDS = new Set([
  "official",
  "audio",
  "video",
  "lyric",
  "lyrics",
  "visualizer",
  "hd",
  "hq",
  "remastered",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/feat\./g, "feat")
    .replace(/[([][^)\]]*[)\]]/g, " ") // strip "(...)" / "[...]" suffixes like [Official Audio]
    .split(/[^a-z0-9']+/)
    .filter((t) => t && !NOISE_WORDS.has(t));
}

function levenshtein(a: string, b: string): number {
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prevDiag = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = dp[j];
      dp[j] =
        a[i - 1] === b[j - 1]
          ? prevDiag
          : 1 + Math.min(prevDiag, dp[j], dp[j - 1]);
      prevDiag = temp;
    }
  }
  return dp[b.length];
}

function ratio(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 100;
  return (1 - levenshtein(a, b) / maxLen) * 100;
}

/**
 * 0-100 similarity that doesn't penalize one side for carrying extra words —
 * essential for YouTube video titles like "Artist - Track [Official Audio]"
 * against a clean "Track" title, where plain edit distance scores low just
 * because the strings are different lengths.
 */
function tokenSetRatio(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  const intersection = [...setA].filter((t) => setB.has(t)).sort().join(" ");
  const onlyA = [...setA].filter((t) => !setB.has(t)).sort().join(" ");
  const onlyB = [...setB].filter((t) => !setA.has(t)).sort().join(" ");
  const combinedA = [intersection, onlyA].filter(Boolean).join(" ");
  const combinedB = [intersection, onlyB].filter(Boolean).join(" ");
  return Math.max(ratio(intersection, combinedA), ratio(intersection, combinedB), ratio(combinedA, combinedB));
}

export function match(track: Track, candidates: Candidate[]): MatchResult {
  if (track.isrc) {
    const exact = candidates.find((c) => c.isrc && c.isrc === track.isrc);
    if (exact) return { candidate: exact, confidence: 100, method: "isrc" };
  }

  let best: Candidate | null = null;
  let bestScore = 0;

  for (const c of candidates) {
    if (
      track.duration !== undefined &&
      c.duration !== undefined &&
      Math.abs(track.duration - c.duration) > DURATION_TOLERANCE_MS
    ) {
      continue;
    }
    const titleScore = tokenSetRatio(track.title, c.title);
    const artistScore = tokenSetRatio(track.creator, c.artist);
    const score = 0.6 * titleScore + 0.4 * artistScore;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }

  if (best && bestScore >= FUZZY_ACCEPT_THRESHOLD) {
    return { candidate: best, confidence: bestScore, method: "fuzzy" };
  }
  return { candidate: null, confidence: bestScore, method: "none" };
}
