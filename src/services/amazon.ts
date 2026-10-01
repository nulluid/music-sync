/**
 * Amazon Music backend, via Playwright browser automation.
 *
 * Amazon Music has a real Web API with a playlist-create endpoint, but
 * it's closed beta and only reachable through a negotiated Amazon Business
 * Development relationship — not self-serve (checked 2026-10, see
 * developer.amazon.com/docs/music/API_web_playlist.html and the Amazon
 * Developer Community threads on it). Soundiiz and similar tools have that
 * access; an individual doesn't. So this backend drives the real
 * music.amazon.com web UI instead.
 *
 * This makes it the most fragile of the three backends: selectors below
 * are written from Amazon Music's documented UI structure, not verified
 * against a live authenticated session (playlist management is behind
 * login, which needs you present). The first real run should use
 * `music-sync auth amazon --headed` so you can confirm each selector still
 * matches before trusting it unattended. Expect this file to need small
 * fixes when Amazon changes their frontend; `npx playwright codegen
 * https://music.amazon.com` is the fastest way to re-record a broken one.
 *
 * One-time setup:
 *
 *   music-sync auth amazon   # opens a real browser window, log in by hand,
 *                             # session is saved to config.AMAZON_STORAGE_STATE
 */

import { existsSync } from "node:fs";
import type { Browser, BrowserContext, Page } from "playwright";

import type { Candidate } from "../matcher.js";
import { AuthRequired, type MusicService } from "./base.js";
import { AMAZON_STORAGE_STATE } from "../config.js";

export const AUTH_INSTRUCTIONS = "run `music-sync auth amazon` and log in in the browser window it opens";

const BASE_URL = "https://music.amazon.com";

export class AmazonMusicService implements MusicService {
  readonly name = "amazon" as const;

  constructor(private headless = true) {}

  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  private async ensurePage(): Promise<Page> {
    if (this.page) return this.page;
    if (!existsSync(AMAZON_STORAGE_STATE)) throw new AuthRequired("amazon", AUTH_INSTRUCTIONS);

    const { chromium } = await import("playwright");
    this.browser = await chromium.launch({ headless: this.headless });
    this.context = await this.browser.newContext({ storageState: AMAZON_STORAGE_STATE });
    this.page = await this.context.newPage();
    await this.page.goto(BASE_URL);
    return this.page;
  }

  async close(): Promise<void> {
    if (this.context) await this.context.storageState({ path: AMAZON_STORAGE_STATE });
    await this.browser?.close();
    this.page = null;
    this.context = null;
    this.browser = null;
  }

  async authenticate(): Promise<void> {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${BASE_URL}/login`);
    await page.waitForSelector("text=Your Library", { timeout: 0 });
    await context.storageState({ path: AMAZON_STORAGE_STATE });
    await browser.close();
  }

  async isAuthenticated(): Promise<boolean> {
    if (!existsSync(AMAZON_STORAGE_STATE)) return false;
    try {
      const page = await this.ensurePage();
      await page.waitForSelector("text=Your Library", { timeout: 10_000 });
      return true;
    } catch {
      return false;
    } finally {
      await this.close();
    }
  }

  async search(title: string, artist: string, limit = 5): Promise<Candidate[]> {
    const page = await this.ensurePage();
    await page.goto(`${BASE_URL}/search/${encodeURIComponent(`${title} ${artist}`)}`);
    await page.waitForSelector('[data-testid="search-results"]', { timeout: 15_000 });
    const rows = (await page.locator('[data-testid="track-row"]').all()).slice(0, limit);
    const out: Candidate[] = [];
    for (const row of rows) {
      out.push({
        id: (await row.getAttribute("data-track-id")) ?? "",
        title: await row.locator('[data-testid="track-title"]').innerText(),
        artist: await row.locator('[data-testid="track-artist"]').innerText(),
      });
    }
    return out;
  }

  async getPlaylistTracks(playlistId: string): Promise<Candidate[]> {
    const page = await this.ensurePage();
    await page.goto(`${BASE_URL}/my/playlists/${playlistId}`);
    await page.waitForSelector('[data-testid="track-row"]', { timeout: 15_000 });
    const out: Candidate[] = [];
    for (const row of await page.locator('[data-testid="track-row"]').all()) {
      out.push({
        id: (await row.getAttribute("data-track-id")) ?? "",
        title: await row.locator('[data-testid="track-title"]').innerText(),
        artist: await row.locator('[data-testid="track-artist"]').innerText(),
      });
    }
    return out;
  }

  async findPlaylistByName(name: string): Promise<string | null> {
    const page = await this.ensurePage();
    await page.goto(`${BASE_URL}/my/playlists`);
    await page.waitForSelector('[data-testid="playlist-tile"]', { timeout: 15_000 });
    for (const tile of await page.locator('[data-testid="playlist-tile"]').all()) {
      const tileTitle = await tile.locator('[data-testid="playlist-title"]').innerText();
      if (tileTitle.toLowerCase() === name.toLowerCase()) {
        const href = (await tile.getAttribute("href")) ?? "";
        return href.replace(/\/$/, "").split("/").pop() ?? null;
      }
    }
    return null;
  }

  async createPlaylist(title: string, description = ""): Promise<string> {
    const page = await this.ensurePage();
    await page.goto(`${BASE_URL}/my/playlists`);
    await page.getByRole("button", { name: "New playlist" }).click();
    await page.getByRole("textbox", { name: "Playlist name" }).fill(title);
    if (description) await page.getByRole("textbox", { name: "Description" }).fill(description);
    await page.getByRole("button", { name: "Create" }).click();
    await page.waitForURL(`${BASE_URL}/my/playlists/*`);
    return page.url().replace(/\/$/, "").split("/").pop() ?? "";
  }

  async addTracks(playlistId: string, trackIds: string[]): Promise<void> {
    const page = await this.ensurePage();
    for (const trackId of trackIds) {
      await page.goto(`${BASE_URL}/tracks/${trackId}`);
      await page.getByRole("button", { name: "Add to playlist" }).click();
      await page.getByRole("menuitem", { name: playlistId }).click();
    }
  }

  async replaceTracks(playlistId: string, trackIds: string[]): Promise<void> {
    const page = await this.ensurePage();
    await page.goto(`${BASE_URL}/my/playlists/${playlistId}`);
    await page.waitForSelector('[data-testid="track-row"]', { timeout: 15_000 });
    for (const row of await page.locator('[data-testid="track-row"]').all()) {
      await row.getByRole("button", { name: "Remove from playlist" }).click();
    }
    await this.addTracks(playlistId, trackIds);
  }
}
