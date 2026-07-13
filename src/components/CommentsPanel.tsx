import { useEffect, useReducer, useState } from "react";
import { ChatCircle, UserCircle } from "@phosphor-icons/react";
import { useAppStore } from "../store/appStore";
import { MentionInput } from "./MentionInput";
import { DEMO_PAGE_ID } from "../lib/demoPage";
import type { CommentThread } from "../lib/notionMcp";
import {
  markAllSeen,
  markFirstVisitIfNeeded,
  markThreadSeen,
  newReplyCount,
  subscribeSeen,
  threadBlockId,
} from "../lib/commentSeen";

/**
 * Right-hand comments panel: every discussion on the page (inline threads
 * included, via the personal MCP connection), with replies. Without the
 * personal connection it falls back to REST page-level comments and posts
 * as the bot with a name prefix.
 */

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const ms = Date.now() - t;
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return new Date(iso).toLocaleDateString();
}

/** Most recent comment's timestamp (ms), or 0 if unparseable/absent — used
 * only to order unread threads by newest activity. */
function lastActivity(thread: CommentThread): number {
  const last = thread.comments[thread.comments.length - 1];
  if (!last) return 0;
  const t = new Date(last.time).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** Unread threads first (newest activity desc), then the rest in their
 * existing order. Computed once per load — callers must NOT re-derive this
 * on every render, or the list would jump around as things get marked seen. */
function computeOrder(threads: CommentThread[]): CommentThread[] {
  const unread: { thread: CommentThread; activity: number }[] = [];
  const rest: CommentThread[] = [];
  for (const t of threads) {
    if (newReplyCount(t) > 0) unread.push({ thread: t, activity: lastActivity(t) });
    else rest.push(t);
  }
  unread.sort((a, b) => b.activity - a.activity);
  return [...unread.map((u) => u.thread), ...rest];
}

/** Strip "..." ellipsis markers from a text-context anchor snippet and
 * return its longest literal fragment — the piece most likely to survive
 * as a contiguous run of text inside the rendered block. */
function longestAnchorFragment(anchor: string): string {
  return anchor
    .split("...")
    .map((s) => s.trim())
    .filter(Boolean)
    .reduce((best, cur) => (cur.length > best.length ? cur : best), "");
}

/** Best-effort text-level highlight via the CSS Custom Highlight API. Never
 * touches the contentEditable DOM — only Range + CSS.highlights, or nothing
 * if the fragment can't be found in a single text node or the API is
 * unavailable. Returns a cleanup function, or null if nothing was applied. */
function tryHighlightAnchor(el: HTMLElement, anchor: string | null): (() => void) | null {
  if (!anchor) return null;
  if (typeof Highlight === "undefined" || typeof CSS === "undefined" || !CSS.highlights) {
    return null;
  }
  const fragment = longestAnchorFragment(anchor);
  if (!fragment) return null;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let range: Range | null = null;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.textContent ?? "";
    const idx = text.indexOf(fragment);
    if (idx >= 0) {
      range = new Range();
      range.setStart(node, idx);
      range.setEnd(node, idx + fragment.length);
      break;
    }
  }
  if (!range) return null;
  const highlight = new Highlight(range);
  CSS.highlights.set("hive-comment-anchor", highlight);
  return () => CSS.highlights.delete("hive-comment-anchor");
}

const BLOCK_FLASH_CLASS = "hive-comment-anchor-flash";
const BLOCK_FLASH_MS = 1600;

/** Click-to-anchor (the reverse of the block's 💬 indicator scrolling the
 * panel): find the block this thread is anchored to, scroll it into view,
 * flash its row, and best-effort highlight the commented text. */
function anchorToBlock(thread: CommentThread): void {
  const blockId = threadBlockId(thread.id);
  const el = blockId
    ? document.querySelector<HTMLElement>(`[data-bid="${CSS.escape(blockId)}"]`)
    : null;
  if (!el) {
    useAppStore.getState().showToast("That text is no longer on the page");
    return;
  }
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.add(BLOCK_FLASH_CLASS);
  const clearHighlight = tryHighlightAnchor(el, thread.anchor);
  setTimeout(() => {
    el.classList.remove(BLOCK_FLASH_CLASS);
    clearHighlight?.();
  }, BLOCK_FLASH_MS);
}

function Thread({ thread }: { thread: CommentThread }) {
  const users = useAppStore((s) => s.commentUsers);
  const replyToThread = useAppStore((s) => s.replyToThread);
  const [replying, setReplying] = useState(false);

  const newCount = newReplyCount(thread);
  const isBrandNew = newCount > 0 && newCount === thread.comments.length;
  const unseenFrom = newCount > 0 ? thread.comments.length - newCount : Infinity;

  const handleThreadClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest(".reply-row, .reply-link, button, textarea, input")) return;
    markThreadSeen(thread);
    anchorToBlock(thread);
  };

  return (
    <div
      className={`hive-comment-thread${newCount > 0 ? " unread" : ""}`}
      data-thread-id={thread.id}
      onClick={handleThreadClick}
    >
      {newCount > 0 && (
        <span className={`badge${isBrandNew ? " dot" : ""}`}>
          {isBrandNew ? "new thread" : `${newCount} new`}
        </span>
      )}
      {thread.anchor && (
        <div className="anchor" title="Commented text on the page">
          {thread.anchor.replace("...", " … ")}
        </div>
      )}
      {thread.comments.map((c, i) => (
        <div key={c.id} className={`comment${i >= unseenFrom ? " unseen" : ""}`}>
          <span className="who">
            <UserCircle size={15} weight="fill" />
            {users[c.authorId] ?? "…"}
            <span className="when">{c.time ? timeAgo(c.time) : ""}</span>
          </span>
          <div className="text">{c.text.replace(/\*{1,3}|__/g, "")}</div>
        </div>
      ))}
      {thread.reactions.length > 0 && (
        <div className="reactions" title="Reactions are read-only — the Notion API can't add them">
          {thread.reactions.map((r) => (
            <span key={r.emoji} className="chip">
              {r.emoji}
              {r.count > 1 && <span className="n">{r.count}</span>}
            </span>
          ))}
        </div>
      )}
      {thread.comments.length > 0 &&
        (replying ? (
        <div className="reply-row">
          <MentionInput
            placeholder="Reply… (@ to mention)"
            autoFocus
            withButton
            onSubmit={(text, mentions) => {
              setReplying(false);
              markThreadSeen(thread);
              void replyToThread(thread.id, text, mentions);
            }}
            onCancel={() => setReplying(false)}
          />
        </div>
      ) : (
        <button className="reply-link" onClick={() => setReplying(true)}>
          Reply
        </button>
      ))}
    </div>
  );
}

