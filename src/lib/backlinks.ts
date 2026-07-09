import Database from "@tauri-apps/plugin-sql";
import { normalizePageId } from "./fetchPage";
import { pageTitle, pageEmoji } from "./pageMeta";
import { DEMO_PAGE_ID } from "./demoPage";

/**
 * "Linked from" — pages in the local cache whose content references the
 * given page, computed entirely offline from page_cache.blocks_json.
 *
 * page_fts strips hrefs during indexing (it only stores plain text), so it
 * can't answer "who links to X" — we fall back to a LIKE scan over the raw
 * block JSON instead. The cached corpus is a few hundred rows at most, so
 * two LIKE queries per lookup is cheap.
 *
 * A page id can appear in cached block JSON in two shapes:
 *  - dashed UUID (`"id":"xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"`) — how page
 *    mentions and Notion's structured `link_to_page` blocks store the id.
 *  - undashed 32-hex run — how notion.so URLs embed the id (plain-text
 *    links pasted as `https://www.notion.so/Some-Title-<32hex>`).
 * We search for both forms.
 */

let dbPromise: Promise<Database> | null = null;

function getDb(): Promise<Database> {
  dbPromise ??= Database.load("sqlite:hive.db").catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

export interface Backlink {
  pageId: string;
  title: string;
  icon: string | null;
}

interface BacklinkRow {
  notion_page_id: string;
  properties_json: string;
}

export async function findBacklinks(pageId: string): Promise<Backlink[]> {
  const normalized = normalizePageId(pageId);
  if (!normalized) return []; // an empty pattern would LIKE-match every row
  const dashed = normalized.toLowerCase();
  const undashed = dashed.replace(/-/g, "");

  if (dashed === DEMO_PAGE_ID) return [];

  try {
    const db = await getDb();
    const rows = await db.select<BacklinkRow[]>(
      `SELECT notion_page_id, properties_json FROM page_cache
       WHERE (blocks_json LIKE '%'||$1||'%' OR blocks_json LIKE '%'||$2||'%')
         AND notion_page_id != $3`,
      [dashed, undashed, dashed],
    );

    const results: Backlink[] = [];
    for (const row of rows) {
      const rowId = (normalizePageId(row.notion_page_id) ?? row.notion_page_id).toLowerCase();
      if (rowId === dashed || rowId === undashed) continue; // self, in any id form
      if (rowId === DEMO_PAGE_ID) continue;
      try {
        const page = JSON.parse(row.properties_json) as Record<string, unknown>;
        results.push({
          pageId: row.notion_page_id,
          title: pageTitle(page),
          icon: pageEmoji(page),
        });
      } catch {
        /* corrupt cache entry: skip, don't fail the whole lookup */
      }
    }
    return results;
  } catch {
    return []; // no SQLite (plain-browser dev) — backlinks degrade to nothing
  }
}
