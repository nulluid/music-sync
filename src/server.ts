/**
 * Admin portal: Google sign-in restricted to one account, a dashboard of
 * sync jobs, and a manual "sync now" button. Runs the scheduler in-process
 * so a single deployed instance both serves the page and does the work.
 */

import { randomBytes } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";

import { loadEnvFile, pathFor } from "./config.js";
import { newPlaylist, newTrack, type Service } from "./format.js";
import { loadJobs, removeJob, upsertJob } from "./jobs.js";
import { createSessionCookie, verifySessionCookie } from "./admin/session.js";
import { getStatus, runJob, startScheduler } from "./scheduler.js";
import { getService, SERVICE_NAMES } from "./services/index.js";
import { appendTracks, sync, upload } from "./sync.js";
import { parseFreeTextSongs } from "./textParser.js";

const ADMIN_ENV = loadEnvFile(pathFor("admin.env"));
const GOOGLE_CLIENT_ID = ADMIN_ENV.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = ADMIN_ENV.GOOGLE_CLIENT_SECRET;
// Lowercased once here so every comparison downstream is case-insensitive —
// Google's userinfo endpoint returns the account's originally-registered
// casing (confirmed live: "Jason@Smathe.rs"), not the lowercase form.
const ADMIN_EMAIL = ADMIN_ENV.ADMIN_EMAIL?.toLowerCase();
const SESSION_SECRET = ADMIN_ENV.SESSION_SECRET;

for (const [key, value] of Object.entries({
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  ADMIN_EMAIL,
  SESSION_SECRET,
})) {
  if (!value) throw new Error(`missing ${key} in ~/.config/music-sync/admin.env`);
}

const PORT = Number(process.env.PORT ?? 3000);
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;
const REDIRECT_URI = `${BASE_URL}/auth/google/callback`;
const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MINUTES ?? 15) * 60_000;

const SESSION_COOKIE = "music_sync_session";
const STATE_COOKIE = "music_sync_oauth_state";

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const cookies = parseCookies(req.headers.cookie);
  const email = verifySessionCookie(cookies[SESSION_COOKIE], SESSION_SECRET!);
  if (email !== ADMIN_EMAIL) {
    res.redirect("/login");
    return;
  }
  next();
}

const app = express();
app.use(express.urlencoded({ extended: false }));

app.get("/login", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html><head><title>music-sync</title><style>
body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#eee}
a.btn{background:#4285F4;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600}
</style></head><body><a class="btn" href="/auth/google">Sign in with Google</a></body></html>`);
});

app.get("/auth/google", (_req, res) => {
  const state = randomBytes(16).toString("hex");
  res.setHeader(
    "Set-Cookie",
    `${STATE_COOKIE}=${state}; HttpOnly; Max-Age=300; Path=/; SameSite=Lax`
  );
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID!,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "openid email",
    state,
    prompt: "select_account",
  }).toString();
  res.redirect(url.toString());
});

app.get("/auth/google/callback", async (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const { code, state } = req.query;
  if (!code || typeof code !== "string" || state !== cookies[STATE_COOKIE]) {
    res.status(400).send("Auth failed: missing code or state mismatch.");
    return;
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID!,
      client_secret: GOOGLE_CLIENT_SECRET!,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    res.status(401).send("Auth failed: token exchange rejected.");
    return;
  }
  const tokens = (await tokenRes.json()) as { access_token: string };

  const userRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const user = (await userRes.json()) as { email?: string; email_verified?: boolean };
  const email = user.email?.toLowerCase();

  if (!user.email_verified || email !== ADMIN_EMAIL) {
    res.status(403).send(`Access restricted to ${ADMIN_EMAIL}.`);
    return;
  }

  const cookie = createSessionCookie(email, SESSION_SECRET!);
  res.setHeader("Set-Cookie", [
    `${SESSION_COOKIE}=${cookie}; HttpOnly; Max-Age=43200; Path=/; SameSite=Lax`,
    `${STATE_COOKIE}=; Max-Age=0; Path=/`,
  ]);
  res.redirect("/");
});

app.get("/auth/logout", (_req, res) => {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Max-Age=0; Path=/`);
  res.redirect("/login");
});

