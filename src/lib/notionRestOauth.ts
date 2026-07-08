import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";

/**
 * Tokenless onboarding: instead of every user filing an IT ticket for an
 * internal-integration token, ONE public OAuth integration is approved once
 * and each user signs in with Notion — they pick which pages to grant in
 * Notion's own consent screen, and the resulting access token is written to
 * ~/.hive/config.json exactly as if they'd pasted it.
 *
 * Fill CLIENT_ID/CLIENT_SECRET from the integration's OAuth tab once it's
 * flipped to Public (notion.so/my-integrations). The "Sign in with Notion"
 * button only renders when these are set. Notion's token exchange requires
 * the secret (no PKCE), so it ships in the binary — acceptable for an
 * internal tool; the grant is still per-user and revocable in Notion.
 *
 * The redirect must be https, so a static bounce page forwards the code to
 * the hive:// deep link (see oauth-bounce/index.html in the repo).
 */
export const NOTION_OAUTH_CLIENT_ID = "";
const NOTION_OAUTH_CLIENT_SECRET = "";
const REDIRECT_URI = "https://thetaylorpratt.github.io/hive-oauth/";

const isTauri = "__TAURI_INTERNALS__" in window;
const http: typeof globalThis.fetch = isTauri
  ? (tauriFetch as unknown as typeof globalThis.fetch)
  : globalThis.fetch.bind(globalThis);

export function restOauthConfigured(): boolean {
  return NOTION_OAUTH_CLIENT_ID.length > 0 && NOTION_OAUTH_CLIENT_SECRET.length > 0;
}

export async function beginRestAuth(): Promise<void> {
  const state = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))),
  ).replace(/[+/=]/g, "");
  localStorage.setItem("hive-rest-oauth-state", state);
  const url =
    "https://api.notion.com/v1/oauth/authorize" +
    `?client_id=${encodeURIComponent(NOTION_OAUTH_CLIENT_ID)}` +
    "&response_type=code&owner=user" +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&state=${state}`;
  if (isTauri) await invoke("forward_url", { url });
  else window.open(url, "_blank");
}

/** Finish from the hive://oauth/notion deep link; returns workspace name. */
export async function completeRestAuth(callbackUrl: string): Promise<string> {
  const params = new URLSearchParams(callbackUrl.split("?")[1] ?? "");
  const code = params.get("code");
  const state = params.get("state");
  const expected = localStorage.getItem("hive-rest-oauth-state");
  if (!code) throw new Error(params.get("error") ?? "missing code");
  if (!expected || state !== expected) throw new Error("state mismatch");
  localStorage.removeItem("hive-rest-oauth-state");

  const resp = await http("https://api.notion.com/v1/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${btoa(`${NOTION_OAUTH_CLIENT_ID}:${NOTION_OAUTH_CLIENT_SECRET}`)}`,
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });
  if (!resp.ok) throw new Error(`token exchange failed (${resp.status})`);
  const body = (await resp.json()) as {
    access_token: string;
    workspace_name?: string;
  };
  await invoke("save_notion_token", { token: body.access_token });
  return body.workspace_name ?? "your workspace";
}
