import { useEffect, useState } from "react";
import { useAppStore } from "../store/appStore";
import { loadCached } from "../lib/fetchPage";
import { pageEmoji, pageTitle } from "../lib/pageMeta";
import { Glyph } from "../lib/iconSets";
import { BlockList } from "./BlockRenderer";
import type { PageData } from "../lib/types";

/**
 * Arc-style peek: hover a sidebar row to preview the cached copy without
 * navigating. Click anywhere in the panel to promote to a full open; Esc
 * dismisses. Cache-only by design — a page you've never opened shows a hint
 * instead of spending API budget (hover prefetch is a later, token-gated
 * upgrade).
 */
export function PeekLayer() {
  const peek = useAppStore((s) => s.peek);
  const holdPeek = useAppStore((s) => s.holdPeek);
  const releasePeek = useAppStore((s) => s.releasePeek);
  const closePeek = useAppStore((s) => s.closePeek);
  const openPage = useAppStore((s) => s.openPage);
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const [data, setData] = useState<PageData | null>(null);
  const [miss, setMiss] = useState(false);

  useEffect(() => {
    if (!peek) return;
    setData(null);
    setMiss(false);
    let alive = true;
    void (async () => {
      let cached: PageData | null = null;
      try {
        cached = await loadCached(peek.pageId);
      } catch {
        /* no SQLite — fall through */
      }
      // The currently-open page is previewable even when the cache isn't.
      if (!cached) {
        const s = useAppStore.getState();
        if (s.pageId === peek.pageId && s.page) cached = s.page;
      }
      if (!alive) return;
      if (cached) setData(cached);
      else setMiss(true);
    })();
    return () => {
      alive = false;
    };
  }, [peek]);

  useEffect(() => {
    if (!peek) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePeek();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [peek, closePeek]);

  if (!peek) return null;

  const top = Math.min(
    Math.max(peek.anchorY - 60, 52),
    window.innerHeight - 460,
  );

  return (
    <div
      className="hive-peek"
      style={{ left: sidebarWidth + 14, top }}
      onMouseEnter={holdPeek}
      onMouseLeave={releasePeek}
      onClick={() => {
        closePeek();
        void openPage(peek.pageId);
      }}
      title="Click to open"
    >
      {data ? (
        <>
          <div className="hive-peek-title">
            {pageEmoji(data.page) && (
              <span style={{ marginRight: "0.3em" }}>
                <Glyph icon={pageEmoji(data.page)} />
              </span>
            )}
            {pageTitle(data.page)}
          </div>
          <div className="hive-peek-body">
            <BlockList blocks={data.blocks.slice(0, 30)} />
          </div>
          <div className="hive-peek-fade" />
        </>
      ) : (
        <div className="hive-peek-miss">
          {miss ? "No cached copy yet — open it once to enable peek." : "…"}
        </div>
      )}
    </div>
  );
}
