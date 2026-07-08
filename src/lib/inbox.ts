import { notion } from "./notionClient";
import { enqueue, queueIdle } from "./queue";
import { listAllWatched } from "./orgDb";
import { DEMO_PAGE_ID } from "./demoPage";

/**
 * Notifications Tier B (PROJECT_PLAN §3.5): poll comments on watched pages
 * (favorites + pins), surface new ones — and @mentions of you — in a local
 * inbox. The API cannot read Notion\'s real notification inbox or resolve
 * threads; this is comment-stream change detection, read-state kept local.
 */

export interface InboxItem {
  id: string; // comment id
  pageId: string;
  kind: "comment" | "mention";
  author: string;
  snippet: string;
  createdAt: string;
}

const POLL_MS = 5 * 60 * 1000;
const MAX_PAGES_PER_CYCLE = 15;

const READ_KEY = "hive-inbox-read";
const readIds = new Set<string>(
  (() => { try { return JSON.parse(localStorage.getItem(READ_KEY) ?? "[]"); } catch { return []; } })(),
);
const items = new Map<string, InboxItem>();
let meId: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let offset = 0;

export function inboxItems(): InboxItem[] {
  return [...items.values()]
    .filter((i) => !readIds.has(i.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function markRead(id: string) {
  readIds.add(id);
  localStorage.setItem(READ_KEY, JSON.stringify([...readIds].slice(-2000)));
}

async function pollOnce(onChange: () => void) {
  if (!queueIdle()) return;
  const watched = await listAllWatched();
  const unique = [...new Set(watched.map((w) => w.notionPageId).filter((id) => id !== DEMO_PAGE_ID))];
  if (unique.length === 0) return;
  const start = offset % unique.length;
  const pageIds = [...unique.slice(start), ...unique.slice(0, start)].slice(0, MAX_PAGES_PER_CYCLE);
  offset += MAX_PAGES_PER_CYCLE;

  let changed = false;
  for (const pageId of pageIds) {
    try {
      const resp = (await enqueue(() =>
        notion().comments.list({ block_id: pageId, page_size: 50 }),
      )) as { results: Record<string, unknown>[] };
      for (const c of resp.results) {
        const id = c.id as string;
        if (items.has(id) || readIds.has(id)) continue;
        const rich = (c.rich_text ?? []) as {
          plain_text: string;
          type?: string;
          mention?: { type?: string; user?: { id?: string } };
        }[];
        const snippet = rich.map((t) => t.plain_text).join("").slice(0, 140);
        const mentioned = meId
          ? rich.some((t) => t.type === "mention" && t.mention?.user?.id === meId)
          : false;
        const author =
          ((c.created_by as { name?: string; id?: string }) ?? {}).name ?? "someone";
        items.set(id, {
          id, pageId,
          kind: mentioned ? "mention" : "comment",
          author,
          snippet,
          createdAt: (c.created_time as string) ?? new Date().toISOString(),
        });
        changed = true;
        if (mentioned && "Notification" in window && Notification.permission === "granted") {
          new Notification("Mentioned in Notion", { body: snippet });
        }
      }
    } catch { /* comments capability may be off for this integration */ }
  }
  if (changed) onChange();
}

export function startInbox(userId: string | null, onChange: () => void) {
  meId = userId;
  if (timer) return;
  if ("Notification" in window && Notification.permission === "default") {
    void Notification.requestPermission();
  }
  timer = setInterval(() => void pollOnce(onChange), POLL_MS);
  setTimeout(() => void pollOnce(onChange), 20_000);
}
