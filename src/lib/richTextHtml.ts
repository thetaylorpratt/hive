import type { RichTextItem } from "./types";

/**
 * Rich text ⇄ HTML round-trip for the block editor.
 *
 * richTextToHtml renders annotations into a minimal tag vocabulary that
 * htmlToRichText parses back after a contentEditable session. Round-trip
 * preserves: bold, italic, underline, strikethrough, inline code, links.
 * Known v1 losses on *edited* blocks only: text colors and inline equations
 * flatten to plain text (unedited blocks are never touched).
 */

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export function richTextToHtml(items: RichTextItem[]): string {
  return items
    .map((item) => {
      // Mentions/equations become ATOMIC chips inside the editable —
      // contenteditable=false so the caret treats them as one unit, with
      // the original item serialized so the round-trip preserves them
      // exactly (these runs used to force the whole block read-only).
      if (item.type !== "text") {
        return `<span class="hive-exotic" contenteditable="false" data-exotic="${escapeHtml(
          JSON.stringify(item),
        )}">${escapeHtml(item.plain_text || "◦")}</span>`;
      }
      let html = escapeHtml(item.plain_text);
      const a = item.annotations;
      if (a?.code) html = `<code>${html}</code>`;
      if (a?.bold) html = `<b>${html}</b>`;
      if (a?.italic) html = `<i>${html}</i>`;
      if (a?.underline) html = `<u>${html}</u>`;
      if (a?.strikethrough) html = `<s>${html}</s>`;
      if (a?.color && a.color !== "default") {
        html = `<span data-color="${escapeHtml(a.color)}">${html}</span>`;
      }
      if (item.href) html = `<a href="${escapeHtml(item.href)}">${html}</a>`;
      return html;
    })
    .join("");
}

interface Flags {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  code: boolean;
  color: string;
  href: string | null;
}

function makeItem(text: string, f: Flags): RichTextItem {
  return {
    type: "text",
    plain_text: text,
    href: f.href,
    text: { content: text, link: f.href ? { url: f.href } : null },
    annotations: {
      bold: f.bold,
      italic: f.italic,
      strikethrough: f.strikethrough,
      underline: f.underline,
      code: f.code,
      color: f.color,
    },
  } as RichTextItem;
}

export function htmlToRichText(html: string): RichTextItem[] {
  const root = document.createElement("div");
  root.innerHTML = html;
  const items: RichTextItem[] = [];

  const walk = (node: Node, f: Flags) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? "";
      if (!text) return;
      const last = items[items.length - 1];
      // merge adjacent runs with identical formatting
      if (
        last &&
        last.href === f.href &&
        last.annotations.bold === f.bold &&
        last.annotations.italic === f.italic &&
        last.annotations.underline === f.underline &&
        last.annotations.strikethrough === f.strikethrough &&
        last.annotations.code === f.code &&
        last.annotations.color === f.color
      ) {
        const merged = last.plain_text + text;
        last.plain_text = merged;
        (last.text as { content: string }).content = merged;
        return;
      }
      items.push(makeItem(text, f));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (el.dataset?.exotic) {
      // atomic chip: restore the original mention/equation item verbatim
      try {
        items.push(JSON.parse(el.dataset.exotic) as RichTextItem);
      } catch {
        items.push(makeItem(el.textContent ?? "", f));
      }
      return;
    }
    const tag = el.tagName.toLowerCase();
    const next: Flags = { ...f };
    if (tag === "b" || tag === "strong") next.bold = true;
    else if (tag === "i" || tag === "em") next.italic = true;
    else if (tag === "u") next.underline = true;
    else if (tag === "s" || tag === "strike" || tag === "del") next.strikethrough = true;
    else if (tag === "code") next.code = true;
    else if (tag === "a") next.href = el.getAttribute("href");
    else if (tag === "span" && el.dataset.color) next.color = el.dataset.color;
    else if (tag === "br") {
      items.push(makeItem("\n", f));
      return;
    }
    el.childNodes.forEach((child) => walk(child, next));
  };

  root.childNodes.forEach((n) =>
    walk(n, {
      bold: false,
      italic: false,
      underline: false,
      strikethrough: false,
      code: false,
      color: "default",
      href: null,
    }),
  );
  return items;
}

export const richTextPlain = (items: RichTextItem[]): string =>
  items.map((i) => i.plain_text).join("");

/** Strip read-only fields before sending to the Notion API. */
export function toApiRichText(items: RichTextItem[]): unknown[] {
  return items.map((i) => {
    // exotic runs write back as their own type, payload verbatim
    if (i.type === "mention") {
      return {
        type: "mention",
        mention: (i as unknown as { mention: unknown }).mention,
        annotations: { ...i.annotations },
      };
    }
    if (i.type === "equation") {
      return {
        type: "equation",
        equation: (i as unknown as { equation: unknown }).equation,
        annotations: { ...i.annotations },
      };
    }
    return {
      type: "text",
      text: (i as { text?: { content: string; link: { url: string } | null } }).text ?? {
        content: i.plain_text,
        link: i.href ? { url: i.href } : null,
      },
      annotations: { ...i.annotations },
    };
  });
}
