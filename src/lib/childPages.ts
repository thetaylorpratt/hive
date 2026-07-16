import Database from "@tauri-apps/plugin-sql";
import { normalizePageId } from "./fetchPage";
import type { HiveBlock } from "./types";

/**
 * Child-page discovery for the sidebar's expand/collapse trees (feature B).
 *
 * Reads ONLY the local cache (page_cache.blocks_json) — never fetches
 * remotely. That keeps expansion instant: a page's children show up once
 * the user has visited it (which populates blocks_json with its child_page
 * blocks), not before. An uncached page simply reports no children until
 * visited.
 */

const isTauri = "__TAURI_INTERNALS__" in window;

let dbPromise: Promise<Database> | null = null;

function getDb(): Promise<Database> {
  // Don't cache a rejection — one failed load shouldn't wedge every caller.
  dbPromise ??= Database.load("sqlite:hive.db").catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

export interface ChildPageEntry {
  id: string;
  title: string;
  icon: string | null; // Notion doesn't expose an icon on child_page blocks
}

interface BlocksRow {
  blocks_json: string;
}

/**
 * Preview-only test seam: outside Tauri (the plain-browser preview at
 * :4173, which has no SQLite/page_cache), childPagesOf/hasChildPages can be
 * driven by this override so the expand/collapse UI is verifiable without a
 * real cached page. Never consulted inside the Tauri build. Set it like:
 *   window.__hiveTestChildren = { "<pageId>": [{ id, title, icon: null }] };
 */
declare global {
  interface Window {
    __hiveTestChildren?: Record<string, ChildPageEntry[]>;
  }
}

function canonicalId(pageId: string): string {
  return normalizePageId(pageId) ?? pageId;
}

export async function hasChildPages(pageId: string): Promise<boolean> {
  const id = canonicalId(pageId);
  if (!isTauri && window.__hiveTestChildren) {
    return (window.__hiveTestChildren[id]?.length ?? 0) > 0;
  }
  try {
    const db = await getDb();
    const rows = await db.select<{ n: number }[]>(
      `SELECT 1 AS n FROM page_cache
       WHERE notion_page_id = $1 AND blocks_json LIKE '%"type":"child_page"%'
       LIMIT 1`,
      [id],
    );
    return rows.length > 0;
  } catch {
    return false; // no SQLite (plain-browser dev without the test seam) — no children
  }
}

export async function childPagesOf(pageId: string): Promise<ChildPageEntry[]> {
  const id = canonicalId(pageId);
  if (!isTauri && window.__hiveTestChildren) {
    return window.__hiveTestChildren[id] ?? [];
  }
  try {
    const db = await getDb();
    const rows = await db.select<BlocksRow[]>(
      "SELECT blocks_json FROM page_cache WHERE notion_page_id = $1",
      [id],
    );
    const row = rows[0];
    if (!row) return [];
    const blocks = JSON.parse(row.blocks_json) as HiveBlock[];
    const out: ChildPageEntry[] = [];
    const walk = (list: HiveBlock[]) => {
      for (const b of list) {
        if (b.type === "child_page") {
          const title =
            (b.child_page as { title?: string } | undefined)?.title || "Untitled";
          out.push({ id: b.id, title, icon: null });
          // child_page contents are a separate document that was never
          // recursed into when this page was fetched (see fetchPage.ts's
          // NO_RECURSE) — nothing further to walk under it here.
          continue;
        }
        if (b.children) walk(b.children);
      }
    };
    walk(blocks);
    return out;
  } catch {
    return []; // corrupt cache entry or no SQLite — treat as no children
  }
}
