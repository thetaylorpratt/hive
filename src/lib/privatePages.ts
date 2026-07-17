import Database from "@tauri-apps/plugin-sql";
import { dlog } from "./debugLog";
import { callTool, mcpConnected } from "./notionMcp";
import { normalizePageId } from "./fetchPage";
import { loadConfig } from "./config";
import { notion } from "./notionClient";
import { enqueue } from "./queue";

/**
 * Discovery + classification of the user's PRIVATE Notion pages — the
 * workspace-level "Private" section Notion shows automatically, with no
 * manual pinning. There is no enumeration API for this, so Hive infers it
 * with a TWO-FACTOR classifier — both must hold for a candidate to be
 * stored as private:
 *
 *  (a) Ancestor factor — notion-fetch's enhanced-markdown-with-XML-tags
 *      payload has an <ancestor-path> element that exists AND has no child
 *      elements (no <parent-page>/<ancestor-N-page> tags). A teamspace page
 *      always has ancestry; a private root does not. Parsed leniently via
 *      DOMParser in text/html mode (the payload isn't well-formed XML, and
 *      HTML parsing silently "un-self-closes" custom tags like
 *      <parent-page .../> — checking element CHILDREN, not textContent,
 *      is what makes this reliable; textContent is empty either way since
 *      the ancestor info lives in attributes, not text nodes).
 *  (b) Bot-visibility factor — a REST `pages.retrieve` for the same id
 *      either FAILS (the integration can't read it — not shared into any
 *      connected teamspace) or the id is one of Hive's own scratchpad /
 *      capture page ids. Those two are deliberately shared with the
 *      integration (so Hive can write to them) yet are still the user's
 *      private pages — the explicit override exists for exactly that.
 *
 * Once a page id is classified (private or not), it's remembered forever —
 * never re-probed, never deleted (private roots stay put; Notion doesn't
 * offer a "make public" that would need to reverse this).
 */

