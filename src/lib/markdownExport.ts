import type { HiveBlock, RichTextItem } from "./types";

/**
 * Faithful Markdown serialization of a page's block tree — the rich big
 * sibling of blocksToPlainText (pageMeta.ts). One action, one clipboard
 * write; no export dialog, no zip. Defensive throughout: malformed/odd
 * block payloads degrade to "skip this line", never throw.
 */

/** Block types that render as "- text" / "N. text" — their children get an
 * extra two-space indent per nesting level. Everything else's children
 * "just follow" at the same indent. */
const LIST_LIKE = new Set([
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
  "toggle",
]);

function isRichTextArray(v: unknown): v is RichTextItem[] {
  return Array.isArray(v);
}

/** One inline run → its Markdown text, honoring annotations + href.
 * Mentions/equations are rendered as plain_text, no emphasis/links. */
function formatRun(item: RichTextItem | null | undefined): string {
  if (!item || typeof item !== "object") return "";
  const raw = typeof item.plain_text === "string" ? item.plain_text : "";
  if (!raw) return "";
  if (item.type === "equation" || item.type === "mention") return raw;

  const a = item.annotations as RichTextItem["annotations"] | undefined;
  let content = raw;
  if (a?.code) {
    content = "`" + content + "`";
  } else {
    if (a?.strikethrough) content = `~~${content}~~`;
    if (a?.italic) content = `*${content}*`;
    if (a?.bold) content = `**${content}**`;
    // underline has no Markdown equivalent — text is kept, styling dropped.
  }
  if (item.href) content = `[${content}](${item.href})`;
  return content;
}

/** Rich text runs joined to inline Markdown; embedded newlines are folded
 * to spaces so they can't break single-line constructs (bullets, quotes). */
function richTextToMd(items: unknown): string {
  if (!isRichTextArray(items)) return "";
  return items
    .map(formatRun)
    .join("")
    .replace(/\r?\n/g, " ");
}

/** Plain (unstyled) text — used where Markdown syntax would corrupt the
 * output, e.g. image alt text / captions. */
function richTextToPlain(items: unknown): string {
  if (!isRichTextArray(items)) return "";
  return items
    .map((i) => (typeof i?.plain_text === "string" ? i.plain_text : ""))
    .join("")
    .replace(/\r?\n/g, " ");
}

function escapeTableCell(s: string): string {
  return s.replace(/\|/g, "\\|");
}

function renderTable(block: HiveBlock, indent: string): string[] {
  const payload = block.table as
    | { table_width?: number; has_column_header?: boolean }
    | undefined;
  const rowsAll = Array.isArray(block.children)
    ? block.children.filter((c) => c?.type === "table_row")
    : [];
  if (!rowsAll.length) return [];

  const rowWidth = (r: HiveBlock): number => {
    const cells = (r.table_row as { cells?: unknown[] } | undefined)?.cells;
    return Array.isArray(cells) ? cells.length : 0;
  };
  const width =
    typeof payload?.table_width === "number" && payload.table_width > 0
      ? payload.table_width
      : Math.max(1, ...rowsAll.map(rowWidth));

  const cellsOf = (row: HiveBlock): string[] => {
    const cells = (row.table_row as { cells?: unknown[] } | undefined)?.cells;
    const arr = Array.isArray(cells) ? cells : [];
    const out: string[] = [];
    for (let i = 0; i < width; i++) {
      out.push(escapeTableCell(richTextToMd(arr[i])));
    }
    return out;
  };

  let headerCells: string[];
  let dataRows: HiveBlock[];
  if (payload?.has_column_header) {
    headerCells = cellsOf(rowsAll[0]);
    dataRows = rowsAll.slice(1);
  } else {
    headerCells = Array.from({ length: width }, () => "");
    dataRows = rowsAll;
  }

  const lines: string[] = [];
  lines.push(indent + "| " + headerCells.join(" | ") + " |");
  lines.push(indent + "| " + headerCells.map(() => "---").join(" | ") + " |");
  for (const row of dataRows) {
    lines.push(indent + "| " + cellsOf(row).join(" | ") + " |");
  }
  return lines;
}

/** One block (+ its own children, recursively) → its Markdown lines,
 * already prefixed with `indent`. `number` is the 1-based ordinal for
 * numbered_list_item, precomputed per consecutive run by serializeBlocks. */
