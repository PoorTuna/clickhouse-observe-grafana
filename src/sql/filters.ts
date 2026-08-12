/**
 * Filter pill state management.
 * Adapted from grafana/clickhouse-datasource src/data/adHocFilter.ts (Apache-2.0).
 */

import { FilterPill, FilterOp } from '../types';

let _idCounter = 0;
function nextId(): string {
  return `f${Date.now()}_${_idCounter++}`;
}

/**
 * True when two pills are functionally identical — same field, op, and value(s). Used to dedupe a
 * true re-add of the exact same pill (a no-op), NOT to decide whether a *different* value on the
 * same field+op should replace the existing pill. Two `!=` (or `contains`/`not_contains`) pills on
 * one field with different values are meant to coexist (AND semantics: `x != 'a' AND x != 'b'`) —
 * comparing field+op alone (the previous behavior) silently dropped the first one whenever a
 * second "Filter out"/"Filter contains" action targeted the same field with a new value.
 * `values` (one_of/not_one_of) compared order-insensitively — the same set typed/clicked in a
 * different order is still the same filter.
 */
function samePill(
  a: Pick<FilterPill, 'field' | 'op' | 'value' | 'values'>,
  b: Pick<FilterPill, 'field' | 'op' | 'value' | 'values'>
): boolean {
  if (a.field !== b.field || a.op !== b.op) {
    return false;
  }
  if (a.values || b.values) {
    const av = [...(a.values ?? [])].sort();
    const bv = [...(b.values ?? [])].sort();
    return av.length === bv.length && av.every((v, i) => v === bv[i]);
  }
  return a.value === b.value;
}

export function addFilter(
  filters: FilterPill[],
  field: string,
  value: string,
  op: FilterOp = '='
): FilterPill[] {
  // Dedupe an exact re-add of the same field+op+value only — see samePill's doc comment for why
  // field+op alone is wrong here.
  const deduplicated = filters.filter((f) => !samePill(f, { field, op, value }));
  return [...deduplicated, { id: nextId(), field, value, op }];
}

export function removeFilter(filters: FilterPill[], id: string): FilterPill[] {
  return filters.filter((f) => f.id !== id);
}

export function toggleFilter(
  filters: FilterPill[],
  field: string,
  value: string,
  include: boolean
): FilterPill[] {
  const op: FilterOp = include ? '=' : '!=';
  return addFilter(filters, field, value, op);
}

/** Create a FilterPill from a field+value+op with a generated id. */
export function makeFilter(
  field: string,
  value: string,
  op: FilterOp = '=',
  extras?: { values?: string[]; label?: string }
): FilterPill {
  return { id: nextId(), field, value, op, ...extras };
}

/**
 * Add a fully-constructed pill to the filter list, deduping an exact re-add (same field+op+value,
 * or same field+op+values set for one_of/not_one_of) — see samePill's doc comment. A different
 * value on the same field+op appends as a second pill rather than replacing the first.
 * Preserves `values` and `label` on the incoming pill — use this instead of
 * `addFilter` when the pill may carry multi-value or custom-label data.
 */
export function addFilterPill(filters: FilterPill[], pill: FilterPill): FilterPill[] {
  const deduplicated = filters.filter((f) => !samePill(f, pill));
  return [...deduplicated, pill];
}

/** Replace one pill by id with a patched copy (edit-save). No-op if the id isn't found. */
export function updateFilter(filters: FilterPill[], id: string, patch: Partial<FilterPill>): FilterPill[] {
  return filters.map((f) => (f.id === id ? { ...f, ...patch, id: f.id } : f));
}

/** Toggle a pill's `disabled` flag in place (id-preserving). */
export function toggleDisabled(filters: FilterPill[], id: string): FilterPill[] {
  return filters.map((f) => (f.id === id ? { ...f, disabled: !f.disabled } : f));
}

const NEGATED_OP: Record<FilterOp, FilterOp> = {
  '=': '!=',
  '!=': '=',
  contains: 'not_contains',
  not_contains: 'contains',
  one_of: 'not_one_of',
  not_one_of: 'one_of',
  exists: 'not_exists',
  not_exists: 'exists',
};

/** Flip a pill's polarity (Exclude results / Include results in the pill menu). */
export function negateFilter(pill: FilterPill): FilterPill {
  return { ...pill, op: NEGATED_OP[pill.op] };
}

/** Human-readable label for a filter pill. */
export function filterLabel(f: FilterPill): string {
  // Custom label takes priority
  if (f.label) {
    return f.label;
  }
  if (f.op === 'exists') {
    return `${f.field} exists`;
  }
  if (f.op === 'not_exists') {
    return `${f.field} does not exist`;
  }
  if (f.op === 'one_of' || f.op === 'not_one_of') {
    const vals = (f.values ?? [f.value]).filter(Boolean).join(', ');
    return f.op === 'one_of'
      ? `${f.field} is one of [${vals}]`
      : `${f.field} is not one of [${vals}]`;
  }
  if (f.value === '' && f.op === '=') {
    return `${f.field} is empty`;
  }
  const opSymbol: Record<FilterOp, string> = {
    '=': '=',
    '!=': '≠',
    contains: '~',
    not_contains: '!~',
    one_of: 'in',
    not_one_of: 'not in',
    exists: 'exists',
    not_exists: '!exists',
  };
  return `${f.field} ${opSymbol[f.op]} ${f.value}`;
}
