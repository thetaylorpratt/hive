# Block Inventory — Real Honeycomb Notion Pages

Validates the renderer tier plan against ~9 real workspace pages, sampled 2026-07-06.

## Method

Fetched via Notion MCP (`notion-fetch`), which returns Notion-flavored markdown — block
mapping is *inferred* from markup, so constructs the exporter flattens (synced blocks,
bookmarks vs. plain links, toggles) may be undercounted. Pages sampled:

1. **LLM O11y Team Sync** — meeting note (lives in a database)
2. **Runbook: Change Team Slug Name** — runbook (database page, locked)
3. **RFC: Lattice Primitives & Variants Pattern** — design doc
4. **Teamspace Home** — team wiki/home page
5. **Session Table Incident Retro Nov 4, 2025** — incident retro (database page)
6. **Data Activation Vision & Execution Plan** — project plan (Quip import)
7. **Winston Onboarding+Welcome Doc** — onboarding doc (Quip import)
8. **Runbooks** (index entry) — database page
9. **📕 Runbooks** — wiki page embedding a full database

## Frequency table

| Construct | Prevalence (pages / notes) | Tier |
|---|---|---|
| Paragraphs | 9/9, dominant everywhere | 1 |
| Headings 1–3 | 8/9, heavy | 1 |
| Bulleted lists (incl. deep nesting) | 7/9, heavy | 1 |
| Numbered lists | 1/9 | 1 |
| To-dos | 2/9 (action items in retro + meeting summary) | 1 |
| Bold/italic/strikethrough/inline code | 8/9 — strikethrough used for dropped scope | 1 (inline) |
| Colored text spans / colored blocks | 3/9 — every runbook banner, wiki headers | 1 (inline) — **not in plan** |
| Inline links + user/page mentions | 9/9, pervasive | 1 (inline) |
| Callouts | 1/9 | 1 |
| Quotes | 1/9 | 1 |
| Dividers | 1/9 | 1 |
| Code blocks | 1/9 (2 JS blocks in RFC) | 1 |
| Simple tables | 3/9 (Quip-import metadata + ownership tables) | 2 |
| Images | 1/9 (single ref, broken) | 2 |
| Columns | 1/9 (Teamspace Home, 2-col) | 2 |
| Child pages | 2/9 as body blocks; ancestry everywhere | **not in plan** |
| Database page properties (page is a DB row) | 4/9 sampled pages | **not in plan** |
| Full-page/inline database views | 2/9 (Runbooks wiki; meeting-notes DB) | 3 |
| AI meeting-notes block (summary/notes/transcript) | 1/9, but standard for all meeting notes | **not in plan** |
| Toggles | 0 observed | 2 |
| Bookmarks / link previews | 0 detected (external links render inline) | 2 |
| Equations | 0 | 2 |
| Embeds (Figma/Mural/Loom) | 0 as blocks — always plain links in sample | 3 |
| Synced blocks | 0 detectable via MCP markdown | 3 |
| Comments | not visible (requires `include_discussions`) | — |

## Assessment

**The Tier 1/2 split covers real Honeycomb docs well.** Prose constructs (paragraphs,
headings, bullets, bold/links) account for the overwhelming majority of content on every
page. Tier 2 tables matter more than expected — Quip-imported docs (a large slice of the
workspace) lead with a metadata table and often contain ownership tables.

**Tier 3 promotion candidates:**
- **Database views** — half the sample *lives inside* databases (meeting notes, retros,
  runbooks), and index pages like 📕 Runbooks are just a title + a database block. A
  fallback card makes those pages useless. Even a read-only row list would help daily use.

**Gaps the plan missed:**
1. **Page properties header** — 4/9 pages are DB rows; without rendering properties
   (attendees, status, tags, summary) the top of the page is missing context.
2. **Colored/highlighted text** — inline rich-text annotation used deliberately
   (orange runbook warnings); needs support in Tier 1 rich text, cheap to add.
3. **AI meeting-notes block** — Honeycomb meeting notes are largely Notion AI notes;
   needs at least a structured render of summary/notes + transcript link, not a fallback.
4. **Child-page links** — wiki/home pages are mostly lists of child pages; render as
   navigable links (cheap, high value).

**Non-issues:** toggles, equations, embeds, bookmarks, and synced blocks did not appear
in the sample; their current tiers are safe defaults.


## REST-exact addendum (2026-07-07, first token run)

Sampled everything the integration can currently see (2 pages: the Hackweek
PRD + its sub-page). Exact top-level counts: bulleted_list_item 25,
heading_2 8, paragraph 7, heading_3 2, quote 1, child_page 1 — 100% covered
by Tier 1 + the navigable child-page card. Sample is too small to be
representative: rerun after connecting teamspaces to the integration
(connections inherit down the tree, so a few teamspace-level connects
unlock the real corpus).
