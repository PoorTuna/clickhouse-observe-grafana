import React from 'react';
import { render, screen } from '@testing-library/react';
import { __resetForTests, startAction } from '../../../diag/tracer';
import { PhaseBreakdown } from '../PhaseBreakdown';

beforeEach(() => {
  __resetForTests();
});

describe('PhaseBreakdown', () => {
  it('renders nothing when no phase span has ended yet', () => {
    const action = startAction('a');
    action.child('logs', 'logs'); // a query op, not a phase kind — never counted
    const { container } = render(<PhaseBreakdown root={action.span} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('sums a phase kind across multiple spans under the tree, not just one', () => {
    const action = startAction('a');
    const logs = action.child('logs', 'logs');
    const decode1 = logs.child('decode', 'decode');
    Object.assign(decode1.span, { startMs: 0, endMs: 10 });
    decode1.end('ok');
    const volume = action.child('volume', 'volume');
    const decode2 = volume.child('decode', 'decode');
    Object.assign(decode2.span, { startMs: 0, endMs: 20 });
    decode2.end('ok');
    render(<PhaseBreakdown root={action.span} />);
    expect(screen.getByText(/Decode 30ms/)).toBeInTheDocument();
  });

  it('shows the enable-server-stats hint when no clickhouse/transport split has landed', () => {
    const action = startAction('a');
    const logs = action.child('logs', 'logs');
    const decode = logs.child('decode', 'decode');
    Object.assign(decode.span, { startMs: 0, endMs: 10 });
    decode.end('ok');
    render(<PhaseBreakdown root={action.span} />);
    expect(screen.getByText(/turn on server-side stats/i)).toBeInTheDocument();
  });

  it('does not show the hint once the clickhouse/transport split has landed', () => {
    const action = startAction('a');
    const logs = action.child('logs', 'logs');
    const clickhouse = logs.child('clickhouse', 'clickhouse');
    Object.assign(clickhouse.span, { startMs: 0, endMs: 10 });
    clickhouse.end('ok');
    render(<PhaseBreakdown root={action.span} />);
    expect(screen.queryByText(/turn on server-side stats/i)).not.toBeInTheDocument();
  });
});
