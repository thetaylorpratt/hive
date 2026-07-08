import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import katex from "katex";
import { htmlToRichText, richTextToHtml } from "../lib/richTextHtml";
import "katex/dist/katex.min.css";
import type { HiveBlock, RichTextItem } from "../lib/types";
import { RichText } from "./RichText";
import { EditableText } from "./EditableText";
import { FallbackCard } from "./FallbackCard";
import { useAppStore } from "../store/appStore";

/**
 * Data-driven block renderer (ARCHITECTURE.md §5). One dispatch table keyed
 * by block type; promoting a block between tiers means adding an entry here —
 * call sites never change. Anything not in the table renders the Tier 3
 * fallback card. Renderers must never throw: SafeBlock catches and degrades.
 */

/** Panes (split view, peek) render read-only regardless of canEdit. */
export const ReadOnlyContext = createContext(false);

type BlockComponent = (props: { block: HiveBlock }) => ReactNode;

function rich(block: HiveBlock): RichTextItem[] {
  const payload = block[block.type] as { rich_text?: RichTextItem[] } | undefined;
  return payload?.rich_text ?? [];
}

function Children({ block }: { block: HiveBlock }) {
  if (!block.children?.length) return null;
  return (
    <div className="hive-children">
      <BlockList blocks={block.children} />
    </div>
  );
}

/**
 * Headings, including Notion toggle headings (is_toggleable): the caret
 * expands/collapses children (collapsed by default, matching Notion);
 * clicking the text edits it.
 */
function HeadingBlock({ block, level }: { block: HiveBlock; level: 1 | 2 | 3 }) {
  const payload = block[block.type] as { is_toggleable?: boolean } | undefined;
  const [open, setOpen] = useState(false);
  const Tag = `h${level}` as "h1";
  const toggleable = Boolean(payload?.is_toggleable);
  return (
    <>
      <Tag
        id={`hb-${block.id}`}
        className={toggleable ? "hive-toggle-heading" : undefined}
      >
        {toggleable && (
          <button
            className="hive-toggle-caret"
            aria-expanded={open}
            title={open ? "Collapse" : "Expand"}
            onClick={() => setOpen(!open)}
          >
            {open ? "\u25be" : "\u25b8"}
          </button>
        )}
        <EditableText block={block} items={rich(block)} />
      </Tag>
      {toggleable && open && (
        <div className="hive-children">
          {block.children?.length ? (
            <BlockList blocks={block.children} />
          ) : (
            <div className="hive-side-empty">Empty toggle</div>
          )}
        </div>
      )}
    </>
  );
}

function TodoBlock({ block }: { block: HiveBlock }) {
  const toggleTodo = useAppStore((s) => s.toggleTodo);
  const readOnly = useContext(ReadOnlyContext);
  const canEdit = useAppStore((s) => s.canEdit()) && !readOnly;
  const payload = block.to_do as { checked?: boolean } | undefined;
  const done = payload?.checked ?? false;
  return (
    <>
      <div className={`hive-todo${done ? " done" : ""}`}>
        <input
          type="checkbox"
          checked={done}
          disabled={!canEdit}
          onChange={(e) => void toggleTodo(block.id, e.target.checked)}
        />
        <span>
          <EditableText block={block} items={rich(block)} />
        </span>
      </div>
      <Children block={block} />
    </>
  );
}

/** Tier 1 — render + edit (write path v1: text-class blocks). */
const TIER1: Record<string, BlockComponent> = {
  paragraph: ({ block }) => (
    <>
      <p>
        <EditableText block={block} items={rich(block)} />
      </p>
      <Children block={block} />
    </>
  ),

  heading_1: ({ block }) => <HeadingBlock block={block} level={1} />,
  heading_2: ({ block }) => <HeadingBlock block={block} level={2} />,
  heading_3: ({ block }) => <HeadingBlock block={block} level={3} />,

  bulleted_list_item: ({ block }) => (
    <li>
      <EditableText block={block} items={rich(block)} />
      <Children block={block} />
    </li>
  ),
  numbered_list_item: ({ block }) => (
    <li>
      <EditableText block={block} items={rich(block)} />
      <Children block={block} />
    </li>
  ),

  to_do: ({ block }) => <TodoBlock block={block} />,

  quote: ({ block }) => (
    <blockquote className="hive-quote">
      <EditableText block={block} items={rich(block)} />
      <Children block={block} />
    </blockquote>
  ),

  callout: ({ block }) => {
    const payload = block.callout as
      | { icon?: { type: string; emoji?: string } }
      | undefined;
    const emoji = payload?.icon?.type === "emoji" ? payload.icon.emoji : "💡";
    return (
      <div className="hive-callout">
        <span>{emoji}</span>
        <div>
          <EditableText block={block} items={rich(block)} />
          <Children block={block} />
        </div>
      </div>
    );
  },

  divider: () => <hr className="hive-divider" />,

  code: ({ block }) => {
    const payload = block.code as { language?: string } | undefined;
    const text = rich(block)
      .map((t) => t.plain_text)
      .join("");
    return (
      <div className="hive-code-block">
        {payload?.language && payload.language !== "plain text" && (
          <div className="lang">{payload.language}</div>
        )}
        <pre>
          <code>{text}</code>
        </pre>
      </div>
    );
  },
};

