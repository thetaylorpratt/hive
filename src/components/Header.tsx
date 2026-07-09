import {
  ArrowLeft,
  ArrowRight,
  ChatCircle,
  DotsThree,
  MagnifyingGlass,
  Sidebar as SidebarIcon,
} from "@phosphor-icons/react";
import { useState, useSyncExternalStore } from "react";
import { PageMenu } from "./PageMenu";
import { useAppStore } from "../store/appStore";
import { pageTitle } from "../lib/pageMeta";
import { Glyph } from "../lib/iconSets";
import { pendingWriteCount, subscribePending } from "../lib/offlineWrites";

/**
 * Header v2 (post-ADR-001): breadcrumb navigation instead of the Phase-1
 * paste-a-URL input and render-vs-embed toggle. URL pasting lives in ⌘T
 * (paste a link there and an "Open page from link" row appears); the
 * embedded window survives as a palette action.
 */

function AuthChip() {
  const auth = useAppStore((s) => s.auth);
  const styles: Record<string, { bg: string; fg: string; label: string }> = {
    checking: {
      bg: "var(--hive-color-bg-subtle)",
      fg: "var(--hive-color-fg-secondary)",
      label: "Checking auth…",
    },
    ready: {
      bg: "var(--hive-color-success-bg)",
      fg: "var(--hive-color-success-fg)",
      label: `Connected${auth.userName ? ` · ${auth.userName}` : ""}`,
    },
    "missing-token": {
      bg: "var(--hive-color-warning-bg)",
      fg: "var(--hive-color-warning-fg)",
      label: "No token",
    },
    error: {
      bg: "var(--hive-color-critical-bg)",
      fg: "var(--hive-color-critical-fg)",
      label: "Auth failed",
    },
  };
  const s = styles[auth.status];
  return (
    <span className="hive-auth-chip" title={auth.message} style={{ background: s.bg, color: s.fg }}>
      {s.label}
    </span>
  );
}

/** Amber pill for unsynced offline edits — visible only while any are queued. */
function UnsyncedChip() {
  const count = useSyncExternalStore(subscribePending, pendingWriteCount, pendingWriteCount);
  if (count === 0) return null;
  return (
    <span
      className="hive-unsynced-chip"
      title="Edits made offline — they'll sync automatically when you're back online."
    >
      ● {count} unsynced
    </span>
  );
}

function Breadcrumbs() {
  const breadcrumbs = useAppStore((s) => s.breadcrumbs);
  const page = useAppStore((s) => s.page);
  const searchView = useAppStore((s) => s.searchView);
  const openPage = useAppStore((s) => s.openPage);

  if (searchView) {
    return <nav className="hive-crumbs"><span className="current">Search</span></nav>;
  }
  if (!page) return <nav className="hive-crumbs" />;

  return (
    <nav className="hive-crumbs">
      {breadcrumbs.map((c) => (
        <span key={c.pageId} className="crumb-seg">
          <button
            className="crumb"
            disabled={c.isDatabase}
            title={c.isDatabase ? `${c.title} (database — open in Notion)` : c.title}
            onClick={() => !c.isDatabase && void openPage(c.pageId)}
          >
            {c.icon && (
              <span className="ci">
                <Glyph icon={c.icon} size={13} />
              </span>
            )}
            {c.title}
          </button>
          <span className="sep">/</span>
        </span>
      ))}
      <span className="current" title={pageTitle(page.page)}>
        {pageTitle(page.page)}
      </span>
    </nav>
  );
}

export function Header() {
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const sidebarVisible = useAppStore((s) => s.sidebarVisible);
  const setCommandBarOpen = useAppStore((s) => s.setCommandBarOpen);
  const goBack = useAppStore((s) => s.goBack);
  const goForward = useAppStore((s) => s.goForward);
  const pageId = useAppStore((s) => s.pageId);
  // re-render on nav so the disabled states track history position
  useAppStore((s) => s.page);
  const canBack = useAppStore((s) => s.canGoBack)();
  const canFwd = useAppStore((s) => s.canGoForward)();
  const commentsOpen = useAppStore((s) => s.commentsOpen);
  const toggleComments = useAppStore((s) => s.toggleComments);
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="hive-header">
      <button
        className="hive-sidebar-toggle"
        title={`${sidebarVisible ? "Hide" : "Show"} sidebar (⌘\\)`}
        onClick={toggleSidebar}
      >
        <SidebarIcon size={17} weight="bold" />
      </button>
      <button
        className="hive-nav-btn"
        disabled={!canBack}
        title="Back (⌘[)"
        onClick={() => void goBack()}
      >
        <ArrowLeft size={16} weight="bold" />
      </button>
      <button
        className="hive-nav-btn"
        disabled={!canFwd}
        title="Forward (⌘])"
        onClick={() => void goForward()}
      >
        <ArrowRight size={16} weight="bold" />
      </button>
      <span className="hive-logo">🐝</span>
      <Breadcrumbs />
      <div style={{ flex: 1 }} />
      <button
        className="hive-search-pill"
        onClick={() => setCommandBarOpen(true)}
        title="Search docs, Notion, and actions"
      >
        <MagnifyingGlass size={14} weight="bold" /> Search <kbd>⌘T</kbd>
      </button>
      {pageId && (
        <button
          className={`hive-nav-btn${commentsOpen ? " active" : ""}`}
          title="Comments"
          onClick={toggleComments}
        >
          <ChatCircle size={17} weight="bold" />
        </button>
      )}
      {pageId && (
        <span style={{ position: "relative" }}>
          <button
            className="hive-nav-btn"
            title="Page options"
            onClick={() => setMenuOpen(!menuOpen)}
          >
            <DotsThree size={20} weight="bold" />
          </button>
          {menuOpen && <PageMenu onClose={() => setMenuOpen(false)} />}
        </span>
      )}
      <UnsyncedChip />
      <AuthChip />
    </header>
  );
}
