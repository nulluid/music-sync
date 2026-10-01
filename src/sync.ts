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
}

export function unmatched(report: ServiceReport): TrackResult[] {
  return report.results.filter((r) => r.status === "unmatched");
}

async function resolveTrackId(service: MusicService, track: Track): Promise<TrackResult> {
  const existing = track.serviceIds[service.name];
  if (existing) {
    return { track, service: service.name, status: "matched", confidence: 100, serviceTrackId: existing };
  }

  const candidates = await service.search(track.title, track.creator);
  const result = match(track, candidates);
  if (!result.candidate) {
    return { track, service: service.name, status: "unmatched", confidence: result.confidence, serviceTrackId: null };
  }
  const status = result.method === "isrc" ? "matched" : "fuzzy_matched";
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
    reports.push(await upload(canonical, target));
  }
  return { canonical, reports };
}
