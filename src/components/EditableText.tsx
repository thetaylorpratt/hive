import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../store/appStore";
import { htmlToRichText, richTextToHtml } from "../lib/richTextHtml";
import { searchEmoji } from "../lib/emoji";
import { RichText } from "./RichText";
import type { HiveBlock, RichTextItem } from "../lib/types";

/** Notion's ⌘⌥<digit> block conversions (using e.code — ⌥ mutates e.key). */
const CMD_OPT_TYPES: Record<string, string> = {
  Digit0: "paragraph",
  Digit1: "heading_1",
  Digit2: "heading_2",
  Digit3: "heading_3",
  Digit4: "to_do",
  Digit5: "bulleted_list_item",
  Digit6: "numbered_list_item",
  Digit7: "toggle",
  Digit8: "code",
};

/** The `:shortcode` under the caret, if any. */
function emojiContext(): {
  node: Text;
  start: number;
  end: number;
  query: string;
} | null {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!range.collapsed || range.startContainer.nodeType !== Node.TEXT_NODE) {
    return null;
  }
  const node = range.startContainer as Text;
  const upto = (node.textContent ?? "").slice(0, range.startOffset);
  const match = /:([a-z0-9_+-]{1,30})$/i.exec(upto);
  if (!match) return null;
  return {
    node,
    start: range.startOffset - match[0].length,
    end: range.startOffset,
    query: match[1].toLowerCase(),
  };
}

/**
 * Markdown block prefixes: typed at the start of a paragraph, then space.
 * Matches Notion exactly (help docs): `>` is a TOGGLE, `"` is the quote,
 * `-`/`*`/`+` all bullet, `a.`/`i.` also start numbered lists.
 */
const AUTOFORMAT: Record<string, string> = {
  "#": "heading_1",
  "##": "heading_2",
  "###": "heading_3",
  "-": "bulleted_list_item",
  "*": "bulleted_list_item",
  "+": "bulleted_list_item",
  "1.": "numbered_list_item",
  "a.": "numbered_list_item",
  "i.": "numbered_list_item",
  "[]": "to_do",
  ">": "toggle",
  '"': "quote",
  "```": "code",
};

const SLASH_OPTIONS: { label: string; type: string; keywords: string }[] = [
  { label: "Text", type: "paragraph", keywords: "text paragraph plain" },
  { label: "Heading 1", type: "heading_1", keywords: "h1 heading title" },
  { label: "Heading 2", type: "heading_2", keywords: "h2 heading" },
  { label: "Heading 3", type: "heading_3", keywords: "h3 heading" },
  { label: "Bulleted list", type: "bulleted_list_item", keywords: "bullet ul list" },
  { label: "Numbered list", type: "numbered_list_item", keywords: "number ol list" },
  { label: "To-do", type: "to_do", keywords: "todo check task" },
  { label: "Quote", type: "quote", keywords: "quote blockquote" },
  { label: "Toggle", type: "toggle", keywords: "toggle collapse dropdown" },
  { label: "Table", type: "table", keywords: "table grid simple" },
  { label: "Callout", type: "callout", keywords: "callout info note" },
  { label: "Divider", type: "divider", keywords: "divider rule hr div" },
  { label: "Code", type: "code", keywords: "code snippet" },
];

