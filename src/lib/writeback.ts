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

// Text typed into blocks that still carry a temporary local- id: buffered
// here (no API call possible yet) and flushed when the real id arrives.
const pendingLocalText = new Map<string, { type: string; richText: RichTextItem[] }>();

/** Cancel any queued/buffered text write (block converted or deleted). */
export function cancelPendingTextWrite(blockId: string) {
  const pending = pendingTextWrites.get(blockId);
  if (pending) {
    clearTimeout(pending.timer);
    pending.waiters.forEach((w) => w.resolve());
    pendingTextWrites.delete(blockId);
  }
  pendingLocalText.delete(blockId);
}

/** Any coalesced or buffered text writes still unsent? */
export function hasPendingTextWrites(): boolean {
  return pendingTextWrites.size > 0 || pendingLocalText.size > 0;
}

/** After an id remap, send any text buffered under the old local id. */
export function flushPendingLocalText(fromId: string, toId: string) {
  const buffered = pendingLocalText.get(fromId);
  pendingLocalText.delete(fromId);
  if (buffered) {
    void scheduleTextWrite(toId, buffered.type, buffered.richText).catch(() => {});
  }
}

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
  let remote: Promise<void> = Promise.resolve();
  if (sink === "notion") {
    if (blockId.startsWith("local-")) {
      pendingLocalText.set(blockId, { type, richText }); // flushed on remap
    } else {
      remote = scheduleTextWrite(blockId, type, richText);
    }
  }
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
    sink === "notion" && !blockId.startsWith("local-")
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
/** Find the direct parent block of a nested block (null = top level). */
function findParentOf(blocks: HiveBlock[], blockId: string): HiveBlock | null {
  for (const b of blocks) {
    if (b.children?.some((c) => c.id === blockId)) return b;
    if (b.children) {
      const nested = findParentOf(b.children, blockId);
      if (nested) return nested;
    }
  }
  return null;
}

export async function insertParagraphAfter(
  pageId: string,
  blocks: HiveBlock[],
  afterId: string,
  pageParentId: string, // the page id (used when afterId is top-level)
  sink: WriteSink,
): Promise<WriteResult & { newBlockId: string; remoteId: Promise<string | null> }> {
  // `after` must be a direct child of the append target: resolve the real
  // parent for nested siblings instead of always appending to the page.
  const parentBlock = findParentOf(blocks, afterId);
  const parentId = parentBlock?.id ?? pageParentId;
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
    sink === "notion" && !afterId.startsWith("local-") && !parentId.startsWith("local-")
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

/** Remap many ids at once (table rebuild: table + every row). */
export function remapIds(
  blocks: HiveBlock[],
  mapping: Map<string, string>,
): HiveBlock[] {
  return mapTree(blocks, (b) =>
    mapping.has(b.id) ? { ...b, id: mapping.get(b.id)! } : b,
  );
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

/** Update a page's icon — an emoji, or a URL (Notion custom icons) sent as
 * an external icon so native Notion renders it too — or clear with null. */
export async function updatePageIcon(
  pageId: string,
  page: Record<string, unknown>,
  blocks: HiveBlock[],
  value: string | null,
  sink: WriteSink,
): Promise<{ page: Record<string, unknown>; remote: Promise<void> }> {
  const iconPayload = value
    ? value.startsWith("http")
      ? { type: "external", external: { url: value } }
      : { type: "emoji", emoji: value }
    : null;
  const nextPage = { ...page, icon: iconPayload };
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
            icon: iconPayload,
          } as never),
        ).then(() => undefined)
      : Promise.resolve();
  return { page: nextPage, remote };
}

/**
 * Add a row to a simple table. Rows are ordinary children of the table
 * block, so this is native API — children.append with `after`.
 */
