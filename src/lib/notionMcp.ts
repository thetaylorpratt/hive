import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";

/**
 * Client for Notion's hosted MCP server (mcp.notion.com) — the identity
 * workaround for the REST API's biggest limitation: REST integration tokens
 * always act as a bot, but MCP OAuth tokens act AS THE USER. Once connected,
 * comments post under the user's real name (with inline anchoring, which
 * REST can't do at all) and new pages can be created in the user's Private
 * section (parent-less create).
 *
 * Flow: dynamic client registration (RFC 7591) → PKCE authorization-code in
 * the system browser → redirect to hive://oauth/callback (our deep link) →
 * token exchange. Tokens live in ~/.hive/mcp_auth.json (chmod 600), never
 * in the repo or logs.
 */

const MCP_BASE = "https://mcp.notion.com";
const REDIRECT_URI = "hive://oauth/callback";
const CLIENT_ID_KEY = "hive-mcp-client-id";
const PKCE_KEY = "hive-mcp-pkce";

const isTauri = "__TAURI_INTERNALS__" in window;
const http: typeof globalThis.fetch = isTauri
  ? (tauriFetch as unknown as typeof globalThis.fetch)
  : globalThis.fetch.bind(globalThis);

interface McpAuth {
  access_token: string;
  refresh_token?: string;
  expires_at?: number; // epoch ms
  client_id: string;
}

let auth: McpAuth | null | undefined; // undefined = not loaded yet
let sessionId: string | null = null;
let rpcId = 1;

async function loadAuth(): Promise<McpAuth | null> {
  if (auth !== undefined) return auth;
  try {
    const raw = isTauri
      ? await invoke<string | null>("load_mcp_auth")
      : localStorage.getItem("hive-mcp-auth-dev");
    auth = raw ? (JSON.parse(raw) as McpAuth) : null;
  } catch {
    auth = null;
  }
  return auth;
}

async function saveAuth(next: McpAuth | null): Promise<void> {
  auth = next;
  sessionId = null;
  const raw = next ? JSON.stringify(next) : "";
  if (isTauri) {
    await invoke("save_mcp_auth", { json: raw }).catch(() => undefined);
  } else if (next) {
    localStorage.setItem("hive-mcp-auth-dev", raw);
  } else {
    localStorage.removeItem("hive-mcp-auth-dev");
  }
}

export async function mcpConnected(): Promise<boolean> {
  return (await loadAuth()) !== null;
}

export async function disconnect(): Promise<void> {
  await saveAuth(null);
}

// ---------- OAuth ----------

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function registerClient(): Promise<string> {
  const cached = localStorage.getItem(CLIENT_ID_KEY);
  if (cached) return cached;
  const resp = await http(`${MCP_BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Hive",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!resp.ok) throw new Error(`MCP client registration failed (${resp.status})`);
  const body = (await resp.json()) as { client_id: string };
  localStorage.setItem(CLIENT_ID_KEY, body.client_id);
  return body.client_id;
}

/** Kick off OAuth: opens the approval page in the fallback browser. */
export async function beginConnect(): Promise<void> {
  const clientId = await registerClient();
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  localStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state, clientId }));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  const challenge = b64url(new Uint8Array(digest));
  const url =
    `${MCP_BASE}/authorize?response_type=code` +
    `&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&code_challenge=${challenge}&code_challenge_method=S256` +
    `&state=${state}`;
  if (isTauri) {
    // the fallback browser, not the default one — Hive IS the default browser
    await invoke("forward_url", { url });
  } else {
    window.open(url, "_blank");
  }
}

async function tokenRequest(params: Record<string, string>): Promise<McpAuth> {
  const clientId =
    params.client_id ?? localStorage.getItem(CLIENT_ID_KEY) ?? "";
  const resp = await http(`${MCP_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  if (!resp.ok) {
    throw new Error(`Notion sign-in failed (${resp.status})`);
  }
  const body = (await resp.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: body.expires_in ? Date.now() + body.expires_in * 1000 : undefined,
    client_id: clientId,
  };
}

/** Finish OAuth from the hive://oauth/callback deep link. */
export async function completeConnect(callbackUrl: string): Promise<void> {
  const query = callbackUrl.split("?")[1] ?? "";
  const params = new URLSearchParams(query);
  const code = params.get("code");
  const state = params.get("state");
  const stored = localStorage.getItem(PKCE_KEY);
  if (!code || !stored) throw new Error("OAuth callback missing code/state");
  const { verifier, state: expected, clientId } = JSON.parse(stored) as {
    verifier: string;
    state: string;
    clientId: string;
  };
  if (state !== expected) throw new Error("OAuth state mismatch");
  localStorage.removeItem(PKCE_KEY);
  const next = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier,
  });
  await saveAuth(next);
}