app.get("/", requireAuth, (_req, res) => {
  const jobs = loadJobs();
  const status = getStatus();

  const rows = jobs
    .map((job) => {
      const s = status[job.name];
      const statusText = !s
        ? "never run"
        : s.ok
          ? `${s.trackCount} tracks, last run ${s.ranAt}`
          : `FAILED: ${s.error} (${s.ranAt})`;
      const reportRows = (s?.reports ?? [])
        .map((r) =>
          r.error
            ? `<li>${r.service}: FAILED — ${r.error}</li>`
            : `<li>${r.service}: ${r.created ? "created" : "updated"} ${r.playlistId}${r.unmatchedCount ? ` — ${r.unmatchedCount} unmatched` : ""}</li>`
        )
        .join("");
      return `<tr>
        <td><a href="/playlist/${encodeURIComponent(job.name)}">${job.name}</a></td>
        <td>${job.source} → ${job.targets.join(", ")}</td>
        <td>${statusText}<ul>${reportRows}</ul></td>
        <td><form method="post" action="/api/sync/${encodeURIComponent(job.name)}"><button>Sync now</button></form></td>
      </tr>`;
    })
    .join("");

  res.type("html").send(page(`
<h1>music-sync</h1>
<p>Signed in as ${ADMIN_EMAIL} · <a href="/auth/logout">sign out</a> · auto-sync every ${SYNC_INTERVAL_MS / 60_000} min</p>
<p><a href="/playlist/new">+ New playlist</a></p>
<table><thead><tr><th>Job</th><th>Route</th><th>Last run</th><th></th></tr></thead><tbody>${rows}</tbody></table>
`));
});

function page(body: string): string {
  return `<!doctype html>
<html><head><title>music-sync</title><style>
body{font-family:system-ui,sans-serif;background:#111;color:#eee;padding:2rem;max-width:960px;margin:auto}
table{width:100%;border-collapse:collapse}
td,th{padding:.5rem;border-bottom:1px solid #333;text-align:left;vertical-align:top}
button{background:#4285F4;color:#fff;border:none;padding:6px 14px;border-radius:4px;cursor:pointer}
button.danger{background:#a33}
a{color:#8ab4f8}
textarea{width:100%;min-height:220px;background:#1a1a1a;color:#eee;border:1px solid #333;border-radius:4px;padding:.5rem;font-family:ui-monospace,monospace}
input[type=text]{background:#1a1a1a;color:#eee;border:1px solid #333;border-radius:4px;padding:.4rem}
label.svc{display:inline-block;margin-right:1rem}
.error{background:#3a1a1a;border:1px solid #a33;padding:.75rem;border-radius:4px;margin:1rem 0}
ul{margin:.25rem 0;padding-left:1.25rem}
</style></head><body>${body}</body></html>`;
}

function serviceCheckboxes(name: string, selected: Service[] = []): string {
  return SERVICE_NAMES.map(
    (s) =>
      `<label class="svc"><input type="checkbox" name="${name}" value="${s}" ${selected.includes(s) ? "checked" : ""}> ${s}</label>`
  ).join("");
}

app.get("/playlist/new", requireAuth, (_req, res) => {
  res.type("html").send(page(`
<p><a href="/">← back</a></p>
<h1>New playlist</h1>
<form method="post" action="/playlist/new">
  <p><label>Name <input type="text" name="name" required></label></p>
  <p>Source of truth (where you'll make edits): ${serviceCheckboxes("source")}
  <br><small>Pick exactly one — it's where you'll add/remove songs going forward.</small></p>
  <p>Also sync to: ${serviceCheckboxes("targets")}</p>
  <p><textarea name="songs" placeholder="Paste a song list in any format — numbered list, &quot;Artist - Title&quot; lines, whatever you've got." required></textarea></p>
  <p><button type="submit">Create</button></p>
</form>
`));
});

app.post("/playlist/new", requireAuth, async (req, res) => {
  const name = String(req.body.name ?? "").trim();
  const sourceInput = req.body.source;
  const source = (Array.isArray(sourceInput) ? sourceInput[0] : sourceInput) as Service | undefined;
  const targetsInput = req.body.targets;
  const targets = (Array.isArray(targetsInput) ? targetsInput : targetsInput ? [targetsInput] : []) as Service[];
  const songsText = String(req.body.songs ?? "");

  if (!name || !source || !SERVICE_NAMES.includes(source)) {
    res.status(400).type("html").send(page(`<div class="error">Name and exactly one source service are required.</div><p><a href="/playlist/new">Back</a></p>`));
    return;
  }

  let songs;
  try {
    songs = await parseFreeTextSongs(songsText);
  } catch (e) {
    res.status(502).type("html").send(page(`<div class="error">Couldn't parse that text: ${(e as Error).message}</div><p><a href="/playlist/new">Back</a></p>`));
    return;
  }
  if (songs.length === 0) {
    res.status(400).type("html").send(page(`<div class="error">Didn't find any songs in that text — nothing created.</div><p><a href="/playlist/new">Back</a></p>`));
    return;
  }

  const playlist = newPlaylist({
    title: name,
    sourceOfTruth: source,
    tracks: songs.map((s) => newTrack({ title: s.title, creator: s.creator })),
  });

  try {
    const sourceService = getService(source);
    const report = await upload(playlist, sourceService);
    upsertJob({ name, source, targets: targets.filter((t) => t !== source) });
    if (targets.length > 0) {
      const targetServices = targets.filter((t) => t !== source).map(getService);
      if (targetServices.length > 0) await sync(sourceService, report.playlistId, targetServices, name);
    }
  } catch (e) {
    res.status(502).type("html").send(page(`<div class="error">Created the job, but the initial upload failed: ${(e as Error).message}</div><p><a href="/playlist/${encodeURIComponent(name)}">View it</a></p>`));
    return;
  }

  res.redirect(`/playlist/${encodeURIComponent(name)}`);
});

