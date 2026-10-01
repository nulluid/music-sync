# music-sync

Upload, sync, and back up playlists across Spotify, YouTube Music, and Amazon Music. Playlists are
stored locally as JSPF (see [SPEC.md](SPEC.md)).

## Setup

Each service needs a one-time credential step, then `music-sync auth <service>` to complete login.
Credentials live in `~/.config/music-sync/`, which is never committed.

### Spotify — done

An app is already registered (`music-sync`, client ID in `~/.config/music-sync/spotify.env`) and
authenticated as Jason. Re-run `music-sync auth spotify` only if the token cache is deleted or
access is revoked.

### YouTube Music — one step left

A Google Cloud OAuth client is already registered (`music-sync`, type "TVs and Limited Input
devices", credentials in `~/.config/music-sync/ytmusic.env`, project `claude-mcp-personal-8193`,
test user `Jason@Smathe.rs`). Run `music-sync auth ytmusic` and finish the Google sign-in — it
stopped at a passkey/biometric prompt that needed you physically present, so the login itself isn't
done yet.

Unlike Spotify and Amazon Music, this backend uses the *official* YouTube Data API v3, not
scraped cookies — see the comment at the top of `src/services/ytmusic.ts` for why that's possible
(YouTube Music playlists are ordinary YouTube playlists under the hood) and what it costs in
search precision.

### Amazon Music — needs your login

No self-serve API exists (Amazon's is closed beta — see the comment at the top of
`src/services/amazon.ts`), so this backend drives the real music.amazon.com web UI with Playwright.
Run `music-sync auth amazon`: it opens a visible browser window, you log in by hand, and it saves
the session. The track-row selectors are written from Amazon's documented UI structure, not
verified against a live session — the first real run should use a visible (non-headless) browser so
you can confirm they still match; `npx playwright codegen https://music.amazon.com` is the fastest
way to fix a broken one.

```sh
npm install
npx playwright install chromium   # once, for the Amazon Music backend
npm run build
```

## Usage

```sh
music-sync upload playlist.jspf.json --to spotify,ytmusic,amazon
music-sync download spotify "Long Drives" -o playlist.jspf.json
music-sync sync --source spotify:"Long Drives" --to ytmusic,amazon
```

`sync` always treats `--source` as the source of truth: it reads that playlist fresh from the live
service and overwrites every target, backing up the result to
`~/.config/music-sync/backups/<name>.jspf.json` unless you pass `--no-backup`.

## Status (as of this commit)

- Format, matcher, sync engine, and CLI: complete, tested (`npm test`, 14 passing).
- Spotify: live and authenticated.
- YouTube Music: credentials registered, login blocked on your passkey.
- Amazon Music: credentials step not started (needs you to log in once).
- Hosted service and admin portal (`music.smathe.rs`): not started. Oracle Cloud is the target
  (existing box at `129.146.248.151` already runs Tahor) — worth a capacity check before deploying
  there, since it's down to ~300MB free RAM and Playwright's headless Chromium is not light; a
  second small instance may be the better call so a stuck sync run can't affect Tahor.
