#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";

import { DEFAULT_BACKUP_DIR } from "./config.js";
import { loadPlaylist, savePlaylist, type Service } from "./format.js";
import { loadJobs, removeJob, upsertJob } from "./jobs.js";
import { runAllJobs, runJob } from "./scheduler.js";
import { AuthRequired, getService, SERVICE_NAMES } from "./services/index.js";
import { download, sync, upload, unmatched, type ServiceReport } from "./sync.js";

function printReport(report: ServiceReport): void {
  const verb = report.createdPlaylist ? "created" : "updated";
  console.log(`  ${report.service}: ${verb} playlist ${report.playlistId}`);
  for (const r of unmatched(report)) {
    console.log(`    ! no match for "${r.track.title}" by ${r.track.creator}`);
  }
  const bad = unmatched(report);
  if (bad.length) console.log(`    ${bad.length}/${report.results.length} tracks unmatched`);
}

function parseServiceList(s: string): Service[] {
  return s.split(",").map((x) => x.trim() as Service);
}

const program = new Command();
program
  .name("music-sync")
  .description("Upload, sync, and back up playlists across Spotify, YouTube Music, and Amazon Music");

program
  .command("auth")
  .argument("<service>", `one of: ${SERVICE_NAMES.join(", ")}`)
  .description("run the one-time interactive login for a service")
  .action(async (serviceName: Service) => {
    const svc = getService(serviceName);
    await svc.authenticate();
    console.log(`${serviceName}: authenticated.`);
  });

program
  .command("upload")
  .argument("<file>", "local playlist file")
  .requiredOption("--to <services>", `comma-separated: ${SERVICE_NAMES.join(", ")}`)
  .description("upload a local playlist file to one or more services")
  .action(async (file: string, opts: { to: string }) => {
    const playlist = loadPlaylist(file);
    console.log(`Uploading "${playlist.title}" (${playlist.tracks.length} tracks)`);
    for (const name of parseServiceList(opts.to)) {
      try {
        const service = getService(name);
        const report = await upload(playlist, service);
        playlist.playlistIds[name] = report.playlistId;
        printReport(report);
      } catch (e) {
        if (e instanceof AuthRequired) {
          console.error(`  ${e.service}: not authenticated — ${e.instructions}`);
        } else {
          throw e;
        }
      }
    }
    savePlaylist(playlist, file);
  });

program
  .command("download")
  .argument("<service>", `one of: ${SERVICE_NAMES.join(", ")}`)
  .argument("<playlistName>")
  .requiredOption("-o, --output <path>")
  .description("download a playlist from a service and save it in the local format")
  .action(async (serviceName: Service, playlistName: string, opts: { output: string }) => {
    const svc = getService(serviceName);
    try {
      const playlistId = await svc.findPlaylistByName(playlistName);
      if (!playlistId) {
        console.error(`No playlist named "${playlistName}" found on ${serviceName}.`);
        process.exitCode = 1;
        return;
      }
      const playlist = await download(svc, playlistId, playlistName);
      savePlaylist(playlist, opts.output);
      console.log(`Saved ${playlist.tracks.length} tracks to ${opts.output}`);
    } catch (e) {
      if (e instanceof AuthRequired) {
        console.error(`${e.service}: not authenticated — ${e.instructions}`);
        process.exitCode = 1;
      } else {
        throw e;
      }
    }
  });

program
  .command("sync")
  .requiredOption("--source <serviceColonName>", "source of truth, e.g. spotify:Long Drives")
  .requiredOption("--to <services>", `comma-separated: ${SERVICE_NAMES.join(", ")}`)
  .option("--no-backup", "skip saving the synced state to a local file")
  .description("mirror a playlist from its source of truth onto one or more target services")
  .action(async (opts: { source: string; to: string; backup: boolean }) => {
    const sepIndex = opts.source.indexOf(":");
    if (sepIndex === -1) {
      console.error("--source must be service:playlist-name");
      process.exitCode = 1;
      return;
    }
    const sourceName = opts.source.slice(0, sepIndex) as Service;
    const playlistName = opts.source.slice(sepIndex + 1);
    const targetNames = parseServiceList(opts.to);

    try {
      const sourceService = getService(sourceName);
      const sourceId = await sourceService.findPlaylistByName(playlistName);
      if (!sourceId) {
        console.error(`No playlist named "${playlistName}" found on ${sourceName}.`);
        process.exitCode = 1;
        return;
      }
      const targetServices = targetNames.map(getService);
      const { canonical, reports } = await sync(sourceService, sourceId, targetServices, playlistName);

      canonical.sourceOfTruth = sourceName;
      canonical.playlistIds[sourceName] = sourceId;
      console.log(`Synced "${playlistName}" from ${sourceName} (${canonical.tracks.length} tracks)`);
      for (const report of reports) {
        canonical.playlistIds[report.service] = report.playlistId;
        printReport(report);
      }

      if (opts.backup) {
        mkdirSync(DEFAULT_BACKUP_DIR, { recursive: true });
        const path = join(DEFAULT_BACKUP_DIR, `${playlistName}.jspf.json`);
        savePlaylist(canonical, path);
        console.log(`Backup saved to ${path}`);
      }
    } catch (e) {
      if (e instanceof AuthRequired) {
        console.error(`${e.service}: not authenticated — ${e.instructions}`);
        process.exitCode = 1;
      } else {
        throw e;
      }
    }
  });

const jobs = program.command("jobs").description("manage recurring sync jobs");

jobs
  .command("add")
  .requiredOption("--name <playlistName>", "exact playlist name on every service")
  .requiredOption("--source <service>", `source of truth: ${SERVICE_NAMES.join(", ")}`)
  .requiredOption("--to <services>", "comma-separated targets")
  .description("register a recurring sync job (or replace one with the same name)")
  .action((opts: { name: string; source: Service; to: string }) => {
    upsertJob({ name: opts.name, source: opts.source, targets: parseServiceList(opts.to) });
    console.log(`Registered: ${opts.name} (${opts.source} -> ${opts.to})`);
  });

jobs
  .command("remove")
  .argument("<name>")
  .description("remove a recurring sync job")
  .action((name: string) => {
    removeJob(name);
    console.log(`Removed: ${name}`);
  });

jobs
  .command("list")
  .description("list registered sync jobs")
  .action(() => {
    for (const job of loadJobs()) {
      console.log(`${job.name}: ${job.source} -> ${job.targets.join(", ")}`);
    }
  });

jobs
  .command("run")
  .argument("[name]", "run a single job by name, or every job if omitted")
  .description("run registered sync jobs immediately")
  .action(async (name?: string) => {
    let results;
    if (name) {
      const job = loadJobs().find((j) => j.name === name);
      if (!job) {
        console.error(`no job named "${name}"`);
        process.exitCode = 1;
        return;
      }
      results = [await runJob(job)];
    } else {
      results = await runAllJobs();
    }
    for (const r of results) {
      if (r.ok) {
        console.log(`${r.job.name}: synced ${r.trackCount} tracks`);
        for (const report of r.reports ?? []) {
          console.log(`  ${report.service}: ${report.created ? "created" : "updated"} ${report.playlistId}`);
          if (report.unmatchedCount) console.log(`    ${report.unmatchedCount} unmatched`);
        }
      } else {
        console.error(`${r.job.name}: FAILED — ${r.error}`);
      }
    }
  });

program.parseAsync();
