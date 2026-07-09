# Database (Table View) — implementation spec

Architecture by Fable; implementation split across agents. This contract is
FIXED — code exactly against it so the pieces integrate without rework.

## Verified API facts (probed live against this workspace, SDK v5.22.0)

- `notion().databases.retrieve({ database_id })` → object with
  `data_sources: [{ id, name }]`, `title`, `icon`, `is_inline`, `parent`.
  Schema is NOT here.
- `notion().dataSources.retrieve({ data_source_id })` → `.properties`:
  `Record<name, { id, name, type, select?: {options}, multi_select?: {options}, status?: {options,groups} }>`.
- `notion().dataSources.query({ data_source_id, page_size, start_cursor? })`
  → `{ results: Page[], has_more, next_cursor }`. Each row is a page:
  `{ id, icon, properties: Record<name, PropertyValue> }`.
- Row edit: `notion().pages.update({ page_id, properties: {...} })`.
- Row create: `notion().pages.create({ parent: { type: "data_source_id", data_source_id }, properties })`.
- Row delete: `notion().pages.update({ page_id, archived: true })`.
- New database: `notion().databases.create({ parent: { type: "page_id", page_id }, is_inline: true, title: [...], initial_data_source: { properties: {...} } })`.
  (If SDK types disagree, verify at runtime; `as never` casts are acceptable
  like elsewhere in the codebase.)
- Add column / option: `notion().dataSources.update({ data_source_id, properties: { [name]: {...} } })`.

## House rules (non-negotiable)

- EVERY Notion call goes through `enqueue(() => notion()....)` —
  `import { enqueue } from "../lib/queue"; import { notion } from "../lib/notionClient";`
- Optimistic UI: update local state first, fire the write, revert + toast on error.
  Toast via `useAppStore.getState().showToast(msg)`.
- No new npm dependencies. TypeScript strict; unused vars fail the build.
- Comments: sparse, only for constraints the code can't express.
- Icons: `@phosphor-icons/react` and `Glyph` from `../lib/iconSets`.
- CSS custom props available: `--hive-color-bg-surface`, `--hive-color-bg-subtle`,
  `--hive-color-border`, `--hive-color-border-subtle`, `--hive-color-fg-primary`,
  `--hive-color-fg-secondary`, `--hive-color-fg-muted`, `--hive-color-accent`,
  `--hive-color-accent-subtle`, `--hive-color-critical-bg/fg`, `--hive-radius`,
  `--hive-radius-sm`, `--hive-font-mono`.

## Shared contract (both agents code against THIS, verbatim)

```ts
// src/lib/databaseApi.ts
export interface DbOption { id?: string; name: string; color?: string }
export interface DbColumn { id: string; name: string; type: string; options?: DbOption[] }
export interface DbSchema {
  databaseId: string;
  dataSourceId: string;
  title: string;
  icon: string | null;           // via pageEmoji-style extraction
  columns: DbColumn[];           // title column FIRST, then schema order
  titleColumnName: string;
}
export interface DbRow { pageId: string; icon: string | null; properties: Record<string, unknown> }
export interface DbData { schema: DbSchema; rows: DbRow[]; hasMore: boolean; cursor: string | null }

export type PropertyDraft =
  | { kind: "text"; text: string }          // title + rich_text
  | { kind: "number"; n: number | null }
  | { kind: "checkbox"; b: boolean }
  | { kind: "select"; name: string | null } // select + status
  | { kind: "multi_select"; names: string[] }
  | { kind: "date"; startIso: string | null }
  | { kind: "link"; s: string | null };     // url + email + phone_number

export const EDITABLE_COLUMN_TYPES: Set<string>; // title, rich_text, number, select, status, multi_select, date, checkbox, url, email, phone_number
export const CREATABLE_COLUMN_TYPES: string[];   // rich_text, number, select, multi_select, date, checkbox, url

export function propertyToText(value: unknown): string; // plain-text for ANY property value type (read-only render). Handles: title, rich_text, number, select, status, multi_select, date, checkbox, url, email, phone_number, people, created_by, last_edited_by, created_time, last_edited_time, formula, relation, rollup, files, unique_id. Unknown → "".

export async function fetchDatabase(databaseId: string): Promise<DbData>;            // retrieve db → ds[0] → schema + first 50 rows
export async function fetchMoreRows(schema: DbSchema, cursor: string): Promise<{ rows: DbRow[]; hasMore: boolean; cursor: string | null }>;
export async function updateRowProperty(pageId: string, column: DbColumn, draft: PropertyDraft): Promise<void>;
export async function createRow(schema: DbSchema, title: string): Promise<DbRow>;
export async function archiveRow(pageId: string): Promise<void>;
export async function createInlineDatabase(parentPageId: string, title: string): Promise<string>; // returns database id; initial schema: "Name" (title), "Status" (select: Not started/In progress/Done), "Notes" (rich_text)
export async function addColumn(schema: DbSchema, name: string, type: string): Promise<void>;
export async function addSelectOption(schema: DbSchema, column: DbColumn, optionName: string): Promise<void>;
```

