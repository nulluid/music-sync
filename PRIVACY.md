# Privacy

music-sync is a local command-line tool and a locally-run admin web portal. There is no hosted
service operated by the project — when you run it, it runs on your own machine (or a server you
control), under your own accounts.

## What it accesses

- **Spotify, YouTube Music, Amazon Music**: only playlist data (titles, track lists, artist names)
  via each service's own API or your own authenticated browser session, using credentials you
  provide and authorize yourself through each service's standard OAuth consent screen.
- **OpenRouter**: when you paste a free-text list of songs to add to a playlist, the raw text is
  sent to a free model on OpenRouter to extract song titles and artists. No other data is sent.
- **Google Sign-In** (admin portal only): used solely to verify your identity against an email
  address you configure yourself. No other profile data is requested or stored.

## What it stores, and where

All credentials (OAuth tokens, API keys), the local playlist-match cache, and session state are
stored in a config directory on the machine running the tool (`~/.config/music-sync/` by default).
Nothing is transmitted to the project's maintainers, to any analytics service, or to any third
party other than the music services and OpenRouter, and only as needed to perform the action you
requested.

## What it does not do

- No analytics or usage tracking.
- No advertising.
- No sharing of your data with anyone other than the services you've explicitly connected.
- No account creation on your behalf without your direct action (every OAuth consent screen is
  shown to you, in your own browser, before any access is granted).

## Source

This is open source. The code is the authoritative description of its behavior:
https://github.com/nulluid/music-sync
