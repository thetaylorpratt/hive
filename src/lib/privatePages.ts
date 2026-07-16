import Database from "@tauri-apps/plugin-sql";
import { callTool, mcpConnected } from "./notionMcp";
import { normalizePageId } from "./fetchPage";
import { loadConfig } from "./config";

/**
 * Discovery + classification of the user's PRIVATE Notion pages — the
 * workspace-level "Private" section Notion shows automatically, with no
 * manual pinning. There is no enumeration API for this, so Hive infers it:
 *
 *  1. notion-search (semantic, broad queries) surfaces candidate page ids
 *     the user is likely to actually use.
 *  2. notion-fetch on a candidate returns enhanced-markdown-with-XML-tags;
 *     an EMPTY <ancestor-path></ancestor-path> means the page has no parent
 *     visible to the API — i.e. it's a private ROOT page (teamspace pages
 *     always have ancestry). That's the classifier.
 *  3. Once a page id is classified (private root or not), it's remembered
 *     forever in the private_page table — never re-classified, never
 *     deleted (private roots stay put; Notion doesn't offer a "make
 *     public" that would need to reverse this).
 *
 * config.json's scratchpad/capture page ids are always private-relevant
 * (Hive created them there) and are upserted unconditionally, bypassing the
 * ancestor-path check.
 */

