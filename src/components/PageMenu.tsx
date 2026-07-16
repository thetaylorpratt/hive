import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../store/appStore";
import { blocksToPlainText, pageEmoji, pageTitle } from "../lib/pageMeta";
import { pageToMarkdown } from "../lib/markdownExport";
import { DEMO_PAGE_ID } from "../lib/demoPage";
import { getReminderFor, setReminder } from "../lib/reminders";
import type { HiveBlock } from "../lib/types";
import "../styles/reminders.css";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/** One-shot reminder duration presets shown in the ⏰ Reminder group. */
const DURATIONS: { label: string; ms: number }[] = [
  { label: "In 30 min", ms: 30 * MINUTE_MS },
  { label: "In 1 hour", ms: HOUR_MS },
  { label: "In 3 hours", ms: 3 * HOUR_MS },
  { label: "Tomorrow", ms: DAY_MS },
  { label: "Next week", ms: WEEK_MS },
];

/**
 * Parses a user-typed duration for the "Custom…" reminder input. Accepts:
 *   - unit-suffixed durations: "45m", "2h", "3d", "1w" (also min/hr/day/wk
 *     spelled out)
 *   - bare numbers, treated as minutes: "90" -> 90 min
 *   - fractional amounts: "1.5h" -> 90 min
 * Returns a whole-minute millisecond duration, or null if unparseable/<=0.
 * Never returns NaN.
 */