function ChildPageCard({ block }: { block: HiveBlock }) {
  const openPage = useAppStore((s) => s.openPage);
  const title = (block.child_page as { title?: string })?.title || "Untitled";
  // A child_page block's id IS the page id — open it in Hive directly.
  return (
    <div
      className="hive-childpage"
      role="link"
      tabIndex={0}
      onClick={() => void openPage(block.id)}
      onKeyDown={(e) => e.key === "Enter" && void openPage(block.id)}
    >
      <span className="icon">📄</span>
      <span className="title">{title}</span>
      <span className="hint">sub-page</span>
    </div>
  );
}

/** Simple-table cell: contentEditable when the page is editable. */
function TableCell({
  rowId,
  index,
  items,
}: {
  rowId: string;
  index: number;
  items: RichTextItem[];
}) {
  const readOnly = useContext(ReadOnlyContext);
  const canEdit = useAppStore((s) => s.canEdit()) && !readOnly;
  const updateTableCell = useAppStore((s) => s.updateTableCell);
  const ref = useRef<HTMLDivElement>(null);

  // Uncontrolled: content written only here (see EditableText for why).
  useEffect(() => {
    const el = ref.current;
    if (!el || document.activeElement === el) return;
    const html = richTextToHtml(items);
    if (el.innerHTML !== html) el.innerHTML = html;
  });

  if (!canEdit || items.some((i) => i.type !== "text")) {
    return <RichText items={items} />;
  }
  return (
    <div
      ref={ref}
      className="hive-cell-editable"
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      onBlur={() => {
        const parsed = htmlToRichText(ref.current?.innerHTML ?? "");
        if (richTextToHtml(parsed) !== richTextToHtml(items)) {
          void updateTableCell(rowId, index, parsed);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === "Escape") {
          e.preventDefault();
          (e.target as HTMLElement).blur();
        }
      }}
    />
  );
}

