import { useState } from "react";
import { EMOJI } from "../lib/emoji";
import {
  NOTION_ICONS,
  NOTION_ICON_COLORS,
  PHOSPHOR_ICONS,
  notionIconUrl,
} from "../lib/iconSets";

// Swatch colors approximating Notion's icon tints (selector dots only —
// the icons themselves come pre-tinted from Notion's CDN).
const NOTION_COLOR_HEX: Record<string, string> = {
  gray: "#787774",
  lightgray: "#b9b9b7",
  brown: "#9f6b53",
  yellow: "#c29343",
  orange: "#d9730d",
  green: "#448361",
  blue: "#337ea9",
  purple: "#9065b0",
  pink: "#c14c8a",
  red: "#d44c47",
};

/**
 * Tabbed icon picker (space icons, page icons). The Emoji tab is always
 * present; `iconSet` adds an Icons tab — "phosphor" offers the Lattice set
 * (stored as "ph:Name", spaces), "notion" offers Notion's tintable CDN
 * icons (stored as the external URL, pages — native Notion renders the
 * same icon).
 */
export function EmojiPicker({
  onPick,
  onRemove,
  onClose,
  iconSet,
}: {
  onPick: (value: string) => void;
  onRemove?: () => void;
  onClose: () => void;
  iconSet?: "phosphor" | "notion";
}) {
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<"emoji" | "icons">("emoji");
  const [color, setColor] = useState("gray");

  const entries = Object.entries(EMOJI).filter(
    ([name]) => !q || name.includes(q.toLowerCase()),
  );
  // de-dupe aliases pointing at the same char
  const seen = new Set<string>();
  const unique = entries.filter(([, char]) =>
    seen.has(char) ? false : (seen.add(char), true),
  );

  const phosphorNames = Object.keys(PHOSPHOR_ICONS).filter(
    (n) => !q || n.toLowerCase().includes(q.toLowerCase()),
  );
  const notionSlugs = NOTION_ICONS.filter(
    (s) => !q || s.includes(q.toLowerCase()),
  );

  return (
    <div className="hive-emoji-picker" onMouseDown={(e) => e.stopPropagation()}>
      {iconSet && (
        <div className="tabs">
          <button
            className={tab === "emoji" ? "active" : ""}
            onClick={() => setTab("emoji")}
          >
            Emoji
          </button>
          <button
            className={tab === "icons" ? "active" : ""}
            onClick={() => setTab("icons")}
          >
            Icons
          </button>
        </div>
      )}
      <div className="row">
        <input
          className="hive-input"
          autoFocus
          placeholder={
            tab === "icons"
              ? "Filter icons…"
              : "Search emoji… (⌃⌘Space for the full macOS picker)"
          }
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "Enter" && tab === "emoji" && unique[0]) {
              onPick(unique[0][1]);
            }
            // let a raw emoji paste/type pass straight through
            if (e.key.length > 1 && /\p{Emoji_Presentation}/u.test(e.key)) {
              onPick(e.key);
            }
          }}
          onInput={(e) => {
            const v = (e.target as HTMLInputElement).value;
            const m = v.match(/\p{Extended_Pictographic}/u);
            if (m && tab === "emoji") onPick(m[0]); // typed/pasted a literal emoji
          }}
        />
        {onRemove && (
          <button className="hive-btn hive-btn-secondary" onClick={onRemove}>
            Remove
          </button>
        )}
      </div>
      {tab === "icons" && iconSet === "notion" && (
        <div className="colors">
          {NOTION_ICON_COLORS.map((c) => (
            <button
              key={c}
              className={`dot${c === color ? " active" : ""}`}
              title={c}
              style={{ background: NOTION_COLOR_HEX[c] }}
              onClick={() => setColor(c)}
            />
          ))}
        </div>
      )}
      {tab === "emoji" && (
        <div className="grid">
          {unique.slice(0, 96).map(([name, char]) => (
            <button key={name} title={`:${name}:`} onClick={() => onPick(char)}>
              {char}
            </button>
          ))}
          {unique.length === 0 && <div className="none">No matches</div>}
        </div>
      )}
      {tab === "icons" && iconSet === "phosphor" && (
        <div className="grid">
          {phosphorNames.map((name) => {
            const Component = PHOSPHOR_ICONS[name];
            return (
              <button
                key={name}
                title={name}
                onClick={() => onPick(`ph:${name}`)}
              >
                <Component size={18} />
              </button>
            );
          })}
          {phosphorNames.length === 0 && <div className="none">No matches</div>}
        </div>
      )}
      {tab === "icons" && iconSet === "notion" && (
        <div className="grid">
          {notionSlugs.map((slug) => (
            <button
              key={slug}
              title={slug}
              onClick={() => onPick(notionIconUrl(slug, color))}
            >
              <img src={notionIconUrl(slug, color)} alt={slug} loading="lazy" />
            </button>
          ))}
          {notionSlugs.length === 0 && <div className="none">No matches</div>}
        </div>
      )}
    </div>
  );
}
