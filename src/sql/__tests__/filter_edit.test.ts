/**
 * Unit tests for the filter-pill edit helpers (updateFilter, negateFilter, toggleDisabled)
 * backing the Kibana-style filter pill context menu (Edit / Exclude / Disable).
 */

import { negateFilter, toggleDisabled, updateFilter } from '../filters';
import { FilterPill } from '../../types';

describe('updateFilter', () => {
  it('replaces the matching pill by id, keeping the id stable', () => {
    const pills: FilterPill[] = [
      { id: 'a', field: 'ServiceName', op: '=', value: 'api' },
      { id: 'b', field: 'Body', op: 'contains', value: 'error' },
    ];
    const result = updateFilter(pills, 'a', { field: 'HostName', op: '!=', value: 'host-1' });
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ id: 'a', field: 'HostName', op: '!=', value: 'host-1' });
    expect(result[1]).toBe(pills[1]);
  });

  it('is a no-op when the id is not found', () => {
    const pills: FilterPill[] = [{ id: 'a', field: 'ServiceName', op: '=', value: 'api' }];
    const result = updateFilter(pills, 'missing', { value: 'x' });
    expect(result).toEqual(pills);
  });
});

describe('toggleDisabled', () => {
  it('flips disabled on the matching pill only', () => {
    const pills: FilterPill[] = [
      { id: 'a', field: 'ServiceName', op: '=', value: 'api' },
      { id: 'b', field: 'Body', op: 'contains', value: 'error' },
    ];
    const once = toggleDisabled(pills, 'a');
    expect(once[0].disabled).toBe(true);
    expect(once[1].disabled).toBeUndefined();

    const twice = toggleDisabled(once, 'a');
    expect(twice[0].disabled).toBe(false);
  });
});

describe('negateFilter', () => {
  const cases: Array<[FilterPill['op'], FilterPill['op']]> = [
    ['=', '!='],
    ['!=', '='],
    ['contains', 'not_contains'],
    ['not_contains', 'contains'],
    ['one_of', 'not_one_of'],
    ['not_one_of', 'one_of'],
    ['exists', 'not_exists'],
    ['not_exists', 'exists'],
  ];

  it.each(cases)('flips %s to %s', (from, to) => {
    const pill: FilterPill = { id: 'a', field: 'ServiceName', op: from, value: 'api' };
    expect(negateFilter(pill).op).toBe(to);
  });

  it('is its own inverse (round-trips back to the original op)', () => {
    const pill: FilterPill = { id: 'a', field: 'ServiceName', op: '=', value: 'api' };
    expect(negateFilter(negateFilter(pill)).op).toBe('=');
  });

  it('preserves field/value/id, only flips op', () => {
    const pill: FilterPill = { id: 'x', field: 'HostName', op: 'one_of', value: '', values: ['h1', 'h2'] };
    const negated = negateFilter(pill);
    expect(negated).toEqual({ ...pill, op: 'not_one_of' });
  });
});
