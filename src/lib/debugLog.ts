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
  // Notion block ids share the page's LEADING characters — the tail is the
  // unique part (logging the first 8 made every block look identical).
  const bid = wrap?.dataset.bid?.slice(-8);
  return `${el.nodeName}${cls ? `.${cls}` : ""}${bid ? `#${bid}` : ""}`;
}

/* While an editable block is focused, sample its list structure twice a
 * second and log the moment it changes — the disappearing-marker bug
 * happens MID-TYPING, between focusin samples, invisible to event taps. */
let structTimer: ReturnType<typeof setInterval> | null = null;
let structLast = "";
function structOf(el: HTMLElement): string {
  const li = el.closest("li");
  if (!li) return "NO-LI";
  const cs = getComputedStyle(li);
  return `li<${li.parentElement?.tagName} disp=${cs.display} marker=${cs.listStyleType}`;
}
function watchStructure(el: HTMLElement) {
  if (structTimer) clearInterval(structTimer);
  structLast = structOf(el);
  structTimer = setInterval(() => {
    if (document.activeElement !== el || !el.isConnected) {
      if (structTimer) clearInterval(structTimer);
      structTimer = null;
      return;
    }
    const now = structOf(el);
    if (now !== structLast) {
      dlog(`STRUCT-CHANGE ${describe(el)} ${structLast} -> ${now}`);
      structLast = now;
    }
  }, 500);
}

let selTimer: ReturnType<typeof setTimeout> | null = null;

/** ⌘⌥D: dump the DOM skeleton of the last few top-level blocks — tags,
 * classes, data-bid, and marker geometry. Ground truth for paint-level
 * mysteries (computed style says disc, no dot visible). */
function dumpDom() {
  const rows = [...document.querySelectorAll<HTMLElement>(".hive-toprow")].slice(-4);
  dlog(`=== DOM DUMP (${rows.length} rows) ===`);
  const skel = (el: Element, depth: number): void => {
    if (depth > 5) return;
    const h = el as HTMLElement;
    const cls = typeof h.className === "string" ? h.className.replace(/\s+/g, ".") : "";
    const bid = h.dataset?.bid ?? h.dataset?.blockId;
    const r = h.getBoundingClientRect?.();
    let marker = "";
    if (el.tagName === "LI") {
      const cs = getComputedStyle(el);
      marker = ` marker=${cs.listStyleType}/${cs.listStylePosition} disp=${cs.display} ovf=${cs.overflow}`;
    }
    dlog(
      `${"  ".repeat(depth)}<${el.tagName}${cls ? "." + cls : ""}${bid ? ` bid=..${bid.slice(-8)}` : ""}> x=${Math.round(r?.left ?? -1)} w=${Math.round(r?.width ?? -1)}${marker}`,
    );
    for (const c of el.children) skel(c, depth + 1);
  };
  for (const row of rows) {
    const parent = row.parentElement;
    dlog(`row parent: <${parent?.tagName}${parent && "className" in parent ? "." + String(parent.className).replace(/\s+/g, ".") : ""}> x=${Math.round(parent?.getBoundingClientRect().left ?? -1)}`);
    skel(row, 0);
  }
  dlog(`=== END DUMP ===`);
}

export function installDebugTaps(): void {
  if (!("__TAURI_INTERNALS__" in window)) return;
  dlog(`=== taps installed, app boot ===`);
  window.addEventListener(
    "keydown",
    (e) => {
      // ⌘⌥L (⌘⌥D is macOS's Show/Hide Dock — the OS eats it before us)
      if (e.metaKey && e.altKey && (e.key === "l" || e.code === "KeyL")) {
        e.preventDefault();
        dumpDom();
      }
    },
    true,
  );

  window.addEventListener("mousedown", (e) => dlog(`mousedown ${describe(e.target)}`), true);
  window.addEventListener(
    "focusin",
    (e) => {
      // For editable blocks, capture the LIST STRUCTURE at the caret —
      // "bullet disappeared with no TYPE-CHANGE" means the model is right
      // and the DOM/CSS is lying: log li presence, its ancestry, and the
      // computed marker style at focus time.
      let ctx = "";
      const el = e.target as HTMLElement | null;
      if (el?.classList?.contains("hive-editable")) {
        ctx = ` ctx=${structOf(el)}`;
        watchStructure(el);
      }
      dlog(`focusin  ${describe(e.target)}${ctx}`);
    },
    true,
  );
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
