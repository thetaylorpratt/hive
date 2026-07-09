/** Comment drafts with @mentions, converted per sink:
 *  - hosted MCP wants markdown with <mention-user url="user://ID"/> tags
 *  - REST comments.create wants rich_text with mention items */

export interface DraftMention {
  id: string;
  name: string;
}

export function draftToMarkdown(text: string, mentions: DraftMention[]): string {
  let md = text;
  for (const m of mentions) {
    md = md.split(`@${m.name}`).join(`<mention-user url="user://${m.id}"/>`);
  }
  return md;
}

export function draftToRichText(text: string, mentions: DraftMention[]): unknown[] {
  const items: unknown[] = [];
  let rest = text;
  while (rest.length > 0) {
    let idx = -1;
    let hit: DraftMention | null = null;
    for (const m of mentions) {
      const i = rest.indexOf(`@${m.name}`);
      if (i !== -1 && (idx === -1 || i < idx)) {
        idx = i;
        hit = m;
      }
    }
    if (!hit) {
      items.push({ text: { content: rest } });
      break;
    }
    if (idx > 0) items.push({ text: { content: rest.slice(0, idx) } });
    items.push({ type: "mention", mention: { user: { id: hit.id } } });
    rest = rest.slice(idx + hit.name.length + 1);
  }
  return items;
}
