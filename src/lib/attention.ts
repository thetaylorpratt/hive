import { notion } from "./notionClient";
import { enqueue } from "./queue";
import { getPageEditTimes, setPageEditTime } from "./db";
import { listAllWatched } from "./orgDb";
import { DEMO_PAGE_ID } from "./demoPage";
import type { SidebarItem } from "./orgDb";

/**
 * Attention engine, Tier A (PROJECT_PLAN.md §3.5): make "something you care
 * about changed" impossible to miss. Polls `pages.retrieve` for watched
 * pages (favorites + pins) on a bounded budget and compares each page's
 * last_edited_time against the sidebar item's last_opened_at. No Notion
 * notifications API exists — this is local change-detection, and nothing is
 * ever written to Notion.
 */

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const MAX_PAGES_PER_CYCLE = 30; // ~10% of the token bucket over a cycle

// Edit times live in page_cache when a row exists; this map covers the rest
// of the session (and the plain-browser fallback).
const editTimes = new Map<string, string>();

// Block-level diffs recorded by revalidation (see lib/blockDiff.ts) —
// session-scoped: "what changed since the copy you last had".
import type { PageDiff } from "./blockDiff";
const pageDiffs = new Map<string, PageDiff>();

export function notePageDiff(pageId: string, diff: PageDiff | null) {
  if (diff) pageDiffs.set(pageId, diff);
}

export function getPageDiffs(): Record<string, PageDiff> {
  return Object.fromEntries(pageDiffs);
}

export function clearPageDiff(pageId: string) {
  pageDiffs.delete(pageId);
}
let seeded = false;
let timer: ReturnType<typeof setInterval> | null = null;

async function seed() {
  if (seeded) return;
  seeded = true;
  for (const [id, t] of Object.entries(await getPageEditTimes())) {
    editTimes.set(id, t);
  }
}

/** Record an edit time learned from any source (poll or full fetch). */
export function noteEditTime(pageId: string, editedTime: string | undefined) {
  if (!editedTime) return;
  editTimes.set(pageId, editedTime);
}

export function computeUnread(items: SidebarItem[]): Set<string> {
  const unread = new Set<string>();
  for (const item of items) {
    const edited = editTimes.get(item.notionPageId);
    if (!edited) continue;
    if (!item.lastOpenedAt || edited > item.lastOpenedAt) {
      unread.add(item.notionPageId);
    }
  }
  return unread;
}

async function pollOnce(onChange: () => void) {
  const watched = await listAllWatched();
  const pageIds = [
    ...new Set(
      watched.map((w) => w.notionPageId).filter((id) => id !== DEMO_PAGE_ID),
    ),
  ].slice(0, MAX_PAGES_PER_CYCLE);

  let changed = false;
  for (const pageId of pageIds) {
    try {
      const page = (await enqueue(() =>
        notion().pages.retrieve({ page_id: pageId }),
      )) as { last_edited_time?: string };
      const edited = page.last_edited_time;
      if (edited && editTimes.get(pageId) !== edited) {
        editTimes.set(pageId, edited);
        try {
          await setPageEditTime(pageId, edited);
        } catch {
          /* no SQLite — in-memory only */
        }
        changed = true;
      }
    } catch {
      // Unreachable page (revoked share, deleted) — skip; not this tier's job.
    }
  }
  if (changed) onChange();
}

/** Start polling; safe to call once after auth is ready. */
export async function startAttentionEngine(onChange: () => void) {
  await seed();
  if (timer) return;
  void pollOnce(onChange);
  timer = setInterval(() => void pollOnce(onChange), POLL_INTERVAL_MS);
}

/** Seed-only start for token-less sessions: unread still computes from cache. */
export async function primeAttention() {
  await seed();
}
