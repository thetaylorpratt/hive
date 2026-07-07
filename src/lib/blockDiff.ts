import { blocksToPlainText } from "./pageMeta";
import type { HiveBlock } from "./types";

/**
 * Block-level change detection (POLISH_OPPORTUNITIES.md — Slite pattern):
 * "unread" is weak for documents; show the delta. Compares two cached block
 * trees by block id and text content. Runs on every background revalidation,
 * so the unread dot can say *what* changed, not just that something did.
 */

export interface PageDiff {
  added: number;
  removed: number;
  changed: number;
  /** short excerpts of added/changed text, newest-first, max 3 */
  excerpts: string[];
}

function textOf(block: HiveBlock): string {
  return blocksToPlainText([block as Parameters<typeof blocksToPlainText>[0][number]]);
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

export function diffBlockTrees(
  oldBlocks: HiveBlock[],
  newBlocks: HiveBlock[],
): PageDiff | null {
  const before = flatten(oldBlocks);
  const after = flatten(newBlocks);
  const excerpts: string[] = [];
  let added = 0;
  let removed = 0;
  let changed = 0;

  for (const [id, block] of after) {
    if (id.startsWith("local-")) continue; // our own uncommitted inserts
    const prev = before.get(id);
    if (!prev) {
      added += 1;
      const text = textOf(block).trim();
      if (text && excerpts.length < 3) excerpts.push(text.slice(0, 90));
    } else if (textOf(prev) !== textOf(block)) {
      changed += 1;
      const text = textOf(block).trim();
      if (text && excerpts.length < 3) excerpts.push(text.slice(0, 90));
    }
  }
  for (const id of before.keys()) {
    if (id.startsWith("local-")) continue; // local id swapped for a real one
    if (!after.has(id)) removed += 1;
  }

  if (added + removed + changed === 0) return null;
  return { added, removed, changed, excerpts };
}
