import { useAppStore } from "../store/appStore";

/**
 * Undo-instead-of-confirm (Superhuman pattern): destructive actions happen
 * immediately and offer a 6-second undo here, bottom center.
 */
export function Toast() {
  const toast = useAppStore((s) => s.toast);
  const dismissToast = useAppStore((s) => s.dismissToast);
  if (!toast) return null;

  return (
    <div className="hive-toast">
      <span>{toast.message}</span>
      {toast.undo && (
        <button
          onClick={() => {
            void toast.undo!();
            dismissToast();
          }}
        >
          {toast.actionLabel ?? "Undo"}
        </button>
      )}
      <button className="close" onClick={dismissToast}>
        ×
      </button>
    </div>
  );
}