export async function addTableRow(
  pageId: string,
  blocks: HiveBlock[],
  tableId: string,
  afterRowId: string | null,
  sink: WriteSink,
): Promise<WriteResult & { newRowId: string }> {
  let width = 2;
  const localId = `local-${crypto.randomUUID()}`;
  const next = mapTree(blocks, (b) => {
    if (b.id !== tableId) return b;
    width = (b.table as { table_width?: number })?.table_width ?? 2;
    const newRow: HiveBlock = {
      id: localId,
      type: "table_row",
      has_children: false,
      table_row: { cells: Array.from({ length: width }, () => []) },
    };
    const children = [...(b.children ?? [])];
    const index = afterRowId
      ? children.findIndex((r) => r.id === afterRowId) + 1
      : children.length;
    children.splice(index, 0, newRow);
    return { ...b, children };
  });
  await persist(pageId, next);

  const remote =
    sink === "notion" && !tableId.startsWith("local-")
      ? enqueue(() =>
          notion().blocks.children.append({
            block_id: tableId,
            ...(afterRowId && !afterRowId.startsWith("local-")
              ? { after: afterRowId }
              : {}),
            children: [
              {
                table_row: {
                  cells: Array.from({ length: width }, () => []),
                },
              } as never,
            ],
          }),
        ).then(() => undefined)
      : Promise.resolve();
  return { blocks: next, remote, newRowId: localId };
}

/**
 * Change a table's column count. `table_width` is immutable after creation,
 * so the notion sink REBUILDS the table: append a new table (with resized
 * rows) after the old one, delete the old, then refetch to pick up the new
 * ids. Caveat: comments anchored to the old table/rows are orphaned — the
 * unavoidable cost of the rebuild trick.
 */
type TablePayload = {
  table_width: number;
  has_column_header?: boolean;
  has_row_header?: boolean;
};

/**
 * table_width is immutable and there's no row-move / column-move endpoint,
 * so every structural table change (resize, reorder rows, reorder columns)
 * is a rebuild: append a fresh table under the SAME parent, then delete the
 * old one, then remap the new ids in place. Two hard-won rules baked in:
 * the append must target the table's real parent (not always the page, or
 * you get a duplicate "at the bottom"), and ids are remapped locally rather
 * than reloading the page (which discarded edits in flight elsewhere).
 */
function rebuildTableRemote(
  pageId: string,
  blocks: HiveBlock[],
  tableId: string,
  payload: TablePayload,
  rows: RichTextItem[][][],
  localRowIds: string[],
  sink: WriteSink,
): { remote: Promise<void>; remap?: Promise<Map<string, string> | null> } {
  const canRebuild = sink === "notion" && !tableId.startsWith("local-");
  if (!canRebuild) return { remote: Promise.resolve() };
  const parentId = findParentOf(blocks, tableId)?.id ?? pageId;
  const remap = (async (): Promise<Map<string, string> | null> => {
    const appended = (await enqueue(() =>
      notion().blocks.children.append({
        block_id: parentId,
        after: tableId,
        children: [
          {
            table: {
              ...payload,
              children: rows.map((cells) => ({
                table_row: { cells: cells.map((c) => toApiRichText(c)) },
              })),
            },
          } as never,
        ],
      }),
    )) as { results?: { id?: string }[] };
    const newTableId = appended.results?.[0]?.id;
    if (!newTableId) return null;
    const rowResp = (await enqueue(() =>
      notion().blocks.children.list({ block_id: newTableId, page_size: 100 }),
    )) as { results?: { id?: string }[] };
    const newRowIds = (rowResp.results ?? []).map((r) => r.id).filter(Boolean) as string[];
    await enqueue(() => notion().blocks.delete({ block_id: tableId }));
    const mapping = new Map<string, string>();
    mapping.set(tableId, newTableId);
    localRowIds.forEach((id, i) => {
      if (newRowIds[i]) mapping.set(id, newRowIds[i]);
    });
    return mapping;
  })();
  return { remote: remap.then(() => undefined), remap };
}

export async function setTableColumns(
  pageId: string,
  blocks: HiveBlock[],
  tableId: string,
  newWidth: number,
  sink: WriteSink,
): Promise<WriteResult & { remap?: Promise<Map<string, string> | null> }> {
  if (newWidth < 1) return { blocks, remote: Promise.resolve() };
  let payload: TablePayload | null = null;
  const localRowIds: string[] = [];
  const rows: RichTextItem[][][] = [];
  const resize = (cells: RichTextItem[][]) =>
    Array.from({ length: newWidth }, (_, i) => cells[i] ?? []);

  const next = mapTree(blocks, (b) => {
    if (b.id === tableId) {
      payload = { ...(b.table as TablePayload), table_width: newWidth };
      const children = (b.children ?? []).map((row) => {
        const cells = resize(
          ((row.table_row as { cells?: RichTextItem[][] })?.cells) ?? [],
        );
        rows.push(cells);
        localRowIds.push(row.id);
        return { ...row, table_row: { cells } };
      });
      return { ...b, table: payload as never, children };
    }
    return b;
  });
  await persist(pageId, next);
  if (!payload) return { blocks: next, remote: Promise.resolve() };
  const { remote, remap } = rebuildTableRemote(
    pageId, blocks, tableId, payload, rows, localRowIds, sink,
  );
  return { blocks: next, remote, remap };
}

