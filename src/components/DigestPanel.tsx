import { useEffect, useState } from "react";
import { create } from "zustand";
import { useAppStore } from "../store/appStore";
import { buildDigest, type DigestEntry } from "../lib/digest";
import "../styles/digest.css";

/** Own tiny store so the orchestrator can toggle this panel (⌘T) without
 * DigestPanel needing a slot in appStore.ts. */
export const useDigestStore = create<{
  open: boolean;
  setOpen(v: boolean): void;
}>((set) => ({
  open: false,
  setOpen: (v) => set({ open: v }),
}));

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  const days = Math.floor(diff / DAY);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function diffSummary(entry: DigestEntry): string | null {
  const d = entry.diff;
  if (!d) return null;
  const parts: string[] = [];
  if (d.added) parts.push(`+${d.added} block${d.added === 1 ? "" : "s"}`);
  if (d.changed) parts.push(`${d.changed} edited`);
  if (d.removed) parts.push(`${d.removed} removed`);
  return parts.length ? parts.join(" · ") : null;
}

function truncate(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function DigestPanel() {
  const open = useDigestStore((s) => s.open);
  const setOpen = useDigestStore((s) => s.setOpen);
  const [entries, setEntries] = useState<DigestEntry[]>([]);

  // Refresh on every open, not on mount — this is a point-in-time briefing,
  // not a live-bound list.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void buildDigest().then((result) => {
      if (!cancelled) setEntries(result);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, setOpen]);

  if (!open) return null;

  return (
    <div className="hive-cmdbar-backdrop" onMouseDown={() => setOpen(false)}>
      <div className="hive-digest" onMouseDown={(e) => e.stopPropagation()}>
        <div className="hive-digest-head">
          <span className="title">
            While you were away
            {entries.length > 0 && <span className="count">{entries.length}</span>}
          </span>
          <button className="close" title="Close" onClick={() => setOpen(false)}>
            ×
          </button>
        </div>
        {entries.length === 0 && (
          <div className="hive-digest-empty">All caught up. 🐝</div>
        )}
        <div className="hive-digest-list">
          {entries.map((entry) => {
            const summary = diffSummary(entry);
            const snippets = entry.diff?.excerpts.slice(0, 2) ?? [];
            return (
              <button
                key={entry.pageId}
                className="hive-digest-row"
                onClick={() => {
                  setOpen(false);
                  void useAppStore.getState().openPage(entry.pageId);
                }}
              >
                <span className="icon">{entry.icon ?? "📄"}</span>
                <span className="body">
                  <span className="line1">
                    <span className="title">{entry.title}</span>
                    <span className="time">{relativeTime(entry.editedTime)}</span>
                  </span>
                  {summary && <span className="summary">{summary}</span>}
                  {snippets.map((s, i) => (
                    <span className="snippet" key={i}>
                      {truncate(s)}
                    </span>
                  ))}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
