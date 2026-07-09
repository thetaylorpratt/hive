# Polish round 3 — three parallel workstreams

House rules: same as docs/DB_SPEC.md (enqueue+notion, optimistic+revert+toast,
no new deps, strict TS, sparse comments, --hive-* tokens).

## F — Text below the last block (click-below-to-append)

Problem: when the last block is a table/database there's no way to add text
after it. Notion: clicking the empty area below content creates a paragraph.

- In `src/App.tsx`'s Content page branch, after the BlockList, render (only
  when the page is editable) a `div.hive-below-strip` filling the remaining
  vertical space (min-height 20vh) with cursor: text.
- onClick: if the LAST top-level block is an empty paragraph, just set
  `focusBlockId` to it (via useAppStore.getState().setFocusBlock). Otherwise
  call `insertParagraphAfter(lastTopLevelBlockId)` (existing store action —
  it appends after that block and auto-focuses the new one).
- CSS in `src/styles/theme.css` (one small rule).
- Files: App.tsx + theme.css ONLY.

## G — Select/multi-select option management (databaseApi.ts + DatabaseView.tsx + database.css)

API facts (live-validated 2026-07-09):
- ADD option: existing `addSelectOption` (merge + update) — works.
- DELETE option: `dataSources.update` with the options array OMITTING the
  option (send remaining as `{ id }` only) — works, verified.
- RENAME option: NOT SUPPORTED — the API silently ignores name changes on
  an existing id. Do not build rename UI.
- RECOLOR option: REJECTED by the API ("Cannot update color..."). Do not
  send `color` for existing options — send `{ id }` only.
- STATUS options: cannot be added OR deleted via API. Pick-only (already
  enforced for add).

Build:
- `databaseApi.ts`: add `deleteSelectOption(schema, column, optionName)` —
  fresh dataSources.retrieve, filter the option out, update with the
  remaining options as `{ id }`-only objects.
- `DatabaseView.tsx` OptionDropdown: each option row (select + multi_select
  only, NOT status) gets a small trash/× affordance on hover → optimistic
  removal from schema options AND from any row values displaying it, then
  deleteSelectOption; revert + toast on error.
- Rows keep values pointing at deleted options? Notion clears them — mirror
  by removing the chip locally; the server clears on its side.

## H — Block multi-selection v1 (⌘A escalation, copy, delete)

Problem: selection can't span blocks (each block is its own contentEditable);
⌘A only selects within one line.

Scope v1 (TEXT blocks only — the ones rendered via EditableText):
- Store slice (appStore.ts): `selectedBlockIds: string[] | null`,
  `setBlockSelection(ids: string[] | null)`,
  `deleteSelectedBlocks(): Promise<void>` (sequential deleteBlock via the
  existing action with `{ silent: true }`, then one toast "N blocks deleted",
  then clear selection).
- EditableText keydown ⌘A: if the block's text is NOT yet fully selected,
  let the browser do its default (select within block). If it IS fully
  selected already (or the block is empty), preventDefault, blur the block,
  and select ALL top-level blocks (ids from the current page whose types
  are text-class — use writeback.EDITABLE_TYPES).
- keymap.ts (or a small module it calls): when a block selection is active:
  Escape clears; Backspace/Delete → deleteSelectedBlocks; ⌘C → copy plain
  text of the selected blocks to the clipboard (navigator.clipboard) with
  Notion-ish prefixes: "- " bullets, "1. " numbered, "[ ] "/"[x] " todos,
  "# "/"## "/"### " headings, plain for the rest — build from each block's
  rich_text plain text; ⌘A selects all (escalation entry point when focus
  isn't in an editable); any character key or click clears the selection.
- Visual: in EditableText, subscribe `useAppStore((s) => s.selectedBlockIds?.includes(block.id) ?? false)`
  (primitive) and add class `selected` to `.hive-editable-wrap`; CSS
  (theme.css is owned by F — put this rule in a NEW `src/styles/selection.css`
  imported from EditableText.tsx): accent-tinted background overlay
  (var(--hive-color-accent-subtle, rgba(0,119,204,.14))) + border-radius.
- Files: appStore.ts, EditableText.tsx, keymap.ts, src/styles/selection.css.
  Do NOT touch App.tsx (owned by F) or any database file (owned by G).
