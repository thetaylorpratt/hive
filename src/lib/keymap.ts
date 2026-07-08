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
  { combo: "meta+shift+f", action: "focus-mode" },
  { combo: "?", action: "shortcut-sheet" },
  { combo: "meta+alt+n", action: "quick-capture" },
  { combo: "meta+[", action: "nav-back" },
  { combo: "meta+]", action: "nav-forward" },
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
  // shift only matters for letter keys; symbols like "\" already encode it
  if (e.shiftKey && /^[a-z]$/i.test(e.key)) parts.push("shift");
  // Option mutates e.key on macOS (⌥N → "˜") — use the physical key instead
  let key = e.key.toLowerCase();
  if (e.altKey && /^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
  parts.push(key);
  return parts.join("+");
}

export function installKeymap(
  dispatch: (action: string) => void,
  bindings: KeyBinding[] = DEFAULT_BINDINGS,
): () => void {
  const byCombo = new Map(bindings.map((b) => [b.combo, b.action]));
  const onKeyDown = (e: KeyboardEvent) => {
    const combo = comboOf(e);
    const action = byCombo.get(combo);
    if (!action) return;
    // Modifier-less bindings (like "?") must never fire while typing.
    if (!combo.includes("meta+") && !combo.includes("ctrl+")) {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA")
      ) {
        return;
      }
    }
    e.preventDefault();
    dispatch(action);
  };
  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}
