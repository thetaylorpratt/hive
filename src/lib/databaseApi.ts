import { notion } from "./notionClient";
import { enqueue } from "./queue";
import { pageEmoji } from "./pageMeta";

/**
 * Database (table view) read/write API (DB_SPEC.md).
 *
 * SDK v5.22.0 splits the old "database" object in two: `databases` holds
 * identity (title, icon, parent, `data_sources: [{id,name}]`); the schema
 * (`properties`) and rows only live under `dataSources`, keyed by
 * `data_source_id`. Every read here follows that split: retrieve the
 * database for identity, then `data_sources[0]` for schema + rows. Writes to
 * rows are plain page writes; writes to schema (columns/options) go through
 * `dataSources.update`.
 */

export interface DbOption {
  id?: string;
  name: string;
  color?: string;
}

export interface DbColumn {
  id: string;
  name: string;
  type: string;
  options?: DbOption[];
}

export interface DbSchema {
  databaseId: string;
  dataSourceId: string;
  title: string;
  icon: string | null;
  columns: DbColumn[];
  titleColumnName: string;
}

export interface DbRow {
  pageId: string;
  icon: string | null;
  properties: Record<string, unknown>;
}

export interface DbData {
  schema: DbSchema;
  rows: DbRow[];
  hasMore: boolean;
  cursor: string | null;
}

export type PropertyDraft =
  | { kind: "text"; text: string }
  | { kind: "number"; n: number | null }
  | { kind: "checkbox"; b: boolean }
  | { kind: "select"; name: string | null }
  | { kind: "multi_select"; names: string[] }
  | { kind: "date"; startIso: string | null }
  | { kind: "link"; s: string | null };

export const EDITABLE_COLUMN_TYPES: Set<string> = new Set([
  "title",
  "rich_text",
  "number",
  "select",
  "status",
  "multi_select",
  "date",
  "checkbox",
  "url",
  "email",
  "phone_number",
]);

export const CREATABLE_COLUMN_TYPES: string[] = [
  "rich_text",
  "number",
  "select",
  "multi_select",
  "date",
  "checkbox",
  "url",
];

const PAGE_SIZE = 50;

/* ---------- read-only rendering ---------- */

export function propertyToText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const v = value as { type?: string } & Record<string, unknown>;
  switch (v.type) {
    case "title":
    case "rich_text": {
      const items = v[v.type] as { plain_text?: string }[] | undefined;
      return Array.isArray(items) ? items.map((t) => t?.plain_text ?? "").join("") : "";
    }
    case "number":
      return typeof v.number === "number" ? String(v.number) : "";
    case "checkbox":
      return v.checkbox ? "Yes" : "No";
    case "select": {
      const sel = v.select as { name?: string } | null;
      return sel?.name ?? "";
    }
    case "status": {
      const st = v.status as { name?: string } | null;
      return st?.name ?? "";
    }
    case "multi_select": {
      const items = v.multi_select as { name?: string }[] | undefined;
      return Array.isArray(items) ? items.map((o) => o?.name ?? "").filter(Boolean).join(", ") : "";
    }
    case "date": {
      const d = v.date as { start?: string; end?: string } | null;
      if (!d?.start) return "";
      return d.end ? `${d.start} → ${d.end}` : d.start;
    }
    case "url":
    case "email":
    case "phone_number": {
      const s = v[v.type];
      return typeof s === "string" ? s : "";
    }
    case "people": {
      const people = v.people as { name?: string }[] | undefined;
      return Array.isArray(people) ? people.map((p) => p?.name ?? "").filter(Boolean).join(", ") : "";
    }
    case "created_by":
    case "last_edited_by": {
      const user = v[v.type] as { name?: string } | undefined;
      return user?.name ?? "";
    }
    case "created_time":
    case "last_edited_time": {
      const t = v[v.type];
      return typeof t === "string" ? t : "";
    }
    case "formula": {
      const f = v.formula as ({ type?: string } & Record<string, unknown>) | undefined;
      if (!f) return "";
      if (f.type === "string") return typeof f.string === "string" ? f.string : "";
      if (f.type === "number") return typeof f.number === "number" ? String(f.number) : "";
      if (f.type === "boolean") return f.boolean ? "Yes" : "No";
      if (f.type === "date") return (f.date as { start?: string } | null)?.start ?? "";
      return "";
    }
    case "relation": {
      const items = v.relation as unknown[] | undefined;
      return Array.isArray(items) && items.length > 0 ? `${items.length} linked` : "";
    }
    case "rollup": {
      const r = v.rollup as ({ type?: string } & Record<string, unknown>) | undefined;
      if (!r) return "";
      if (r.type === "number") return typeof r.number === "number" ? String(r.number) : "";
      if (r.type === "date") return (r.date as { start?: string } | null)?.start ?? "";
      if (r.type === "array") {
        const items = r.array as unknown[] | undefined;
        return Array.isArray(items) ? items.map(propertyToText).filter(Boolean).join(", ") : "";
      }
      return "";
    }
    case "files": {
      const files = v.files as { name?: string }[] | undefined;
      return Array.isArray(files) ? files.map((f) => f?.name ?? "").filter(Boolean).join(", ") : "";
    }
    case "unique_id": {
      const u = v.unique_id as { prefix?: string; number?: number } | null;
      if (!u || typeof u.number !== "number") return "";
      return u.prefix ? `${u.prefix}-${u.number}` : String(u.number);
    }
    default:
      return "";
  }
}

