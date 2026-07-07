import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../store/appStore";
import { notion } from "../lib/notionClient";
import { enqueue } from "../lib/queue";
import { pageEmoji, pageTitle } from "../lib/pageMeta";
import { topRecents } from "../lib/frecencyDb";
import { searchCachedPages } from "../lib/db";
import type { SearchHit } from "../lib/db";
import type { FrecencyEntry } from "../lib/frecencyDb";

/**
 * Cmd-T command bar (Phase 3): one input searches sidebar docs,
 * frecency-ranked recents, live Notion search (when authed), and app
 * actions — fuzzy-matched and merged into a single ranked list.
 */

interface Result {
  key: string;
  title: string;
  icon: string | null;
  source: "sidebar" | "recent" | "cached" | "notion" | "action";
  hint?: string;
  keyHint?: string;
  subtitle?: string;
  pageId?: string;
  run?: () => void;
}

/**
 * Raycast-style aliases: strict-prefix match, always ranked first —
 * predictability over cleverness. Stored locally, keyed to a page.
 */
interface Alias {
  pageId: string;
  title: string;
  icon: string | null;
}

function getAliases(): Record<string, Alias> {
  try {
    return JSON.parse(localStorage.getItem("hive-aliases") ?? "{}");
  } catch {
    return {};
  }
}

