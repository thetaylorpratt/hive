import { useEffect, useState } from "react";
import {
  MagnifyingGlass,
  PencilSimpleLine,
  Bell,
  Lightbulb,
  FileText,
  ArrowRight,
} from "@phosphor-icons/react";
import { useAppStore } from "../store/appStore";
import { Glyph } from "../lib/iconSets";
import { topRecents } from "../lib/frecencyDb";
import type { FrecencyEntry } from "../lib/frecencyDb";

/**
 * The start page: quick actions, your recent docs, and a rotating tip that
 * teaches one Hive behavior at a time (Lattice-styled, Phosphor icons —
 * the same set Lattice wraps).
 */

const TIPS: { keys?: string; text: string }[] = [
  { keys: "⌘T", text: "Search everything — titles live from Notion, full document content from Hive's local index." },
  { keys: "⌘⌥N", text: "Quick capture: jot a note, ⌘↵ files it as a real Notion page under 🐝 Hive Captures." },
  { text: "Hover any sidebar doc for a peek — click the preview to open it fully." },
  { keys: "⌃Tab", text: "Cycle your most recent docs, Arc-style. Hold ⌃, tap Tab, release to open." },
  { text: "Two-finger swipe on the sidebar switches Spaces. ⌃1–9 jumps directly." },
  { keys: "# − []", text: "Notion markdown works while typing: # heading, - bullet, [] to-do, > toggle, ``` code." },
  { keys: "/", text: "Slash on an empty line opens the block menu — tables, callouts, toggles, dividers." },
  { keys: ":bee:", text: "Type a colon + name for emoji autocomplete, exactly like Notion and Slack." },
  { text: "Select any text for the formatting toolbar — 💬 posts a comment to the page, quoting your selection." },
  { keys: "⌘⇧F", text: "Focus mode dims everything but the block you're writing in, with typewriter scrolling." },
  { text: "Drag docs from Today to Pinned to keep them; drop onto folders to file them. Today auto-archives in 24h." },
  { keys: "alias", text: "Type “alias mtg” in ⌘T to bind a word to the current doc — strict-prefix, always ranks first." },
  { text: "Right-click a Space dot to give it an emoji icon and accent color." },
  { text: "A blue dot means the doc changed since you last read it — open it to see exactly what changed." },
  { keys: "⌘D", text: "Duplicate the current block. ⌘⌥1–8 converts block types. Tab indents list items." },
  { keys: "?", text: "See every keyboard shortcut on one sheet." },
  { text: "Click a Notion link anywhere on your Mac — it opens here. Everything else passes through to your browser." },
];

export function HomeScreen() {
  const setCommandBarOpen = useAppStore((s) => s.setCommandBarOpen);
  const setCaptureOpen = useAppStore((s) => s.setCaptureOpen);
  const setInboxOpen = useAppStore((s) => s.setInboxOpen);
  const openDemo = useAppStore((s) => s.openDemo);
  const openPage = useAppStore((s) => s.openPage);
  const inboxCount = useAppStore((s) => s.inbox.length);

  const [recents, setRecents] = useState<FrecencyEntry[]>([]);
  const [tip, setTip] = useState(() => Math.floor(Math.random() * TIPS.length));
  const [fading, setFading] = useState(false);

  useEffect(() => {
    topRecents(6).then(setRecents).catch(() => setRecents([]));
  }, []);

  useEffect(() => {
    const t = setInterval(() => {
      setFading(true);
      setTimeout(() => {
        setTip((i) => (i + 1) % TIPS.length);
        setFading(false);
      }, 250);
    }, 8000);
    return () => clearInterval(t);
  }, []);

  const current = TIPS[tip];

  return (
    <div className="hive-home hive-page-in">
      <div className="hero">
        <span className="bee">🐝</span>
        <h1>Hive</h1>
        <p>Your Notion, organized your way.</p>
      </div>

      <div className="actions">
        <button className="card" onClick={() => setCommandBarOpen(true)}>
          <MagnifyingGlass size={20} weight="bold" />
          <span className="t">Search</span>
          <kbd>⌘T</kbd>
        </button>
        <button className="card" onClick={() => setCaptureOpen(true)}>
          <PencilSimpleLine size={20} weight="bold" />
          <span className="t">Capture</span>
          <kbd>⌘⌥N</kbd>
        </button>
        <button className="card" onClick={() => setInboxOpen(true)}>
          <Bell size={20} weight="bold" />
          <span className="t">Inbox</span>
          {inboxCount > 0 && <span className="badge">{inboxCount}</span>}
        </button>
      </div>

      {recents.length > 0 && (
        <div className="recents">
          <div className="label">Pick up where you left off</div>
          {recents.map((r) => (
            <button
              key={r.notionPageId}
              className="recent"
              onClick={() => void openPage(r.notionPageId)}
            >
              <span className="icon">
                {r.iconCache ? <Glyph icon={r.iconCache} size={15} /> : <FileText size={15} />}
              </span>
              <span className="title">{r.titleCache}</span>
              <ArrowRight size={13} className="go" />
            </button>
          ))}
        </div>
      )}

      <div className={`tip${fading ? " fading" : ""}`}>
        <Lightbulb size={16} weight="fill" className="bulb" />
        <span>
          {current.keys && <kbd>{current.keys}</kbd>} {current.text}
        </span>
      </div>

      {recents.length === 0 && (
        <button className="demo-link" onClick={() => void openDemo()}>
          New here? Load the demo page to try everything →
        </button>
      )}
    </div>
  );
}