let dbPromise: Promise<Database> | null = null;
function getDb(): Promise<Database> {
  dbPromise ??= Database.load("sqlite:hive.db").catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

// v2: the v0.10.0 table (`private_page`) misclassified team pages due to a
// parsing bug (see parseAncestorPath below) — bumping the table name resets
// the store cleanly rather than trying to selectively repair bad rows.
const TABLE = "private_page_v2";

let tableEnsured = false;
async function ensureTable(db: Database): Promise<void> {
  if (tableEnsured) return;
  await db.execute(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
       notion_page_id TEXT PRIMARY KEY,
       title TEXT,
       icon TEXT,
       classified_at TEXT
     )`,
  );
  await db.execute(
    `CREATE TABLE IF NOT EXISTS private_probe (
       notion_page_id TEXT PRIMARY KEY,
       verdict TEXT,
       classified_at TEXT
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
  classifiedAt: string;
}

const LS_TABLE_KEY = "hive-private-pages-v2-fallback";

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

/* NEGATIVE classifications must be remembered too: without this, every
 * refresh burned its whole budget re-probing the same top-ranked (team)
 * search results, and discovery never advanced past them. */
const PROBE_TABLE = "private_probe";
const LS_PROBE_KEY = "hive-private-probe-fallback";

async function recordVerdict(id: string, verdict: "private" | "not-private"): Promise<void> {
  try {
    const db = await getDb();
    await ensureTable(db);
    await db.execute(
      `INSERT INTO ${PROBE_TABLE} (notion_page_id, verdict, classified_at)
       VALUES ($1, $2, $3)
       ON CONFLICT(notion_page_id) DO UPDATE SET verdict = excluded.verdict, classified_at = excluded.classified_at`,
      [id, verdict, new Date().toISOString()],
    );
  } catch {
    try {
      const map = JSON.parse(localStorage.getItem(LS_PROBE_KEY) ?? "{}") as Record<string, string>;
      map[id] = verdict;
      localStorage.setItem(LS_PROBE_KEY, JSON.stringify(map));
    } catch {
      /* best-effort */
    }
  }
}

async function isClassified(id: string): Promise<boolean> {
  try {
    const db = await getDb();
    await ensureTable(db);
    const rows = await db.select<{ n: number }[]>(
      `SELECT 1 AS n FROM ${PROBE_TABLE} WHERE notion_page_id = $1
       UNION SELECT 1 FROM ${TABLE} WHERE notion_page_id = $1 LIMIT 1`,
      [id],
    );
    return rows.length > 0;
  } catch {
    try {
      const probes = JSON.parse(localStorage.getItem(LS_PROBE_KEY) ?? "{}") as Record<string, string>;
      if (id in probes) return true;
    } catch {
      /* fall through */
    }
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
      `INSERT INTO ${TABLE} (notion_page_id, title, icon, classified_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT(notion_page_id) DO UPDATE SET
         title = excluded.title,
         icon = excluded.icon,
         classified_at = excluded.classified_at`,
      [id, title, icon, now],
    );
  } catch {
    const map = lsRead();
    map[id] = { id, title, icon, classifiedAt: now };
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
      `SELECT notion_page_id, title, icon FROM ${TABLE} ORDER BY title COLLATE NOCASE ASC`,
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

/** Icon transform: the fetch tool's `icon` attribute on the root <page> is
 * either an emoji, an https URL, or (for Notion's built-in tintable icon
 * set) a bare name like "icons/pencil_lightgray" — NOT renderable as-is
 * (that's the literal-text-icon bug). Turn the builtin form into the same
 * icons.notion.so SVG URL the REST icon.icon.{name,color} shape maps to
 * (see pageMeta.ts's pageEmoji); leave emoji and URLs untouched. */
export function transformFetchIcon(icon: string | null): string | null {
  if (!icon) return null;
  if (icon.startsWith("http://") || icon.startsWith("https://")) return icon;
  if (icon.startsWith("icons/")) return `https://www.notion.so/${icon}.svg`;
  return icon;
}

/**
 * Factor (a): does this notion-fetch XML payload's <ancestor-path> exist
 * AND have no child elements? Exported standalone for testability. Checks
 * `children.length`, NOT textContent — ancestor tags like
 * <parent-page url="..." title="..."/> carry their info in ATTRIBUTES, so
 * textContent is empty whether or not the tag is present (that was the
 * v0.10.0 bug: an ancestor-path containing real ancestor tags still had
 * empty textContent and was misread as a private root).
 */
export function parseAncestorPath(xml: string): boolean {
  const doc = new DOMParser().parseFromString(xml, "text/html");
  const ancestorEl = doc.querySelector("ancestor-path");
  // Missing tag altogether = unconfirmed; don't guess private.
  if (!ancestorEl) return false;
  return ancestorEl.children.length === 0;
}

interface FetchMeta {
  ancestorEligible: boolean;
  title: string | null;
  icon: string | null;
}

/** Lenient parse of notion-fetch's enhanced-markdown-with-XML-tags payload. */
function parseFetchMeta(xml: string): FetchMeta {
  const doc = new DOMParser().parseFromString(xml, "text/html");
  // The root <page ...> wrapper is the first `page` element in document
  // order; any child-page links inside <content> appear later, as
  // descendants, so this reliably picks the fetched page's own attrs.
  const rootPage = doc.querySelector("page");
  return {
    ancestorEligible: parseAncestorPath(xml),
    title: rootPage?.getAttribute("title") || null,
    icon: rootPage?.getAttribute("icon") || null,
  };
}

async function fetchMeta(id: string): Promise<FetchMeta | null> {
  try {
    const raw = await callTool("notion-fetch", { id });
    const meta = parseFetchMeta(unwrapToolText(raw));
    // The page TITLE lives in the JSON envelope, not the XML (<page> has
    // url/icon attrs only) — unwrapping discarded it, which made even
    // Scratchpad die at the no-title check.
    if (!meta.title) {
      try {
        const envelope = JSON.parse(raw) as { title?: string };
        if (typeof envelope.title === "string") meta.title = envelope.title;
      } catch {
        /* raw wasn't the JSON envelope — keep whatever the XML gave us */
      }
    }
    return meta;
  } catch (err) {
    dlog(
      `PRIV fetchMeta ..${id.slice(-8)} THREW: ${err instanceof Error ? err.message.slice(0, 80) : err}`,
    );
    return null;
  }
}

/** Factor (b)'s REST probe: is this id readable by the bot integration at
 * all? Run through the shared rate-limited queue like every other Notion
 * REST call in the app. */
async function isReadableByBot(id: string): Promise<boolean> {
  try {
    await enqueue(() => notion().pages.retrieve({ page_id: id }));
    return true;
  } catch {
    return false;
  }
}

interface ConfigPageIds {
  scratchpadId: string | null;
  captureId: string | null;
}

/** Two-factor classification. Both factors must hold for the candidate to
 * be stored: (a) the ancestor-path is present and empty, and (b) either the
 * REST probe fails (not bot-readable) or the id is Hive's own scratchpad /
 * capture page (explicitly shared, still private). Skips storing anything
 * with no real title anywhere rather than upserting a junk "Untitled" row. */
async function classifyAndStore(
  id: string,
  knownTitle: string,
  cfg: ConfigPageIds,
): Promise<void> {
  const meta = await fetchMeta(id);
  if (!meta) {
    // Transient (network/session) — do NOT record a verdict; retry later.
    dlog(`PRIV classify ..${id.slice(-8)} SKIP fetch-failed (will retry)`);
    return;
  }
  if (!meta.ancestorEligible) {
    dlog(`PRIV classify ..${id.slice(-8)} REJECT factor-a hasAncestors`);
    await recordVerdict(id, "not-private");
    return;
  }

  const isConfigPage = id === cfg.scratchpadId || id === cfg.captureId;
  const factorB = isConfigPage || !(await isReadableByBot(id));
  if (!factorB) {
    dlog(`PRIV classify ..${id.slice(-8)} REJECT factor-b (bot-readable, not config)`);
    await recordVerdict(id, "not-private");
    return;
  }

  // Both factors passed — store even without a title ("Untitled" pages are
  // legitimately private; the v0.10.0 junk came from misclassification,
  // not untitled-ness).
  const title = (meta.title || knownTitle || "").trim() || "Untitled";

  dlog(`PRIV classify ..${id.slice(-8)} PRIVATE "${title.slice(0, 30)}"`);
  await upsertPrivate(id, title, transformFetchIcon(meta.icon));
  await recordVerdict(id, "private");
}

const SEARCH_QUERIES = ["notes", "plan", "draft", "meeting", "scratchpad"];
const CLASSIFY_BUDGET_PER_REFRESH = 10;
const THROTTLE_KEY = "hive-private-last-refresh";
const THROTTLE_MS = 6 * 60 * 60 * 1000;

let refreshing = false;

/** Refresh the private-pages set from search + classification. Silent on
 * every failure — this is best-effort background enrichment, never a
 * blocking or user-facing error path. Pass force=true to bypass the 6h
 * throttle (the sidebar's manual ↻ button). */
export async function refreshPrivatePages(force = false): Promise<void> {
  if (refreshing) {
    dlog("PRIV refresh SKIP: already running");
    return;
  }
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
  dlog(`PRIV refresh start force=${force} connected=${connected}`);
  if (!connected) return;

  refreshing = true;
  try {
    localStorage.setItem(THROTTLE_KEY, String(Date.now()));

    const cfg = await loadConfig().catch(() => null);
    const cfgIds: ConfigPageIds = {
      scratchpadId: cfg?.scratchpad_page_id ? canonicalId(cfg.scratchpad_page_id) : null,
      captureId: cfg?.capture_page_id ? canonicalId(cfg.capture_page_id) : null,
    };

    // Hive's own pages: classified unconditionally every refresh, outside
    // the search budget below (they must always end up in the store once
    // shared, regardless of what else is competing for the 10-item budget).
    for (const id of [cfgIds.scratchpadId, cfgIds.captureId]) {
      if (!id) continue;
      if (await isClassified(id)) continue;
      await classifyAndStore(id, "", cfgIds);
    }

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
          if (!candidates.has(id)) candidates.set(id, r.title || "");
        }
      } catch {
        /* one query failing shouldn't block the others */
      }
    }

    dlog(`PRIV refresh cfg=[${cfgIds.scratchpadId?.slice(-8) ?? "-"},${cfgIds.captureId?.slice(-8) ?? "-"}] candidates=${candidates.size}`);
    // Manual ↻ is explicit user intent — probe harder than background runs.
    let budget = force ? 25 : CLASSIFY_BUDGET_PER_REFRESH;
    for (const [id, title] of candidates) {
      if (budget <= 0) break;
      if (await isClassified(id)) continue;
      budget -= 1;
      await classifyAndStore(id, title, cfgIds);
    }
    dlog(`PRIV refresh done, budget left=${budget}`);
  } catch (err) {
    dlog(`PRIV refresh THREW: ${err instanceof Error ? err.message.slice(0, 100) : err}`);
  } finally {
    refreshing = false;
    notifySubscribers();
  }
}
