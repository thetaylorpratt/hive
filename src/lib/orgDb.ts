import Database from "@tauri-apps/plugin-sql";

/**
 * Organization plane (ARCHITECTURE.md §2/§4): Spaces, sidebar items, folders.
 * Local, private, mutable — holds pointers (Notion page IDs) plus placement.
 * NEVER written to Notion.
 *
 * Backend: SQLite under Tauri; a localStorage snapshot when the SQL plugin is
 * unavailable (plain-browser dev/preview) so the whole org UX stays testable
 * without the desktop shell.
 */

export type Tier = "favorite" | "pinned" | "today";

export interface Space {
  id: string;
  name: string;
  color: string; // accent key, see SPACE_ACCENTS in theme.css
  icon: string | null; // emoji; falls back to the name's first letter
  sortOrder: number;
  createdAt: string;
}

export interface SidebarItem {
  id: string;
  spaceId: string | null; // null ⇒ favorite (transcends Spaces)
  notionPageId: string;
  tier: Tier;
  parentFolderId: string | null;
  sortOrder: number;
  titleCache: string;
  iconCache: string | null;
  lastOpenedAt: string | null;
  autoArchiveAt: string | null; // set for 'today' tier
}

export interface Folder {
  id: string;
  spaceId: string;
  name: string;
  parentFolderId: string | null;
  sortOrder: number;
}

export const SPACE_ACCENTS = ["sky", "green", "amber", "red", "purple", "teal"];
export const TODAY_TTL_MS = 24 * 60 * 60 * 1000;

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

/* ------------------------------------------------------------------ */
/* Backend selection                                                    */
/* ------------------------------------------------------------------ */

interface OrgSnapshot {
  spaces: Space[];
  items: SidebarItem[];
  folders: Folder[];
}

let db: Database | null = null;
let local: OrgSnapshot | null = null;

async function backend(): Promise<"sql" | "local"> {
  if (db) return "sql";
  if (local) return "local";
  try {
    db = await Database.load("sqlite:hive.db");
    return "sql";
  } catch {
    const raw = localStorage.getItem("hive-org");
    local = raw
      ? (JSON.parse(raw) as OrgSnapshot)
      : { spaces: [], items: [], folders: [] };
    return "local";
  }
}

function persistLocal() {
  if (local) localStorage.setItem("hive-org", JSON.stringify(local));
}

/* ------------------------------------------------------------------ */
/* Row mapping (SQL is snake_case)                                      */
/* ------------------------------------------------------------------ */

interface ItemRow {
  id: string;
  space_id: string | null;
  notion_page_id: string;
  tier: Tier;
  parent_folder_id: string | null;
  sort_order: number;
  title_cache: string | null;
  icon_cache: string | null;
  last_opened_at: string | null;
  auto_archive_at: string | null;
}

const itemFromRow = (r: ItemRow): SidebarItem => ({
  id: r.id,
  spaceId: r.space_id,
  notionPageId: r.notion_page_id,
  tier: r.tier,
  parentFolderId: r.parent_folder_id,
  sortOrder: r.sort_order,
  titleCache: r.title_cache ?? "Untitled",
  iconCache: r.icon_cache,
  lastOpenedAt: r.last_opened_at,
  autoArchiveAt: r.auto_archive_at,
});

/* ------------------------------------------------------------------ */
/* Spaces                                                               */
/* ------------------------------------------------------------------ */

export async function listSpaces(): Promise<Space[]> {
  if ((await backend()) === "sql") {
    const rows = await db!.select<
      { id: string; name: string; color: string; icon: string | null; sort_order: number; created_at: string }[]
    >("SELECT * FROM space ORDER BY sort_order");
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      icon: r.icon ?? null,
      sortOrder: r.sort_order,
      createdAt: r.created_at,
    }));
  }
  return [...local!.spaces]
    .map((s) => ({ ...s, icon: s.icon ?? null }))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

export async function createSpace(name: string, color: string): Promise<Space> {
  const existing = await listSpaces();
  const space: Space = {
    id: uuid(),
    name,
    color,
    icon: null,
    sortOrder: existing.length,
    createdAt: now(),
  };
  if ((await backend()) === "sql") {
    await db!.execute(
      "INSERT INTO space (id, name, color, icon, sort_order, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [space.id, space.name, space.color, space.icon, space.sortOrder, space.createdAt],
    );
  } else {
    local!.spaces.push(space);
    persistLocal();
  }
  return space;
}

