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
  await db.execute(
    `INSERT INTO page_cache (notion_page_id, blocks_json, properties_json, fetched_at, etag)
     VALUES ($1, $2, $3, $4, NULL)
     ON CONFLICT(notion_page_id) DO UPDATE SET
       blocks_json = excluded.blocks_json,
       properties_json = excluded.properties_json,
       fetched_at = excluded.fetched_at`,
    [pageId, JSON.stringify(blocks), JSON.stringify(page), new Date().toISOString()],
  );
}
