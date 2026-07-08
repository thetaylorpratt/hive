import { useEffect, useState } from "react";
import { useAppStore } from "./store/appStore";
import { Header } from "./components/Header";
import { BlockList } from "./components/BlockRenderer";
import { Sidebar } from "./components/Sidebar";
import { CommandBar } from "./components/CommandBar";
import { MruSwitcher } from "./components/MruSwitcher";
import { Toast } from "./components/Toast";
import { PropertiesHeader } from "./components/PropertiesHeader";
import { PeekLayer } from "./components/PeekLayer";
import { SplitPane } from "./components/SplitPane";
import { InboxPanel } from "./components/InboxPanel";
import { OutlineRail } from "./components/OutlineRail";
import { ShortcutSheet } from "./components/ShortcutSheet";
import { installKeymap } from "./lib/keymap";
import { blocksToPlainText, pageEmoji, pageTitle } from "./lib/pageMeta";
import { normalizePageId } from "./lib/fetchPage";
import { invoke } from "@tauri-apps/api/core";

function Notice({
  tone,
  title,
  children,
}: {
  tone: "warning" | "critical" | "neutral";
  title: string;
  children?: React.ReactNode;
}) {
  const palette = {
    warning: ["var(--hive-color-warning-bg)", "var(--hive-color-warning-fg)"],
    critical: ["var(--hive-color-critical-bg)", "var(--hive-color-critical-fg)"],
    neutral: ["var(--hive-color-bg-subtle)", "var(--hive-color-fg-secondary)"],
  }[tone];
  return (
    <div
      className="mx-auto mt-16 max-w-lg"
      style={{
        background: "var(--hive-color-bg-surface)",
        border: "1px solid var(--hive-color-border-subtle)",
        borderRadius: "var(--hive-radius-lg)",
        boxShadow: "var(--hive-shadow-sm)",
        padding: "20px 24px",
      }}
    >
      <div
        className="mb-2 inline-block"
        style={{
          background: palette[0],
          color: palette[1],
          borderRadius: "var(--hive-radius)",
          padding: "2px 10px",
          fontSize: "0.75rem",
          fontWeight: 600,
        }}
      >
        {title}
      </div>
      <div style={{ color: "var(--hive-color-fg-secondary)" }}>{children}</div>
    </div>
  );
}

function PageIcon({ emoji }: { emoji: string | null }) {
  const canEdit = useAppStore((s) => s.canEdit());
  const updatePageIcon = useAppStore((s) => s.updatePageIcon);
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <input
        className="hive-input hive-page-icon-input"
        autoFocus
        defaultValue={emoji ?? ""}
        maxLength={4}
        placeholder="🐝"
        title="⌃⌘Space opens the emoji picker; empty removes the icon"
        onBlur={(e) => {
          void updatePageIcon(e.target.value.trim() || null);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setEditing(false);
        }}
      />
    );
  }
  if (!emoji && !canEdit) return null;
  return (
    <span
      className={`hive-page-icon${canEdit ? " editable" : ""}`}
      title={canEdit ? "Click to change icon" : undefined}
      onClick={() => canEdit && setEditing(true)}
    >
      {emoji ?? <span className="add-hint">☺︎</span>}
    </span>
  );
}

function DemoButton() {
  const openDemo = useAppStore((s) => s.openDemo);
  return (
    <button
      className="hive-btn hive-btn-secondary"
      style={{ marginTop: "10px" }}
      onClick={() => void openDemo()}
    >
      Load demo page
    </button>
  );
}

function SearchResults() {
  const searchView = useAppStore((s) => s.searchView)!;
  const openPage = useAppStore((s) => s.openPage);
  const loadMoreSearch = useAppStore((s) => s.loadMoreSearch);
  const closeSearch = useAppStore((s) => s.closeSearch);
  return (
    <article className="hive-doc hive-page-in">
      <div className="hive-search-head">
        <h1 className="hive-page-title">Results for “{searchView.query}”</h1>
        <button className="hive-btn hive-btn-secondary" onClick={closeSearch}>
          Close
        </button>
      </div>
      {searchView.results.map((r) => (
        <div
          key={r.pageId}
          className="hive-search-row"
          onClick={() => void openPage(r.pageId)}
        >
          <span className="icon">{r.icon ?? "📄"}</span>
          <span className="body">
            <span className="title">{r.title}</span>
            {r.snippet && <span className="snippet">{r.snippet}</span>}
          </span>
          <span className="hint">{r.source === "cached" ? "content match" : "Notion"}</span>
        </div>
      ))}
      {searchView.results.length === 0 && !searchView.loading && (
        <p style={{ color: "var(--hive-color-fg-muted)" }}>
          No matches. Title search only covers pages connected to the
          integration; content search grows as the background indexer crawls.
        </p>
      )}
      {searchView.loading && <p style={{ color: "var(--hive-color-fg-muted)" }}>Searching…</p>}
      {searchView.cursor && !searchView.loading && (
        <button className="hive-btn hive-btn-secondary" onClick={() => void loadMoreSearch()}>
          Load more
        </button>
      )}
    </article>
  );
}

