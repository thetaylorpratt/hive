import type { ReactNode } from "react";
import type { HiveBlock, RichTextItem } from "../lib/types";
import { RichText } from "./RichText";
import { FallbackCard } from "./FallbackCard";

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

/** Tier 1 — read-only in Phase 1. */
const TIER1: Record<string, BlockComponent> = {
  paragraph: ({ block }) => (
    <>
      <p>
        <RichText items={rich(block)} />
      </p>
      <Children block={block} />
    </>
  ),

  heading_1: ({ block }) => (
    <h1>
      <RichText items={rich(block)} />
    </h1>
  ),
  heading_2: ({ block }) => (
    <h2>
      <RichText items={rich(block)} />
    </h2>
  ),
  heading_3: ({ block }) => (
    <h3>
      <RichText items={rich(block)} />
    </h3>
  ),

  bulleted_list_item: ({ block }) => (
    <li>
      <RichText items={rich(block)} />
      <Children block={block} />
    </li>
  ),
  numbered_list_item: ({ block }) => (
    <li>
      <RichText items={rich(block)} />
      <Children block={block} />
    </li>
  ),

  to_do: ({ block }) => {
    const payload = block.to_do as { checked?: boolean } | undefined;
    const done = payload?.checked ?? false;
    return (
      <>
        <div className={`hive-todo${done ? " done" : ""}`}>
          <input type="checkbox" checked={done} disabled readOnly />
          <span>
            <RichText items={rich(block)} />
          </span>
        </div>
        <Children block={block} />
      </>
    );
  },

  quote: ({ block }) => (
    <blockquote className="hive-quote">
      <RichText items={rich(block)} />
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
          <RichText items={rich(block)} />
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

function SafeBlock({ block }: { block: HiveBlock }) {
  const Component = TIER1[block.type];
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
