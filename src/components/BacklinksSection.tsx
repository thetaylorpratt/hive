import { useEffect, useState } from "react";
import { findBacklinks, type Backlink } from "../lib/backlinks";
import { useAppStore } from "../store/appStore";
import { Glyph } from "../lib/iconSets";
import "../styles/backlinks.css";

/**
 * "Linked from" — other cached pages whose content references this one,
 * computed offline from the local SQLite cache (see lib/backlinks.ts).
 * Renders nothing when there are no backlinks: zero visual cost on pages
 * nothing links to.
 */
export function BacklinksSection({ pageId }: { pageId: string }) {
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setExpanded(false);
    findBacklinks(pageId).then((hits) => {
      if (!cancelled) setBacklinks(hits);
    });
    return () => {
      cancelled = true;
    };
  }, [pageId]);

  if (backlinks.length === 0) return null;

  return (
    <div className="hive-backlinks">
      <button
        type="button"
        className="hive-backlinks-toggle"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className={`chevron ${expanded ? "open" : ""}`}>▸</span>
        <span>
          ↩ Linked from {backlinks.length} page{backlinks.length === 1 ? "" : "s"}
        </span>
      </button>
      {expanded && (
        <div className="hive-backlinks-list">
          {backlinks.map((b) => (
            <div
              key={b.pageId}
              className="hive-backlinks-row"
              onClick={() => useAppStore.getState().openPage(b.pageId)}
            >
              <span className="icon">{b.icon ? <Glyph icon={b.icon} size={14} /> : "📄"}</span>
              <span className="title">{b.title}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
