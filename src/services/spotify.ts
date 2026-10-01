/**
 * Spotify backend, via the Spotify Web API (REST) directly — no SDK needed.
 *
 * Auth is Authorization Code + PKCE, so only a client ID is needed (no
 * client secret to protect) and the one-time setup is:
 *
 *   1. Create an app at https://developer.spotify.com/dashboard
 *      (redirect URI: http://127.0.0.1:8765/callback)
 *   2. Put SPOTIFY_CLIENT_ID=<app client id> in ~/.config/music-sync/spotify.env
 *   3. music-sync auth spotify   # opens a browser, one-time consent
 *
 * Everything after that is unattended: the refresh token is cached and
 * renewed automatically.
 */

import { randomBytes, createHash } from "node:crypto";
import { createServer } from "node:http";
import { exec } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { Candidate } from "../matcher.js";
import { AuthRequired, type MusicService } from "./base.js";
import { SPOTIFY_ENV, SPOTIFY_TOKEN_CACHE, loadEnvFile } from "../config.js";

const SCOPES = "playlist-read-private playlist-modify-private playlist-modify-public user-read-private";
const REDIRECT_URI = "http://127.0.0.1:8765/callback";
const AUTH_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const API_BASE = "https://api.spotify.com/v1";

export const AUTH_INSTRUCTIONS =
  `1) create an app at https://developer.spotify.com/dashboard with redirect URI ` +
  `${REDIRECT_URI}, 2) put SPOTIFY_CLIENT_ID=<id> in ~/.config/music-sync/spotify.env, ` +
  `3) run \`music-sync auth spotify\``;

interface TokenCache {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
}

function clientId(): string | undefined {
  return loadEnvFile(SPOTIFY_ENV).SPOTIFY_CLIENT_ID;
}

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function readCache(): TokenCache | null {
  if (!existsSync(SPOTIFY_TOKEN_CACHE)) return null;
  return JSON.parse(readFileSync(SPOTIFY_TOKEN_CACHE, "utf-8"));
}

function writeCache(cache: TokenCache): void {
  writeFileSync(SPOTIFY_TOKEN_CACHE, JSON.stringify(cache, null, 2));
}

async function refreshAccessToken(id: string, refreshToken: string): Promise<TokenCache> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: id,
    }),
  });
  if (!res.ok) throw new Error(`spotify token refresh failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  const cache: TokenCache = {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? refreshToken,
    expires_at: Date.now() + data.expires_in * 1000 - 60_000,
  };
  writeCache(cache);
  return cache;
}

async function runPkceLogin(id: string): Promise<TokenCache> {
  const verifier = base64url(randomBytes(64)).slice(0, 128);
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(16));

  const authUrl = new URL(AUTH_URL);
  authUrl.search = new URLSearchParams({
    client_id: id,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    code_challenge_method: "S256",
    code_challenge: challenge,
    scope: SCOPES,
    state,
  }).toString();

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "", REDIRECT_URI);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      const returnedCode = url.searchParams.get("code");
      res.writeHead(200, { "Content-Type": "text/plain" });
      if (error || returnedState !== state || !returnedCode) {
        res.end("Spotify auth failed, check the terminal.");
        server.close();
        reject(new Error(error ?? "state mismatch or missing code"));
        return;
      }
      res.end("Spotify auth complete, you can close this tab.");
      server.close();
      resolve(returnedCode);
    });
    server.listen(8765, "127.0.0.1", () => {
      exec(`open "${authUrl.toString()}"`);
      console.error(`Opening browser for Spotify consent. If it didn't open:\n${authUrl}`);
    });
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: id,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(`spotify token exchange failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  const cache: TokenCache = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000 - 60_000,
  };
  writeCache(cache);
  return cache;
}

export class SpotifyService implements MusicService {
  readonly name = "spotify" as const;

  private async accessToken(): Promise<string> {
    const id = clientId();
    if (!id) throw new AuthRequired("spotify", AUTH_INSTRUCTIONS);
    let cache = readCache();
    if (!cache) throw new AuthRequired("spotify", AUTH_INSTRUCTIONS);
    if (Date.now() >= cache.expires_at) cache = await refreshAccessToken(id, cache.refresh_token);
    return cache.access_token;
  }

  private async api(path: string, init: RequestInit = {}): Promise<any> {
    const token = await this.accessToken();
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    if (!res.ok) throw new Error(`spotify api ${path} failed: ${res.status} ${await res.text()}`);
    if (res.status === 204) return null;
    return res.json();
  }

  async isAuthenticated(): Promise<boolean> {
    try {
      await this.api("/me");
      return true;
    } catch {
      return false;
    }
  }

  async authenticate(): Promise<void> {
    const id = clientId();
    if (!id) throw new AuthRequired("spotify", AUTH_INSTRUCTIONS);
    await runPkceLogin(id);
  }

  private candidateFromTrack(item: any): Candidate {
    return {
      id: item.id,
      title: item.name,
      artist: (item.artists ?? []).map((a: any) => a.name).join(", "),
      album: item.album?.name,
      duration: item.duration_ms,
      isrc: item.external_ids?.isrc,
    };
  }

  async search(title: string, artist: string, limit = 5): Promise<Candidate[]> {
    const q = encodeURIComponent(`track:${title} artist:${artist}`);
    const data = await this.api(`/search?q=${q}&type=track&limit=${limit}`);
    return data.tracks.items.map((t: any) => this.candidateFromTrack(t));
  }

  async getPlaylistTracks(playlistId: string): Promise<Candidate[]> {
    const out: Candidate[] = [];
    let next: string | null = `/playlists/${playlistId}/items?limit=100`;
    while (next) {
      const data: any = await this.api(next);
      for (const item of data.items) {
        if (item.track?.id) out.push(this.candidateFromTrack(item.track));
      }
      next = data.next ? data.next.slice(API_BASE.length) : null;
    }
    return out;
  }

  async findPlaylistByName(name: string): Promise<string | null> {
    let next: string | null = "/me/playlists?limit=50";
    while (next) {
      const data: any = await this.api(next);
      for (const p of data.items) {
        if (p.name.toLowerCase() === name.toLowerCase()) return p.id;
      }
      next = data.next ? data.next.slice(API_BASE.length) : null;
    }
    return null;
  }

  async createPlaylist(title: string, description = ""): Promise<string> {
    // POST /users/{id}/playlists was removed in Spotify's February 2026 API
    // overhaul (confirmed live: it now 403s even for a Premium, allow-listed
    // account) in favor of this one, which no longer needs the user id at all.
    const playlist = await this.api("/me/playlists", {
      method: "POST",
      body: JSON.stringify({ name: title, public: false, description }),
    });
    return playlist.id;
  }

  async addTracks(playlistId: string, trackIds: string[]): Promise<void> {
    const uris = trackIds.map((id) => `spotify:track:${id}`);
    for (let i = 0; i < uris.length; i += 100) {
      await this.api(`/playlists/${playlistId}/items`, {
        method: "POST",
        body: JSON.stringify({ uris: uris.slice(i, i + 100) }),
      });
    }
  }

  async replaceTracks(playlistId: string, trackIds: string[]): Promise<void> {
    const uris = trackIds.map((id) => `spotify:track:${id}`);
    await this.api(`/playlists/${playlistId}/items`, {
      method: "PUT",
      body: JSON.stringify({ uris: uris.slice(0, 100) }),
    });
    for (let i = 100; i < uris.length; i += 100) {
      await this.api(`/playlists/${playlistId}/items`, {
        method: "POST",
        body: JSON.stringify({ uris: uris.slice(i, i + 100) }),
      });
    }
  }
}
