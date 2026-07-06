import { notion } from "./notionClient";
import { enqueue } from "./queue";
import { getCachedPage, upsertPageCache } from "./db";
import type { HiveBlock, PageData } from "./types";

/** Notion nests deeply in pathological docs; cap recursion to bound API calls. */
const MAX_DEPTH = 6;

/** Container types whose children are separate documents — never recurse. */
const NO_RECURSE = new Set(["child_page", "child_database", "synced_block"]);

/**
 * Accepts a bare page ID or any notion.so URL and returns the dashed UUID,
 * or null if no 32-hex ID is present.
 */
export function normalizePageId(input: string): string | null {
  const match = input
    .trim()
    .replace(/-/g, "")
    .match(/[0-9a-f]{32}/i);
  if (!match) return null;
  const id = match[0].toLowerCase();
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

export function loadCached(pageId: string): Promise<PageData | null> {
  return getCachedPage(pageId);
}

export async function fetchFresh(pageId: string): Promise<PageData> {
  const page = (await enqueue(() =>
    notion().pages.retrieve({ page_id: pageId }),
  )) as Record<string, unknown>;
  const blocks = await fetchBlockTree(pageId, 0);
  // Record what changed vs. the copy we last had (feeds the unread UI).
  try {
    const previous = await getCachedPage(pageId);
    if (previous) {
      const { diffBlockTrees } = await import("./blockDiff");
      const { notePageDiff } = await import("./attention");
      notePageDiff(pageId, diffBlockTrees(previous.blocks, blocks));
    }
  } catch {
    /* diffing is best-effort */
  }
  await upsertPageCache(pageId, page, blocks);
  return { page, blocks, fetchedAt: new Date().toISOString(), fromCache: false };
}

async function fetchBlockTree(blockId: string, depth: number): Promise<HiveBlock[]> {
  const blocks: HiveBlock[] = [];
  let cursor: string | undefined;
  do {
    const resp = (await enqueue(() =>
      notion().blocks.children.list({
        block_id: blockId,
        page_size: 100,
        start_cursor: cursor,
      }),
    )) as { results: HiveBlock[]; has_more: boolean; next_cursor: string | null };
    blocks.push(...resp.results);
    cursor = resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
  } while (cursor);

  if (depth < MAX_DEPTH) {
    for (const block of blocks) {
      if (block.has_children && !NO_RECURSE.has(block.type)) {
        block.children = await fetchBlockTree(block.id, depth + 1);
      }
    }
  }
  return blocks;
}