async function ensureFreshToken(): Promise<McpAuth> {
  const current = await loadAuth();
  if (!current) throw new Error("Not connected to Notion (personal)");
  if (
    current.expires_at &&
    current.refresh_token &&
    Date.now() > current.expires_at - 60_000
  ) {
    try {
      const next = await tokenRequest({
        grant_type: "refresh_token",
        refresh_token: current.refresh_token,
        client_id: current.client_id,
      });
      const merged = { ...next, refresh_token: next.refresh_token ?? current.refresh_token };
      await saveAuth(merged);
      return merged;
    } catch {
      await saveAuth(null);
      throw new Error("Notion session expired — reconnect from the comments panel");
    }
  }
  return current;
}

// ---------- MCP JSON-RPC over streamable HTTP ----------

interface RpcMessage {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

async function postRpc(
  body: Record<string, unknown>,
  token: string,
  expectReply: boolean,
): Promise<RpcMessage | null> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
    "MCP-Protocol-Version": "2025-06-18",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const resp = await http(`${MCP_BASE}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const newSession = resp.headers.get("mcp-session-id");
  if (newSession) sessionId = newSession;
  if (resp.status === 401) throw new Error("mcp-unauthorized");
  if (resp.status === 404 && sessionId) {
    // session evaporated server-side
    sessionId = null;
    throw new Error("mcp-session-lost");
  }
  if (!resp.ok) throw new Error(`MCP request failed (${resp.status})`);
  if (!expectReply) return null;
  const contentType = resp.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const text = await resp.text();
    const wanted = body.id as number;
    let last: RpcMessage | null = null;
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        const msg = JSON.parse(line.slice(5).trim()) as RpcMessage;
        if (msg.id === wanted) return msg;
        if (msg.result || msg.error) last = msg;
      } catch {
        /* keep-alive or partial frame */
      }
    }
    return last;
  }
  return (await resp.json()) as RpcMessage;
}

async function ensureSession(token: string): Promise<void> {
  if (sessionId) return;
  const init = await postRpc(
    {
      jsonrpc: "2.0",
      id: rpcId++,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "hive", version: "0.1.0" },
      },
    },
    token,
    true,
  );
  if (init?.error) throw new Error(`MCP initialize failed: ${init.error.message}`);
  await postRpc(
    { jsonrpc: "2.0", method: "notifications/initialized" },
    token,
    false,
  );
}

/** Call an MCP tool as the signed-in user; returns the text content. */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const attempt = async (): Promise<string> => {
    const token = (await ensureFreshToken()).access_token;
    await ensureSession(token);
    const reply = await postRpc(
      {
        jsonrpc: "2.0",
        id: rpcId++,
        method: "tools/call",
        params: { name, arguments: args },
      },
      token,
      true,
    );
    if (!reply) throw new Error("MCP returned no reply");
    if (reply.error) throw new Error(reply.error.message);
    const result = reply.result as
      | { content?: { type: string; text?: string }[]; isError?: boolean }
      | undefined;
    const text =
      result?.content
        ?.filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n") ?? "";
    if (result?.isError) throw new Error(text.slice(0, 300) || "MCP tool error");
    return text;
  };
  try {
    return await attempt();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "mcp-unauthorized") {
      // token may have just expired mid-flight — force refresh and retry once
      const current = await loadAuth();
      if (current) {
        auth = { ...current, expires_at: 0 };
        return attempt();
      }
    }
    if (msg === "mcp-session-lost") return attempt();
    throw err;
  }
}

// ---------- High-level operations ----------

/** Tool results arrive as a JSON envelope ({"text": "<xml...>"}) — unwrap
 * it, or pass through if a tool ever returns the payload bare. */
function unwrapToolText(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { text?: unknown };
    if (parsed && typeof parsed.text === "string") return parsed.text;
  } catch {
    /* already plain text */
  }
  return raw;
}

/** ~10 chars from each end — the MCP selection anchor format. */
export function selectionEllipsis(quote: string): string {
  const clean = quote.trim();
  if (clean.length <= 24) return clean;
  return `${clean.slice(0, 10)}...${clean.slice(-10)}`;
}

export async function createCommentAsUser(
  pageId: string,
  markdown: string,
  opts: { quote?: string; discussionId?: string } = {},
): Promise<void> {
  const args: Record<string, unknown> = { page_id: pageId, markdown };
  if (opts.discussionId) args.discussion_id = opts.discussionId;
  else if (opts.quote) args.selection_with_ellipsis = selectionEllipsis(opts.quote);
  await callTool("notion-create-comment", args);
}

/** Create a parent-less page → lands in the user's workspace-level Private
 * pages (exactly Notion's "Private" sidebar section). Returns the page id. */
export async function createPrivatePage(title: string): Promise<string | null> {
  const text = unwrapToolText(
    await callTool("notion-create-pages", {
      pages: [{ properties: { title } }],
    }),
  );
  const match = text.match(/[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i);
  return match ? match[0].replace(/-/g, "") : null;
}

export interface CommentEntry {
  id: string;
  authorId: string;
  time: string;
  text: string;
}

export interface CommentThread {
  id: string; // discussion://pageId/blockId/discussionId
  context: "inline" | "page";
  anchor: string | null; // text-context snippet for inline threads
  resolved: boolean;
  comments: CommentEntry[];
}

/** Fetch and parse all discussions on a page (incl. block-anchored ones). */
export async function getCommentsAsUser(pageId: string): Promise<CommentThread[]> {
  const xml = unwrapToolText(
    await callTool("notion-get-comments", {
      page_id: pageId,
      include_all_blocks: true,
    }),
  );
  return parseDiscussions(xml);
}

export function parseDiscussions(xml: string): CommentThread[] {
  // Lenient HTML parsing: the payload contains unescaped ampersands and
  // custom tags (<mention-user/>) that a strict XML parser rejects.
  const doc = new DOMParser().parseFromString(xml, "text/html");
  const threads: CommentThread[] = [];
  for (const d of doc.querySelectorAll("discussion")) {
    if (d.getAttribute("type") === "reaction") continue;
    const comments: CommentEntry[] = [];
    for (const c of d.querySelectorAll("comment")) {
      let text = "";
      for (const node of c.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? "";
        else if ((node as Element).tagName?.toLowerCase() === "mention-user") {
          const url = (node as Element).getAttribute("url") ?? "";
          // HTML parsing treats the self-closing tag as unclosed, so any
          // following text lands INSIDE it — append textContent to keep it
          text += `@${url.replace("user://", "").slice(0, 8)}${node.textContent ?? ""}`;
        } else text += node.textContent ?? "";
      }
      comments.push({
        id: c.getAttribute("id") ?? "",
        authorId: (c.getAttribute("user-url") ?? "").replace("user://", ""),
        time: c.getAttribute("datetime") ?? "",
        text: text.trim(),
      });
    }
    if (comments.length === 0) continue;
    threads.push({
      id: d.getAttribute("id") ?? "",
      context: d.getAttribute("context") === "inline" ? "inline" : "page",
      anchor: d.getAttribute("text-context"),
      resolved: d.getAttribute("resolved") === "true",
      comments,
    });
  }
  return threads;
}
