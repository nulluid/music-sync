/**
 * Minimal signed-cookie session, hand-rolled on purpose: this admin portal
 * has exactly one legitimate user, so a session store is overkill. The
 * cookie carries `base64url(email).expiry.hmac` — HMAC-SHA256 over
 * `email.expiry` keyed by SESSION_SECRET, so a client can't forge or extend
 * it. The email is base64url-encoded before embedding: a real email address
 * contains a literal "." (the domain), which broke naive dot-splitting —
 * confirmed live, jason@smathe.rs always failed verification because
 * splitting on "." produced four parts instead of three.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function base64url(input: string): string {
  return Buffer.from(input, "utf-8").toString("base64url");
}

export function createSessionCookie(email: string, secret: string): string {
  const expiry = Date.now() + SESSION_TTL_MS;
  const payload = `${base64url(email)}.${expiry}`;
  return `${payload}.${sign(payload, secret)}`;
}

/** Returns the verified email, or null if the cookie is missing, forged, or expired. */
export function verifySessionCookie(cookie: string | undefined, secret: string): string | null {
  if (!cookie) return null;
  const parts = cookie.split(".");
  if (parts.length !== 3) return null;
  const [encodedEmail, expiryStr, mac] = parts;
  const payload = `${encodedEmail}.${expiryStr}`;
  const expected = sign(payload, secret);

  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || Date.now() > expiry) return null;

  try {
    return Buffer.from(encodedEmail, "base64url").toString("utf-8");
  } catch {
    return null;
  }
}
