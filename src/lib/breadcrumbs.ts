import { notion } from "./notionClient";
import { enqueue } from "./queue";
import { pageEmoji, pageTitle } from "./pageMeta";

/** Ancestor chain for the open page (parent → … → root), session-cached. */

export interface Crumb {
  pageId: string;
  title: string;
  icon: string | null;
  isDatabase?: boolean; // database crumbs aren't openable in Hive (yet)
}

const chainCache = new Map<string, Crumb[]>();

/** Drop a cached chain (after moving a page to a new parent). */
export function invalidateBreadcrumbs(pageId: string): void {
  chainCache.delete(pageId);
}

type Parent =
  | { type: "page_id"; page_id: string }
  | { type: "database_id"; database_id: string }
  | { type: "workspace" | "block_id"; [k: string]: unknown };

export async function loadBreadcrumbs(
  pageId: string,
  page: Record<string, unknown>,
): Promise<Crumb[]> {
  const cached = chainCache.get(pageId);
  if (cached) return cached;

  const crumbs: Crumb[] = [];
  let parent = page.parent as Parent | undefined;
  let depth = 0;
  try {
    while (parent && depth < 6) {
      depth += 1;
      if (parent.type === "page_id") {
        const p = (await enqueue(() =>
          notion().pages.retrieve({ page_id: (parent as { page_id: string }).page_id }),
        )) as Record<string, unknown>;
        crumbs.unshift({
          pageId: p.id as string,
          title: pageTitle(p),
          icon: pageEmoji(p),
        });
        parent = p.parent as Parent;
      } else if (parent.type === "database_id") {
        const db = (await enqueue(() =>
          notion().databases.retrieve({
            database_id: (parent as { database_id: string }).database_id,
          }),
        )) as { id: string; title?: { plain_text: string }[]; parent?: Parent };
        crumbs.unshift({
          pageId: db.id,
          title: db.title?.map((t) => t.plain_text).join("") || "Database",
          icon: null,
          isDatabase: true,
        });
        parent = db.parent;
      } else {
        break; // workspace root (or block parent) — stop
      }
    }
  } catch {
    /* partial chains are fine (unshared ancestor) */
  }
  chainCache.set(pageId, crumbs);
  return crumbs;
}
