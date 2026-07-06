import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../store/appStore";
import { htmlToRichText, richTextToHtml } from "../lib/richTextHtml";
import { RichText } from "./RichText";
import type { HiveBlock, RichTextItem } from "../lib/types";

/** Markdown block prefixes: typed at the start of a paragraph, then space. */
const AUTOFORMAT: Record<string, string> = {
  "#": "heading_1",
  "##": "heading_2",
  "###": "heading_3",
  "-": "bulleted_list_item",
  "*": "bulleted_list_item",
  "1.": "numbered_list_item",
  "[]": "to_do",
  ">": "quote",
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
  { label: "Callout", type: "callout", keywords: "callout info note" },
  { label: "Divider", type: "divider", keywords: "divider rule hr" },
  { label: "Code", type: "code", keywords: "code snippet" },
];

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

  const slashMatches = slash
    ? SLASH_OPTIONS.filter(
        (o) =>
          !slash.filter ||
          o.label.toLowerCase().includes(slash.filter) ||
          o.keywords.includes(slash.filter),
      )
    : [];

  // Keep DOM in sync with the model, but never clobber an active edit.
  useEffect(() => {
    const el = ref.current;
    if (!el || document.activeElement === el) return;
    const html = canonical(items);
    if (el.innerHTML !== html) el.innerHTML = html;
  }, [items]);

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

  const onKeyDown = (e: React.KeyboardEvent) => {
    const text = ref.current?.textContent ?? "";

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
        dangerouslySetInnerHTML={{ __html: canonical(items) }}
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
          // typewriter scroll: keep the caret's block vertically centered
          if (useAppStore.getState().focusMode) {
            e.currentTarget.scrollIntoView({ block: "center", behavior: "smooth" });
          }
        }}
      />
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
