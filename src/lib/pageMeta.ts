import type { RichTextItem } from "./types";

/** Title/icon extraction from a Notion page object (shared by view + sidebar cache). */

export function pageTitle(page: Record<string, unknown>): string {
  const properties = page.properties as
    | Record<string, { type: string; title?: RichTextItem[] }>
    | undefined;
  if (properties) {
    for (const prop of Object.values(properties)) {
      if (prop.type === "title" && prop.title) {
        return prop.title.map((t) => t.plain_text).join("") || "Untitled";
      }
    }
  }
  return "Untitled";
}

export function pageEmoji(page: Record<string, unknown>): string | null {
  const icon = page.icon as
    | { type?: string; emoji?: string; external?: { url?: string }; file?: { url?: string } }
    | null;
  if (icon?.type === "emoji" && icon.emoji) return icon.emoji;
  // custom/uploaded icons come through as URLs; <Glyph> renders them
  if (icon?.type === "external" && icon.external?.url) return icon.external.url;
  if (icon?.type === "file" && icon.file?.url) return icon.file.url;
  return null;
}

/** Flatten a block tree to plain text (FTS indexing, word counts). */
export function blocksToPlainText(
  blocks: { [key: string]: unknown; type: string; children?: unknown[] }[],
): string {
  const parts: string[] = [];
  const walk = (list: typeof blocks) => {
    for (const b of list) {
      const payload = b[b.type] as {
        rich_text?: { plain_text: string }[];
        cells?: { plain_text: string }[][];
        caption?: { plain_text: string }[];
        title?: string;
      } | undefined;
      if (payload?.rich_text) {
        parts.push(payload.rich_text.map((t) => t.plain_text).join(""));
      }
      if (payload?.cells) {
        parts.push(
          payload.cells.map((c) => c.map((t) => t.plain_text).join("")).join(" "),
        );
      }
      if (payload?.caption) {
        parts.push(payload.caption.map((t) => t.plain_text).join(""));
      }
      if (typeof payload?.title === "string") parts.push(payload.title);
      if (b.children) walk(b.children as typeof blocks);
    }
  };
  walk(blocks);
  return parts.join("\n");
}