function SimpleTable({ block }: { block: HiveBlock }) {
  const readOnly = useContext(ReadOnlyContext);
  const canEdit = useAppStore((s) => s.canEdit()) && !readOnly;
  const addTableRow = useAppStore((s) => s.addTableRow);
  const setTableColumns = useAppStore((s) => s.setTableColumns);
  const updateTableSettings = useAppStore((s) => s.updateTableSettings);
  const deleteBlock = useAppStore((s) => s.deleteBlock);
  const payload = block.table as {
    has_column_header?: boolean;
    has_row_header?: boolean;
  };
  const rows = (block.children ?? []).filter((c) => c.type === "table_row");
  return (
    <div className="hive-table-wrap">
      <table className="hive-table">
        <tbody>
          {rows.map((row, ri) => {
            const cells =
              (row.table_row as { cells?: RichTextItem[][] })?.cells ?? [];
            return (
              <tr key={row.id}>
                {cells.map((cell, ci) => {
                  const isHeader =
                    (payload?.has_column_header && ri === 0) ||
                    (payload?.has_row_header && ci === 0);
                  const Cell = isHeader ? "th" : "td";
                  return (
                    <Cell key={ci}>
                      <TableCell rowId={row.id} index={ci} items={cell} />
                    </Cell>
                  );
                })}
                {canEdit && (
                  <td className="hive-row-gutter">
                    <button
                      title="Add row below"
                      onClick={() => void addTableRow(block.id, row.id)}
                    >
                      +
                    </button>
                    {rows.length > 1 && (
                      <button
                        title="Delete row"
                        onClick={() => void deleteBlock(row.id)}
                      >
                        ×
                      </button>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {canEdit && (
        <div className="hive-table-controls">
          <button onClick={() => void addTableRow(block.id, rows[rows.length - 1]?.id ?? null)}>
            + row
          </button>
          <button onClick={() => void setTableColumns(block.id, 1)}>+ col</button>
          <button
            title="Removes the last column (rebuilds the table on Notion — anchored comments are lost)"
            onClick={() => void setTableColumns(block.id, -1)}
          >
            − col
          </button>
          <button
            className={payload?.has_column_header ? "on" : ""}
            onClick={() =>
              void updateTableSettings(block.id, {
                has_column_header: !payload?.has_column_header,
              })
            }
          >
            header row
          </button>
          <button
            className={payload?.has_row_header ? "on" : ""}
            onClick={() =>
              void updateTableSettings(block.id, {
                has_row_header: !payload?.has_row_header,
              })
            }
          >
            header col
          </button>
        </div>
      )}
    </div>
  );
}

/** Tier 2 — render-only (Phase 3); tables gained editable cells later. */
const TIER2: Record<string, BlockComponent> = {
  child_page: ({ block }) => <ChildPageCard block={block} />,
  image: ({ block }) => {
    const payload = block.image as {
      type?: string;
      external?: { url?: string };
      file?: { url?: string };
      caption?: RichTextItem[];
    };
    const url = payload?.external?.url ?? payload?.file?.url;
    if (!url) return <FallbackCard block={block} />;
    return (
      <figure className="hive-image">
        <img src={url} alt={payload.caption?.map((c) => c.plain_text).join("") || "image"} loading="lazy" />
        {payload.caption && payload.caption.length > 0 && (
          <figcaption>
            <RichText items={payload.caption} />
          </figcaption>
        )}
      </figure>
    );
  },

  table: ({ block }) => <SimpleTable block={block} />,

  toggle: ({ block }) => (
    <details className="hive-toggle">
      <summary>
        <RichText items={rich(block)} />
      </summary>
      <div className="hive-children">
        {block.children && <BlockList blocks={block.children} />}
      </div>
    </details>
  ),

  bookmark: ({ block }) => {
    const payload = block.bookmark as {
      url?: string;
      caption?: RichTextItem[];
    };
    if (!payload?.url) return <FallbackCard block={block} />;
    let host = payload.url;
    try {
      host = new URL(payload.url).hostname;
    } catch {
      /* keep raw */
    }
    return (
      <a className="hive-bookmark" href={payload.url} target="_blank" rel="noreferrer">
        <span className="host">🔗 {host}</span>
        <span className="url">{payload.url}</span>
        {payload.caption && payload.caption.length > 0 && (
          <span className="caption">
            <RichText items={payload.caption} />
          </span>
        )}
      </a>
    );
  },

  column_list: ({ block }) => (
    <div className="hive-columns">
      {(block.children ?? [])
        .filter((c) => c.type === "column")
        .map((col) => (
          <div className="hive-column" key={col.id}>
            {col.children && <BlockList blocks={col.children} />}
          </div>
        ))}
    </div>
  ),

  equation: ({ block }) => {
    const expression =
      (block.equation as { expression?: string })?.expression ?? "";
    return (
      <div
        className="hive-equation"
        dangerouslySetInnerHTML={{
          __html: katex.renderToString(expression, {
            displayMode: true,
            throwOnError: false,
          }),
        }}
      />
    );
  },
};

const RENDERERS: Record<string, BlockComponent> = { ...TIER1, ...TIER2 };

import { Component as ReactComponent } from "react";
import type { ErrorInfo, ReactNode as RN } from "react";

/** Real error boundary: a try/catch around createElement never fires —
 * React invokes components later. Malformed payloads degrade to the card. */
class BlockBoundary extends ReactComponent<
  { block: HiveBlock; children: RN },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(_e: Error, _i: ErrorInfo) {}
  componentDidUpdate(prev: { block: HiveBlock }) {
    if (prev.block !== this.props.block && this.state.failed) {
      this.setState({ failed: false });
    }
  }
  render() {
    if (this.state.failed) return <FallbackCard block={this.props.block} />;
    return this.props.children;
  }
}

function SafeBlock({ block }: { block: HiveBlock }) {
  const Component = RENDERERS[block.type];
  if (!Component) return <FallbackCard block={block} />;
  return (
    <BlockBoundary block={block}>
      <Component block={block} />
    </BlockBoundary>
  );
}

/**
 * Renders a block sequence, grouping consecutive list items into real
 * <ul>/<ol> elements so numbered lists actually count.
 */
export function BlockList({ blocks }: { blocks: HiveBlock[] }) {
  const out: ReactNode[] = [];
  let i = 0;
  while (i < blocks.length) {
    const type = blocks[i].type;
    if (type === "bulleted_list_item" || type === "numbered_list_item") {
      const group: HiveBlock[] = [];
      while (i < blocks.length && blocks[i].type === type) {
        group.push(blocks[i]);
        i += 1;
      }
      const items = group.map((b) => <SafeBlock key={b.id} block={b} />);
      out.push(
        type === "numbered_list_item" ? (
          <ol key={group[0].id}>{items}</ol>
        ) : (
          <ul key={group[0].id}>{items}</ul>
        ),
      );
    } else {
      out.push(<SafeBlock key={blocks[i].id} block={blocks[i]} />);
      i += 1;
    }
  }
  return <>{out}</>;
}
