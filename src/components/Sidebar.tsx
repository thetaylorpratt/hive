import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { ArrowClockwise, Bell, PencilSimpleLine } from "@phosphor-icons/react";
import { Glyph } from "../lib/iconSets";
import { useAppStore } from "../store/appStore";
import { SpaceSwitcher } from "./SpaceSwitcher";
import type { SidebarItem, Tier } from "../lib/orgDb";
import { subscribeReminders, dueReminders } from "../lib/reminders";
import { dlog } from "../lib/debugLog";

/**
 * Per-Space sidebar: Favorites (icon row, transcend Spaces), Pinned,
 * Folders, and Today (ephemeral, auto-archived after 24h).
 *
 * Drag & drop is native HTML5 for v1 (reorder within a tier, drag Today →
 * Pinned to pin, drop onto a folder to file). dnd-kit is the upgrade path
 * if the interaction needs more polish later.
 */

const DRAG_MIME = "application/x-hive-item";

// WebKit (the real Tauri WKWebView) has been observed to refuse drags that
// carry only a custom MIME type — the drop's dataTransfer comes back empty
// even though dragstart set it. Worse, during dragover WKWebView can report
// dataTransfer.types as UTI strings ("public.utf8-plain-text") rather than
// MIME, so no string check on types is reliable. For drags that originate in
// our own sidebar we don't need dataTransfer at all: dragstart records the
// dragged item id module-side, and every check/read prefers that. dataTransfer
// remains a fallback so nothing regresses in engines where it works.
function hasDragPayload(e: React.DragEvent): boolean {
  return (
    isDragging ||
    e.dataTransfer.types.includes(DRAG_MIME) ||
    e.dataTransfer.types.includes("text/plain")
  );
}
function getDraggedItemId(e: React.DragEvent): string {
  return (
    e.dataTransfer.getData(DRAG_MIME) ||
    e.dataTransfer.getData("text/plain") ||
    draggedItemId ||
    ""
  );
}

// Suppress the hover-peek while a native HTML5 drag is in flight — mouseenter
// on rows the drag passes over would otherwise race the drop, opening peek
// panels mid-drag. Module-level because dragstart/dragend on one row must be
// visible to onMouseEnter on every other row. draggedItemId doubles as the
// payload for engines whose dataTransfer is unreliable (see above).
let isDragging = false;
let draggedItemId: string | null = null;

/** Right-click menu for a sidebar row: move Space/folder, pin/star toggles,
 * remove. Portals to <body> — WebKit clips absolutely-positioned
 * descendants of scrolling/overflow-hidden ancestors (see Popover in
 * DatabaseView.tsx), and a fixed-position menu at raw mouse coords needs the
 * same escape hatch. Self-contained per-row: no lifted state needed, since
 * only one row's contextmenu event can fire at a time and the click-away
 * listener on any previously-open menu closes it on the new event's mousedown. */
