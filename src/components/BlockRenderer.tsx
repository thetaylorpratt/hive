import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import katex from "katex";
import { htmlToRichText, richTextToHtml } from "../lib/richTextHtml";
import "katex/dist/katex.min.css";
import type { HiveBlock, RichTextItem } from "../lib/types";
import { RichText } from "./RichText";
import { EditableText } from "./EditableText";
import { FallbackCard } from "./FallbackCard";
import { DatabaseView } from "./DatabaseView";
import { useAppStore } from "../store/appStore";
import { EDITABLE_TYPES } from "../lib/writeback";
import { diffWords, type DiffEntry } from "../lib/blockDiff";
import { workspaceUsers } from "../lib/users";
import "../styles/diffbanner.css";

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

/*
 * Drag-to-move (Notion-style): top-level blocks only. Mirrors the sidebar's
 * drag lessons (Sidebar.tsx) — WKWebView's dataTransfer is unreliable, so the
 * dragged block's id lives module-side (isBlockDragging + draggedBlockId),
 * and dataTransfer carries a custom MIME plus a text/plain fallback anyway.
 * The dragend → "clear the drop line" handoff uses a window CustomEvent, the
 * same idiom appStore.ts uses for requestCommit — the handle that starts the
 * drag and the container that owns the drop-line state are different
 * components with no direct reference to each other.
 */
const BLOCK_DRAG_MIME = "application/x-hive-block";
let isBlockDragging = false;
let draggedBlockId: string | null = null;

/** Only text-class blocks with no children can be recreated elsewhere
 * without dropping content — see writeback.moveBlockTo's own guard. */
function isMovableBlock(block: HiveBlock): boolean {
  return EDITABLE_TYPES.has(block.type) && !block.children?.length;
}

function DragHandle({ blockId }: { blockId: string }) {
  return (
    <span
      className="hive-block-handle"
      draggable
      title="Drag to move"
      onDragStart={(e) => {
        isBlockDragging = true;
        draggedBlockId = blockId;
        e.dataTransfer.setData(BLOCK_DRAG_MIME, blockId);
        // WebKit fallback: drags carrying only a custom MIME have been
        // observed to arrive at the drop target with an empty dataTransfer.
        e.dataTransfer.setData("text/plain", blockId);
        e.dataTransfer.effectAllowed = "move";
        e.currentTarget.closest<HTMLElement>("[data-block-id]")?.classList.add(
          "hive-block-dragging",
        );
      }}
      onDragEnd={(e) => {
        isBlockDragging = false;
        draggedBlockId = null;
        e.currentTarget
          .closest<HTMLElement>("[data-block-id]")
          ?.classList.remove("hive-block-dragging");
        window.dispatchEvent(new CustomEvent("hive-block-dragend"));
      }}
    >
      ⋮⋮
    </span>
  );
}

/** Resolves a workspace user id to a display name, best-effort (silently
 * gives up on lookup failure — the popover just falls back to a generic
 * label). Shared by the diff chip's popover title. */
function useAuthorName(id: string | null): string | null {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    if (!id) {
      setName(null);
      return;
    }
    let cancelled = false;
    workspaceUsers()
      .then((users) => {
        if (cancelled) return;
        setName(users.find((u) => u.id === id)?.name ?? null);
      })
      .catch(() => {
        /* best-effort — chip still opens, just without a name */
      });
    return () => {
      cancelled = true;
    };
  }, [id]);
  return name;
}

/** Portal popover for the ± diff chip. Mirrors DatabaseView.tsx's Popover:
 * position:fixed computed from the anchor's rect, rendered into <body> so
 * the doc column's overflow (and any ancestor's) can't clip it — the same
 * WebKit lesson DatabaseView's comment documents. */
function DiffPopover({
  anchorRef,
  onClose,
  children,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
}) {
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const top = Math.min(r.bottom + 4, window.innerHeight - 60);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - 380));
    setPos({ top, left });
  }, [anchorRef]);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    };
    window.addEventListener("mousedown", away, true);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", away, true);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [anchorRef, onClose]);

  if (!pos) return null;
  return createPortal(
    <div
      ref={popRef}
      className="hive-diff-popover"
      style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 1000 }}
    >
      {children}
    </div>,
    document.body,
  );
}

/** The gutter ± chip for an edited block: opens a word-level diff popover.
 * Parked at -4.5em — clear of the drag handle (-1.7em / -3.1em in lists)
 * and the ::before bullet/number markers, which have collided before. */
