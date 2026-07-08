import { useEffect, useState } from "react";
import { ArrowUp, ChatCircle, UserCircle } from "@phosphor-icons/react";
import { useAppStore } from "../store/appStore";
import { DEMO_PAGE_ID } from "../lib/demoPage";

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

function Thread({ thread }: { thread: import("../lib/notionMcp").CommentThread }) {
  const users = useAppStore((s) => s.commentUsers);
  const replyToThread = useAppStore((s) => s.replyToThread);
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState("");

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    setReplying(false);
    void replyToThread(thread.id, text);
  };

  return (
    <div className="hive-comment-thread">
      {thread.anchor && (
        <div className="anchor" title="Commented text on the page">
          {thread.anchor.replace("...", " … ")}
        </div>
      )}
      {thread.comments.map((c) => (
        <div key={c.id} className="comment">
          <span className="who">
            <UserCircle size={15} weight="fill" />
            {users[c.authorId] ?? "…"}
            <span className="when">{c.time ? timeAgo(c.time) : ""}</span>
          </span>
          <div className="text">{c.text.replace(/\*{1,3}|__/g, "")}</div>
        </div>
      ))}
      {replying ? (
        <div className="reply-row">
          <input
            className="hive-input"
            autoFocus
            placeholder="Reply…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") send();
              if (e.key === "Escape") setReplying(false);
            }}
          />
          <button className="hive-btn hive-btn-primary" onClick={send} title="Send">
            <ArrowUp size={14} weight="bold" />
          </button>
        </div>
      ) : (
        <button className="reply-link" onClick={() => setReplying(true)}>
          Reply
        </button>
      )}
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
  const [draft, setDraft] = useState("");

  // Reload when navigating with the panel open.
  useEffect(() => {
    if (pageId) void loadComments();
  }, [pageId, loadComments]);

  const realPage = pageId && pageId !== DEMO_PAGE_ID;
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    void createComment(text, "");
  };

  return (
    <aside className="hive-comments">
      <div className="head">
        <ChatCircle size={16} weight="bold" /> Comments
        {threads && threads.length > 0 && <span className="count">{threads.length}</span>}
      </div>

      {!realPage && <div className="empty">Open a Notion page to see its comments.</div>}
      {realPage && loading && !threads?.length && <div className="empty">Loading…</div>}
      {realPage && !loading && threads?.length === 0 && (
        <div className="empty">No comments on this page yet.</div>
      )}
      <div className="threads">
        {threads?.map((t) => <Thread key={t.id} thread={t} />)}
      </div>

      {realPage && (
        <div className="composer">
          <input
            className="hive-input"
            placeholder="Comment on this page…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
          />
          <button className="hive-btn hive-btn-primary" onClick={send} title="Send">
            <ArrowUp size={14} weight="bold" />
          </button>
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
