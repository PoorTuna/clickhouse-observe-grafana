/**
 * Reducer for LogsExplorer's query-builder state (search/filters/columns/sort/raw-SQL toggle).
 * Pure and self-contained — split out of LogsExplorer.tsx so it's independently testable and
 * doesn't add to that page's size. `_`-prefixed per this repo's module-structure convention
 * (internal/supporting module, not an entry point).
 */
import { FilterPill, LogsQueryState, SelectedColumn } from '../types';

export type LogsQueryAction =
  | { type: 'SET_SEARCH'; value: string }
  | { type: 'SET_FILTERS'; filters: FilterPill[] }
  | { type: 'TOGGLE_RAW_SQL' }
  | { type: 'SET_RAW_SQL'; sql: string }
  // `columns` on every one of these is the caller's current *displayed* list (effectiveColumns),
  // not state.columns — state.columns is empty until the user's first explicit column change, so
  // acting against state.columns directly would silently no-op (reorder) or blow away the
  // still-visible default set (add — appending to [] replaces defaultColumns() as soon as
  // effectiveColumns switches from the fallback to state.columns).
  // `targetId`: when set, the new column is inserted immediately before it instead of appended
  // at the end — lets a sidebar field drag land wherever the user actually dropped it.
  | { type: 'ADD_COLUMN'; col: SelectedColumn; columns: SelectedColumn[]; targetId?: string }
  | { type: 'REMOVE_COLUMN'; id: string; columns: SelectedColumn[] }
  | { type: 'REORDER_COLUMN'; id: string; direction: 'left' | 'right'; columns: SelectedColumn[] }
  | { type: 'MOVE_COLUMN_TO'; id: string; targetId: string; columns: SelectedColumn[] }
  | { type: 'SET_SORT'; col: string }
  | { type: 'LOAD_SAVED'; state: Partial<LogsQueryState> };

export function logsQueryReducer(state: LogsQueryState, action: LogsQueryAction): LogsQueryState {
  switch (action.type) {
    case 'SET_SEARCH':
      return { ...state, search: action.value };
    case 'SET_FILTERS':
      return { ...state, filters: action.filters };
    case 'TOGGLE_RAW_SQL':
      return { ...state, useRawSql: !state.useRawSql };
    case 'SET_RAW_SQL':
      return { ...state, rawSql: action.sql };
    case 'ADD_COLUMN': {
      if (action.columns.some((c) => c.id === action.col.id)) {
        return state;
      }
      const targetIdx = action.targetId ? action.columns.findIndex((c) => c.id === action.targetId) : -1;
      if (targetIdx === -1) {
        return { ...state, columns: [...action.columns, action.col] };
      }
      const next = [...action.columns];
      next.splice(targetIdx, 0, action.col);
      return { ...state, columns: next };
    }
    case 'REMOVE_COLUMN': {
      // If the removed column was the active sort target, clear sort — its `key` was only ever
      // a synthetic SELECT alias (see extraSelect in buildLogsQuery), so leaving it in state.sort
      // produces an `ORDER BY fld_...` with no matching column once the SELECT drops it, which
      // ClickHouse rejects outright ("Unknown identifier").
      const removed = action.columns.find((c) => c.id === action.id);
      const sort = removed && state.sort?.col === removed.key ? undefined : state.sort;
      return { ...state, columns: action.columns.filter((c) => c.id !== action.id), sort };
    }
    case 'REORDER_COLUMN': {
      const idx = action.columns.findIndex((c) => c.id === action.id);
      if (idx === -1) {
        return state;
      }
      const next = [...action.columns];
      const swapIdx = action.direction === 'left' ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= next.length) {
        return state;
      }
      [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
      return { ...state, columns: next };
    }
    case 'MOVE_COLUMN_TO': {
      // Drag-and-drop reorder: pull the dragged column out and reinsert it at the target
      // column's position — an arbitrary-distance move, unlike REORDER_COLUMN's adjacent swap.
      if (action.id === action.targetId) {
        return state;
      }
      const fromIdx = action.columns.findIndex((c) => c.id === action.id);
      const toIdx = action.columns.findIndex((c) => c.id === action.targetId);
      if (fromIdx === -1 || toIdx === -1) {
        return state;
      }
      const next = [...action.columns];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return { ...state, columns: next };
    }
    case 'SET_SORT': {
      const current = state.sort;
      const dir: 'asc' | 'desc' =
        current?.col === action.col && current.dir === 'desc' ? 'asc' : 'desc';
      return { ...state, sort: { col: action.col, dir } };
    }
    case 'LOAD_SAVED':
      return { ...state, ...action.state };
    default:
      return state;
  }
}