function renderBlock(block: HiveBlock, indent: string, number: number): string[] {
  if (!block || typeof block !== "object" || typeof block.type !== "string") {
    return [];
  }
  const type = block.type;
  const payload = (block as Record<string, unknown>)[type] as
    | Record<string, unknown>
    | undefined;

  let ownLines: string[] = [];
  let consumesChildren = false;

  switch (type) {
    case "paragraph": {
      const t = richTextToMd(payload?.rich_text);
      if (t) ownLines = [indent + t];
      break;
    }
    case "heading_1":
    case "heading_2":
    case "heading_3": {
      const hashes = type === "heading_1" ? "#" : type === "heading_2" ? "##" : "###";
      const t = richTextToMd(payload?.rich_text);
      ownLines = [indent + `${hashes} ${t}`.trimEnd()];
      break;
    }
    case "bulleted_list_item": {
      const t = richTextToMd(payload?.rich_text);
      ownLines = [indent + `- ${t}`.trimEnd()];
      break;
    }
    case "numbered_list_item": {
      const t = richTextToMd(payload?.rich_text);
      ownLines = [indent + `${number}. ${t}`.trimEnd()];
      break;
    }
    case "to_do": {
      const t = richTextToMd(payload?.rich_text);
      const box = payload?.checked ? "[x]" : "[ ]";
      ownLines = [indent + `- ${box} ${t}`.trimEnd()];
      break;
    }
    case "quote": {
      const t = richTextToMd(payload?.rich_text);
      ownLines = [indent + `> ${t}`.trimEnd()];
      break;
    }
    case "callout": {
      const t = richTextToMd(payload?.rich_text);
      const icon = payload?.icon as { type?: string; emoji?: string } | undefined;
      const emoji = icon?.type === "emoji" && icon.emoji ? icon.emoji : "💡";
      ownLines = [indent + `> ${emoji} ${t}`.trimEnd()];
      break;
    }
    case "code": {
      const lang = typeof payload?.language === "string" ? payload.language : "";
      const rt = payload?.rich_text;
      const codeText = isRichTextArray(rt)
        ? rt.map((t) => (typeof t?.plain_text === "string" ? t.plain_text : "")).join("")
        : "";
      const codeLines = codeText.split("\n");
      ownLines = [
        indent + "```" + (lang === "plain text" ? "" : lang),
        ...codeLines.map((l) => indent + l),
        indent + "```",
      ];
      break;
    }
    case "divider": {
      ownLines = [indent + "---"];
      break;
    }
    case "toggle": {
      const t = richTextToMd(payload?.rich_text);
      ownLines = [indent + `- ${t}`.trimEnd()];
      break;
    }
    case "table": {
      consumesChildren = true;
      ownLines = renderTable(block, indent);
      break;
    }
    case "child_page": {
      const title =
        typeof payload?.title === "string" && payload.title ? payload.title : "Untitled";
      const idNoDashes = String(block.id ?? "").replace(/-/g, "");
      ownLines = [indent + `[📄 ${title}](https://www.notion.so/${idNoDashes})`];
      break;
    }
    case "child_database": {
      const title =
        typeof payload?.title === "string" && payload.title ? payload.title : "Untitled";
      ownLines = [indent + `**[Database: ${title}]**`];
      break;
    }
    case "image": {
      const external = payload?.external as { url?: string } | undefined;
      const file = payload?.file as { url?: string } | undefined;
      const url = external?.url ?? file?.url;
      if (typeof url === "string" && url) {
        const caption = richTextToPlain(payload?.caption);
        ownLines = [indent + `![${caption}](${url})`];
      }
      break;
    }
    case "bookmark": {
      const url = payload?.url;
      if (typeof url === "string" && url) ownLines = [indent + `[${url}](${url})`];
      break;
    }
    default: {
      const rt = payload?.rich_text;
      if (isRichTextArray(rt) && rt.length) {
        const t = richTextToMd(rt);
        if (t) ownLines = [indent + t];
      }
      // otherwise: unknown, no rich_text — skip this block's own line, but
      // still recurse into children below so real content nested under
      // layout-only wrappers (column_list/column, synced_block, …) survives.
      break;
    }
  }

  const lines = [...ownLines];
  if (!consumesChildren && Array.isArray(block.children) && block.children.length) {
    const childIndent = LIST_LIKE.has(type) ? indent + "  " : indent;
    lines.push(...serializeBlocks(block.children, childIndent));
  }
  return lines;
}

/** A sibling list of blocks → Markdown lines. Consecutive list items of the
 * same type (bulleted/numbered/to_do) stay tight (no blank line between);
 * everything else gets a blank-line separator, and numbered items get real
 * per-run numbering. */
function serializeBlocks(blocks: unknown, indent: string): string[] {
  if (!Array.isArray(blocks)) return [];
  const out: string[] = [];
  let numberCounter = 0;
  let prevType: string | null = null;
  for (const b of blocks as HiveBlock[]) {
    if (!b || typeof b !== "object" || typeof b.type !== "string") continue;
    const type = b.type;
    numberCounter = type === "numbered_list_item" ? numberCounter + 1 : 0;

    let rendered: string[];
    try {
      rendered = renderBlock(b, indent, numberCounter);
    } catch {
      rendered = [];
    }
    if (!rendered.length) continue;

    const tightRun =
      prevType === type &&
      (type === "bulleted_list_item" || type === "numbered_list_item" || type === "to_do");
    if (out.length > 0 && !tightRun) out.push("");
    out.push(...rendered);
    prevType = type;
  }
  return out;
}

/** Full page → Markdown: `# title` then the serialized block tree. */
export function pageToMarkdown(title: string, blocks: HiveBlock[]): string {
  const lines: string[] = [`# ${title || "Untitled"}`];
  const body = serializeBlocks(Array.isArray(blocks) ? blocks : [], "");
  if (body.length) {
    lines.push("", ...body);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
