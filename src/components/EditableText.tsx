import { useContext, useEffect, useRef, useState } from "react";
import { dlog } from "../lib/debugLog";
import { searchUsers, userMentionItem, workspaceUsers } from "../lib/users";
import type { WorkspaceUser } from "../lib/users";
import { MentionInput } from "./MentionInput";
import { ReadOnlyContext } from "./BlockRenderer";
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

/** Block id embedded in a discussion:// url (discussion://page/BLOCK/id). */
function threadBlockId(threadId: string): string | null {
  return threadId.split("/")[3] ?? null;
}

/** Notion-style margin indicator on blocks that carry comment threads.
 * Lives OUTSIDE the contentEditable div so the rich-text round-trip never
 * sees it. Click → open the panel focused on this block's first thread. */
function CommentDot({ blockId }: { blockId: string }) {
  // primitive selector — a filtered array would re-render on every store tick
  const count = useAppStore(
    (s) =>
      s.commentThreads?.filter(
        (t) => t.comments.length > 0 && threadBlockId(t.id) === blockId,
      ).length ?? 0,
  );
  const focusThread = useAppStore((s) => s.focusThread);
  if (count === 0) return null;
  return (
    <button
      className="hive-comment-dot"
      contentEditable={false}
      title={`${count} comment thread${count > 1 ? "s" : ""} — click to view`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        const first = useAppStore
          .getState()
          .commentThreads?.find(
            (t) => t.comments.length > 0 && threadBlockId(t.id) === blockId,
          );
        if (first) focusThread(first.id);
      }}
    >
      💬{count > 1 ? count : ""}
    </button>
  );
}

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

/** Caret geometry helpers for cross-block arrow navigation. Each block is
 * its own contentEditable, so the browser can't walk the caret between
 * them — we detect edge lines and hand focus to the neighbouring block. */
function caretIsCollapsed(): boolean {
  const sel = window.getSelection();
  return !!sel && sel.isCollapsed && sel.rangeCount > 0;
}

function caretRect(): DOMRect | null {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return null;
  const r = sel.getRangeAt(0).cloneRange();
  r.collapse(true);
  const rects = r.getClientRects();
  return rects.length ? rects[0] : null;
}

function caretAtStart(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return false;
  const r = document.createRange();
  r.selectNodeContents(el);
  r.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
  return r.toString().length === 0;
}

