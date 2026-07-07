import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { loadConfig } from "../lib/config";
import { initNotion, notion } from "../lib/notionClient";
import { enqueue } from "../lib/queue";
import { fetchFresh, loadCached, normalizePageId } from "../lib/fetchPage";
import { DEMO_PAGE_ID, DEMO_VERSION, demoBlocks, demoPage } from "../lib/demoPage";
import { upsertPageCache } from "../lib/db";
import { blocksToPlainText, pageEmoji, pageTitle } from "../lib/pageMeta";
import { indexPageForSearch } from "../lib/db";
import { recordHit } from "../lib/frecencyDb";
import {
  clearPageDiff,
  computeUnread,
  getPageDiffs,
  noteEditTime,
  primeAttention,
  startAttentionEngine,
} from "../lib/attention";
import type { PageDiff } from "../lib/blockDiff";
import * as org from "../lib/orgDb";
import * as writeback from "../lib/writeback";
import type { Folder, SidebarItem, Space, Tier } from "../lib/orgDb";
import type { PageData, RichTextItem } from "../lib/types";

export type AuthStatus = "checking" | "ready" | "missing-token" | "error";
export type PageStatus = "idle" | "loading" | "refreshing" | "error";
export type ViewMode = "native" | "embed";

const ACTIVE_SPACE_KEY = "hive-active-space";

let peekOpenTimer: ReturnType<typeof setTimeout>;
let peekCloseTimer: ReturnType<typeof setTimeout>;
let navSeq = 0;
let initStarted = false;

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
    if (result.remap) {
      void result.remap
        .then((mapping) => {
          if (!mapping?.to) return;
          requestCommit(mapping.from);
          return chainWrite(async () => {
            const current = get();
            if (current.pageId !== pageId || !current.page) return;
            writeback.flushPendingLocalText(mapping.from, mapping.to!);
            set({
              page: {
                ...current.page,
                blocks: writeback.remapBlockId(current.page.blocks, mapping.from, mapping.to!),
              },
            });
          });
        })
        .catch(() => undefined);
    }
  });
}

function applySpaceAccent(space: Space | undefined) {
  document.documentElement.dataset.spaceAccent = space?.color ?? "sky";
}

interface AppState {
  auth: { status: AuthStatus; userName?: string; message?: string };
  view: ViewMode;
  pageId: string | null;
  page: PageData | null;
  pageStatus: PageStatus;
  pageError: string | null;

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
  toast: { message: string; undo?: () => Promise<void> } | null;
  pageDiffs: Record<string, PageDiff>;
  shortcutSheetOpen: boolean;
  peek: { pageId: string; anchorY: number } | null;

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
  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
  setCommandBarOpen: (open: boolean) => void;
  recomputeUnread: () => Promise<void>;

  // editing (write path)
  focusBlockId: string | null;
  writeError: string | null;
  canEdit: () => boolean;
  editBlockText: (blockId: string, type: string, richText: RichTextItem[]) => Promise<void>;
  toggleTodo: (blockId: string, checked: boolean) => Promise<void>;
  insertParagraphAfter: (afterId: string) => Promise<void>;
  convertBlock: (
    blockId: string,
    newType: string,
    richText?: RichTextItem[],
  ) => Promise<void>;
  deleteBlock: (blockId: string) => Promise<void>;
  updatePageIcon: (emoji: string | null) => Promise<void>;
  updateTableCell: (
    rowId: string,
    cellIndex: number,
    richText: RichTextItem[],
  ) => Promise<void>;
  addTableRow: (tableId: string, afterRowId: string | null) => Promise<void>;
  setTableColumns: (tableId: string, delta: 1 | -1) => Promise<void>;
  duplicateBlock: (blockId: string) => Promise<void>;
  updateTableSettings: (
    tableId: string,
    patch: { has_column_header?: boolean; has_row_header?: boolean },
  ) => Promise<void>;
  moveBlock: (blockId: string, direction: "up" | "down") => Promise<void>;
  indentBlock: (blockId: string) => Promise<void>;
  outdentBlock: (blockId: string) => Promise<void>;
  setFocusBlock: (blockId: string | null) => void;
  toggleFocusMode: () => void;
  showToast: (message: string, undo?: () => Promise<void>) => void;
  dismissToast: () => void;
  dismissDiff: (pageId: string) => void;
  setShortcutSheetOpen: (open: boolean) => void;
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
  pageDiffs: {},
  shortcutSheetOpen: false,
  peek: null,

