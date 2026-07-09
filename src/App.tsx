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
import { CommentsPanel } from "./components/CommentsPanel";
import { MovePageModal } from "./components/MovePageModal";
import { InboxPanel } from "./components/InboxPanel";
import { CaptureModal } from "./components/CaptureModal";
import { HomeScreen } from "./components/HomeScreen";
import { EmojiPicker } from "./components/EmojiPicker";
import { OutlineRail } from "./components/OutlineRail";
import { ShortcutSheet } from "./components/ShortcutSheet";
import { installKeymap } from "./lib/keymap";
import { installDebugTaps } from "./lib/debugLog";
import { blocksToPlainText, pageEmoji, pageTitle } from "./lib/pageMeta";
import { Glyph } from "./lib/iconSets";
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
  const [picking, setPicking] = useState(false);

  if (!emoji && !canEdit) return null;
  return (
    <span style={{ position: "relative" }}>
      <span
        className={`hive-page-icon${canEdit ? " editable" : ""}`}
        title={canEdit ? "Click to change icon" : undefined}
        onClick={() => canEdit && setPicking(!picking)}
      >
        {emoji ? <Glyph icon={emoji} size={34} /> : <span className="add-hint">☺︎</span>}
      </span>
      {picking && (
        <span className="hive-page-icon-popover">
          <EmojiPicker
            iconSet="notion"
            onPick={(char) => {
              setPicking(false);
              void updatePageIcon(char);
            }}
            onRemove={() => {
              setPicking(false);
              void updatePageIcon(null);
            }}
            onClose={() => setPicking(false)}
          />
        </span>
      )}
    </span>
  );
}

/** On a failed page load, hand the link off to something that CAN open it —
 * the native Notion app or the fallback browser (the user's own permissions
 * apply there, unlike the integration's). */
function ErrorEscapeHatches() {
  const lastOpenInput = useAppStore((s) => s.lastOpenInput);
  if (!lastOpenInput) return null;
  const id = normalizePageId(lastOpenInput);
  const webUrl = /^https?:\/\//i.test(lastOpenInput)
    ? lastOpenInput
    : id
      ? `https://www.notion.so/${id.replace(/-/g, "")}`
      : null;
  return (
    <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
      {id && (
        <button
          className="hive-btn hive-btn-secondary"
          onClick={() => void invoke("open_in_notion", { pageId: id }).catch(() => undefined)}
        >
          Open in Notion app
        </button>
      )}
      {webUrl && (
        <button
          className="hive-btn hive-btn-secondary"
          onClick={() => void invoke("forward_url", { url: webUrl }).catch(() => undefined)}
        >
          Open in browser
        </button>
      )}
    </div>
  );
}

/** Tokenless onboarding: one-click OAuth when the public integration's
 * credentials are baked into the build (see notionRestOauth.ts). */
function SignInWithNotion() {
  const [busy, setBusy] = useState(false);
  const [configured, setConfigured] = useState(false);
  useEffect(() => {
    void import("./lib/notionRestOauth").then((m) =>
      setConfigured(m.restOauthConfigured()),
    );
  }, []);
  if (!configured) return null;
  return (
    <p>
      <button
        className="hive-btn hive-btn-primary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void import("./lib/notionRestOauth").then((m) => m.beginRestAuth());
        }}
      >
        {busy ? "Waiting for Notion…" : "Sign in with Notion"}
      </button>
      <span style={{ marginLeft: 10, color: "var(--hive-color-fg-muted)", fontSize: "0.85rem" }}>
        pick the pages you want Hive to see — no token needed
      </span>
    </p>
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
          <span className="icon">{r.icon ? <Glyph icon={r.icon} /> : "📄"}</span>
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
  const displayPrefs = useAppStore((s) => s.displayPrefs);
  const loadMs = useAppStore((s) => s.loadMs);
  const loadSource = useAppStore((s) => s.loadSource);
  const offline = useAppStore((s) => s.offline);

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
        className={`hive-doc hive-page-in${focusMode ? " focus-mode" : ""}${
          displayPrefs.smallText ? " small-text" : ""
        }${displayPrefs.fullWidth ? " full-width" : ""}`}
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
          <span
            className={canEdit ? "hive-title-edit" : undefined}
            contentEditable={canEdit}
            suppressContentEditableWarning
            spellCheck={false}
            onBlur={(e) => {
              const t = e.currentTarget.textContent ?? "";
              if (canEdit && t.trim() && t.trim() !== pageTitle(page.page)) {
                void useAppStore.getState().updatePageTitle(t);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                (e.target as HTMLElement).blur();
              }
            }}
          >
            {pageTitle(page.page)}
          </span>
        </h1>
        <PropertiesHeader page={page.page} />
        <SubPages />
        <div
          className="mb-4"
          style={{ fontSize: "0.75rem", color: "var(--hive-color-fg-muted)" }}
        >
          {loadSource && loadMs !== null && (
            <>
              <span
                className={`hive-load-chip${
                  loadSource === "cache"
                    ? offline
                      ? " hive-load-chip-offline"
                      : " hive-load-chip-cache"
                    : ""
                }`}
              >
                {loadSource === "cache"
                  ? offline
                    ? `⚡ ${loadMs} ms · offline copy`
                    : `⚡ ${loadMs} ms · cache`
                  : `${loadMs} ms · fetched live`}
              </span>{" "}
              ·{" "}
            </>
          )}
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
        {canEdit && (
          <div
            className="hive-below-strip"
            onClick={() => {
              const blocks = page.blocks;
              const last = blocks[blocks.length - 1];
              if (!last) return;
              const payload = last[last.type] as
                | { rich_text?: unknown[] }
                | undefined;
              if (last.type === "paragraph" && !payload?.rich_text?.length) {
                useAppStore.getState().setFocusBlock(last.id);
              } else {
                void useAppStore.getState().insertParagraphAfter(last.id);
              }
            }}
          />
        )}
      </article>
    );
  }

  if (auth.status === "missing-token") {
    return (
      <Notice tone="warning" title="Connect Notion">
        <SignInWithNotion />
        <p>
          Or create <code className="hive-inline-code">~/.hive/config.json</code>{" "}
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
        <ErrorEscapeHatches />
      </Notice>
    );
  }

  if (pageStatus === "loading") {
    return <PageSkeleton />;
  }

  return <HomeScreen />;
}

