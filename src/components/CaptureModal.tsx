import { useState } from "react";
import { useAppStore } from "../store/appStore";

/**
 * Quick capture (Phase 6, in-app v1): jot a note, first line becomes the
 * title of a real Notion page under config capturePageId. A system-wide
 * floating window (global shortcut) is the future upgrade.
 */
export function CaptureModal() {
  const open = useAppStore((s) => s.captureOpen);
  const setOpen = useAppStore((s) => s.setCaptureOpen);
  const createCapture = useAppStore((s) => s.createCapture);
  const [text, setText] = useState("");
  if (!open) return null;

  return (
    <div className="hive-cmdbar-backdrop" onMouseDown={() => setOpen(false)}>
      <div className="hive-capture" onMouseDown={(e) => e.stopPropagation()}>
        <textarea
          autoFocus
          placeholder={"Quick note… first line becomes the title.\n⌘Enter saves to Notion, Esc discards."}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.metaKey && text.trim()) {
              void createCapture(text);
              setText("");
            }
            if (e.key === "Escape") setOpen(false);
          }}
        />
        <div className="hint">
          ⌘↵ save · saved under your capture page (capturePageId in ~/.hive/config.json)
        </div>
      </div>
    </div>
  );
}