/** Sub-page navigation: child_page blocks anywhere in the open page. */
function SubPages() {
  const page = useAppStore((s) => s.page);
  const openPage = useAppStore((s) => s.openPage);
  if (!page) return null;
  const subs: { id: string; title: string }[] = [];
  const walk = (blocks: typeof page.blocks) => {
    for (const b of blocks) {
      if (b.type === "child_page") {
        subs.push({ id: b.id, title: (b.child_page as { title?: string })?.title || "Untitled" });
      }
      if (b.children) walk(b.children);
    }
  };
  walk(page.blocks);
  if (subs.length === 0) return null;
  return (
    <div className="hive-subpages">
      <span className="label">Sub-pages</span>
      {subs.map((sp) => (
        <button key={sp.id} onClick={() => void openPage(sp.id)}>
          📄 {sp.title}
        </button>
      ))}
    </div>
  );
}

function Content() {
  const searchView = useAppStore((s) => s.searchView);
  const auth = useAppStore((s) => s.auth);
  const page = useAppStore((s) => s.page);
  const pageStatus = useAppStore((s) => s.pageStatus);
  const pageError = useAppStore((s) => s.pageError);
  const writeError = useAppStore((s) => s.writeError);
  const canEdit = useAppStore((s) => s.canEdit());
  const focusMode = useAppStore((s) => s.focusMode);
  const pageId = useAppStore((s) => s.pageId);
  const pageDiffs = useAppStore((s) => s.pageDiffs);
  const dismissDiff = useAppStore((s) => s.dismissDiff);

  if (searchView) return <SearchResults />;

  // A loaded page (including the demo fixture) always wins over auth notices.
  if (page && pageStatus !== "error" && pageStatus !== "loading") {
    const emoji = pageEmoji(page.page);
    const words = blocksToPlainText(
      page.blocks as Parameters<typeof blocksToPlainText>[0],
    )
      .split(/\s+/)
      .filter(Boolean).length;
    const diff = pageId ? pageDiffs[pageId] : undefined;
    return (
      <article
        key={pageId}
        className={`hive-doc hive-page-in${focusMode ? " focus-mode" : ""}`}
      >
        {diff && (
          <div className="hive-diff-banner">
            <div className="summary">
              <span>
                Changed since your last copy: {diff.added > 0 && `${diff.added} added`}
                {diff.added > 0 && (diff.changed > 0 || diff.removed > 0) && " · "}
                {diff.changed > 0 && `${diff.changed} edited`}
                {diff.changed > 0 && diff.removed > 0 && " · "}
                {diff.removed > 0 && `${diff.removed} removed`}
              </span>
              <button onClick={() => pageId && dismissDiff(pageId)}>×</button>
            </div>
            {diff.excerpts.length > 0 && (
              <ul>
                {diff.excerpts.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        <h1 className="hive-page-title">
          <PageIcon emoji={emoji} />
          {pageTitle(page.page)}
        </h1>
        <PropertiesHeader page={page.page} />
        <SubPages />
        <div
          className="mb-4"
          style={{ fontSize: "0.75rem", color: "var(--hive-color-fg-muted)" }}
        >
          {page.fromCache ? "served from cache" : "fresh from Notion"} · fetched{" "}
          {new Date(page.fetchedAt).toLocaleString()}
          {pageStatus === "refreshing" && " · refreshing…"}
          {canEdit ? " · editable" : " · read-only until token"}
          {` · ${words} words`}
          {focusMode && " · focus"}
          {pageError && (
            <span style={{ color: "var(--hive-color-critical-fg)" }}>
              {" "}
              · {pageError}
            </span>
          )}
          {writeError && (
            <span style={{ color: "var(--hive-color-critical-fg)" }}>
              {" "}
              · {writeError}
            </span>
          )}
        </div>
        <BlockList blocks={page.blocks} />
      </article>
    );
  }

  if (auth.status === "missing-token") {
    return (
      <Notice tone="warning" title="Notion token missing">
        <p>
          Create <code className="hive-inline-code">~/.hive/config.json</code>{" "}
          containing:
        </p>
        <div className="hive-code-block">
          <pre>{`{ "notionToken": "ntn_..." }`}</pre>
        </div>
        <p>
          Get an internal integration token at notion.so/my-integrations and
          share the pages you want with the integration, then relaunch Hive.
        </p>
        <p>Meanwhile, the renderer and cache work without a token:</p>
        <DemoButton />
      </Notice>
    );
  }

  if (auth.status === "error") {
    return (
      <Notice tone="critical" title="Authentication failed">
        <p>{auth.message}</p>
        <p>Check that the token in ~/.hive/config.json is valid.</p>
      </Notice>
    );
  }

  if (pageStatus === "error") {
    return (
      <Notice tone="critical" title="Couldn't load page">
        <p>{pageError}</p>
        <p>
          Make sure the page is shared with your integration (Notion → page →
          Connections).
        </p>
      </Notice>
    );
  }

  if (pageStatus === "loading") {
    return (
      <Notice tone="neutral" title="Loading">
        <p>Fetching page from Notion…</p>
      </Notice>
    );
  }

  return (
    <Notice tone="neutral" title="Phase 2 — sidebar & Spaces">
      <p>
        <kbd>⌘T</kbd> to search and open docs. Open docs land in Today, pin
        what should persist, <kbd>⌃1–9</kbd> switches Spaces.
      </p>
      <DemoButton />
    </Notice>
  );
}

export default function App() {
  const init = useAppStore((s) => s.init);
  const sidebarVisible = useAppStore((s) => s.sidebarVisible);
  const split = useAppStore((s) => s.split);

  useEffect(() => {
    void init();
  }, [init]);

  // URL routing (built-in Finicky). Hive handles hive:// deep links AND —
  // when set as the default browser — all http/https clicks: Notion pages
  // open in Hive; every other link forwards to the fallback browser.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const handle = (urls: string[]) => {
      const s = useAppStore.getState();
      let openedInHive = false;
      for (const raw of urls) {
        const url = decodeURIComponent(raw);
        const isHiveScheme = raw.startsWith("hive:");
        const isNotionLink = /https?:\/\/[^/]*notion\.(so|com)\//i.test(url);
        if ((isHiveScheme || isNotionLink) && normalizePageId(url)) {
          void s.openPage(url);
          openedInHive = true;
        } else if (!isHiveScheme) {
          // not ours — hand it to the real browser, don't steal focus
          void invoke("forward_url", { url: raw }).catch(() => undefined);
        }
      }
      if (openedInHive) {
        void import("@tauri-apps/api/window")
          .then((w) => w.getCurrentWindow().setFocus())
          .catch(() => undefined);
      }
    };
    void import("@tauri-apps/plugin-deep-link")
      .then(async (dl) => {
        const initial = await dl.getCurrent().catch(() => null);
        if (initial?.length) handle(initial);
        unlisten = await dl.onOpenUrl(handle);
      })
      .catch(() => undefined); // plain-browser dev: no deep links
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    return installKeymap((action) => {
      const s = useAppStore.getState();
      if (action === "command-bar") s.setCommandBarOpen(!s.commandBarOpen);
      else if (action === "toggle-sidebar") s.toggleSidebar();
      else if (action === "focus-mode") s.toggleFocusMode();
      else if (action === "shortcut-sheet")
        s.setShortcutSheetOpen(!s.shortcutSheetOpen);
      else if (action.startsWith("switch-space-")) {
        void s.switchSpaceByIndex(Number(action.slice("switch-space-".length)));
      }
    });
  }, []);

  return (
    <div className="flex h-full">
      {sidebarVisible && <Sidebar />}
      <div className="flex min-w-0 flex-1 flex-col">
        <Header />
        <div className="flex min-h-0 flex-1">
          <main className="relative flex-1 overflow-y-auto">
            <Content />
            <OutlineRail />
          </main>
          {split && <SplitPane />}
        </div>
      </div>
      <CommandBar />
      <MruSwitcher />
      <Toast />
      <ShortcutSheet />
      <InboxPanel />
      <PeekLayer />
    </div>
  );
}
