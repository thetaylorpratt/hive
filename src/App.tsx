import { useEffect } from "react";
import { useAppStore } from "./store/appStore";
import { Header } from "./components/Header";
import { BlockList } from "./components/BlockRenderer";
import { Sidebar } from "./components/Sidebar";
import { CommandBar } from "./components/CommandBar";
import { MruSwitcher } from "./components/MruSwitcher";
import { Toast } from "./components/Toast";
import { OutlineRail } from "./components/OutlineRail";
import { ShortcutSheet } from "./components/ShortcutSheet";
import { installKeymap } from "./lib/keymap";
import { blocksToPlainText, pageEmoji, pageTitle } from "./lib/pageMeta";

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

function Content() {
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
      <article className={`hive-doc${focusMode ? " focus-mode" : ""}`}>
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
          {emoji && <span style={{ marginRight: "0.35em" }}>{emoji}</span>}
          {pageTitle(page.page)}
        </h1>
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

  useEffect(() => {
    void init();
  }, [init]);

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
        <main className="relative flex-1 overflow-y-auto">
          <Content />
          <OutlineRail />
        </main>
      </div>
      <CommandBar />
      <MruSwitcher />
      <Toast />
      <ShortcutSheet />
    </div>
  );
}
