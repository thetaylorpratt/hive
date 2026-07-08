import { useState } from "react";
import { EMOJI } from "../lib/emoji";

/** Searchable emoji grid (space icons, page icons). */
export function EmojiPicker({
  onPick,
  onRemove,
  onClose,
}: {
  onPick: (emoji: string) => void;
  onRemove?: () => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const entries = Object.entries(EMOJI).filter(
    ([name]) => !q || name.includes(q.toLowerCase()),
  );
  // de-dupe aliases pointing at the same char
  const seen = new Set<string>();
  const unique = entries.filter(([, char]) =>
    seen.has(char) ? false : (seen.add(char), true),
  );

  return (
    <div className="hive-emoji-picker" onMouseDown={(e) => e.stopPropagation()}>
      <div className="row">
        <input
          className="hive-input"
          autoFocus
          placeholder="Search emoji… (⌃⌘Space for the full macOS picker)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "Enter" && unique[0]) onPick(unique[0][1]);
            // let a raw emoji paste/type pass straight through
            if (e.key.length > 1 && /\p{Emoji_Presentation}/u.test(e.key)) {
              onPick(e.key);
            }
          }}
          onInput={(e) => {
            const v = (e.target as HTMLInputElement).value;
            const m = v.match(/\p{Extended_Pictographic}/u);
            if (m) onPick(m[0]); // typed/pasted a literal emoji
          }}
        />
        {onRemove && (
          <button className="hive-btn hive-btn-secondary" onClick={onRemove}>
            Remove
          </button>
        )}
      </div>
      <div className="grid">
        {unique.slice(0, 96).map(([name, char]) => (
          <button key={name} title={`:${name}:`} onClick={() => onPick(char)}>
            {char}
          </button>
        ))}
        {unique.length === 0 && <div className="none">No matches</div>}
      </div>
    </div>
  );
}
