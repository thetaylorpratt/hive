/**
 * Single in-app keymap (ARCHITECTURE.md §8) so shortcuts stay remappable.
 * Global (OS-level) shortcuts like quick-capture arrive in Phase 6 via
 * Tauri's globalShortcut — this module is window-scoped only.
 */

export interface KeyBinding {
  /** e.g. "meta+t", "ctrl+3", "meta+\\", "escape" */
  combo: string;
  action: string;
}

// Cmd-K mirrors Cmd-T because browsers refuse to yield Cmd-T during
// plain-browser dev; inside the Tauri webview both work.
export const DEFAULT_BINDINGS: KeyBinding[] = [
  { combo: "meta+t", action: "command-bar" },
  { combo: "meta+k", action: "command-bar" },
  { combo: "meta+\\", action: "toggle-sidebar" },
  ...Array.from({ length: 9 }, (_, i) => ({
    combo: `ctrl+${i + 1}`,
    action: `switch-space-${i + 1}`,
  })),
];

function comboOf(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.metaKey) parts.push("meta");
  if (e.ctrlKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  parts.push(e.key.toLowerCase());
  return parts.join("+");
}

export function installKeymap(
  dispatch: (action: string) => void,
  bindings: KeyBinding[] = DEFAULT_BINDINGS,
): () => void {
  const byCombo = new Map(bindings.map((b) => [b.combo, b.action]));
  const onKeyDown = (e: KeyboardEvent) => {
    const action = byCombo.get(comboOf(e));
    if (!action) return;
    e.preventDefault();
    dispatch(action);
  };
  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}
