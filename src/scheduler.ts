/**
 * Runs every registered sync job on an interval and records what happened,
 * so the admin portal (and `music-sync jobs status`) can show it without
 * re-running anything.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { pathFor } from "./config.js";
import { loadJobs, type SyncJob } from "./jobs.js";
import { getService } from "./services/index.js";
import { sync, unmatched, type ServiceReport } from "./sync.js";

export interface JobRunResult {
  job: SyncJob;
  ranAt: string; // ISO timestamp
  ok: boolean;
  error?: string;
  trackCount?: number;
  reports?: {
    service: string;
    playlistId: string;
    created: boolean;
    unmatchedCount: number;
    error?: string;
  }[];
}

const STATUS_FILE = pathFor("sync-status.json");

function readStatus(): Record<string, JobRunResult> {
  if (!existsSync(STATUS_FILE)) return {};
  return JSON.parse(readFileSync(STATUS_FILE, "utf-8"));
}

function writeStatus(status: Record<string, JobRunResult>): void {
  writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2) + "\n");
}

export function getStatus(): Record<string, JobRunResult> {
  return readStatus();
}

export async function runJob(job: SyncJob): Promise<JobRunResult> {
  const ranAt = new Date().toISOString();
  try {
    const sourceService = getService(job.source);
    const sourceId = await sourceService.findPlaylistByName(job.name);
    if (!sourceId) {
      throw new Error(`no playlist named "${job.name}" found on ${job.source}`);
    }
    const targetServices = job.targets.map(getService);
    const { canonical, reports } = await sync(sourceService, sourceId, targetServices, job.name);

    const result: JobRunResult = {
      job,
      ranAt,
      ok: true,
      trackCount: canonical.tracks.length,
      reports: reports.map((r: ServiceReport) => ({
        service: r.service,
        playlistId: r.playlistId,
        created: r.createdPlaylist,
        unmatchedCount: unmatched(r).length,
        error: r.error,
      })),
    };
    const status = readStatus();
    status[job.name] = result;
    writeStatus(status);
    return result;
  } catch (e) {
    const result: JobRunResult = { job, ranAt, ok: false, error: (e as Error).message };
    const status = readStatus();
    status[job.name] = result;
    writeStatus(status);
    return result;
  }
}

export async function runAllJobs(): Promise<JobRunResult[]> {
  const jobs = loadJobs();
  const results: JobRunResult[] = [];
  for (const job of jobs) {
    results.push(await runJob(job));
  }
  return results;
}

export function startScheduler(intervalMs: number): NodeJS.Timeout {
  runAllJobs().catch((e) => console.error("initial sync run failed:", e));
  return setInterval(() => {
    runAllJobs().catch((e) => console.error("scheduled sync run failed:", e));
  }, intervalMs);
}
