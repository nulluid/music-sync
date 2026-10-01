/**
 * YouTube Music backend, via the official YouTube Data API v3.
 *
 * YouTube Music playlists are stored as ordinary YouTube playlists on the
 * same account, so the documented, fully-supported Data API v3 can create
 * and manage them — no cookie-scraping, no unofficial client, no terms-of-
 * service risk. The trade-off is search quality: `search.list` is general
 * YouTube video search (restricted to the Music category, 10), not the
 * curated "Songs" filter YouTube Music's own app uses, so it occasionally
 * surfaces lyric videos or covers alongside the real track. The ISRC-first,
 * duration-filtered matcher in matcher.ts is what keeps that noise out —
 * YouTube search results never carry an ISRC, so every YouTube Music match
 * is a fuzzy match by construction.
 *
 * One-time setup:
 *
 *   1. Google Cloud Console -> OAuth client, type "TVs and Limited Input
 *      devices" -> note the client ID and secret.
 *   2. Put YTMUSIC_CLIENT_ID=... and YTMUSIC_CLIENT_SECRET=... in
 *      ~/.config/music-sync/ytmusic.env
 *   3. music-sync auth ytmusic   # device-code flow, one-time consent
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { Candidate } from "../matcher.js";
import { AuthRequired, type MusicService } from "./base.js";
import { YTMUSIC_ENV, YTMUSIC_TOKEN_CACHE, loadEnvFile } from "../config.js";

const SCOPE = "https://www.googleapis.com/auth/youtube";
const DEVICE_CODE_URL = "https://oauth2.googleapis.com/device/code";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_BASE = "https://www.googleapis.com/youtube/v3";

export const AUTH_INSTRUCTIONS =
  "1) create a Google Cloud OAuth client of type 'TVs and Limited Input devices', " +
  "2) put YTMUSIC_CLIENT_ID and YTMUSIC_CLIENT_SECRET in ~/.config/music-sync/ytmusic.env, " +
  "3) run `music-sync auth ytmusic`";

interface TokenCache {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

function credentials(): { id: string; secret: string } | null {
  const env = loadEnvFile(YTMUSIC_ENV);
  if (!env.YTMUSIC_CLIENT_ID || !env.YTMUSIC_CLIENT_SECRET) return null;
  return { id: env.YTMUSIC_CLIENT_ID, secret: env.YTMUSIC_CLIENT_SECRET };
}

function readCache(): TokenCache | null {
  if (!existsSync(YTMUSIC_TOKEN_CACHE)) return null;
  return JSON.parse(readFileSync(YTMUSIC_TOKEN_CACHE, "utf-8"));
}

function writeCache(cache: TokenCache): void {
  writeFileSync(YTMUSIC_TOKEN_CACHE, JSON.stringify(cache, null, 2));
}

async function refreshAccessToken(id: string, secret: string, refreshToken: string): Promise<TokenCache> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: id,
      client_secret: secret,
    }),
  });
  if (!res.ok) throw new Error(`ytmusic token refresh failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  const cache: TokenCache = {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? refreshToken,
    expires_at: Date.now() + data.expires_in * 1000 - 60_000,
  };
  writeCache(cache);
  return cache;
}

async function runDeviceCodeLogin(id: string, secret: string): Promise<TokenCache> {
  const res = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: id, scope: SCOPE }),
  });
  if (!res.ok) throw new Error(`device code request failed: ${res.status} ${await res.text()}`);
  const device = (await res.json()) as any;

  console.error(
    `\nGo to ${device.verification_url} and enter this code: ${device.user_code}\n` +
      `Waiting for you to approve...`
  );

  const deadline = Date.now() + device.expires_in * 1000;
  let interval = (device.interval ?? 5) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: id,
        client_secret: secret,
        device_code: device.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const data = (await tokenRes.json()) as any;
    if (tokenRes.ok) {
      const cache: TokenCache = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + data.expires_in * 1000 - 60_000,
      };
      writeCache(cache);
      return cache;
    }
    if (data.error === "slow_down") interval += 5000;
    else if (data.error !== "authorization_pending") {
      throw new Error(`device code auth failed: ${data.error}`);
    }
  }
  throw new Error("device code auth timed out, run `music-sync auth ytmusic` again");
}

/** PT3M45S -> 225000 ms */
function parseIsoDuration(iso: string): number {
  const match = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso);
  const [, h, m, s] = match ?? [];
  return ((Number(h ?? 0) * 60 + Number(m ?? 0)) * 60 + Number(s ?? 0)) * 1000;
}

