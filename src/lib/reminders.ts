import Database from "@tauri-apps/plugin-sql";

/**
 * One-shot page reminders: "remind me to look at this again in 30
 * min/1h/3h/tomorrow/next week/custom." Local-only (never written to
 * Notion), surfaced through Hive's existing Inbox panel alongside
 * comments/mentions.
 *
 * Backend: SQLite under Tauri (page_reminder table, created lazily); a
 * localStorage JSON mirror when the SQL plugin is unavailable (plain-browser
 * dev/preview) — same dual-backend spirit as orgDb.ts, kept intentionally
 * simple since this is a small, single-table concern.
 *
 * Note: the table keeps a `frequency` column for backward compatibility with
 * rows written by the earlier recurring-reminder feature. New rows always
 * write "once"; old rows with a legacy value ("daily"/"weekly"/"monthly")
 * are read back and treated as a plain one-shot due at their existing
 * next_due_at — no migration, no special-casing beyond that.
 */

/** Legacy frequency values from the old recurring model — kept only so old
 * rows deserialize without throwing. Not written by current code. */
export type LegacyReminderFreq = "once" | "daily" | "weekly" | "monthly";

export interface PageReminder {
  id: string;
  pageId: string;
  title: string;
  icon: string | null;
  /** Optional legacy field; current code always writes "once" and never
   * reads this to make decisions. */
  frequency?: LegacyReminderFreq;
  nextDueAt: string;
}

const LOCAL_KEY = "hive-reminders";
const NOTIFY_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const uuid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

interface Row {
  id: string;
  notion_page_id: string;
  title_cache: string | null;
  icon_cache: string | null;
  frequency: LegacyReminderFreq;
  next_due_at: string;
  created_at: string;
}

function fromRow(r: Row): PageReminder {
  return {
    id: r.id,
    pageId: r.notion_page_id,
    title: r.title_cache ?? "Untitled",
    icon: r.icon_cache,
    frequency: r.frequency,
    nextDueAt: r.next_due_at,
  };
}

/* ------------------------------------------------------------------ */
/* Backend selection (mirrors orgDb.ts)                                 */
/* ------------------------------------------------------------------ */

let db: Database | null = null;
let local: PageReminder[] | null = null;

async function backend(): Promise<"sql" | "local"> {
  if (db) return "sql";
  if (local) return "local";
  try {
    db = await Database.load("sqlite:hive.db");
    await db.execute(
      `CREATE TABLE IF NOT EXISTS page_reminder (
         id TEXT PRIMARY KEY,
         notion_page_id TEXT NOT NULL UNIQUE,
         title_cache TEXT,
         icon_cache TEXT,
         frequency TEXT NOT NULL,
         next_due_at TEXT NOT NULL,
         created_at TEXT NOT NULL
       )`,
    );
    return "sql";
  } catch {
    db = null;
    try {
      const raw = localStorage.getItem(LOCAL_KEY);
      local = raw ? (JSON.parse(raw) as PageReminder[]) : [];
    } catch {
      local = []; // corrupt snapshot: reset rather than brick reminders
    }
    return "local";
  }
}

function persistLocal() {
  if (local) localStorage.setItem(LOCAL_KEY, JSON.stringify(local));
}

/* ------------------------------------------------------------------ */
/* In-memory cache — synchronous reads for the Inbox panel & PageMenu   */
/* ------------------------------------------------------------------ */

let cache: PageReminder[] = [];
let ready: Promise<void> | null = null;

// Memoized due-list snapshot: recomputed only when the underlying data (or
// the clock, via the 60s tick) actually moves — never on every read. Needed
// because dueReminders() doubles as a useSyncExternalStore getSnapshot in
// InboxPanel, which requires a stable reference between notifications or it
// throws "getSnapshot should be cached" / loops forever re-rendering.
let dueCache: PageReminder[] = [];

function recomputeDue() {
  const cutoff = nowIso();
  dueCache = [...cache]
    .filter((r) => r.nextDueAt <= cutoff)
    .sort((a, b) => a.nextDueAt.localeCompare(b.nextDueAt));
}

function init(): Promise<void> {
  ready ??= (async () => {
    const which = await backend();
    if (which === "sql" && db) {
      const rows = await db.select<Row[]>(
        `SELECT * FROM page_reminder`,
      );
      cache = rows.map(fromRow);
    } else {
      cache = local ? [...local] : [];
    }
  })()
    .catch(() => {
      cache = [];
    })
    .finally(() => {
      recomputeDue();
      notify();
    });
  return ready;
}
void init();

