import Database from "@tauri-apps/plugin-sql";

/**
 * Navigation intelligence (ARCHITECTURE.md §4): every page open records a
 * hit; the command bar ranks recents by frequency × recency decay. SQLite
 * under Tauri, localStorage fallback in plain-browser dev.
 */

export interface FrecencyEntry {
  notionPageId: string;
  hitCount: number;
  lastHitAt: string;
  titleCache: string;
  iconCache: string | null;
}

const HALF_LIFE_DAYS = 14;

export function frecencyScore(entry: FrecencyEntry, now = Date.now()): number {
  const ageDays =
    (now - new Date(entry.lastHitAt).getTime()) / (24 * 60 * 60 * 1000);
  return entry.hitCount * Math.pow(0.5, Math.max(0, ageDays) / HALF_LIFE_DAYS);
}

let db: Database | null = null;
let local: Record<string, FrecencyEntry> | null = null;

async function backend(): Promise<"sql" | "local"> {
  if (db) return "sql";
  if (local) return "local";
  try {
    db = await Database.load("sqlite:hive.db");
    return "sql";
  } catch {
    try {
      local = JSON.parse(localStorage.getItem("hive-frecency") ?? "{}");
    } catch {
      local = null;
    }
    local ??= {}; // corrupt or "null" snapshot: reset
    return "local";
  }
}

export async function recordHit(
  notionPageId: string,
  title: string,
  icon: string | null,
): Promise<void> {
  const at = new Date().toISOString();
  if ((await backend()) === "sql") {
    await db!.execute(
      `INSERT INTO frecency (notion_page_id, hit_count, last_hit_at, title_cache, icon_cache)
       VALUES ($1, 1, $2, $3, $4)
       ON CONFLICT(notion_page_id) DO UPDATE SET
         hit_count = hit_count + 1,
         last_hit_at = excluded.last_hit_at,
         title_cache = excluded.title_cache,
         icon_cache = excluded.icon_cache`,
      [notionPageId, at, title, icon],
    );
  } else {
    const prev = local![notionPageId];
    local![notionPageId] = {
      notionPageId,
      hitCount: (prev?.hitCount ?? 0) + 1,
      lastHitAt: at,
      titleCache: title,
      iconCache: icon,
    };
    localStorage.setItem("hive-frecency", JSON.stringify(local));
  }
}

export async function topRecents(limit = 30): Promise<FrecencyEntry[]> {
  let entries: FrecencyEntry[];
  if ((await backend()) === "sql") {
    const rows = await db!.select<
      {
        notion_page_id: string;
        hit_count: number;
        last_hit_at: string | null;
        title_cache: string | null;
        icon_cache: string | null;
      }[]
    >("SELECT * FROM frecency");
    entries = rows.map((r) => ({
      notionPageId: r.notion_page_id,
      hitCount: r.hit_count,
      lastHitAt: r.last_hit_at ?? new Date(0).toISOString(),
      titleCache: r.title_cache ?? "Untitled",
      iconCache: r.icon_cache,
    }));
  } else {
    entries = Object.values(local!);
  }
  const now = Date.now();
  return entries
    .sort((a, b) => frecencyScore(b, now) - frecencyScore(a, now))
    .slice(0, limit);
}
