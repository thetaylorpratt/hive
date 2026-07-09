import { useEffect, useState } from "react";
import type { ComponentType } from "react";
import {
  Lightning,
  SquaresFour,
  Compass,
  Lightbulb,
  FileText,
  ArrowRight,
} from "@phosphor-icons/react";
import { useAppStore } from "../store/appStore";
import { Glyph } from "../lib/iconSets";
import { topRecents } from "../lib/frecencyDb";
import type { FrecencyEntry } from "../lib/frecencyDb";
import "../styles/home.css";

/**
 * The start page — the pitch. Three things Notion's own app/browser cannot
 * do (instant local cache, your-own organization, browser-level link
 * handling), a keyboard cheat-sheet, your recents, and a rotating tip that
 * teaches one Hive behavior at a time (Lattice-styled, Phosphor icons — the
 * same set Lattice wraps).
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

const DIFFERENTIATORS: {
  icon: ComponentType<{ size?: number; weight?: "regular" | "bold" | "fill" }>;
  title: string;
  body: string;
}[] = [
  {
    icon: Lightning,
    title: "Instant everything",
    body: "Pages open from local cache in milliseconds — then refresh live. No spinners.",
  },
  {
    icon: SquaresFour,
    title: "Your spaces, your rules",
    body: "Pin, group, and organize the team wiki privately. Nobody else's sidebar changes.",
  },
  {
    icon: Compass,
    title: "It's your browser",
    body: "Notion links from anywhere open here. Everything else goes to Arc. Comments post as you.",
  },
];

const SHORTCUTS: { keys: string; label: string }[] = [
  { keys: "⌘T", label: "search" },
  { keys: "⌘⌥N", label: "capture" },
  { keys: "⌃Tab", label: "switch" },
  { keys: "⌘\\", label: "sidebar" },
  { keys: "⌘⇧F", label: "focus" },
];

/** A very low-contrast honeycomb lattice, built once, tiled behind the hero. */
function buildHoneycomb(cols: number, rows: number, r: number) {
  const dx = r * 1.5;
  const dy = r * Math.sqrt(3);
  const angles = [0, 60, 120, 180, 240, 300];
  let d = "";
  for (let col = 0; col < cols; col++) {
    for (let row = 0; row < rows; row++) {
      const cx = col * dx;
      const cy = row * dy + (col % 2 === 1 ? dy / 2 : 0);
      const pts = angles.map((deg) => {
        const rad = (Math.PI / 180) * deg;
        return `${(cx + r * Math.cos(rad)).toFixed(1)},${(cy + r * Math.sin(rad)).toFixed(1)}`;
      });
      d += `M${pts[0]} L${pts[1]} L${pts[2]} L${pts[3]} L${pts[4]} L${pts[5]} Z `;
    }
  }
  const width = (cols - 1) * dx + r * 2;
  const height = rows * dy + dy;
  return { d: d.trim(), width, height };
}

const HONEYCOMB = buildHoneycomb(16, 7, 17);

export function HomeScreen() {
  const openDemo = useAppStore((s) => s.openDemo);
  const openPage = useAppStore((s) => s.openPage);

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
    <div className="hh hive-page-in">
      <section className="hh-hero">
        <svg
          className="hh-hex-bg"
          viewBox={`0 0 ${HONEYCOMB.width} ${HONEYCOMB.height}`}
          preserveAspectRatio="xMidYMid slice"
          aria-hidden="true"
          focusable="false"
        >
          <path d={HONEYCOMB.d} />
        </svg>
        <div className="hh-hero-content">
          <div className="hh-wordmark">
            <span className="hh-bee" aria-hidden="true">🐝</span>
            <h1 className="hh-word">Hive</h1>
          </div>
          <p className="hh-tagline">Your Notion, at the speed of thought.</p>
        </div>
      </section>

      <section className="hh-diffs" aria-label="Why Hive">
        {DIFFERENTIATORS.map(({ icon: Icon, title, body }) => (
          <div className="hh-diff-card" key={title}>
            <Icon size={20} weight="bold" />
            <h2>{title}</h2>
            <p>{body}</p>
          </div>
        ))}
      </section>

      <div className="hh-shortcuts" aria-label="Keyboard shortcuts">
        {SHORTCUTS.map((s, i) => (
          <span className="hh-shortcut" key={s.keys}>
            {i > 0 && <span className="hh-dot">·</span>}
            <kbd>{s.keys}</kbd> {s.label}
          </span>
        ))}
      </div>

      <div className={`hh-tip${fading ? " fading" : ""}`}>
        <Lightbulb size={14} weight="fill" className="hh-tip-bulb" />
        <span>
          {current.keys && <kbd>{current.keys}</kbd>} {current.text}
        </span>
      </div>

      {recents.length > 0 && (
        <section className="hh-recents">
          <div className="hh-section-label">Pick up where you left off</div>
          <div className="hh-recents-grid">
            {recents.map((r) => (
              <button
                key={r.notionPageId}
                className="hh-recent"
                onClick={() => void openPage(r.notionPageId)}
              >
                <span className="hh-recent-icon">
                  {r.iconCache ? <Glyph icon={r.iconCache} size={16} /> : <FileText size={16} />}
                </span>
                <span className="hh-recent-title">{r.titleCache}</span>
                <ArrowRight size={13} className="hh-recent-go" />
              </button>
            ))}
          </div>
        </section>
      )}

      {recents.length === 0 && (
        <button className="hh-demo-link" onClick={() => void openDemo()}>
          New here? Load the demo page to try everything →
        </button>
      )}
    </div>
  );
}
