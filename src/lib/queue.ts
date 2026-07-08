/**
 * Central Notion request queue (ARCHITECTURE.md §6).
 *
 * Every Notion API call in the app funnels through `enqueue`. Token-bucket
 * limited to ~3 req/s with a small burst; 429s honor Retry-After and 5xx
 * retries use exponential backoff. This is load-bearing infrastructure for
 * later phases (prefetch, revalidation, comment polling) — do not bypass it.
 */

const CAPACITY = 3; // burst
const REFILL_PER_SEC = 3;
const MAX_ATTEMPTS = 5;
const PUMP_INTERVAL_MS = 120;

interface Job {
  fn: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  attempts: number;
}

class NotionQueue {
  private tokens = CAPACITY;
  private lastRefill = Date.now();
  private queue: Job[] = [];
  private pumping = false;

  schedule<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        fn,
        resolve: resolve as (v: unknown) => void,
        reject,
        attempts: 0,
      });
      this.pump();
    });
  }

  private refill() {
    const now = Date.now();
    this.tokens = Math.min(
      CAPACITY,
      this.tokens + ((now - this.lastRefill) / 1000) * REFILL_PER_SEC,
    );
    this.lastRefill = now;
  }

  private pump() {
    if (this.pumping) return;
    this.pumping = true;
    const tick = () => {
      this.refill();
      while (this.queue.length > 0 && this.tokens >= 1) {
        this.tokens -= 1;
        void this.run(this.queue.shift()!);
      }
      if (this.queue.length > 0) {
        setTimeout(tick, PUMP_INTERVAL_MS);
      } else {
        this.pumping = false;
      }
    };
    tick();
  }

  private async run(job: Job) {
    try {
      job.resolve(await job.fn());
    } catch (err) {
      job.attempts += 1;
      if (isRetryable(err) && job.attempts < MAX_ATTEMPTS) {
        const retryAfterSec = readRetryAfter(err);
        const delay =
          retryAfterSec !== null
            ? retryAfterSec * 1000
            : Math.min(30_000, 1000 * 2 ** job.attempts);
        setTimeout(() => {
          this.queue.push(job);
          this.pump();
        }, delay);
      } else {
        job.reject(err);
      }
    }
  }
}

function isRetryable(err: unknown): boolean {
  const e = err as { status?: number; code?: string };
  if (e?.code === "rate_limited") return true;
  return typeof e?.status === "number" && (e.status === 429 || e.status >= 500);
}

function readRetryAfter(err: unknown): number | null {
  const headers = (err as { headers?: unknown })?.headers;
  let raw: unknown;
  if (headers && typeof (headers as Headers).get === "function") {
    raw = (headers as Headers).get("retry-after");
  } else if (headers && typeof headers === "object") {
    raw = (headers as Record<string, unknown>)["retry-after"];
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

let inflight = 0;

/** True when nothing is queued or executing — crawlers should only run then. */
export function queueIdle(): boolean {
  return inflight === 0;
}

const notionQueue = new NotionQueue();

export function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  inflight += 1;
  const done = () => {
    inflight -= 1;
  };
  const run = notionQueue.schedule(fn);
  run.then(done, done);
  return run;
}
