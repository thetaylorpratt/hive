/**
 * Single in-app keymap (ARCHITECTURE.md §8) so shortcuts stay remappable.
 * Global (OS-level) shortcuts like quick-capture arrive in Phase 6 via
 * Tauri's globalShortcut — this module is window-scoped only.
 */

import { selectableBlockIds, useAppStore } from "../store/appStore";
import type { HiveBlock } from "./types";

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
  const stopSelectionKeymap = installSelectionKeymap();
  return () => {
    window.removeEventListener("keydown", onKeyDown);
    stopSelectionKeymap();
  };
}

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA");
}

/** Notion-ish plain-text prefix for one block, given its plain text and its
 * position (1-based) within the current run of consecutive numbered items. */
function prefixedLine(block: HiveBlock, text: string, numberInRun: number): string {
  switch (block.type) {
    case "bulleted_list_item":
      return `- ${text}`;
    case "numbered_list_item":
      return `${numberInRun}. ${text}`;
    case "to_do":
      return `${(block.to_do as { checked?: boolean } | undefined)?.checked ? "[x]" : "[ ]"} ${text}`;
    case "heading_1":
      return `# ${text}`;
    case "heading_2":
      return `## ${text}`;
    case "heading_3":
      return `### ${text}`;
    default:
      return text;
  }
}

/** Build the ⌘C clipboard text for a block selection, in document order. */
function plainTextFor(ids: string[]): string {
  const blocks = useAppStore.getState().page?.blocks ?? [];
  const byId = new Map(blocks.map((b) => [b.id, b]));
  let run = 0;
  const lines: string[] = [];
  for (const id of ids) {
    const block = byId.get(id);
    if (!block) continue;
    const richText =
      (block[block.type] as { rich_text?: { plain_text: string }[] } | undefined)?.rich_text ?? [];
    const text = richText.map((t) => t.plain_text).join("");
    run = block.type === "numbered_list_item" ? run + 1 : 0;
    lines.push(prefixedLine(block, text, run));
  }
  return lines.join("\n");
}

/**
 * Block multi-selection v1 (H): once `selectedBlockIds` is set (escalated
 * from EditableText's double-⌘A, see there), focus has been blurred out of
 * any editable — these global handlers own Escape/Backspace/⌘C/⌘A while a
 * selection is active, and clear it on any other keystroke or click.
 */
function installSelectionKeymap(): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    const s = useAppStore.getState();
    const meta = e.metaKey || e.ctrlKey;

    if (s.selectedBlockIds && s.selectedBlockIds.length > 0) {
      if (e.key === "Escape") {
        e.preventDefault();
        s.setBlockSelection(null);
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        void s.deleteSelectedBlocks();
        return;
      }
      if (meta && !e.altKey && e.key.toLowerCase() === "c") {
        e.preventDefault();
        void navigator.clipboard.writeText(plainTextFor(s.selectedBlockIds));
        return;
      }
      if (meta && !e.altKey && e.key.toLowerCase() === "a") {
        e.preventDefault();
        s.setBlockSelection(selectableBlockIds());
        return;
      }
      // any other character key drops the selection (typing starts fresh)
      if (!meta && !e.altKey && e.key.length === 1) {
        s.setBlockSelection(null);
      }
      return;
    }

    // escalation entry point when focus isn't inside an editable block —
    // e.g. selection was just cleared, or the user clicked blank page space
    if (meta && !e.altKey && e.key.toLowerCase() === "a" && !isEditableTarget(e.target)) {
      const ids = selectableBlockIds();
      if (ids.length === 0) return;
      e.preventDefault();
      s.setBlockSelection(ids);
    }
  };
  const onMouseDown = () => {
    const s = useAppStore.getState();
    if (s.selectedBlockIds) s.setBlockSelection(null);
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("mousedown", onMouseDown);
  return () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("mousedown", onMouseDown);
  };
}