## Agent A — `src/lib/databaseApi.ts` (sole owner of this file)

Implement the contract above. Notes:
- `fetchDatabase`: title from `db.title` rich array plain_text join; icon: reuse
  the icon-shape logic conceptually from `pageMeta.pageEmoji` (import and use
  `pageEmoji({ icon: db.icon })`-compatible? `pageEmoji` takes a page object —
  pass `{ icon: db.icon }` cast; it only reads `.icon`).
- Column list: title column first; preserve schema iteration order otherwise;
  skip none (include read-only types — the view renders them via propertyToText).
- `updateRowProperty` draft→property payloads:
  - text/title: `{ title: [{ text: { content } }] }` or `{ rich_text: [...] }`
  - number `{ number }`, checkbox `{ checkbox }`,
  - select `{ select: name ? { name } : null }`, status `{ status: name ? { name } : null }`,
  - multi_select `{ multi_select: names.map(name => ({ name })) }`,
  - date `{ date: startIso ? { start: startIso } : null }`,
  - url/email/phone `{ url: s }` etc. (null clears).
- `createRow`: properties = `{ [titleColumnName]: { title: [{ text: { content: title } }] } }`;
  return a DbRow built from the response.
- `addSelectOption`: dataSources.update merging existing options + new one
  (fetch fresh schema first to avoid clobbering concurrent edits).

## Agent B — `src/components/DatabaseView.tsx` + `src/styles/database.css` (sole owner)

`export function DatabaseView({ databaseId }: { databaseId: string })`.
Import the contract from `../lib/databaseApi` (it will exist — code against
the spec signatures; do NOT stub it, import for real). Import the css file
from the component (`import "../styles/database.css"`).

States: loading skeleton (title bar + 3 gray rows), error card (message +
"Open in Notion" button via `invoke("open_in_notion", { pageId: databaseId })`
from `@tauri-apps/api/core`), loaded grid.

Grid (`<div class="hive-db">`):
- Header: db icon (Glyph) + title, row count badge.
- Table: sticky header row of column names (+ small muted type label).
  Last header cell: `+` button → popover: name input + type `<select>` from
  `CREATABLE_COLUMN_TYPES` → `addColumn` → refetch.
- Cells by column type:
  - title: text (click text = edit inline; a small ↗ button on hover opens
    the row as a page via `useAppStore.getState().openPage(row.pageId)`).
  - rich_text/number/url/email/phone_number: click → inline `<input>`,
    commit on Enter/blur, Escape cancels.
  - checkbox: toggles directly on click.
  - select/status: click → dropdown of options (colored dots ok) + text row
    "+ Create '<typed>'" when the filter text matches no option (calls
    addSelectOption then updateRowProperty).
  - multi_select: like select but toggles membership; chips display.
  - date: `<input type="date">`, commit on change/blur.
  - anything else: `propertyToText(value)`, muted, not editable.
- All edits optimistic: update local rows state, call updateRowProperty,
  on error revert and `useAppStore.getState().showToast(...)`.
- Bottom bar: `+ New row` (createRow("") → append + start editing its title),
  `Load more` when hasMore.
- Row hover gutter (right): archive `×` → optimistic remove + archiveRow +
  toast "Row moved to trash".
- Keep the component self-contained: NO store state additions; use
  `useAppStore.getState()` for openPage/showToast only.
- css: clean Lattice-ish grid — hairline borders (--hive-color-border-subtle),
  header row bg --hive-color-bg-subtle, cell padding 6px 10px, 0.85rem,
  horizontal scroll wrapper for wide tables (`overflow-x: auto`), select
  dropdown reusing the feel of `.hive-slash-menu` (but own classes, no reuse
  of that classname).

## Agent C — integration (after A & B land)

- `BlockRenderer.tsx`: route `child_database` → `<DatabaseView databaseId={block.id} />`
  (block id IS the database id). Demo page's fake child_database must fall
  into DatabaseView's error card gracefully (it will — fetch fails).
- `EditableText.tsx` SLASH_OPTIONS: add "Database (table view)" entry,
  keywords `database,table view,db`. pickSlash special-case: it calls the new
  store action `createDatabaseInline()` instead of convertBlock, then clears
  the block text like other picks.
- `appStore.ts`: `createDatabaseInline: () => Promise<void>` — guards
  (real page + auth ready), calls `createInlineDatabase(pageId, "Untitled")`,
  toast, then `openPage(pageId)` to refetch (db creation is rare; a reload
  is acceptable ONLY here).
- Verify build passes.