function ItemContextMenu({
  item,
  point,
  onClose,
}: {
  item: SidebarItem;
  point: { x: number; y: number };
  onClose: () => void;
}) {
  const spaces = useAppStore((s) => s.spaces);
  const activeSpaceId = useAppStore((s) => s.activeSpaceId);
  const folders = useAppStore((s) => s.folders);
  const setItemTier = useAppStore((s) => s.setItemTier);
  const moveItemToSpace = useAppStore((s) => s.moveItemToSpace);
  const fileItemIntoFolder = useAppStore((s) => s.fileItemIntoFolder);
  const createFolder = useAppStore((s) => s.createFolder);
  const removeItem = useAppStore((s) => s.removeItem);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(point.x, window.innerWidth - width - 8));
    const top = Math.max(8, Math.min(point.y, window.innerHeight - height - 8));
    setPos({ top, left });
  }, [point]);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", away, true);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", away, true);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const otherSpaces = spaces.filter((s) => s.id !== activeSpaceId);

  const runAndClose = (fn: () => Promise<unknown>) => {
    onClose();
    void fn();
  };

  return createPortal(
    <div
      ref={menuRef}
      className="hive-ctx-menu"
      style={{
        position: "fixed",
        top: pos?.top ?? point.y,
        left: pos?.left ?? point.x,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      {otherSpaces.length > 0 && (
        <>
          {otherSpaces.map((space) => (
            <button
              key={space.id}
              className="row"
              onClick={() => runAndClose(() => moveItemToSpace(item.id, space.id))}
            >
              <span className={`hive-ctx-dot accent-${space.color}`} />
              Move to {space.name}
            </button>
          ))}
          <div className="sep" />
        </>
      )}

      {folders.map((folder) => (
        <button
          key={folder.id}
          className="row"
          onClick={() => runAndClose(() => fileItemIntoFolder(item.id, folder.id))}
        >
          Add to {folder.name}
        </button>
      ))}
      <button
        className="row create"
        onClick={() =>
          runAndClose(async () => {
            await createFolder();
            const created = useAppStore.getState().folders;
            const newest = created[created.length - 1];
            if (newest) await fileItemIntoFolder(item.id, newest.id);
          })
        }
      >
        New folder…
      </button>
      <div className="sep" />

      {item.tier === "today" && (
        <button className="row" onClick={() => runAndClose(() => setItemTier(item.id, "pinned"))}>
          Pin
        </button>
      )}
      {item.tier === "pinned" && (
        <button className="row" onClick={() => runAndClose(() => setItemTier(item.id, "today"))}>
          Unpin
        </button>
      )}
      {item.tier !== "favorite" ? (
        <button className="row" onClick={() => runAndClose(() => setItemTier(item.id, "favorite"))}>
          Star
        </button>
      ) : (
        <button className="row" onClick={() => runAndClose(() => setItemTier(item.id, "pinned"))}>
          Unstar
        </button>
      )}
      <div className="sep" />
      <button className="row danger" onClick={() => runAndClose(() => removeItem(item.id))}>
        Remove from sidebar
      </button>
    </div>,
    document.body,
  );
}

/** A starred doc's compact chip. Right-click gets the same context menu as
 * regular rows — without it, Unstar/Remove are unreachable once a doc leaves
 * the Pinned/Today lists (starred items were stuck forever). */
function FavChip({ item }: { item: SidebarItem }) {
  const openPage = useAppStore((s) => s.openPage);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <button
        className="hive-fav"
        title={`${item.titleCache} — right-click for options`}
        onClick={() => void openPage(item.notionPageId)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {item.iconCache ? (
          <Glyph icon={item.iconCache} size={15} />
        ) : (
          item.titleCache.slice(0, 1).toUpperCase()
        )}
      </button>
      {menu && (
        <ItemContextMenu item={item} point={menu} onClose={() => setMenu(null)} />
      )}
    </>
  );
}

function ItemRow({ item }: { item: SidebarItem }) {
  const openPage = useAppStore((s) => s.openPage);
  const setItemTier = useAppStore((s) => s.setItemTier);
  const removeItem = useAppStore((s) => s.removeItem);
  const currentPageId = useAppStore((s) => s.pageId);
  const unread = useAppStore((s) => s.unreadPageIds.has(item.notionPageId));
  const requestPeek = useAppStore((s) => s.requestPeek);
  const releasePeek = useAppStore((s) => s.releasePeek);
  const closePeek = useAppStore((s) => s.closePeek);
  const active = currentPageId === item.notionPageId;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  return (
    <div
      className={`hive-side-row${active ? " active" : ""}`}
      draggable
      onDragStart={(e) => {
        closePeek();
        isDragging = true;
        draggedItemId = item.id;
        dlog(`drag start item=${item.id} title=${item.titleCache.slice(0, 20)}`);
        e.dataTransfer.setData(DRAG_MIME, item.id);
        // WebKit fallback: drags carrying only a custom MIME have been
        // observed to arrive at the drop target with an empty dataTransfer.
        e.dataTransfer.setData("text/plain", item.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragEnd={() => {
        dlog("drag end");
        isDragging = false;
        draggedItemId = null;
      }}
      onClick={() => {
        closePeek();
        void openPage(item.notionPageId);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        closePeek();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      onMouseEnter={(e) => {
        if (isDragging) return;
        requestPeek(item.notionPageId, e.currentTarget.getBoundingClientRect().top);
      }}
      onMouseLeave={releasePeek}
      title={item.titleCache}
    >
      <span className="icon">{item.iconCache ? <Glyph icon={item.iconCache} /> : "📄"}</span>
      <span className="title">{item.titleCache}</span>
      {unread && <span className="hive-unread-dot" title="Changed since you last opened it" />}
      <span className="actions" onClick={(e) => e.stopPropagation()}>
        {item.tier !== "favorite" && (
          <button
            title="Favorite (all Spaces)"
            onClick={() => void setItemTier(item.id, "favorite")}
          >
            ★
          </button>
        )}
        {item.tier === "today" && (
          <button title="Pin" onClick={() => void setItemTier(item.id, "pinned")}>
            📌
          </button>
        )}
        {item.tier === "pinned" && (
          <button title="Unpin" onClick={() => void setItemTier(item.id, "today")}>
            ⤵
          </button>
        )}
        <button title="Remove from sidebar" onClick={() => void removeItem(item.id)}>
          ×
        </button>
      </span>
      {menu && <ItemContextMenu item={item} point={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** A list that accepts reordering drops of its own tier's items. */
function TierList({
  tier,
  items,
  emptyHint,
}: {
  tier: Tier;
  items: SidebarItem[];
  emptyHint?: string;
}) {
  const reorderTier = useAppStore((s) => s.reorderTier);
  const setItemTier = useAppStore((s) => s.setItemTier);
  const moveItemToFolder = useAppStore((s) => s.moveItemToFolder);
  const sidebarItems = useAppStore((s) => s.sidebarItems);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const onDrop = (e: React.DragEvent) => {
    if (!hasDragPayload(e)) return;
    e.preventDefault();
    setOverIndex(null);
    const draggedId = getDraggedItemId(e);
    if (!draggedId) return;
    const dragged = sidebarItems.find((i) => i.id === draggedId);
    if (!dragged) return;

    void (async () => {
      // Cross-tier drop = adopt this tier; also un-file from any folder.
      if (dragged.tier !== tier) await setItemTier(draggedId, tier);
      else if (dragged.parentFolderId) await moveItemToFolder(draggedId, null);
      const from = items.findIndex((i) => i.id === draggedId);
      let insertAt = overIndex ?? items.length;
      // the drop index was computed over rows that still include the
      // dragged item — compensate when moving downward
      if (from !== -1 && from < insertAt) insertAt -= 1;
      const ids = items.filter((i) => i.id !== draggedId).map((i) => i.id);
      ids.splice(insertAt, 0, draggedId);
      await reorderTier(tier, ids);
    })();
  };

  return (
    <div
      ref={listRef}
      className="hive-tier-list"
      onDragEnter={(e) => {
        if (!hasDragPayload(e)) return;
        e.preventDefault();
      }}
      onDragOver={(e) => {
        if (!hasDragPayload(e)) return;
        e.preventDefault();
        const rows = Array.from(
          listRef.current?.querySelectorAll(".hive-side-row") ?? [],
        );
        const index = rows.findIndex(
          (r) => e.clientY < r.getBoundingClientRect().top + r.clientHeight / 2,
        );
        setOverIndex(index === -1 ? rows.length : index);
      }}
      onDragLeave={() => setOverIndex(null)}
      onDrop={onDrop}
    >
      {items.map((item, i) => (
        <div key={item.id}>
          {overIndex === i && <div className="hive-drop-line" />}
          <ItemRow item={item} />
        </div>
      ))}
      {overIndex === items.length && <div className="hive-drop-line" />}
      {items.length === 0 && emptyHint && (
        <div className="hive-side-empty">{emptyHint}</div>
      )}
    </div>
  );
}

function FolderBlock({
  folderId,
  name,
  items,
}: {
  folderId: string;
  name: string;
  items: SidebarItem[];
}) {
  const [open, setOpen] = useState(true);
  const [dropping, setDropping] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(name);
  const moveItemToFolder = useAppStore((s) => s.moveItemToFolder);
  const setItemTier = useAppStore((s) => s.setItemTier);
  const sidebarItems = useAppStore((s) => s.sidebarItems);
  const deleteFolder = useAppStore((s) => s.deleteFolder);
  const renameFolder = useAppStore((s) => s.renameFolder);

  return (
    <div
      className={`hive-folder${dropping ? " dropping" : ""}`}
      onDragEnter={(e) => {
        dlog(
          `folder dragenter ${name} payload=${hasDragPayload(e)} types=[${Array.from(e.dataTransfer.types).join(",")}]`,
        );
        if (!hasDragPayload(e)) return;
        e.preventDefault();
      }}
      onDragOver={(e) => {
        // The ONLY drop target used to be the head title row — dropping
        // anywhere else on the folder (open body, empty-state hint, or a
        // row already inside it) silently no-op'd. The whole block is now
        // the drop target so a drop lands wherever the user releases it.
        if (!hasDragPayload(e)) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(e) => {
        // Moving between children (head <-> body <-> a row) fires
        // dragleave/dragenter pairs on the block itself too — only clear
        // the highlight once the pointer has actually left the block.
        const next = e.relatedTarget as Node | null;
        if (next && e.currentTarget.contains(next)) return;
        setDropping(false);
      }}
      onDrop={(e) => {
        dlog(
          `folder drop ${name} payload=${hasDragPayload(e)} id=${getDraggedItemId(e) || "(none)"}`,
        );
        if (!hasDragPayload(e)) return;
        e.preventDefault();
        // Nothing else should double-handle this drop (e.g. a TierList
        // wrapping this block, or a bubbling drop on document).
        e.stopPropagation();
        setDropping(false);
        const draggedId = getDraggedItemId(e);
        const dragged = sidebarItems.find((i) => i.id === draggedId);
        if (!dragged) {
          dlog(`folder drop MISS: id=${draggedId} not in sidebarItems`);
          return;
        }
        void (async () => {
          // Folders live in the pinned section; filing implies pinning.
          if (dragged.tier !== "pinned") await setItemTier(draggedId, "pinned");
          await moveItemToFolder(draggedId, folderId);
          dlog(`folder drop FILED ${draggedId} -> ${name}`);
        })();
      }}
    >
      <div className="hive-folder-head" onClick={() => setOpen(!open)}>
        <span className="chevron">{open ? "▾" : "▸"}</span>
        {renaming ? (
          <input
            className="hive-input"
            autoFocus
            value={draft}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              setRenaming(false);
              void renameFolder(folderId, draft);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setRenaming(false);
            }}
          />
        ) : (
          <span
            className="title"
            title="Double-click to rename"
            onDoubleClick={(e) => {
              e.stopPropagation();
              setDraft(name);
              setRenaming(true);
            }}
          >
            {name}
          </span>
        )}
        <span className="actions" onClick={(e) => e.stopPropagation()}>
          <button
            title="Delete folder (items are kept)"
            onClick={() => void deleteFolder(folderId)}
          >
            ×
          </button>
        </span>
      </div>
      {open && (
        <div className="hive-folder-body">
          {items.map((item) => (
            <ItemRow key={item.id} item={item} />
          ))}
          {items.length === 0 && (
            <div className="hive-side-empty">drag docs here</div>
          )}
        </div>
      )}
    </div>
  );
}

function SpaceName() {
  const spaces = useAppStore((s) => s.spaces);
  const activeSpaceId = useAppStore((s) => s.activeSpaceId);
  const updateSpace = useAppStore((s) => s.updateSpace);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const space = spaces.find((s) => s.id === activeSpaceId);
  if (!space) return null;

  if (editing) {
    return (
      <input
        className="hive-input hive-space-name-input"
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          void updateSpace(space.id, { name: draft });
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setEditing(false);
        }}
      />
    );
  }
  return (
    <div
      className="hive-space-name"
      title="Double-click to rename"
      onDoubleClick={() => {
        setDraft(space.name);
        setEditing(true);
      }}
    >
      {space.icon && (
        <span className="hive-space-name-icon">
          <Glyph icon={space.icon} size={14} />
        </span>
      )}
      <span className="hive-space-name-text">{space.name}</span>
    </div>
  );
}

/** Two-finger horizontal trackpad swipe (wheel deltaX) switches Spaces. */
const SWIPE_THRESHOLD = 90;
const SWIPE_COOLDOWN_MS = 450;

function useSwipeToSwitch() {
  const switchSpaceRelative = useAppStore((s) => s.switchSpaceRelative);
  const acc = useRef(0);
  const cooldownUntil = useRef(0);
  const lastEvent = useRef(0);

  return (e: React.WheelEvent) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    const now = Date.now();
    if (now < cooldownUntil.current) return;
    if (now - lastEvent.current > 250) acc.current = 0; // new gesture
    lastEvent.current = now;
    acc.current += e.deltaX;
    if (Math.abs(acc.current) >= SWIPE_THRESHOLD) {
      void switchSpaceRelative(acc.current > 0 ? 1 : -1);
      acc.current = 0;
      cooldownUntil.current = now + SWIPE_COOLDOWN_MS;
    }
  };
}

function InboxBell() {
  const inboxCount = useAppStore((s) => s.inbox.length);
  const dueCount = useSyncExternalStore(
    subscribeReminders,
    () => dueReminders().length,
    () => 0,
  );
  const count = inboxCount + dueCount;
  const setInboxOpen = useAppStore((s) => s.setInboxOpen);
  return (
    <button
      className="hive-newpage-btn hive-inbox-iconbtn"
      onClick={() => setInboxOpen(true)}
      title={`Comments, mentions & review reminders${count > 0 ? ` (${count})` : ""}`}
    >
      <Bell size={15} weight={count > 0 ? "fill" : "bold"} />
      {count > 0 && <span className="hive-space-badge">{count}</span>}
    </button>
  );
}

export function Sidebar() {
  const sidebarItems = useAppStore((s) => s.sidebarItems);
  const folders = useAppStore((s) => s.folders);
  const createFolder = useAppStore((s) => s.createFolder);
  const createPage = useAppStore((s) => s.createPage);
  const openPage = useAppStore((s) => s.openPage);
  const spaces = useAppStore((s) => s.spaces);
  const activeSpaceId = useAppStore((s) => s.activeSpaceId);
  const onWheel = useSwipeToSwitch();

  // Directional slide when the Space changes. Direction must only update on
  // an actual index change — follow-up renders (sidebar refresh) would
  // otherwise recompute it as "no change" and restart the wrong animation.
  const activeIndex = spaces.findIndex((s) => s.id === activeSpaceId);
  const prevIndex = useRef(activeIndex);
  const dirRef = useRef("slide-left");
  if (activeIndex !== prevIndex.current) {
    dirRef.current =
      activeIndex > prevIndex.current ? "slide-left" : "slide-right";
    prevIndex.current = activeIndex;
  }
  const direction = dirRef.current;

  const favorites = sidebarItems.filter((i) => i.tier === "favorite");
  const pinnedLoose = sidebarItems.filter(
    (i) => i.tier === "pinned" && !i.parentFolderId,
  );
  const today = sidebarItems.filter((i) => i.tier === "today");

  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    const onMove = (ev: MouseEvent) =>
      setSidebarWidth(startWidth + (ev.clientX - startX));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <aside
      className="hive-sidebar"
      style={{ width: sidebarWidth }}
      onWheel={onWheel}
    >
      <div className="hive-sidebar-resizer" onMouseDown={startResize} />
      <div
        key={activeSpaceId ?? "none"}
        className={`hive-space-pane ${direction}`}
      >
      <div className="hive-side-toprow">
        <SpaceName />
        <InboxBell />
        <button
          className="hive-newpage-btn"
          title="New page (in your scratchpad)"
          onClick={() => void createPage(null)}
        >
          <PencilSimpleLine size={15} weight="bold" />
        </button>
      </div>

      {favorites.length > 0 && (
        <div className="hive-fav-row">
          {favorites.map((f) => (
            <FavChip key={f.id} item={f} />
          ))}
        </div>
      )}

      <div className="hive-side-section">
        <div className="hive-side-heading">
          <span>Pinned</span>
          <button
            className="hive-side-heading-action"
            title="New folder"
            onClick={() => void createFolder()}
          >
            + folder
          </button>
        </div>
        {folders.map((folder) => (
          <FolderBlock
            key={folder.id}
            folderId={folder.id}
            name={folder.name}
            items={sidebarItems.filter(
              (i) => i.tier === "pinned" && i.parentFolderId === folder.id,
            )}
          />
        ))}
        <TierList
          tier="pinned"
          items={pinnedLoose}
          emptyHint="drag from Today, or 📌 a doc"
        />
      </div>

      <div className="hive-side-section">
        <div className="hive-side-heading">
          <span>Today</span>
          <span className="hive-side-heading-note">auto-archives 24h</span>
        </div>
        <TierList tier="today" items={today} emptyHint="open a doc to start" />
      </div>
      </div>
      <VersionFooter />
      <SpaceSwitcher />
    </aside>
  );
}

/** Version + manual update control (users asked to see their version and
 * update on demand — the auto-check toast only appears when behind). */
function VersionFooter() {
  const version = useAppStore((s) => s.appVersion);
  const state = useAppStore((s) => s.updateState);
  const available = useAppStore((s) => s.availableVersion);
  const checkForUpdates = useAppStore((s) => s.checkForUpdates);
  const applyUpdate = useAppStore((s) => s.applyUpdate);

  if (state === "available" && available) {
    return (
      <button
        className="hive-version-footer update"
        title={`Update Hive to ${available} and restart`}
        onClick={() => void applyUpdate()}
      >
        <ArrowClockwise size={12} weight="bold" /> Update to {available} · restart
      </button>
    );
  }
  return (
    <button
      className="hive-version-footer"
      title="Click to check for updates"
      onClick={() => void checkForUpdates(true)}
    >
      Hive {version ? `v${version}` : "…"}
      {state === "checking" ? " · checking…" : ""}
    </button>
  );
}
