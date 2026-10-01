import { describe, expect, it, vi } from "vitest";

import { createSessionCookie, verifySessionCookie } from "../src/admin/session.js";

const SECRET = "test-secret";

describe("session cookie", () => {
  it("round-trips an email containing a dot in the domain", () => {
    // Regression test: naive `cookie.split(".")` broke on any real email,
    // since the domain itself contains a literal "." — verification always
    // failed (4 parts instead of 3), confirmed live against a real account.
    const cookie = createSessionCookie("user@example.com", SECRET);
    expect(verifySessionCookie(cookie, SECRET)).toBe("user@example.com");
  });

  it("rejects a missing cookie", () => {
    expect(verifySessionCookie(undefined, SECRET)).toBeNull();
  });

  it("rejects a tampered cookie", () => {
    const cookie = createSessionCookie("user@example.com", SECRET);
    const tampered = cookie.replace(/^[^.]+/, Buffer.from("attacker@evil.com").toString("base64url"));
    expect(verifySessionCookie(tampered, SECRET)).toBeNull();
  });

  it("rejects a cookie signed with a different secret", () => {
    const cookie = createSessionCookie("user@example.com", SECRET);
    expect(verifySessionCookie(cookie, "wrong-secret")).toBeNull();
  });

  it("rejects an expired cookie", () => {
    vi.useFakeTimers();
    try {
      const cookie = createSessionCookie("user@example.com", SECRET);
      vi.setSystemTime(Date.now() + 13 * 60 * 60 * 1000); // past the 12h TTL
      expect(verifySessionCookie(cookie, SECRET)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects garbage input without throwing", () => {
    expect(verifySessionCookie("not-a-real-cookie", SECRET)).toBeNull();
    expect(verifySessionCookie("a.b.c.d", SECRET)).toBeNull();
    expect(verifySessionCookie("", SECRET)).toBeNull();
  });
});