function DiffChip({ entry }: { entry: DiffEntry }) {
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);
  const authorName = useAuthorName(entry.editedBy);
  const words = useMemo(
    () => diffWords(entry.oldText, entry.newText),
    [entry.oldText, entry.newText],
  );

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className="hive-diff-chip"
        title="Show changes"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        ±
      </button>
      {open && (
        <DiffPopover anchorRef={chipRef} onClose={() => setOpen(false)}>
          <div className="hive-diff-popover-title">Changed by {authorName ?? "someone else"}</div>
          <div className="hive-diff-popover-body">
            {words.map((w, i) => (
              <span key={i} className={`hive-diff-word-${w.type}`}>
                {w.text}
              </span>
            ))}
          </div>
        </DiffPopover>
      )}
    </>
  );
}

/** Wraps one top-level block with its gutter drag handle (movable types
 * only) and a stable data-block-id the container reads to compute drop
 * gaps. Never wraps the contentEditable element itself or anything inside
 * EditableText — this div sits alongside/around it, not inside it.
 *
 * Also carries the "changed since your last copy" highlight toggle (the
 * DiffBanner's "Show in doc" button): when on and this block appears in
 * the current page's diff, the row gets a subtle tint/border class, and
 * edited blocks get the ± chip. Classes go on this wrapper only — the
 * contentEditable DOM inside stays untouched. */
function TopRow({ block, children }: { block: HiveBlock; children: ReactNode }) {
  const pageId = useAppStore((s) => s.pageId);
  const showDiffHighlights = useAppStore((s) => s.showDiffHighlights);
  const entries = useAppStore((s) => (pageId ? s.pageDiffs[pageId]?.entries : undefined));
  const entry =
    showDiffHighlights && entries ? entries.find((e) => e.blockId === block.id) : undefined;
  const diffClass =
    entry?.kind === "added" ? " hive-diff-added" : entry?.kind === "edited" ? " hive-diff-edited" : "";

  return (
    <div className={`hive-toprow${diffClass}`} data-block-id={block.id}>
      {isMovableBlock(block) && <DragHandle blockId={block.id} />}
      {entry?.kind === "edited" && <DiffChip entry={entry} />}
      {children}
    </div>
  );
}

/** Container for the real, editable, top-level page tree: owns the
 * dragover/drop choreography and the single drop-indicator line. Gated on
 * canEdit + ReadOnlyContext exactly like EditableText itself, so preview/peek
 * panes and read-only split views never activate it. */
function TopLevelDropZone({ children }: { children: ReactNode }) {
  const readOnly = useContext(ReadOnlyContext);
  const canEdit = useAppStore((s) => s.canEdit()) && !readOnly;
  const dragMoveBlock = useAppStore((s) => s.dragMoveBlock);
  const containerRef = useRef<HTMLDivElement>(null);
  const [gap, setGap] = useState<{ afterId: string | null; y: number } | null>(null);

  useEffect(() => {
    const clear = () => setGap(null);
    window.addEventListener("hive-block-dragend", clear);
    return () => window.removeEventListener("hive-block-dragend", clear);
  }, []);

  if (!canEdit) return <>{children}</>;

  const computeGap = (clientY: number): { afterId: string | null; y: number } | null => {
    const container = containerRef.current;
    if (!container) return null;
    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-block-id]"));
    if (!rows.length) return null;
    let idx = rows.findIndex(
      (r) => clientY < r.getBoundingClientRect().top + r.getBoundingClientRect().height / 2,
    );
    if (idx === -1) idx = rows.length;
    const draggedIdx = draggedBlockId
      ? rows.findIndex((r) => r.dataset.blockId === draggedBlockId)
      : -1;
    // Adjacent to the dragged block itself on either side = identity move.
    if (draggedIdx !== -1 && (idx === draggedIdx || idx === draggedIdx + 1)) {
      return null;
    }
    const containerTop = container.getBoundingClientRect().top;
    const afterId = idx === 0 ? null : (rows[idx - 1].dataset.blockId ?? null);
    const y =
      idx === 0
        ? rows[0].getBoundingClientRect().top - containerTop
        : rows[idx - 1].getBoundingClientRect().bottom - containerTop;
    return { afterId, y };
  };

  return (
    <div
      ref={containerRef}
      className="hive-toplevel-dnd"
      onDragEnter={(e) => {
        if (isBlockDragging) e.preventDefault();
      }}
      onDragOver={(e) => {
        // Always preventDefault while a drag we started is in flight — do
        // not trust dataTransfer.types (WKWebView reports UTI strings, not
        // MIME, during dragover).
        if (!isBlockDragging) return;
        e.preventDefault();
        setGap(computeGap(e.clientY));
      }}
      onDrop={(e) => {
        if (!isBlockDragging) return;
        e.preventDefault();
        e.stopPropagation();
        const blockId = draggedBlockId;
        const activeGap = gap;
        setGap(null);
        if (blockId && activeGap) {
          void dragMoveBlock(blockId, activeGap.afterId);
        }
      }}
    >
      {children}
      {gap && <div className="hive-block-droptarget" style={{ top: gap.y }} />}
    </div>
  );
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
  const moveTableRow = useAppStore((s) => s.moveTableRow);
  const moveTableColumn = useAppStore((s) => s.moveTableColumn);
  const payload = block.table as {
    table_width?: number;
    has_column_header?: boolean;
    has_row_header?: boolean;
  };
  const rows = (block.children ?? []).filter((c) => c.type === "table_row");
  const width = payload?.table_width ?? 2;
  return (
    <div className="hive-table-wrap">
      <table className="hive-table">
        {canEdit && (
          <thead>
            <tr className="hive-col-gutter-row">
              {Array.from({ length: width }, (_, ci) => (
                <th key={ci}>
                  <span className="hive-col-gutter">
                    <button
                      title="Move column left"
                      disabled={ci === 0}
                      onClick={() => void moveTableColumn(block.id, ci, "left")}
                    >
                      ‹
                    </button>
                    <button
                      title="Move column right"
                      disabled={ci === width - 1}
                      onClick={() => void moveTableColumn(block.id, ci, "right")}
                    >
                      ›
                    </button>
                  </span>
                </th>
              ))}
              <th />
            </tr>
          </thead>
        )}
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
                      title="Move row up"
                      disabled={ri === 0}
                      onClick={() => void moveTableRow(block.id, row.id, "up")}
                    >
                      ↑
                    </button>
                    <button
                      title="Move row down"
                      disabled={ri === rows.length - 1}
                      onClick={() => void moveTableRow(block.id, row.id, "down")}
                    >
                      ↓
                    </button>
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
          <button
            className="danger"
            title="Delete this table"
            onClick={() => void deleteBlock(block.id)}
          >
            🗑 delete table
          </button>
        </div>
      )}
    </div>
  );
}

