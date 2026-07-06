# Notion's hidden context — what the API exposes and what Hive can surface

Analysis 2026-07-06. Question: Notion buries a lot of context behind the ⋯
menu and left sidebar. Which of it can Hive read via the API and surface
ambiently on rendered pages — and which of it is structurally out of reach?

Two different surfaces matter:

- **REST API** (`@notionhq/client`, integration token) — what the shipped
  app can use at runtime. Pages, blocks, data sources/queries, comments
  (read + create), users, search, page metadata, file uploads. Notion also
  added **integration webhooks** (page/comment events) — worth verifying in
  Phase 0, though a desktop app needs a relay to receive them, so polling
  stays the default plan.
- **Hosted Notion MCP** (the connector, OAuth as you) — strictly build-time
  per ARCHITECTURE §7, but notably *more capable* than REST in spots: it can
  **move pages**, **duplicate pages**, list **teamspaces**, and query AI
  meeting notes. REST can do none of those. If "Move to…" ever becomes a
  must-have inside Hive, routing that one rare action through MCP is the
  only path — flagged as an open question, not a plan.

## Page-level context worth surfacing ambiently (ranked)

| # | Context | Source | Where it goes in Hive |
|---|---|---|---|
| 1 | **Last edited by + when** | `page.last_edited_by` + cached `users.retrieve` | Meta line: avatar · name · relative time. Notion buries this at the *bottom of the ⋯ menu*; Hive shows it on every page. |
| 2 | **Comment threads** | `comments.list` (page- and block-anchored), `comments.create` | Tier B centerpiece: count in meta line, gutter markers on commented blocks, side panel to read/reply. Caveat: API cannot *resolve* threads — view/add only. |
| 3 | **Database-page properties** | `page.properties` (status, dates, people, selects…) | A properties header, like Notion renders above database pages. Many real docs (RFCs, projects) ARE database rows — Hive currently shows only their title. Biggest rendering gap this analysis found. |
| 4 | **Child pages as navigable cards** | `child_page` blocks (already cached!) | Currently a Tier 3 fallback card — promote to a real card that opens the page in Hive. Token-free; data is already in the cache. Same for `child_database` → labeled card + open-in-Notion. |
| 5 | **Breadcrumbs** | walk `page.parent` chain, cached | Orientation without mirroring the shared tree. |
| 6 | **Created by/when** | page object | Secondary meta, hover detail. |
| 7 | **Local version history** | extend the diff engine: keep N snapshots per page in SQLite | Substitute for Notion's buried Version History — and better for daily use, since ours diffs at block level against *your last read*. True historical restore stays a native-Notion job. |
| 8 | **"Your history with this doc"** | frecency table (local) | "Opened 14×, last Tuesday" — the honest substitute for Updates & Analytics (view counts are not in the API). |
| 9 | **Backlinks** | none — build a local link index from cached `link_to_page`/mention blocks | Backlog item; costs a corpus indexing pass. |
| 10 | **Per-page display prefs** (serif/mono font, small text, full width) | pure local | The ⋯ menu items people actually touch — trivial for Hive since we own the renderer. |

## The ⋯ menu, item by item

Recreatable now: copy link, word count (shipped), last-edited-by (#1 above),
small text / full width / font (#10), copy page contents (blocks → markdown),
"available offline" (Hive is offline-first by construction — our default is
their toggle). Recreatable with effort: duplicate (recreate via
create+children walk; lossy for exotic blocks — hosted MCP does it natively),
export (print our own render to PDF — arguably nicer than Notion's export).
Not available in any API: version history (see #7 substitute), updates &
analytics (#8 substitute), move-to (MCP-only), lock page, presentation mode,
suggest edits, turn-into-wiki, connections.

## Notion's left sidebar, feature by feature

| Sidebar feature | Verdict |
|---|---|
| Search | ✓ better already: local FTS + frecency + live API search |
| Home | ✓ Hive's Spaces/recents replace it |
| Inbox / notifications | ✗ no API — the attention engine (dots, badges, diffs; comments/mentions in Tier B) is the substitute, and the reason Hive exists |
| Favorites | ✓ native, richer (cross-Space, local) |
| Teamspaces tree | partial — REST has no teamspaces endpoint; hosted MCP `get-teams` could seed a build-time map. Deliberately out of scope: Hive's thesis is search-first + local org, not mirroring the shared tree |
| Shared with me | ✗ no facet; search covers discovery |
| New page | ✓ `pages.create` — this is what makes Phase 6 quick-capture real |
| Templates | ✗ not in API |
| Trash | partial — can archive a page (`archived: true`), cannot list or restore trash |
| Members | ✓ `users.list` — needed anyway for mentions and last-edited-by names |
| Calendar / AI meeting notes | ✗ REST (hosted-MCP-only, build-time) |

## Roadmap implications

1. **Add a "page context header" work item** (token-dependent): last-edited
   by/when, properties for database pages, breadcrumbs — one meta component,
   three API reads, all cacheable.
2. **Promote `child_page` to a navigable card now** — token-free, cached
   data, and sub-page navigation is table stakes for wiki-style docs.
3. **Tier B (comments) unchanged** in Phase 4, with the resolve-thread
   limitation documented.
4. **Verify webhooks in Phase 0** alongside the token: if a lightweight
   relay is ever acceptable, polling upgrades to push.
5. **Snapshot-based local version history** joins the backlog after diffs
   prove themselves in daily use.
