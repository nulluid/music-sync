/**
 * Cross-run cache of track matches, keyed by ISRC (preferred) or normalized
 * title+artist. Without this, every sync run re-searches every track on
 * every target service from scratch — fatal for YouTube Data API v3's
 * search quota (100 units per call, a few thousand units/day by default:
 * confirmed live, a 26-track playlist alone can burn the daily allowance).
 * A negative match (nothing found) is cached too, but expires after a day
 * so a track that's merely missing from the catalog *today* gets retried
 * rather than permanently written off.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { Service, Track } from "./format.js";
import { pathFor } from "./config.js";

const CACHE_FILE = pathFor("match-cache.json");
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry {
  id: string | null;
  cachedAt: string; // ISO timestamp
}

type Cache = Record<string, Partial<Record<Service, CacheEntry>>>;

function normalize(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, " ");
}

function keyFor(track: Track): string {
  return track.isrc ? `isrc:${track.isrc}` : `ta:${normalize(track.title)}|${normalize(track.creator)}`;
}

function load(): Cache {
  if (!existsSync(CACHE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function save(cache: Cache): void {
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + "\n");
}

/** Returns a cached id (string) or confirmed-absent (null), or undefined if there's nothing usable cached. */
export function getCached(track: Track, service: Service): string | null | undefined {
  const entry = load()[keyFor(track)]?.[service];
  if (!entry) return undefined;
  if (entry.id === null && Date.now() - Date.parse(entry.cachedAt) > NEGATIVE_TTL_MS) return undefined;
  return entry.id;
}

export function setCached(track: Track, service: Service, id: string | null): void {
  const cache = load();
  const key = keyFor(track);
  cache[key] = { ...cache[key], [service]: { id, cachedAt: new Date().toISOString() } };
  save(cache);
}
