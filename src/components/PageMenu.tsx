import { useEffect, useRef } from "react";
import { useAppStore } from "../store/appStore";
import { blocksToPlainText, pageTitle } from "../lib/pageMeta";
import { DEMO_PAGE_ID } from "../lib/demoPage";

/** The ⋯ page-options menu (Notion parity, API-possible subset). */
export function PageMenu({ onClose }: { onClose: () => void }) {
  const store = useAppStore;
  const ref = useRef<HTMLDivElement>(null);
  const pageId = useAppStore((s) => s.pageId)!;
  const prefs = useAppStore((s) => s.displayPrefs);
  const spaces = useAppStore((s) => s.spaces);
  const activeSpaceId = useAppStore((s) => s.activeSpaceId);
  const realPage = pageId !== DEMO_PAGE_ID;

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
      {item("New sub-page", () => void store.getState().createPage(pageId))}
      <div className="sep" />
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
