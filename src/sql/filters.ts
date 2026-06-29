/**
 * Filter pill state management.
 * Adapted from grafana/clickhouse-datasource src/data/adHocFilter.ts (Apache-2.0).
 */

import { FilterPill, FilterOp } from '../types';

let _idCounter = 0;
function nextId(): string {
  return `f${Date.now()}_${_idCounter++}`;
}

export function addFilter(
  filters: FilterPill[],
  field: string,
  value: string,
  op: FilterOp = '='
): FilterPill[] {
  // Replace any existing pill with the same field+op
  const deduplicated = filters.filter((f) => !(f.field === field && f.op === op));
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

/**
 * Parse shorthand filter syntax typed into the search bar:
 *   `field:value`  → { field, value, op: '=' }
 *   `field!=value` → { field, value, op: '!=' }
 *
 * Returns null if the string doesn't match shorthand syntax.
 */
export function parseFilterShorthand(input: string): Omit<FilterPill, 'id'> | null {
  const neqMatch = /^([A-Za-z_][A-Za-z0-9_.[\]']*)\s*!=\s*(.+)$/.exec(input.trim());
  if (neqMatch) {
    return { field: neqMatch[1], value: neqMatch[2].trim(), op: '!=' };
  }

  const colonMatch = /^([A-Za-z_][A-Za-z0-9_.[\]']*):(.+)$/.exec(input.trim());
  if (colonMatch) {
    return { field: colonMatch[1], value: colonMatch[2].trim(), op: '=' };
  }

  const eqMatch = /^([A-Za-z_][A-Za-z0-9_.[\]']*)\s*=\s*(.+)$/.exec(input.trim());
  if (eqMatch) {
    return { field: eqMatch[1], value: eqMatch[2].trim(), op: '=' };
  }

  return null;
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
 * Add a fully-constructed pill to the filter list, deduping by field+op.
 * Preserves `values` and `label` on the incoming pill — use this instead of
 * `addFilter` when the pill may carry multi-value or custom-label data.
 */
export function addFilterPill(filters: FilterPill[], pill: FilterPill): FilterPill[] {
  const deduplicated = filters.filter((f) => !(f.field === pill.field && f.op === pill.op));
  return [...deduplicated, pill];
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
