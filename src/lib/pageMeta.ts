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
  const icon = page.icon as { type?: string; emoji?: string } | null;
  return icon?.type === "emoji" && icon.emoji ? icon.emoji : null;
}

/** Flatten a block tree to plain text (FTS indexing, word counts). */
export function blocksToPlainText(
  blocks: { [key: string]: unknown; type: string; children?: unknown[] }[],
): string {
  const parts: string[] = [];
  const walk = (list: typeof blocks) => {
    for (const b of list) {
      const payload = b[b.type] as { rich_text?: { plain_text: string }[] } | undefined;
      if (payload?.rich_text) {
        parts.push(payload.rich_text.map((t) => t.plain_text).join(""));
      }
      if (b.children) walk(b.children as typeof blocks);
    }
  };
  walk(blocks);
  return parts.join("\n");
}
