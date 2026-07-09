import { useSyncExternalStore } from "react";
import { useAppStore } from "../store/appStore";
import {
  completeReminder,
  dueReminders,
  snoozeReminder,
  subscribeReminders,
} from "../lib/reminders";
import "../styles/reminders.css";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Due reminders are, by construction, in the past — "due 12m ago", "due
 * just now", etc. */
function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  const days = Math.floor(diff / DAY);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** "Reminders" section: one-shot reminders that have come due, above the
 * comments/mentions inbox proper. */
function ReminderSection() {
  const reminders = useSyncExternalStore(subscribeReminders, dueReminders);
  const openPage = useAppStore((s) => s.openPage);
  const setOpen = useAppStore((s) => s.setInboxOpen);
  if (reminders.length === 0) return null;

  return (
    <div className="hive-reminder-section">
      <div className="hive-reminder-head">Reminders</div>
      {reminders.map((r) => (
        <div key={r.id} className="hive-reminder-row">
          <span className="icon">{r.icon ?? "📄"}</span>
          <button
            className="body"
            onClick={() => {
              setOpen(false);
              void openPage(r.pageId);
            }}
          >
            <span className="title">{r.title}</span>
            <span className="meta">reminder · due {relativeTime(r.nextDueAt)}</span>
          </button>
          <button
            className="snooze"
            title="Snooze 1 hour"
            onClick={() => void snoozeReminder(r.id)}
          >
            +1h
          </button>
          <button
            className="done"
            title="Mark done"
            onClick={() => void completeReminder(r.id)}
          >
            ✓ Done
          </button>
        </div>
      ))}
    </div>
  );
}

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
        <ReminderSection />
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
