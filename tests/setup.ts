/**
 * Runs before each test file's own imports — critical, since config.ts reads
 * MUSIC_SYNC_CONFIG_DIR into a top-level const at module-load time, which
 * happens before any beforeEach could set it. Without this, tests that
 * import sync.ts (and transitively matchCache.ts) read and write the real
 * ~/.config/music-sync/ directory: a real incident, not a hypothetical —
 * fake test tracks ended up in the user's actual match cache, and worse,
 * negative cache entries from a real quota failure outlived the test run
 * that happened to share the directory.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MUSIC_SYNC_CONFIG_DIR = mkdtempSync(join(tmpdir(), "music-sync-test-config-"));
