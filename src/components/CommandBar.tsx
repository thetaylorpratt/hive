import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../store/appStore";
import { notion } from "../lib/notionClient";
import { enqueue } from "../lib/queue";
import { pageEmoji, pageTitle } from "../lib/pageMeta";

/**
 * Cmd-T command bar — Phase 2 minimal version: fuzzy-match local sidebar
 * items (recents first) and live Notion search when authed. Frecency ranking
 * and app actions land in Phase 3.
 */

interface Result {
  key: string;
  pageId: string;
  title: string;
  icon: string | null;
  source: "sidebar" | "notion";
  hint?: string;
}

/** Cheap subsequence fuzzy score: higher is better, null = no match. */
function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 0;
  let qi = 0;
  let score = 0;
  let streak = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi += 1;
      streak += 1;
      score += streak; // contiguity bonus
    } else {
      streak = 0;
    }
  }
  return qi === q.length ? score - t.length * 0.01 : null;
}

export function CommandBar() {
  const open = useAppStore((s) => s.commandBarOpen);
  const setOpen = useAppStore((s) => s.setCommandBarOpen);
  const sidebarItems = useAppStore((s) => s.sidebarItems);
  const openPage = useAppStore((s) => s.openPage);
  const authReady = useAppStore((s) => s.auth.status === "ready");

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [remote, setRemote] = useState<Result[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (open) {
      setQuery("");
      setRemote([]);
      setSelected(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Live Notion search, debounced, through the queue.
  useEffect(() => {
    if (!open || !authReady || query.trim().length < 2) {
      setRemote([]);
      return;
    }
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void (async () => {
        try {
          const resp = (await enqueue(() =>
            notion().search({
              query,
              page_size: 8,
              filter: { property: "object", value: "page" },
            }),
          )) as { results: Record<string, unknown>[] };
          setRemote(
            resp.results.map((p) => ({
              key: `notion-${p.id as string}`,
              pageId: p.id as string,
              title: pageTitle(p),
              icon: pageEmoji(p),
              source: "notion" as const,
            })),
          );
        } catch {
          setRemote([]); // search failures are non-fatal; local results remain
        }
      })();
    }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [query, open, authReady]);

  const results = useMemo<Result[]>(() => {
    const seen = new Set<string>();
    const localResults = sidebarItems
      .map((i) => ({
        item: i,
        score: fuzzyScore(query, i.titleCache),
      }))
      .filter((x): x is { item: (typeof sidebarItems)[number]; score: number } => x.score !== null)
      .sort(
        (a, b) =>
          b.score - a.score ||
          (b.item.lastOpenedAt ?? "").localeCompare(a.item.lastOpenedAt ?? ""),
      )
      .map(({ item }) => ({
        key: `local-${item.id}`,
        pageId: item.notionPageId,
        title: item.titleCache,
        icon: item.iconCache,
        source: "sidebar" as const,
        hint: item.tier,
      }));
    const merged: Result[] = [];
    for (const r of [...localResults, ...remote]) {
      if (seen.has(r.pageId)) continue;
      seen.add(r.pageId);
      merged.push(r);
    }
    return merged.slice(0, 12);
  }, [query, sidebarItems, remote]);

  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(0, results.length - 1)));
  }, [results.length]);

  if (!open) return null;

  const pick = (r: Result | undefined) => {
    if (!r) return;
    setOpen(false);
    void openPage(r.pageId);
  };

  return (
    <div className="hive-cmdbar-backdrop" onMouseDown={() => setOpen(false)}>
      <div className="hive-cmdbar" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="hive-cmdbar-input"
          placeholder={
            authReady
              ? "Search docs and Notion…"
              : "Search sidebar docs… (Notion search needs a token)"
          }
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSelected((s) => Math.min(s + 1, results.length - 1));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setSelected((s) => Math.max(s - 1, 0));
            }
            if (e.key === "Enter") pick(results[selected]);
          }}
        />
        <div className="hive-cmdbar-results">
          {results.map((r, i) => (
            <div
              key={r.key}
              className={`hive-cmdbar-row${i === selected ? " selected" : ""}`}
              onMouseEnter={() => setSelected(i)}
              onClick={() => pick(r)}
            >
              <span className="icon">{r.icon ?? "📄"}</span>
              <span className="title">{r.title}</span>
              <span className="hint">
                {r.source === "notion" ? "Notion" : r.hint}
              </span>
            </div>
          ))}
          {results.length === 0 && (
            <div className="hive-cmdbar-empty">
              {query ? "No matches" : "Recent docs appear here"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