export function CommentsPanel() {
  const pageId = useAppStore((s) => s.pageId);
  const threads = useAppStore((s) => s.commentThreads);
  const loading = useAppStore((s) => s.commentsLoading);
  const mcpStatus = useAppStore((s) => s.mcpStatus);
  const loadComments = useAppStore((s) => s.loadComments);
  const createComment = useAppStore((s) => s.createComment);
  const connectPersonalNotion = useAppStore((s) => s.connectPersonalNotion);

  // Self-healing load: anything that nulls the threads (navigation, the
  // stale-page refresh swapping the doc underneath us) triggers a reload —
  // keyed on threads, not just pageId, so a refresh of the SAME page can't
  // leave the panel blank.
  useEffect(() => {
    if (pageId && threads === null && !loading) void loadComments();
  }, [pageId, threads, loading, loadComments]);

  // Force a re-render whenever seen-state mutates (mark-seen, mark-all,
  // first-visit) so badges/dots update live. Deliberately NOT a dependency
  // of the order below — reordering while the panel is open is jarring.
  const [, bumpSeenTick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeSeen(bumpSeenTick), []);

  // Compute display order exactly once per load (new `threads` reference) —
  // never re-derived from live seen-state, so clicking/replying can't
  // reshuffle the list out from under the user mid-session.
  const [orderedThreads, setOrderedThreads] = useState<CommentThread[]>([]);
  useEffect(() => {
    if (!threads || !pageId) {
      setOrderedThreads([]);
      return;
    }
    markFirstVisitIfNeeded(pageId, threads);
    setOrderedThreads(computeOrder(threads));
  }, [threads, pageId]);

  // A block's 💬 indicator was clicked — scroll its thread into view.
  const focusThreadId = useAppStore((s) => s.focusThreadId);
  useEffect(() => {
    if (!focusThreadId || !threads?.length) return;
    const el = document.querySelector(
      `[data-thread-id="${CSS.escape(focusThreadId)}"]`,
    );
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("flash");
    const t = setTimeout(() => {
      el.classList.remove("flash");
      useAppStore.setState({ focusThreadId: null });
    }, 1600);
    return () => clearTimeout(t);
  }, [focusThreadId, threads]);

  const realPage = pageId && pageId !== DEMO_PAGE_ID;

  // Recomputed on every render (cheap — a reduce over the thread list), so
  // it reflects seen-state immediately after a mark-seen/mark-all tick
  // without needing to be part of the (deliberately sticky) order above.
  const totalUnread = threads?.reduce((sum, t) => sum + newReplyCount(t), 0) ?? 0;

  return (
    <aside className="hive-comments">
      <div className="head">
        <ChatCircle size={16} weight="bold" /> Comments
        {threads && threads.length > 0 && <span className="count">{threads.length}</span>}
        {totalUnread > 0 && <span className="unread-chip">{totalUnread} new</span>}
        {totalUnread > 0 && (
          <button
            className="mark-all-read"
            onClick={() => threads && markAllSeen(threads)}
          >
            Mark all read
          </button>
        )}
      </div>

      {!realPage && <div className="empty">Open a Notion page to see its comments.</div>}
      {realPage && loading && !threads?.length && <div className="empty">Loading…</div>}
      {realPage && !loading && threads?.length === 0 && (
        <div className="empty">
          {mcpStatus === "connected"
            ? "No comments on this page yet."
            : "No page-level comments — and without your personal Notion connection, inline discussions on this page are invisible. Connect below to see everything."}
        </div>
      )}
      <div className="threads">
        {orderedThreads.map((t) => <Thread key={t.id} thread={t} />)}
      </div>

      {realPage && (
        <div className="composer">
          <MentionInput
            placeholder="Comment on this page… (@ to mention)"
            withButton
            onSubmit={(text, mentions) => void createComment(text, "", mentions)}
          />
        </div>
      )}

      <div className="identity">
        {mcpStatus === "connected" ? (
          // auth.userName is the bot's name (workspace-owned integration) —
          // the MCP token is the user's own identity, so say "you"
          <span className="as-you">Commenting as you (personal Notion connection)</span>
        ) : (
          <>
            <span className="as-bot">
              Posting as the integration bot (name prefixed).
            </span>
            <button
              className="hive-btn hive-btn-secondary"
              onClick={() => void connectPersonalNotion()}
              disabled={mcpStatus === "pending"}
            >
              {mcpStatus === "pending" ? "Waiting for approval…" : "Comment as you — connect Notion"}
            </button>
          </>
        )}
      </div>
    </aside>
  );
}
