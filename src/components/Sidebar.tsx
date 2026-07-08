import { useRef, useState } from "react";
import { Bell, PencilSimpleLine } from "@phosphor-icons/react";
import { Glyph } from "../lib/iconSets";
import { useAppStore } from "../store/appStore";
import { SpaceSwitcher } from "./SpaceSwitcher";
import type { SidebarItem, Tier } from "../lib/orgDb";

/**
 * Per-Space sidebar: Favorites (icon row, transcend Spaces), Pinned,
 * Folders, and Today (ephemeral, auto-archived after 24h).
 *
 * Drag & drop is native HTML5 for v1 (reorder within a tier, drag Today →
 * Pinned to pin, drop onto a folder to file). dnd-kit is the upgrade path
 * if the interaction needs more polish later.
 */

const DRAG_MIME = "application/x-hive-item";

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

  return (
    <div
      className={`hive-side-row${active ? " active" : ""}`}
      draggable
      onDragStart={(e) => {
        closePeek();
        e.dataTransfer.setData(DRAG_MIME, item.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={() => {
        closePeek();
        void openPage(item.notionPageId);
      }}
      onMouseEnter={(e) =>
        requestPeek(item.notionPageId, e.currentTarget.getBoundingClientRect().top)
      }
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
    e.preventDefault();
    setOverIndex(null);
    const draggedId = e.dataTransfer.getData(DRAG_MIME);
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
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
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
  const moveItemToFolder = useAppStore((s) => s.moveItemToFolder);
  const setItemTier = useAppStore((s) => s.setItemTier);
  const sidebarItems = useAppStore((s) => s.sidebarItems);
  const deleteFolder = useAppStore((s) => s.deleteFolder);

  return (
    <div className={`hive-folder${dropping ? " dropping" : ""}`}>
      <div
        className="hive-folder-head"
        onClick={() => setOpen(!open)}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
          e.preventDefault();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDropping(false);
          const draggedId = e.dataTransfer.getData(DRAG_MIME);
          const dragged = sidebarItems.find((i) => i.id === draggedId);
          if (!dragged) return;
          void (async () => {
            // Folders live in the pinned section; filing implies pinning.
            if (dragged.tier !== "pinned") await setItemTier(draggedId, "pinned");
            await moveItemToFolder(draggedId, folderId);
          })();
        }}
      >
        <span className="chevron">{open ? "▾" : "▸"}</span>
        <span className="title">{name}</span>
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
        <span style={{ marginRight: "0.4em" }}>
          <Glyph icon={space.icon} size={14} />
        </span>
      )}
      {space.name}
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
  const count = useAppStore((s) => s.inbox.length);
  const setInboxOpen = useAppStore((s) => s.setInboxOpen);
  return (
    <button
      className="hive-newpage-btn hive-inbox-iconbtn"
      onClick={() => setInboxOpen(true)}
      title={`Comments & mentions inbox${count > 0 ? ` (${count})` : ""}`}
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
            <button
              key={f.id}
              className="hive-fav"
              title={f.titleCache}
              onClick={() => void openPage(f.notionPageId)}
            >
              {f.iconCache ? (
                <Glyph icon={f.iconCache} size={15} />
              ) : (
                f.titleCache.slice(0, 1).toUpperCase()
              )}
            </button>
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
      <SpaceSwitcher />
    </aside>
  );
}
