# Why Hive — vs. just opening notion.so in Arc

The steel-man first: Arc already gives you Spaces, pins, a command bar, and
peek — for *tabs*. Notion's web UI in a pinned Arc tab is a perfectly fine
setup. Hive has to beat that combination, not Notion alone. Here's the honest
case, sharpest first.

## 1. Arc organizes tabs. Hive organizes documents.

In Arc, "Notion" is one tab; everything inside it is still Notion's shared
tree. You can pin individual page URLs, but they're dead bookmarks — titles
don't sync, there's no unread state, no search inside them, and Arc can't
know one doc from another. Hive's sidebar entries are live document objects:
title and icon stay current, they carry unread state, they can live in three
Spaces at once, be filed into folders, auto-archive from Today — all without
moving anything in the shared workspace. This is the PRD's founding thesis,
and no browser can replicate it because a browser can't see inside the tab.

## 2. The network is never on the interaction path.

notion.so cold-loads in seconds and its search regularly takes 3+. Hive
renders every page you've ever opened instantly from SQLite and revalidates
behind, and ⌘T full-text search over your cached corpus returns in
milliseconds, ranked by your own frecency. On a plane, everything you've
read is still readable. Reviewers of Reflect/Bear/Obsidian cite exactly this
gap against Notion — it's structural: a web app can't cache-first your whole
working set; a local client is nothing but that.

## 3. Attention is the killer feature (and the founding pain point).

Notion's web UI famously hides that anything is new — that's what started
this project. Hive: unread dots per doc, count badges per Space, a dock
badge, and — the one nothing else has, including Notion itself —
**block-level diffs**: "changed since your last copy: 2 edited, 1 added,"
with the changed text excerpted. Arc contributes nothing here; a tab can't
tell you what changed inside it.

## 4. The writing surface respects keyboards.

Autoformat (`# `, `- `, `[] `), a slash menu, focus/typewriter mode, undo
toasts, one keymap taught by the palette. Where fidelity beats speed
(databases, embeds, weird blocks), every doc is one key from native Notion —
Hive doesn't pretend to replace the long tail, it routes around it.

## 5. The Arc workflow needs a durable home anyway.

The Browser Company put Arc in maintenance mode and moved to Dia. The
muscle memory Hive replicates — Spaces, pins, ⌘T, Ctrl+Tab — is the workflow
its users are on track to lose. A purpose-built client keeps it alive
independent of any browser vendor's pivots.

## Where Notion-in-a-tab honestly wins

Real-time collaboration and presence, databases as first-class surfaces,
comments/threads (until Tier B lands), and full editing parity. Hive's
answer is scope, not denial: it's the layer for the ~80% of document time
that is reading, navigating, and noticing — with a one-key escape hatch for
the rest. If a session is mostly co-editing a doc in a meeting, use Notion;
you'll be back in Hive to find it again tomorrow.

## The adoption wedge (if this spreads beyond one person)

The convincing demo is 30 seconds: ⌘T → instant full-text hit on a doc
Notion's search takes seconds to find → open renders instantly from cache →
the diff banner shows what a teammate changed overnight. That sequence is
the pitch. Practical friction to solve before evangelizing: each user needs
their own integration token today (a workspace-level internal OAuth app
would fix onboarding), and the repo/theme carry Honeycomb-internal values —
distribution would need a design pass and a signed build. Until then: this
is a personal daily driver, and the success metric stays the PRD's — *you*
reach for it instead of the tab.
