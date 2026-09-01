/**
 * SearchBar's Map-key dot-drilldown: accepting a Map container field inserts a trailing dot, the
 * dropdown then shows a loading row while sql/keys.ts's loadColumnKeys resolves, and the fetched
 * keys land as selectable suggestions with the full "column.key" prefix on accept. Also covers the
 * error row for a failed key fetch.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { SearchBar } from '../SearchBar';
import { FieldsContext } from '../FieldsContext';
import { FieldModel } from '../../sql/fieldModel';
import { KeysResult } from '../../sql/keys';

const mapContainer: FieldModel = {
  id: 'col:LogAttributes',
  name: 'LogAttributes',
  displayName: 'LogAttributes',
  sqlExpr: 'LogAttributes',
  type: 'map',
  source: 'column',
};

function renderBar(loadMapKeys: (col: string) => Promise<KeysResult>, initial = '') {
  const onChange = jest.fn();
  render(
    <FieldsContext.Provider value={{ fields: [mapContainer], loading: false, error: null, refresh: () => {} }}>
      <SearchBar
        value={initial}
        onChange={onChange}
        onSearch={() => {}}
        loadValues={async () => []}
        loadMapKeys={loadMapKeys}
      />
    </FieldsContext.Provider>
  );
  return { onChange, input: screen.getByPlaceholderText(/filter logs with kql/i) as HTMLInputElement };
}

/** fireEvent.change alone doesn't reliably move jsdom's selectionStart to the new value's end on
 *  every version, so this sets it explicitly before firing — SearchBar reads
 *  e.target.selectionStart to know the cursor position (see computeSuggestions' callers). */
function typeAtEnd(input: HTMLInputElement, value: string) {
  fireEvent.change(input, { target: { value, selectionStart: value.length } });
}

describe('SearchBar — Map dot-drilldown', () => {
  it('accepting the Map container suggestion inserts a trailing dot and shows a loading row', async () => {
    let resolveKeys: (r: KeysResult) => void = () => {};
    const loadMapKeys = jest.fn(() => new Promise<KeysResult>((resolve) => { resolveKeys = resolve; }));
    const { input } = renderBar(loadMapKeys);

    fireEvent.focus(input);
    typeAtEnd(input, 'LogA');
    await waitFor(() => expect(screen.getByText('LogAttributes.')).toBeInTheDocument());

    fireEvent.mouseDown(screen.getByText('LogAttributes.'));

    await waitFor(() => expect(input.value).toBe('LogAttributes.'));
    await waitFor(() => expect(screen.getByText(/listing keys/i)).toBeInTheDocument());
    expect(loadMapKeys).toHaveBeenCalledWith('LogAttributes');

    // Resolve and let the follow-up state updates flush, so the test doesn't leave a dangling
    // promise whose eventual setState lands outside any act() (and outside this test's lifetime).
    await act(async () => {
      resolveKeys({ keys: [], total: 0 });
      await Promise.resolve();
    });
  });

  it('once keys resolve, they render as selectable suggestions and accepting one inserts the full prefixed name', async () => {
    const loadMapKeys = jest.fn(async (): Promise<KeysResult> => ({
      keys: [{ key: 'http.method' }, { key: 'http.status_code' }],
      total: 42,
    }));
    const { input, onChange } = renderBar(loadMapKeys, 'LogAttributes.');

    fireEvent.focus(input);
    await waitFor(() => expect(screen.getByText('LogAttributes.http.method')).toBeInTheDocument());
    expect(screen.getByText('LogAttributes.http.status_code')).toBeInTheDocument();
    expect(screen.getByText(/from 42 sampled records/i)).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByText('LogAttributes.http.method'));
    await waitFor(() => expect(input.value).toBe('LogAttributes.http.method '));

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('LogAttributes.http.method ');
  });

  it('a failed key fetch shows an error row instead of getting stuck loading', async () => {
    const loadMapKeys = jest.fn(async (): Promise<KeysResult> => {
      throw new Error('mapKeys query failed: boom');
    });
    const { input } = renderBar(loadMapKeys, 'LogAttributes.');

    fireEvent.focus(input);
    await waitFor(() => expect(screen.getByText(/mapKeys query failed: boom/i)).toBeInTheDocument());
  });

  it('typing after the dot filters the already-fetched key list without a second fetch', async () => {
    const loadMapKeys = jest.fn(async (): Promise<KeysResult> => ({
      keys: [{ key: 'http.method' }, { key: 'http.status_code' }],
      total: 10,
    }));
    const { input } = renderBar(loadMapKeys, 'LogAttributes.');

    fireEvent.focus(input);
    await waitFor(() => expect(screen.getByText('LogAttributes.http.method')).toBeInTheDocument());
    expect(loadMapKeys).toHaveBeenCalledTimes(1);

    typeAtEnd(input, 'LogAttributes.stat');
    await waitFor(() => expect(screen.getByText('LogAttributes.http.status_code')).toBeInTheDocument());
    expect(screen.queryByText('LogAttributes.http.method')).not.toBeInTheDocument();
    expect(loadMapKeys).toHaveBeenCalledTimes(1); // still just the one fetch
  });
});
