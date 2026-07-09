import Database from "@tauri-apps/plugin-sql";

/**
 * Recurring review reminders: "remind me to review this page every
 * day/week/month." Local-only (never written to Notion), surfaced through
 * Hive's existing Inbox panel alongside comments/mentions.
 *
 * Backend: SQLite under Tauri (page_reminder table, created lazily); a
 * localStorage JSON mirror when the SQL plugin is unavailable (plain-browser
 * dev/preview) — same dual-backend spirit as orgDb.ts, kept intentionally
 * simple since this is a small, single-table concern.
 */

export type ReminderFreq = "daily" | "weekly" | "monthly";

export interface PageReminder {
  id: string;
  pageId: string;
  title: string;
  icon: string | null;
  frequency: ReminderFreq;
  nextDueAt: string;
}

const LOCAL_KEY = "hive-reminders";
const NOTIFY_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const PERIOD_MS: Record<ReminderFreq, number> = {
  daily: DAY_MS,
  weekly: 7 * DAY_MS,
  monthly: 30 * DAY_MS,
};

const uuid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();
const addPeriod = (freq: ReminderFreq, fromMs = Date.now()) =>
  new Date(fromMs + PERIOD_MS[freq]).toISOString();

interface Row {
  id: string;
  notion_page_id: string;
  title_cache: string | null;
  icon_cache: string | null;
  frequency: ReminderFreq;
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
 * Set, change, or remove (freq === null) the reminder on a page. First due
 * is one period from now. Upserts by pageId — a page has at most one
 * reminder.
 */
export async function setReminder(
  pageId: string,
  title: string,
  icon: string | null,
  freq: ReminderFreq | null,
): Promise<void> {
  await init();
  const which = await backend();

  if (freq === null) {
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
  const nextDueAt = addPeriod(freq);
  const createdAt = nowIso();
  const reminder: PageReminder = { id, pageId, title, icon, frequency: freq, nextDueAt };

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
      [id, pageId, title, icon, freq, nextDueAt, createdAt],
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

/** Marks a reminder reviewed: reschedules one period out (stays recurring). */
export async function completeReminder(id: string): Promise<void> {
  const r = cache.find((x) => x.id === id);
  if (!r) return;
  await reschedule(id, addPeriod(r.frequency));
}

/** Pushes a reminder's due date out by one day without changing its cadence. */
export async function snoozeReminder(id: string): Promise<void> {
  const r = cache.find((x) => x.id === id);
  if (!r) return;
  const base = Math.max(Date.now(), new Date(r.nextDueAt).getTime());
  await reschedule(id, new Date(base + DAY_MS).toISOString());
}

/** Test/dev seam only — not called from any UI. Forces an arbitrary
 * next-due timestamp (including the past) so verification tooling can
 * simulate an overdue reminder without waiting real time. */
export const __debugSetNextDueAt = reschedule;