/** Move a table row up or down (rebuild — no row-move endpoint exists). */
export async function moveTableRow(
  pageId: string,
  blocks: HiveBlock[],
  tableId: string,
  rowId: string,
  dir: "up" | "down",
  sink: WriteSink,
): Promise<WriteResult & { remap?: Promise<Map<string, string> | null> }> {
  const table = findWithPrev(blocks, tableId)?.block;
  if (!table) return { blocks, remote: Promise.resolve() };
  const children = [...(table.children ?? [])];
  const i = children.findIndex((r) => r.id === rowId);
  const j = dir === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= children.length) {
    return { blocks, remote: Promise.resolve() };
  }
  [children[i], children[j]] = [children[j], children[i]];
  const next = mapTree(blocks, (b) => (b.id === tableId ? { ...b, children } : b));
  await persist(pageId, next);
  const payload = table.table as TablePayload;
  const rows = children.map(
    (r) => ((r.table_row as { cells?: RichTextItem[][] })?.cells) ?? [],
  );
  const localRowIds = children.map((r) => r.id);
  const { remote, remap } = rebuildTableRemote(
    pageId, blocks, tableId, payload, rows, localRowIds, sink,
  );
  return { blocks: next, remote, remap };
}

/** Move a table column left or right (rebuild — reorders every row's cells). */
export async function moveTableColumn(
  pageId: string,
  blocks: HiveBlock[],
  tableId: string,
  colIndex: number,
  dir: "left" | "right",
  sink: WriteSink,
): Promise<WriteResult & { remap?: Promise<Map<string, string> | null> }> {
  const table = findWithPrev(blocks, tableId)?.block;
  if (!table) return { blocks, remote: Promise.resolve() };
  const payload = table.table as TablePayload;
  const target = dir === "left" ? colIndex - 1 : colIndex + 1;
  if (colIndex < 0 || target < 0 || target >= payload.table_width) {
    return { blocks, remote: Promise.resolve() };
  }
  const swap = (cells: RichTextItem[][]) => {
    const c = [...cells];
    [c[colIndex], c[target]] = [c[target] ?? [], c[colIndex] ?? []];
    return c;
  };
  const children = (table.children ?? []).map((row) => ({
    ...row,
    table_row: {
      cells: swap(((row.table_row as { cells?: RichTextItem[][] })?.cells) ?? []),
    },
  }));
  const next = mapTree(blocks, (b) => (b.id === tableId ? { ...b, children } : b));
  await persist(pageId, next);
  const rows = children.map((r) => r.table_row.cells);
  const localRowIds = children.map((r) => r.id);
  const { remote, remap } = rebuildTableRemote(
    pageId, blocks, tableId, payload, rows, localRowIds, sink,
  );
  return { blocks: next, remote, remap };
}

