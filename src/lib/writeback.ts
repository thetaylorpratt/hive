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

/**
 * Per-block write coalescing: rapid edits to the same block collapse into a
 * single blocks.update carrying the latest payload (protects the ~3 req/s
 * budget during fast editing — POLISH_OPPORTUNITIES sync refinements).
 */
const COALESCE_MS = 1200;
const pendingTextWrites = new Map<
  string,
  {
    timer: ReturnType<typeof setTimeout>;
    payload: { type: string; richText: RichTextItem[] };
    waiters: { resolve: () => void; reject: (e: unknown) => void }[];
  }
>();

function scheduleTextWrite(
  blockId: string,
  type: string,
  richText: RichTextItem[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = pendingTextWrites.get(blockId);
    if (existing) clearTimeout(existing.timer);
    const waiters = existing?.waiters ?? [];
    waiters.push({ resolve, reject });
    const entry = {
      payload: { type, richText },
      waiters,
      timer: setTimeout(() => {
        pendingTextWrites.delete(blockId);
        enqueue(() =>
          notion().blocks.update({
            block_id: blockId,
            [entry.payload.type]: {
              rich_text: toApiRichText(entry.payload.richText),
            },
          } as never),
        ).then(
          () => entry.waiters.forEach((w) => w.resolve()),
          (err) => entry.waiters.forEach((w) => w.reject(err)),
        );
      }, COALESCE_MS),
    };
    pendingTextWrites.set(blockId, entry);
  });
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
      ? scheduleTextWrite(blockId, type, richText)
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

/** Fresh payload for a just-converted block type. */
export function emptyPayload(type: string): Record<string, unknown> {
  switch (type) {
    case "to_do":
      return { rich_text: [], checked: false };
    case "callout":
      return { rich_text: [], icon: { type: "emoji", emoji: "💡" } };
    case "divider":
      return {};
    case "code":
      return { rich_text: [], language: "plain text" };
    case "table":
      return { table_width: 2, has_column_header: true, has_row_header: false };
    default:
      return { rich_text: [] };
  }
}

/** Local table_row children for a fresh /table (2 cols × 3 rows). */
function freshTableRows(): HiveBlock[] {
  return Array.from({ length: 3 }, () => ({
    id: `local-${crypto.randomUUID()}`,
    type: "table_row",
    has_children: false,
    table_row: { cells: [[], []] },
  }));
}

/** Update a page's emoji icon (or clear it with null). */
export async function updatePageIcon(
  pageId: string,
  page: Record<string, unknown>,
  blocks: HiveBlock[],
  emoji: string | null,
  sink: WriteSink,
): Promise<{ page: Record<string, unknown>; remote: Promise<void> }> {
  const nextPage = {
    ...page,
    icon: emoji ? { type: "emoji", emoji } : null,
  };
  try {
    const { upsertPageCache } = await import("./db");
    await upsertPageCache(pageId, nextPage, blocks);
  } catch {
    /* no SQLite */
  }
  const remote =
    sink === "notion"
      ? enqueue(() =>
          notion().pages.update({
            page_id: pageId,
            icon: emoji ? { type: "emoji", emoji } : null,
          } as never),
        ).then(() => undefined)
      : Promise.resolve();
  return { page: nextPage, remote };
}

/** Replace one cell of a table_row (API requires writing all cells). */
export async function updateTableCell(
  pageId: string,
  blocks: HiveBlock[],
  rowId: string,
  cellIndex: number,
  richText: RichTextItem[],
  sink: WriteSink,
): Promise<WriteResult> {
  let updatedCells: RichTextItem[][] | null = null;
  const next = mapTree(blocks, (b) => {
    if (b.id !== rowId) return b;
    const cells = [
      ...(((b.table_row as { cells?: RichTextItem[][] })?.cells) ?? []),
    ];
    cells[cellIndex] = richText;
    updatedCells = cells;
    return { ...b, table_row: { cells } };
  });
  await persist(pageId, next);
  const remote =
    sink === "notion" && updatedCells && !rowId.startsWith("local-")
      ? enqueue(() =>
          notion().blocks.update({
            block_id: rowId,
            table_row: {
              cells: updatedCells!.map((cell) => toApiRichText(cell)),
            },
          } as never),
        ).then(() => undefined)
      : Promise.resolve();
  return { blocks: next, remote };
}

