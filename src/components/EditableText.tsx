import { useEffect, useRef } from "react";
import { useAppStore } from "../store/appStore";
import { htmlToRichText, richTextToHtml } from "../lib/richTextHtml";
import { RichText } from "./RichText";
import type { HiveBlock, RichTextItem } from "../lib/types";

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
  const deleteBlock = useAppStore((s) => s.deleteBlock);
  const focusBlockId = useAppStore((s) => s.focusBlockId);
  const setFocusBlock = useAppStore((s) => s.setFocusBlock);
  const ref = useRef<HTMLDivElement>(null);

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

  if (!canEdit) return <RichText items={items} />;

  const commit = () => {
    const el = ref.current;
    if (!el) return;
    const parsed = htmlToRichText(el.innerHTML);
    if (canonical(parsed) !== canonical(items)) {
      void editBlockText(block.id, block.type, parsed);
    }
  };

  return (
    <div
      ref={ref}
      className="hive-editable"
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      data-placeholder="Type…"
      dangerouslySetInnerHTML={{ __html: canonical(items) }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          commit();
          void insertParagraphAfter(block.id);
        } else if (
          e.key === "Backspace" &&
          (ref.current?.textContent ?? "").length === 0
        ) {
          e.preventDefault();
          void deleteBlock(block.id);
        } else if (e.key === "Escape") {
          ref.current?.blur();
        }
      }}
    />
  );
}
