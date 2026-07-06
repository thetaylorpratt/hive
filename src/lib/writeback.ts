import { notion } from "./notionClient";
import { enqueue } from "./queue";
import { updateCachedBlocks } from "./db";
import { toApiRichText } from "./richTextHtml";
import { DEMO_PAGE_ID } from "./demoPage";
import type { HiveBlock, RichTextItem } from "./types";

/**
 * Editing write path (v1 scope per PRD §8: text-class blocks only).
 *
 * Every mutation is optimistic: the block tree is updated locally and
 * persisted to page_cache immediately; the Notion API write then flows
 * through the rate-limited queue. Two sinks:
 *  - notion: real page + authed → blocks.update / children.append / delete
 *  - local-only: demo page or no token → the optimistic write IS the write
 * On an API failure the caller's onError fires so the UI can resync.
 *
 * Never writes organizational state — this is content-plane only, and only
 * for blocks the user explicitly edited.
 */

export type WriteSink = "notion" | "local";

export function sinkFor(pageId: string, authReady: boolean): WriteSink {
  return pageId !== DEMO_PAGE_ID && authReady ? "notion" : "local";
}

/** Text-class block types whose rich_text we allow editing (PRD v1 scope). */
export const EDITABLE_TYPES = new Set([
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
  "quote",
  "callout",
]);

/* ---------- tree helpers (blocks nest via .children) ---------- */

export function mapTree(
  blocks: HiveBlock[],
  fn: (b: HiveBlock) => HiveBlock,
): HiveBlock[] {
  return blocks.map((b) => {
    const mapped = fn(b);
    return mapped.children
      ? { ...mapped, children: mapTree(mapped.children, fn) }
      : mapped;
  });
}

function removeFromTree(blocks: HiveBlock[], blockId: string): HiveBlock[] {
  return blocks
    .filter((b) => b.id !== blockId)
    .map((b) =>
      b.children ? { ...b, children: removeFromTree(b.children, blockId) } : b,
    );
}

function insertAfterInTree(
  blocks: HiveBlock[],
  afterId: string,
  block: HiveBlock,
): HiveBlock[] {
  const index = blocks.findIndex((b) => b.id === afterId);
  if (index !== -1) {
    const next = [...blocks];
    next.splice(index + 1, 0, block);
    return next;
  }
  return blocks.map((b) =>
    b.children
      ? { ...b, children: insertAfterInTree(b.children, afterId, block) }
      : b,
  );
}

async function persist(pageId: string, blocks: HiveBlock[]) {
  try {
    await updateCachedBlocks(pageId, blocks);
  } catch {
    /* no SQLite (plain-browser dev) — optimistic state is in-memory only */
  }
}

/* ---------- mutations ---------- */

export interface WriteResult {
  blocks: HiveBlock[];
  /** resolves when the remote write settles; local sink resolves immediately */
  remote: Promise<void>;
}

export async function editBlockText(
  pageId: string,
  blocks: HiveBlock[],
  blockId: string,
  type: string,
  richText: RichTextItem[],
  sink: WriteSink,
): Promise<WriteResult> {
  const next = mapTree(blocks, (b) =>
    b.id === blockId
      ? {
          ...b,
          [type]: { ...(b[type] as object), rich_text: richText },
        }
      : b,
  );
  await persist(pageId, next);
  const remote =
    sink === "notion"
      ? enqueue(() =>
          notion().blocks.update({
            block_id: blockId,
            [type]: { rich_text: toApiRichText(richText) },
          } as never),
        ).then(() => undefined)
      : Promise.resolve();
  return { blocks: next, remote };
}

export async function toggleTodo(
  pageId: string,
  blocks: HiveBlock[],
  blockId: string,
  checked: boolean,
  sink: WriteSink,
): Promise<WriteResult> {
  const next = mapTree(blocks, (b) =>
    b.id === blockId
      ? { ...b, to_do: { ...(b.to_do as object), checked } }
      : b,
  );
  await persist(pageId, next);
  const remote =
    sink === "notion"
      ? enqueue(() =>
          notion().blocks.update({
            block_id: blockId,
            to_do: { checked },
          } as never),
        ).then(() => undefined)
      : Promise.resolve();
  return { blocks: next, remote };
}

/**
 * Insert a new empty paragraph after a sibling. Returns a temporary
 * `local-*` id immediately; on the notion sink, `remoteId` resolves with the
 * real block id so the caller can remap before any follow-up write.
 */
export async function insertParagraphAfter(
  pageId: string,
  blocks: HiveBlock[],
  afterId: string,
  parentId: string, // the Notion parent to append into (page or block id)
  sink: WriteSink,
): Promise<WriteResult & { newBlockId: string; remoteId: Promise<string | null> }> {
  const localId = `local-${crypto.randomUUID()}`;
  const newBlock: HiveBlock = {
    id: localId,
    type: "paragraph",
    has_children: false,
    paragraph: { rich_text: [] },
  };
  const next = insertAfterInTree(blocks, afterId, newBlock);
  await persist(pageId, next);

  const remoteId =
    sink === "notion"
      ? enqueue(() =>
          notion().blocks.children.append({
            block_id: parentId,
            after: afterId,
            children: [{ paragraph: { rich_text: [] } } as never],
          }),
        ).then(
          (resp) =>
            ((resp as { results?: { id?: string }[] }).results?.[0]?.id ??
              null),
        )
      : Promise.resolve(null);
  return {
    blocks: next,
    remote: remoteId.then(() => undefined),
    remoteId,
    newBlockId: localId,
  };
}

/** Swap a temporary local id for the real Notion id once the append settles. */
export function remapBlockId(
  blocks: HiveBlock[],
  fromId: string,
  toId: string,
): HiveBlock[] {
  return mapTree(blocks, (b) => (b.id === fromId ? { ...b, id: toId } : b));
}

export async function deleteBlock(
  pageId: string,
  blocks: HiveBlock[],
  blockId: string,
  sink: WriteSink,
): Promise<WriteResult> {
  const next = removeFromTree(blocks, blockId);
  await persist(pageId, next);
  const remote =
    sink === "notion" && !blockId.startsWith("local-")
      ? enqueue(() => notion().blocks.delete({ block_id: blockId })).then(
          () => undefined,
        )
      : Promise.resolve();
  return { blocks: next, remote };
}