/** Cold-load placeholder: a content skeleton instead of a bare spinner
 * notice, so even the (rare) uncached load still feels alive. */
function PageSkeleton() {
  return (
    <article className="hive-doc hive-page-in">
      <div className="hive-skeleton hive-skeleton-title" />
      <div className="hive-skeleton hive-skeleton-line" />
      <div className="hive-skeleton hive-skeleton-line" />
      <div className="hive-skeleton hive-skeleton-line" />
      <div className="hive-skeleton hive-skeleton-line short" />
    </article>
  );
}

export default function App() {
  const init = useAppStore((s) => s.init);
  const sidebarVisible = useAppStore((s) => s.sidebarVisible);
  const split = useAppStore((s) => s.split);
  const commentsOpen = useAppStore((s) => s.commentsOpen);
  const movePageOpen = useAppStore((s) => s.movePageOpen);

  useEffect(() => {
    void init();
    installDebugTaps();
    // Global link routing: WKWebView asks the OS to open external links,
    // but the OS default browser IS Hive — macOS refuses the self-open and
    // falls back to Safari. Intercept every anchor click ourselves: Notion
    // links open in Hive, everything else forwards to the fallback browser.
    const onLinkClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a) return;
      const href = a.getAttribute("href") ?? "";
      if (!/^https?:\/\//i.test(href)) return;
      // preventDefault also suppresses WebKit's native ⌘-click/middle-click
      // "open in new window" policy, which would end up in Safari
      e.preventDefault();
      const id = /notion\.(so|com)/i.test(href) ? normalizePageId(href) : null;
      if (id && !e.metaKey) void useAppStore.getState().openPage(id);
      else void invoke("forward_url", { url: href }).catch(() => undefined);
    };
    document.addEventListener("click", onLinkClick, true);
    document.addEventListener("auxclick", onLinkClick, true);
    return () => {
      document.removeEventListener("click", onLinkClick, true);
      document.removeEventListener("auxclick", onLinkClick, true);
    };
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
        if (raw.startsWith("hive://oauth/callback")) {
          void s.completeMcpAuth(raw);
          openedInHive = true;
          continue;
        }
        if (raw.startsWith("hive://oauth/notion")) {
          void s.completeRestAuth(raw);
          openedInHive = true;
          continue;
        }
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

  // System-wide quick capture: ⌃⌥N from any app raises Hive with the
  // capture modal open (Rust registers the shortcut and emits the event).
  useEffect(() => {
    let uninstall: (() => void) | undefined;
    void import("./lib/globalCapture")
      .then(async (m) => {
        uninstall = await m.installGlobalCaptureListener();
      })
      .catch(() => undefined);
    return () => uninstall?.();
  }, []);

  useEffect(() => {
    return installKeymap((action) => {
      const s = useAppStore.getState();
      if (action === "command-bar") s.setCommandBarOpen(!s.commandBarOpen);
      else if (action === "toggle-sidebar") s.toggleSidebar();
      else if (action === "focus-mode") s.toggleFocusMode();
      else if (action === "shortcut-sheet")
        s.setShortcutSheetOpen(!s.shortcutSheetOpen);
      else if (action === "quick-capture") s.setCaptureOpen(!s.captureOpen);
      else if (action === "nav-back") void s.goBack();
      else if (action === "nav-forward") void s.goForward();
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
          {commentsOpen && <CommentsPanel />}
        </div>
      </div>
      {movePageOpen && <MovePageModal />}
      <CommandBar />
      <MruSwitcher />
      <Toast />
      <ShortcutSheet />
      <InboxPanel />
      <CaptureModal />
      <PeekLayer />
    </div>
  );
}
