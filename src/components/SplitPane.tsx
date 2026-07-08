import { useAppStore } from "../store/appStore";
import { BlockList, ReadOnlyContext } from "./BlockRenderer";
import { pageEmoji, pageTitle } from "../lib/pageMeta";

/**
 * Right split pane (Phase 4): a read-only companion view — runbook beside
 * incident doc. Click the title to promote it to the main view; × closes.
 */
export function SplitPane() {
  const split = useAppStore((s) => s.split)!;
  const openPage = useAppStore((s) => s.openPage);
  const closeSplit = useAppStore((s) => s.closeSplit);
  const data = split.data;

  return (
    <aside className="hive-split">
      <div className="hive-split-head">
        <button
          className="title"
          title="Open as main view"
          onClick={() => {
            closeSplit();
            void openPage(split.pageId);
          }}
        >
          {data ? (
            <>
              {pageEmoji(data.page) && (
                <span style={{ marginRight: "0.3em" }}>{pageEmoji(data.page)}</span>
              )}
              {pageTitle(data.page)}
            </>
          ) : (
            "Loading…"
          )}
        </button>
        <button className="close" title="Close split" onClick={closeSplit}>
          ×
        </button>
      </div>
      <div className="hive-split-body">
        {data ? (
          <ReadOnlyContext.Provider value={true}>
            <BlockList blocks={data.blocks} />
          </ReadOnlyContext.Provider>
        ) : (
          <div className="hive-side-empty">No cached copy yet — fetching…</div>
        )}
      </div>
    </aside>
  );
}
