import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = process.env.MUSIC_SYNC_CONFIG_DIR ?? join(homedir(), ".config", "music-sync");

export function configDir(): string {
  mkdirSync(CONFIG_DIR, { recursive: true });
  return CONFIG_DIR;
}

export function pathFor(filename: string): string {
  return join(configDir(), filename);
}

export const SPOTIFY_TOKEN_CACHE = pathFor("spotify_token_cache.json");
export const SPOTIFY_ENV = pathFor("spotify.env");
export const YTMUSIC_ENV = pathFor("ytmusic.env");
export const YTMUSIC_TOKEN_CACHE = pathFor("ytmusic_token_cache.json");
export const AMAZON_STORAGE_STATE = pathFor("amazon_storage_state.json");
export const DEFAULT_BACKUP_DIR = pathFor("backups");

/** Minimal KEY=VALUE .env reader — no need for a dependency for this. */
export function loadEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}
