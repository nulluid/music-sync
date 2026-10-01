/**
 * Admin portal: Google sign-in restricted to one account, a dashboard of
 * sync jobs, and a manual "sync now" button. Runs the scheduler in-process
 * so a single deployed instance both serves the page and does the work.
 */

import { randomBytes } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";

import { loadEnvFile, pathFor } from "./config.js";
import { loadJobs } from "./jobs.js";
import { createSessionCookie, verifySessionCookie } from "./admin/session.js";
import { getStatus, runJob, startScheduler } from "./scheduler.js";

const ADMIN_ENV = loadEnvFile(pathFor("admin.env"));
const GOOGLE_CLIENT_ID = ADMIN_ENV.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = ADMIN_ENV.GOOGLE_CLIENT_SECRET;
const ADMIN_EMAIL = ADMIN_ENV.ADMIN_EMAIL;
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

  if (!user.email_verified || user.email !== ADMIN_EMAIL) {
    res.status(403).send(`Access restricted to ${ADMIN_EMAIL}.`);
    return;
  }

  const cookie = createSessionCookie(user.email, SESSION_SECRET!);
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
        <td>${job.name}</td>
        <td>${job.source} → ${job.targets.join(", ")}</td>
        <td>${statusText}<ul>${reportRows}</ul></td>
        <td><form method="post" action="/api/sync/${encodeURIComponent(job.name)}"><button>Sync now</button></form></td>
      </tr>`;
    })
    .join("");

  res.type("html").send(`<!doctype html>
<html><head><title>music-sync</title><style>
body{font-family:system-ui,sans-serif;background:#111;color:#eee;padding:2rem;max-width:960px;margin:auto}
table{width:100%;border-collapse:collapse}
td,th{padding:.5rem;border-bottom:1px solid #333;text-align:left;vertical-align:top}
button{background:#4285F4;color:#fff;border:none;padding:6px 14px;border-radius:4px;cursor:pointer}
a{color:#8ab4f8}
</style></head><body>
<h1>music-sync</h1>
<p>Signed in as ${ADMIN_EMAIL} · <a href="/auth/logout">sign out</a> · auto-sync every ${SYNC_INTERVAL_MS / 60_000} min</p>
<table><thead><tr><th>Job</th><th>Route</th><th>Last run</th><th></th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`);
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
