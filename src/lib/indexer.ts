import { notion } from "./notionClient";
import { enqueue, queueIdle } from "./queue";
import { hasCachedPage, indexPageForSearch, indexTitleIfNew } from "./db";
import { fetchFresh } from "./fetchPage";
import { blocksToPlainText, pageEmoji, pageTitle } from "./pageMeta";

/**
 * Background workspace indexer. The Notion API's search endpoint matches
 * TITLES ONLY — content search is impossible remotely. So Hive builds its
 * own: enumerate everything the integration can see, index titles
 * immediately, and crawl full page bodies into the cache + FTS a few pages
 * per cycle. Over time the whole connected workspace becomes locally
 * full-text searchable — better than the API allows.
 *
 * Politeness rules: runs only when the request queue is idle (interactive
 * work always wins), small crawl budget per cycle, cursor wraps so newly
 * connected pages are picked up on later passes.
 */

const CYCLE_MS = 2 * 60 * 1000;
const CRAWL_PAGES_PER_CYCLE = 4;

let timer: ReturnType<typeof setInterval> | null = null;
let cursor: string | undefined;
let running = false;

export interface IndexerStats {
  enumerated: number;
  crawled: number;
}
const stats: IndexerStats = { enumerated: 0, crawled: 0 };
export const indexerStats = () => ({ ...stats });

async function cycle() {
  if (running || !queueIdle()) return;
  running = true;
  try {
    const resp = (await enqueue(() =>
      notion().search({
        page_size: 50,
        filter: { property: "object", value: "page" },
        ...(cursor ? { start_cursor: cursor } : {}),
      }),
    )) as {
      results: Record<string, unknown>[];
      has_more: boolean;
      next_cursor: string | null;
    };
    cursor = resp.has_more && resp.next_cursor ? resp.next_cursor : undefined;
    stats.enumerated += resp.results.length;

    // Titles index instantly (already in the search response — free).
    for (const p of resp.results) {
      await indexTitleIfNew(p.id as string, pageTitle(p));
    }

    // Crawl a few uncached pages fully for real content search.
    let crawled = 0;
    for (const p of resp.results) {
      if (crawled >= CRAWL_PAGES_PER_CYCLE) break;
      if (!queueIdle()) break; // user became active — yield immediately
      const pageId = p.id as string;
      if (await hasCachedPage(pageId)) continue;
      try {
        const data = await fetchFresh(pageId);
        await indexPageForSearch(
          pageId,
          pageTitle(data.page),
          blocksToPlainText(
            data.blocks as Parameters<typeof blocksToPlainText>[0],
          ),
        );
        void pageEmoji; // (icons come along inside the cached page object)
        crawled += 1;
        stats.crawled += 1;
      } catch {
        /* unreachable page — skip */
      }
    }
  } catch {
    /* search hiccup — next cycle retries */
  } finally {
    running = false;
  }
}

export function startIndexer() {
  if (timer) return;
  timer = setInterval(() => void cycle(), CYCLE_MS);
  setTimeout(() => void cycle(), 10_000); // first pass shortly after boot
}
