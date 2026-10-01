/**
 * Common interface every service backend implements.
 *
 * sync.ts and cli.ts only talk to this interface, never to a specific
 * backend, so adding a fourth service later is a new services/*.ts file
 * and one line in services/index.ts.
 */

import type { Candidate } from "../matcher.js";
import type { Service } from "../format.js";

export class AuthRequired extends Error {
  readonly service: Service;
  readonly instructions: string;

  constructor(service: Service, instructions: string) {
    super(`${service} needs auth: ${instructions}`);
    this.service = service;
    this.instructions = instructions;
  }
}

export interface MusicService {
  readonly name: Service;

  /** Cheap check (no network call that can hang) for stored auth. */
  isAuthenticated(): Promise<boolean>;

  /** Run the one-time interactive login, if this service has one. */
  authenticate(): Promise<void>;

  search(title: string, artist: string, limit?: number): Promise<Candidate[]>;

  getPlaylistTracks(playlistId: string): Promise<Candidate[]>;

  /** Exact (case-insensitive) title match, or null. */
  findPlaylistByName(name: string): Promise<string | null>;

  createPlaylist(title: string, description?: string): Promise<string>;

  addTracks(playlistId: string, trackIds: string[]): Promise<void>;

  /** Replace a playlist's contents with exactly this ordered list. */
  replaceTracks(playlistId: string, trackIds: string[]): Promise<void>;
}
