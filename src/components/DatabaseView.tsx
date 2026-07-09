import { useContext, useEffect, useRef, useState } from "react";
import {
  ArrowSquareOut,
  At,
  ArrowClockwise,
  Calendar,
  CaretCircleDown,
  Check,
  CheckSquare,
  Hash,
  LinkSimple,
  ListBullets,
  Phone,
  Plus,
  Question,
  TextAlignLeft,
  TextT,
  Trash,
  User,
  X,
} from "@phosphor-icons/react";
import { useAppStore } from "../store/appStore";
import { Glyph } from "../lib/iconSets";
import { ReadOnlyContext } from "./BlockRenderer";
import {
  fetchDatabase,
  fetchMoreRows,
  updateRowProperty,
  createRow,
  archiveRow,
  addColumn,
  addSelectOption,
  deleteSelectOption,
  propertyToText,
  renameDatabase,
  renameColumn,
  changeColumnType,
  deleteColumn,
  CREATABLE_COLUMN_TYPES,
  COLUMN_TYPE_META,
} from "../lib/databaseApi";
import type { DbSchema, DbColumn, DbRow, PropertyDraft } from "../lib/databaseApi";
import { workspaceUsers, searchUsers } from "../lib/users";
import type { WorkspaceUser } from "../lib/users";
import "../styles/database.css";

/**
 * Table (database) view for `child_database` blocks. Self-contained: no new
 * store state — only `openPage` / `showToast` / `canEdit()` from the app
 * store. Every Notion write is optimistic (revert + toast on failure); the
 * component never throws on odd data, since a personal Notion workspace can
 * contain any property shape.
 */

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function asObj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function safeText(v: unknown): string {
  try {
    return propertyToText(v);
  } catch {
    return "";
  }
}

/** Best-effort read of a property value's plain text, for the edit inputs. */
function extractText(prop: unknown, type: string): string {
  const p = asObj(prop);
  if (type === "title" || type === "rich_text") {
    const arr = p[type];
    if (!Array.isArray(arr)) return "";
    return arr
      .map((item) => {
        const o = asObj(item);
        return str(o.plain_text) || str(asObj(o.text).content);
      })
      .join("");
  }
  if (type === "url") return str(p.url);
  if (type === "email") return str(p.email);
  if (type === "phone_number") return str(p.phone_number);
  if (type === "number") {
    const n = p.number;
    return typeof n === "number" ? String(n) : "";
  }
  return "";
}

function extractCheckbox(prop: unknown): boolean {
  return asObj(prop).checkbox === true;
}

function extractSelectName(prop: unknown, type: string): string | null {
  const key = type === "status" ? "status" : "select";
  const o = asObj(asObj(prop)[key]);
  return typeof o.name === "string" ? o.name : null;
}

function extractMultiNames(prop: unknown): string[] {
  const arr = asObj(prop).multi_select;
  if (!Array.isArray(arr)) return [];
  return arr
    .map((item) => asObj(item).name)
    .filter((n): n is string => typeof n === "string");
}

function extractDateStart(prop: unknown): string {
  const d = asObj(asObj(prop).date).start;
  return typeof d === "string" ? d.slice(0, 10) : "";
}

function extractPeople(prop: unknown): { id: string; name: string }[] {
  const arr = asObj(prop).people;
  if (!Array.isArray(arr)) return [];
  return arr
    .map((item) => {
      const o = asObj(item);
      return { id: str(o.id), name: str(o.name) || "Unknown" };
    })
    .filter((p) => p.id);
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 1).toUpperCase();
  return (parts[0]!.slice(0, 1) + parts[parts.length - 1]!.slice(0, 1)).toUpperCase();
}

function optionColor(column: DbColumn, name: string): string | undefined {
  return column.options?.find((o) => o.name === name)?.color;
}

/** Icon per Notion property type, for header cells (per-type icon + name). */
const COLUMN_TYPE_ICONS: Record<string, typeof Question> = {
  title: TextT,
  rich_text: TextAlignLeft,
  number: Hash,
  select: CaretCircleDown,
  multi_select: ListBullets,
  status: ArrowClockwise,
  date: Calendar,
  checkbox: CheckSquare,
  url: LinkSimple,
  email: At,
  phone_number: Phone,
  people: User,
};

function typeIcon(type: string, size = 13) {
  const Icon = COLUMN_TYPE_ICONS[type] ?? Question;
  return <Icon size={size} />;
}