/* ---------- shape helpers ---------- */

function toColumn(name: string, prop: { id: string; type: string } & Record<string, unknown>): DbColumn {
  const options =
    (prop.select as { options?: DbOption[] } | undefined)?.options ??
    (prop.multi_select as { options?: DbOption[] } | undefined)?.options ??
    (prop.status as { options?: DbOption[] } | undefined)?.options;
  return { id: prop.id, name, type: prop.type, options };
}

function toRow(page: unknown): DbRow {
  const p = page as { id: string; icon?: unknown; properties?: Record<string, unknown> };
  return {
    pageId: p.id,
    icon: pageEmoji({ icon: p.icon } as never),
    properties: p.properties ?? {},
  };
}

/* ---------- reads ---------- */

export async function fetchDatabase(databaseId: string): Promise<DbData> {
  const db = (await enqueue(() =>
    notion().databases.retrieve({ database_id: databaseId } as never),
  )) as {
    id: string;
    title?: { plain_text: string }[];
    icon?: unknown;
    data_sources?: { id: string; name?: string }[];
  };

  const dataSourceId = db.data_sources?.[0]?.id;
  if (!dataSourceId) throw new Error("Database has no data source");

  const ds = (await enqueue(() =>
    notion().dataSources.retrieve({ data_source_id: dataSourceId } as never),
  )) as {
    properties: Record<string, { id: string; type: string } & Record<string, unknown>>;
  };

  const entries = Object.entries(ds.properties);
  const titleEntry = entries.find(([, p]) => p.type === "title");
  const titleColumnName = titleEntry?.[0] ?? "Name";

  const columns: DbColumn[] = [];
  if (titleEntry) columns.push(toColumn(titleEntry[0], titleEntry[1]));
  for (const [name, prop] of entries) {
    if (name === titleColumnName) continue;
    columns.push(toColumn(name, prop));
  }

  const query = (await enqueue(() =>
    notion().dataSources.query({ data_source_id: dataSourceId, page_size: PAGE_SIZE } as never),
  )) as { results: unknown[]; has_more: boolean; next_cursor: string | null };

  const schema: DbSchema = {
    databaseId: db.id,
    dataSourceId,
    title: db.title?.map((t) => t.plain_text).join("") || "Untitled",
    icon: pageEmoji({ icon: db.icon } as never),
    columns,
    titleColumnName,
  };

  return {
    schema,
    rows: query.results.map(toRow),
    hasMore: query.has_more,
    cursor: query.next_cursor,
  };
}

