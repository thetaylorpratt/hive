import { useEffect } from "react";
import { useAppStore } from "./store/appStore";
import { Header } from "./components/Header";
import { BlockList } from "./components/BlockRenderer";
import type { RichTextItem } from "./lib/types";

function pageTitle(page: Record<string, unknown>): string {
  const properties = page.properties as
    | Record<string, { type: string; title?: RichTextItem[] }>
    | undefined;
  if (properties) {
    for (const prop of Object.values(properties)) {
      if (prop.type === "title" && prop.title) {
        return prop.title.map((t) => t.plain_text).join("") || "Untitled";
      }
    }
  }
  return "Untitled";
}

function pageEmoji(page: Record<string, unknown>): string | null {
  const icon = page.icon as { type?: string; emoji?: string } | null;
  return icon?.type === "emoji" && icon.emoji ? icon.emoji : null;
}

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

  // A loaded page (including the demo fixture) always wins over auth notices.
  if (page && pageStatus !== "error" && pageStatus !== "loading") {
    const emoji = pageEmoji(page.page);
    return (
      <article className="hive-doc">
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
          {pageError && (
            <span style={{ color: "var(--hive-color-critical-fg)" }}>
              {" "}
              · {pageError}
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
    <Notice tone="neutral" title="Phase 1 — the pipe">
      <p>
        Paste a Notion page ID or URL above to render it. Pages are cached in
        SQLite and served cache-first on the next open.
      </p>
      <DemoButton />
    </Notice>
  );
}

export default function App() {
  const init = useAppStore((s) => s.init);
  useEffect(() => {
    void init();
  }, [init]);

  return (
    <div className="flex h-full flex-col">
      <Header />
      <main className="flex-1 overflow-y-auto">
        <Content />
      </main>
    </div>
  );
}
