import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { loadConfig } from "../lib/config";
import { initNotion, notion } from "../lib/notionClient";
import { enqueue } from "../lib/queue";
import { fetchFresh, loadCached, normalizePageId } from "../lib/fetchPage";
import { DEMO_PAGE_ID, DEMO_VERSION, demoBlocks, demoPage } from "../lib/demoPage";
import { upsertPageCache } from "../lib/db";
import { blocksToPlainText, pageEmoji, pageTitle } from "../lib/pageMeta";
import { createInlineDatabase } from "../lib/databaseApi";
import { indexPageForSearch } from "../lib/db";
import { recordHit } from "../lib/frecencyDb";
import {
  clearPageDiff,
  computeUnread,
  getPageDiffs,
  noteEditTime,
  primeAttention,
  setOwnEditSeenHandler,
  setOwnUserIds,
  startAttentionEngine,
} from "../lib/attention";
import type { PageDiff } from "../lib/blockDiff";
import type { Crumb } from "../lib/breadcrumbs";
import * as org from "../lib/orgDb";
import * as mcp from "../lib/notionMcp";
import type { CommentThread } from "../lib/notionMcp";
import * as writeback from "../lib/writeback";
import { dlog } from "../lib/debugLog";
import type { Folder, SidebarItem, Space, Tier } from "../lib/orgDb";
import type { HiveBlock, PageData, RichTextItem } from "../lib/types";

export type AuthStatus = "checking" | "ready" | "missing-token" | "error";
export type PageStatus = "idle" | "loading" | "refreshing" | "error";
export type ViewMode = "native" | "embed";

const ACTIVE_SPACE_KEY = "hive-active-space";

let peekOpenTimer: ReturnType<typeof setTimeout>;
let peekCloseTimer: ReturnType<typeof setTimeout>;
let navSeq = 0;
let initStarted = false;
let lastStaleCheck = 0;
// Per-page throttle for the own-edit "mark seen" observer (see init).
const ownEditMarked = new Map<string, number>();

/* Blocks live under a temporary local-* id until Notion confirms the create
 * (~1s); recreate ops (convert/move) likewise swap a block's id when they
 * settle. Structural ops issued during that window — a fast typist's "- "
 * right after Enter is the classic case — used to skip their remote write
 * silently: the local model showed a bullet while the server kept a
 * paragraph, so every later save on the block failed and any refetch
 * reverted it ("bullets disappear as I type"). Ops now await the pending
 * remap and target the real id. */
const pendingRemaps = new Map<string, Promise<string | null>>();
function trackRemap(fromId: string, real: Promise<string | null>) {
  pendingRemaps.set(fromId, real);
  void real.catch(() => null).then(() => pendingRemaps.delete(fromId));
}
async function settleId(blockId: string): Promise<string> {
  let id = blockId;
  // Chase chains (insert -> convert -> move can each remap) with a bound.
  for (let hops = 0; hops < 4; hops++) {
    const pending = pendingRemaps.get(id);
    if (!pending) return id;
    const real = await pending.catch(() => null);
    if (!real || real === id) return id;
    id = real;
  }
  return id;
}
function loadDisplayPrefs(pageId: string) {
  try {
    return {
      smallText: false,
      fullWidth: false,
      ...JSON.parse(localStorage.getItem(`hive-prefs-${pageId}`) ?? "{}"),
    };
  } catch {
    return { smallText: false, fullWidth: false };
  }
}

const TEXT_SCALE_KEY = "hive-text-scale";
// Fixed step ladder — adjustTextScale walks it one step at a time; direction
// 0 resets straight to 1 (100%, the default).
const TEXT_SCALE_STEPS = [0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.2, 1.3, 1.45];

function loadTextScale(): number {
  const raw = Number(localStorage.getItem(TEXT_SCALE_KEY));
  return TEXT_SCALE_STEPS.includes(raw) ? raw : 1;
}

/** Push the scale onto <html> as a CSS var — .hive-doc's font-size reads it
 * (theme.css). Applied at module load (covers the preview / pre-init render)
 * and again from init() once the app boots for real. */
function applyTextScale(scale: number) {
  // Native webview page zoom scales the ENTIRE app uniformly (sidebar,
  // panels, databases, editor) — like browser ⌘+ — and can't be disturbed
  // by re-renders (the doc-only CSS var approach read as inconsistent).
  if ("__TAURI_INTERNALS__" in window) {
    void import("@tauri-apps/api/webview")
      .then((m) => m.getCurrentWebview().setZoom(scale))
      .catch(() => {
        document.documentElement.style.setProperty("--hive-doc-scale", String(scale));
      });
  } else {
    // Plain-browser preview: approximate with the doc CSS var.
    document.documentElement.style.setProperty("--hive-doc-scale", String(scale));
  }
}
applyTextScale(loadTextScale());

let history: string[] = [];
let historyIndex = -1;
let suppressHistory = false;

/**
 * All block mutations run through this chain, one at a time, reading state
 * fresh inside — two rapid mutations otherwise snapshot the same pre-edit
 * tree and the second silently erases the first (QA finding #5).
 */
let writeChain: Promise<unknown> = Promise.resolve();
export function chainWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => undefined);
  return run;
}

/** Ask the focused editor (if any) to commit before a structural change. */
function requestCommit(blockId: string) {
  window.dispatchEvent(new CustomEvent("hive-commit-block", { detail: blockId }));
}

/** Is the caret currently inside this block's editor? Remaps change the
 * block's React key, which REMOUNTS the editor and silently kills the
 * caret mid-typing — callers use this to restore focus afterwards. */
function isBlockFocused(blockId: string): boolean {
  const el = document.activeElement as HTMLElement | null;
  return !!el && el.dataset?.bid === blockId;
}

/** Shared optimistic-write plumbing for block mutations (serialized). */
async function applyWrite(
  get: () => AppState,
  set: (partial: Partial<AppState>) => void,
  op: (
    pageId: string,
    blocks: PageData["blocks"],
    sink: writeback.WriteSink,
  ) => Promise<{
    blocks: PageData["blocks"];
    remote: Promise<void>;
    remap?: Promise<writeback.RemapResult>;
  }>,
) {
  return chainWrite(async () => {
    const { pageId, page, auth } = get();
    if (!pageId || !page) return;
    const sink = writeback.sinkFor(pageId, auth.status === "ready");
    const result = await op(pageId, page.blocks, sink);
    if (get().pageId !== pageId) return; // navigated away mid-write
    set({ page: { ...page, blocks: result.blocks }, writeError: null });
    result.remote.catch((err) =>
      set({
        writeError: `Save failed: ${err instanceof Error ? err.message : err}`,
      }),
    );
    // Recreate-trick ops give the block a new remote id: remap the local
    // tree and flush any buffered text once it settles.
    applyRecreateRemap(get, set, pageId, result.remap);
  });
}

/** Apply one recreate-trick id remap to the live tree once it settles: flush
 * any text buffered at the old id, swap the id in the tree, and restore
 * focus if the block was focused (a remap remounts the editor via its React
 * key, which silently drops the caret mid-typing otherwise). Shared by every
 * op whose remote write hands back a fresh id — moves, indent/outdent,
 * drag-to-move (which can carry two remaps for the top-of-page case). */
function applyRecreateRemap(
  get: () => AppState,
  set: (partial: Partial<AppState>) => void,
  pageId: string,
  remap?: Promise<writeback.RemapResult>,
) {
  if (!remap) return;
  void remap
    .then((mapping) => {
      if (!mapping?.to) return;
      requestCommit(mapping.from);
      return chainWrite(async () => {
        const current = get();
        if (current.pageId !== pageId || !current.page) return;
        writeback.flushPendingLocalText(mapping.from, mapping.to!);
        const wasFocused = isBlockFocused(mapping.from);
        set({
          page: {
            ...current.page,
            blocks: writeback.remapBlockId(current.page.blocks, mapping.from, mapping.to!),
          },
          ...(wasFocused ? { focusBlockId: mapping.to } : {}),
        });
      });
    })
    .catch(() => undefined);
}

/** Apply a table-rebuild's id remap to the live tree (table + row ids),
 * surgically — never a full page reload, which would drop in-flight edits. */
function applyTableRemap(
  get: () => AppState,
  set: (partial: Partial<AppState>) => void,
  pageId: string,
  remap?: Promise<Map<string, string> | null>,
) {
  if (!remap) return;
  void remap
    .then((mapping) => {
      if (!mapping || get().pageId !== pageId) return;
      const current = get();
      if (!current.page) return;
      set({
        page: {
          ...current.page,
          blocks: writeback.remapIds(current.page.blocks, mapping),
        },
      });
    })
    .catch((err) =>
      set({ writeError: `Save failed: ${err instanceof Error ? err.message : err}` }),
    );
}

function applySpaceAccent(space: Space | undefined) {
  document.documentElement.dataset.spaceAccent = space?.color ?? "sky";
}

/**
 * Best-effort classification: does this failure look like "the network is
 * down" rather than a real API/auth/permissions error? Deliberately
 * generous — a false positive just shows the calmer "offline copy" chip
 * instead of a scary error banner; a false negative shows the scarier one
 * for what's actually a connectivity blip. Covers: the browser fetch
 * TypeErrors WKWebView/Safari/Chromium throw when a request never reaches
 * the network ("Failed to fetch", "Load failed", "NetworkError..."), and
 * the @notionhq/client RequestTimeoutError (code
 * "notionhq_client_request_timeout").
 */
