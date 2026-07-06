# Polish opportunities — what best-in-class editors do that Hive should steal

Synthesized 2026-07-06 from research across writing-focused editors (Craft,
Bear, iA Writer, Ulysses, Typora, Obsidian, Reflect) and keyboard-first
products (Linear, Superhuman, Raycast, Arc, Slack Catch Up, Slite, Almanac).
Each item complements the Arc-style shell rather than fighting it. Ordered by
feel-per-effort for a solo-built client, adjusted for what Hive already has
(frecency ✓, optimistic writes ✓, unread dots ✓, command bar ✓).

## The two principles everything else falls out of

1. **The network is never on the interaction path** (Bear/Obsidian/Superhuman).
   Never render a spinner for content ever seen; write locally, sync behind,
   undo-toast instead of confirmation dialogs. Hive's SQLite cache + queue
   already embodies this — finish the last 10% everywhere it leaks.
2. **One muscle-memory pattern covers the whole app** (Linear). Every action
   reachable via palette + shortcut + menu with identical naming; the palette
   displays each action's key, so the slow path teaches the fast path.

## Prioritized backlog

### P1 — do next (highest feel-per-effort)

1. **Local full-text search in Cmd-T** (Reflect/Obsidian). SQLite FTS5 over
   cached block text + titles; recents-first empty state already exists.
   Instant results make Hive *feel* faster than Notion on every invocation —
   reviewers cite exactly this against Notion's ~3s search. Zero API cost.
2. **Markdown autoformat in the editor** (Notion/Bear/Typora). `# `→heading,
   `- `→bullet, `[] `→to-do, `**bold**` on closing char — with the critical
   detail: undo reverts the *conversion* first, not the typing. Pairs with a
   `/` slash menu reusing the command-bar component anchored at the caret.
3. **Contextual actions + shortcut hints in Cmd-T** (Linear/Superhuman).
   When a page is open, page-scoped actions rank first; every action row
   shows its keybinding on the right edge. Palette becomes the control plane
   and the shortcut teacher.
4. **Ctrl+Tab MRU switcher** (Arc). A recency stack + small overlay cycling
   the ~5 most recent docs. Tiny build, used constantly, and the connective
   tissue for Phase 4 split view.

### P2 — Hive's signature move + writing feel

5. **Block-level "what changed" diffs** (Slite → attention engine). We cache
   `blocks_json` per page: diff snapshots between syncs and turn the unread
   dot into "3 blocks changed" with excerpts in peek/inbox. Notion itself
   doesn't have this — it's the feature that justifies the whole project.
6. **Focus/typewriter mode + typography pass** (iA Writer/Bear). Fixed
   ~44rem measure (have), caret-centering scroll, dim non-active blocks,
   one great font pair, live word-count in a corner (Bear). ~A day of work,
   outsized "this app respects writing" signal.
7. **Undo toast everywhere** (Superhuman). Especially remove-from-sidebar,
   archive, and delete-block. Undo-instead-of-confirm is the single biggest
   "feels native" convention.

### P3 — Phase 4/5 alignment (build into those phases, not before)

8. **Peek with promote keys** (Arc). Hover peek must be a fork point, not a
   dead end: Cmd-O promotes to tab, one key to split, Esc dismisses.
9. **Little-Arc-style link window** (Arc). notion.so links from other apps
   open a chromeless throwaway viewer; explicitly "Add to Space…" or it
   vanishes. Reuses the peek surface.
10. **j/k + E/H triage grammar for the comments/mentions inbox** (Superhuman/
    Linear). Adopt their exact letters so conventions transfer. Optional
    Slack-style "Catch Up" deck cycling changed pages one at a time.
11. **Craft-style navigation transitions + Esc block-select** (Craft/Notion).
    150–200ms push/pop on page navigation; Esc selects the block as an
    object, arrows move selection. Makes the shell feel native, not webby.

### P4 — backlog (real but lower daily impact)

12. **Outline rail** (Typora/Obsidian): hover-expanding heading TOC on the
    right edge, derived from cached heading blocks.
13. **Raycast-style aliases**: tiny table mapping `mtg` → a page, strict
    prefix match, always ranks #1 — predictability over cleverness.
14. **Per-Space Today-archive TTLs + archived-items view** (Arc): archive
    must never feel like loss; reachable from Cmd-T.
15. **Backlinks panel** (Obsidian/Reflect): no API endpoint — requires DIY
    link-graph indexing during cache sync. Best next big rock after these.
16. **`?` shortcut overlay + "press H instead" teaching toasts** (Raycast/
    Superhuman): cheap once the keymap module has labels.

## Sync-behavior refinements (from the offline/local-first research)

- **Debounced per-block write coalescing**: multiple edits to one block
  within ~1.5s should collapse to one `blocks.update` (protects the 3 req/s
  budget during fast typing). Current code writes per blur — fine for now,
  needed before real typing-heavy use.
- **Conflict guard before PATCH**: compare remote `last_edited_time` before
  writing; on mismatch show a non-blocking "page changed remotely" toast
  (PRD §8 sync risk). The attention engine already fetches the needed data.
- **Quiet sync indicator** (Ulysses): a subtle syncing/synced dot near the
  page meta line, never a modal.
- **Hover prefetch**: debounced ~150ms `pages.retrieve` on sidebar hover so
  Phase 4 peek opens warm; budgeted by frecency.

Full research (sources, per-product detail) lives in the two agent reports
from 2026-07-06; patterns above are the distilled, deduplicated set.
