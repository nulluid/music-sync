/**
 * Registry of recurring sync jobs — "mirror this playlist from its source
 * of truth onto these targets, on a schedule." Lives in the gitignored
 * config dir since it's runtime state, not editorial content (that's what
 * the committed files under playlists/ are for).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { Service } from "./format.js";
import { pathFor } from "./config.js";

export interface SyncJob {
  name: string; // playlist name, exact match on every service
  source: Service;
  targets: Service[];
}

const JOBS_FILE = pathFor("sync-jobs.json");

export function loadJobs(): SyncJob[] {
  if (!existsSync(JOBS_FILE)) return [];
  return JSON.parse(readFileSync(JOBS_FILE, "utf-8"));
}

export function saveJobs(jobs: SyncJob[]): void {
  writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2) + "\n");
}

export function upsertJob(job: SyncJob): void {
  const jobs = loadJobs().filter((j) => j.name !== job.name);
  jobs.push(job);
  saveJobs(jobs);
}

export function removeJob(name: string): void {
  saveJobs(loadJobs().filter((j) => j.name !== name));
}