app.get("/playlist/:name", requireAuth, async (req, res) => {
  const name = String(req.params.name);
  const job = loadJobs().find((j) => j.name === name);
  if (!job) {
    res.status(404).type("html").send(page(`<p>No playlist job named "${name}".</p><p><a href="/">← back</a></p>`));
    return;
  }

  let trackRows = "<li><em>couldn't load current tracks</em></li>";
  try {
    const sourceService = getService(job.source);
    const playlistId = await sourceService.findPlaylistByName(name);
    if (playlistId) {
      const tracks = await sourceService.getPlaylistTracks(playlistId);
      trackRows = tracks.map((t) => `<li>${t.title} — ${t.artist}</li>`).join("") || "<li><em>empty</em></li>";
    }
  } catch {
    // leave the fallback message
  }

  const status = getStatus()[name];

  res.type("html").send(page(`
<p><a href="/">← back</a></p>
<h1>${name}</h1>
<p>Source of truth: <strong>${job.source}</strong> · Also synced to: ${job.targets.join(", ") || "(none)"}</p>
${status ? `<p>Last run: ${status.ok ? `ok, ${status.trackCount} tracks` : `FAILED — ${status.error}`} (${status.ranAt})</p>` : ""}

<h2>Current tracks on ${job.source} (source of truth)</h2>
<ul>${trackRows}</ul>

<h2>Add songs</h2>
<p>Pasted text is parsed by a free AI model and appended to the ${job.source} playlist, then synced to the rest.</p>
<form method="post" action="/playlist/${encodeURIComponent(name)}/add">
  <textarea name="songs" placeholder="Paste songs to add — any format." required></textarea>
  <p><button type="submit">Add to playlist</button></p>
</form>

<h2>Sync</h2>
<form method="post" action="/api/sync/${encodeURIComponent(name)}"><button>Sync now</button></form>

<h2>Danger zone</h2>
<p>Stops auto-sync for this playlist. Does <strong>not</strong> delete it on any service.</p>
<form method="post" action="/playlist/${encodeURIComponent(name)}/delete" onsubmit="return confirm('Stop auto-syncing ${name.replace(/'/g, "\\'")}? The playlists themselves are left alone on every service.')"><button class="danger">Stop syncing</button></form>
`));
});

app.post("/playlist/:name/add", requireAuth, async (req, res) => {
  const name = String(req.params.name);
  const job = loadJobs().find((j) => j.name === name);
  if (!job) {
    res.status(404).send("No such playlist job.");
    return;
  }
  const songsText = String(req.body.songs ?? "");

  let songs;
  try {
    songs = await parseFreeTextSongs(songsText);
  } catch (e) {
    res.status(502).type("html").send(page(`<div class="error">Couldn't parse that text: ${(e as Error).message}</div><p><a href="/playlist/${encodeURIComponent(name)}">Back</a></p>`));
    return;
  }
  if (songs.length === 0) {
    res.redirect(`/playlist/${encodeURIComponent(name)}`);
    return;
  }

  try {
    const sourceService = getService(job.source);
    const playlistId = await sourceService.findPlaylistByName(name);
    if (!playlistId) throw new Error(`no playlist named "${name}" found on ${job.source}`);
    await appendTracks(
      playlistId,
      sourceService,
      songs.map((s) => newTrack({ title: s.title, creator: s.creator }))
    );
    if (job.targets.length > 0) {
      await sync(sourceService, playlistId, job.targets.map(getService), name);
    }
  } catch (e) {
    res.status(502).type("html").send(page(`<div class="error">Add failed: ${(e as Error).message}</div><p><a href="/playlist/${encodeURIComponent(name)}">Back</a></p>`));
    return;
  }

  res.redirect(`/playlist/${encodeURIComponent(name)}`);
});

app.post("/playlist/:name/delete", requireAuth, (req, res) => {
  removeJob(String(req.params.name));
  res.redirect("/");
});

app.post("/api/sync/:name", requireAuth, async (req, res) => {
  const job = loadJobs().find((j) => j.name === req.params.name);
  if (!job) {
    res.status(404).send("No such job.");
    return;
  }
  await runJob(job);
  res.redirect("/");
});

startScheduler(SYNC_INTERVAL_MS);

app.listen(PORT, () => {
  console.log(`music-sync admin portal listening on ${BASE_URL}`);
});
