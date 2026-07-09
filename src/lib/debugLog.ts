import { invoke } from "@tauri-apps/api/core";

/**
 * Live diagnostics for packaged-app-only bugs: event taps stream to
 * ~/.hive/debug.log (batched). Cheap enough to leave on; grep-friendly.
 */

let buf: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

export function dlog(evt: string): void {
  buf.push(`${new Date().toISOString().slice(11, 23)} ${evt}`);
  if (!timer) timer = setTimeout(flush, 400);
}

function flush(): void {
  timer = null;
  if (!buf.length) return;
  const line = buf.join("\n");
  buf = [];
  void invoke("append_debug_log", { line }).catch(() => undefined);
}

function describe(target: EventTarget | null): string {
  const el = target as HTMLElement | null;
  if (!el || !el.nodeName) return "null";
  const cls = typeof el.className === "string" ? el.className.split(" ")[0] : "";
  const wrap = el.closest?.("[data-bid]") as HTMLElement | null;
  const bid = wrap?.dataset.bid?.slice(0, 8);
  return `${el.nodeName}${cls ? `.${cls}` : ""}${bid ? `#${bid}` : ""}`;
}

let selTimer: ReturnType<typeof setTimeout> | null = null;

export function installDebugTaps(): void {
  if (!("__TAURI_INTERNALS__" in window)) return;
  dlog(`=== taps installed, app boot ===`);

  window.addEventListener("mousedown", (e) => dlog(`mousedown ${describe(e.target)}`), true);
  window.addEventListener("focusin", (e) => dlog(`focusin  ${describe(e.target)}`), true);
  window.addEventListener(
    "focusout",
    (e) => dlog(`focusout ${describe(e.target)} -> ${describe((e as FocusEvent).relatedTarget)}`),
    true,
  );
  document.addEventListener("selectionchange", () => {
    if (selTimer) return;
    selTimer = setTimeout(() => {
      selTimer = null;
      const sel = window.getSelection();
      dlog(
        `selection anchor=${describe(sel?.anchorNode?.parentElement ?? null)} off=${sel?.anchorOffset} active=${describe(document.activeElement)}`,
      );
    }, 150);
  });
  // capture phase: what arrives; bubble phase: what survived the handlers
  window.addEventListener(
    "keydown",
    (e) => {
      const k = e.key.length === 1 ? "ch" : e.key;
      dlog(`keydown  ${k} active=${describe(document.activeElement)}`);
    },
    true,
  );
  window.addEventListener("keydown", (e) => {
    if (e.defaultPrevented) {
      const k = e.key.length === 1 ? `ch(${e.key})` : e.key;
      dlog(`keydown-PREVENTED ${k} by-someone target=${describe(e.target)}`);
    }
  });
  window.addEventListener(
    "beforeinput",
    (e) =>
      dlog(
        `beforeinput ${(e as InputEvent).inputType} target=${describe(e.target)} prevented=${e.defaultPrevented}`,
      ),
    true,
  );
  window.addEventListener("input", (e) => dlog(`input    target=${describe(e.target)}`), true);
}
