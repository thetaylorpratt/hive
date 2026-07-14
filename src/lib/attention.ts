import { notion } from "./notionClient";
import { enqueue } from "./queue";
import { getPageEditTimes, setPageEditTime } from "./db";
import { listAllWatched } from "./orgDb";
import { DEMO_PAGE_ID } from "./demoPage";
import type { SidebarItem } from "./orgDb";
import { excerptsOf, type PageDiff } from "./blockDiff";

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
const pageDiffs = new Map<string, PageDiff>();

// The signed-in identity's own ids (bot id + human owner id — see
// appStore's init), set once auth is ready. Used to filter the reader's
// own edits out of both the page-diff banner (below) and the poll's
// unread signal (pollOnce, further down).
let ownUserIds = new Set<string>();

export function setOwnUserIds(ids: Set<string>) {
  ownUserIds = ids;
}

/**
 * Records a page's block diff, filtering out any entries authored by the
 * reader themself. `diff` may already have been computed with `ownIds`
 * passed straight to diffBlockTrees (no-op filter here in that case); this
 * second pass is what makes the filter effective for callers that only
 * pass diffBlockTrees(old, new) without threading ownIds through (the
 * default revalidation path in fetchPage.ts).
 */
export function notePageDiff(pageId: string, diff: PageDiff | null) {
  if (!diff) return;
  if (!ownUserIds.size) {
    pageDiffs.set(pageId, diff);
    return;
  }
  const entries = diff.entries.filter((e) => !e.editedBy || !ownUserIds.has(e.editedBy));
  if (!entries.length) {
    // Everything in this diff was the reader's own edit — nothing to show.
    pageDiffs.delete(pageId);
    return;
  }
  pageDiffs.set(pageId, {
    added: entries.filter((e) => e.kind === "added").length,
    removed: entries.filter((e) => e.kind === "removed").length,
    changed: entries.filter((e) => e.kind === "edited").length,
    entries,
    excerpts: excerptsOf(entries),
  });
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

export function getEditTime(pageId: string): string | undefined {
  return editTimes.get(pageId);
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

// Called when the poll discovers a page whose latest edit came from the
// reader's own identity (typically: edited straight in the Notion app,
// since Hive's own writes already mark themselves seen via writeback's
// observer — see appStore's init). appStore supplies a callback that
// marks that page's watched items lastOpenedAt=now, so the edit is
// recorded (editTimes still advances) without ringing the unread bell.
let ownEditSeenHandler: ((pageId: string) => void) | null = null;

export function setOwnEditSeenHandler(handler: (pageId: string) => void) {
  ownEditSeenHandler = handler;
}

let pollOffset = 0;

async function pollOnce(onChange: () => void) {
  const watched = await listAllWatched();
  const unique = [
    ...new Set(
      watched.map((w) => w.notionPageId).filter((id) => id !== DEMO_PAGE_ID),
    ),
  ];
  // Rotate the window so watch lists larger than one cycle still get
  // coverage instead of starving everything past the first N.
  const start = unique.length ? pollOffset % unique.length : 0;
  const pageIds = [...unique.slice(start), ...unique.slice(0, start)].slice(
    0,
    MAX_PAGES_PER_CYCLE,
  );
  pollOffset += MAX_PAGES_PER_CYCLE;

  let changed = false;
  for (const pageId of pageIds) {
    try {
      const page = (await enqueue(() =>
        notion().pages.retrieve({ page_id: pageId }),
      )) as { last_edited_time?: string; last_edited_by?: { id?: string } };
      const edited = page.last_edited_time;
      if (edited && editTimes.get(pageId) !== edited) {
        editTimes.set(pageId, edited);
        try {
          await setPageEditTime(pageId, edited);
        } catch {
          /* no SQLite — in-memory only */
        }
        changed = true;
        const editorId = page.last_edited_by?.id;
        if (editorId && ownUserIds.has(editorId)) {
          // Our own edit, made outside Hive — don't let it ring the bell.
          ownEditSeenHandler?.(pageId);
        }
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
