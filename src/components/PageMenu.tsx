import { useEffect, useRef } from "react";
import { useAppStore } from "../store/appStore";
import { blocksToPlainText, pageEmoji, pageTitle } from "../lib/pageMeta";
import { pageToMarkdown } from "../lib/markdownExport";
import { DEMO_PAGE_ID } from "../lib/demoPage";
import { getReminderFor, setReminder, type ReminderFreq } from "../lib/reminders";
import type { HiveBlock } from "../lib/types";

const REMINDER_FREQS: ReminderFreq[] = ["daily", "weekly", "monthly"];

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
        .filter((sp) => sp.id !== activeSpaceId)
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
          <div
            style={{
              padding: "6px 10px 2px",
              fontSize: "0.72rem",
              fontWeight: 600,
              color: "var(--hive-color-fg-muted)",
            }}
          >
            ⏰ Review reminder
          </div>
          {REMINDER_FREQS.map((freq) =>
            item(
              `${currentReminder?.frequency === freq ? "✓ " : ""}Remind: ${freq}`,
              () => {
                const s = store.getState();
                const title = s.page ? pageTitle(s.page.page) : "Untitled";
                const icon = s.page ? pageEmoji(s.page.page) : null;
                void setReminder(pageId, title, icon, freq);
                s.showToast(`You'll be reminded ${freq}`);
              },
            ),
          )}
          {currentReminder &&
            item("Remove reminder", () => {
              void setReminder(pageId, currentReminder.title, currentReminder.icon, null);
              store.getState().showToast("Reminder removed");
            })}
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
