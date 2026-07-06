import Database from "@tauri-apps/plugin-sql";
import type { HiveBlock, PageData } from "./types";

/**
 * Content-plane cache (read-only mirror of Notion — ARCHITECTURE.md §2).
 * Schema is created by the Rust-side migration in src-tauri/src/lib.rs.
 */

let dbPromise: Promise<Database> | null = null;

function getDb(): Promise<Database> {
  dbPromise ??= Database.load("sqlite:hive.db");
  return dbPromise;
}

interface PageCacheRow {
  notion_page_id: string;
  blocks_json: string;
  properties_json: string;
  fetched_at: string;
  etag: string | null;
}

export async function getCachedPage(pageId: string): Promise<PageData | null> {
  const db = await getDb();
  const rows = await db.select<PageCacheRow[]>(
    "SELECT * FROM page_cache WHERE notion_page_id = $1",
    [pageId],
  );
  const row = rows[0];
  if (!row) return null;
  try {
    return {
      page: JSON.parse(row.properties_json) as Record<string, unknown>,
      blocks: JSON.parse(row.blocks_json) as HiveBlock[],
      fetchedAt: row.fetched_at,
      fromCache: true,
    };
  } catch {
    return null; // corrupt cache entry: treat as miss, refetch will overwrite
  }
}

export async function upsertPageCache(
  pageId: string,
  page: Record<string, unknown>,
  blocks: HiveBlock[],
): Promise<void> {
  const db = await getDb();
  const editedTime = (page.last_edited_time as string | undefined) ?? null;
  await db.execute(
    `INSERT INTO page_cache (notion_page_id, blocks_json, properties_json, fetched_at, etag, last_edited_time)
     VALUES ($1, $2, $3, $4, NULL, $5)
     ON CONFLICT(notion_page_id) DO UPDATE SET
       blocks_json = excluded.blocks_json,
       properties_json = excluded.properties_json,
       fetched_at = excluded.fetched_at,
       last_edited_time = excluded.last_edited_time`,
    [pageId, JSON.stringify(blocks), JSON.stringify(page), new Date().toISOString(), editedTime],
  );
}

/* ---- local full-text search (FTS5; graceful no-op if unavailable) ---- */

let ftsAvailable: boolean | null = null;

async function ensureFts(db: Database): Promise<boolean> {
  if (ftsAvailable !== null) return ftsAvailable;
  try {
    await db.execute(
      "CREATE VIRTUAL TABLE IF NOT EXISTS page_fts USING fts5(notion_page_id UNINDEXED, title, body)",
    );
    ftsAvailable = true;
  } catch {
    ftsAvailable = false; // SQLite built without FTS5 — search degrades to titles
  }
  return ftsAvailable;
}

export async function indexPageForSearch(
  pageId: string,
  title: string,
  body: string,
): Promise<void> {
  try {
    const db = await getDb();
    if (!(await ensureFts(db))) return;
    await db.execute("DELETE FROM page_fts WHERE notion_page_id = $1", [pageId]);
    await db.execute(
      "INSERT INTO page_fts (notion_page_id, title, body) VALUES ($1, $2, $3)",
      [pageId, title, body],
    );
  } catch {
    /* indexing is best-effort */
  }
}

export interface SearchHit {
  pageId: string;
  title: string;
  snippet: string;
}

export async function searchCachedPages(query: string): Promise<SearchHit[]> {
  try {
    const db = await getDb();
    if (!(await ensureFts(db))) return [];
    const terms = query.replace(/['"*^]/g, " ").trim();
    if (!terms) return [];
    const match = terms
      .split(/\s+/)
      .map((t) => `"${t}"*`)
      .join(" ");
    const rows = await db.select<
      { notion_page_id: string; title: string; snip: string }[]
    >(
      `SELECT notion_page_id, title, snippet(page_fts, 2, '', '', '…', 10) AS snip
       FROM page_fts WHERE page_fts MATCH $1 ORDER BY rank LIMIT 10`,
      [match],
    );
    return rows.map((r) => ({
      pageId: r.notion_page_id,
      title: r.title || "Untitled",
      snippet: r.snip,
    }));
  } catch {
    return [];
  }
}

/** Persist edited block tree without touching page properties (editor path). */
export async function updateCachedBlocks(
  pageId: string,
  blocks: HiveBlock[],
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE page_cache SET blocks_json = $2, fetched_at = $3 WHERE notion_page_id = $1",
    [pageId, JSON.stringify(blocks), new Date().toISOString()],
  );
}

/** Change-detection metadata (Notifications Tier A). Update-if-cached. */
export async function setPageEditTime(pageId: string, editedTime: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE page_cache SET last_edited_time = $2 WHERE notion_page_id = $1",
    [pageId, editedTime],
  );
}

export async function getPageEditTimes(): Promise<Record<string, string>> {
  try {
    const db = await getDb();
    const rows = await db.select<{ notion_page_id: string; last_edited_time: string | null }[]>(
      "SELECT notion_page_id, last_edited_time FROM page_cache WHERE last_edited_time IS NOT NULL",
    );
    return Object.fromEntries(rows.map((r) => [r.notion_page_id, r.last_edited_time!]));
  } catch {
    return {}; // no SQLite (plain-browser dev) — attention engine stays in-memory
  }
}