export class YTMusicService implements MusicService {
  readonly name = "ytmusic" as const;

  private async accessToken(): Promise<string> {
    const creds = credentials();
    if (!creds) throw new AuthRequired("ytmusic", AUTH_INSTRUCTIONS);
    let cache = readCache();
    if (!cache) throw new AuthRequired("ytmusic", AUTH_INSTRUCTIONS);
    if (Date.now() >= cache.expires_at) {
      cache = await refreshAccessToken(creds.id, creds.secret, cache.refresh_token);
    }
    return cache.access_token;
  }

  private async api(path: string, init: RequestInit = {}): Promise<any> {
    const token = await this.accessToken();
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    if (!res.ok) throw new Error(`youtube api ${path} failed: ${res.status} ${await res.text()}`);
    if (res.status === 204) return null;
    return res.json();
  }

  async isAuthenticated(): Promise<boolean> {
    try {
      await this.api("/channels?part=id&mine=true");
      return true;
    } catch {
      return false;
    }
  }

  async authenticate(): Promise<void> {
    const creds = credentials();
    if (!creds) throw new AuthRequired("ytmusic", AUTH_INSTRUCTIONS);
    await runDeviceCodeLogin(creds.id, creds.secret);
  }

  private async durationsFor(videoIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (let i = 0; i < videoIds.length; i += 50) {
      const batch = videoIds.slice(i, i + 50);
      const data = await this.api(`/videos?part=contentDetails&id=${batch.join(",")}`);
      for (const item of data.items) {
        out.set(item.id, parseIsoDuration(item.contentDetails.duration));
      }
    }
    return out;
  }

  async search(title: string, artist: string, limit = 5): Promise<Candidate[]> {
    const q = encodeURIComponent(`${title} ${artist}`);
    const data = await this.api(
      `/search?part=snippet&q=${q}&type=video&videoCategoryId=10&maxResults=${limit}`
    );
    const items = data.items as any[];
    const ids = items.map((i) => i.id.videoId);
    const durations = await this.durationsFor(ids);
    return items.map((item) => ({
      id: item.id.videoId,
      title: item.snippet.title,
      artist: item.snippet.channelTitle,
      duration: durations.get(item.id.videoId),
    }));
  }

  /** Raw playlistItems, carrying both the playlist-item id (for deletes) and videoId. */
  private async listPlaylistItems(playlistId: string): Promise<any[]> {
    const items: any[] = [];
    let pageToken: string | undefined;
    do {
      const data: any = await this.api(
        `/playlistItems?part=snippet,contentDetails&playlistId=${playlistId}&maxResults=50` +
          (pageToken ? `&pageToken=${pageToken}` : "")
      );
      items.push(...data.items);
      pageToken = data.nextPageToken;
    } while (pageToken);
    return items;
  }

  async getPlaylistTracks(playlistId: string): Promise<Candidate[]> {
    const items = await this.listPlaylistItems(playlistId);
    const ids = items.map((i) => i.contentDetails.videoId);
    const durations = await this.durationsFor(ids);
    return items.map((item) => ({
      id: item.contentDetails.videoId,
      title: item.snippet.title,
      artist: item.snippet.videoOwnerChannelTitle ?? item.snippet.channelTitle ?? "",
      duration: durations.get(item.contentDetails.videoId),
    }));
  }

  async findPlaylistByName(name: string): Promise<string | null> {
    let pageToken: string | undefined;
    do {
      const data: any = await this.api(
        `/playlists?part=snippet&mine=true&maxResults=50` + (pageToken ? `&pageToken=${pageToken}` : "")
      );
      for (const p of data.items) {
        if (p.snippet.title.toLowerCase() === name.toLowerCase()) return p.id;
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
    return null;
  }

  async createPlaylist(title: string, description = ""): Promise<string> {
    const data = await this.api("/playlists?part=snippet,status", {
      method: "POST",
      body: JSON.stringify({
        snippet: { title, description },
        status: { privacyStatus: "private" },
      }),
    });
    return data.id;
  }

  async addTracks(playlistId: string, trackIds: string[]): Promise<void> {
    for (const videoId of trackIds) {
      await this.api("/playlistItems?part=snippet", {
        method: "POST",
        body: JSON.stringify({
          snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } },
        }),
      });
    }
  }

  async replaceTracks(playlistId: string, trackIds: string[]): Promise<void> {
    const existing = await this.listPlaylistItems(playlistId);
    for (const item of existing) {
      await this.api(`/playlistItems?id=${item.id}`, { method: "DELETE" });
    }
    await this.addTracks(playlistId, trackIds);
  }
}