/**
 * Change a block's type (markdown autoformat / slash menu). The Notion API
 * cannot convert types in place, so the notion sink appends a new block
 * after the old one and deletes the old — `remoteId` resolves with the new
 * block's real id for remapping. Caveat: the append targets the page as
 * parent, so converting a block nested inside another block is local-sink
 * accurate but remote-sink unsupported (kept top-level-only by the caller).
 */
export async function convertBlockType(
  pageId: string,
  blocks: HiveBlock[],
  blockId: string,
  newType: string,
  richText: RichTextItem[],
  sink: WriteSink,
): Promise<WriteResult & { remoteId: Promise<string | null> }> {
  const noText = newType === "divider" || newType === "table";
  const payload = { ...emptyPayload(newType), ...(noText ? {} : { rich_text: richText }) };
  const tableChildren = newType === "table" ? freshTableRows() : null;
  const next = mapTree(blocks, (b) => {
    if (b.id !== blockId) return b;
    const children = tableChildren ?? b.children;
    const replaced: HiveBlock = {
      id: b.id,
      type: newType,
      has_children: Boolean(children?.length),
      ...(children ? { children } : {}),
      [newType]: payload,
    };
    return replaced;
  });
  await persist(pageId, next);

  const remoteId =
    sink === "notion" && !blockId.startsWith("local-")
      ? enqueue(() =>
          notion().blocks.children.append({
            block_id: pageId,
            after: blockId,
            children: [
              {
                [newType]: {
                  ...payload,
                  ...(noText ? {} : { rich_text: toApiRichText(richText) }),
                  ...(newType === "table"
                    ? {
                        children: Array.from({ length: 3 }, () => ({
                          table_row: { cells: [[], []] },
                        })),
                      }
                    : {}),
                },
              } as never,
            ],
          }),
        )
          .then(async (resp) => {
            await enqueue(() => notion().blocks.delete({ block_id: blockId }));
            return (
              (resp as { results?: { id?: string }[] }).results?.[0]?.id ?? null
            );
          })
      : Promise.resolve(null);
  return { blocks: next, remote: remoteId.then(() => undefined), remoteId };
}

/**
 * Undo path for block deletion: re-insert the captured block after a sibling
 * (or at the end when it was first). Local sink restores children too; the
 * notion sink recreates the block's own content only (children not
 * re-created — v1 undo, acceptable for text-class blocks).
 */
export async function restoreBlock(
  pageId: string,
  blocks: HiveBlock[],
  block: HiveBlock,
  afterId: string | null,
  sink: WriteSink,
): Promise<WriteResult> {
  const next = afterId
    ? insertAfterInTree(blocks, afterId, block)
    : [block, ...blocks];
  await persist(pageId, next);

  let remote: Promise<void> = Promise.resolve();
  if (sink === "notion" && EDITABLE_TYPES.has(block.type)) {
    const payload = block[block.type] as { rich_text?: RichTextItem[] };
    remote = enqueue(() =>
      notion().blocks.children.append({
        block_id: pageId,
        ...(afterId && !afterId.startsWith("local-") ? { after: afterId } : {}),
        children: [
          {
            [block.type]: {
              ...(block.type === "to_do"
                ? { checked: (block.to_do as { checked?: boolean })?.checked ?? false }
                : {}),
              rich_text: toApiRichText(payload?.rich_text ?? []),
            },
          } as never,
        ],
      }),
    ).then(() => undefined);
  }
  return { blocks: next, remote };
}

/** Locate a block and its previous same-level sibling (for undo). */
export function findWithPrev(
  blocks: HiveBlock[],
  blockId: string,
): { block: HiveBlock; prevId: string | null } | null {
  const scan = (list: HiveBlock[]): { block: HiveBlock; prevId: string | null } | null => {
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === blockId) {
        return { block: list[i], prevId: i > 0 ? list[i - 1].id : null };
      }
      if (list[i].children) {
        const found = scan(list[i].children!);
        if (found) return found;
      }
    }
    return null;
  };
  return scan(blocks);
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