const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function notify() {
  recomputeDue();
  for (const fn of subscribers) fn();
}

/** Subscribe to reminder changes; also starts a 60s tick (lazily, on first
 * subscriber) so "due" rows appear/disappear without any user interaction. */
export function subscribeReminders(fn: () => void): () => void {
  subscribers.add(fn);
  timer ??= setInterval(notify, NOTIFY_MS);
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function getReminderFor(pageId: string): PageReminder | null {
  return cache.find((r) => r.pageId === pageId) ?? null;
}

export function listReminders(): PageReminder[] {
  return [...cache].sort((a, b) => a.nextDueAt.localeCompare(b.nextDueAt));
}

/** Stable reference between notify() calls — safe as a useSyncExternalStore
 * snapshot. Recomputed on mutation and on the 60s subscriber tick. */
export function dueReminders(): PageReminder[] {
  return dueCache;
}

/**
 * Set, change, or remove (dueAt === null) the one-shot reminder on a page.
 * dueAt is an absolute ISO timestamp — callers compute "in 30 min",
 * "tomorrow", etc. themselves. Upserts by pageId — a page has at most one
 * reminder.
 */
export async function setReminder(
  pageId: string,
  title: string,
  icon: string | null,
  dueAt: string | null,
): Promise<void> {
  await init();
  const which = await backend();

  if (dueAt === null) {
    cache = cache.filter((r) => r.pageId !== pageId);
    if (which === "sql" && db) {
      await db.execute(
        `DELETE FROM page_reminder WHERE notion_page_id = $1`,
        [pageId],
      );
    } else if (local) {
      local = local.filter((r) => r.pageId !== pageId);
      persistLocal();
    }
    notify();
    return;
  }

  const existing = cache.find((r) => r.pageId === pageId);
  const id = existing?.id ?? uuid();
  const createdAt = nowIso();
  const reminder: PageReminder = {
    id,
    pageId,
    title,
    icon,
    frequency: "once",
    nextDueAt: dueAt,
  };

  cache = [...cache.filter((r) => r.pageId !== pageId), reminder];

  if (which === "sql" && db) {
    await db.execute(
      `INSERT INTO page_reminder (id, notion_page_id, title_cache, icon_cache, frequency, next_due_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT(notion_page_id) DO UPDATE SET
         title_cache = excluded.title_cache,
         icon_cache = excluded.icon_cache,
         frequency = excluded.frequency,
         next_due_at = excluded.next_due_at`,
      [id, pageId, title, icon, "once", dueAt, createdAt],
    );
  } else if (local) {
    local = [...local.filter((r) => r.pageId !== pageId), reminder];
    persistLocal();
  }
  notify();
}

async function reschedule(id: string, nextDueAt: string): Promise<void> {
  await init();
  const which = await backend();
  cache = cache.map((r) => (r.id === id ? { ...r, nextDueAt } : r));
  if (which === "sql" && db) {
    await db.execute(
      `UPDATE page_reminder SET next_due_at = $1 WHERE id = $2`,
      [nextDueAt, id],
    );
  } else if (local) {
    local = local.map((r) => (r.id === id ? { ...r, nextDueAt } : r));
    persistLocal();
  }
  notify();
}

async function remove(id: string): Promise<void> {
  await init();
  const which = await backend();
  cache = cache.filter((r) => r.id !== id);
  if (which === "sql" && db) {
    await db.execute(`DELETE FROM page_reminder WHERE id = $1`, [id]);
  } else if (local) {
    local = local.filter((r) => r.id !== id);
    persistLocal();
  }
  notify();
}

/** Marks a one-shot reminder reviewed: it's done, so it's deleted outright
 * (no next occurrence to reschedule to). */
export async function completeReminder(id: string): Promise<void> {
  await remove(id);
}

/** Pushes a reminder's due time out by one hour. A short, fixed bump — a
 * one-shot reminder snoozed by a full day would defeat the point of "in 30
 * min"/"in 1 hour" durations. */
export async function snoozeReminder(id: string): Promise<void> {
  const r = cache.find((x) => x.id === id);
  if (!r) return;
  const base = Math.max(Date.now(), new Date(r.nextDueAt).getTime());
  await reschedule(id, new Date(base + HOUR_MS).toISOString());
}

/** Test/dev seam only — not called from any UI. Forces an arbitrary
 * next-due timestamp (including the past) so verification tooling can
 * simulate an overdue reminder without waiting real time. */
export const __debugSetNextDueAt = reschedule;
