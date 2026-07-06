import { useState } from "react";
import { useAppStore } from "../store/appStore";

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
    <span
      title={auth.message}
      style={{
        background: s.bg,
        color: s.fg,
        borderRadius: "var(--hive-radius)",
        padding: "3px 10px",
        fontSize: "0.75rem",
        fontWeight: 500,
        whiteSpace: "nowrap",
      }}
    >
      {s.label}
    </span>
  );
}

export function Header() {
  const [input, setInput] = useState("");
  const openPage = useAppStore((s) => s.openPage);
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const authReady = useAppStore((s) => s.auth.status === "ready");

  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const sidebarVisible = useAppStore((s) => s.sidebarVisible);

  return (
    <header
      className="flex items-center gap-3 px-4 py-2.5"
      style={{
        background: "var(--hive-color-bg-surface)",
        borderBottom: "1px solid var(--hive-color-border-subtle)",
      }}
    >
      <button
        className="hive-sidebar-toggle"
        title={`${sidebarVisible ? "Hide" : "Show"} sidebar (⌘\\)`}
        onClick={toggleSidebar}
      >
        ◧
      </button>
      <span className="font-semibold" style={{ letterSpacing: "-0.01em" }}>
        🐝 Hive
      </span>
      <form
        className="flex flex-1 gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (input.trim()) void openPage(input);
        }}
      >
        <input
          className="hive-input flex-1"
          placeholder="Paste a Notion page ID or URL…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={!authReady}
          spellCheck={false}
        />
        <button className="hive-btn" type="submit" disabled={!authReady || !input.trim()}>
          Open
        </button>
      </form>
      <div className="hive-segment" title="Render-vs-embed spike (Phase 1)">
        <button
          type="button"
          className={view === "native" ? "active" : ""}
          onClick={() => setView("native")}
        >
          Native
        </button>
        <button
          type="button"
          className={view === "embed" ? "active" : ""}
          onClick={() => setView("embed")}
        >
          Embedded
        </button>
      </div>
      <AuthChip />
    </header>
  );
}
