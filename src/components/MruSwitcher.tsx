import { useEffect, useState } from "react";
import { useAppStore } from "../store/appStore";

/**
 * Arc-style Ctrl+Tab MRU switcher: hold Ctrl, tap Tab to cycle the most
 * recently used docs (Shift+Tab cycles back), release Ctrl to open the
 * selection. Esc cancels.
 */
export function MruSwitcher() {
  const mru = useAppStore((s) => s.mru);
  const openPage = useAppStore((s) => s.openPage);
  const [index, setIndex] = useState<number | null>(null); // null = closed

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Tab" && e.ctrlKey) {
        const entries = useAppStore.getState().mru;
        if (entries.length < 2) return;
        e.preventDefault();
        setIndex((prev) => {
          const start = prev ?? 0;
          const delta = e.shiftKey ? -1 : 1;
          return (start + delta + entries.length) % entries.length;
        });
      } else if (e.key === "Escape") {
        setIndex(null);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== "Control") return;
      setIndex((current) => {
        if (current !== null) {
          const entry = useAppStore.getState().mru[current];
          if (entry) void openPage(entry.pageId);
        }
        return null;
      });
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [openPage]);

  if (index === null || mru.length < 2) return null;

  return (
    <div className="hive-mru-backdrop">
      <div className="hive-mru">
        {mru.map((entry, i) => (
          <div
            key={entry.pageId}
            className={`hive-mru-card${i === index ? " selected" : ""}`}
          >
            <span className="icon">{entry.icon ?? "📄"}</span>
            <span className="title">{entry.title}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