/** Duplicate a text-class block (or simple table) right below itself. */
export async function duplicateBlock(
  pageId: string,
  blocks: HiveBlock[],
  blockId: string,
  sink: WriteSink,
): Promise<WriteResult> {
  const found = findWithPrev(blocks, blockId);
  if (!found) return { blocks, remote: Promise.resolve() };
  const source = found.block;

  const cloneTree = (b: HiveBlock): HiveBlock => ({
    ...JSON.parse(JSON.stringify(b)),
    id: `local-${crypto.randomUUID()}`,
    ...(b.children ? { children: b.children.map(cloneTree) } : {}),
  });
  const copy = cloneTree(source);
  const next = insertAfterInTree(blocks, blockId, copy);
  await persist(pageId, next);

  let remote: Promise<void> = Promise.resolve();
  if (sink === "notion" && !blockId.startsWith("local-")) {
    if (EDITABLE_TYPES.has(source.type)) {
      const payload = source[source.type] as { rich_text?: RichTextItem[]; checked?: boolean };
      remote = enqueue(() =>
        notion().blocks.children.append({
          block_id: pageId,
          after: blockId,
          children: [
            {
              [source.type]: {
                ...(source.type === "to_do" ? { checked: payload?.checked ?? false } : {}),
                rich_text: toApiRichText(payload?.rich_text ?? []),
              },
            } as never,
          ],
        }),
      ).then(() => undefined);
    } else if (source.type === "table") {
      const table = source.table as { table_width: number; has_column_header?: boolean; has_row_header?: boolean };
      remote = enqueue(() =>
        notion().blocks.children.append({
          block_id: pageId,
          after: blockId,
          children: [
            {
              table: {
                ...table,
                children: (source.children ?? []).map((row) => ({
                  table_row: {
                    cells: (
                      ((row.table_row as { cells?: RichTextItem[][] })?.cells) ?? []
                    ).map((c) => toApiRichText(c)),
                  },
                })),
              },
            } as never,
          ],
        }),
      ).then(() => undefined);
    }
  }
  return { blocks: next, remote };
}

/** Toggle table header row/column — plain blocks.update, fully supported. */
export async function updateTableSettings(
  pageId: string,
  blocks: HiveBlock[],
  tableId: string,
  patch: { has_column_header?: boolean; has_row_header?: boolean },
  sink: WriteSink,
): Promise<WriteResult> {
  const next = mapTree(blocks, (b) =>
    b.id === tableId ? { ...b, table: { ...(b.table as object), ...patch } } : b,
  );
  await persist(pageId, next);
  const remote =
    sink === "notion" && !tableId.startsWith("local-")
      ? enqueue(() =>
          notion().blocks.update({ block_id: tableId, table: patch } as never),
        ).then(() => undefined)
      : Promise.resolve();
  return { blocks: next, remote };
}

/** Payload for recreating a text-class block elsewhere (recreate trick). */
function apiPayloadFor(block: HiveBlock): Record<string, unknown> | null {
  if (!EDITABLE_TYPES.has(block.type)) return null;
  const payload = block[block.type] as { rich_text?: RichTextItem[]; checked?: boolean };
  return {
    [block.type]: {
      ...(block.type === "to_do" ? { checked: payload?.checked ?? false } : {}),
      rich_text: toApiRichText(payload?.rich_text ?? []),
    },
  };
}

/**
 * Move a text-class block up/down among its top-level siblings via the
 * recreate trick (the API cannot move blocks). Moving up recreates the
 * sibling ABOVE after this block (so first-position moves work — append
 * without `after` lands at the END, not the top). The recreated block's id
 * changes → comments anchored to it orphan.
 */
export type RemapResult = { from: string; to: string | null } | null;

export async function moveBlock(
  pageId: string,
  blocks: HiveBlock[],
  blockId: string,
  direction: "up" | "down",
  sink: WriteSink,
): Promise<WriteResult & { remap?: Promise<RemapResult> }> {
  const index = blocks.findIndex((b) => b.id === blockId);
  if (index === -1) return { blocks, remote: Promise.resolve() }; // top-level only in v1
  const swapWith = direction === "up" ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= blocks.length) {
    return { blocks, remote: Promise.resolve() };
  }
  // Recreate the block that logically moved DOWN, after its new predecessor.
  const recreated = direction === "up" ? blocks[swapWith] : blocks[index];
  const afterId = direction === "up" ? blockId : blocks[swapWith].id;
  if (recreated.children?.length) {
    // Recreate would drop the subtree on Notion — refuse rather than diverge.
    return { blocks, remote: Promise.resolve() };
  }
  const next = [...blocks];
  [next[index], next[swapWith]] = [next[swapWith], next[index]];
  await persist(pageId, next);

  const payload = apiPayloadFor(recreated);
  const remote =
    sink === "notion" && payload && !recreated.id.startsWith("local-") && !afterId.startsWith("local-")
      ? enqueue(() =>
          notion().blocks.children.append({
            block_id: pageId,
            after: afterId,
            children: [payload as never],
          }),
        ).then(async (resp) => {
          await enqueue(() => notion().blocks.delete({ block_id: recreated.id }));
          return { from: recreated.id, to: (resp as { results?: { id?: string }[] }).results?.[0]?.id ?? null };
        })
      : Promise.resolve(null);
  return { blocks: next, remote: remote.then(() => undefined), remap: remote };
}

