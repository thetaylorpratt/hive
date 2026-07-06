import { Client } from "@notionhq/client";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

/**
 * Notion REST client. Uses the Tauri HTTP plugin's fetch so requests go
 * through the Rust core — api.notion.com does not allow browser CORS, and the
 * capability scope pins outbound requests to api.notion.com only.
 */
let client: Client | null = null;

export function initNotion(token: string): Client {
  client = new Client({
    auth: token,
    fetch: tauriFetch as unknown as typeof globalThis.fetch,
  });
  return client;
}

export function notion(): Client {
  if (!client) throw new Error("Notion client not initialized");
  return client;
}
