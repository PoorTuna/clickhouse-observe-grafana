/**
 * Verifies StatsTable shows a distinct message per diag/serverStats.ts's ServerStatsResult status
 * — "off", "waiting", "no-data", "no-grant", "readonly", and "ok" are different facts, and this
 * component's whole job is not collapsing them into one generic empty state.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { __resetForTests, startAction } from '../../../diag/tracer';
import { setEnrichmentEnabled } from '../../../diag/enrichment';
import { StatsTable } from '../StatsTable';

beforeEach(() => {
  __resetForTests();
  setEnrichmentEnabled(false);
});

describe('StatsTable', () => {
  it('shows the "off" state when enrichment is disabled', () => {
    const action = startAction('a');
    render(<StatsTable root={action.span} />);
    expect(screen.getByText(/server-side stats are off/i)).toBeInTheDocument();
  });

  it('shows a "waiting" state while a tagged lookup is genuinely in flight', () => {
    setEnrichmentEnabled(true);
    const action = startAction('a');
    action.setAttrs({ serverStatsStatus: 'pending' });
    render(<StatsTable root={action.span} />);
    expect(screen.getByText(/waiting for clickhouse/i)).toBeInTheDocument();
  });

  // Regression coverage for a real bug found testing against a live stack: a root that ended
  // while enrichment was off never gets tagged, so a lookup for it will never find anything — but
  // its serverStatsStatus attr is left unset, identically to a freshly-created root whose lookup
  // just hasn't resolved yet. Before diag/autoEnrich.ts started stamping 'not-tagged' explicitly,
  // both rendered as "waiting to flush", which was permanently misleading for the former.
  it('distinguishes "never tagged" (status unset) from "pending" — it must not show "waiting"', () => {
    setEnrichmentEnabled(true);
    const action = startAction('a'); // enrichment was off when this root's queries actually ran
    render(<StatsTable root={action.span} />);
    expect(screen.queryByText(/waiting for clickhouse/i)).not.toBeInTheDocument();
    expect(screen.getByText(/never tagged/i)).toBeInTheDocument();
  });

  it('shows the same "never tagged" message for the explicit not-tagged status', () => {
    setEnrichmentEnabled(true);
    const action = startAction('a');
    action.setAttrs({ serverStatsStatus: 'not-tagged' });
    render(<StatsTable root={action.span} />);
    expect(screen.getByText(/never tagged/i)).toBeInTheDocument();
  });

  it('shows a "no-data" explanation distinct from "waiting"', () => {
    setEnrichmentEnabled(true);
    const action = startAction('a');
    action.setAttrs({ serverStatsStatus: 'no-data' });
    render(<StatsTable root={action.span} />);
    expect(screen.getByText(/no matching rows showed up/i)).toBeInTheDocument();
  });

  it('shows a no-grant message naming the missing privilege', () => {
    setEnrichmentEnabled(true);
    const action = startAction('a');
    action.setAttrs({ serverStatsStatus: 'unavailable', serverStatsReason: 'no-grant', serverStatsDetail: 'Not enough privileges' });
    render(<StatsTable root={action.span} />);
    expect(screen.getByText(/doesn't have select on system\.query_log/i)).toBeInTheDocument();
    expect(screen.getByText('Not enough privileges')).toBeInTheDocument();
  });

  it('shows a readonly-specific message', () => {
    setEnrichmentEnabled(true);
    const action = startAction('a');
    action.setAttrs({ serverStatsStatus: 'unavailable', serverStatsReason: 'readonly' });
    render(<StatsTable root={action.span} />);
    expect(screen.getByText(/readonly mode/i)).toBeInTheDocument();
  });

  it('renders a table row per enriched query when stats landed', () => {
    setEnrichmentEnabled(true);
    const action = startAction('a');
    const logs = action.child('logs', 'logs');
    logs.setAttrs({
      sql: 'SELECT 1',
      serverDurationMs: 840,
      serverReadRows: 12400000,
      serverReadBytes: 310000000,
      serverResultRows: 100,
      serverMemoryUsage: 5000000,
    });
    action.setAttrs({ serverStatsStatus: 'ok' });
    render(<StatsTable root={action.span} />);
    // The 'logs' query op renders as its plain-language label ("Log rows"), not the raw op string
    // — see phaseColors.ts's QUERY_OP_LABELS.
    expect(screen.getByText('Log rows')).toBeInTheDocument();
    expect(screen.getByText('840 ms')).toBeInTheDocument();
    expect(screen.getByText('12,400,000')).toBeInTheDocument();
  });

  it('excludes a query span with no server attrs even when the root status is ok', () => {
    setEnrichmentEnabled(true);
    const action = startAction('a');
    const logs = action.child('logs', 'logs');
    logs.setAttrs({ sql: 'SELECT 1' }); // never enriched (e.g. no matching row for this span)
    action.setAttrs({ serverStatsStatus: 'ok' });
    render(<StatsTable root={action.span} />);
    expect(screen.getByText(/no queries in this action matched yet/i)).toBeInTheDocument();
  });
});
