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

function normalize(text: string): string {
  return text.toLowerCase().replace(/feat\./g, "feat").split(/\s+/).filter(Boolean).join(" ");
}

function tokenSort(text: string): string {
  return text.split(" ").filter(Boolean).sort().join(" ");
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

/** 0-100 similarity, order-insensitive (sorts tokens before comparing). */
function tokenSortRatio(a: string, b: string): number {
  const sa = tokenSort(normalize(a));
  const sb = tokenSort(normalize(b));
  const maxLen = Math.max(sa.length, sb.length);
  if (maxLen === 0) return 100;
  return (1 - levenshtein(sa, sb) / maxLen) * 100;
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
    const titleScore = tokenSortRatio(track.title, c.title);
    const artistScore = tokenSortRatio(track.creator, c.artist);
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