export async function fetchMoreRows(
  schema: DbSchema,
  cursor: string,
): Promise<{ rows: DbRow[]; hasMore: boolean; cursor: string | null }> {
  const query = (await enqueue(() =>
    notion().dataSources.query({
      data_source_id: schema.dataSourceId,
      page_size: PAGE_SIZE,
      start_cursor: cursor,
    } as never),
  )) as { results: unknown[]; has_more: boolean; next_cursor: string | null };

  return { rows: query.results.map(toRow), hasMore: query.has_more, cursor: query.next_cursor };
}

/* ---------- writes ---------- */

function draftToPayload(column: DbColumn, draft: PropertyDraft): Record<string, unknown> {
  switch (draft.kind) {
    case "text":
      return column.type === "title"
        ? { title: draft.text ? [{ text: { content: draft.text } }] : [] }
        : { rich_text: draft.text ? [{ text: { content: draft.text } }] : [] };
    case "number":
      return { number: draft.n };
    case "checkbox":
      return { checkbox: draft.b };
    case "select":
      // status shares the {name} shape but is its own property key
      return column.type === "status"
        ? { status: draft.name ? { name: draft.name } : null }
        : { select: draft.name ? { name: draft.name } : null };
    case "multi_select":
      return { multi_select: draft.names.map((name) => ({ name })) };
    case "date":
      return { date: draft.startIso ? { start: draft.startIso } : null };
    case "link":
      // url | email | phone_number all take the raw string (or null to clear)
      return { [column.type]: draft.s };
  }
}

export async function updateRowProperty(
  pageId: string,
  column: DbColumn,
  draft: PropertyDraft,
): Promise<void> {
  await enqueue(() =>
    notion().pages.update({
      page_id: pageId,
      properties: { [column.name]: draftToPayload(column, draft) },
    } as never),
  );
}

export async function createRow(schema: DbSchema, title: string): Promise<DbRow> {
  const page = await enqueue(() =>
    notion().pages.create({
      parent: { type: "data_source_id", data_source_id: schema.dataSourceId },
      properties: {
        [schema.titleColumnName]: {
          title: title ? [{ text: { content: title } }] : [],
        },
      },
    } as never),
  );
  return toRow(page);
}

export async function archiveRow(pageId: string): Promise<void> {
  await enqueue(() => notion().pages.update({ page_id: pageId, archived: true } as never));
}

export async function createInlineDatabase(parentPageId: string, title: string): Promise<string> {
  const db = (await enqueue(() =>
    notion().databases.create({
      parent: { type: "page_id", page_id: parentPageId },
      is_inline: true,
      title: [{ type: "text", text: { content: title } }],
      initial_data_source: {
        properties: {
          Name: { title: {} },
          Status: {
            select: {
              options: [
                { name: "Not started", color: "default" },
                { name: "In progress", color: "blue" },
                { name: "Done", color: "green" },
              ],
            },
          },
          Notes: { rich_text: {} },
        },
      },
    } as never),
  )) as { id: string };
  return db.id;
}

export async function addColumn(schema: DbSchema, name: string, type: string): Promise<void> {
  await enqueue(() =>
    notion().dataSources.update({
      data_source_id: schema.dataSourceId,
      properties: { [name]: { [type]: {} } },
    } as never),
  );
}

export async function addSelectOption(
  schema: DbSchema,
  column: DbColumn,
  optionName: string,
): Promise<void> {
  // status/select/multi_select options all live under a key matching the
  // column's own type — fetch fresh so a concurrent edit isn't clobbered.
  const ds = (await enqueue(() =>
    notion().dataSources.retrieve({ data_source_id: schema.dataSourceId } as never),
  )) as { properties: Record<string, Record<string, unknown>> };

  const fresh = ds.properties[column.name];
  const existing = (fresh?.[column.type] as { options?: DbOption[] } | undefined)?.options ?? [];
  if (existing.some((o) => o.name === optionName)) return;

  const options = [...existing.map((o) => ({ name: o.name, color: o.color })), { name: optionName }];
  await enqueue(() =>
    notion().dataSources.update({
      data_source_id: schema.dataSourceId,
      properties: { [column.name]: { [column.type]: { options } } },
    } as never),
  );
}
