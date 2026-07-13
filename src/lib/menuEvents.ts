/**
 * Real macOS app menu (Hive/File/Edit/View/Window/Help): the Rust side
 * (src-tauri/src/lib.rs, `build_app_menu`) builds the menu and sets it as
 * THE app menu via `app.set_menu`. Predefined items (About, Services, Hide,
 * Undo/Cut/Copy/Paste/SelectAll, Fullscreen, Minimize, Zoom, Quit) are
 * handled natively by macOS/WKWebView and never reach here. Everything else
 * — our custom MenuItemBuilder ids — surfaces the main window Rust-side and
 * then emits ONE event, "hive://menu", with the item id as payload. This
 * module listens for that event and dispatches to the matching store action,
 * same pattern as trayEvents.ts and globalCapture.ts.
 *
 * Guarded for plain-browser/preview dev, same pattern as the other listener
 * modules: outside Tauri there's no native menu and no event to listen for.
 */
import { useAppStore } from "../store/appStore";

const MENU_EVENT = "hive://menu";

const isTauri = "__TAURI_INTERNALS__" in window;

/**
 * Starts listening for native app-menu events and returns an unlisten
 * function. Safe to call in non-Tauri environments (no-ops there).
 */
export async function installMenuListeners(): Promise<() => void> {
  if (!isTauri) return () => undefined;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    const unlisten = await listen<string>(MENU_EVENT, (event) => {
      const store = useAppStore.getState();
      switch (event.payload) {
        case "settings":
          store.setSettingsOpen(true);
          break;
        case "text-bigger":
          store.adjustTextScale(1);
          break;
        case "text-smaller":
          store.adjustTextScale(-1);
          break;
        case "text-reset":
          store.adjustTextScale(0);
          break;
        case "toggle-sidebar":
          store.toggleSidebar();
          break;
        case "focus-mode":
          store.toggleFocusMode();
          break;
        case "capture":
          store.setCaptureOpen(true);
          break;
        case "new-page":
          void store.createPage(null);
          break;
        case "check-updates":
          void store.checkForUpdates(true);
          break;
        case "shortcut-sheet":
          store.setShortcutSheetOpen(true);
          break;
        default:
          break;
      }
    });
    return unlisten;
  } catch {
    // Best-effort — if the event API isn't available for some reason, the
    // in-app keymap and UI buttons still cover the same actions.
    return () => undefined;
  }
}
