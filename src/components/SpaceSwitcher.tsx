import { useEffect, useRef, useState } from "react";
import { useAppStore, PRIVATE_SPACE_ID } from "../store/appStore";
import { EmojiPicker } from "./EmojiPicker";
import { Glyph } from "../lib/iconSets";
import { SPACE_ACCENTS } from "../lib/orgDb";
import type { Space } from "../lib/orgDb";

/**
 * Arc-style Space switcher, docked at the bottom of the sidebar: one icon
 * per Space (assignable emoji, falling back to the name's initial), a "+",
 * and a right-click (or double-click) editor for icon / name / accent.
 */

function SpaceEditor({ space, onClose }: { space: Space; onClose: () => void }) {
  const updateSpace = useAppStore((s) => s.updateSpace);
  const [name, setName] = useState(space.name);
  const [icon, setIcon] = useState(space.icon ?? "");
  const ref = useRef<HTMLDivElement>(null);

  const commit = () => {
    void updateSpace(space.id, { name, icon: icon || null });
  };
  const commitRef = useRef(commit);
  commitRef.current = commit;

  useEffect(() => {
    // Click-away saves rather than discards.
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        commitRef.current();
        onClose();
      }
    };
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [onClose]);

  const [pickerOpen, setPickerOpen] = useState(false);
  return (
    <div className="hive-space-editor" ref={ref}>
      <div className="row">
        <button
          className="hive-input icon-input"
          title="Space icon"
          onClick={() => setPickerOpen(!pickerOpen)}
        >
          {icon ? <Glyph icon={icon} size={17} /> : "🐝"}
        </button>
        <input
          className="hive-input flex-1"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commit();
              onClose();
            }
            if (e.key === "Escape") onClose();
          }}
        />
      </div>
      {pickerOpen && (
        <EmojiPicker
          iconSet="phosphor"
          onPick={(char) => {
            setIcon(char);
            setPickerOpen(false);
            void updateSpace(space.id, { name, icon: char });
          }}
          onRemove={() => {
            setIcon("");
            setPickerOpen(false);
            void updateSpace(space.id, { name, icon: null });
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
      <div className="row swatches">
        {SPACE_ACCENTS.map((accent) => (
          <button
            key={accent}
            className={`hive-swatch accent-${accent}${
              space.color === accent ? " active" : ""
            }`}
            title={accent}
            onClick={() => void updateSpace(space.id, { color: accent })}
          />
        ))}
      </div>
    </div>
  );
}

export function SpaceSwitcher() {
  const spaces = useAppStore((s) => s.spaces);
  const activeSpaceId = useAppStore((s) => s.activeSpaceId);
  const switchSpace = useAppStore((s) => s.switchSpace);
  const createSpace = useAppStore((s) => s.createSpace);
  const unreadBySpace = useAppStore((s) => s.unreadBySpace);
  const [editingId, setEditingId] = useState<string | null>(null);

  const editing = spaces.find((s) => s.id === editingId);

  return (
    <div className="hive-space-switcher">
      {editing && (
        <SpaceEditor space={editing} onClose={() => setEditingId(null)} />
      )}
      <div className="hive-space-row">
        {spaces.map((space, i) => {
          const isPrivate = space.id === PRIVATE_SPACE_ID;
          return (
          <span className="hive-space-dot-wrap" key={space.id}>
            <button
              className={`hive-space-dot accent-${space.color}${
                space.id === activeSpaceId ? " active" : ""
              }${space.icon ? " has-emoji" : ""}`}
              title={
                isPrivate
                  ? `${space.name} (⌃${i + 1})`
                  : `${space.name} (⌃${i + 1}) — right-click to edit`
              }
              onClick={() => void switchSpace(space.id)}
              onDoubleClick={() => {
                if (!isPrivate) setEditingId(space.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                if (!isPrivate) setEditingId(space.id);
              }}
            >
              {space.icon ? (
                <Glyph icon={space.icon} size={15} />
              ) : (
                space.name.slice(0, 1).toUpperCase()
              )}
            </button>
            {(unreadBySpace[space.id] ?? 0) > 0 && (
              <span className="hive-space-badge">
                {unreadBySpace[space.id]}
              </span>
            )}
          </span>
          );
        })}
        <button
          className="hive-space-dot add"
          title="New Space"
          onClick={() => void createSpace()}
        >
          +
        </button>
      </div>
    </div>
  );
}