/**
 * Indent: re-home the block as the last child of its previous sibling.
 * Outdent: lift a nested block to sit after its parent. Both use the
 * recreate trick on the notion sink (id changes; children not carried).
 */
export async function indentBlock(
  pageId: string,
  blocks: HiveBlock[],
  blockId: string,
  sink: WriteSink,
): Promise<WriteResult & { remap?: Promise<RemapResult> }> {
  const scan = (list: HiveBlock[]): { list: HiveBlock[]; i: number } | null => {
    const i = list.findIndex((b) => b.id === blockId);
    if (i !== -1) return { list, i };
    for (const b of list) {
      if (b.children) {
        const r = scan(b.children);
        if (r) return r;
      }
    }
    return null;
  };
  const found = scan(blocks);
  if (!found || found.i === 0) return { blocks, remote: Promise.resolve() };
  const prev = found.list[found.i - 1];
  const moving = found.list[found.i];
  // Only types the API allows as parents (plain headings cannot nest).
  const CAN_PARENT = new Set([
    "paragraph", "bulleted_list_item", "numbered_list_item", "to_do",
    "toggle", "quote", "callout",
  ]);
  if (!CAN_PARENT.has(prev.type) || moving.children?.length) {
    return { blocks, remote: Promise.resolve() };
  }
  const next = mapTree(removeFromTree(blocks, blockId), (b) =>
    b.id === prev.id
      ? { ...b, has_children: true, children: [...(b.children ?? []), moving] }
      : b,
  );
  await persist(pageId, next);

  const payload = apiPayloadFor(moving);
  const remap =
    sink === "notion" && payload && !moving.id.startsWith("local-") && !prev.id.startsWith("local-")
      ? enqueue(() =>
          notion().blocks.children.append({
            block_id: prev.id,
            children: [payload as never],
          }),
        ).then(async (resp) => {
          await enqueue(() => notion().blocks.delete({ block_id: blockId }));
          return {
            from: blockId,
            to: (resp as { results?: { id?: string }[] }).results?.[0]?.id ?? null,
          };
        })
      : Promise.resolve(null);
  return { blocks: next, remote: remap.then(() => undefined), remap };
}

export async function outdentBlock(
  pageId: string,
  blocks: HiveBlock[],
  blockId: string,
  sink: WriteSink,
): Promise<WriteResult & { remap?: Promise<RemapResult> }> {
  // find parent whose children contain blockId (top level = not outdentable)
  let parent: HiveBlock | null = null;
  const walk = (list: HiveBlock[]) => {
    for (const b of list) {
      if (b.children?.some((c) => c.id === blockId)) parent = b;
      if (b.children) walk(b.children);
    }
  };
  walk(blocks);
  if (!parent) return { blocks, remote: Promise.resolve() };
  const parentBlock: HiveBlock = parent;
  const moving = parentBlock.children!.find((c) => c.id === blockId)!;

  const stripped = mapTree(blocks, (b) =>
    b.id === parentBlock.id
      ? { ...b, children: b.children!.filter((c) => c.id !== blockId) }
      : b,
  );
  const next = insertAfterInTree(stripped, parentBlock.id, moving);
  await persist(pageId, next);

  const payload = apiPayloadFor(moving);
  const remap =
    sink === "notion" && payload && !moving.id.startsWith("local-") && !parentBlock.id.startsWith("local-")
      ? enqueue(() =>
          notion().blocks.children.append({
            block_id: pageId,
            after: parentBlock.id,
            children: [payload as never],
          }),
        ).then(async (resp) => {
          await enqueue(() => notion().blocks.delete({ block_id: blockId }));
          return {
            from: blockId,
            to: (resp as { results?: { id?: string }[] }).results?.[0]?.id ?? null,
          };
        })
      : Promise.resolve(null);
  return { blocks: next, remote: remap.then(() => undefined), remap };
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
  cancelPendingTextWrite(blockId); // the old block is about to be replaced
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
  // The API can only append (after a sibling or at the end) — when the
  // block was first, place it at the end locally too so both sides agree.
  const next = afterId
    ? insertAfterInTree(blocks, afterId, block)
    : sink === "notion"
      ? [...blocks, block]
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
  cancelPendingTextWrite(blockId);
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
