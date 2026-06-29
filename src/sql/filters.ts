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
export function makeFilter(field: string, value: string, op: FilterOp = '='): FilterPill {
  return { id: nextId(), field, value, op };
}

/** Human-readable label for a filter pill. */
export function filterLabel(f: FilterPill): string {
  if (f.value === '' && f.op === '=') {
    return `${f.field} is empty`;
  }
  const opSymbol: Record<FilterOp, string> = {
    '=': '=',
    '!=': '≠',
    contains: '~',
    not_contains: '!~',
  };
  return `${f.field} ${opSymbol[f.op]} ${f.value}`;
}
