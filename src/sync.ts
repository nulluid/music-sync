/**
 * Upload, download, and sync orchestration.
 *
 * These functions only depend on the MusicService interface
 * (services/base.ts) and the Playlist/Track model (format.ts), never on a
 * specific backend, so it's the same code path for Spotify, YouTube Music,
 * and Amazon Music.
 */

import { newPlaylist, newTrack, type Playlist, type Service, type Track } from "./format.js";
import { match, type Candidate } from "./matcher.js";
import { getCached, setCached } from "./matchCache.js";
import type { MusicService } from "./services/base.js";

export interface TrackResult {
  track: Track;
  service: Service;
  status: "matched" | "fuzzy_matched" | "unmatched";
  confidence: number;
  serviceTrackId: string | null;
}

export interface ServiceReport {
  service: Service;
  playlistId: string;
  createdPlaylist: boolean;
  results: TrackResult[];
  /** Set when this target failed outright (e.g. Amazon Music selector broke) — the
   *  other fields are empty placeholders in that case, not a real result. */
  error?: string;
}

export function unmatched(report: ServiceReport): TrackResult[] {
  return report.results.filter((r) => r.status === "unmatched");
}

const FEATURED_ARTIST = /\s+(feat\.?|ft\.?|featuring)\s+.+$/i;

async function searchWithFallback(service: MusicService, track: Track): Promise<Candidate[]> {
  try {
    const candidates = await service.search(track.title, track.creator);
    if (candidates.length > 0) return candidates;
  } catch {
    // fall through to the retry below rather than aborting
  }
  // Some services (confirmed on Spotify: a strict artist: field filter) return
  // nothing for "Zac Brown Band feat. Chris Cornell" as a literal artist string,
  // since the featured artist is credited separately, not part of the name.
  // Retrying with just the primary artist recovers these.
  const primaryArtist = track.creator.replace(FEATURED_ARTIST, "").trim();
  if (primaryArtist === track.creator) return [];
  // Unlike the first attempt, a failure here must propagate: resolveTrackId
  // needs to tell "genuinely searched, found nothing" (safe to cache as a
  // negative match) apart from "the search itself failed" (quota, network —
  // must not poison the cache with a false negative).
  return service.search(track.title, primaryArtist);
}

async function resolveTrackId(service: MusicService, track: Track): Promise<TrackResult> {
  const existing = track.serviceIds[service.name];
  if (existing) {
    return { track, service: service.name, status: "matched", confidence: 100, serviceTrackId: existing };
  }

  // Avoid re-searching on every run (fatal for YouTube Data API v3's search
  // quota under the scheduler — see matchCache.ts) by reusing a prior match,
  // positive or negative, for this exact track on this service.
  const cached = getCached(track, service.name);
  if (cached !== undefined) {
    return cached === null
      ? { track, service: service.name, status: "unmatched", confidence: 0, serviceTrackId: null }
      : { track, service: service.name, status: "matched", confidence: 100, serviceTrackId: cached };
  }

  // A single track's search failing (rate limit, transient 5xx) must not abort
  // the other 25 in the same Promise.all batch, and must not cache a false
  // negative — report unmatched for this run only, retry next time.
  let candidates: Candidate[];
  try {
    candidates = await searchWithFallback(service, track);
  } catch {
    return { track, service: service.name, status: "unmatched", confidence: 0, serviceTrackId: null };
  }
  const result = match(track, candidates);
  if (!result.candidate) {
    setCached(track, service.name, null);
    return { track, service: service.name, status: "unmatched", confidence: result.confidence, serviceTrackId: null };
  }
  const status = result.method === "isrc" ? "matched" : "fuzzy_matched";
  setCached(track, service.name, result.candidate.id);
  return { track, service: service.name, status, confidence: result.confidence, serviceTrackId: result.candidate.id };
}

/** Create (or reuse an existing, same-named) playlist on `service` and fill it. */
export async function upload(playlist: Playlist, service: MusicService): Promise<ServiceReport> {
  let playlistId =
    playlist.playlistIds[service.name] ?? (await service.findPlaylistByName(playlist.title));
  let created = false;
  if (!playlistId) {
    playlistId = await service.createPlaylist(playlist.title, playlist.annotation ?? "");
    created = true;
  }

  const results = await Promise.all(playlist.tracks.map((t) => resolveTrackId(service, t)));
  const trackIds = results.map((r) => r.serviceTrackId).filter((id): id is string => id !== null);

  if (created) await service.addTracks(playlistId, trackIds);
  else await service.replaceTracks(playlistId, trackIds);

  return { service: service.name, playlistId, createdPlaylist: created, results };
}

function trackFromCandidate(c: Candidate): Track {
  return newTrack({ title: c.title, creator: c.artist, album: c.album, duration: c.duration, isrc: c.isrc });
}

/** Pull a playlist's current contents from `service` into the local format. */
export async function download(
  service: MusicService,
  playlistId: string,
  title?: string
): Promise<Playlist> {
  const candidates = await service.getPlaylistTracks(playlistId);
  const playlist = newPlaylist({ title: title ?? playlistId, tracks: candidates.map(trackFromCandidate) });
  playlist.playlistIds[service.name] = playlistId;
  return playlist;
}

/**
 * Mirror `sourceService`'s playlist onto every service in `targetServices`.
 *
 * The source is read fresh from the live service on every call — it is the
 * source of truth, so there is nothing to merge, only to overwrite the
 * targets with.
 */
export async function sync(
  sourceService: MusicService,
  sourcePlaylistId: string,
  targetServices: MusicService[],
  title?: string
): Promise<{ canonical: Playlist; reports: ServiceReport[] }> {
  const canonical = await download(sourceService, sourcePlaylistId, title);
  const reports: ServiceReport[] = [];
  for (const target of targetServices) {
    try {
      reports.push(await upload(canonical, target));
    } catch (e) {
      // One target failing (a broken Amazon Music selector, a revoked token) must
      // not stop the others from syncing — each target is independent.
      reports.push({
        service: target.name,
        playlistId: "",
        createdPlaylist: false,
        results: [],
        error: (e as Error).message,
      });
    }
  }
  return { canonical, reports };
}