let dbPromise: Promise<Database> | null = null;
function getDb(): Promise<Database> {
  dbPromise ??= Database.load("sqlite:hive.db").catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

let tableEnsured = false;
async function ensureTable(db: Database): Promise<void> {
  if (tableEnsured) return;
  await db.execute(
    `CREATE TABLE IF NOT EXISTS private_page (
       notion_page_id TEXT PRIMARY KEY,
       title TEXT,
       icon TEXT,
       last_seen_at TEXT
     )`,
  );
  tableEnsured = true;
}

export interface PrivatePageEntry {
  id: string;
  title: string;
  icon: string | null;
}

// ---------- localStorage fallback (no SQLite — plain-browser dev/preview) ----------

interface FallbackRecord {
  id: string;
  title: string;
  icon: string | null;
  lastSeenAt: string;
}

const LS_TABLE_KEY = "hive-private-pages-fallback";

function lsRead(): Record<string, FallbackRecord> {
  try {
    return JSON.parse(localStorage.getItem(LS_TABLE_KEY) ?? "{}") as Record<
      string,
      FallbackRecord
    >;
  } catch {
    return {};
  }
}
function lsWrite(map: Record<string, FallbackRecord>): void {
  try {
    localStorage.setItem(LS_TABLE_KEY, JSON.stringify(map));
  } catch {
    /* quota or unavailable — best-effort only */
  }
}

// ---------- table access (SQLite, falling back to localStorage) ----------

function canonicalId(pageId: string): string {
  return normalizePageId(pageId) ?? pageId;
}

async function isClassified(id: string): Promise<boolean> {
  try {
    const db = await getDb();
    await ensureTable(db);
    const rows = await db.select<{ n: number }[]>(
      "SELECT 1 AS n FROM private_page WHERE notion_page_id = $1 LIMIT 1",
      [id],
    );
    return rows.length > 0;
  } catch {
    return id in lsRead();
  }
}

async function upsertPrivate(
  id: string,
  title: string,
  icon: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  try {
    const db = await getDb();
    await ensureTable(db);
    await db.execute(
      `INSERT INTO private_page (notion_page_id, title, icon, last_seen_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT(notion_page_id) DO UPDATE SET
         title = excluded.title,
         icon = excluded.icon,
         last_seen_at = excluded.last_seen_at`,
      [id, title, icon, now],
    );
  } catch {
    const map = lsRead();
    map[id] = { id, title, icon, lastSeenAt: now };
    lsWrite(map);
  }
}

export async function listPrivatePages(): Promise<PrivatePageEntry[]> {
  try {
    const db = await getDb();
    await ensureTable(db);
    const rows = await db.select<
      { notion_page_id: string; title: string | null; icon: string | null }[]
    >(
      "SELECT notion_page_id, title, icon FROM private_page ORDER BY title COLLATE NOCASE ASC",
    );
    return rows.map((r) => ({
      id: r.notion_page_id,
      title: r.title || "Untitled",
      icon: r.icon,
    }));
  } catch {
    const map = lsRead();
    return Object.values(map)
      .map((r) => ({ id: r.id, title: r.title || "Untitled", icon: r.icon }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }
}

// ---------- subscription ----------

const listeners = new Set<() => void>();

export function subscribePrivate(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notifySubscribers(): void {
  for (const fn of listeners) fn();
}

// ---------- MCP calls ----------

/** Tool results arrive as a JSON envelope ({"text": "..."}) — unwrap it, or
 * pass through if a tool ever returns the payload bare. Duplicated from
 * notionMcp.ts's private unwrapToolText rather than exporting it there,
 * since callTool is already exported and that's the only wrapper this file
 * needs. */
function unwrapToolText(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { text?: unknown };
    if (parsed && typeof parsed.text === "string") return parsed.text;
  } catch {
    /* already plain text */
  }
  return raw;
}

interface FetchMeta {
  isPrivateRoot: boolean;
  title: string | null;
  icon: string | null;
}

/** Lenient parse of notion-fetch's enhanced-markdown-with-XML-tags payload.
 * DOMParser in text/html mode (not strict XML) — same trick parseDiscussions
 * in notionMcp.ts uses, since the payload isn't well-formed XML. */
function parseFetchMeta(xml: string): FetchMeta {
  const doc = new DOMParser().parseFromString(xml, "text/html");
  const ancestorEl = doc.querySelector("ancestor-path");
  // Only classify "private root" when the tag is present AND empty — if the
  // tag is missing altogether we haven't confirmed what that means, so
  // don't guess.
  const isPrivateRoot =
    !!ancestorEl && (ancestorEl.textContent ?? "").trim().length === 0;
  // The root <page ...> wrapper is the first `page` element in document
  // order; any child-page links inside <content> appear later, as
  // descendants, so this reliably picks the fetched page's own attrs.
  const rootPage = doc.querySelector("page");
  const title = rootPage?.getAttribute("title");
  const icon = rootPage?.getAttribute("icon");
  return {
    isPrivateRoot,
    title: title || null,
    icon: icon || null,
  };
}

async function fetchMeta(id: string): Promise<FetchMeta | null> {
  try {
    const raw = await callTool("notion-fetch", { id });
    return parseFetchMeta(unwrapToolText(raw));
  } catch {
    return null;
  }
}

async function classifyAndStore(id: string, knownTitle: string | null): Promise<void> {
  const meta = await fetchMeta(id);
  if (!meta || !meta.isPrivateRoot) return;
  await upsertPrivate(id, meta.title ?? knownTitle ?? "Untitled", meta.icon);
}

async function ensureConfigPages(): Promise<void> {
  try {
    const cfg = await loadConfig();
    const ids = [cfg.scratchpad_page_id, cfg.capture_page_id].filter(
      (x): x is string => !!x,
    );
    for (const raw of ids) {
      const id = canonicalId(raw);
      if (await isClassified(id)) continue;
      const meta = await fetchMeta(id);
      await upsertPrivate(id, meta?.title ?? "Untitled", meta?.icon ?? null);
    }
  } catch {
    /* config unavailable — skip, retried on next refresh */
  }
}

const SEARCH_QUERIES = ["notes", "plan", "draft"];
const CLASSIFY_BUDGET_PER_REFRESH = 10;
const THROTTLE_KEY = "hive-private-last-refresh";
const THROTTLE_MS = 6 * 60 * 60 * 1000;

let refreshing = false;

/** Refresh the private-pages set from search + classification. Silent on
 * every failure — this is best-effort background enrichment, never a
 * blocking or user-facing error path. Pass force=true to bypass the 6h
 * throttle (the sidebar's manual ↻ button). */
export async function refreshPrivatePages(force = false): Promise<void> {
  if (refreshing) return;
  if (!force) {
    const last = Number(localStorage.getItem(THROTTLE_KEY) ?? "0");
    if (Date.now() - last < THROTTLE_MS) return;
  }

  let connected = false;
  try {
    connected = await mcpConnected();
  } catch {
    connected = false;
  }
  if (!connected) return;

  refreshing = true;
  try {
    localStorage.setItem(THROTTLE_KEY, String(Date.now()));

    await ensureConfigPages();

    const candidates = new Map<string, string>(); // id -> title
    for (const query of SEARCH_QUERIES) {
      try {
        const raw = await callTool("notion-search", {
          query,
          page_size: 25,
          max_highlight_length: 0,
          content_search_mode: "workspace_search",
        });
        const parsed = JSON.parse(unwrapToolText(raw)) as {
          results?: { id?: string; title?: string }[];
        };
        for (const r of parsed.results ?? []) {
          if (!r.id) continue;
          const id = canonicalId(r.id);
          if (!candidates.has(id)) candidates.set(id, r.title || "Untitled");
        }
      } catch {
        /* one query failing shouldn't block the others */
      }
    }

    let budget = CLASSIFY_BUDGET_PER_REFRESH;
    for (const [id, title] of candidates) {
      if (budget <= 0) break;
      if (await isClassified(id)) continue;
      budget -= 1;
      await classifyAndStore(id, title);
    }
  } catch {
    /* fully silent */
  } finally {
    refreshing = false;
    notifySubscribers();
  }
}