  init: async () => {
    if (initStarted) return; // StrictMode double-invoke / re-mount guard
    initStarted = true;
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
    });

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
        name?: string;
      };
      set({ auth: { status: "ready", userName: me.name ?? "integration" } });
      void startAttentionEngine(() => void get().recomputeUnread());
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
    set({
      pageId,
      page: cached,
      pageStatus: cached ? "refreshing" : "loading",
      pageError: null,
      focusBlockId: null,
      writeError: null,
    });
    get().closePeek();
    if (cached) await get().recordOpen(pageId, cached);

    try {
      const fresh = await fetchFresh(pageId);
      // A newer navigation may have happened while we were fetching.
      if (get().pageId !== pageId) return;
      set({ page: fresh, pageStatus: "idle" });
      await get().recordOpen(pageId, fresh);
    } catch (err) {
      if (get().pageId !== pageId) return;
      const message = err instanceof Error ? err.message : String(err);
      if (cached) {
        set({ pageStatus: "idle", pageError: `Refresh failed: ${message}` });
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
      focusBlockId: null, writeError: null,
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

  toggleSidebar: () => set({ sidebarVisible: !get().sidebarVisible }),

  setSidebarWidth: (width: number) => {
    const clamped = Math.min(400, Math.max(180, Math.round(width)));
    localStorage.setItem("hive-sidebar-width", String(clamped));
    set({ sidebarWidth: clamped });
  },
  setCommandBarOpen: (open: boolean) => set({ commandBarOpen: open }),

  focusBlockId: null,
  writeError: null,

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
    await applyWrite(get, set, (pageId, blocks, sink) =>
      writeback.toggleTodo(pageId, blocks, blockId, checked, sink),
    );
  },

  insertParagraphAfter: async (afterId) => {
    await chainWrite(async () => {
      const { pageId, page, auth } = get();
      if (!pageId || !page) return;
      const sink = writeback.sinkFor(pageId, auth.status === "ready");
      const result = await writeback.insertParagraphAfter(
        pageId, page.blocks, afterId, pageId, sink,
      );
      if (get().pageId !== pageId) return;
      set({
        page: { ...page, blocks: result.blocks },
        focusBlockId: result.newBlockId,
        writeError: null,
      });
      void result.remoteId
        .then((realId) => {
          if (!realId) return;
          requestCommit(result.newBlockId);
          return chainWrite(async () => {
            const current = get();
            if (current.pageId !== pageId || !current.page) return;
            writeback.flushPendingLocalText(result.newBlockId, realId);
            set({
              page: {
                ...current.page,
                blocks: writeback.remapBlockId(current.page.blocks, result.newBlockId, realId),
              },
              focusBlockId:
                get().focusBlockId === result.newBlockId ? realId : get().focusBlockId,
            });
          });
        })
        .catch((err) =>
          set({ writeError: `Save failed: ${err instanceof Error ? err.message : err}` }),
        );
    });
  },

  convertBlock: async (blockId, newType, richText = []) => {
    await chainWrite(async () => {
      const { pageId, page, auth } = get();
      if (!pageId || !page) return;
      const sink = writeback.sinkFor(pageId, auth.status === "ready");
      const result = await writeback.convertBlockType(
        pageId, page.blocks, blockId, newType, richText, sink,
      );
      if (get().pageId !== pageId) return;
      set({
        page: { ...page, blocks: result.blocks },
        focusBlockId: newType === "divider" ? null : blockId,
        writeError: null,
      });
      void result.remoteId
        .then((realId) => {
          if (!realId) return;
          requestCommit(blockId);
          return chainWrite(async () => {
            const current = get();
            if (current.pageId !== pageId || !current.page) return;
            writeback.flushPendingLocalText(blockId, realId);
            set({
              page: {
                ...current.page,
                blocks: writeback.remapBlockId(current.page.blocks, blockId, realId),
              },
            });
          });
        })
        .catch((err) =>
          set({ writeError: `Save failed: ${err instanceof Error ? err.message : err}` }),
        );
    });
  },

  deleteBlock: async (blockId) => {
    await chainWrite(async () => {
    const { pageId, page, auth } = get();
    if (!pageId || !page) return;
    const sink = writeback.sinkFor(pageId, auth.status === "ready");
    const captured = writeback.findWithPrev(page.blocks, blockId);
    const result = await writeback.deleteBlock(pageId, page.blocks, blockId, sink);
    if (get().pageId !== pageId) return;
    set({ page: { ...page, blocks: result.blocks }, writeError: null });
    result.remote.catch((err) =>
      set({ writeError: `Save failed: ${err instanceof Error ? err.message : err}` }),
    );
    const hadText =
      captured &&
      ((captured.block[captured.block.type] as { rich_text?: unknown[] })
        ?.rich_text?.length ?? 0) > 0;
    if (captured && hadText) {
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

  setFocusBlock: (blockId) => set({ focusBlockId: blockId }),

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

  showToast: (message, undo) => {
    set({ toast: { message, undo } });
    const shown = get().toast;
    setTimeout(() => {
      if (get().toast === shown) set({ toast: null });
    }, 6000);
  },

  dismissToast: () => set({ toast: null }),

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
    void result.remote
      .then(() => {
        // The rebuild trick changes table/row ids — resync from Notion.
        if (result.rebuilt && get().pageId === pageId) {
          void get().openPage(pageId);
        }
      })
      .catch((err) =>
        set({ writeError: `Save failed: ${err instanceof Error ? err.message : err}` }),
      );
    });
  },

  duplicateBlock: async (blockId) => {
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
    await applyWrite(get, set, (pageId, blocks, sink) =>
      writeback.moveBlock(pageId, blocks, blockId, direction, sink),
    );
  },
  indentBlock: async (blockId) => {
    await applyWrite(get, set, (pageId, blocks, sink) =>
      writeback.indentBlock(pageId, blocks, blockId, sink),
    );
  },
  outdentBlock: async (blockId) => {
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

  dismissDiff: (pageId: string) => {
    clearPageDiff(pageId);
    set({ pageDiffs: getPageDiffs() });
  },

  setShortcutSheetOpen: (open: boolean) => set({ shortcutSheetOpen: open }),

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

// Dev hook for driving the store from browser tooling.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__hiveStore = useAppStore;
}
