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

---

# V2 — Notion-parity polish (round 2)

User feedback: v1's editing/creating UX is "janky" vs Notion. This round
restyles the grid to match Notion's table view and adds schema editing.

## Newly verified API facts (live-tested 2026-07-09)

- Rename column: `dataSources.update({ properties: { [oldName]: { name: newName } } })`
- Change column type: `dataSources.update({ properties: { [name]: { name, type: "select", select: {} } } })`
  — converts existing data where compatible (rich_text→select verified; options
  backfill lazily). Formula/synced/place types cannot be written.
- Delete column: `dataSources.update({ properties: { [name]: null } })`
- Rename database title: `databases.update({ database_id, title: [{type:"text",text:{content}}] })` (works; also mirror to dataSources.update title)
- Person cells: `pages.update({ properties: { [name]: { people: [{ id }] } } })`
- Notion UX reference: blue "New" button top right; "+ New" row at table
  bottom; property header click → menu with rename / change type / delete;
  title cell hover shows OPEN button; cells edit strictly in place.

## Contract additions (`src/lib/databaseApi.ts`)

```ts
export type PropertyDraft = /* existing kinds */ | { kind: "people"; ids: string[] };

export const COLUMN_TYPE_META: Record<string, { label: string }>; // for header menus: title→"Title", rich_text→"Text", number→"Number", select→"Select", multi_select→"Multi-select", status→"Status", date→"Date", checkbox→"Checkbox", url→"URL", email→"Email", phone_number→"Phone", people→"Person" (others fall back to raw type string)

export async function renameDatabase(databaseId: string, dataSourceId: string, title: string): Promise<void>; // databases.update AND dataSources.update (both titles)
export async function renameColumn(schema: DbSchema, column: DbColumn, newName: string): Promise<void>;
export async function changeColumnType(schema: DbSchema, column: DbColumn, newType: string): Promise<void>; // { name: column.name, type: newType, [newType]: {} }
export async function deleteColumn(schema: DbSchema, column: DbColumn): Promise<void>;
```
- `CREATABLE_COLUMN_TYPES` gains "people".
- `updateRowProperty` handles `people` drafts: `{ people: ids.map(id => ({ id })) }`.

## DatabaseView v2 (full restyle + new interactions)

Visual (match Notion's table view, dark+light via --hive-* tokens):
- NO outer card/box; the grid sits flush on the page background.
- Title bar above grid: inline-editable database title (h3 weight, muted
  "Untitled" placeholder; commit on Enter/blur → renameDatabase) on the
  left; a compact primary "New" button (accent bg) on the right that
  creates a row and immediately starts editing its title.
- Header cells: per-type icon + name, 0.8rem, --hive-color-fg-muted,
  weight 500, hairline bottom border. Phosphor icon suggestions:
  title→TextT, rich_text→TextAlignLeft, number→Hash, select→CaretCircleDown,
  multi_select→ListBullets, status→ArrowClockwise, date→Calendar,
  checkbox→CheckSquare, url→LinkSimple, email→At, phone_number→Phone,
  people→User; anything else→Question.
- Hairline borders both axes but ultra-subtle (--hive-color-border-subtle);
  row hover = --hive-color-bg-subtle at low intensity.
- Cell editing IN PLACE: the display and the editor occupy the same box —
  editing swaps in a borderless input inheriting font/size with an inset
  accent focus ring (box-shadow: inset 0 0 0 2px var(--hive-color-accent)),
  no layout shift. Enter commits; Escape cancels; Tab commits and moves to
  the next editable cell in the row (nice-to-have; skip if fragile).
- Title cell: row icon + text; hover reveals a small "OPEN" pill button
  (right-aligned in cell) → openPage(row.pageId).
- Bottom of grid: full-width "+ New" muted row (like Notion) — same action
  as the New button; keep "Load more" when hasMore, styled as a subtle row.
- Remove the row-count badge from the head; instead a tiny muted
  "{n} rows" at the bottom-left after the + New row.

New interactions:
- **Column header menu**: click a header → popover (click-away closes):
  rename input (autofocus, Enter commits → renameColumn), a "Type" section
  listing CREATABLE_COLUMN_TYPES with COLUMN_TYPE_META labels (current
  type highlighted; click → changeColumnType, optimistic schema update,
  refetch rows after success since values convert), and "Delete property"
  in critical color (not shown for the title column). Rename-only for
  title column.
- **Person cells**: chips with a small initial-circle avatar; click →
  dropdown (same pattern as select) searching `workspaceUsers()` from
  ../lib/users; toggle membership; commit `{ kind: "people", ids }`.
- **Add column** stays but restyled to match the header menu look.
- Column ops are schema-wide: after changeColumnType succeeds, re-run
  fetchDatabase (values may have converted server-side).

## Integration (small, after the above)

- `createDatabaseInline` in appStore: after the openPage reload, scroll the
  last `.hive-db` into view and toast "Database created (Notion places new
  databases at the end of the page)". The at-cursor position is an API
  limitation: child_database blocks cannot be created or moved via REST.
