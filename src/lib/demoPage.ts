import type { HiveBlock, RichTextItem } from "./types";

/**
 * Built-in demo page for exercising the full pipe (store → SQLite cache →
 * renderer) without a Notion token. Shapes mirror the real block API so the
 * renderer can't tell the difference. Covers every Tier 1 block, rich-text
 * annotation combinations, nesting, and unsupported types (fallback cards).
 */

export const DEMO_PAGE_ID = "00000000-0000-0000-0000-00000000demo";

function text(
  content: string,
  overrides: Partial<RichTextItem["annotations"]> = {},
  href: string | null = null,
): RichTextItem {
  return {
    type: "text",
    plain_text: content,
    href,
    annotations: {
      bold: false,
      italic: false,
      strikethrough: false,
      underline: false,
      code: false,
      color: "default",
      ...overrides,
    },
  };
}

let counter = 0;
function block(
  type: string,
  payload: Record<string, unknown>,
  children?: HiveBlock[],
): HiveBlock {
  counter += 1;
  return {
    id: `demo-block-${counter}`,
    type,
    has_children: Boolean(children?.length),
    ...(children?.length ? { children } : {}),
    [type]: payload,
  };
}

export const demoPage: Record<string, unknown> = {
  object: "page",
  id: DEMO_PAGE_ID,
  icon: { type: "emoji", emoji: "🐝" },
  properties: {
    title: {
      type: "title",
      title: [text("Hive demo page — the Phase 1 pipe, sans token")],
    },
  },
};

export const demoBlocks: HiveBlock[] = [
  block("callout", {
    icon: { type: "emoji", emoji: "🚧" },
    rich_text: [
      text("This page is a local fixture. ", { bold: true }),
      text(
        "It flows through the same store, SQLite cache, and renderer as a real Notion page — close and reopen it and it's served cache-first from disk.",
      ),
    ],
  }),
  block("heading_1", { rich_text: [text("Tier 1 blocks")] }),
  block("paragraph", {
    rich_text: [
      text("Rich text with "),
      text("bold", { bold: true }),
      text(", "),
      text("italic", { italic: true }),
      text(", "),
      text("strikethrough", { strikethrough: true }),
      text(", "),
      text("underline", { underline: true }),
      text(", "),
      text("inline code", { code: true }),
      text(", a "),
      text("link", {}, "https://gib.taylorpratt.com"),
      text(", and "),
      text("colored ", { color: "orange" }),
      text("text", { color: "blue_background" }),
      text("."),
    ],
  }),
  block("heading_2", { rich_text: [text("Lists, nested")] }),
  block(
    "bulleted_list_item",
    { rich_text: [text("Sidebar houses Favorites, Pins, and Today")] },
    [
      block("bulleted_list_item", {
        rich_text: [text("nested: Spaces are a local overlay")],
      }),
    ],
  ),
  block("bulleted_list_item", {
    rich_text: [text("Notion stays the source of truth for content")],
  }),
  block("numbered_list_item", { rich_text: [text("Authenticate")] }),
  block("numbered_list_item", { rich_text: [text("Fetch through the queue")] }),
  block("numbered_list_item", { rich_text: [text("Render, then cache")] }),
  block("heading_3", { rich_text: [text("To-dos")] }),
  block("to_do", {
    checked: true,
    rich_text: [text("Build the skeleton")],
  }),
  block("to_do", {
    checked: false,
    rich_text: [text("Get the integration token from IT")],
  }),
  block("quote", {
    rich_text: [
      text(
        "Reorganizing your own working set never prompts a “did this change it for everyone?” worry — because it structurally can't.",
      ),
    ],
  }),
  block("code", {
    language: "sql",
    rich_text: [
      text(
        "-- the content-plane mirror\nSELECT * FROM page_cache WHERE notion_page_id = $1;",
      ),
    ],
  }),
  block("divider", {}),
  block("heading_1", { rich_text: [text("Tier 2 blocks (Phase 3)")] }),
  block("image", {
    type: "external",
    external: {
      url:
        "data:image/svg+xml;utf8," +
        encodeURIComponent(
          `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="120"><rect width="480" height="120" rx="12" fill="#0077cc"/><text x="240" y="68" text-anchor="middle" font-family="Roboto,Arial" font-size="26" fill="#fff">🐝 rendered image block</text></svg>`,
        ),
    },
    caption: [text("An image block, with a caption")],
  }),
  block(
    "table",
    { table_width: 3, has_column_header: true, has_row_header: false },
    [
      block("table_row", {
        cells: [[text("Tier", { bold: true })], [text("Examples")], [text("Behavior")]],
      }),
      block("table_row", {
        cells: [[text("1")], [text("paragraphs, lists, code")], [text("render + edit later")]],
      }),
      block("table_row", {
        cells: [[text("2")], [text("images, tables, toggles")], [text("render only")]],
      }),
      block("table_row", {
        cells: [[text("3")], [text("synced blocks, databases")], [text("fallback card")]],
      }),
    ],
  ),
  block(
    "toggle",
    { rich_text: [text("A toggle block — click to expand")] },
    [
      block("paragraph", {
        rich_text: [text("Nested content renders through the same dispatch table.")],
      }),
    ],
  ),
  block("bookmark", {
    url: "https://arc.net",
    caption: [text("The north star")],
  }),
  block(
    "column_list",
    {},
    [
      block("column", {}, [
        block("paragraph", {
          rich_text: [text("Left column. ", { bold: true }), text("Columns flex side by side.")],
        }),
      ]),
      block("column", {}, [
        block("paragraph", {
          rich_text: [
            text("Right column, with inline math "),
            {
              type: "equation",
              plain_text: "e^{i\\pi}+1=0",
              href: null,
              equation: { expression: "e^{i\\pi}+1=0" },
              annotations: {
                bold: false, italic: false, strikethrough: false,
                underline: false, code: false, color: "default",
              },
            } as RichTextItem,
            text("."),
          ],
        }),
      ]),
    ],
  ),
  block("equation", { expression: "f(x) = \\int_{-\\infty}^{\\infty} \\hat{f}(\\xi)\\, e^{2\\pi i \\xi x} \\, d\\xi" }),
  block("divider", {}),
  block("heading_2", { rich_text: [text("Graceful degradation")] }),
  block("paragraph", {
    rich_text: [
      text(
        "Anything the renderer doesn't support degrades to a fallback card — fallback, never crash:",
      ),
    ],
  }),
  block("child_database", { title: "Roadmap (linked database)" }),
  block("synced_block", {}),
];
