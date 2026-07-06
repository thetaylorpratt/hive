import type { ReactNode } from "react";
import katex from "katex";
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

function TodoBlock({ block }: { block: HiveBlock }) {
  const toggleTodo = useAppStore((s) => s.toggleTodo);
  const canEdit = useAppStore((s) => s.canEdit());
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

  heading_1: ({ block }) => (
    <h1 id={`hb-${block.id}`}>
      <EditableText block={block} items={rich(block)} />
    </h1>
  ),
  heading_2: ({ block }) => (
    <h2 id={`hb-${block.id}`}>
      <EditableText block={block} items={rich(block)} />
    </h2>
  ),
  heading_3: ({ block }) => (
    <h3 id={`hb-${block.id}`}>
      <EditableText block={block} items={rich(block)} />
    </h3>
  ),

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

/** Tier 2 — render-only (Phase 3). */
const TIER2: Record<string, BlockComponent> = {
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

  table: ({ block }) => {
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
                        <RichText items={cell} />
                      </Cell>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  },

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

function SafeBlock({ block }: { block: HiveBlock }) {
  const Component = RENDERERS[block.type];
  if (!Component) return <FallbackCard block={block} />;
  try {
    return <Component block={block} />;
  } catch {
    // Fallback, never crash — malformed payloads degrade to the Tier 3 card.
    return <FallbackCard block={block} />;
  }
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
