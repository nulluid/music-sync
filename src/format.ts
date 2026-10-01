/**
 * JSPF playlist format, extended with a music.smathe.rs namespace block.
 * See SPEC.md for the on-disk shape and why ISRC is the primary match key.
 */

import { readFileSync, writeFileSync } from "node:fs";

export const NS = "https://music.smathe.rs/ns#";
export const SERVICES = ["spotify", "ytmusic", "amazon"] as const;
export type Service = (typeof SERVICES)[number];

export type ServiceIds = Partial<Record<Service, string>>;

export interface Track {
  title: string;
  creator: string; // artist
  album?: string;
  duration?: number; // milliseconds
  trackNum?: number;
  identifier?: string[];
  isrc?: string;
  serviceIds: ServiceIds;
}

export interface Playlist {
  title: string;
  creator?: string;
  annotation?: string;
  date?: string;
  sourceOfTruth?: Service;
  playlistIds: ServiceIds;
  tracks: Track[];
}

export function newTrack(partial: Pick<Track, "title" | "creator"> & Partial<Track>): Track {
  return { serviceIds: {}, ...partial };
}

export function newPlaylist(
  partial: Pick<Playlist, "title"> & Partial<Playlist>
): Playlist {
  return { playlistIds: {}, tracks: [], ...partial };
}

function trackToJspf(track: Track): Record<string, unknown> {
  const ext: Record<string, unknown> = {};
  if (track.isrc) ext.isrc = track.isrc;
  for (const service of SERVICES) {
    const id = track.serviceIds[service];
    if (id) ext[service] = { id };
  }
  const out: Record<string, unknown> = { title: track.title, creator: track.creator };
  if (track.album) out.album = track.album;
  if (track.duration !== undefined) out.duration = track.duration;
  if (track.trackNum !== undefined) out.trackNum = track.trackNum;
  if (track.identifier?.length) out.identifier = track.identifier;
  if (Object.keys(ext).length) out.extension = { [NS]: ext };
  return out;
}

function trackFromJspf(data: Record<string, any>): Track {
  const ext = data.extension?.[NS] ?? {};
  const serviceIds: ServiceIds = {};
  for (const service of SERVICES) {
    const id = ext[service]?.id;
    if (id) serviceIds[service] = id;
  }
  return {
    title: data.title,
    creator: data.creator ?? "",
    album: data.album,
    duration: data.duration,
    trackNum: data.trackNum,
    identifier: data.identifier,
    isrc: ext.isrc,
    serviceIds,
  };
}

export function playlistToJspf(playlist: Playlist): Record<string, unknown> {
  const ext: Record<string, unknown> = {};
  if (playlist.sourceOfTruth) ext.sourceOfTruth = playlist.sourceOfTruth;
  const serviceIds: Record<string, string> = {};
  for (const service of SERVICES) {
    const id = playlist.playlistIds[service];
    if (id) serviceIds[service] = id;
  }
  if (Object.keys(serviceIds).length) ext.serviceIds = serviceIds;

  const out: Record<string, unknown> = { title: playlist.title };
  if (playlist.creator) out.creator = playlist.creator;
  if (playlist.annotation) out.annotation = playlist.annotation;
  if (playlist.date) out.date = playlist.date;
  if (Object.keys(ext).length) out.extension = { [NS]: ext };
  out.track = playlist.tracks.map(trackToJspf);
  return { playlist: out };
}

export function playlistFromJspf(data: Record<string, any>): Playlist {
  const p = data.playlist;
  const ext = p.extension?.[NS] ?? {};
  const playlistIds: ServiceIds = {};
  for (const service of SERVICES) {
    const id = ext.serviceIds?.[service];
    if (id) playlistIds[service] = id;
  }
  return {
    title: p.title,
    creator: p.creator,
    annotation: p.annotation,
    date: p.date,
    sourceOfTruth: ext.sourceOfTruth,
    playlistIds,
    tracks: (p.track ?? []).map(trackFromJspf),
  };
}

export function savePlaylist(playlist: Playlist, path: string): void {
  writeFileSync(path, JSON.stringify(playlistToJspf(playlist), null, 2) + "\n");
}

export function loadPlaylist(path: string): Playlist {
  return playlistFromJspf(JSON.parse(readFileSync(path, "utf-8")));
}
