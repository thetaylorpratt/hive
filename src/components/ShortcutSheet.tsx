import { useAppStore } from "../store/appStore";

/** `?` opens the shortcut sheet (Raycast/Superhuman teaching pattern). */

const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: "Navigate",
    rows: [
      ["⌘T", "Command bar — search docs, Notion, actions"],
      ["⌘K", "Copy link to the current page"],
      ["⌘,", "Settings"],
      ["⌘+ / ⌘− / ⌘0", "Text size bigger / smaller / reset"],
      ["⌃Tab", "Cycle recent docs (hold ⌃, Tab to advance)"],
      ["⌃1–9", "Switch Space"],
      ["two-finger swipe", "Next / previous Space (on sidebar)"],
      ["⌘\\", "Toggle sidebar"],
    ],
  },
  {
    title: "Write",
    rows: [
      ["Enter", "New block below"],
      ["⌫ on empty block", "Delete block"],
      ["/ on empty block", "Block type menu"],
      ["# ## ### - [] 1. > + space", "Markdown autoformat"],
      ["⌘⇧F", "Focus mode (typewriter scroll)"],
      ["Esc", "Leave block / close menus"],
    ],
  },
  {
    title: "Organize",
    rows: [
      ["hover row → 📌 / ★ / ×", "Pin, favorite, remove"],
      ["drag rows", "Reorder, file into folders, Today → Pinned"],
      ["right-click Space dot", "Edit Space icon, name, color"],
    ],
  },
];

export function ShortcutSheet() {
  const open = useAppStore((s) => s.shortcutSheetOpen);
  const setOpen = useAppStore((s) => s.setShortcutSheetOpen);
  if (!open) return null;

  return (
    <div className="hive-cmdbar-backdrop" onMouseDown={() => setOpen(false)}>
      <div
        className="hive-sheet"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="hive-sheet-title">Keyboard shortcuts</div>
        <div className="hive-sheet-groups">
          {GROUPS.map((g) => (
            <div key={g.title}>
              <div className="hive-sheet-group">{g.title}</div>
              {g.rows.map(([keys, what]) => (
                <div className="hive-sheet-row" key={keys}>
                  <kbd>{keys}</kbd>
                  <span>{what}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
