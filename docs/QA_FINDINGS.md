# QA pass findings — 2026-07-07

Three parallel review agents (data layer / React layer / store+Rust).
Status markers updated as fixes land: [FIXED] / [OPEN] / [WONTFIX v1].

## High

1. [FIXED] editBlockText/toggleTodo send blocks.update against `local-` ids
   (400s); pending coalesced writes not re-keyed on remap → text never
   reaches Notion. Fix: local- guard + pendingLocal buffer flushed on remap.
2. [FIXED] moveBlock/indentBlock/outdentBlock discard the recreated block's
   new id (no remap) → every later write to it 404s. Fix: return remoteId,
   remap in store.
3. [FIXED] insertParagraphAfter always appends to the page parent and passes
   local- `after` ids → 400 on nested Enter. Fix: resolve real parent from
   tree; skip remote when ids are local- (documented local-only fallback).
4. [FIXED] moveBlock recreates blocks without children → subtree destroyed
   remotely. Fix: refuse move when the recreated block has children.
5. [FIXED] Lost-update race: all mutations snapshot page.blocks before an
   awaited persist; two rapid mutations → last-writer-wins erases one
   (deterministic on Enter-after-typing). Fix: serialize all block
   mutations through a write chain; read state inside the chain.
6. [FIXED] Remap of a local- id remounts the actively-edited block (React
   key change) → uncommitted typing wiped. Fix: pre-remap commit event +
   chained ordering so items carry the text through the remount.
7. [FIXED] Stale-page races: mutations/openDemo set state without pageId
   guards after awaits → old page renders under new route; focusBlockId/
   writeError leak across navigation. Fix: nav token + guards + resets.

## Medium

8. [FIXED] Coalesced text write fires after convert/delete archived the
   block → spurious Save failed. Fix: cancel pending writes in
   convertBlockType/deleteBlock.
9. [FIXED] TierList drop index off-by-one on downward drags.
10. [FIXED] Slash menu: blur leaves orphaned menu + skips commit; Enter
    swallowed when filter has zero matches.
11. [FIXED] ⌘⇧H color menu has no Escape/click-away close path.
12. [FIXED] SafeBlock try/catch is dead code (React invokes components
    later) → renderer throw blanks the app. Fix: real ErrorBoundary.
13. [FIXED] CommandBar remote search results land after query changed
    (stale setRemote). Fix: query-token guard.
14. [FIXED] setTableColumns reports rebuilt for local- tables → refetch
    reverts the local change.
15. [FIXED] restoreBlock undo of first block restores top locally, bottom
    remotely. Fix: match remote placement (end) for consistency.
16. [FIXED] attention poller starves watched pages beyond first 30 (no
    rotation).
17. [FIXED] Corrupt localStorage snapshot bricks orgDb/frecency fallback
    (unguarded JSON.parse; frecency "null" case).
18. [FIXED] escapeHtml misses `"` → href attribute breakout + link
    corruption on round-trip.
19. [FIXED] init() not idempotent (StrictMode double-run: duplicate Home
    space, leaked focus listeners).
20. [FIXED] blockDiff blind to table cells / captions / child_page titles;
    phantom self-diffs from local-→real id swaps. Fix: include table_row
    cells in text extraction; ignore local- ids in diff.

## Open (documented limitations, not fixed in v1)

21. [OPEN] Queue retry re-enters at tail → two writes to the same block can
    apply out of order after a transient 5xx (rare; needs per-block
    ordering keys).
22. [OPEN] fetchFresh can clobber optimistic cache if revalidation lands
    inside the 1.2s coalesce window (self-edit reverts until next commit).
23. [OPEN] ⌘K immediately after typing in the same block may no-op (saved
    selection detaches when the pre-popover commit rewrites the DOM);
    guarded so it degrades to nothing rather than corrupting.
24. [OPEN] MruSwitcher misses Ctrl-keyup if the window loses focus
    mid-chord; stale switcher until next Ctrl release.
25. [OPEN] Peek panel not closed by keyboard navigation (⌘T open, ⌘\\).
26. [OPEN] `open_embed` accepts http:// (non-TLS) notion.so URLs.
