/**
 * Verifies the log detail drawer's traceId row: it's a link to `getTraceHref`'s result when one
 * is available, and falls back to plain (non-interactive) text — same as any other attribute row
 * — when the datasource has no Traces config (getTraceHref returns undefined). Guards against the
 * traceId regressing to always being a filter-only button, or a dead link with no href.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { LogDetailDrawer } from '../LogDetailDrawer';
import { CORE_ALIAS } from '../../sql/queryBuilder';
import { DEFAULT_SOURCE_CONFIG, OTEL_COLUMN_MAPPING, LogRow, SourceConfig } from '../../types';

const config: SourceConfig = {
  ...DEFAULT_SOURCE_CONFIG,
  datasourceUid: 'ds-uid-1',
  columns: OTEL_COLUMN_MAPPING,
};

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

// Only the raw mapped column (TraceId) is included, not the __traceId CORE_ALIAS — both would
// otherwise render as separate flat rows with the same value (the alias is only consumed
// elsewhere, e.g. the header timestamp / logRowKey matching), which would make the traceId text
// ambiguous to query for in this test.
const row: LogRow = {
  [CORE_ALIAS.timestamp]: '2026-01-01T00:00:00Z',
  [CORE_ALIAS.body]: 'request failed',
  TraceId: TRACE_ID,
};

const baseProps = {
  row,
  // The panel body now blocks until detailRow is populated (see LogDetailDrawer's `blocked`) —
  // these tests exercise rendered content, not the loading state itself, so pass row straight
  // through as an already-hydrated detailRow, same as raw-SQL mode does in LogsExplorer.
  detailRow: row,
  config,
  columns: [],
  onClose: jest.fn(),
  onAddFilter: jest.fn(),
};

describe('LogDetailDrawer traceId row', () => {
  it('renders the traceId as a link to the ClickHouse Explore trace view when getTraceHref resolves one', () => {
    const href = '/explore?left=%7B%22traceId%22%3A%22abc%22%7D';
    render(<LogDetailDrawer {...baseProps} getTraceHref={() => href} />);

    const link = screen.getByRole('link', { name: new RegExp(TRACE_ID) });
    expect(link).toHaveAttribute('href', href);
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('renders the traceId as plain text (no link) when getTraceHref returns undefined', () => {
    render(<LogDetailDrawer {...baseProps} getTraceHref={() => undefined} />);

    expect(screen.queryByRole('link', { name: new RegExp(TRACE_ID) })).not.toBeInTheDocument();
    expect(screen.getByText(TRACE_ID)).toBeInTheDocument();
  });

  it('renders the traceId as plain text when getTraceHref is not provided at all', () => {
    render(<LogDetailDrawer {...baseProps} />);

    expect(screen.queryByRole('link', { name: new RegExp(TRACE_ID) })).not.toBeInTheDocument();
    expect(screen.getByText(TRACE_ID)).toBeInTheDocument();
  });
});

describe('LogDetailDrawer blocking states', () => {
  // Regression coverage for the "only underscored fields show" bug: the panel body must never
  // render `row`'s narrow grid columns as if they were the complete field list — it either shows
  // real (fully hydrated + field-discovered) data, a loading state, or an error with Retry.
  it('blocks the panel body on a spinner, not a partial field list, while detailRow is unhydrated', () => {
    render(<LogDetailDrawer {...baseProps} detailRow={undefined} />);

    expect(screen.getByText(/loading all fields/i)).toBeInTheDocument();
    expect(screen.queryByText(TRACE_ID)).not.toBeInTheDocument();
  });

  it('blocks the panel body while field discovery is still loading, even once detailRow has landed', () => {
    render(<LogDetailDrawer {...baseProps} fieldsLoading />);

    expect(screen.getByText(/loading all fields/i)).toBeInTheDocument();
    expect(screen.queryByText(TRACE_ID)).not.toBeInTheDocument();
  });

  it('shows the real field list once both detailRow and field discovery have completed', () => {
    render(<LogDetailDrawer {...baseProps} fieldsLoading={false} />);

    expect(screen.queryByText(/loading all fields/i)).not.toBeInTheDocument();
    expect(screen.getByText(TRACE_ID)).toBeInTheDocument();
  });

  it('shows a blocking error with Retry instead of a partial field list when hydration failed', () => {
    const onRetryHydrate = jest.fn();
    render(
      <LogDetailDrawer
        {...baseProps}
        detailRow={undefined}
        detailError="This row wasn't found on the replica that answered."
        onRetryHydrate={onRetryHydrate}
      />
    );

    expect(screen.getByText(/wasn't found on the replica/i)).toBeInTheDocument();
    expect(screen.queryByText(TRACE_ID)).not.toBeInTheDocument();

    screen.getByRole('button', { name: /retry/i }).click();
    expect(onRetryHydrate).toHaveBeenCalledTimes(1);
  });

  it('shows a blocking error when field discovery failed, even if detailRow is present', () => {
    render(<LogDetailDrawer {...baseProps} fieldsError="Field discovery failed for: LogAttributes." />);

    expect(screen.getByText(/field discovery failed/i)).toBeInTheDocument();
    expect(screen.queryByText(TRACE_ID)).not.toBeInTheDocument();
  });

  // Regression coverage for the perf plan's item 4 / the user's original "can't read a record"
  // complaint: fieldsLoading/fieldsError now reflect Phase A (system.columns) discovery only — the
  // dedicated Map-key/JSON-path scan (former Phase B/C) that used to also gate this render was
  // deleted from the mount path entirely (see FieldsContext.tsx). The drawer must render as soon
  // as detailRow + Phase-A fields are ready, with no separate "attribute discovery" signal to wait
  // on — there no longer is one.
  it('renders once detailRow + Phase-A fields are ready, with no attribute-discovery signal to block on', () => {
    render(
      <LogDetailDrawer
        {...baseProps}
        fieldsLoading={false}
        fieldsError={null}
        fields={[{ id: 'col:TraceId', name: 'TraceId', displayName: 'TraceId', sqlExpr: 'TraceId', type: 'string', source: 'column' }]}
      />
    );

    expect(screen.queryByText(/loading all fields/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/field discovery failed/i)).not.toBeInTheDocument();
    expect(screen.getByText(TRACE_ID)).toBeInTheDocument();
  });
});
