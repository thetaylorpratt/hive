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

// Mouse-driven range selection (shift+click and click-drag), layered onto
// the ⌘A-escalated block selection below. Module-level so it survives
// across blur/focus and doesn't need React state.
let lastFocusedBlockId: string | null = null;
/** Sticks across repeated shift+clicks (and once a drag starts) so a second
 * shift+click extends from the ORIGINAL anchor, not the previous target. */
let selectionAnchorId: string | null = null;
let dragAnchorId: string | null = null;
let dragStartX = 0;
let dragStartY = 0;
let dragActive = false;
const DRAG_THRESHOLD_SQ = 6 * 6; // px, squared — a real drag, not a click's jitter

/** The block currently focused, or the last one that was (survives blur —
 * e.g. after the ⌘A escalation, or once a selection has taken focus away). */
function currentlyFocusedBlockId(): string | null {
  const el = document.activeElement as HTMLElement | null;
  if (el && el.classList.contains("hive-editable") && el.dataset.bid) {
    return el.dataset.bid;
  }
  return lastFocusedBlockId;
}

/** Inclusive slice of selectableBlockIds() between two ids, order-agnostic.
 * Null if either id isn't a top-level selectable block (v1 scope). */
function rangeFromIds(ids: string[], anchorId: string, currentId: string): string[] | null {
  const a = ids.indexOf(anchorId);
  const b = ids.indexOf(currentId);
  if (a === -1 || b === -1) return null;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return ids.slice(lo, hi + 1);
}

function blockIdAtPoint(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  return el?.closest<HTMLElement>(".hive-editable")?.dataset.bid ?? null;
}

function onDragMouseMove(e: MouseEvent) {
  if (!dragAnchorId) return;
  const currentId = blockIdAtPoint(e.clientX, e.clientY);
  if (!dragActive) {
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    if (dx * dx + dy * dy < DRAG_THRESHOLD_SQ) return; // hasn't moved enough yet
    if (!currentId || currentId === dragAnchorId) return; // still inside the anchor block
    const range = rangeFromIds(selectableBlockIds(), dragAnchorId, currentId);
    if (!range) return; // anchor isn't a top-level selectable block — not our v1 scope
    dragActive = true;
    selectionAnchorId = dragAnchorId;
    window.getSelection()?.removeAllRanges(); // drop whatever text-selection had started
    (document.activeElement as HTMLElement | null)?.blur();
    useAppStore.getState().setBlockSelection(range);
    e.preventDefault();
    return;
  }
  e.preventDefault();
  if (!currentId) return; // pointer between blocks — keep the last computed range
  const range = rangeFromIds(selectableBlockIds(), dragAnchorId, currentId);
  if (range) useAppStore.getState().setBlockSelection(range);
}

function onDragMouseUp() {
  document.removeEventListener("mousemove", onDragMouseMove);
  document.removeEventListener("mouseup", onDragMouseUp);
  dragAnchorId = null;
  dragActive = false;
}

/**
 * Block multi-selection v1 (H): once `selectedBlockIds` is set — escalated
 * from EditableText's double-⌘A, or from a shift+click / click-drag range
 * below — focus has been blurred out of any editable — these global
 * handlers own Escape/Backspace/⌘C/⌘A while a selection is active, and
 * clear it on any other keystroke or click.
 */
function installSelectionKeymap(): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    const s = useAppStore.getState();
    const meta = e.metaKey || e.ctrlKey;

    if (s.selectedBlockIds && s.selectedBlockIds.length > 0) {
      if (e.key === "Escape") {
        e.preventDefault();
        selectionAnchorId = null;
        s.setBlockSelection(null);
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        selectionAnchorId = null;
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
        selectionAnchorId = null;
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

  const onFocusIn = (e: FocusEvent) => {
    const el = e.target as HTMLElement | null;
    if (el?.classList.contains("hive-editable") && el.dataset.bid) {
      lastFocusedBlockId = el.dataset.bid;
    }
  };

  const onMouseDown = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    const editable = target?.closest<HTMLElement>(".hive-editable");
    const blockId = editable?.dataset.bid ?? null;

    // Shift+click: extend a range from the sticky anchor (or the
    // currently/last-focused block) to the clicked block, inclusive.
    if (blockId && e.shiftKey && e.button === 0 && !e.metaKey && !e.altKey) {
      const ids = selectableBlockIds();
      const anchor = [selectionAnchorId, currentlyFocusedBlockId(), blockId].find(
        (id): id is string => !!id && ids.includes(id),
      );
      const range = anchor ? rangeFromIds(ids, anchor, blockId) : null;
      if (range) {
        e.preventDefault(); // select the block, don't place/extend a text caret
        selectionAnchorId = anchor!;
        (document.activeElement as HTMLElement | null)?.blur();
        useAppStore.getState().setBlockSelection(range);
        return;
      }
      // blockId isn't a top-level selectable block (nested) — fall through
      // to plain-click handling below, which still drops a stale selection
      // but lets the native shift+click text-selection happen.
    }

    const s = useAppStore.getState();
    if (s.selectedBlockIds) {
      s.setBlockSelection(null);
      selectionAnchorId = null;
    }

    // Click-drag range-select: record the anchor now; promotion to a block
    // selection happens in onDragMouseMove once the pointer crosses into a
    // different block past a small threshold. A drag that never leaves the
    // anchor block is left alone — that's normal in-block text selection.
    if (blockId && !e.shiftKey && e.button === 0) {
      dragAnchorId = blockId;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      dragActive = false;
      document.addEventListener("mousemove", onDragMouseMove);
      document.addEventListener("mouseup", onDragMouseUp);
    }
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("mousedown", onMouseDown);
  document.addEventListener("focusin", onFocusIn);
  return () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("mousedown", onMouseDown);
    document.removeEventListener("focusin", onFocusIn);
    onDragMouseUp(); // drop any in-flight drag listeners
  };
}
