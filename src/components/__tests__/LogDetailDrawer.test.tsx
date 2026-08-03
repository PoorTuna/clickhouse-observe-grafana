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