function wrapInlineCode() {
  const sel = window.getSelection();
  if (!sel?.rangeCount || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  const code = document.createElement("code");
  try {
    range.surroundContents(code);
    sel.removeAllRanges();
  } catch {
    /* selection spans nodes — skip rather than corrupt */
  }
}

/** List-ish types where Enter-on-empty exits the list (Notion behavior). */
const LIST_TYPES = new Set([
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
  "toggle",
]);

/**
 * Inline editor for text-class blocks (write path v1). contentEditable with
 * HTML ⇄ rich-text round-trip: commit on blur, Enter inserts a paragraph
 * after, Backspace on an empty block deletes it. Falls back to static
 * RichText when the page isn't editable (real page, no token).
 */

const canonical = (items: RichTextItem[]) => richTextToHtml(items);

export function EditableText({
  block,
  items,
}: {
  block: HiveBlock;
  items: RichTextItem[];
}) {
  const canEdit = useAppStore((s) => s.canEdit());
  const editBlockText = useAppStore((s) => s.editBlockText);
  const insertParagraphAfter = useAppStore((s) => s.insertParagraphAfter);
  const convertBlock = useAppStore((s) => s.convertBlock);
  const deleteBlock = useAppStore((s) => s.deleteBlock);
  const focusBlockId = useAppStore((s) => s.focusBlockId);
  const setFocusBlock = useAppStore((s) => s.setFocusBlock);
  const ref = useRef<HTMLDivElement>(null);
  const [slash, setSlash] = useState<{ filter: string; index: number } | null>(null);
  const [emojiMenu, setEmojiMenu] = useState<{ query: string; index: number } | null>(null);
  const emojiMatches = emojiMenu ? searchEmoji(emojiMenu.query) : [];

  const slashMatches = slash
    ? SLASH_OPTIONS.filter(
        (o) =>
          !slash.filter ||
          o.label.toLowerCase().includes(slash.filter) ||
          o.keywords.includes(slash.filter),
      )
    : [];

  // Fully uncontrolled contentEditable: React never renders its children —
  // all content writes happen here (including initial mount). Rendering via
  // dangerouslySetInnerHTML wiped in-progress typing whenever local state
  // (slash/emoji menus) re-rendered the component.
  useEffect(() => {
    const el = ref.current;
    if (!el || document.activeElement === el) return;
    const html = canonical(items);
    if (el.innerHTML !== html) el.innerHTML = html;
  });

  // Focus requests (e.g. the paragraph just created by Enter).
  useEffect(() => {
    if (focusBlockId === block.id && ref.current) {
      ref.current.focus();
      setFocusBlock(null);
    }
  }, [focusBlockId, block.id, setFocusBlock]);

  // Blocks with non-text runs (inline equations, mentions) keep the static
  // renderer: the HTML round-trip would flatten them. Editing those blocks
  // stays a native-Notion job in v1.
  const hasExoticRuns = items.some((i) => i.type !== "text");
  if (!canEdit || hasExoticRuns) return <RichText items={items} />;

  const commit = () => {
    const el = ref.current;
    if (!el) return;
    const parsed = htmlToRichText(el.innerHTML);
    if (canonical(parsed) !== canonical(items)) {
      void editBlockText(block.id, block.type, parsed);
    }
  };

  const pickSlash = (type: string) => {
    setSlash(null);
    if (ref.current) ref.current.innerHTML = "";
    void convertBlock(block.id, type);
  };

  const insertEmoji = (char: string) => {
    const ctx = emojiContext();
    setEmojiMenu(null);
    if (!ctx) return;
    const t = ctx.node.textContent ?? "";
    ctx.node.textContent = t.slice(0, ctx.start) + char + t.slice(ctx.end);
    const sel = window.getSelection();
    const range = document.createRange();
    range.setStart(ctx.node, ctx.start + char.length);
    range.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(range);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const text = ref.current?.textContent ?? "";

    // :emoji: completion menu
    if (emojiMenu && emojiMatches.length > 0) {
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insertEmoji(emojiMatches[emojiMenu.index].char);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setEmojiMenu(null);
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        setEmojiMenu((prev) =>
          prev && {
            ...prev,
            index: (prev.index + delta + emojiMatches.length) % emojiMatches.length,
          },
        );
        return;
      }
      // other keys fall through — typing keeps filtering via onInput
    }

    // inline formatting (Notion parity: ⌘B/I/U, ⌘⇧S strike, ⌘E code)
    if ((e.metaKey || e.ctrlKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "b" && !e.shiftKey) { e.preventDefault(); document.execCommand("bold"); return; }
      if (k === "i" && !e.shiftKey) { e.preventDefault(); document.execCommand("italic"); return; }
      if (k === "u" && !e.shiftKey) { e.preventDefault(); document.execCommand("underline"); return; }
      if (k === "s" && e.shiftKey) { e.preventDefault(); document.execCommand("strikeThrough"); return; }
      if (k === "e" && !e.shiftKey) { e.preventDefault(); wrapInlineCode(); return; }
      if (k === "d" && !e.shiftKey) {
        e.preventDefault();
        commit();
        void useAppStore.getState().duplicateBlock(block.id);
        return;
      }
    }

    // ⌘⌥0-8 block conversions, preserving current text
    if (e.metaKey && e.altKey && CMD_OPT_TYPES[e.code]) {
      e.preventDefault();
      const richText = htmlToRichText(ref.current?.innerHTML ?? "");
      void convertBlock(block.id, CMD_OPT_TYPES[e.code], richText);
      return;
    }

    // slash menu: capture navigation + filter while open
    if (slash) {
      if (e.key === "Enter") {
        e.preventDefault();
        const option = slashMatches[slash.index];
        if (option) pickSlash(option.type);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlash(null);
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        setSlash((prev) =>
          prev && {
            ...prev,
            index:
              (prev.index + delta + slashMatches.length) %
              Math.max(1, slashMatches.length),
          },
        );
        return;
      }
      if (e.key === "Backspace") {
        setSlash((prev) =>
          prev?.filter ? { filter: prev.filter.slice(0, -1), index: 0 } : null,
        );
        return; // let the char delete happen in the block too
      }
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
        const ch = e.key.toLowerCase();
        setSlash((prev) => prev && { filter: prev.filter + ch, index: 0 });
        return; // char also types into the block; cleared on selection
      }
    }

    // open slash menu on "/" in an empty text-ish block
    if (e.key === "/" && text === "" && block.type === "paragraph") {
      setSlash({ filter: "", index: 0 });
      return; // the "/" types into the block; cleared on selection
    }

    // markdown autoformat: prefix + space at the start of a paragraph
    if (
      e.key === " " &&
      block.type === "paragraph" &&
      AUTOFORMAT[text] !== undefined
    ) {
      e.preventDefault();
      if (ref.current) ref.current.innerHTML = "";
      void convertBlock(block.id, AUTOFORMAT[text]);
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // Notion: Enter on an empty list item exits the list (becomes text)
      if (text === "" && LIST_TYPES.has(block.type)) {
        void convertBlock(block.id, "paragraph");
        return;
      }
      commit();
      void insertParagraphAfter(block.id);
    } else if (e.key === "Backspace" && text.length === 0) {
      e.preventDefault();
      void deleteBlock(block.id);
    } else if (e.key === "Escape") {
      ref.current?.blur();
    }
  };

  return (
    <span className="hive-editable-wrap">
      <div
        ref={ref}
        className="hive-editable"
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        data-placeholder={block.type === "paragraph" ? "Type, or / for blocks…" : "Type…"}
        onBlur={() => {
          if (!slash) commit();
        }}
        onKeyDown={onKeyDown}
        onFocus={(e) => {
          if (useAppStore.getState().focusMode) {
            e.currentTarget.scrollIntoView({ block: "center", behavior: "smooth" });
          }
        }}
        onInput={(e) => {
          // :emoji: completion (Notion shows the menu after 2+ chars)
          const ctx = emojiContext();
          setEmojiMenu(
            ctx && ctx.query.length >= 2
              ? { query: ctx.query, index: 0 }
              : null,
          );
          // '---' converts to a divider on the third hyphen (Notion)
          if (
            block.type === "paragraph" &&
            e.currentTarget.textContent === "---"
          ) {
            e.currentTarget.innerHTML = "";
            void convertBlock(block.id, "divider");
            return;
          }
          // typewriter scroll: keep the caret's block vertically centered
          if (useAppStore.getState().focusMode) {
            e.currentTarget.scrollIntoView({ block: "center", behavior: "smooth" });
          }
        }}
      />
      {emojiMenu && emojiMatches.length > 0 && (
        <div className="hive-slash-menu">
          {emojiMatches.map((m, i) => (
            <div
              key={m.name}
              className={`hive-slash-row${i === emojiMenu.index ? " selected" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                insertEmoji(m.char);
              }}
            >
              <span style={{ marginRight: "0.5em" }}>{m.char}</span>:{m.name}:
            </div>
          ))}
        </div>
      )}
      {slash && slashMatches.length > 0 && (
        <div className="hive-slash-menu">
          {slashMatches.map((option, i) => (
            <div
              key={option.type + option.label}
              className={`hive-slash-row${i === slash.index ? " selected" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                pickSlash(option.type);
              }}
            >
              {option.label}
            </div>
          ))}
        </div>
      )}
    </span>
  );
}
