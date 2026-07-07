# Notion editor parity — mechanics checklist

Sourced from notion.com/help (keyboard shortcuts, writing & editing basics,
slash commands, customize a page) on 2026-07-07. Status: ✅ shipped in Hive,
🔜 deferred (with reason), ❌ out of API reach.

## Inline formatting (on selection)

| Trigger | Notion behavior | Hive |
|---|---|---|
| ⌘B / ⌘I / ⌘U | bold / italic / underline | ✅ |
| ⌘⇧S | strikethrough | ✅ |
| ⌘E | inline code | ✅ (single-node selections; cross-run selections no-op) |
| ⌘K / paste-URL-over-selection | link selection | 🔜 needs a link input popover |
| ⌘⇧H | repeat last color | 🔜 colors render, not yet applied in-editor |
| `**b**` `*i*` `` `c` `` `~s~` while typing | converts on closing char | 🔜 needs live delimiter scanning; block prefixes cover most muscle memory |

## Block markdown prefixes (+ space)

`#`/`##`/`###` headings ✅ · `-`/`*`/`+` bullets ✅ · `1.`/`a.`/`i.` numbered ✅
· `[]` to-do ✅ · `>` **toggle** ✅ (parity trap: not quote!) · `"` quote ✅ ·
` ``` ` code ✅ · `---` divider on third hyphen ✅ · `$$` equation 🔜

## Slash menu

✅ `/` on empty block, type-ahead filter, arrows/Enter/click, Esc. Types:
text, h1–h3, bulleted, numbered, to-do, quote, **toggle**, **table**,
callout, divider, code. Notion's `/table` = simple table, 2×3, no header
row by default — matched. 🔜: media/database/embed entries (API-dependent),
Suggested section, `/turn into`, color commands.

## Emoji & page icons

- ✅ `:name:` completion — menu after 2+ chars (Notion's threshold), arrows/
  Enter/Tab/click insert, Esc closes. Curated ~250-name set (`lib/emoji.ts`);
  the macOS picker (⌃⌘Space) covers the long tail.
- ✅ Page icons: click the title emoji (or ghost placeholder) → inline input
  → saves via `pages.update` (notion sink) and syncs sidebar/frecency caches.
  🔜 random-icon shuffle + Notion's custom-image icons (upload API).

## Block-level keys

| Trigger | Notion | Hive |
|---|---|---|
| ⌘⌥0–8 | turn into text/h1/h2/h3/to-do/bullet/numbered/toggle/code | ✅ preserves text |
| ⌘⌥9 | turn into page | ❌ requires page create + content move |
| Enter on empty list item | exits list → text | ✅ |
| Enter / ⇧Enter | new block / soft break | ✅ (soft break = browser default `<br>` → `\n`) |
| Backspace on empty | delete block | ✅ (+ undo toast) |
| Tab / ⇧Tab | indent / outdent | 🔜 needs API re-parenting choreography |
| ⌘⇧↑/↓ move block, ⌘D duplicate, Esc block-select model, ⌘Enter modify | | 🔜 next parity tranche |
| ⌘/ action menu, ⌘⇧M comment | | 🔜 comments arrive with Tier B |

## Tables

✅ `/table` inserts 2×3 simple table (local children + API `table_row`
children on the notion sink); ✅ cells are contentEditable with per-row
`table_row.cells` write-back. 🔜 add/remove rows/columns, header toggles.

## Also inventoried, deliberately deferred

`@` mentions & dates (needs users/search wiring — Tier B adjacent), `[[` /
`+` page links (needs pages.create), paste-markdown conversion, `⌘⇧V` plain
paste, drag-handle `⋮⋮` menu, `⌥`-drag duplicate.

## Engineering note

contentEditable blocks are **fully uncontrolled**: React renders no children
for them; all content writes go through a sync effect that defers while the
element is focused. Rendering via `dangerouslySetInnerHTML` caused React to
wipe in-progress typing whenever menu state re-rendered the component — the
bug was invisible until menus could open on non-empty blocks.
