/**
 * Minimal signed-cookie session, hand-rolled on purpose: this admin portal
 * has exactly one legitimate user, so a session store is overkill. The
 * cookie carries `email.expiry.hmac` — HMAC-SHA256 over `email.expiry`
 * keyed by SESSION_SECRET, so a client can't forge or extend it.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function createSessionCookie(email: string, secret: string): string {
  const expiry = Date.now() + SESSION_TTL_MS;
  const payload = `${email}.${expiry}`;
  return `${payload}.${sign(payload, secret)}`;
}

/** Returns the verified email, or null if the cookie is missing, forged, or expired. */
export function verifySessionCookie(cookie: string | undefined, secret: string): string | null {
  if (!cookie) return null;
  const parts = cookie.split(".");
  if (parts.length !== 3) return null;
  const [email, expiryStr, mac] = parts;
  const payload = `${email}.${expiryStr}`;
  const expected = sign(payload, secret);

  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || Date.now() > expiry) return null;

  return email;
}