function caretAtEnd(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return false;
  const r = document.createRange();
  r.selectNodeContents(el);
  r.setStart(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
  return r.toString().length === 0;
}

function caretOnFirstLine(el: HTMLElement): boolean {
  const cr = caretRect();
  if (!cr) return true; // empty block
  return cr.top - el.getBoundingClientRect().top < 10;
}

function caretOnLastLine(el: HTMLElement): boolean {
  const cr = caretRect();
  if (!cr) return true;
  return el.getBoundingClientRect().bottom - cr.bottom < 10;
}

/** Move focus to the adjacent editable block, placing the caret at the far
 * edge so it reads as one continuous document. Returns false if none. */
function focusAdjacentEditable(current: HTMLElement, dir: "prev" | "next"): boolean {
  const all = [...document.querySelectorAll<HTMLElement>(".hive-editable")];
  const i = all.indexOf(current);
  const target = dir === "prev" ? all[i - 1] : all[i + 1];
  if (!target) return false;
  target.focus({ preventScroll: true });
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(target);
  range.collapse(dir === "next"); // next → caret at START, prev → at END
  sel?.removeAllRanges();
  sel?.addRange(range);
  target.scrollIntoView({ block: "nearest" });
  return true;
}

/** The `@name` under the caret, if any — "@" must start a word. */
function mentionContext(): {
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
  // word-boundary @ so emails ("x@y") don't trigger; query may span a space
  // (first + last name) but not two
  const match = /(?:^|\s)@([A-Za-z0-9][A-Za-z0-9._-]*(?: [A-Za-z0-9._-]*)?)?$/.exec(upto);
  if (!match) return null;
  const full = `@${match[1] ?? ""}`;
  return {
    node,
    start: range.startOffset - full.length,
    end: range.startOffset,
    query: match[1] ?? "",
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
  { label: "Database (table view)", type: "database", keywords: "database table view db" },
];

/** Notion's color palette for ⌘⇧H; `_background` variants highlight. */
const COLOR_OPTIONS = [
  "default", "gray", "brown", "orange", "yellow", "green", "blue", "purple",
  "pink", "red", "yellow_background", "green_background", "blue_background",
  "red_background",
];

function wrapSelection(makeEl: () => HTMLElement) {
  const sel = window.getSelection();
  if (!sel?.rangeCount || sel.isCollapsed) return false;
  const range = sel.getRangeAt(0);
  try {
    range.surroundContents(makeEl());
    sel.removeAllRanges();
    return true;
  } catch {
    return false; // selection spans nodes — skip rather than corrupt
  }
}

/** Inline markdown that converts on the closing character (Notion). */
const INLINE_MD: { re: RegExp; tag: string }[] = [
  { re: /\*\*([^*\n]+)\*\*$/, tag: "b" },
  { re: /(?:^|[^*])\*([^*\n]+)\*$/, tag: "i" },
  { re: /`([^`\n]+)`$/, tag: "code" },
  { re: /~([^~\n]+)~$/, tag: "s" },
];

function tryInlineMarkdown(): boolean {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return false;
  const range = sel.getRangeAt(0);
  if (!range.collapsed || range.startContainer.nodeType !== Node.TEXT_NODE) return false;
  const node = range.startContainer as Text;
  const text = node.textContent ?? "";
  const upto = text.slice(0, range.startOffset);
  for (const { re, tag } of INLINE_MD) {
    const m = re.exec(upto);
    if (!m) continue;
    // the delimited region only ("*x*" — the italic regex may capture a lead char)
    const delim = tag === "i" ? `*${m[1]}*` : m[0];
    const start = range.startOffset - delim.length;
    const el = document.createElement(tag);
    el.textContent = m[1];
    const tail = document.createTextNode(text.slice(range.startOffset));
    node.textContent = text.slice(0, start);
    const parent = node.parentNode;
    if (!parent) return false;
    parent.insertBefore(el, node.nextSibling);
    parent.insertBefore(tail, el.nextSibling);
    const newRange = document.createRange();
    newRange.setStart(tail, 0);
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);
    return true;
  }
  return false;
}

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
  const readOnly = useContext(ReadOnlyContext);
  const canEdit = useAppStore((s) => s.canEdit()) && !readOnly;
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
  const [mentionMenu, setMentionMenu] = useState<{ query: string; index: number } | null>(null);
  const [people, setPeople] = useState<WorkspaceUser[]>([]);
  const mentionMatches = mentionMenu ? searchUsers(people, mentionMenu.query) : [];
  useEffect(() => {
    if (mentionMenu && people.length === 0) {
      void workspaceUsers().then(setPeople).catch(() => undefined);
    }
  }, [mentionMenu, people.length]);
  const [linkInput, setLinkInput] = useState(false);
  const [colorMenu, setColorMenu] = useState(false);
  const [commentInput, setCommentInput] = useState(false);
  const [toolbar, setToolbar] = useState<{ x: number; y: number } | null>(null);
  const savedRange = useRef<Range | null>(null);

  const updateToolbar = () => {
    const sel = window.getSelection();
    const el = ref.current;
    if (
      !sel || sel.rangeCount === 0 || sel.isCollapsed || !el ||
      !el.contains(sel.anchorNode)
    ) {
      setToolbar(null);
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    setToolbar({ x: rect.left + rect.width / 2, y: rect.top });
  };

  const saveSelection = () => {
    const sel = window.getSelection();
    if (sel?.rangeCount && !sel.isCollapsed) {
      savedRange.current = sel.getRangeAt(0).cloneRange();
      return true;
    }
    return false;
  };
  const restoreSelection = () => {
    const sel = window.getSelection();
    if (savedRange.current && sel) {
      sel.removeAllRanges();
      sel.addRange(savedRange.current);
    }
  };

  const applyLink = (url: string) => {
    setLinkInput(false);
    restoreSelection();
    if (url.trim()) document.execCommand("createLink", false, url.trim());
    else document.execCommand("unlink");
    ref.current?.focus();
  };

  const applyColor = (color: string) => {
    setColorMenu(false);
    restoreSelection();
    if (color === "default") {
      document.execCommand("removeFormat"); // strips spans; close enough for reset
    } else {
      wrapSelection(() => {
        const span = document.createElement("span");
        span.dataset.color = color;
        return span;
      });
    }
    localStorage.setItem("hive-last-color", color);
    ref.current?.focus();
  };

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
  // (slash/emoji menus) re-rendered the component. The dirty flag guards the
  // other direction: never sync FROM the model while the DOM holds
  // uncommitted edits (e.g. focus moved to the ⌘K popover before commit).
  const dirty = useRef(false);
  // WebKit normalizes assigned HTML (quote entities, attribute order), so
  // comparing el.innerHTML against our canonical string is ALWAYS unequal
  // for some content — which rewrote those blocks on every render, killing
  // any caret inside. Track what WE last synced instead.
  const lastSynced = useRef<string | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || document.activeElement === el || dirty.current) return;
    // WKWebView can leave activeElement on <body> while the caret genuinely
    // sits in this block — selection containment is the reliable signal.
    const sel = window.getSelection();
    if (sel?.anchorNode && el.contains(sel.anchorNode)) return;
    const html = canonical(items);
    if (lastSynced.current !== html) {
      dlog(`SYNC-REWRITE #${block.id.slice(0, 8)} active=${document.activeElement?.nodeName}`);
      el.innerHTML = html;
      lastSynced.current = html;
    }
  });

  // Focus requests: the paragraph just created by Enter, or this block
  // remounting after an id remap while the user was typing in it. Plain
  // .focus() parks the caret at the START — put it at the end, where the
  // typist left off.
  useEffect(() => {
    if (focusBlockId === block.id && ref.current) {
      const el = ref.current;
      el.focus();
      if (el.childNodes.length > 0) {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      setFocusBlock(null);
    }
  }, [focusBlockId, block.id, setFocusBlock]);

  // The store asks us to commit before it remaps this block's id (the key
  // change remounts the editor — uncommitted text must reach the model first).
  useEffect(() => {
    const onCommitRequest = (e: Event) => {
      if ((e as CustomEvent).detail === block.id) commitRef.current();
    };
    window.addEventListener("hive-commit-block", onCommitRequest);
    return () => window.removeEventListener("hive-commit-block", onCommitRequest);
  }, [block.id]);

  // Non-text runs (mentions, equations) render as atomic chips inside the
  // editable — richTextToHtml serializes them into data-exotic spans that
  // htmlToRichText restores verbatim, so editing around them is safe.
  if (!canEdit) return <RichText items={items} />;

  const commit = () => {
    const el = ref.current;
    if (!el) return;
    dirty.current = false;
    const parsed = htmlToRichText(el.innerHTML);
    const next = canonical(parsed);
    if (next !== canonical(items)) {
      lastSynced.current = next; // DOM already shows this — don't re-sync
      void editBlockText(block.id, block.type, parsed);
    }
  };

  const commitRef = useRef(() => {});
  commitRef.current = commit;

  const pickSlash = (type: string) => {
    setSlash(null);
    if (ref.current) ref.current.innerHTML = "";
    if (type === "database") {
      void useAppStore.getState().createDatabaseInline(block.id);
      return;
    }
    void convertBlock(block.id, type);
  };

  const insertMention = (user: WorkspaceUser) => {
    const ctx = mentionContext();
    setMentionMenu(null);
    if (!ctx) return;
    const item = userMentionItem(user);
    const text = ctx.node.textContent ?? "";
    const chip = document.createElement("span");
    chip.className = "hive-exotic";
    chip.contentEditable = "false";
    chip.dataset.exotic = JSON.stringify(item);
    chip.textContent = `@${user.name}`;
    const before = document.createTextNode(text.slice(0, ctx.start));
    const after = document.createTextNode(` ${text.slice(ctx.end)}`);
    const parent = ctx.node.parentNode;
    if (!parent) return;
    parent.replaceChild(after, ctx.node);
    parent.insertBefore(chip, after);
    parent.insertBefore(before, chip);
    const sel = window.getSelection();
    const range = document.createRange();
    range.setStart(after, 1);
    range.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(range);
    dirty.current = true;
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

    if (colorMenu && e.key === "Escape") {
      e.preventDefault();
      setColorMenu(false);
      return;
    }

    // @mention completion menu
    if (mentionMenu && mentionMatches.length > 0) {
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insertMention(mentionMatches[mentionMenu.index]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionMenu(null);
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        setMentionMenu((prev) =>
          prev && {
            ...prev,
            index: (prev.index + delta + mentionMatches.length) % mentionMatches.length,
          },
        );
        return;
      }
    }

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

    // Cross-block caret navigation: blocks are separate contentEditables,
    // so the browser stops the caret at each block's edge. Carry it into
    // the neighbour when an arrow would otherwise dead-end.
    if (
      !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey &&
      ref.current &&
      caretIsCollapsed()
    ) {
      const el = ref.current;
      if (e.key === "ArrowUp" && caretOnFirstLine(el)) {
        if (focusAdjacentEditable(el, "prev")) { e.preventDefault(); return; }
      } else if (e.key === "ArrowDown" && caretOnLastLine(el)) {
        if (focusAdjacentEditable(el, "next")) { e.preventDefault(); return; }
      } else if (e.key === "ArrowLeft" && caretAtStart(el)) {
        if (focusAdjacentEditable(el, "prev")) { e.preventDefault(); return; }
      } else if (e.key === "ArrowRight" && caretAtEnd(el)) {
        if (focusAdjacentEditable(el, "next")) { e.preventDefault(); return; }
      }
    }

    // inline formatting (Notion parity: ⌘B/I/U, ⌘⇧S strike, ⌘E code)
    if ((e.metaKey || e.ctrlKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "b" && !e.shiftKey) { e.preventDefault(); document.execCommand("bold"); return; }
      if (k === "i" && !e.shiftKey) { e.preventDefault(); document.execCommand("italic"); return; }
      if (k === "u" && !e.shiftKey) { e.preventDefault(); document.execCommand("underline"); return; }
      if (k === "s" && e.shiftKey) { e.preventDefault(); document.execCommand("strikeThrough"); return; }
      if (k === "e" && !e.shiftKey) { e.preventDefault(); wrapInlineCode(); return; }
      if (k === "k" && !e.shiftKey) {
        // ⌘K link input (only with a selection; otherwise the command bar owns ⌘K)
        if (saveSelection()) {
          e.preventDefault();
          e.stopPropagation();
          setLinkInput(true);
        }
        return;
      }
      if (k === "h" && e.shiftKey) {
        e.preventDefault();
        // Opens the palette (last-used color listed first). Slight deviation
        // from Notion's instant re-apply, but never a dead end.
        if (saveSelection()) setColorMenu(true);
        return;
      }
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
      if (e.key === "Enter" && slashMatches.length > 0) {
        e.preventDefault();
        const option = slashMatches[slash.index];
        if (option) pickSlash(option.type);
        return;
      }
      if (e.key === "Enter") {
        setSlash(null); // no matches: let Enter behave normally below
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

    // Tab / ⇧Tab indent-outdent; ⌘⇧↑/↓ move block (recreate trick)
    if (e.key === "Tab") {
      e.preventDefault();
      commit();
      void (e.shiftKey
        ? useAppStore.getState().outdentBlock(block.id)
        : useAppStore.getState().indentBlock(block.id));
      return;
    }
    if (e.metaKey && e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      commit();
      void useAppStore.getState().moveBlock(block.id, e.key === "ArrowUp" ? "up" : "down");
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
      void deleteBlock(block.id, { focusPrevious: true, silent: true });
    } else if (e.key === "Escape") {
      ref.current?.blur();
    }
  };

  return (
    <span className="hive-editable-wrap">
      <CommentDot blockId={block.id} />
      <div
        ref={ref}
        className="hive-editable"
        data-bid={block.id}
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        data-placeholder={block.type === "paragraph" ? "Type, or / for blocks…" : "Type…"}
        onBlur={() => {
          setToolbar(null);
          if (linkInput || commentInput) return; // focus moved into our popover
          setSlash(null);
          setEmojiMenu(null);
          setColorMenu(false);
          commit();
        }}
        onKeyDown={onKeyDown}
        onMouseUp={(e) => {
          // WKWebView responder guard: a click can place the caret without
          // moving activeElement off <body>. Re-assert focus so the sync
          // guard and blur/commit lifecycle see this block as active — but
          // .focus() collapses the selection to the element start in WebKit,
          // so capture the click's caret first and restore it after.
          const el = e.currentTarget;
          if (document.activeElement !== el) {
            const sel = window.getSelection();
            const saved =
              sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
            el.focus({ preventScroll: true });
            if (saved) {
              sel!.removeAllRanges();
              sel!.addRange(saved);
            }
          }
          updateToolbar();
        }}
        onKeyUp={(e) => {
          if (e.shiftKey || toolbar) updateToolbar();
        }}
        onFocus={(e) => {
          if (useAppStore.getState().focusMode) {
            e.currentTarget.scrollIntoView({ block: "center", behavior: "smooth" });
          }
        }}
        onInput={(e) => {
          dirty.current = true;
          // inline markdown converts on the closing character (Notion)
          tryInlineMarkdown();
          // :emoji: completion (Notion shows the menu after 2+ chars)
          const ctx = emojiContext();
          setEmojiMenu(
            ctx && ctx.query.length >= 2
              ? { query: ctx.query, index: 0 }
              : null,
          );
          // @mention completion (opens on the @ itself, like Notion)
          const mctx = mentionContext();
          setMentionMenu(mctx ? { query: mctx.query, index: 0 } : null);
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
      {toolbar && !linkInput && !colorMenu && !commentInput && (
        <div
          className="hive-seltoolbar"
          style={{ left: toolbar.x, top: toolbar.y }}
          onMouseDown={(e) => e.preventDefault() /* keep the selection */}
        >
          <button title="Bold (⌘B)" onClick={() => document.execCommand("bold")}><b>B</b></button>
          <button title="Italic (⌘I)" onClick={() => document.execCommand("italic")}><i>I</i></button>
          <button title="Underline (⌘U)" onClick={() => document.execCommand("underline")}><u>U</u></button>
          <button title="Strikethrough (⌘⇧S)" onClick={() => document.execCommand("strikeThrough")}><s>S</s></button>
          <button title="Inline code (⌘E)" onClick={() => wrapInlineCode()} className="mono">{"</>"}</button>
          <button title="Link (⌘K)" onClick={() => { if (saveSelection()) { setToolbar(null); setLinkInput(true); } }}>🔗</button>
          <button title="Color (⌘⇧H)" onClick={() => { if (saveSelection()) { setToolbar(null); setColorMenu(true); } }}>🎨</button>
          <button title="Comment on page (quotes selection)" onClick={() => { if (saveSelection()) { setToolbar(null); setCommentInput(true); } }}>💬</button>
        </div>
      )}
      {commentInput && (
        <div
          className="hive-slash-menu hive-link-input"
          onKeyDown={(e) => e.stopPropagation()}
        >
          <MentionInput
            autoFocus
            placeholder="Comment… (@ to mention; anchors to selection)"
            onSubmit={(value, mentions) => {
              const quote = savedRange.current?.toString() ?? "";
              setCommentInput(false);
              void useAppStore.getState().createComment(value, quote, mentions);
              ref.current?.focus();
            }}
            onCancel={() => setCommentInput(false)}
          />
          <button
            className="hive-comment-native"
            title="Open this page in the Notion app, where comments can anchor to the exact text"
            onMouseDown={(e) => {
              e.preventDefault(); // fire before the input's blur closes us
              setCommentInput(false);
              const pageId = useAppStore.getState().pageId;
              if (pageId) {
                void import("@tauri-apps/api/core").then((m) =>
                  m.invoke("open_in_notion", { pageId }),
                );
              }
            }}
          >
            Comment natively in Notion ↗
          </button>
        </div>
      )}
      {linkInput && (
        <div className="hive-slash-menu hive-link-input">
          <input
            className="hive-input"
            autoFocus
            placeholder="Paste a link… (empty removes)"
            onKeyDown={(e) => {
              if (e.key === "Enter") applyLink((e.target as HTMLInputElement).value);
              if (e.key === "Escape") setLinkInput(false);
              e.stopPropagation();
            }}
            onBlur={() => setLinkInput(false)}
          />
        </div>
      )}
      {colorMenu && (
        <div className="hive-slash-menu">
          {[
            localStorage.getItem("hive-last-color"),
            ...COLOR_OPTIONS,
          ]
            .filter((c, i, arr): c is string => Boolean(c) && arr.indexOf(c) === i)
            .map((color) => (
              <div
                key={color}
                className="hive-slash-row"
                onMouseDown={(e) => {
                  e.preventDefault();
                  applyColor(color);
                }}
              >
                <span
                  className="hive-color-dot"
                  data-color={color === "default" ? undefined : color}
                >
                  A
                </span>
                {color.replace("_", " ")}
              </div>
            ))}
        </div>
      )}
      {mentionMenu && mentionMatches.length > 0 && (
        <div className="hive-slash-menu">
          {mentionMatches.map((u, i) => (
            <div
              key={u.id}
              className={`hive-slash-row${i === mentionMenu.index ? " selected" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                insertMention(u);
              }}
            >
              <span style={{ marginRight: "0.5em" }}>👤</span>
              {u.name}
            </div>
          ))}
        </div>
      )}
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
