import Database from "@tauri-apps/plugin-sql";
import { notion } from "./notionClient";
import { enqueue } from "./queue";
import { useAppStore } from "../store/appStore";

/**
 * Offline write queue (companion to writeback.ts).
 *
 * Scope: only id-stable, replay-safe ops (block text/checkbox/cell updates,
 * block deletes, page icon updates) route through here. Everything else
 * (moves, indents, converts, table structure, duplicate, restore, …) needs a
 * live round trip for a fresh id and is blocked outright while offline — see
 * the guards writeback.ts adds at the top of those functions.
 *
 * Model: writes are already applied optimistically to the local block tree
 * by the caller before this module is ever consulted — our only job is to
 * get the matching Notion API call out the door now, or durably later.
 */

export type OfflineOp =
  | { kind: "block_update"; blockId: string; payload: Record<string, unknown> }
  | { kind: "block_delete"; blockId: string }
  | { kind: "page_update"; pageId: string; payload: Record<string, unknown> };

/**
 * Best-effort classification: does this failure look like "the network is
 * down" rather than a real API/auth/permissions error? Copied from
 * appStore.ts's isNetworkError (kept read-only per task scope) — keep this
 * in sync if that heuristic changes.
 */
function isNetworkError(err: unknown): boolean {
  if (!err) return false;
  const name = err instanceof Error ? err.name : undefined;
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const code = (err as { code?: string } | null)?.code?.toLowerCase();
  if (name === "TypeError") return true;
  if (code?.includes("timeout")) return true;
  const needles = [
    "load failed",
    "failed to fetch",
    "fetch failed",
    "network",
    "timed out",
    "timeout",
    "offline",
    "internet connection",
    "err_internet",
    "err_network",
  ];
  return needles.some((n) => message.includes(n));
}

/* ---------- SQLite (best-effort; plain-browser dev has none) ---------- */

