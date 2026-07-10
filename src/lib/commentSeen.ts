import type { CommentThread } from "./notionMcp";

/**
 * Per-thread "seen" state so busy documents can show which discussions have
 * NEW replies since you last looked. Backed by localStorage so it survives
 * reloads; a thread's identity is its discussion:// id (stable across
 * fetches — see notionMcp.ts CommentThread.id).
 *
 * Model: { [discussionThreadId]: lastSeenCommentCount }. A thread with no
 * entry at all has never been seen — every comment on it counts as new,
 * EXCEPT on a page's very first load (see markFirstVisitIfNeeded), so we
 * don't greet the user with a wall of "new" badges on day one.
 */

const STORAGE_KEY = "hive-comment-seen";
const FIRST_VISIT_KEY = "hive-comment-seen-visited-pages";

type SeenMap = Record<string, number>;
type VisitedMap = Record<string, true>;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / private-mode — seen-state is best-effort, never fatal */
  }
}

function readSeen(): SeenMap {
  return readJson<SeenMap>(STORAGE_KEY, {});
}

function writeSeen(map: SeenMap): void {
  writeJson(STORAGE_KEY, map);
  notify();
}

const listeners = new Set<() => void>();
function notify(): void {
  for (const fn of listeners) fn();
}

/** Subscribe to any seen-state mutation (mark-seen, mark-all, first-visit).
 * Returns an unsubscribe function. Used to re-render badges/dots live. */
export function subscribeSeen(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Block id embedded in a discussion:// url:
 * discussion://pageId/blockId/discussionId */
export function threadBlockId(threadId: string): string | null {
  return threadId.split("/")[3] ?? null;
}

/** How many of this thread's comments are new since last seen. A never-seen
 * thread counts ALL its comments as new (subject to the first-visit rule
 * being applied upstream by the caller via markFirstVisitIfNeeded). */
export function newReplyCount(thread: CommentThread): number {
  const seen = readSeen();
  const lastSeen = seen[thread.id];
  if (lastSeen === undefined) return thread.comments.length;
  return Math.max(0, thread.comments.length - lastSeen);
}

/** True if this thread has no seen-entry at all (never looked at). Used to
 * distinguish "brand-new thread" (dot, "new thread") from "N new replies"
 * on a thread that's been seen before. */
export function isNeverSeen(thread: CommentThread): boolean {
  const seen = readSeen();
  return seen[thread.id] === undefined;
}

export function markThreadSeen(thread: CommentThread): void {
  const seen = readSeen();
  seen[thread.id] = thread.comments.length;
  writeSeen(seen);
}

export function markAllSeen(threads: CommentThread[]): void {
  const seen = readSeen();
  for (const t of threads) seen[t.id] = t.comments.length;
  writeSeen(seen);
}

/** Call once per page load with its freshly-fetched threads. The first time
 * a given page is seen with NO seen-entries at all, silently mark every
 * thread on it as seen (so existing discussions don't all light up as
 * "new" the first time this feature ships). Subsequent loads are no-ops. */
export function markFirstVisitIfNeeded(pageId: string, threads: CommentThread[]): void {
  const visited = readJson<VisitedMap>(FIRST_VISIT_KEY, {});
  if (visited[pageId]) return;
  visited[pageId] = true;
  writeJson(FIRST_VISIT_KEY, visited);

  const seen = readSeen();
  let changed = false;
  for (const t of threads) {
    if (seen[t.id] === undefined) {
      seen[t.id] = t.comments.length;
      changed = true;
    }
  }
  if (changed) writeSeen(seen);
  else notify();
}
