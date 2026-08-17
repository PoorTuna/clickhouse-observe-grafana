/**
 * FieldKeysPopover: the on-demand Map/JSON key-browse popover (see the "Logs Explorer field
 * sidebar: on-demand Map/JSON key browsing" plan, Item 3). Covers loading/error/empty states, the
 * key list render for both Map and JSON columns, and click-through to a leaf FieldModel with the
 * same id/sqlExpr scheme rowFields.ts used to produce (map:${col}:${key} / ${col}['key'],
 * json:${col}:${path} / quoteDottedPath).
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { FieldKeysPopover } from '../FieldKeysPopover';
import { runQueryRows } from '../../../data/runQuery';
import { SourceConfigContext } from '../../App/App';
import { FieldsContext } from '../../FieldsContext';
import { DEFAULT_SOURCE_CONFIG, LogsQueryState, DEFAULT_LOGS_QUERY_STATE, SourceConfig } from '../../../types';
import { FieldModel } from '../../../sql/fieldModel';
import { TimeRange, dateTime } from '@grafana/data';
import { keysCache } from '../../../sql/keys';

jest.mock('../../../data/runQuery');

const mockRunQueryRows = runQueryRows as jest.MockedFunction<typeof runQueryRows>;

const config: SourceConfig = {
  ...DEFAULT_SOURCE_CONFIG,
  datasourceUid: 'ds-uid-1',
  database: 'default',
  logsTable: 'otel_logs',
};

const timeRange: TimeRange = {
  from: dateTime('2026-01-01T00:00:00Z'),
  to: dateTime('2026-01-01T01:00:00Z'),
  raw: { from: 'now-1h', to: 'now' },
};

const queryState: LogsQueryState = { ...DEFAULT_LOGS_QUERY_STATE };

const mapField: FieldModel = {
  id: 'col:LogAttributes',
  name: 'LogAttributes',
  displayName: 'LogAttributes',
  sqlExpr: 'LogAttributes',
  type: 'map',
  source: 'column',
};

const jsonField: FieldModel = {
  id: 'col:Payload',
  name: 'Payload',
  displayName: 'Payload',
  sqlExpr: 'Payload',
  type: 'json',
  source: 'column',
};

function renderPopover(field: FieldModel, onSelectKey: (f: FieldModel) => void) {
  return render(
    <SourceConfigContext.Provider value={config}>
      <FieldsContext.Provider value={{ fields: [], loading: false, error: null, refresh: () => {} }}>
        <FieldKeysPopover field={field} queryState={queryState} timeRange={timeRange} onSelectKey={onSelectKey} />
      </FieldsContext.Provider>
    </SourceConfigContext.Provider>
  );
}

describe('FieldKeysPopover', () => {
  beforeEach(() => {
    mockRunQueryRows.mockReset();
    keysCache.clear();
  });

  it('shows a loading state before the key query resolves', () => {
    mockRunQueryRows.mockImplementation(() => new Promise(() => {})); // never resolves
    renderPopover(mapField, jest.fn());
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('shows an error state when the key query fails', async () => {
    mockRunQueryRows.mockRejectedValue(new Error('boom'));
    renderPopover(mapField, jest.fn());
    await waitFor(() => expect(screen.getByText(/boom/i)).toBeInTheDocument());
  });

  it('shows an empty state when the sample has no keys', async () => {
    mockRunQueryRows.mockResolvedValue([]);
    renderPopover(mapField, jest.fn());
    await waitFor(() => expect(screen.getByText(/no keys found/i)).toBeInTheDocument());
  });

  it('renders the discovered Map keys and the sampled-record caption', async () => {
    mockRunQueryRows.mockResolvedValue([
      { k: 'http.method', total: 42 },
      { k: 'http.status_code', total: 42 },
    ]);
    renderPopover(mapField, jest.fn());
    await waitFor(() => expect(screen.getByText('http.method')).toBeInTheDocument());
    expect(screen.getByText('http.status_code')).toBeInTheDocument();
    expect(screen.getByText(/discovered from 42 records/i)).toBeInTheDocument();
  });

  it('renders the discovered JSON paths with their reported type', async () => {
    mockRunQueryRows.mockResolvedValue([
      { path: 'user.id', type: 'Int64', total: 10 },
      { path: 'user.name', type: 'String', total: 10 },
    ]);
    renderPopover(jsonField, jest.fn());
    await waitFor(() => expect(screen.getByText('user.id')).toBeInTheDocument());
    expect(screen.getByText('Int64')).toBeInTheDocument();
    expect(screen.getByText('user.name')).toBeInTheDocument();
    expect(screen.getByText('String')).toBeInTheDocument();
  });

  it('clicking a Map key calls onSelectKey with the rowFields.ts id/sqlExpr scheme', async () => {
    mockRunQueryRows.mockResolvedValue([{ k: 'http.method', total: 5 }]);
    const onSelectKey = jest.fn();
    renderPopover(mapField, onSelectKey);
    await waitFor(() => expect(screen.getByText('http.method')).toBeInTheDocument());
    screen.getByText('http.method').closest('button')!.click();
    expect(onSelectKey).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'map:LogAttributes:http.method',
        sqlExpr: `LogAttributes['http.method']`,
        source: 'map',
        mapColumn: 'LogAttributes',
      })
    );
  });

  it('clicking a JSON path calls onSelectKey with the rowFields.ts id/sqlExpr scheme', async () => {
    mockRunQueryRows.mockResolvedValue([{ path: 'user.id', type: 'Int64', total: 5 }]);
    const onSelectKey = jest.fn();
    renderPopover(jsonField, onSelectKey);
    await waitFor(() => expect(screen.getByText('user.id')).toBeInTheDocument());
    screen.getByText('user.id').closest('button')!.click();
    expect(onSelectKey).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'json:Payload:user.id',
        sqlExpr: 'Payload.user.id',
        source: 'json',
        jsonColumn: 'Payload',
        jsonPath: 'user.id',
      })
    );
  });
});
