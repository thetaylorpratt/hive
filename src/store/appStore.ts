import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { loadConfig } from "../lib/config";
import { initNotion, notion } from "../lib/notionClient";
import { enqueue } from "../lib/queue";
import { fetchFresh, loadCached, normalizePageId } from "../lib/fetchPage";
import { DEMO_PAGE_ID, DEMO_VERSION, demoBlocks, demoPage } from "../lib/demoPage";
import { upsertPageCache } from "../lib/db";
import { pageEmoji, pageTitle } from "../lib/pageMeta";
import { recordHit } from "../lib/frecencyDb";
import {
  computeUnread,
  noteEditTime,
  primeAttention,
  startAttentionEngine,
} from "../lib/attention";
import * as org from "../lib/orgDb";
import * as writeback from "../lib/writeback";
import type { Folder, SidebarItem, Space, Tier } from "../lib/orgDb";
import type { PageData, RichTextItem } from "../lib/types";

export type AuthStatus = "checking" | "ready" | "missing-token" | "error";
export type PageStatus = "idle" | "loading" | "refreshing" | "error";
export type ViewMode = "native" | "embed";

const ACTIVE_SPACE_KEY = "hive-active-space";

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
  commandBarOpen: boolean;
  unreadPageIds: Set<string>;
  unreadBySpace: Record<string, number>;

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
  setCommandBarOpen: (open: boolean) => void;
  recomputeUnread: () => Promise<void>;

  // editing (write path)
  focusBlockId: string | null;
  writeError: string | null;
  canEdit: () => boolean;
  editBlockText: (blockId: string, type: string, richText: RichTextItem[]) => Promise<void>;
  toggleTodo: (blockId: string, checked: boolean) => Promise<void>;
  insertParagraphAfter: (afterId: string) => Promise<void>;
  deleteBlock: (blockId: string) => Promise<void>;
  setFocusBlock: (blockId: string | null) => void;
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
  commandBarOpen: false,
  unreadPageIds: new Set<string>(),
  unreadBySpace: {},

  init: async () => {
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
    const pageId = normalizePageId(input);
    if (!pageId) {
      set({ pageStatus: "error", pageError: "That doesn't look like a Notion page ID or URL." });
      return;
    }

    // Cache-first: render instantly from SQLite, then revalidate.
    const cached = await loadCached(pageId);
    set({
      pageId,
      page: cached,
      pageStatus: cached ? "refreshing" : "loading",
      pageError: null,
    });
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
    await get().refreshSidebar();
    await get().recomputeUnread();
  },

  openDemo: async () => {
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
    set({ pageId: DEMO_PAGE_ID, page: data, pageStatus: "idle", pageError: null });
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
    await org.deleteItem(itemId);
    await get().refreshSidebar();
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
    const { pageId, page, auth } = get();
    if (!pageId || !page) return;
    const sink = writeback.sinkFor(pageId, auth.status === "ready");
    const result = await writeback.editBlockText(
      pageId, page.blocks, blockId, type, richText, sink,
    );
    set({ page: { ...page, blocks: result.blocks }, writeError: null });
    result.remote.catch((err) =>
      set({ writeError: `Save failed: ${err instanceof Error ? err.message : err}` }),
    );
  },

  toggleTodo: async (blockId, checked) => {
    const { pageId, page, auth } = get();
    if (!pageId || !page) return;
    const sink = writeback.sinkFor(pageId, auth.status === "ready");
    const result = await writeback.toggleTodo(
      pageId, page.blocks, blockId, checked, sink,
    );
    set({ page: { ...page, blocks: result.blocks }, writeError: null });
    result.remote.catch((err) =>
      set({ writeError: `Save failed: ${err instanceof Error ? err.message : err}` }),
    );
  },

  insertParagraphAfter: async (afterId) => {
    const { pageId, page, auth } = get();
    if (!pageId || !page) return;
    const sink = writeback.sinkFor(pageId, auth.status === "ready");
    const result = await writeback.insertParagraphAfter(
      pageId, page.blocks, afterId, pageId, sink,
    );
    set({
      page: { ...page, blocks: result.blocks },
      focusBlockId: result.newBlockId,
      writeError: null,
    });
    void result.remoteId
      .then((realId) => {
        if (!realId) return;
        const current = get().page;
        if (!current) return;
        set({
          page: {
            ...current,
            blocks: writeback.remapBlockId(current.blocks, result.newBlockId, realId),
          },
          focusBlockId:
            get().focusBlockId === result.newBlockId ? realId : get().focusBlockId,
        });
      })
      .catch((err) =>
        set({ writeError: `Save failed: ${err instanceof Error ? err.message : err}` }),
      );
  },

  deleteBlock: async (blockId) => {
    const { pageId, page, auth } = get();
    if (!pageId || !page) return;
    const sink = writeback.sinkFor(pageId, auth.status === "ready");
    const result = await writeback.deleteBlock(pageId, page.blocks, blockId, sink);
    set({ page: { ...page, blocks: result.blocks }, writeError: null });
    result.remote.catch((err) =>
      set({ writeError: `Save failed: ${err instanceof Error ? err.message : err}` }),
    );
  },

  setFocusBlock: (blockId) => set({ focusBlockId: blockId }),

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
    set({ unreadPageIds: unread, unreadBySpace });
    try {
      await invoke("set_badge", { count: unread.size });
    } catch {
      /* not running under Tauri */
    }
  },
}));

// Dev hook for driving the store from browser tooling.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__hiveStore = useAppStore;
}
