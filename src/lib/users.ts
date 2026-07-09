import { notion } from "./notionClient";
import { enqueue } from "./queue";
import type { RichTextItem } from "./types";

/** Workspace people for @mentions (documents + comments), cached 10 min. */

export interface WorkspaceUser {
  id: string;
  name: string;
  avatar: string | null;
}

let cache: WorkspaceUser[] | null = null;
let fetchedAt = 0;
let inflight: Promise<WorkspaceUser[]> | null = null;

export function workspaceUsers(): Promise<WorkspaceUser[]> {
  if (cache && Date.now() - fetchedAt < 10 * 60_000) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = (async () => {
    const out: WorkspaceUser[] = [];
    let cursor: string | undefined;
    do {
      const resp = (await enqueue(() =>
        notion().users.list({ start_cursor: cursor, page_size: 100 }),
      )) as {
        results: { id: string; name?: string; type?: string; avatar_url?: string | null }[];
        has_more: boolean;
        next_cursor: string | null;
      };
      for (const u of resp.results) {
        if (u.type === "person" && u.name) {
          out.push({ id: u.id, name: u.name, avatar: u.avatar_url ?? null });
        }
      }
      cursor = resp.has_more ? (resp.next_cursor ?? undefined) : undefined;
    } while (cursor);
    cache = out;
    fetchedAt = Date.now();
    inflight = null;
    return out;
  })().catch((err) => {
    inflight = null;
    throw err;
  });
  return inflight;
}

export function searchUsers(users: WorkspaceUser[], query: string): WorkspaceUser[] {
  const q = query.trim().toLowerCase();
  const hits = q
    ? users.filter((u) => u.name.toLowerCase().includes(q))
    : users;
  return hits.slice(0, 6);
}

/** A person-mention rich-text item, ready for the editor chip round-trip. */
export function userMentionItem(user: WorkspaceUser): RichTextItem {
  return {
    type: "mention",
    plain_text: `@${user.name}`,
    href: null,
    annotations: {
      bold: false,
      italic: false,
      strikethrough: false,
      underline: false,
      code: false,
      color: "default",
    },
    mention: { type: "user", user: { id: user.id } },
  } as unknown as RichTextItem;
}