function isNetworkError(err: unknown): boolean {
  if (!err) return false;
  const name = err instanceof Error ? err.name : undefined;
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const code = (err as { code?: string } | null)?.code?.toLowerCase();
  if (name === "TypeError") return true; // fetch's own transport-failure shape
  if (code?.includes("timeout")) return true; // notionhq_client_request_timeout, etc.
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

interface AppState {
  auth: { status: AuthStatus; userName?: string; message?: string };
  view: ViewMode;
  pageId: string | null;
  page: PageData | null;
  pageStatus: PageStatus;
  pageError: string | null;
  // felt-speed proof: how long the currently-shown page took to render, and
  // whether that came from local cache or a live Notion fetch. Reset on
  // each openPage/openDemo navigation.
  loadMs: number | null;
  loadSource: "cache" | "notion" | null;
  // "Notion web is a white screen offline; Hive doesn't notice." True once a
  // background refresh fails in a network-shaped way while a cached copy is
  // on screen. Cleared the instant any fetch succeeds, or a fresh openPage
  // retry begins.
  offline: boolean;

  // organization plane
  spaces: Space[];
  activeSpaceId: string | null;
  sidebarItems: SidebarItem[]; // favorites + active-Space items
  folders: Folder[];
  sidebarVisible: boolean;
  sidebarWidth: number;
  commandBarOpen: boolean;
  unreadPageIds: Set<string>;
  unreadBySpace: Record<string, number>;
  mru: { pageId: string; title: string; icon: string | null }[];
  focusMode: boolean;
  toast: { message: string; undo?: () => Promise<void>; actionLabel?: string; sticky?: boolean } | null;
  appVersion: string;
  updateState: "idle" | "checking" | "current" | "available";
  availableVersion: string | null;
  checkForUpdates: (manual: boolean) => Promise<void>;
  applyUpdate: () => Promise<void>;
  pageDiffs: Record<string, PageDiff>;
  /** The signed-in identity's own ids (Hive bot id + human owner id),
   * captured during init — see diffBlockTrees/notePageDiff (blockDiff.ts,
   * attention.ts) for why: "changed since your last copy" must exclude the
   * reader's own edits, made from either identity. */
  ownUserIds: Set<string>;
  /** Track-changes-style toggle: when true, BlockRenderer highlights blocks
   * that appear in the current page's diff. Resets to false on every page
   * navigation (see openPage/openDemo). */
  showDiffHighlights: boolean;
  setShowDiffHighlights: (show: boolean) => void;
  shortcutSheetOpen: boolean;
  peek: { pageId: string; anchorY: number } | null;
  breadcrumbs: Crumb[];
  split: { pageId: string; data: PageData | null } | null;
  inbox: { id: string; pageId: string; kind: "comment" | "mention"; author: string; snippet: string; createdAt: string }[];
  inboxOpen: boolean;
  captureOpen: boolean;
  displayPrefs: { smallText: boolean; fullWidth: boolean };
  searchView: {
    query: string;
    results: { pageId: string; title: string; icon: string | null; source: "notion" | "cached"; snippet?: string }[];
    cursor: string | null;
    loading: boolean;
  } | null;

  // reader text-size control — a --hive-doc-scale CSS var consumed by .hive-doc
  textScale: number;
  adjustTextScale: (direction: 1 | -1 | 0) => void;

  // Settings modal (the traditional preferences surface)
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;

  init: () => Promise<void>;
  openPage: (input: string) => Promise<void>;
  openDemo: () => Promise<void>;
  recordOpen: (pageId: string, page: PageData) => Promise<void>;
  setView: (view: ViewMode) => void;

  refreshSidebar: () => Promise<void>;
  switchSpace: (spaceId: string) => Promise<void>;
  switchSpaceByIndex: (index: number) => Promise<void>;
  switchSpaceRelative: (delta: 1 | -1) => Promise<void>;
  createSpace: () => Promise<void>;
  updateSpace: (
    spaceId: string,
    patch: { name?: string; color?: string; icon?: string | null },
  ) => Promise<void>;
  setItemTier: (itemId: string, tier: Tier) => Promise<void>;
  removeItem: (itemId: string) => Promise<void>;
  reorderTier: (tier: Tier, idsInOrder: string[]) => Promise<void>;
  moveItemToFolder: (itemId: string, folderId: string | null) => Promise<void>;
  createFolder: () => Promise<void>;
  deleteFolder: (folderId: string) => Promise<void>;
  renameFolder: (folderId: string, name: string) => Promise<void>;
  filePageIntoFolder: (folderId: string) => Promise<void>;
  moveItemToSpace: (itemId: string, spaceId: string) => Promise<void>;
  fileItemIntoFolder: (itemId: string, folderId: string) => Promise<void>;
  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
  setCommandBarOpen: (open: boolean) => void;
  recomputeUnread: () => Promise<void>;

  // editing (write path)
  focusBlockId: string | null;
  writeError: string | null;
  // block multi-selection v1 (H) — top-level text-class blocks only
  selectedBlockIds: string[] | null;
  setBlockSelection: (ids: string[] | null) => void;
  deleteSelectedBlocks: () => Promise<void>;
  canEdit: () => boolean;
  editBlockText: (blockId: string, type: string, richText: RichTextItem[]) => Promise<void>;
  toggleTodo: (blockId: string, checked: boolean) => Promise<void>;
  insertParagraphAfter: (
    afterId: string | null,
    type?: string,
    richText?: RichTextItem[],
  ) => Promise<void>;
  convertBlock: (
    blockId: string,
    newType: string,
    richText?: RichTextItem[],
  ) => Promise<void>;
  deleteBlock: (
    blockId: string,
    opts?: { focusPrevious?: boolean; silent?: boolean },
  ) => Promise<void>;
  updatePageIcon: (emoji: string | null) => Promise<void>;
  updateTableCell: (
    rowId: string,
    cellIndex: number,
    richText: RichTextItem[],
  ) => Promise<void>;
  addTableRow: (tableId: string, afterRowId: string | null) => Promise<void>;
  setTableColumns: (tableId: string, delta: 1 | -1) => Promise<void>;
  moveTableRow: (tableId: string, rowId: string, dir: "up" | "down") => Promise<void>;
  moveTableColumn: (tableId: string, colIndex: number, dir: "left" | "right") => Promise<void>;
  duplicateBlock: (blockId: string) => Promise<void>;
  updateTableSettings: (
    tableId: string,
    patch: { has_column_header?: boolean; has_row_header?: boolean },
  ) => Promise<void>;
  moveBlock: (blockId: string, direction: "up" | "down") => Promise<void>;
  dragMoveBlock: (blockId: string, afterId: string | null) => Promise<void>;
  indentBlock: (blockId: string) => Promise<void>;
  outdentBlock: (blockId: string) => Promise<void>;
  setFocusBlock: (blockId: string | null) => void;
  /** Consume-once: the next focus request places the caret at the block START
   * (split-block Enter) instead of the default end. */
  focusCaretStart: boolean;
  toggleFocusMode: () => void;
  showToast: (
    message: string,
    undo?: () => Promise<void>,
    opts?: { actionLabel?: string; sticky?: boolean },
  ) => void;
  dismissToast: () => void;
  refreshCurrentIfStale: () => Promise<void>;
  dismissDiff: (pageId: string) => void;
  setShortcutSheetOpen: (open: boolean) => void;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  goBack: () => Promise<void>;
  goForward: () => Promise<void>;
  openInSplit: (pageId: string) => Promise<void>;
  refreshInbox: () => void;
  dismissInboxItem: (id: string) => void;
  setInboxOpen: (open: boolean) => void;
  setCaptureOpen: (open: boolean) => void;
  createComment: (
    text: string,
    quote: string,
    mentions?: import("../lib/commentDraft").DraftMention[],
  ) => Promise<void>;

  // personal Notion identity (hosted MCP OAuth) + comments panel
  mcpStatus: "disconnected" | "pending" | "connected";
  commentsOpen: boolean;
  commentThreads: CommentThread[] | null;
  commentsLoading: boolean;
  commentUsers: Record<string, string>;
  connectPersonalNotion: () => Promise<void>;
  completeMcpAuth: (url: string) => Promise<void>;
  completeRestAuth: (url: string) => Promise<void>;
  toggleComments: () => void;
  loadComments: () => Promise<void>;
  focusThreadId: string | null;
  focusThread: (threadId: string) => void;
  replyToThread: (
    discussionId: string,
    text: string,
    mentions?: import("../lib/commentDraft").DraftMention[],
  ) => Promise<void>;
  lastOpenInput: string | null;
  movePageOpen: boolean;
  setMovePageOpen: (open: boolean) => void;
  movePageInNotion: (parent: { pageId: string } | "workspace") => Promise<void>;
  deletePage: () => Promise<void>;
  setDisplayPref: (key: "smallText" | "fullWidth", value: boolean) => void;
  movePageToSpace: (pageId: string, spaceId: string) => Promise<void>;
  createPage: (parentId: string | null) => Promise<void>;
  createDatabaseInline: (afterBlockId: string) => Promise<void>;
  updatePageTitle: (title: string) => Promise<void>;
  createCapture: (text: string) => Promise<void>;
  closeSplit: () => void;
  openSearch: (query: string) => Promise<void>;
  loadMoreSearch: () => Promise<void>;
  closeSearch: () => void;
  requestPeek: (pageId: string, anchorY: number) => void;
  releasePeek: () => void;
  holdPeek: () => void;
  closePeek: () => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  auth: { status: "checking" },
  view: "native",
  pageId: null,
  page: null,
  pageStatus: "idle",
  pageError: null,
  loadMs: null,
  loadSource: null,
  offline: false,

  spaces: [],
  activeSpaceId: null,
  sidebarItems: [],
  folders: [],
  sidebarVisible: true,
  sidebarWidth: Number(localStorage.getItem("hive-sidebar-width")) || 232,
  commandBarOpen: false,
  unreadPageIds: new Set<string>(),
  unreadBySpace: {},
  mru: [],
  focusMode: false,
  toast: null,
  appVersion: "",
  updateState: "idle",
  availableVersion: null,
  pageDiffs: {},
  ownUserIds: new Set<string>(),
  showDiffHighlights: false,
  setShowDiffHighlights: (show: boolean) => set({ showDiffHighlights: show }),
  shortcutSheetOpen: false,
  peek: null,
  breadcrumbs: [],
  split: null,
  inbox: [],
  inboxOpen: false,
  captureOpen: false,
  displayPrefs: { smallText: false, fullWidth: false },
  mcpStatus: "disconnected",
  commentsOpen: false,
  commentThreads: null,
  commentsLoading: false,
  commentUsers: {},
  lastOpenInput: null,
  movePageOpen: false,
  focusThreadId: null,
  searchView: null,

  textScale: loadTextScale(),
  adjustTextScale: (direction) => {
    const current = get().textScale;
    let next: number;
    if (direction === 0) {
      next = 1;
    } else {
      const idx = TEXT_SCALE_STEPS.indexOf(current);
      const curIdx = idx === -1 ? TEXT_SCALE_STEPS.indexOf(1) : idx;
      const nextIdx = Math.min(
        TEXT_SCALE_STEPS.length - 1,
        Math.max(0, curIdx + direction),
      );
      next = TEXT_SCALE_STEPS[nextIdx];
    }
    localStorage.setItem(TEXT_SCALE_KEY, String(next));
    applyTextScale(next);
    set({ textScale: next });
    get().showToast(`Text size ${Math.round(next * 100)}%`);
  },

  settingsOpen: false,
  setSettingsOpen: (open) => set({ settingsOpen: open }),

  init: async () => {
    if (initStarted) return; // StrictMode double-invoke / re-mount guard
    initStarted = true;
    // Reader text-size preference — reapply on real boot too (module load
    // already covers the pre-init/preview render).
    applyTextScale(get().textScale);
    // Organization plane boots regardless of Notion auth.
    const spaces = await org.ensureDefaultSpace();
    const savedId = localStorage.getItem(ACTIVE_SPACE_KEY);
    const active = spaces.find((s) => s.id === savedId) ?? spaces[0];
    applySpaceAccent(active);
    set({ spaces, activeSpaceId: active.id });
    await org.archiveExpiredToday();
    await get().refreshSidebar();
    window.addEventListener("focus", () => {
      void org.archiveExpiredToday().then((n) => {
        if (n > 0) void get().refreshSidebar();
      });
      void get().refreshCurrentIfStale();
    });
    // Element blur never fires when the whole WINDOW blurs — switching to
    // another app left the focused block's typed-but-uncommitted text
    // stranded in the DOM (the classic "my last checkmark didn't save").
    window.addEventListener("blur", () => {
      const el = document.activeElement as HTMLElement | null;
      const bid = el?.closest?.("[data-bid]")
        ? (el.closest("[data-bid]") as HTMLElement).dataset.bid
        : undefined;
      if (bid) requestCommit(bid);
    });
    // Quasi-live pickup of OTHER people's changes: probe the open page
    // every 30s. The probe's own guards (busy queue, pending writes, recent
    // local write, own-echo editor, active editing session, 30s throttle)
    // make this cheap and safe.
    setInterval(() => void get().refreshCurrentIfStale(), 30_000);

    // navigator.onLine is a hint at best in WKWebView (it can lag or lie),
    // so we don't trust it to CLEAR the badge — only a real fetch success
    // does that (see openPage). But a fired "offline" event is a fine early
    // signal to flip the badge on before the next refresh even fails.
    window.addEventListener("offline", () => set({ offline: true }));
    window.addEventListener("online", () => {
      if (!navigator.onLine) return;
      void get().refreshCurrentIfStale();
    });

    // Personal identity plane: hosted-MCP OAuth tokens, if present.
    void mcp.mcpConnected().then((connected) => {
      if (connected) set({ mcpStatus: "connected" });
    });

    // Version badge + auto-update: read our version, then check the feed a
    // little after startup (silent if current). The version footer lets the
    // user see their version and re-check on demand.
    void import("../lib/updater").then((m) =>
      m.appVersion().then((v) => set({ appVersion: v })),
    );
    setTimeout(() => void get().checkForUpdates(false), 8000);

    // Content plane: Notion auth.
    let config;
    try {
      config = await loadConfig();
    } catch {
      set({ auth: { status: "missing-token" } });
      return;
    }
    if (!config.notion_token) {
      set({ auth: { status: "missing-token" } });
      void primeAttention().then(() => get().recomputeUnread());
      return;
    }
    try {
      initNotion(config.notion_token);
      const me = (await enqueue(() => notion().users.me({}))) as {
        id?: string;
        name?: string;
        bot?: { owner?: { user?: { id?: string; name?: string } } };
      };
      // Prefer the human who owns the integration over the bot's name
      const userName = me.bot?.owner?.user?.name ?? me.name ?? "integration";
      set({ auth: { status: "ready", userName } });
      // Both identities Notion can report for this one integration: the bot
      // id (Hive's own writes) and the human id (edits made in the Notion
      // app itself). "Changed since your last copy" must exclude both.
      const ownIds = new Set<string>();
      if (me.id) ownIds.add(me.id);
      const humanId = me.bot?.owner?.user?.id;
      if (humanId) ownIds.add(humanId);
      set({ ownUserIds: ownIds });
      setOwnUserIds(ownIds);
      void import("../lib/inbox").then((m) =>
        m.startInbox(
          me.bot?.owner?.user?.id ?? null,
          me.id ?? null,
          () => get().refreshInbox(),
        ),
      );
      void startAttentionEngine(() => {
        void get().recomputeUnread();
        void get().refreshCurrentIfStale();
      });
      // Your own edits must not ring the unread bell: every local write, and
      // every own-authored edit the attention poll discovers (made straight
      // in the Notion app), marks the page's watched entries as "seen now"
      // (throttled per page) so the attention engine only alerts on OTHER
      // people's changes. Both sources share the same throttle map so a
      // near-simultaneous write + poll observation don't double up.
      const markOwnEditSeen = (wroteMsgPageId: string) => {
        const now = Date.now();
        if ((ownEditMarked.get(wroteMsgPageId) ?? 0) > now - 30_000) return;
        ownEditMarked.set(wroteMsgPageId, now);
        void (async () => {
          try {
            const watched = await org.listAllWatched();
            const mine = watched.filter((w) => w.notionPageId === wroteMsgPageId);
            const ts = new Date().toISOString();
            for (const item of mine) {
              await org.updateItem(item.id, { lastOpenedAt: ts });
            }
            if (mine.length) await get().recomputeUnread();
          } catch {
            /* best-effort */
          }
        })();
      };
      writeback.setWriteObserver(markOwnEditSeen);
      setOwnEditSeenHandler(markOwnEditSeen);
      void import("../lib/indexer").then((m) => m.startIndexer());
    } catch (err) {
      set({
        auth: {
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  },

  openPage: async (input: string) => {
    if (input === DEMO_PAGE_ID) return get().openDemo();
    const nav = ++navSeq;
    const t0 = performance.now();
    set({ lastOpenInput: input });
    const pageId = normalizePageId(input);
    if (!pageId) {
      set({ pageStatus: "error", pageError: "That doesn't look like a Notion page ID or URL." });
      return;
    }

    // Cache-first: render instantly from SQLite, then revalidate.
    let cached = null;
    try {
      cached = await loadCached(pageId);
    } catch {
      /* no SQLite (plain-browser dev) — proceed as a cache miss */
    }
    if (navSeq !== nav) return; // a newer navigation superseded this one
    if (!suppressHistory && history[historyIndex] !== pageId) {
      history = [...history.slice(0, historyIndex + 1), pageId];
      historyIndex = history.length - 1;
    }
    suppressHistory = false;
    const samePage = get().pageId === pageId;
    set({
      pageId,
      page: cached,
      pageStatus: cached ? "refreshing" : "loading",
      pageError: null,
      focusBlockId: null,
      writeError: null,
      searchView: null,
      // A new page means a new diff (or none) — the "show in doc" toggle
      // is per-page, not a sticky preference.
      showDiffHighlights: false,
      // same-page refresh keeps the threads — nulling them unmounted every
      // comment indicator and blanked the open panel until the reload
      commentThreads: samePage ? get().commentThreads : null,
      breadcrumbs: [],
      displayPrefs: loadDisplayPrefs(pageId),
      // Cache hit renders instantly — that's the number we prove. A cache
      // miss doesn't get a time yet; it's set below once the fresh fetch
      // lands (still nav-guarded, since navSeq !== nav already returned above).
      loadMs: cached ? Math.round(performance.now() - t0) : null,
      loadSource: cached ? "cache" : null,
      // A fresh navigation is a fresh chance — don't carry a stale offline
      // badge into a page we haven't even tried to fetch yet.
      offline: false,
    });
    get().closePeek();
    if (cached) await get().recordOpen(pageId, cached);

    try {
      const fresh = await fetchFresh(pageId);
      // A newer navigation may have happened while we were fetching.
      if (get().pageId !== pageId) return;
      set({
        page: fresh,
        pageStatus: "idle",
        offline: false,
        // Only stamp the "notion" timing for a genuine cold load — a cache
        // hit already recorded its (much faster) number above.
        ...(cached ? {} : { loadMs: Math.round(performance.now() - t0), loadSource: "notion" as const }),
      });
      await get().recordOpen(pageId, fresh);
    } catch (err) {
      if (get().pageId !== pageId) return;
      const message = err instanceof Error ? err.message : String(err);
      const networkish = isNetworkError(err);
      if (cached) {
        // The selling point: a cached page stays fully on screen — no error
        // banner, just a quiet "offline copy" badge on the load chip.
        if (networkish) {
          set({ pageStatus: "idle", offline: true });
        } else {
          set({ pageStatus: "idle", pageError: `Refresh failed: ${message}` });
        }
      } else if (networkish) {
        set({
          pageStatus: "error",
          pageError: "You're offline and this page isn't cached yet.",
          offline: true,
        });
      } else {
        set({ pageStatus: "error", pageError: message });
      }
    }
  },

  /** Sidebar + frecency + unread bookkeeping after any successful page load. */
  recordOpen: async (pageId: string, page: PageData) => {
    const { activeSpaceId } = get();
    if (!activeSpaceId) return;
    const title = pageTitle(page.page);
    const icon = pageEmoji(page.page);
    noteEditTime(pageId, page.page.last_edited_time as string | undefined);
    // Background-load discussions so block 💬 indicators appear without
    // opening the panel (personal connection only — REST can't see inline).
    if (
      pageId !== DEMO_PAGE_ID &&
      get().mcpStatus === "connected" &&
      get().commentThreads === null
    ) {
      void get().loadComments();
    }
    await org.touchToday(activeSpaceId, pageId, title, icon);
    try {
      await recordHit(pageId, title, icon);
    } catch {
      /* frecency is best-effort */
    }
    void indexPageForSearch(
      pageId,
      title,
      blocksToPlainText(page.blocks as Parameters<typeof blocksToPlainText>[0]),
    );
    if (get().auth.status === "ready" && pageId !== DEMO_PAGE_ID) {
      void import("../lib/breadcrumbs").then(async (m) => {
        const crumbs = await m.loadBreadcrumbs(pageId, page.page);
        if (get().pageId === pageId) set({ breadcrumbs: crumbs });
        // ATC: route the doc's sidebar entry to its rule's Space
        const { matchRule } = await import("../lib/atc");
        const rule = matchRule(crumbs.map((c) => c.pageId));
        if (rule && rule.spaceId !== get().activeSpaceId) {
          const item = get().sidebarItems.find(
            (i) => i.notionPageId === pageId && i.tier === "today",
          );
          if (item) {
            await org.updateItem(item.id, { spaceId: rule.spaceId });
            await get().refreshSidebar();
            const space = get().spaces.find((sp) => sp.id === rule.spaceId);
            if (space) get().showToast(`Routed to ${space.name} (ATC rule)`);
          }
        }
      });
    }
    // MRU stack for the Ctrl+Tab switcher
    const mru = [
      { pageId, title, icon },
      ...get().mru.filter((m) => m.pageId !== pageId),
    ].slice(0, 8);
    set({ mru });
    await get().refreshSidebar();
    await get().recomputeUnread();
  },

  openDemo: async () => {
    const nav = ++navSeq;
    const t0 = performance.now();
    if (!suppressHistory && history[historyIndex] !== DEMO_PAGE_ID) {
      history = [...history.slice(0, historyIndex + 1), DEMO_PAGE_ID];
      historyIndex = history.length - 1;
    }
    suppressHistory = false;
    // Exercises the real pipe minus Notion, cache-first — including your own
    // edits, which persist in page_cache. Re-seed only on fixture upgrades.
    let data: PageData;
    try {
      const seeded = localStorage.getItem("hive-demo-version") === DEMO_VERSION;
      let cached = seeded ? await loadCached(DEMO_PAGE_ID) : null;
      if (!cached) {
        await upsertPageCache(DEMO_PAGE_ID, demoPage, demoBlocks);
        localStorage.setItem("hive-demo-version", DEMO_VERSION);
        cached = await loadCached(DEMO_PAGE_ID);
      }
      data = cached ?? {
        page: demoPage,
        blocks: demoBlocks,
        fetchedAt: new Date().toISOString(),
        fromCache: false,
      };
    } catch {
      // SQLite unavailable (e.g. plain-browser dev) — fall back to memory.
      data = {
        page: demoPage,
        blocks: demoBlocks,
        fetchedAt: new Date().toISOString(),
        fromCache: false,
      };
    }
    if (navSeq !== nav) return; // user navigated elsewhere while we loaded
    set({
      pageId: DEMO_PAGE_ID, page: data, pageStatus: "idle", pageError: null,
      focusBlockId: null, writeError: null, showDiffHighlights: false,
      // The demo fixture is always local (SQLite page_cache or an in-memory
      // fallback) — it's the cache-hit path, so it gets the same felt-speed
      // proof chip as a real cached page.
      loadMs: Math.round(performance.now() - t0),
      loadSource: "cache",
      // Fresh navigation, and the demo fixture never touches the network —
      // don't let a stale offline badge from a previous real page leak in.
      offline: false,
    });
    get().closePeek();
    await get().recordOpen(DEMO_PAGE_ID, data);
  },

  setView: (view: ViewMode) => {
    set({ view });
    const { pageId } = get();
    if (view === "embed" && pageId && pageId !== DEMO_PAGE_ID) {
      // Spike: notion.so can't be iframed, so the embedded view is a separate
      // Tauri webview window (see src-tauri open_embed).
      void invoke("open_embed", {
        url: `https://www.notion.so/${pageId.replace(/-/g, "")}`,
      });
    }
  },

  refreshSidebar: async () => {
    const { activeSpaceId } = get();
    if (!activeSpaceId) return;
    const [sidebarItems, folders] = await Promise.all([
      org.listSidebar(activeSpaceId),
      org.listFolders(activeSpaceId),
    ]);
    set({ sidebarItems, folders });
  },

  switchSpace: async (spaceId: string) => {
    const space = get().spaces.find((s) => s.id === spaceId);
    if (!space) return;
    localStorage.setItem(ACTIVE_SPACE_KEY, spaceId);
    applySpaceAccent(space);
    set({ activeSpaceId: spaceId });
    await get().refreshSidebar();
  },

  switchSpaceByIndex: async (index: number) => {
    const space = get().spaces[index - 1];
    if (space) await get().switchSpace(space.id);
  },

  switchSpaceRelative: async (delta: 1 | -1) => {
    const { spaces, activeSpaceId } = get();
    if (spaces.length < 2) return;
    const current = spaces.findIndex((s) => s.id === activeSpaceId);
    const next = spaces[(current + delta + spaces.length) % spaces.length];
    await get().switchSpace(next.id);
  },

  createSpace: async () => {
    const { spaces } = get();
    const color = org.SPACE_ACCENTS[spaces.length % org.SPACE_ACCENTS.length];
    const space = await org.createSpace(`Space ${spaces.length + 1}`, color);
    set({ spaces: [...spaces, space] });
    await get().switchSpace(space.id);
  },

  updateSpace: async (spaceId, patch) => {
    const clean = { ...patch };
    if (clean.name !== undefined) {
      clean.name = clean.name.trim();
      if (!clean.name) delete clean.name;
    }
    if (clean.icon !== undefined && clean.icon !== null) {
      clean.icon = clean.icon.trim() || null;
    }
    if (Object.keys(clean).length === 0) return;
    await org.updateSpace(spaceId, clean);
    const spaces = get().spaces.map((s) =>
      s.id === spaceId ? { ...s, ...clean } : s,
    );
    set({ spaces });
    if (spaceId === get().activeSpaceId) {
      applySpaceAccent(spaces.find((s) => s.id === spaceId));
    }
  },

  setItemTier: async (itemId: string, tier: Tier) => {
    const { activeSpaceId } = get();
    if (!activeSpaceId) return;
    await org.setTier(itemId, tier, activeSpaceId);
    await get().refreshSidebar();
  },

  removeItem: async (itemId: string) => {
    const removed = get().sidebarItems.find((i) => i.id === itemId);
    await org.deleteItem(itemId);
    await get().refreshSidebar();
    if (removed) {
      get().showToast(`Removed “${removed.titleCache}”`, async () => {
        await org.restoreItem(removed);
        await get().refreshSidebar();
      });
    }
  },

  reorderTier: async (_tier: Tier, idsInOrder: string[]) => {
    await org.reorderItems(idsInOrder);
    await get().refreshSidebar();
  },

  moveItemToFolder: async (itemId: string, folderId: string | null) => {
    await org.updateItem(itemId, { parentFolderId: folderId });
    await get().refreshSidebar();
  },

  createFolder: async () => {
    const { activeSpaceId, folders } = get();
    if (!activeSpaceId) return;
    await org.createFolder(activeSpaceId, `Folder ${folders.length + 1}`);
    await get().refreshSidebar();
  },

  deleteFolder: async (folderId: string) => {
    await org.deleteFolder(folderId);
    await get().refreshSidebar();
  },

  renameFolder: async (folderId: string, name: string) => {
    const clean = name.trim();
    if (!clean) return;
    await org.renameFolder(folderId, clean);
    await get().refreshSidebar();
  },

  /** Pin the current page and file it into a folder — the no-drag path. */
  filePageIntoFolder: async (folderId: string) => {
    const { pageId, sidebarItems, activeSpaceId } = get();
    if (!pageId || pageId === DEMO_PAGE_ID || !activeSpaceId) return;
    let item = sidebarItems.find((i) => i.notionPageId === pageId);
    if (!item) {
      const { page } = get();
      const title = page ? pageTitle(page.page) : "Untitled";
      await org.touchToday(activeSpaceId, pageId, title, page ? pageEmoji(page.page) : null);
      await get().refreshSidebar();
      item = get().sidebarItems.find((i) => i.notionPageId === pageId);
    }
    if (!item) return;
    if (item.tier !== "pinned") await get().setItemTier(item.id, "pinned");
    await get().moveItemToFolder(
      get().sidebarItems.find((i) => i.notionPageId === pageId)?.id ?? item.id,
      folderId,
    );
    const folder = get().folders.find((f) => f.id === folderId);
    get().showToast(`Filed into ${folder?.name ?? "folder"}`);
  },

  /** Right-click "Move to {Space}" — itemId-keyed (unlike movePageToSpace,
   * which resolves/creates by notionPageId). Favorites transcend Spaces
   * (spaceId null), so moving one into a Space would otherwise be a no-op —
   * demote it to "pinned" in the same write so the move is visible. */
  moveItemToSpace: async (itemId: string, spaceId: string) => {
    const item = get().sidebarItems.find((i) => i.id === itemId);
    if (!item) return;
    await org.updateItem(itemId, {
      spaceId,
      parentFolderId: null,
      ...(item.tier === "favorite" ? { tier: "pinned" as Tier } : {}),
    });
    await get().refreshSidebar();
    const space = get().spaces.find((s) => s.id === spaceId);
    if (space) get().showToast(`Moved to ${space.name}`);
  },

  /** Right-click "Add to {folder}" for an arbitrary sidebar item — mirrors
   * filePageIntoFolder's pin-then-file sequence, but for an item that's
   * already in the sidebar (no need to touchToday it in first). */
  fileItemIntoFolder: async (itemId: string, folderId: string) => {
    const item = get().sidebarItems.find((i) => i.id === itemId);
    if (!item) return;
    if (item.tier !== "pinned") await get().setItemTier(itemId, "pinned");
    await get().moveItemToFolder(itemId, folderId);
    const folder = get().folders.find((f) => f.id === folderId);
    get().showToast(`Filed into ${folder?.name ?? "folder"}`);
  },

  toggleSidebar: () => {
    get().closePeek();
    set({ sidebarVisible: !get().sidebarVisible });
  },

  setSidebarWidth: (width: number) => {
    const clamped = Math.min(400, Math.max(180, Math.round(width)));
    localStorage.setItem("hive-sidebar-width", String(clamped));
    set({ sidebarWidth: clamped });
  },
  setCommandBarOpen: (open: boolean) => set({ commandBarOpen: open }),

  focusBlockId: null,
  writeError: null,

  selectedBlockIds: null,
  setBlockSelection: (ids) => set({ selectedBlockIds: ids }),
  deleteSelectedBlocks: async () => {
    const ids = get().selectedBlockIds;
    if (!ids || ids.length === 0) return;
    set({ selectedBlockIds: null });
    for (const id of ids) {
      await get().deleteBlock(id, { silent: true }); // chainWrite-serialized
    }
    get().showToast(`${ids.length} block${ids.length === 1 ? "" : "s"} deleted`);
  },

  /** Demo always editable (local echo); real pages need the token. */
  canEdit: () => {
    const { pageId, auth } = get();
    if (!pageId) return false;
    return pageId === DEMO_PAGE_ID || auth.status === "ready";
  },

  editBlockText: async (blockId, type, richText) => {
    await applyWrite(get, set, (pageId, blocks, sink) =>
      writeback.editBlockText(pageId, blocks, blockId, type, richText, sink),
    );
  },

  toggleTodo: async (blockId, checked) => {
    blockId = await settleId(blockId);
    await applyWrite(get, set, (pageId, blocks, sink) =>
      writeback.toggleTodo(pageId, blocks, blockId, checked, sink),
    );
  },

  insertParagraphAfter: async (afterId, type = "paragraph", richText = []) => {
    if (afterId) afterId = await settleId(afterId);
    await chainWrite(async () => {
      const { pageId, page, auth } = get();
      if (!pageId || !page) return;
      const sink = writeback.sinkFor(pageId, auth.status === "ready");
      const result = await writeback.insertParagraphAfter(
        pageId, page.blocks, afterId, pageId, sink, type, richText,
      );
      if (get().pageId !== pageId) return;
      set({
        page: { ...page, blocks: result.blocks },
        focusBlockId: result.newBlockId,
        // Split-block: the caret belongs at the START of the carried text.
        focusCaretStart: richText.length > 0,
        writeError: null,
      });
      trackRemap(result.newBlockId, result.remoteId);
      void result.remoteId
        .then((realId) => {
          if (!realId) return;
          requestCommit(result.newBlockId);
          return chainWrite(async () => {
            const current = get();
            if (current.pageId !== pageId || !current.page) return;
            writeback.flushPendingLocalText(result.newBlockId, realId);
            const wasFocused = isBlockFocused(result.newBlockId);
            set({
              page: {
                ...current.page,
                blocks: writeback.remapBlockId(current.page.blocks, result.newBlockId, realId),
              },
              focusBlockId:
                wasFocused || get().focusBlockId === result.newBlockId
                  ? realId
                  : get().focusBlockId,
            });
          });
        })
        .catch((err) =>
          set({ writeError: `Save failed: ${err instanceof Error ? err.message : err}` }),
        );
    });
  },

  convertBlock: async (blockId, newType, richText = []) => {
    // LOCAL-FIRST: the marker must appear the instant "- " is typed.
    // Awaiting settleId before ANY visual change (v0.8.7) left the block
    // looking like a plain line for ~1s while the create's remap settled —
    // and the late conversion then remounted the list under the user's
    // typing ("bullets keep disappearing"). Convert the model immediately;
    // the remote recreate chases once the real id is known, carrying
    // whatever text has been typed by then.
    const localPageId = get().pageId;
    await chainWrite(async () => {
      const { pageId, page } = get();
      if (!pageId || !page) return;
      const local = await writeback.convertBlockType(
        pageId, page.blocks, blockId, newType, richText, "local",
      );
      if (get().pageId !== pageId) return;
      set({
        page: { ...page, blocks: local.blocks },
        focusBlockId: newType === "divider" ? null : blockId,
        writeError: null,
      });
    });
    const settledId = await settleId(blockId);
    await chainWrite(async () => {
      const { pageId, page, auth } = get();
      if (!pageId || !page || pageId !== localPageId) return;
      const sink = writeback.sinkFor(pageId, auth.status === "ready");
      // Create never confirmed (offline/local sink) — stay local-only.
      if (sink !== "notion" || settledId.startsWith("local-")) return;
      const find = (bs: HiveBlock[]): HiveBlock | null => {
        for (const b of bs) {
          if (b.id === settledId) return b;
          const n = b.children ? find(b.children) : null;
          if (n) return n;
        }
        return null;
      };
      // Recreate remotely with the block's CURRENT text — the user may have
      // kept typing while the id settled.
      const blk = find(page.blocks);
      const currentRich =
        ((blk?.[newType] as { rich_text?: RichTextItem[] })?.rich_text) ?? richText;
      const result = await writeback.convertBlockType(
        pageId, page.blocks, settledId, newType, currentRich, sink,
      );
      if (get().pageId !== pageId) return;
      set({ page: { ...page, blocks: result.blocks }, writeError: null });
      trackRemap(settledId, result.remoteId);
      void result.remoteId
        .then((realId) => {
          if (!realId) return;
          requestCommit(settledId);
          return chainWrite(async () => {
            const current = get();
            if (current.pageId !== pageId || !current.page) return;
            writeback.flushPendingLocalText(settledId, realId);
            const wasFocused = isBlockFocused(settledId);
            set({
              page: {
                ...current.page,
                blocks: writeback.remapBlockId(current.page.blocks, settledId, realId),
              },
              ...(wasFocused ? { focusBlockId: realId } : {}),
            });
          });
        })
        .catch((err) =>
          set({ writeError: `Save failed: ${err instanceof Error ? err.message : err}` }),
        );
    });
  },

  deleteBlock: async (blockId, opts = {}) => {
    blockId = await settleId(blockId);
    await chainWrite(async () => {
    const { pageId, page, auth } = get();
    if (!pageId || !page) return;
    const sink = writeback.sinkFor(pageId, auth.status === "ready");
    const captured = writeback.findWithPrev(page.blocks, blockId);
    const result = await writeback.deleteBlock(pageId, page.blocks, blockId, sink);
    if (get().pageId !== pageId) return;
    // Merge-up like Notion: move the caret to the end of the previous block
    // so typing continues seamlessly (no re-click needed).
    const focusPrev = opts.focusPrevious && captured?.prevId ? captured.prevId : null;
    set({
      page: { ...page, blocks: result.blocks },
      writeError: null,
      ...(focusPrev ? { focusBlockId: focusPrev } : {}),
    });
    result.remote.catch((err) =>
      set({ writeError: `Save failed: ${err instanceof Error ? err.message : err}` }),
    );
    // Offer undo only for a deliberate delete of a block that still had
    // content — a backspace on an empty line is silent (matches Notion).
    const hadText =
      captured &&
      ((captured.block[captured.block.type] as { rich_text?: unknown[] })
        ?.rich_text?.length ?? 0) > 0;
    if (captured && hadText && !opts.silent) {
      get().showToast("Block deleted", async () => {
        await chainWrite(async () => {
          const current = get();
          if (!current.page || current.pageId !== pageId) return;
          const restored = await writeback.restoreBlock(
            pageId, current.page.blocks, captured.block, captured.prevId, sink,
          );
          if (get().pageId !== pageId) return;
          set({ page: { ...current.page, blocks: restored.blocks } });
        });
      });
    }
    });
  },

  setFocusBlock: (blockId) =>
    set(blockId === null ? { focusBlockId: null, focusCaretStart: false } : { focusBlockId: blockId }),
  focusCaretStart: false,

  updatePageIcon: async (emoji) => {
    const { pageId, page, auth } = get();
    if (!pageId || !page) return;
    const sink = writeback.sinkFor(pageId, auth.status === "ready");
    const result = await writeback.updatePageIcon(
      pageId, page.page, page.blocks, emoji, sink,
    );
    set({ page: { ...page, page: result.page }, writeError: null });
    result.remote.catch((err) =>
      set({ writeError: `Save failed: ${err instanceof Error ? err.message : err}` }),
    );
    // keep sidebar/frecency icons in sync
    await get().recordOpen(pageId, { ...page, page: result.page });
  },

  updateTableCell: async (rowId, cellIndex, richText) => {
    await applyWrite(get, set, (pageId, blocks, sink) =>
      writeback.updateTableCell(pageId, blocks, rowId, cellIndex, richText, sink),
    );
  },

  toggleFocusMode: () => set({ focusMode: !get().focusMode }),

  showToast: (message, undo, opts) => {
    set({ toast: { message, undo, ...opts } });
    const shown = get().toast;
    if (!opts?.sticky) {
      setTimeout(() => {
        if (get().toast === shown) set({ toast: null });
      }, 6000);
    }
  },

  dismissToast: () => set({ toast: null }),

  checkForUpdates: async (manual) => {
    if (get().updateState === "checking") return;
    set({ updateState: "checking" });
    const m = await import("../lib/updater");
    const version = await m.checkForUpdate();
    if (version) {
      set({ updateState: "available", availableVersion: version });
    } else {
      set({ updateState: "current", availableVersion: null });
      // a manual check deserves acknowledgement; the auto one stays silent
      if (manual) get().showToast(`You're on the latest version (${get().appVersion})`);
    }
  },

  applyUpdate: async () => {
    try {
      get().showToast("Downloading update…");
      await (await import("../lib/updater")).applyPendingUpdate();
    } catch (err) {
      get().showToast(`Update failed: ${err instanceof Error ? err.message : err}`);
    }
  },

  addTableRow: async (tableId, afterRowId) => {
    await applyWrite(get, set, (pageId, blocks, sink) =>
      writeback.addTableRow(pageId, blocks, tableId, afterRowId, sink),
    );
  },

  setTableColumns: async (tableId, delta) => {
    await chainWrite(async () => {
    const { pageId, page, auth } = get();
    if (!pageId || !page) return;
    const table = writeback.findWithPrev(page.blocks, tableId)?.block;
    const width = (table?.table as { table_width?: number })?.table_width ?? 2;
    const newWidth = width + delta;
    if (newWidth < 1 || newWidth > 8) return;
    const sink = writeback.sinkFor(pageId, auth.status === "ready");
    const result = await writeback.setTableColumns(
      pageId, page.blocks, tableId, newWidth, sink,
    );
    if (get().pageId !== pageId) return;
    set({ page: { ...page, blocks: result.blocks }, writeError: null });
    applyTableRemap(get, set, pageId, result.remap);
    });
  },

  moveTableRow: async (tableId, rowId, dir) => {
    await chainWrite(async () => {
      const { pageId, page, auth } = get();
      if (!pageId || !page) return;
      const sink = writeback.sinkFor(pageId, auth.status === "ready");
      const result = await writeback.moveTableRow(pageId, page.blocks, tableId, rowId, dir, sink);
      if (get().pageId !== pageId) return;
      set({ page: { ...page, blocks: result.blocks }, writeError: null });
      applyTableRemap(get, set, pageId, result.remap);
    });
  },

  moveTableColumn: async (tableId, colIndex, dir) => {
    await chainWrite(async () => {
      const { pageId, page, auth } = get();
      if (!pageId || !page) return;
      const sink = writeback.sinkFor(pageId, auth.status === "ready");
      const result = await writeback.moveTableColumn(pageId, page.blocks, tableId, colIndex, dir, sink);
      if (get().pageId !== pageId) return;
      set({ page: { ...page, blocks: result.blocks }, writeError: null });
      applyTableRemap(get, set, pageId, result.remap);
    });
  },

  duplicateBlock: async (blockId) => {
    blockId = await settleId(blockId);
    await applyWrite(get, set, (pageId, blocks, sink) =>
      writeback.duplicateBlock(pageId, blocks, blockId, sink),
    );
  },

  updateTableSettings: async (tableId, patch) => {
    await applyWrite(get, set, (pageId, blocks, sink) =>
      writeback.updateTableSettings(pageId, blocks, tableId, patch, sink),
    );
  },
  moveBlock: async (blockId, direction) => {
    blockId = await settleId(blockId);
    await applyWrite(get, set, (pageId, blocks, sink) =>
      writeback.moveBlock(pageId, blocks, blockId, direction, sink),
    );
  },
  // Not routed through applyWrite: a top-of-page drop can carry TWO remaps
  // (the dragged block's, and the displaced first block's — see
  // writeback.moveBlockTo), and the offline throw needs to surface as a
  // banner even though the drop handler that calls this doesn't await it.
  dragMoveBlock: async (blockId, afterId) => {
    blockId = await settleId(blockId);
    if (afterId) afterId = await settleId(afterId);
    try {
      await chainWrite(async () => {
        const { pageId, page, auth } = get();
        if (!pageId || !page) return;
        const sink = writeback.sinkFor(pageId, auth.status === "ready");
        const result = await writeback.moveBlockTo(pageId, page.blocks, blockId, afterId, sink);
        if (get().pageId !== pageId) return; // navigated away mid-write
        set({ page: { ...page, blocks: result.blocks }, writeError: null });
        result.remote.catch((err) =>
          set({
            writeError: `Save failed: ${err instanceof Error ? err.message : err}`,
          }),
        );
        applyRecreateRemap(get, set, pageId, result.remap);
        applyRecreateRemap(get, set, pageId, result.remap2);
      });
    } catch (err) {
      set({
        writeError: `Save failed: ${err instanceof Error ? err.message : err}`,
      });
    }
  },
  indentBlock: async (blockId) => {
    blockId = await settleId(blockId);
    await applyWrite(get, set, (pageId, blocks, sink) =>
      writeback.indentBlock(pageId, blocks, blockId, sink),
    );
  },
  outdentBlock: async (blockId) => {
    blockId = await settleId(blockId);
    await applyWrite(get, set, (pageId, blocks, sink) =>
      writeback.outdentBlock(pageId, blocks, blockId, sink),
    );
  },

  recomputeUnread: async () => {
    const watched = await org.listAllWatched();
    const unread = computeUnread(watched);
    const unreadBySpace: Record<string, number> = {};
    for (const item of watched) {
      if (!unread.has(item.notionPageId)) continue;
      if (item.spaceId) {
        unreadBySpace[item.spaceId] = (unreadBySpace[item.spaceId] ?? 0) + 1;
      }
    }
    set({ unreadPageIds: unread, unreadBySpace, pageDiffs: getPageDiffs() });
    try {
      await invoke("set_badge", { count: unread.size });
    } catch {
      /* not running under Tauri */
    }
  },

  /**
   * PRD §8 concurrent-edit guard: on window focus (and when the attention
   * poller flags the open page), compare the remote last_edited_time to the
   * loaded copy and pull fresh content if a teammate changed it. The diff
   * engine turns the refetch into a "changed since your last copy" banner.
   */
  refreshCurrentIfStale: async () => {
    const { pageId, page, auth, pageStatus } = get();
    if (
      !pageId || !page || pageId === DEMO_PAGE_ID ||
      auth.status !== "ready" || pageStatus !== "idle"
    ) {
      return;
    }
    if (writeback.hasPendingTextWrites()) return; // don't clobber unsent edits
    // Structural writes (convert/insert/move recreate ops) live in the
    // rate-limited queue, NOT in pendingTextWrites — a swap while they're
    // in flight fetches a server snapshot OLDER than local optimism and
    // reverts it (the "bullet turns back into a paragraph" bug). Also skip
    // while offline edits await replay, and for ~20s after ANY local write:
    // the "newer" remote edit time is usually our own write echoing back.
    const { queueIdle } = await import("../lib/queue");
    if (!queueIdle()) return;
    const { pendingWriteCount } = await import("../lib/offlineWrites");
    if (pendingWriteCount() > 0) return;
    if (Date.now() - writeback.lastLocalWriteAt(pageId) < 20_000) return;
    // Never swap the doc out from under an active editing session — the
    // full-page re-set redraws every block, and the remote "newer" edit is
    // usually just OUR last write echoing back.
    const active = document.activeElement as HTMLElement | null;
    const sel = window.getSelection();
    if (
      active?.classList?.contains("hive-editable") ||
      (sel?.anchorNode &&
        (sel.anchorNode as HTMLElement).parentElement?.closest?.(".hive-editable"))
    ) {
      return;
    }
    const now = Date.now();
    if (now - lastStaleCheck < 30_000) return; // one probe per 30s max
    lastStaleCheck = now;
    try {
      const remote = (await enqueue(() =>
        notion().pages.retrieve({ page_id: pageId }),
      )) as { last_edited_time?: string; last_edited_by?: { id?: string } };
      // The newest edit being OUR OWN (either identity) means there's
      // nothing to pick up — swapping on our own echo churned the doc
      // under the user about once a minute while they worked.
      const editor = remote.last_edited_by?.id;
      if (editor && get().ownUserIds.has(editor)) return;
      const loaded = page.page.last_edited_time as string | undefined;
      if (
        remote.last_edited_time && loaded &&
        remote.last_edited_time > loaded &&
        get().pageId === pageId
      ) {
        const { dlog } = await import("../lib/debugLog");
        dlog(`STALE-SWAP page=${pageId.slice(0, 8)} remote>${remote.last_edited_time}`);
        await get().openPage(pageId); // cache-first swap + diff banner
      }
    } catch {
      /* staleness probe is best-effort */
    }
  },

  dismissDiff: (pageId: string) => {
    clearPageDiff(pageId);
    set({ pageDiffs: getPageDiffs() });
  },

  setShortcutSheetOpen: (open: boolean) => set({ shortcutSheetOpen: open }),

  canGoBack: () => historyIndex > 0,
  canGoForward: () => historyIndex < history.length - 1,
  goBack: async () => {
    if (historyIndex <= 0) return;
    historyIndex -= 1;
    suppressHistory = true;
    await get().openPage(history[historyIndex]);
  },
  goForward: async () => {
    if (historyIndex >= history.length - 1) return;
    historyIndex += 1;
    suppressHistory = true;
    await get().openPage(history[historyIndex]);
  },

  openInSplit: async (pageId: string) => {
    let cached: PageData | null = null;
    try {
      cached = await loadCached(pageId);
    } catch { /* no cache */ }
    if (!cached) {
      const s = get();
      if (s.pageId === pageId && s.page) cached = s.page;
      else if (pageId === DEMO_PAGE_ID) {
        cached = {
          page: demoPage, blocks: demoBlocks,
          fetchedAt: new Date().toISOString(), fromCache: false,
        };
      }
    }
    set({ split: { pageId, data: cached } });
    if (get().auth.status === "ready" && pageId !== DEMO_PAGE_ID) {
      try {
        const fresh = await fetchFresh(pageId);
        if (get().split?.pageId === pageId) {
          set({ split: { pageId, data: fresh }, offline: false });
        }
      } catch { /* keep cached */ }
    }
  },

  closeSplit: () => set({ split: null }),

  refreshInbox: () => {
    void import("../lib/inbox").then((m) => set({ inbox: m.inboxItems() }));
  },
  dismissInboxItem: (id: string) => {
    void import("../lib/inbox").then((m) => {
      m.markRead(id);
      set({ inbox: m.inboxItems() });
    });
  },
  setInboxOpen: (open: boolean) => set({ inboxOpen: open }),
  setCaptureOpen: (open: boolean) => set({ captureOpen: open }),

  setDisplayPref: (key, value) => {
    const { pageId, displayPrefs } = get();
    const next = { ...displayPrefs, [key]: value };
    set({ displayPrefs: next });
    if (pageId) localStorage.setItem(`hive-prefs-${pageId}`, JSON.stringify(next));
  },

  movePageToSpace: async (pageId: string, spaceId: string) => {
    const existing = get().sidebarItems.find((i) => i.notionPageId === pageId);
    if (existing) {
      await org.updateItem(existing.id, { spaceId });
    } else {
      const page = get().page;
      const title = page && get().pageId === pageId ? pageTitle(page.page) : "Untitled";
      await org.touchToday(spaceId, pageId, title, page ? pageEmoji(page.page) : null);
    }
    await get().refreshSidebar();
    const space = get().spaces.find((sp) => sp.id === spaceId);
    if (space) get().showToast(`Moved to ${space.name}`);
  },

  createPage: async (parentId: string | null) => {
    dlog(`createPage entry parent=${parentId?.slice(-8) ?? "null"} auth=${get().auth.status}`);
    if (get().auth.status !== "ready") {
      get().showToast("Creating pages needs the Notion token");
      return;
    }
    // Top-level "New page": try the private scratchpad first, then the
    // capture page. Both must be shared with the integration so the created
    // page is readable back in Hive; an unshared scratchpad just falls
    // through to the next candidate.
    let candidates: string[];
    if (parentId && parentId !== DEMO_PAGE_ID) {
      candidates = [parentId];
    } else {
      const config = await loadConfig().catch(() => null);
      candidates = [
        ...new Set(
          [config?.scratchpad_page_id, config?.capture_page_id].filter(
            (p): p is string => !!p,
          ),
        ),
      ];
    }
    dlog(`createPage candidates=[${candidates.map((c) => c.slice(-8)).join(",")}]`);
    let lastError: unknown = null;
    for (const parent of candidates) {
      try {
        const created = (await enqueue(() =>
          notion().pages.create({
            parent: { page_id: parent },
            properties: { title: { title: [{ text: { content: "Untitled" } }] } },
          }),
        )) as { id: string };
        dlog(`createPage created=..${created.id.slice(-8)} under=..${parent.slice(-8)}`);
        await get().openPage(created.id);
        get().showToast("Page created — click the title to name it");
        return;
      } catch (err) {
        dlog(`createPage FAILED under=..${parent.slice(-8)}: ${err instanceof Error ? err.message.slice(0, 80) : err}`);
        lastError = err;
      }
    }
    if (get().mcpStatus === "connected") {
      // Last resort: create a parent-less page AS THE USER — it lands in
      // their Private section, but the integration can't read it back, so
      // Hive can only hand it off to Notion.
      try {
        const id = await mcp.createPrivatePage("Untitled");
        if (id) {
          get().showToast("Created in your Private pages — share it with the integration to edit here");
          void invoke("open_in_notion", { pageId: id }).catch(() => undefined);
          return;
        }
      } catch (err) {
        lastError = err;
      }
    }
    get().showToast(
      lastError
        ? `Create failed: ${lastError instanceof Error ? lastError.message : lastError}`
        : "No parent page — set scratchpadPageId or capturePageId in config",
    );
  },

  createDatabaseInline: async (_afterBlockId: string) => {
    const { pageId, auth } = get();
    if (!pageId || pageId === DEMO_PAGE_ID || auth.status !== "ready") return;
    try {
      await createInlineDatabase(pageId, "Untitled");
      // The API appends child_database blocks at the page end and offers no
      // way to create or move them at a position — be honest and take the
      // user there. A full reload is acceptable here only: creation is rare.
      get().showToast("Database created at the end of the page (API places it there)");
      await get().openPage(pageId);
      setTimeout(() => {
        const grids = document.querySelectorAll(".hive-db");
        grids[grids.length - 1]?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 600);
    } catch (err) {
      get().showToast(
        `Create failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  },

  updatePageTitle: async (title: string) => {
    const { pageId, page, auth } = get();
    if (!pageId || !page || !title.trim()) return;
    const clean = title.trim();
    // optimistic: rewrite the title property locally
    const props = { ...(page.page.properties as Record<string, unknown>) };
    for (const [key, val] of Object.entries(props)) {
      const v = val as { type?: string };
      if (v?.type === "title") {
        props[key] = {
          ...v,
          title: [{ type: "text", plain_text: clean, href: null,
            annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
            text: { content: clean, link: null } }],
        };
      }
    }
    const nextPage = { ...page.page, properties: props };
    set({ page: { ...page, page: nextPage } });
    try {
      await upsertPageCache(pageId, nextPage, page.blocks);
    } catch { /* no SQLite */ }
    if (auth.status === "ready" && pageId !== DEMO_PAGE_ID) {
      enqueue(() =>
        notion().pages.update({
          page_id: pageId,
          properties: { title: { title: [{ text: { content: clean } }] } },
        } as never),
      ).catch((err) =>
        set({ writeError: `Title save failed: ${err instanceof Error ? err.message : err}` }),
      );
    }
    await get().recordOpen(pageId, { ...page, page: nextPage });
  },

  /**
   * Comment on the open page. The API cannot anchor new inline threads
   * (page-level comments or thread replies only), so the selection is
   * quoted for context — teammates see it in Notion's page comments.
   */
  createComment: async (text: string, quote: string, mentions = []) => {
    const { pageId, auth, mcpStatus } = get();
    if (!pageId || pageId === DEMO_PAGE_ID || auth.status !== "ready") {
      get().showToast("Comments need a real page and a connected token");
      return;
    }
    const { draftToMarkdown, draftToRichText } = await import("../lib/commentDraft");
    // Preferred path: the user's own identity via hosted-MCP OAuth. Posts
    // under their real name and — when there's a selection — anchors the
    // comment inline, which the REST API cannot do at all.
    if (mcpStatus === "connected") {
      try {
        await mcp.createCommentAsUser(pageId, draftToMarkdown(text, mentions), {
          quote: quote.trim() || undefined,
        });
        get().showToast(
          quote.trim() ? "Comment anchored to your selection" : "Comment posted as you",
        );
        if (get().commentsOpen) void get().loadComments();
        return;
      } catch (err) {
        get().showToast(
          `Personal comment failed, falling back to bot: ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
    }
    try {
      // The API always posts comments AS the integration bot — prefix the
      // human's name so teammates know who is speaking.
      const who = get().auth.userName;
      const rich: unknown[] = [];
      if (who) {
        rich.push({ text: { content: `${who}: ` }, annotations: { bold: true } });
      }
      if (quote.trim()) {
        rich.push({
          text: { content: `“${quote.trim().slice(0, 120)}” — ` },
          annotations: { italic: true },
        });
      }
      rich.push(...draftToRichText(text, mentions));
      await enqueue(() =>
        notion().comments.create({
          parent: { page_id: pageId },
          rich_text: rich as never,
        }),
      );
      get().showToast("Comment posted to the page");
      if (get().commentsOpen) void get().loadComments();
    } catch (err) {
      get().showToast(
        `Comment failed (does the integration have the comment capability?): ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  },

  connectPersonalNotion: async () => {
    try {
      set({ mcpStatus: "pending" });
      await mcp.beginConnect();
      get().showToast("Approve Hive in the browser window that just opened");
    } catch (err) {
      set({ mcpStatus: "disconnected" });
      get().showToast(
        `Couldn't start Notion sign-in: ${err instanceof Error ? err.message : err}`,
      );
    }
  },

  completeRestAuth: async (url: string) => {
    try {
      const { completeRestAuth } = await import("../lib/notionRestOauth");
      const workspace = await completeRestAuth(url);
      get().showToast(`Connected to ${workspace} — restarting Hive…`);
      setTimeout(() => window.location.reload(), 1200);
    } catch (err) {
      get().showToast(
        `Notion sign-in failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  },

  completeMcpAuth: async (url: string) => {
    try {
      await mcp.completeConnect(url);
      set({ mcpStatus: "connected" });
      get().showToast("Connected — comments now post as you");
      if (get().commentsOpen) void get().loadComments();
    } catch (err) {
      set({ mcpStatus: "disconnected" });
      get().showToast(
        `Notion sign-in failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  },

  toggleComments: () => {
    const open = !get().commentsOpen;
    set({ commentsOpen: open });
    if (open) void get().loadComments();
  },

  focusThread: (threadId: string) => {
    set({ commentsOpen: true, focusThreadId: threadId });
    if (!get().commentThreads) void get().loadComments();
  },

  loadComments: async () => {
    const { pageId, auth, mcpStatus } = get();
    if (!pageId || pageId === DEMO_PAGE_ID || auth.status !== "ready") {
      set({ commentThreads: [] });
      return;
    }
    set({ commentsLoading: true });
    try {
      let threads: CommentThread[] | undefined;
      if (mcpStatus === "connected") {
        try {
          threads = await mcp.getCommentsAsUser(pageId);
        } catch {
          // Personal connection failed — reflect it so the panel shows the
          // reconnect affordance instead of silently pretending, then fall
          // through to the page-level REST fallback below.
          set({ mcpStatus: "disconnected" });
        }
      }
      if (threads === undefined) {
        // REST fallback: page-level comments only, grouped by discussion.
        const resp = (await enqueue(() =>
          notion().comments.list({ block_id: pageId, page_size: 100 }),
        )) as { results: Record<string, unknown>[] };
        const byDiscussion = new Map<string, CommentThread>();
        for (const c of resp.results) {
          const did = (c.discussion_id as string) ?? (c.id as string);
          const entry = {
            id: c.id as string,
            authorId: ((c.created_by as { id?: string }) ?? {}).id ?? "",
            time: (c.created_time as string) ?? "",
            text: ((c.rich_text ?? []) as { plain_text: string }[])
              .map((t) => t.plain_text)
              .join(""),
          };
          const existing = byDiscussion.get(did);
          if (existing) existing.comments.push(entry);
          else
            byDiscussion.set(did, {
              id: did,
              context: "page",
              anchor: null,
              resolved: false,
              comments: [entry],
              reactions: [],
            });
        }
        threads = [...byDiscussion.values()];
      }
      set({ commentThreads: threads, commentsLoading: false });
      // Resolve author ids → names through the REST users API (cached).
      const known = get().commentUsers;
      const missing = [
        ...new Set(
          threads
            .flatMap((t) => t.comments.map((c) => c.authorId))
            .filter((id) => id && !known[id]),
        ),
      ];
      for (const id of missing.slice(0, 20)) {
        try {
          const u = (await enqueue(() =>
            notion().users.retrieve({ user_id: id }),
          )) as { name?: string };
          if (u.name) {
            set({ commentUsers: { ...get().commentUsers, [id]: u.name } });
          }
        } catch {
          /* guests or removed users can 404 — leave the id short-form */
        }
      }
    } catch (err) {
      set({ commentsLoading: false, commentThreads: [] });
      get().showToast(
        `Couldn't load comments: ${err instanceof Error ? err.message : err}`,
      );
    }
  },

  setMovePageOpen: (open: boolean) => set({ movePageOpen: open }),

  movePageInNotion: async (parent: { pageId: string } | "workspace") => {
    const { pageId, mcpStatus } = get();
    if (!pageId || pageId === DEMO_PAGE_ID) return;
    if (mcpStatus !== "connected") {
      get().showToast("Moving pages needs your personal Notion connection (comments panel → connect)");
      return;
    }
    try {
      await mcp.movePageAsUser(pageId, parent);
      const { invalidateBreadcrumbs } = await import("../lib/breadcrumbs");
      invalidateBreadcrumbs(pageId);
      set({ movePageOpen: false });
      get().showToast(
        parent === "workspace" ? "Moved to your Private pages" : "Page moved",
      );
      // reopen so the parent chain and sub-pages reflect the new home
      void get().openPage(pageId);
    } catch (err) {
      get().showToast(`Move failed: ${err instanceof Error ? err.message : err}`);
    }
  },

  deletePage: async () => {
    const { pageId, auth, page } = get();
    if (!pageId || pageId === DEMO_PAGE_ID || auth.status !== "ready") return;
    const title = page ? pageTitle(page.page) : "page";
    try {
      // Notion's API can't hard-delete — archived: true IS "move to trash"
      // (restorable from Notion's Trash for 30 days, or via undo here).
      await enqueue(() =>
        notion().pages.update({ page_id: pageId, archived: true } as never),
      );
      for (const item of get().sidebarItems.filter((i) => i.notionPageId === pageId)) {
        await get().removeItem(item.id);
      }
      set({ pageId: null, page: null, pageStatus: "idle", pageError: null });
      get().showToast(`“${title}” moved to Notion's trash`, async () => {
        await enqueue(() =>
          notion().pages.update({ page_id: pageId, archived: false } as never),
        );
        await get().openPage(pageId);
      });
    } catch (err) {
      get().showToast(
        `Delete failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  },

  replyToThread: async (discussionId: string, text: string, mentions = []) => {
    const { pageId, mcpStatus } = get();
    if (!pageId) return;
    const { draftToMarkdown, draftToRichText } = await import("../lib/commentDraft");
    try {
      if (mcpStatus === "connected") {
        await mcp.createCommentAsUser(pageId, draftToMarkdown(text, mentions), {
          discussionId,
        });
      } else {
        const who = get().auth.userName;
        const rich: unknown[] = [];
        if (who) rich.push({ text: { content: `${who}: ` }, annotations: { bold: true } });
        rich.push(...draftToRichText(text, mentions));
        // REST replies want the bare discussion uuid, not the discussion:// URL
        const bare = discussionId.split("/").pop() ?? discussionId;
        await enqueue(() =>
          notion().comments.create({ discussion_id: bare, rich_text: rich as never }),
        );
      }
      get().showToast("Reply posted");
      void get().loadComments();
    } catch (err) {
      get().showToast(
        `Reply failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  },

  /** Quick capture: create a real Notion page under config capturePageId. */
  createCapture: async (text: string) => {
    const lines = text.trim().split("\n");
    const title = lines[0]?.slice(0, 120) || "Quick note";
    const body = lines.slice(1).join("\n").trim();
    try {
      const config = await loadConfig();
      const parent = config.capture_page_id;
      if (!parent || get().auth.status !== "ready") {
        get().showToast("Set capturePageId in ~/.hive/config.json first");
        return;
      }
      const created = (await enqueue(() =>
        notion().pages.create({
          parent: { page_id: parent },
          properties: {
            title: { title: [{ text: { content: title } }] },
          },
          ...(body
            ? {
                children: [
                  {
                    paragraph: {
                      rich_text: [{ text: { content: body.slice(0, 1900) } }],
                    },
                  } as never,
                ],
              }
            : {}),
        }),
      )) as { id: string };
      set({ captureOpen: false });
      get().showToast(`Captured “${title}”`, async () => {
        await get().openPage(created.id); // "undo" slot doubles as open
      });
    } catch (err) {
      get().showToast(
        `Capture failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  },

  openSearch: async (query: string) => {
    const q = query.trim();
    if (!q) return;
    set({ searchView: { query: q, results: [], cursor: null, loading: true } });
    // Local full-text hits first (these include body matches the API can't do)
    type Row = { pageId: string; title: string; icon: string | null; source: "notion" | "cached"; snippet?: string };
    let local: Row[] = [];
    try {
      const { searchCachedPages } = await import("../lib/db");
      local = (await searchCachedPages(q)).map((h) => ({
        pageId: h.pageId, title: h.title, icon: null,
        source: "cached" as const, snippet: h.snippet,
      }));
    } catch { /* no FTS */ }
    let remote: Row[] = [];
    let cursor: string | null = null;
    if (get().auth.status === "ready") {
      try {
        const resp = (await enqueue(() =>
          notion().search({ query: q, page_size: 25, filter: { property: "object", value: "page" } }),
        )) as { results: Record<string, unknown>[]; has_more: boolean; next_cursor: string | null };
        cursor = resp.has_more ? resp.next_cursor : null;
        remote = resp.results.map((p) => ({
          pageId: p.id as string, title: pageTitle(p), icon: pageEmoji(p),
          source: "notion" as const,
        }));
      } catch { /* keep local */ }
    }
    const seen = new Set(local.map((l) => l.pageId));
    const merged = [...local, ...remote.filter((r) => !seen.has(r.pageId))];
    if (get().searchView?.query !== q) return; // superseded
    set({ searchView: { query: q, results: merged, cursor, loading: false } });
  },

  loadMoreSearch: async () => {
    const view = get().searchView;
    if (!view?.cursor || view.loading) return;
    set({ searchView: { ...view, loading: true } });
    try {
      const resp = (await enqueue(() =>
        notion().search({
          query: view.query, page_size: 25, start_cursor: view.cursor!,
          filter: { property: "object", value: "page" },
        }),
      )) as { results: Record<string, unknown>[]; has_more: boolean; next_cursor: string | null };
      const seen = new Set(view.results.map((r) => r.pageId));
      const more = resp.results
        .map((p) => ({
          pageId: p.id as string, title: pageTitle(p),
          icon: pageEmoji(p), source: "notion" as const,
        }))
        .filter((r) => !seen.has(r.pageId));
      const current = get().searchView;
      if (current?.query !== view.query) return;
      set({
        searchView: {
          ...current,
          results: [...current.results, ...more],
          cursor: resp.has_more ? resp.next_cursor : null,
          loading: false,
        },
      });
    } catch {
      const current = get().searchView;
      if (current) set({ searchView: { ...current, loading: false } });
    }
  },

  closeSearch: () => set({ searchView: null }),

  // Peek (Arc's hover preview): 400ms intent delay to open, 250ms grace to
  // travel from the row into the panel before it closes.
  requestPeek: (pageId: string, anchorY: number) => {
    clearTimeout(peekOpenTimer);
    clearTimeout(peekCloseTimer);
    peekOpenTimer = setTimeout(() => set({ peek: { pageId, anchorY } }), 400);
  },
  releasePeek: () => {
    clearTimeout(peekOpenTimer);
    clearTimeout(peekCloseTimer);
    peekCloseTimer = setTimeout(() => set({ peek: null }), 250);
  },
  holdPeek: () => clearTimeout(peekCloseTimer),
  closePeek: () => {
    clearTimeout(peekOpenTimer);
    clearTimeout(peekCloseTimer);
    set({ peek: null });
  },
}));

// Hook for driving the store from browser tooling. Exposed in release
// builds too — local-only, and live debugging has already paid for itself.
(window as unknown as Record<string, unknown>).__hiveStore = useAppStore;

/** Top-level text-class block ids of the current page — v1 multi-select
 * scope (H): direct children of page.blocks only, EDITABLE_TYPES only. */
export function selectableBlockIds(): string[] {
  return (useAppStore.getState().page?.blocks ?? [])
    .filter((b) => writeback.EDITABLE_TYPES.has(b.type))
    .map((b) => b.id);
}
