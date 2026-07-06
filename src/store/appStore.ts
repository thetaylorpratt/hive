import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { loadConfig } from "../lib/config";
import { initNotion, notion } from "../lib/notionClient";
import { enqueue } from "../lib/queue";
import { fetchFresh, loadCached, normalizePageId } from "../lib/fetchPage";
import { DEMO_PAGE_ID, demoBlocks, demoPage } from "../lib/demoPage";
import { upsertPageCache } from "../lib/db";
import type { PageData } from "../lib/types";

export type AuthStatus = "checking" | "ready" | "missing-token" | "error";
export type PageStatus = "idle" | "loading" | "refreshing" | "error";
export type ViewMode = "native" | "embed";

interface AppState {
  auth: { status: AuthStatus; userName?: string; message?: string };
  view: ViewMode;
  pageId: string | null;
  page: PageData | null;
  pageStatus: PageStatus;
  pageError: string | null;

  init: () => Promise<void>;
  openPage: (input: string) => Promise<void>;
  openDemo: () => Promise<void>;
  setView: (view: ViewMode) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  auth: { status: "checking" },
  view: "native",
  pageId: null,
  page: null,
  pageStatus: "idle",
  pageError: null,

  init: async () => {
    let config;
    try {
      config = await loadConfig();
    } catch {
      // Config unreadable (or not running under Tauri) — same guidance applies.
      set({ auth: { status: "missing-token" } });
      return;
    }
    if (!config.notion_token) {
      set({ auth: { status: "missing-token" } });
      return;
    }
    try {
      initNotion(config.notion_token);
      const me = (await enqueue(() => notion().users.me({}))) as {
        name?: string;
        bot?: { owner?: unknown };
      };
      set({ auth: { status: "ready", userName: me.name ?? "integration" } });
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

    try {
      const fresh = await fetchFresh(pageId);
      // A newer navigation may have happened while we were fetching.
      if (get().pageId !== pageId) return;
      set({ page: fresh, pageStatus: "idle" });
    } catch (err) {
      if (get().pageId !== pageId) return;
      const message = err instanceof Error ? err.message : String(err);
      if (cached) {
        // Stale-but-usable: keep showing cache, surface the refresh failure.
        set({ pageStatus: "idle", pageError: `Refresh failed: ${message}` });
      } else {
        set({ pageStatus: "error", pageError: message });
      }
    }
  },

  openDemo: async () => {
    // Exercises the real pipe minus Notion: write the fixture into SQLite,
    // then serve it back cache-first, exactly like a revisited page.
    try {
      await upsertPageCache(DEMO_PAGE_ID, demoPage, demoBlocks);
      const cached = await loadCached(DEMO_PAGE_ID);
      if (cached) {
        set({ pageId: DEMO_PAGE_ID, page: cached, pageStatus: "idle", pageError: null });
        return;
      }
    } catch {
      // SQLite unavailable (e.g. plain-browser dev) — fall through to memory.
    }
    set({
      pageId: DEMO_PAGE_ID,
      page: {
        page: demoPage,
        blocks: demoBlocks,
        fetchedAt: new Date().toISOString(),
        fromCache: false,
      },
      pageStatus: "idle",
      pageError: null,
    });
  },

  setView: (view: ViewMode) => {
    set({ view });
    const { pageId } = get();
    if (view === "embed" && pageId) {
      // Spike: notion.so can't be iframed, so the embedded view is a separate
      // Tauri webview window (see src-tauri open_embed).
      void invoke("open_embed", {
        url: `https://www.notion.so/${pageId.replace(/-/g, "")}`,
      });
    }
  },
}));
