import { useAppStore } from "../store/appStore";

/** Comments/mentions inbox (Tier B): click opens the page, ✓ dismisses. */
export function InboxPanel() {
  const inbox = useAppStore((s) => s.inbox);
  const open = useAppStore((s) => s.inboxOpen);
  const setOpen = useAppStore((s) => s.setInboxOpen);
  const openPage = useAppStore((s) => s.openPage);
  const dismiss = useAppStore((s) => s.dismissInboxItem);
  if (!open) return null;

  return (
    <div className="hive-cmdbar-backdrop" onMouseDown={() => setOpen(false)}>
      <div className="hive-inbox" onMouseDown={(e) => e.stopPropagation()}>
        <div className="head">Inbox — comments & mentions on watched docs</div>
        {inbox.length === 0 && (
          <div className="hive-cmdbar-empty">
            Nothing new. Mentions and comments on pinned/favorited docs land
            here as the poller sweeps (~5 min).
          </div>
        )}
        {inbox.map((item) => (
          <div key={item.id} className={`row ${item.kind}`}>
            <span className="kind">{item.kind === "mention" ? "@" : "💬"}</span>
            <button
              className="body"
              onClick={() => {
                setOpen(false);
                void openPage(item.pageId);
              }}
            >
              <span className="author">{item.author}</span>
              <span className="snippet">{item.snippet}</span>
            </button>
            <button className="done" title="Mark read" onClick={() => dismiss(item.id)}>
              ✓
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