function typeLabel(type: string): string {
  return COLUMN_TYPE_META[type]?.label ?? type;
}

/** Mirrors the Notion property-value shapes closely enough that the
 * extract* readers above see the edit reflected immediately (optimistic). */
function applyDraftLocally(column: DbColumn, draft: PropertyDraft): unknown {
  switch (draft.kind) {
    case "text":
      return column.type === "title"
        ? { title: [{ plain_text: draft.text }] }
        : { rich_text: [{ plain_text: draft.text }] };
    case "number":
      return { number: draft.n };
    case "checkbox":
      return { checkbox: draft.b };
    case "select":
      return column.type === "status"
        ? { status: draft.name ? { name: draft.name } : null }
        : { select: draft.name ? { name: draft.name } : null };
    case "multi_select":
      return { multi_select: draft.names.map((name) => ({ name })) };
    case "date":
      return { date: draft.startIso ? { start: draft.startIso } : null };
    case "link": {
      const key =
        column.type === "email" ? "email" : column.type === "phone_number" ? "phone_number" : "url";
      return { [key]: draft.s };
    }
    case "people":
      return { people: draft.ids.map((id) => ({ id })) };
    default:
      return {};
  }
}

/* ---------- lazily-loaded, module-cached workspace people list ---------- */

let peopleListCache: WorkspaceUser[] | null = null;

function usePeopleList(): { people: WorkspaceUser[]; ensureLoaded: () => void } {
  const [people, setPeople] = useState<WorkspaceUser[]>(peopleListCache ?? []);
  function ensureLoaded() {
    if (peopleListCache) {
      setPeople(peopleListCache);
      return;
    }
    workspaceUsers()
      .then((users) => {
        peopleListCache = users;
        setPeople(users);
      })
      .catch(() => {});
  }
  return { people, ensureLoaded };
}

interface CellCtx {
  canEdit: boolean;
  editKey: string | null;
  editValue: string;
  onStartEdit: (row: DbRow, column: DbColumn, initial: string) => void;
  onChangeEditValue: (v: string) => void;
  onCommitEdit: (row: DbRow, column: DbColumn, value: string) => void;
  onCancelEdit: () => void;
  onCommitProperty: (row: DbRow, column: DbColumn, draft: PropertyDraft, localOverride?: unknown) => void;
  onCreateOption: (row: DbRow, column: DbColumn, name: string, multi: boolean) => void;
  onDeleteOption: (column: DbColumn, name: string) => void;
  onOpenPage: (pageId: string) => void;
}

function cellKey(row: DbRow, column: DbColumn): string {
  return `${row.pageId}:${column.id}`;
}

function TitleCell({ row, column, ctx }: { row: DbRow; column: DbColumn; ctx: CellCtx }) {
  const key = cellKey(row, column);
  const editing = ctx.editKey === key;
  const text = extractText(row.properties[column.name], "title");
  const inputRef = useRef<HTMLInputElement>(null);
  const suppressBlur = useRef(false);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="hive-db-cell-input"
        value={ctx.editValue}
        onChange={(e) => ctx.onChangeEditValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            suppressBlur.current = true;
            ctx.onCommitEdit(row, column, ctx.editValue);
          } else if (e.key === "Escape") {
            e.preventDefault();
            suppressBlur.current = true;
            ctx.onCancelEdit();
          }
        }}
        onBlur={() => {
          if (suppressBlur.current) {
            suppressBlur.current = false;
            return;
          }
          ctx.onCommitEdit(row, column, ctx.editValue);
        }}
      />
    );
  }
  return (
    <div className="hive-db-title-cell">
      <Glyph icon={row.icon} size={14} />
      <span
        className={ctx.canEdit ? "hive-db-text" : "hive-db-text readonly"}
        onClick={() => {
          if (ctx.canEdit) ctx.onStartEdit(row, column, text);
        }}
      >
        {text || <span className="placeholder">Untitled</span>}
      </span>
      <button
        type="button"
        className="hive-db-open-pill"
        title="Open as page"
        onClick={(e) => {
          e.stopPropagation();
          ctx.onOpenPage(row.pageId);
        }}
      >
        <ArrowSquareOut size={11} />
        Open
      </button>
    </div>
  );
}

const TEXT_LIKE = new Set(["rich_text", "number", "url", "email", "phone_number"]);