let dbPromise: Promise<Database> | null = null;
function getDb(): Promise<Database> {
  dbPromise ??= Database.load("sqlite:hive.db").catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

async function ensureTable(): Promise<void> {
  const db = await getDb();
  await db.execute(
    "CREATE TABLE IF NOT EXISTS pending_writes (seq INTEGER PRIMARY KEY AUTOINCREMENT, op_json TEXT NOT NULL, created_at TEXT NOT NULL)",
  );
}

async function persistOp(seq: number, op: OfflineOp): Promise<void> {
  try {
    await ensureTable();
    const db = await getDb();
    await db.execute(
      "INSERT INTO pending_writes (seq, op_json, created_at) VALUES ($1, $2, $3)",
      [seq, JSON.stringify(op), new Date().toISOString()],
    );
  } catch {
    /* no SQLite (plain-browser dev) — in-memory queue only */
  }
}

async function removePersisted(seq: number): Promise<void> {
  try {
    const db = await getDb();
    await db.execute("DELETE FROM pending_writes WHERE seq = $1", [seq]);
  } catch {
    /* no SQLite */
  }
}

/* ---------- in-memory state ---------- */

interface QueuedOp {
  seq: number;
  op: OfflineOp;
}

let ops: QueuedOp[] = [];
let memSeq = 0;
let offlineMode = false;
let draining = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function notifyListeners(): void {
  listeners.forEach((fn) => fn());
}

export function isWriteOffline(): boolean {
  return offlineMode;
}

export function pendingWriteCount(): number {
  return ops.length;
}

export function subscribePending(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function startPollTimerIfNeeded(): void {
  if (pollTimer || ops.length === 0) return;
  pollTimer = setInterval(() => {
    if (ops.length > 0) notePossiblyOnline();
  }, 20_000);
}

function stopPollTimerIfEmpty(): void {
  if (ops.length === 0 && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** Dedup key: a block_update keys on its blockId, a page_update on its
 * pageId — a later queued op with the same key replaces the earlier one
 * (last write wins). Deletes have no content to replace. */
function keyFor(op: OfflineOp): string | null {
  if (op.kind === "block_update") return `block_update:${op.blockId}`;
  if (op.kind === "page_update") return `page_update:${op.pageId}`;
  return null;
}

function removeQueued(predicate: (op: OfflineOp) => boolean): void {
  const idx = ops.findIndex((q) => predicate(q.op));
  if (idx !== -1) {
    const [removed] = ops.splice(idx, 1);
    void removePersisted(removed.seq);
  }
}

function queueOp(op: OfflineOp): void {
  // A delete supersedes any queued update for the same block — that update
  // would only fail against an archived block during drain anyway.
  if (op.kind === "block_delete") {
    removeQueued((q) => q.kind === "block_update" && q.blockId === op.blockId);
  }
  const key = keyFor(op);
  if (key) removeQueued((q) => keyFor(q) === key);

  const seq = ++memSeq;
  ops.push({ seq, op });
  void persistOp(seq, op);
  startPollTimerIfNeeded();
  notifyListeners();
}

/* ---------- lazy init (table + persisted ops + reconnect listeners) ---------- */

let initialized = false;

export async function loadPersistedWrites(): Promise<void> {
  if (initialized) return;
  initialized = true;

  try {
    await ensureTable();
    const db = await getDb();
    const rows = await db.select<{ seq: number; op_json: string }[]>(
      "SELECT seq, op_json FROM pending_writes ORDER BY seq ASC",
    );
    ops = rows.map((r) => ({ seq: r.seq, op: JSON.parse(r.op_json) as OfflineOp }));
    memSeq = ops.length ? ops[ops.length - 1].seq : 0;
    if (ops.length > 0) {
      offlineMode = true; // unsynced work survived a restart
      startPollTimerIfNeeded();
      notifyListeners();
    }
  } catch {
    /* no SQLite (plain-browser dev) — nothing to restore */
  }

  // Reconnect triggers. Deferred to this lazy init (rather than module top
  // level) so the appStore import — circular via writeback.ts — is fully
  // resolved before we touch it.
  if (typeof window !== "undefined") {
    window.addEventListener("online", () => notePossiblyOnline());
  }
  let prevOffline = useAppStore.getState().offline;
  useAppStore.subscribe((state) => {
    if (prevOffline && !state.offline) notePossiblyOnline();
    prevOffline = state.offline;
  });
}

/* ---------- run-or-queue ---------- */

export async function runOrQueue(
  op: OfflineOp,
  fn: () => Promise<unknown>,
): Promise<void> {
  await loadPersistedWrites();

  if (offlineMode) {
    queueOp(op);
    return;
  }
  try {
    await fn();
  } catch (err) {
    if (isNetworkError(err)) {
      offlineMode = true;
      queueOp(op);
      return; // resolve, not reject — caller's optimistic model already applied
    }
    throw err; // real error (permissions, archived block, etc.) — unchanged
  }
}

/* ---------- replay ---------- */

function runOp(op: OfflineOp): Promise<unknown> {
  if (op.kind === "block_update") {
    return notion().blocks.update({ block_id: op.blockId, ...op.payload } as never);
  }
  if (op.kind === "block_delete") {
    return notion().blocks.delete({ block_id: op.blockId });
  }
  return notion().pages.update({ page_id: op.pageId, ...op.payload } as never);
}

export function notePossiblyOnline(): void {
  if (draining || ops.length === 0) return;
  void drain();
}

async function drain(): Promise<void> {
  draining = true;
  let synced = 0;
  let failed = 0;

  while (ops.length > 0) {
    const { seq, op } = ops[0];
    try {
      await enqueue(() => runOp(op));
      ops.shift();
      void removePersisted(seq);
      synced += 1;
      stopPollTimerIfEmpty();
      notifyListeners();
    } catch (err) {
      if (isNetworkError(err)) {
        draining = false; // stay offline; interval/online-event/store will retry
        return;
      }
      // Non-network failure (e.g. block archived remotely) — drop and move on.
      ops.shift();
      void removePersisted(seq);
      failed += 1;
      stopPollTimerIfEmpty();
      notifyListeners();
    }
  }

  draining = false;
  offlineMode = false;
  notifyListeners();

  if (synced > 0 || failed > 0) {
    const summary =
      `Synced ${synced} offline change${synced === 1 ? "" : "s"}` +
      (failed > 0 ? `, ${failed} failed` : "");
    try {
      useAppStore.getState().showToast(summary);
    } catch {
      /* store not ready — non-fatal */
    }
  }
}
