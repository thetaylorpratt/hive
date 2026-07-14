import { useEffect, useState } from "react";
import { useAppStore } from "../store/appStore";
import { workspaceUsers } from "../lib/users";
import type { DiffEntry } from "../lib/blockDiff";
import "../styles/diffbanner.css";

/**
 * "Changed since your last copy" — v2 (POLISH_OPPORTUNITIES.md follow-up).
 * Replaces the old truncated-excerpt banner: real per-block entries, author
 * names where resolvable, and a "Show in doc" toggle that turns on inline
 * track-changes-style highlights in BlockRenderer instead of forcing you to
 * read a wall of snippets here. Own edits (either identity — see
 * appStore's init + blockDiff.ts/attention.ts) never appear: this banner
 * only exists when someone ELSE changed something.
 */

const FLASH_CLASS = "hive-comment-anchor-flash";
const FLASH_MS = 1600;

function flashBlock(blockId: string) {
  const escaped = CSS.escape(blockId);
  const el =
    document.querySelector<HTMLElement>(`[data-bid="${escaped}"]`) ??
    document.querySelector<HTMLElement>(`[data-block-id="${escaped}"]`);
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.add(FLASH_CLASS);
  setTimeout(() => el.classList.remove(FLASH_CLASS), FLASH_MS);
}

function kindIcon(kind: DiffEntry["kind"]): string {
  if (kind === "added") return "+";
  if (kind === "removed") return "−";
  return "±";
}

export function DiffBanner() {
  const pageId = useAppStore((s) => s.pageId);
  const pageDiffs = useAppStore((s) => s.pageDiffs);
  const dismissDiff = useAppStore((s) => s.dismissDiff);
  const showDiffHighlights = useAppStore((s) => s.showDiffHighlights);
  const setShowDiffHighlights = useAppStore((s) => s.setShowDiffHighlights);
  const [names, setNames] = useState<Record<string, string>>({});

  const diff = pageId ? pageDiffs[pageId] : undefined;
  const entries = diff?.entries ?? [];

  // A diff with no entries left (e.g. everything in it turned out to be the
  // reader's own edit) has nothing to show — clear it rather than leave a
  // phantom entry sitting in the digest/unread bookkeeping.
  useEffect(() => {
    if (pageId && diff && entries.length === 0) dismissDiff(pageId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId, diff]);

  useEffect(() => {
    if (!entries.length) return;
    let cancelled = false;
    workspaceUsers()
      .then((users) => {
        if (cancelled) return;
        const map: Record<string, string> = {};
        for (const u of users) map[u.id] = u.name;
        setNames(map);
      })
      .catch(() => {
        /* best-effort — rows just render without author attribution */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId, entries.length]);

  if (!pageId || !diff || entries.length === 0) return null;

  const byAuthor = new Map<string, number>();
  for (const e of entries) {
    const label = e.editedBy ? names[e.editedBy] : null;
    if (!label) continue;
    byAuthor.set(label, (byAuthor.get(label) ?? 0) + 1);
  }
  const authorSummary = [...byAuthor.entries()].map(([name, n]) => `${n} by ${name}`).join(", ");

  const total = entries.length;
  const rows = entries.slice(0, 3);

  return (
    <div className="hive-diffbanner">
      <div className="hive-diffbanner-summary">
        <span className="hive-diffbanner-count">
          {total} change{total === 1 ? "" : "s"} by others since your last visit
          {authorSummary && <span className="hive-diffbanner-authors"> ({authorSummary})</span>}
        </span>
        <div className="hive-diffbanner-actions">
          <button
            type="button"
            className="hive-diffbanner-toggle"
            onClick={() => setShowDiffHighlights(!showDiffHighlights)}
          >
            {showDiffHighlights ? "Hide" : "Show in doc"}
          </button>
          <button
            type="button"
            className="hive-diffbanner-dismiss"
            title="Dismiss"
            onClick={() => {
              dismissDiff(pageId);
              setShowDiffHighlights(false);
            }}
          >
            ×
          </button>
        </div>
      </div>
      <ul className="hive-diffbanner-rows">
        {rows.map((e) => (
          <li
            key={e.blockId}
            className={`hive-diffbanner-row kind-${e.kind}`}
            onClick={() => flashBlock(e.blockId)}
          >
            <span className={`hive-diffbanner-icon kind-${e.kind}`}>{kindIcon(e.kind)}</span>
            <span className="hive-diffbanner-text">
              {e.kind === "removed" ? (
                <span className="hive-diffbanner-struck">{e.oldText || "(empty block)"}</span>
              ) : (
                e.newText || "(empty block)"
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