function TextCell({ row, column, ctx }: { row: DbRow; column: DbColumn; ctx: CellCtx }) {
  const key = cellKey(row, column);
  const editing = ctx.editKey === key;
  const text = extractText(row.properties[column.name], column.type);
  const inputRef = useRef<HTMLInputElement>(null);
  const suppressBlur = useRef(false);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="hive-db-cell-input"
        type={column.type === "number" ? "number" : "text"}
        value={ctx.editValue}
        onChange={(e) => ctx.onChangeEditValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            suppressBlur.current = true;
            ctx.onCommitEdit(row, column, ctx.editValue);
          } else if (e.key === "Escape") {
            e.preventDefault();
            suppressBlur.current = true;
            ctx.onCancelEdit();
          }
        }}
        onBlur={() => {
          if (suppressBlur.current) {
            suppressBlur.current = false;
            return;
          }
          ctx.onCommitEdit(row, column, ctx.editValue);
        }}
      />
    );
  }
  return (
    <span
      className={ctx.canEdit ? "hive-db-text" : "hive-db-text readonly"}
      onClick={() => {
        if (ctx.canEdit) ctx.onStartEdit(row, column, text);
      }}
    >
      {text || <span className="placeholder">—</span>}
    </span>
  );
}

function CheckboxCell({ row, column, ctx }: { row: DbRow; column: DbColumn; ctx: CellCtx }) {
  const checked = extractCheckbox(row.properties[column.name]);
  return (
    <input
      type="checkbox"
      className="hive-db-checkbox"
      checked={checked}
      disabled={!ctx.canEdit}
      onChange={() => ctx.onCommitProperty(row, column, { kind: "checkbox", b: !checked })}
    />
  );
}

function DateCell({ row, column, ctx }: { row: DbRow; column: DbColumn; ctx: CellCtx }) {
  const value = extractDateStart(row.properties[column.name]);
  if (!ctx.canEdit) {
    return (
      <span className="hive-db-text readonly">
        {value || <span className="placeholder">—</span>}
      </span>
    );
  }
  return (
    <input
      type="date"
      className="hive-db-date"
      value={value}
      onChange={(e) =>
        ctx.onCommitProperty(row, column, { kind: "date", startIso: e.target.value || null })
      }
    />
  );
}