/** Tier 2 — render-only (Phase 3); tables gained editable cells later. */
const TIER2: Record<string, BlockComponent> = {
  child_page: ({ block }) => <ChildPageCard block={block} />,
  // block id IS the database id for a child_database block.
  child_database: ({ block }) => <DatabaseView databaseId={block.id} />,
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
 * Builds a block sequence, grouping consecutive list items into real
 * <ul>/<ol> elements so numbered lists actually count. When `topLevel`,
 * every entry (including each item inside a grouped list) is wrapped in a
 * TopRow so it can carry a drag handle and register itself for drop-gap
 * detection.
 */
function buildBlockNodes(blocks: HiveBlock[], topLevel: boolean): ReactNode[] {
  const out: ReactNode[] = [];
  const renderOne = (b: HiveBlock) =>
    topLevel ? (
      <TopRow key={b.id} block={b}>
        <SafeBlock block={b} />
      </TopRow>
    ) : (
      <SafeBlock key={b.id} block={b} />
    );
  let i = 0;
  while (i < blocks.length) {
    const type = blocks[i].type;
    if (type === "bulleted_list_item" || type === "numbered_list_item") {
      const group: HiveBlock[] = [];
      while (i < blocks.length && blocks[i].type === type) {
        group.push(blocks[i]);
        i += 1;
      }
      const items = group.map((b) => renderOne(b));
      out.push(
        type === "numbered_list_item" ? (
          <ol key={group[0].id}>{items}</ol>
        ) : (
          <ul key={group[0].id}>{items}</ul>
        ),
      );
    } else {
      out.push(renderOne(blocks[i]));
      i += 1;
    }
  }
  return out;
}

/**
 * Renders a block sequence. Drag-to-move only activates for the real,
 * editable page tree (App.tsx's own top-level `<BlockList blocks={page.blocks} />`
 * call) — everything else (Children, toggle bodies, columns, the peek
 * preview, split-pane) must never get a handle, since dragMoveBlock mutates
 * the currently *open* page's top-level block array specifically.
 *
 * There's no `topLevel` prop to flip: App.tsx, PeekLayer.tsx and SplitPane.tsx
 * are outside this component's file, so instead this detects "is this
 * literally the live open page's block array" by reference — `page.blocks`
 * is the exact array App.tsx passes down un-cloned, while every other
 * caller (nested children/toggle/column arrays, the peek's `.slice()` copy,
 * split-pane's independently-fetched data) can never be `===` to it.
 */
export function BlockList({ blocks }: { blocks: HiveBlock[] }) {
  const livePageBlocks = useAppStore((s) => s.page?.blocks);
  const topLevel = blocks === livePageBlocks;
  const out = buildBlockNodes(blocks, topLevel);
  if (!topLevel) return <>{out}</>;
  return <TopLevelDropZone>{out}</TopLevelDropZone>;
}
