/**
 * Loosely-typed Notion shapes. The official SDK's block union is unwieldy for
 * a dispatch-table renderer; we keep the fields we rely on typed and leave the
 * per-block payload dynamic (the renderer must tolerate anything anyway —
 * fallback, never crash).
 */

export interface RichTextItem {
  type: string;
  plain_text: string;
  href: string | null;
  annotations: {
    bold: boolean;
    italic: boolean;
    strikethrough: boolean;
    underline: boolean;
    code: boolean;
    color: string;
  };
  [key: string]: unknown;
}

export interface HiveBlock {
  id: string;
  type: string;
  has_children: boolean;
  children?: HiveBlock[];
  [key: string]: unknown;
}

export interface PageData {
  page: Record<string, unknown>;
  blocks: HiveBlock[];
  fetchedAt: string;
  fromCache: boolean;
}