export function parseDuration(raw: string): number | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  const m = trimmed.match(
    /^(\d+(?:\.\d+)?)\s*(min|mins|minute|minutes|m|hr|hrs|hour|hours|h|day|days|d|wk|wks|week|weeks|w)?$/,
  );
  if (!m) return null;
  const amount = parseFloat(m[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = m[2] ?? "m";
  let unitMs: number;
  if (/^(min|mins|minute|minutes|m)$/.test(unit)) unitMs = MINUTE_MS;
  else if (/^(hr|hrs|hour|hours|h)$/.test(unit)) unitMs = HOUR_MS;
  else if (/^(day|days|d)$/.test(unit)) unitMs = DAY_MS;
  else if (/^(wk|wks|week|weeks|w)$/.test(unit)) unitMs = WEEK_MS;
  else return null;
  const ms = amount * unitMs;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  // Round to the nearest whole minute — sub-minute precision isn't
  // meaningful for a reminder due time.
  return Math.round(ms / MINUTE_MS) * MINUTE_MS;
}

/** "3:45 PM", or "Thu 3:45 PM" when `date` isn't today — used for both the
 * confirmation toast and the "Remove reminder (…)" label. */
function formatDueTime(date: Date): string {
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const sameDay = date.toDateString() === new Date().toDateString();
  if (sameDay) return time;
  const weekday = date.toLocaleDateString([], { weekday: "short" });
  return `${weekday} ${time}`;
}

/** Compact "in Xm/Xh/Xd/Xw" used for the header's pending-reminder status. */
function relativeUntil(dueAtIso: string): string {
  const msLeft = new Date(dueAtIso).getTime() - Date.now();
  if (msLeft <= 0) return "a moment";
  if (msLeft < HOUR_MS) return `${Math.max(1, Math.round(msLeft / MINUTE_MS))}m`;
  if (msLeft < DAY_MS) return `${Math.round(msLeft / HOUR_MS)}h`;
  if (msLeft < WEEK_MS) return `${Math.round(msLeft / DAY_MS)}d`;
  return `${Math.round(msLeft / WEEK_MS)}w`;
}

/** The ⋯ page-options menu (Notion parity, API-possible subset). */
export function PageMenu({ onClose }: { onClose: () => void }) {
  const store = useAppStore;
  const ref = useRef<HTMLDivElement>(null);
  const pageId = useAppStore((s) => s.pageId)!;
  const prefs = useAppStore((s) => s.displayPrefs);
  const spaces = useAppStore((s) => s.spaces);
  const activeSpaceId = useAppStore((s) => s.activeSpaceId);
  const folders = useAppStore((s) => s.folders);
  const realPage = pageId !== DEMO_PAGE_ID;
  const currentReminder = getReminderFor(pageId);

  const [customOpen, setCustomOpen] = useState(false);
  const [customValue, setCustomValue] = useState("");
  const [shake, setShake] = useState(false);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [onClose]);

  const item = (
    label: string,
    run: () => void,
    opts: { toggle?: boolean; on?: boolean } = {},
  ) => (
    <button
      key={label}
      className="row"
      onClick={() => {
        run();
        if (!opts.toggle) onClose();
      }}
    >
      <span>{label}</span>
      {opts.toggle && <span className={`tgl${opts.on ? " on" : ""}`} />}
    </button>
  );

  function scheduleReminder(ms: number) {
    const s = store.getState();
    const title = s.page ? pageTitle(s.page.page) : "Untitled";
    const icon = s.page ? pageEmoji(s.page.page) : null;
    const due = new Date(Date.now() + ms);
    void setReminder(pageId, title, icon, due.toISOString());
    s.showToast(`Reminder set for ${formatDueTime(due)}`);
  }

  function confirmCustom() {
    const ms = parseDuration(customValue);
    if (ms == null) {
      setShake(true);
      store.getState().showToast("Try 45m, 2h, 3d, 1w");
      window.setTimeout(() => setShake(false), 320);
      return;
    }
    scheduleReminder(ms);
    setCustomOpen(false);
    setCustomValue("");
    onClose();
  }

  return (
    <div className="hive-page-menu" ref={ref}>
      {item("Copy link", () => {
        void navigator.clipboard.writeText(
          `https://www.notion.so/${pageId.replace(/-/g, "")}`,
        );
        store.getState().showToast("Link copied");
      })}
      {item("Copy page text", () => {
        const s = store.getState();
        if (!s.page) return;
        void navigator.clipboard.writeText(
          `${pageTitle(s.page.page)}\n\n${blocksToPlainText(
            s.page.blocks as Parameters<typeof blocksToPlainText>[0],
          )}`,
        );
        store.getState().showToast("Page text copied");
      })}
      {item("Copy as Markdown", () => {
        const s = store.getState();
        if (!s.page) return;
        void navigator.clipboard.writeText(
          pageToMarkdown(pageTitle(s.page.page), s.page.blocks as HiveBlock[]),
        );
        store.getState().showToast("Markdown copied");
      })}
      <div className="sep" />
      {item(
        "Small text",
        () => store.getState().setDisplayPref("smallText", !prefs.smallText),
        { toggle: true, on: prefs.smallText },
      )}
      {item(
        "Full width",
        () => store.getState().setDisplayPref("fullWidth", !prefs.fullWidth),
        { toggle: true, on: prefs.fullWidth },
      )}
      <div className="sep" />
      {spaces
        .filter((sp) => sp.id !== activeSpaceId && sp.id !== "__private__")
        .slice(0, 4)
        .map((sp) =>
          // ph:/URL icons can't interpolate into a text label — emoji only
          item(
            `Move to ${sp.icon && !sp.icon.startsWith("ph:") && !sp.icon.startsWith("http") ? `${sp.icon} ` : ""}${sp.name}`,
            () => {
            void store.getState().movePageToSpace(pageId, sp.id);
          }),
        )}
      {realPage &&
        folders
          .slice(0, 4)
          .map((f) =>
            item(`File into 📁 ${f.name} (Hive only)`, () => {
              void store.getState().filePageIntoFolder(f.id);
            }),
          )}
      {realPage &&
        item("Move to another page…", () => store.getState().setMovePageOpen(true))}
      {item("New sub-page", () => void store.getState().createPage(pageId))}
      <div className="sep" />
      {realPage && (
        <>
          <div className="hive-pm-remind-head">
            <span>⏰ Reminder</span>
            {currentReminder && (
              <span className="hive-pm-remind-status">
                ✓ Reminds in {relativeUntil(currentReminder.nextDueAt)}
              </span>
            )}
          </div>
          {DURATIONS.map(({ label, ms }) =>
            item(label, () => scheduleReminder(ms)),
          )}
          {customOpen ? (
            <div className={`hive-pm-remind-custom-row${shake ? " shake" : ""}`}>
              <input
                autoFocus
                type="text"
                inputMode="text"
                placeholder="e.g. 45m, 2h, 3d, 1w"
                value={customValue}
                onChange={(e) => setCustomValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    confirmCustom();
                  } else if (e.key === "Escape") {
                    e.stopPropagation();
                    setCustomOpen(false);
                    setCustomValue("");
                  }
                }}
              />
            </div>
          ) : (
            <button className="row" onClick={() => setCustomOpen(true)}>
              <span>Custom…</span>
            </button>
          )}
          {currentReminder &&
            item(
              `Remove reminder (${formatDueTime(new Date(currentReminder.nextDueAt))})`,
              () => {
                void setReminder(pageId, currentReminder.title, currentReminder.icon, null);
                store.getState().showToast("Reminder removed");
              },
            )}
        </>
      )}
      <div className="sep" />
      {realPage &&
        item("Move to trash", () => void store.getState().deletePage())}
      {realPage &&
        item("Open in Notion", () => {
          void import("@tauri-apps/api/core").then((m) =>
            m.invoke("open_in_notion", { pageId }),
          );
        })}
      {realPage &&
        item("View in embedded window", () => {
          void import("@tauri-apps/api/core").then((m) =>
            m.invoke("open_embed", {
              url: `https://www.notion.so/${pageId.replace(/-/g, "")}`,
            }),
          );
        })}
    </div>
  );
}
