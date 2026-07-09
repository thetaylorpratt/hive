import { useContext, useEffect, useRef, useState } from "react";
import { ArrowSquareOut, Check, Plus, X } from "@phosphor-icons/react";
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
  propertyToText,
  CREATABLE_COLUMN_TYPES,
} from "../lib/databaseApi";
import type { DbSchema, DbColumn, DbRow, PropertyDraft } from "../lib/databaseApi";
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

function optionColor(column: DbColumn, name: string): string | undefined {
  return column.options?.find((o) => o.name === name)?.color;
}

function typeLabel(type: string): string {
  return type.replace(/_/g, " ");
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
    default:
      return {};
  }
}

interface CellCtx {
  canEdit: boolean;
  editKey: string | null;
  editValue: string;
  onStartEdit: (row: DbRow, column: DbColumn, initial: string) => void;
  onChangeEditValue: (v: string) => void;
  onCommitEdit: (row: DbRow, column: DbColumn, value: string) => void;
  onCancelEdit: () => void;
  onCommitProperty: (row: DbRow, column: DbColumn, draft: PropertyDraft) => void;
  onCreateOption: (row: DbRow, column: DbColumn, name: string, multi: boolean) => void;
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
    <div className="hive-db-title">
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
        className="hive-db-open"
        title="Open as page"
        onClick={(e) => {
          e.stopPropagation();
          ctx.onOpenPage(row.pageId);
        }}
      >
        <ArrowSquareOut size={13} />
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
                <div key={o.name} className="hive-db-dropdown-row" onClick={() => pick(o.name)}>
                  <span className="hive-db-chip" data-hive-color={o.color ?? "default"}>
                    {o.name}
                  </span>
                  {checked && <Check size={12} />}
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

function CellSwitch({ row, column, ctx }: { row: DbRow; column: DbColumn; ctx: CellCtx }) {
  try {
    if (column.type === "title") return <TitleCell row={row} column={column} ctx={ctx} />;
    if (TEXT_LIKE.has(column.type)) return <TextCell row={row} column={column} ctx={ctx} />;
    if (column.type === "checkbox") return <CheckboxCell row={row} column={column} ctx={ctx} />;
    if (column.type === "date") return <DateCell row={row} column={column} ctx={ctx} />;
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
        <div className="hive-db-dropdown hive-db-addcol-pop">
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
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {CREATABLE_COLUMN_TYPES.map((t) => (
              <option key={t} value={t}>
                {typeLabel(t)}
              </option>
            ))}
          </select>
          <button type="button" className="hive-btn" disabled={!name.trim()} onClick={submit}>
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

  function commitProperty(row: DbRow, column: DbColumn, draft: PropertyDraft) {
    const prevValue = row.properties[column.name];
    const nextValue = applyDraftLocally(column, draft);
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

  if (loading) {
    return (
      <div className="hive-db hive-db-skeleton">
        <div className="hive-db-head">
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
    onOpenPage: (pageId: string) => void useAppStore.getState().openPage(pageId),
  };

  const totalCols = schema.columns.length + (canEdit ? 1 : 0);

  return (
    <div className="hive-db">
      <div className="hive-db-head">
        <Glyph icon={schema.icon} size={16} />
        <span className="hive-db-title">{schema.title || "Untitled"}</span>
        <span className="hive-db-count">
          {rows.length}
          {hasMore ? "+" : ""}
        </span>
      </div>
      <div className="hive-db-tablewrap">
        <table className="hive-db-table">
          <thead>
            <tr>
              {schema.columns.map((column) => (
                <th key={column.id}>
                  <div className="hive-db-th">
                    <span className="name">{column.name}</span>
                    <span className="type">{typeLabel(column.type)}</span>
                  </div>
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
          <button type="button" className="hive-db-newrow" onClick={handleNewRow}>
            <Plus size={13} /> New row
          </button>
        )}
        {hasMore && (
          <button
            type="button"
            className="hive-db-loadmore"
            onClick={loadMore}
            disabled={loadingMore}
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        )}
      </div>
    </div>
  );
}
