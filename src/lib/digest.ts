import { listAllWatched } from "./orgDb";
import type { SidebarItem } from "./orgDb";
import { DEMO_PAGE_ID } from "./demoPage";
import { getEditTime, getPageDiffs } from "./attention";
import { topRecents } from "./frecencyDb";
import type { PageDiff } from "./blockDiff";

/**
 * "While you were away" digest (POLISH_OPPORTUNITIES.md — Slite-style
 * briefing): turns the attention engine's unread-dot machinery into a list
 * you can actually read through. Same unread test as computeUnread
 * (attention.ts), but keeps the diff and enough display data to render a
 * standalone panel instead of a dot.
 */

export interface DigestEntry {
  pageId: string;
  title: string;
  icon?: string | null;
  editedTime: string;
  lastOpenedAt: string | null;
  diff?: PageDiff;
}

export async function buildDigest(): Promise<DigestEntry[]> {
  const watched = await listAllWatched();

  // Unique by notionPageId: a page can appear more than once (e.g.
  // favorited AND pinned in a Space), each with its own lastOpenedAt. Keep
  // the entry with the most recent lastOpenedAt — the most generous "have
  // I seen this" signal available, so we don't manufacture false unreads
  // out of a stale duplicate.
  const byId = new Map<string, SidebarItem>();
  for (const item of watched) {
    if (item.notionPageId === DEMO_PAGE_ID) continue;
    const existing = byId.get(item.notionPageId);
    if (!existing || (item.lastOpenedAt ?? "") > (existing.lastOpenedAt ?? "")) {
      byId.set(item.notionPageId, item);
    }
  }

  const diffs = getPageDiffs();
  // Fallback title/icon source, fetched lazily and only once per call — most
  // watched items already carry a titleCache, so this is usually skipped.
  let frecencyById: Map<string, { titleCache: string; iconCache: string | null }> | null = null;
  const frecencyFallback = async (pageId: string) => {
    if (!frecencyById) {
      const recents = await topRecents(Number.MAX_SAFE_INTEGER);
      frecencyById = new Map(recents.map((r) => [r.notionPageId, r]));
    }
    return frecencyById.get(pageId) ?? null;
  };

  const entries: DigestEntry[] = [];
  for (const item of byId.values()) {
    // Same test as computeUnread: no known edit time ⇒ nothing to report;
    // never opened (null lastOpenedAt) or edited after last open ⇒ unread.
    const edited = getEditTime(item.notionPageId);
    if (!edited) continue;
    if (item.lastOpenedAt && edited <= item.lastOpenedAt) continue;

    let title = item.titleCache;
    let icon = item.iconCache;
    if (!title || title === "Untitled") {
      const fallback = await frecencyFallback(item.notionPageId);
      if (fallback) {
        title = fallback.titleCache || title;
        icon = icon ?? fallback.iconCache;
      }
    }

    entries.push({
      pageId: item.notionPageId,
      title: title || "Untitled",
      icon,
      editedTime: edited,
      lastOpenedAt: item.lastOpenedAt,
      diff: diffs[item.notionPageId],
    });
  }

  entries.sort((a, b) => (a.editedTime < b.editedTime ? 1 : a.editedTime > b.editedTime ? -1 : 0));
  return entries;
}
