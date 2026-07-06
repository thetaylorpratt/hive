import { useAppStore } from "../store/appStore";

/**
 * Vertical rail of Space icons (Arc parity). Ctrl+<n> switches; clicking too.
 * Each Space's accent color makes the current context obvious at a glance.
 */
export function SpaceBar() {
  const spaces = useAppStore((s) => s.spaces);
  const activeSpaceId = useAppStore((s) => s.activeSpaceId);
  const switchSpace = useAppStore((s) => s.switchSpace);
  const createSpace = useAppStore((s) => s.createSpace);

  return (
    <nav className="hive-spacebar">
      {spaces.map((space, i) => (
        <button
          key={space.id}
          className={`hive-space-dot accent-${space.color}${
            space.id === activeSpaceId ? " active" : ""
          }`}
          title={`${space.name} (⌃${i + 1})`}
          onClick={() => void switchSpace(space.id)}
        >
          {space.name.slice(0, 1).toUpperCase()}
        </button>
      ))}
      <button
        className="hive-space-dot add"
        title="New Space"
        onClick={() => void createSpace()}
      >
        +
      </button>
    </nav>
  );
}