export async function updateSpace(
  id: string,
  patch: Partial<Pick<Space, "name" | "color" | "icon">>,
): Promise<void> {
  const entries = Object.entries(patch);
  if (!entries.length) return;
  if ((await backend()) === "sql") {
    const sets = entries.map(([k], i) => `${k} = $${i + 2}`).join(", ");
    await db!.execute(`UPDATE space SET ${sets} WHERE id = $1`, [
      id,
      ...entries.map(([, v]) => v),
    ]);
  } else {
    const s = local!.spaces.find((s) => s.id === id);
    if (s) Object.assign(s, patch);
    persistLocal();
  }
}

/** First-run seed: guarantees at least one Space exists. */
export async function ensureDefaultSpace(): Promise<Space[]> {
  const spaces = await listSpaces();
  if (spaces.length > 0) return spaces;
  const home = await createSpace("Home", "sky");
  return [home];
}

/* ------------------------------------------------------------------ */
/* Sidebar items                                                        */
/* ------------------------------------------------------------------ */

/** Favorites (space_id NULL) plus everything in the given Space. */
export async function listSidebar(spaceId: string): Promise<SidebarItem[]> {
  if ((await backend()) === "sql") {
    const rows = await db!.select<ItemRow[]>(
      "SELECT * FROM sidebar_item WHERE space_id = $1 OR space_id IS NULL ORDER BY sort_order",
      [spaceId],
    );
    return rows.map(itemFromRow);
  }
  return local!.items
    .filter((i) => i.spaceId === spaceId || i.spaceId === null)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/** Favorites + pins across ALL Spaces — the attention engine's watch list. */
export async function listAllWatched(): Promise<SidebarItem[]> {
  if ((await backend()) === "sql") {
    const rows = await db!.select<ItemRow[]>(
      "SELECT * FROM sidebar_item WHERE tier IN ('favorite', 'pinned')",
    );
    return rows.map(itemFromRow);
  }
  return local!.items.filter(
    (i) => i.tier === "favorite" || i.tier === "pinned",
  );
}

async function insertItem(item: SidebarItem): Promise<void> {
  if ((await backend()) === "sql") {
    await db!.execute(
      `INSERT INTO sidebar_item
         (id, space_id, notion_page_id, tier, parent_folder_id, sort_order,
          title_cache, icon_cache, last_opened_at, auto_archive_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        item.id,
        item.spaceId,
        item.notionPageId,
        item.tier,
        item.parentFolderId,
        item.sortOrder,
        item.titleCache,
        item.iconCache,
        item.lastOpenedAt,
        item.autoArchiveAt,
      ],
    );
  } else {
    local!.items.push(item);
    persistLocal();
  }
}

export async function updateItem(
  id: string,
  patch: Partial<
    Pick<
      SidebarItem,
      | "spaceId"
      | "tier"
      | "parentFolderId"
      | "sortOrder"
      | "titleCache"
      | "iconCache"
      | "lastOpenedAt"
      | "autoArchiveAt"
    >
  >,
): Promise<void> {
  if ((await backend()) === "sql") {
    const cols: Record<string, string> = {
      spaceId: "space_id",
      tier: "tier",
      parentFolderId: "parent_folder_id",
      sortOrder: "sort_order",
      titleCache: "title_cache",
      iconCache: "icon_cache",
      lastOpenedAt: "last_opened_at",
      autoArchiveAt: "auto_archive_at",
    };
    const entries = Object.entries(patch);
    if (!entries.length) return;
    const sets = entries.map(([k], i) => `${cols[k]} = $${i + 2}`).join(", ");
    await db!.execute(`UPDATE sidebar_item SET ${sets} WHERE id = $1`, [
      id,
      ...entries.map(([, v]) => v),
    ]);
  } else {
    const item = local!.items.find((i) => i.id === id);
    if (item) Object.assign(item, patch);
    persistLocal();
  }
}

export async function deleteItem(id: string): Promise<void> {
  if ((await backend()) === "sql") {
    await db!.execute("DELETE FROM sidebar_item WHERE id = $1", [id]);
  } else {
    local!.items = local!.items.filter((i) => i.id !== id);
    persistLocal();
  }
}

/** Rewrite sort orders after a drag-reorder (ids in their new order). */
export async function reorderItems(idsInOrder: string[]): Promise<void> {
  for (let i = 0; i < idsInOrder.length; i++) {
    await updateItem(idsInOrder[i], { sortOrder: i });
  }
}

/**
 * Record "this page was opened in this Space": refresh an existing entry
 * (any tier — favorites and pins count) or create a 'today' item. Today
 * entries get their auto-archive extended on every open.
 */
export async function touchToday(
  spaceId: string,
  notionPageId: string,
  title: string,
  icon: string | null,
): Promise<void> {
  const items = await listSidebar(spaceId);
  const existing = items.find((i) => i.notionPageId === notionPageId);
  const opened = now();
  const archiveAt = new Date(Date.now() + TODAY_TTL_MS).toISOString();
  if (existing) {
    await updateItem(existing.id, {
      titleCache: title,
      iconCache: icon,
      lastOpenedAt: opened,
      ...(existing.tier === "today" ? { autoArchiveAt: archiveAt } : {}),
    });
    return;
  }
  const todayCount = items.filter((i) => i.tier === "today").length;
  await insertItem({
    id: uuid(),
    spaceId,
    notionPageId,
    tier: "today",
    parentFolderId: null,
    sortOrder: todayCount,
    titleCache: title,
    iconCache: icon,
    lastOpenedAt: opened,
    autoArchiveAt: archiveAt,
  });
}

/** Change an item's tier (pin / favorite / demote back to today). */
export async function setTier(
  id: string,
  tier: Tier,
  spaceId: string,
): Promise<void> {
  await updateItem(id, {
    tier,
    // favorites transcend Spaces; pins/today belong to the active Space
    spaceId: tier === "favorite" ? null : spaceId,
    parentFolderId: null,
    autoArchiveAt:
      tier === "today" ? new Date(Date.now() + TODAY_TTL_MS).toISOString() : null,
  });
}

/** Kill the 300-stale-tabs problem: drop expired 'today' entries. */
export async function archiveExpiredToday(): Promise<number> {
  const cutoff = now();
  if ((await backend()) === "sql") {
    const result = await db!.execute(
      "DELETE FROM sidebar_item WHERE tier = 'today' AND auto_archive_at IS NOT NULL AND auto_archive_at < $1",
      [cutoff],
    );
    return result.rowsAffected ?? 0;
  }
  const before = local!.items.length;
  local!.items = local!.items.filter(
    (i) => !(i.tier === "today" && i.autoArchiveAt && i.autoArchiveAt < cutoff),
  );
  persistLocal();
  return before - local!.items.length;
}

/* ------------------------------------------------------------------ */
/* Folders                                                              */
/* ------------------------------------------------------------------ */

export async function listFolders(spaceId: string): Promise<Folder[]> {
  if ((await backend()) === "sql") {
    const rows = await db!.select<
      { id: string; space_id: string; name: string; parent_folder_id: string | null; sort_order: number }[]
    >("SELECT * FROM folder WHERE space_id = $1 ORDER BY sort_order", [spaceId]);
    return rows.map((r) => ({
      id: r.id,
      spaceId: r.space_id,
      name: r.name,
      parentFolderId: r.parent_folder_id,
      sortOrder: r.sort_order,
    }));
  }
  return local!.folders
    .filter((f) => f.spaceId === spaceId)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

export async function createFolder(spaceId: string, name: string): Promise<Folder> {
  const folders = await listFolders(spaceId);
  const folder: Folder = {
    id: uuid(),
    spaceId,
    name,
    parentFolderId: null,
    sortOrder: folders.length,
  };
  if ((await backend()) === "sql") {
    await db!.execute(
      "INSERT INTO folder (id, space_id, name, parent_folder_id, sort_order) VALUES ($1,$2,$3,$4,$5)",
      [folder.id, folder.spaceId, folder.name, folder.parentFolderId, folder.sortOrder],
    );
  } else {
    local!.folders.push(folder);
    persistLocal();
  }
  return folder;
}

export async function deleteFolder(id: string): Promise<void> {
  // Items inside are re-homed to the folder's list root, not deleted.
  if ((await backend()) === "sql") {
    await db!.execute(
      "UPDATE sidebar_item SET parent_folder_id = NULL WHERE parent_folder_id = $1",
      [id],
    );
    await db!.execute("DELETE FROM folder WHERE id = $1", [id]);
  } else {
    for (const i of local!.items) {
      if (i.parentFolderId === id) i.parentFolderId = null;
    }
    local!.folders = local!.folders.filter((f) => f.id !== id);
    persistLocal();
  }
}