function OptionDropdown({
  row,
  column,
  ctx,
  multi,
  selectedNames,
}: {
  row: DbRow;
  column: DbColumn;
  ctx: CellCtx;
  multi: boolean;
  selectedNames: string[];
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(false);
        setFilter("");
      }
    };
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [open]);

  const options = column.options ?? [];
  const trimmedFilter = filter.trim();
  const filtered = trimmedFilter
    ? options.filter((o) => o.name.toLowerCase().includes(trimmedFilter.toLowerCase()))
    : options;
  const exactMatch = options.some((o) => o.name.toLowerCase() === trimmedFilter.toLowerCase());
  // the API rejects creating STATUS options (verified live) — pick-only there
  const canCreate = column.type !== "status";

  function pick(name: string) {
    if (multi) {
      const names = selectedNames.includes(name)
        ? selectedNames.filter((n) => n !== name)
        : [...selectedNames, name];
      ctx.onCommitProperty(row, column, { kind: "multi_select", names });
      return;
    }
    ctx.onCommitProperty(row, column, {
      kind: "select",
      name: selectedNames[0] === name ? null : name,
    });
    setOpen(false);
    setFilter("");
  }

  function createAndPick() {
    if (!trimmedFilter || exactMatch) return;
    ctx.onCreateOption(row, column, trimmedFilter, multi);
    setFilter("");
    if (!multi) setOpen(false);
  }

  return (
    <div className="hive-db-option-cell" ref={ref}>
      <button
        type="button"
        className="hive-db-option-trigger"
        disabled={!ctx.canEdit}
        onClick={() => setOpen((o) => !o)}
      >
        {selectedNames.length > 0 ? (
          <span className="hive-db-chips">
            {selectedNames.map((n) => (
              <span key={n} className="hive-db-chip" data-hive-color={optionColor(column, n) ?? "default"}>
                {n}
              </span>
            ))}
          </span>
        ) : (
          <span className="placeholder">—</span>
        )}
      </button>
      {open && ctx.canEdit && (
        <div className="hive-db-dropdown">
          <input
            autoFocus
            className="hive-db-dropdown-filter"
            placeholder="Search or create…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setOpen(false);
                setFilter("");
              } else if (e.key === "Enter") {
                if (trimmedFilter && !exactMatch && canCreate) createAndPick();
              }
            }}
          />
          <div className="hive-db-dropdown-list">
            {filtered.map((o) => {
              const checked = selectedNames.includes(o.name);
              return (
                <div key={o.name} className="hive-db-dropdown-row hive-db-option-row" onClick={() => pick(o.name)}>
                  <span className="hive-db-chip" data-hive-color={o.color ?? "default"}>
                    {o.name}
                  </span>
                  <span className="hive-db-option-row-right">
                    {checked && <Check size={12} />}
                    {column.type !== "status" && (
                      <button
                        type="button"
                        className="hive-db-option-delete"
                        title={`Delete "${o.name}"`}
                        onClick={(e) => {
                          e.stopPropagation();
                          ctx.onDeleteOption(column, o.name);
                        }}
                      >
                        <Trash size={11} />
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
            {trimmedFilter && !exactMatch && canCreate && (
              <div className="hive-db-dropdown-row create" onClick={createAndPick}>
                + Create “{trimmedFilter}”
              </div>
            )}
            {filtered.length === 0 && !trimmedFilter && (
              <div className="hive-db-dropdown-empty">No options</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function PersonCell({ row, column, ctx }: { row: DbRow; column: DbColumn; ctx: CellCtx }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const { people, ensureLoaded } = usePeopleList();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(false);
        setFilter("");
      }
    };
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [open]);

  const current = extractPeople(row.properties[column.name]);
  const currentIds = current.map((p) => p.id);
  const filtered = searchUsers(people, filter);

  function toggle(user: WorkspaceUser) {
    const nextIds = currentIds.includes(user.id)
      ? currentIds.filter((id) => id !== user.id)
      : [...currentIds, user.id];
    const nextPeople = nextIds
      .map((id) => people.find((u) => u.id === id) ?? current.find((p) => p.id === id))
      .filter((p): p is WorkspaceUser | { id: string; name: string } => Boolean(p));
    ctx.onCommitProperty(
      row,
      column,
      { kind: "people", ids: nextIds },
      { people: nextPeople.map((p) => ({ id: p.id, name: p.name })) },
    );
  }

  return (
    <div className="hive-db-person-cell" ref={ref}>
      <button
        type="button"
        className="hive-db-option-trigger"
        disabled={!ctx.canEdit}
        onClick={() => {
          setOpen((o) => !o);
          ensureLoaded();
        }}
      >
        {current.length > 0 ? (
          <span className="hive-db-chips">
            {current.map((p) => (
              <span key={p.id} className="hive-db-person-chip">
                <span className="hive-db-avatar">{initials(p.name)}</span>
                {p.name}
              </span>
            ))}
          </span>
        ) : (
          <span className="placeholder">—</span>
        )}
      </button>
      {open && ctx.canEdit && (
        <div className="hive-db-dropdown">
          <input
            autoFocus
            className="hive-db-dropdown-filter"
            placeholder="Search people…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setOpen(false);
                setFilter("");
              }
            }}
          />
          <div className="hive-db-dropdown-list">
            {filtered.map((u) => (
              <div key={u.id} className="hive-db-dropdown-row" onClick={() => toggle(u)}>
                <span className="hive-db-person-chip">
                  <span className="hive-db-avatar">{initials(u.name)}</span>
                  {u.name}
                </span>
                {currentIds.includes(u.id) && <Check size={12} />}
              </div>
            ))}
            {filtered.length === 0 && <div className="hive-db-dropdown-empty">No people found</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function CellSwitch({ row, column, ctx }: { row: DbRow; column: DbColumn; ctx: CellCtx }) {
  try {
    if (column.type === "title") return <TitleCell row={row} column={column} ctx={ctx} />;
    if (TEXT_LIKE.has(column.type)) return <TextCell row={row} column={column} ctx={ctx} />;
    if (column.type === "checkbox") return <CheckboxCell row={row} column={column} ctx={ctx} />;
    if (column.type === "date") return <DateCell row={row} column={column} ctx={ctx} />;
    if (column.type === "people") return <PersonCell row={row} column={column} ctx={ctx} />;
    if (column.type === "select" || column.type === "status") {
      const name = extractSelectName(row.properties[column.name], column.type);
      return (
        <OptionDropdown
          row={row}
          column={column}
          ctx={ctx}
          multi={false}
          selectedNames={name ? [name] : []}
        />
      );
    }
    if (column.type === "multi_select") {
      return (
        <OptionDropdown
          row={row}
          column={column}
          ctx={ctx}
          multi
          selectedNames={extractMultiNames(row.properties[column.name])}
        />
      );
    }
    return <span className="hive-db-text readonly">{safeText(row.properties[column.name])}</span>;
  } catch {
    return <span className="hive-db-text readonly">{safeText(row.properties[column.name])}</span>;
  }
}

/** Column header: click opens a popover with rename / change-type / delete.
 * Title column is rename-only (no type change, no delete). */
function ColumnHeaderMenu({
  column,
  onRenamed,
  onTypeChanged,
  onDeleted,
}: {
  column: DbColumn;
  onRenamed: (column: DbColumn, newName: string) => void;
  onTypeChanged: (column: DbColumn, newType: string) => void;
  onDeleted: (column: DbColumn) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(column.name);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const isTitle = column.type === "title";

  useEffect(() => {
    if (!open) return;
    setName(column.name);
    const t = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", away);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("mousedown", away);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function commitRename() {
    const trimmed = name.trim();
    if (trimmed && trimmed !== column.name) onRenamed(column, trimmed);
    setOpen(false);
  }

  return (
    <div className="hive-db-th-menu" ref={ref}>
      <button type="button" className="hive-db-th-trigger" onClick={() => setOpen((o) => !o)}>
        {typeIcon(column.type)}
        <span className="name">{column.name}</span>
      </button>
      {open && (
        <div className="hive-db-dropdown hive-db-th-pop">
          <input
            ref={inputRef}
            className="hive-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setOpen(false);
            }}
          />
          {!isTitle && (
            <>
              <div className="hive-db-th-pop-label">Type</div>
              <div className="hive-db-th-types">
                {CREATABLE_COLUMN_TYPES.map((t) => {
                  const current = t === column.type;
                  return (
                    <div
                      key={t}
                      className={current ? "hive-db-th-type-row current" : "hive-db-th-type-row"}
                      onClick={() => {
                        setOpen(false);
                        if (!current) onTypeChanged(column, t);
                      }}
                    >
                      {typeIcon(t)}
                      <span>{typeLabel(t)}</span>
                      {current && <Check size={12} />}
                    </div>
                  );
                })}
              </div>
              <button
                type="button"
                className="hive-db-th-delete"
                onClick={() => {
                  setOpen(false);
                  onDeleted(column);
                }}
              >
                Delete property
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function AddColumnPopover({ schema, onAdded }: { schema: DbSchema; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<string>(CREATABLE_COLUMN_TYPES[0] ?? "rich_text");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [open]);

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setOpen(false);
    setName("");
    addColumn(schema, trimmed, type)
      .then(onAdded)
      .catch((err) => useAppStore.getState().showToast(`Couldn't add column: ${msg(err)}`));
  }

  return (
    <div className="hive-db-addcol" ref={ref}>
      <button
        type="button"
        className="hive-db-addcol-btn"
        title="Add column"
        onClick={() => setOpen((o) => !o)}
      >
        <Plus size={13} />
      </button>
      {open && (
        <div className="hive-db-dropdown hive-db-th-pop hive-db-addcol-pop">
          <input
            autoFocus
            className="hive-input"
            placeholder="Column name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") setOpen(false);
            }}
          />
          <div className="hive-db-th-types">
            {CREATABLE_COLUMN_TYPES.map((t) => {
              const selected = t === type;
              return (
                <div
                  key={t}
                  className={selected ? "hive-db-th-type-row current" : "hive-db-th-type-row"}
                  onClick={() => setType(t)}
                >
                  {typeIcon(t)}
                  <span>{typeLabel(t)}</span>
                  {selected && <Check size={12} />}
                </div>
              );
            })}
          </div>
          <button type="button" className="hive-btn hive-db-addcol-submit" disabled={!name.trim()} onClick={submit}>
            Add
          </button>
        </div>
      )}
    </div>
  );
}

export function DatabaseView({ databaseId }: { databaseId: string }) {
  const readOnly = useContext(ReadOnlyContext);
  const canEditPage = useAppStore((s) => s.canEdit());
  const canEdit = canEditPage && !readOnly;

  const [schema, setSchema] = useState<DbSchema | null>(null);
  const [rows, setRows] = useState<DbRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editKey, setEditKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const [titleEditing, setTitleEditing] = useState(false);
  const [titleValue, setTitleValue] = useState("");
  const titleInputRef = useRef<HTMLInputElement>(null);

  function load() {
    setLoading(true);
    setError(null);
    fetchDatabase(databaseId)
      .then((data) => {
        setSchema(data.schema);
        setRows(data.rows);
        setHasMore(data.hasMore);
        setCursor(data.cursor);
      })
      .catch((err) => setError(msg(err)))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [databaseId]);

  useEffect(() => {
    if (titleEditing) {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }
  }, [titleEditing]);

  function loadMore() {
    if (!schema || !cursor || loadingMore) return;
    setLoadingMore(true);
    fetchMoreRows(schema, cursor)
      .then((res) => {
        setRows((prev) => [...prev, ...res.rows]);
        setHasMore(res.hasMore);
        setCursor(res.cursor);
      })
      .catch((err) =>
        useAppStore.getState().showToast(`Couldn't load more rows: ${msg(err)}`),
      )
      .finally(() => setLoadingMore(false));
  }

  function commitProperty(row: DbRow, column: DbColumn, draft: PropertyDraft, localOverride?: unknown) {
    const prevValue = row.properties[column.name];
    const nextValue = localOverride !== undefined ? localOverride : applyDraftLocally(column, draft);
    setRows((prev) =>
      prev.map((r) =>
        r.pageId === row.pageId
          ? { ...r, properties: { ...r.properties, [column.name]: nextValue } }
          : r,
      ),
    );
    updateRowProperty(row.pageId, column, draft).catch((err) => {
      setRows((prev) =>
        prev.map((r) =>
          r.pageId === row.pageId
            ? { ...r, properties: { ...r.properties, [column.name]: prevValue } }
            : r,
        ),
      );
      useAppStore.getState().showToast(`Couldn't save: ${msg(err)}`);
    });
  }

  function createOption(row: DbRow, column: DbColumn, name: string, multi: boolean) {
    if (!schema) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const prevColumns = schema.columns;
    const prevValue = row.properties[column.name];

    setSchema((prev) =>
      prev
        ? {
            ...prev,
            columns: prev.columns.map((c) =>
              c.id === column.id ? { ...c, options: [...(c.options ?? []), { name: trimmed }] } : c,
            ),
          }
        : prev,
    );
    const draft: PropertyDraft = multi
      ? { kind: "multi_select", names: [...extractMultiNames(row.properties[column.name]), trimmed] }
      : { kind: "select", name: trimmed };
    const nextValue = applyDraftLocally(column, draft);
    setRows((prev) =>
      prev.map((r) =>
        r.pageId === row.pageId
          ? { ...r, properties: { ...r.properties, [column.name]: nextValue } }
          : r,
      ),
    );

    addSelectOption(schema, column, trimmed)
      .then(() => updateRowProperty(row.pageId, column, draft))
      .catch((err) => {
        setSchema((prev) => (prev ? { ...prev, columns: prevColumns } : prev));
        setRows((prev) =>
          prev.map((r) =>
            r.pageId === row.pageId
              ? { ...r, properties: { ...r.properties, [column.name]: prevValue } }
              : r,
          ),
        );
        useAppStore.getState().showToast(`Couldn't add option: ${msg(err)}`);
      });
  }

  /** Clears the deleted option's chip from any row currently showing it —
   * mirrors what Notion does server-side when an option disappears. */
  function stripOptionFromRows(rowsIn: DbRow[], column: DbColumn, optionName: string): DbRow[] {
    return rowsIn.map((r) => {
      const val = r.properties[column.name];
      if (column.type === "multi_select") {
        const names = extractMultiNames(val);
        if (!names.includes(optionName)) return r;
        const nextNames = names.filter((n) => n !== optionName);
        return {
          ...r,
          properties: {
            ...r.properties,
            [column.name]: { multi_select: nextNames.map((name) => ({ name })) },
          },
        };
      }
      if (extractSelectName(val, column.type) !== optionName) return r;
      return { ...r, properties: { ...r.properties, [column.name]: { select: null } } };
    });
  }

  function handleDeleteOption(column: DbColumn, optionName: string) {
    if (!schema) return;
    const prevSchema = schema;
    const prevRows = rows;
    setSchema((prev) =>
      prev
        ? {
            ...prev,
            columns: prev.columns.map((c) =>
              c.id === column.id
                ? { ...c, options: (c.options ?? []).filter((o) => o.name !== optionName) }
                : c,
            ),
          }
        : prev,
    );
    setRows((prev) => stripOptionFromRows(prev, column, optionName));
    deleteSelectOption(schema, column, optionName).catch((err) => {
      setSchema(prevSchema);
      setRows(prevRows);
      useAppStore.getState().showToast(`Couldn't delete option: ${msg(err)}`);
    });
  }

  function startEdit(row: DbRow, column: DbColumn, initial: string) {
    setEditKey(cellKey(row, column));
    setEditValue(initial);
  }
  function cancelEdit() {
    setEditKey(null);
  }
  function commitEdit(row: DbRow, column: DbColumn, value: string) {
    setEditKey(null);
    if (column.type === "number") {
      const n = value.trim() === "" ? null : Number(value);
      commitProperty(row, column, { kind: "number", n: n !== null && Number.isFinite(n) ? n : null });
      return;
    }
    if (column.type === "url" || column.type === "email" || column.type === "phone_number") {
      commitProperty(row, column, { kind: "link", s: value.trim() === "" ? null : value });
      return;
    }
    commitProperty(row, column, { kind: "text", text: value });
  }

  function handleNewRow() {
    if (!schema) return;
    createRow(schema, "")
      .then((row) => {
        setRows((prev) => [...prev, row]);
        startEdit(row, schema.columns[0], "");
      })
      .catch((err) => useAppStore.getState().showToast(`Couldn't create row: ${msg(err)}`));
  }

  function handleArchiveRow(row: DbRow) {
    setRows((prev) => prev.filter((r) => r.pageId !== row.pageId));
    archiveRow(row.pageId)
      .then(() => useAppStore.getState().showToast("Row moved to trash"))
      .catch((err) => {
        setRows((prev) => [...prev, row]);
        useAppStore.getState().showToast(`Couldn't delete row: ${msg(err)}`);
      });
  }

  function startTitleEdit() {
    if (!schema) return;
    setTitleValue(schema.title === "Untitled" ? "" : schema.title);
    setTitleEditing(true);
  }
  function cancelTitleEdit() {
    setTitleEditing(false);
  }
  function commitTitleEdit(value: string) {
    setTitleEditing(false);
    if (!schema) return;
    const trimmed = value.trim();
    const finalTitle = trimmed || "Untitled";
    if (finalTitle === schema.title) return;
    const prevTitle = schema.title;
    setSchema((prev) => (prev ? { ...prev, title: finalTitle } : prev));
    renameDatabase(schema.databaseId, schema.dataSourceId, finalTitle).catch((err) => {
      setSchema((prev) => (prev ? { ...prev, title: prevTitle } : prev));
      useAppStore.getState().showToast(`Couldn't rename database: ${msg(err)}`);
    });
  }

  function handleRenameColumn(column: DbColumn, newName: string) {
    if (!schema) return;
    const trimmed = newName.trim();
    if (!trimmed || trimmed === column.name) return;
    const prevSchema = schema;
    const prevRows = rows;
    const isTitle = column.type === "title";
    setSchema((prev) =>
      prev
        ? {
            ...prev,
            columns: prev.columns.map((c) => (c.id === column.id ? { ...c, name: trimmed } : c)),
            titleColumnName: isTitle ? trimmed : prev.titleColumnName,
          }
        : prev,
    );
    setRows((prev) =>
      prev.map((r) => {
        if (!(column.name in r.properties)) return r;
        const nextProps = { ...r.properties };
        nextProps[trimmed] = nextProps[column.name];
        delete nextProps[column.name];
        return { ...r, properties: nextProps };
      }),
    );
    renameColumn(schema, column, trimmed).catch((err) => {
      setSchema(prevSchema);
      setRows(prevRows);
      useAppStore.getState().showToast(`Couldn't rename property: ${msg(err)}`);
    });
  }

  function handleChangeColumnType(column: DbColumn, newType: string) {
    if (!schema || newType === column.type) return;
    const prevSchema = schema;
    setSchema((prev) =>
      prev
        ? {
            ...prev,
            columns: prev.columns.map((c) =>
              c.id === column.id ? { ...c, type: newType, options: undefined } : c,
            ),
          }
        : prev,
    );
    changeColumnType(schema, column, newType)
      .then(() => load())
      .catch((err) => {
        setSchema(prevSchema);
        useAppStore.getState().showToast(`Couldn't change property type: ${msg(err)}`);
      });
  }

  function handleDeleteColumn(column: DbColumn) {
    if (!schema) return;
    const prevSchema = schema;
    setSchema((prev) =>
      prev ? { ...prev, columns: prev.columns.filter((c) => c.id !== column.id) } : prev,
    );
    deleteColumn(schema, column).catch((err) => {
      setSchema(prevSchema);
      useAppStore.getState().showToast(`Couldn't delete property: ${msg(err)}`);
    });
  }

  if (loading) {
    return (
      <div className="hive-db hive-db-skeleton">
        <div className="hive-db-titlebar">
          <span className="hive-db-skel-bar" />
        </div>
        <div className="hive-db-skel-rows">
          <span className="hive-db-skel-row" />
          <span className="hive-db-skel-row" />
          <span className="hive-db-skel-row" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="hive-db hive-db-error">
        <span>Couldn't load this database: {error}</span>
        <button
          className="hive-btn hive-btn-secondary"
          onClick={() => {
            void import("@tauri-apps/api/core").then((m) =>
              m.invoke("open_in_notion", { pageId: databaseId }),
            );
          }}
        >
          Open in Notion
        </button>
      </div>
    );
  }

  if (!schema) return null;

  const ctx: CellCtx = {
    canEdit,
    editKey,
    editValue,
    onStartEdit: startEdit,
    onChangeEditValue: setEditValue,
    onCommitEdit: commitEdit,
    onCancelEdit: cancelEdit,
    onCommitProperty: commitProperty,
    onCreateOption: createOption,
    onDeleteOption: handleDeleteOption,
    onOpenPage: (pageId: string) => void useAppStore.getState().openPage(pageId),
  };

  const totalCols = schema.columns.length + (canEdit ? 1 : 0);

  return (
    <div className="hive-db">
      <div className="hive-db-titlebar">
        {titleEditing ? (
          <input
            ref={titleInputRef}
            className="hive-db-title-input"
            value={titleValue}
            onChange={(e) => setTitleValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitTitleEdit(titleValue);
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelTitleEdit();
              }
            }}
            onBlur={() => commitTitleEdit(titleValue)}
          />
        ) : (
          <h3
            className={canEdit ? "hive-db-title-display" : "hive-db-title-display readonly"}
            onClick={() => {
              if (canEdit) startTitleEdit();
            }}
          >
            <Glyph icon={schema.icon} size={16} />
            {schema.title === "Untitled" ? (
              <span className="placeholder">Untitled</span>
            ) : (
              schema.title
            )}
          </h3>
        )}
        {canEdit && (
          <button type="button" className="hive-btn hive-db-new-btn" onClick={handleNewRow}>
            <Plus size={13} weight="bold" />
            New
          </button>
        )}
      </div>
      <div className="hive-db-tablewrap">
        <table className="hive-db-table">
          <thead>
            <tr>
              {schema.columns.map((column) => (
                <th key={column.id} className="hive-db-th-cell">
                  {canEdit ? (
                    <ColumnHeaderMenu
                      column={column}
                      onRenamed={handleRenameColumn}
                      onTypeChanged={handleChangeColumnType}
                      onDeleted={handleDeleteColumn}
                    />
                  ) : (
                    <div className="hive-db-th-static">
                      {typeIcon(column.type)}
                      <span className="name">{column.name}</span>
                    </div>
                  )}
                </th>
              ))}
              {canEdit && (
                <th className="hive-db-th-add">
                  <AddColumnPopover schema={schema} onAdded={load} />
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.pageId} className="hive-db-row">
                {schema.columns.map((column) => (
                  <td key={column.id} className="hive-db-td">
                    <CellSwitch row={row} column={column} ctx={ctx} />
                  </td>
                ))}
                {canEdit && (
                  <td className="hive-db-gutter">
                    <button
                      type="button"
                      className="hive-db-archive"
                      title="Move to trash"
                      onClick={() => handleArchiveRow(row)}
                    >
                      <X size={13} />
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td className="hive-db-empty" colSpan={totalCols}>
                  No rows yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="hive-db-bottom">
        {canEdit && (
          <button type="button" className="hive-db-newrow-row" onClick={handleNewRow}>
            <Plus size={13} /> New
          </button>
        )}
        {hasMore && (
          <button
            type="button"
            className="hive-db-loadmore-row"
            onClick={loadMore}
            disabled={loadingMore}
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        )}
        <div className="hive-db-rowcount">
          {rows.length}
          {hasMore ? "+" : ""} rows
        </div>
      </div>
    </div>
  );
}
