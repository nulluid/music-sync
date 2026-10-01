import type { Service } from "../format.js";
import { AmazonMusicService } from "./amazon.js";
import type { MusicService } from "./base.js";
import { SpotifyService } from "./spotify.js";
import { YTMusicService } from "./ytmusic.js";

export { AuthRequired, type MusicService } from "./base.js";

export const SERVICE_NAMES: Service[] = ["spotify", "ytmusic", "amazon"];

export function getService(name: Service): MusicService {
  switch (name) {
    case "spotify":
      return new SpotifyService();
    case "ytmusic":
      return new YTMusicService();
    case "amazon":
      return new AmazonMusicService();
  }
}
