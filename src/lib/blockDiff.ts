import { blocksToPlainText } from "./pageMeta";
import type { HiveBlock } from "./types";

/**
 * Block-level change detection (POLISH_OPPORTUNITIES.md — Slite pattern):
 * "unread" is weak for documents; show the delta. Compares two cached block
 * trees by block id and text content. Runs on every background revalidation,
 * so the unread dot can say *what* changed, not just that something did.
 *
 * v2 (real line diffs): a bare count + truncated excerpt told you nothing
 * useful, and it counted the reader's OWN edits as "changes since your last
 * copy" — obviously wrong when the person asking "what changed" is the one
 * who changed it. `entries` now carries full old/new text per block plus
 * who touched it, and `ownIds` (see appStore's init — both the Hive bot
 * identity and the human identity behind the same integration) filters out
 * self-authored blocks so only OTHER people's edits show up.
 */

export interface DiffEntry {
  blockId: string;
  kind: "added" | "edited" | "removed";
  oldText: string;
  newText: string;
  /** last_edited_by.id of the block as it stood after the change (or, for
   * a removed block, as it stood before removal). Null when Notion didn't
   * return an editor (never observed in practice, but the field is
   * optional on the wire). */
  editedBy: string | null;
}

export interface PageDiff {
  added: number;
  removed: number;
  changed: number;
  entries: DiffEntry[];
  /** @deprecated short excerpts of added/changed text, newest-first, max 3
   * — derived from `entries`. Kept only for older consumers (DigestPanel /
   * digest.ts) that haven't moved to `entries` yet. */
  excerpts: string[];
}

function textOf(block: HiveBlock): string {
  return blocksToPlainText([block as Parameters<typeof blocksToPlainText>[0][number]]);
}

function editorOf(block: HiveBlock): string | null {
  const by = (block as { last_edited_by?: { id?: string } }).last_edited_by;
  return by?.id ?? null;
}

function flatten(blocks: HiveBlock[]): Map<string, HiveBlock> {
  const map = new Map<string, HiveBlock>();
  const walk = (list: HiveBlock[]) => {
    for (const b of list) {
      map.set(b.id, b);
      if (b.children) walk(b.children);
    }
  };
  walk(blocks);
  return map;
}

/** Short excerpts for consumers that only want a headline, not full text. */
export function excerptsOf(entries: DiffEntry[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (e.kind === "removed") continue;
    const text = e.newText.trim();
    if (text && out.length < 3) out.push(text.slice(0, 90));
  }
  return out;
}

/**
 * Compares two cached block trees by id + text. `ownIds` excludes blocks
 * whose most recent editor is the signed-in user themself — from EITHER
 * identity Notion can report for the same integration: the Hive bot id
 * (`me.id`) for edits made in Hive, and the human id
 * (`me.bot.owner.user.id`) for edits made straight in the Notion app.
 * Without `ownIds` (default empty), behaves exactly like before — no
 * filtering — so existing callers that haven't threaded identity through
 * yet keep compiling and working.
 */
export function diffBlockTrees(
  oldBlocks: HiveBlock[],
  newBlocks: HiveBlock[],
  ownIds: Set<string> = new Set(),
): PageDiff | null {
  const before = flatten(oldBlocks);
  const after = flatten(newBlocks);
  const entries: DiffEntry[] = [];
  let added = 0;
  let removed = 0;
  let changed = 0;

  const isOwn = (editedBy: string | null) => !!editedBy && ownIds.has(editedBy);

  for (const [id, block] of after) {
    if (id.startsWith("local-")) continue; // our own uncommitted inserts
    const prev = before.get(id);
    const editedBy = editorOf(block);
    if (!prev) {
      if (isOwn(editedBy)) continue;
      added += 1;
      entries.push({ blockId: id, kind: "added", oldText: "", newText: textOf(block).trim(), editedBy });
    } else if (textOf(prev) !== textOf(block)) {
      if (isOwn(editedBy)) continue;
      changed += 1;
      entries.push({
        blockId: id,
        kind: "edited",
        oldText: textOf(prev).trim(),
        newText: textOf(block).trim(),
        editedBy,
      });
    }
  }
  for (const [id, block] of before) {
    if (id.startsWith("local-")) continue; // local id swapped for a real one
    if (after.has(id)) continue;
    const editedBy = editorOf(block);
    if (isOwn(editedBy)) continue;
    removed += 1;
    entries.push({ blockId: id, kind: "removed", oldText: textOf(block).trim(), newText: "", editedBy });
  }

  if (added + removed + changed === 0) return null;
  return { added, removed, changed, entries, excerpts: excerptsOf(entries) };
}

/** Word-size cap for diffWords — defensive only; block text is never
 * document-length, but the LCS table is O(n*m) so a bound keeps a
 * pathological block (a giant pasted paragraph) from stalling the UI. */
const MAX_DIFF_WORDS = 2000;

/** Split into words + whitespace runs, keeping every piece so re-joining
 * the parts reproduces the original string exactly (spacing included). */
function splitWords(s: string): string[] {
  return s.split(/(\s+)/).filter((w) => w.length > 0);
}

/**
 * Word-level LCS diff between two block-sized strings. Classic O(n*m)
 * dynamic program — fine at word-count-per-block scale (capped at
 * MAX_DIFF_WORDS for safety). Adjacent same-type runs are merged so the
 * popover doesn't render one <span> per word.
 */
export function diffWords(
  oldText: string,
  newText: string,
): { text: string; type: "same" | "added" | "removed" }[] {
  const a = splitWords(oldText).slice(0, MAX_DIFF_WORDS);
  const b = splitWords(newText).slice(0, MAX_DIFF_WORDS);
  const n = a.length;
  const m = b.length;

  // dp[i][j] = length of the LCS of a[i:] and b[j:]
  const dp: Int32Array[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Int32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: { text: string; type: "same" | "added" | "removed" }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ text: a[i], type: "same" });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ text: a[i], type: "removed" });
      i += 1;
    } else {
      out.push({ text: b[j], type: "added" });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ text: a[i], type: "removed" });
    i += 1;
  }
  while (j < m) {
    out.push({ text: b[j], type: "added" });
    j += 1;
  }

  const merged: { text: string; type: "same" | "added" | "removed" }[] = [];
  for (const part of out) {
    const last = merged[merged.length - 1];
    if (last && last.type === part.type) {
      last.text += part.text;
    } else {
      merged.push({ ...part });
    }
  }
  return merged;
}
