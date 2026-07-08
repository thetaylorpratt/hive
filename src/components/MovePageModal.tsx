import { useEffect, useRef, useState } from "react";
import { ArrowElbowDownRight, House } from "@phosphor-icons/react";
import { useAppStore } from "../store/appStore";
import { notion } from "../lib/notionClient";
import { enqueue } from "../lib/queue";
import { pageEmoji, pageTitle } from "../lib/pageMeta";
import { Glyph } from "../lib/iconSets";

/**
 * Move the current page to a new parent INSIDE Notion (not a Hive Space) —
 * real re-parenting via the personal MCP connection's move-pages tool.
 * Destinations come from API search, so they're pages Hive can still open.
 */
export function MovePageModal() {
  const pageId = useAppStore((s) => s.pageId);
  const mcpStatus = useAppStore((s) => s.mcpStatus);
  const movePageInNotion = useAppStore((s) => s.movePageInNotion);
  const setMovePageOpen = useAppStore((s) => s.setMovePageOpen);
  const connectPersonalNotion = useAppStore((s) => s.connectPersonalNotion);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<
    { id: string; title: string; icon: string | null }[]
  >([]);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const query = q.trim();
    const mine = ++seq.current;
    const t = setTimeout(() => {
      void (async () => {
        try {
          const resp = (await enqueue(() =>
            notion().search({
              query,
              page_size: 8,
              filter: { property: "object", value: "page" },
            }),
          )) as { results: Record<string, unknown>[] };
          if (seq.current !== mine) return;
          setResults(
            resp.results
              .filter((p) => (p.id as string) !== pageId)
              .map((p) => ({
                id: p.id as string,
                title: pageTitle(p),
                icon: pageEmoji(p),
              })),
          );
        } catch {
          if (seq.current === mine) setResults([]);
        }
      })();
    }, 250);
    return () => clearTimeout(t);
  }, [q, pageId]);

  const move = (parent: { pageId: string } | "workspace") => {
    if (busy) return;
    setBusy(true);
    void movePageInNotion(parent).finally(() => setBusy(false));
  };

  return (
    <div className="hive-modal-backdrop" onMouseDown={() => setMovePageOpen(false)}>
      <div className="hive-move-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="title">Move page to…</div>
        {mcpStatus !== "connected" ? (
          <div className="hint">
            Moving pages inside Notion needs your personal connection.
            <button
              className="hive-btn hive-btn-secondary"
              onClick={() => void connectPersonalNotion()}
            >
              Connect Notion
            </button>
          </div>
        ) : (
          <>
            <input
              className="hive-input"
              autoFocus
              placeholder="Search destination pages…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setMovePageOpen(false)}
            />
            <div className="rows">
              <button className="row" disabled={busy} onClick={() => move("workspace")}>
                <House size={15} />
                <span>My Private pages (workspace level)</span>
              </button>
              {results.map((r) => (
                <button
                  key={r.id}
                  className="row"
                  disabled={busy}
                  onClick={() => move({ pageId: r.id })}
                >
                  <ArrowElbowDownRight size={14} />
                  <span className="icon">{r.icon ? <Glyph icon={r.icon} /> : "📄"}</span>
                  <span className="t">{r.title}</span>
                </button>
              ))}
              {results.length === 0 && (
                <div className="none">No matching destinations (integration-visible pages only)</div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
