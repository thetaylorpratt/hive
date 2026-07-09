import { useEffect, useRef, useState } from "react";
import { ArrowUp } from "@phosphor-icons/react";
import { searchUsers, workspaceUsers } from "../lib/users";
import type { WorkspaceUser } from "../lib/users";
import type { DraftMention } from "../lib/commentDraft";

const TRAILING_AT = /@([A-Za-z0-9][A-Za-z0-9._-]*(?: [A-Za-z0-9._-]*)?)?$/;

/** Comment input with Notion-style @people autocomplete. Mentions are
 * tracked as (name → id) picks; the submitted draft carries both the plain
 * text and the mention list for sink-specific conversion. */
export function MentionInput({
  placeholder,
  autoFocus,
  withButton,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  autoFocus?: boolean;
  withButton?: boolean;
  onSubmit: (text: string, mentions: DraftMention[]) => void;
  onCancel?: () => void;
}) {
  const [value, setValue] = useState("");
  const [menu, setMenu] = useState<{ query: string; index: number } | null>(null);
  const [people, setPeople] = useState<WorkspaceUser[]>([]);
  const picked = useRef<DraftMention[]>([]);
  const matches = menu ? searchUsers(people, menu.query) : [];

  useEffect(() => {
    if (menu && people.length === 0) {
      void workspaceUsers().then(setPeople).catch(() => undefined);
    }
  }, [menu, people.length]);

  const pick = (u: WorkspaceUser) => {
    setValue((v) => v.replace(TRAILING_AT, `@${u.name} `));
    if (!picked.current.some((m) => m.id === u.id)) {
      picked.current.push({ id: u.id, name: u.name });
    }
    setMenu(null);
  };

  const submit = () => {
    const text = value.trim();
    if (!text) return;
    const used = picked.current.filter((m) => text.includes(`@${m.name}`));
    setValue("");
    picked.current = [];
    onSubmit(text, used);
  };

  return (
    <span className="hive-mention-input">
      <input
        className="hive-input"
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          setValue(v);
          const m = /(?:^|\s)@([A-Za-z0-9][A-Za-z0-9._-]*(?: [A-Za-z0-9._-]*)?)?$/.exec(v);
          setMenu(m ? { query: m[1] ?? "", index: 0 } : null);
        }}
        onKeyDown={(e) => {
          if (menu && matches.length > 0) {
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              pick(matches[menu.index]);
              return;
            }
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const delta = e.key === "ArrowDown" ? 1 : -1;
              setMenu(
                (prev) =>
                  prev && {
                    ...prev,
                    index: (prev.index + delta + matches.length) % matches.length,
                  },
              );
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setMenu(null);
              return;
            }
          }
          if (e.key === "Enter") submit();
          if (e.key === "Escape") onCancel?.();
        }}
      />
      {withButton && (
        <button className="hive-btn hive-btn-primary" onClick={submit} title="Send">
          <ArrowUp size={14} weight="bold" />
        </button>
      )}
      {menu && matches.length > 0 && (
        <div className="hive-slash-menu hive-mention-menu">
          {matches.map((u, i) => (
            <div
              key={u.id}
              className={`hive-slash-row${i === menu.index ? " selected" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(u);
              }}
            >
              <span style={{ marginRight: "0.5em" }}>👤</span>
              {u.name}
            </div>
          ))}
        </div>
      )}
    </span>
  );
}
