/**
 * Turns an arbitrary pasted block of text — a numbered list, "Artist -
 * Title" lines, a chat export, whatever shape someone pastes a song list
 * in — into structured {title, creator} pairs, via a free OpenRouter
 * model. Song titles and artist names aren't sensitive, so this is
 * explicitly the kind of mechanical reformatting that shouldn't spend the
 * hosted model's budget — see the project's OpenRouter-for-nonsensitive-
 * formatting convention.
 */

import { loadEnvFile, pathFor } from "./config.js";

const MODEL = "qwen/qwen3.8-27b:free";
const API_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface ParsedSong {
  title: string;
  creator: string;
}

function apiKey(): string | undefined {
  return loadEnvFile(pathFor("admin.env")).OPENROUTER_API_KEY;
}

const SYSTEM_PROMPT = `You extract songs from arbitrary pasted text (numbered lists, "Artist - Title" \
lines, markdown, chat exports, anything). For each song, identify its title and artist(s). \
Strip list markers, bold/markdown formatting, and footnote-style punctuation. Keep "feat." \
credits attached to the artist field exactly as written. Respond with ONLY a JSON array of \
objects shaped {"title": string, "creator": string}, no prose, no markdown fence. If a line \
isn't a song (e.g. a heading), skip it.`;

export async function parseFreeTextSongs(text: string): Promise<ParsedSong[]> {
  const key = apiKey();
  if (!key) {
    throw new Error(
      "OPENROUTER_API_KEY missing in ~/.config/music-sync/admin.env — get a free key at https://openrouter.ai/keys"
    );
  }

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
      temperature: 0,
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenRouter request failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as any;
  const content: string = data.choices?.[0]?.message?.content ?? "";

  // Free models sometimes wrap JSON in a markdown fence despite being told not to.
  const jsonText = content.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error(`OpenRouter didn't return valid JSON: ${content.slice(0, 500)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`OpenRouter returned JSON but not an array: ${jsonText.slice(0, 500)}`);
  }

  const songs: ParsedSong[] = [];
  for (const item of parsed) {
    if (item && typeof item.title === "string" && typeof item.creator === "string" && item.title.trim()) {
      songs.push({ title: item.title.trim(), creator: item.creator.trim() });
    }
  }
  return songs;
}