function saveAlias(word: string, alias: Alias) {
  const all = getAliases();
  all[word.toLowerCase()] = alias;
  localStorage.setItem("hive-aliases", JSON.stringify(all));
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

/** App actions surfaced through the same input; keyHint teaches the shortcut. */
function useActions(): Result[] {
  const store = useAppStore;
  const pageId = useAppStore((s) => s.pageId);
  const spaces = useAppStore((s) => s.spaces);
  const pageOpen = Boolean(pageId);
  const realPage = pageOpen && !pageId?.startsWith("00000000-0000");

  const action = (
    title: string,
    icon: string,
    run: () => void,
    keyHint?: string,
  ): Result => ({
    key: `action-${title}`,
    title,
    icon,
    source: "action",
    hint: "action",
    keyHint,
    run,
  });

  const actions: Result[] = [
    action("New Space", "✨", () => void store.getState().createSpace()),
    action("New folder", "📁", () => void store.getState().createFolder()),
    action("Toggle sidebar", "◧", () => store.getState().toggleSidebar(), "⌘\\"),
    action("Focus mode", "🎯", () => store.getState().toggleFocusMode(), "⌘⇧F"),
    action("Theme: light", "☀️", () => void import("../lib/theme").then((m) => m.setThemePref("light"))),
    action("Theme: dark", "🌙", () => void import("../lib/theme").then((m) => m.setThemePref("dark"))),
    action("Theme: system", "🖥", () => void import("../lib/theme").then((m) => m.setThemePref("system"))),
    ...spaces.map((space, i) =>
      action(
        `Switch to Space: ${space.name}`,
        space.icon ?? "⬡",
        () => void store.getState().switchSpace(space.id),
        i < 9 ? `⌃${i + 1}` : undefined,
      ),
    ),
  ];
  if (pageOpen) {
    actions.push(
      action("Pin current doc", "📌", () => void pinCurrent("pinned")),
      action("Favorite current doc", "★", () => void pinCurrent("favorite")),
    );
  }
  if (realPage) {
    actions.push(
      action("Open current doc in Notion", "↗", () => {
        const id = store.getState().pageId!.replace(/-/g, "");
        const url = `https://www.notion.so/${id}`;
        void import("@tauri-apps/plugin-opener")
          .then((m) => m.openUrl(url))
          .catch(() => window.open(url, "_blank"));
      }),
    );
  }
  return actions;
}

async function pinCurrent(tier: "pinned" | "favorite") {
  const s = useAppStore.getState();
  if (!s.pageId) return;
  const item = s.sidebarItems.find((i) => i.notionPageId === s.pageId);
  if (item) await s.setItemTier(item.id, tier);
}

export function CommandBar() {
  const open = useAppStore((s) => s.commandBarOpen);
  const setOpen = useAppStore((s) => s.setCommandBarOpen);
  const sidebarItems = useAppStore((s) => s.sidebarItems);
  const openPage = useAppStore((s) => s.openPage);
  const authReady = useAppStore((s) => s.auth.status === "ready");
  const actions = useActions();

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [remote, setRemote] = useState<Result[]>([]);
  const [recents, setRecents] = useState<FrecencyEntry[]>([]);
  const [cached, setCached] = useState<SearchHit[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const queryRef = useRef("");
  queryRef.current = query;

  useEffect(() => {
    if (open) {
      setQuery("");
      setRemote([]);
      setSelected(0);
      requestAnimationFrame(() => inputRef.current?.focus());
      topRecents(30).then(setRecents).catch(() => setRecents([]));
    }
  }, [open]);

  // Local full-text search over cached pages — instant, zero API cost.
  useEffect(() => {
    if (!open || query.trim().length < 2) {
      setCached([]);
      return;
    }
    const t = setTimeout(() => {
      void searchCachedPages(query).then(setCached);
    }, 120);
    return () => clearTimeout(t);
  }, [query, open]);

  // Live Notion search, debounced, through the queue.
  useEffect(() => {
    if (!open || !authReady || query.trim().length < 2) {
      setRemote([]);
      return;
    }
    clearTimeout(debounceRef.current);
    const issuedFor = query;
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
          if (queryRef.current !== issuedFor) return; // stale response
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
    const scored: { result: Result; score: number }[] = [];
    const q = query.trim().toLowerCase();

    // Aliases first: strict prefix, deterministic, huge score.
    if (q) {
      for (const [word, alias] of Object.entries(getAliases())) {
        if (word.startsWith(q)) {
          scored.push({
            score: 10_000,
            result: {
              key: `alias-${word}`,
              pageId: alias.pageId,
              title: alias.title,
              icon: alias.icon,
              source: "sidebar",
              hint: `alias: ${word}`,
            },
          });
        }
      }
    }

    // "alias xyz" while a doc is open → setter action.
    const aliasMatch = /^alias\s+(\S+)$/.exec(q);
    const state = useAppStore.getState();
    if (aliasMatch && state.pageId && state.page) {
      const word = aliasMatch[1];
      scored.push({
        score: 20_000,
        result: {
          key: "action-set-alias",
          title: `Set alias “${word}” for current doc`,
          icon: "🔖",
          source: "action",
          hint: "action",
          run: () => {
            const s = useAppStore.getState();
            saveAlias(word, {
              pageId: s.pageId!,
              title: s.page ? pageTitle(s.page.page) : "Untitled",
              icon: s.page ? pageEmoji(s.page.page) : null,
            });
            s.showToast(`“${word}” now opens this doc`);
          },
        },
      });
    }

    for (const item of sidebarItems) {
      const score = fuzzyScore(query, item.titleCache);
      if (score === null) continue;
      scored.push({
        score: score + 2, // sidebar docs outrank equal-scoring recents
        result: {
          key: `local-${item.id}`,
          pageId: item.notionPageId,
          title: item.titleCache,
          icon: item.iconCache,
          source: "sidebar",
          hint: item.tier,
        },
      });
    }

    recents.forEach((entry, rank) => {
      const score = fuzzyScore(query, entry.titleCache);
      if (score === null) return;
      scored.push({
        score: score + 1 - rank * 0.05, // frecency order breaks ties
        result: {
          key: `recent-${entry.notionPageId}`,
          pageId: entry.notionPageId,
          title: entry.titleCache,
          icon: entry.iconCache,
          source: "recent",
          hint: "recent",
        },
      });
    });

    for (const a of actions) {
      // Actions surface only when searched for — docs own the empty state.
      if (!query) continue;
      const score = fuzzyScore(query, a.title);
      if (score === null) continue;
      scored.push({ score, result: a });
    }

    for (const hit of cached) {
      // Body-matched: surface even when the title doesn't fuzzy-match.
      const score = (fuzzyScore(query, hit.title) ?? 0) + 1.5;
      scored.push({
        score,
        result: {
          key: `cached-${hit.pageId}`,
          pageId: hit.pageId,
          title: hit.title,
          icon: null,
          source: "cached",
          hint: "cached",
          subtitle: hit.snippet,
        },
      });
    }

    for (const r of remote) {
      const score = fuzzyScore(query, r.title) ?? 0;
      scored.push({ score, result: r });
    }

    const seen = new Set<string>();
    const merged: Result[] = [];
    for (const { result } of scored.sort((a, b) => b.score - a.score)) {
      const dedupeKey = result.pageId ?? result.key;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      merged.push(result);
    }
    return merged.slice(0, 12);
  }, [query, sidebarItems, remote, recents, cached, actions]);

  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(0, results.length - 1)));
  }, [results.length]);

  if (!open) return null;

  const pick = (r: Result | undefined) => {
    if (!r) return;
    setOpen(false);
    if (r.run) r.run();
    else if (r.pageId) void openPage(r.pageId);
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
              <span className="title">
                {r.title}
                {r.subtitle && <span className="subtitle"> — {r.subtitle}</span>}
              </span>
              {r.keyHint ? (
                <kbd>{r.keyHint}</kbd>
              ) : (
                <span className="hint">
                  {r.source === "notion" ? "Notion" : r.hint}
                </span>
              )}
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
