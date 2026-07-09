import { topRecents } from "./frecencyDb";
import { getCachedPage } from "./db";
import { pageTitle } from "./pageMeta";
import { enqueue } from "./queue";
import { notion } from "./notionClient";
import { useAppStore } from "../store/appStore";

/**
 * Best-effort title lookup for a Notion page id — used to upgrade a pasted
 * bare URL into a titled link (EditableText's paste handler). Tries, in
 * order of cost: the frecency title cache, the local page_cache mirror, and
 * (only when Notion auth is actually configured) a single live API call
 * through the shared queue. Never throws — every layer is try/catch'd so a
 * miss just falls through to the next, and total failure resolves to null.
 */
export async function resolvePageTitle(pageId: string): Promise<string | null> {
  try {
    // topRecents sorts-then-slices to `limit`; passing an oversized limit is
    // how the existing API surfaces "give me everything" — there's no
    // by-id lookup export, and frecencyDb.ts is off-limits for this change.
    const recents = await topRecents(Number.MAX_SAFE_INTEGER);
    const hit = recents.find((entry) => entry.notionPageId === pageId);
    if (hit?.titleCache) return hit.titleCache;
  } catch {
    /* frecency lookup is best-effort */
  }

  try {
    const cached = await getCachedPage(pageId);
    if (cached) {
      const title = pageTitle(cached.page);
      if (title) return title;
    }
  } catch {
    /* page_cache lookup is best-effort */
  }

  if (useAppStore.getState().auth.status === "ready") {
    try {
      const page = (await enqueue(() =>
        notion().pages.retrieve({ page_id: pageId }),
      )) as Record<string, unknown>;
      return pageTitle(page);
    } catch {
      /* live fetch is best-effort — offline, revoked token, no perms, etc. */
    }
  }

  return null;
}
