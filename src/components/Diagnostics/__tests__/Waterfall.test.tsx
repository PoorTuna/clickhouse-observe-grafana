/**
 * Covers the Waterfall's plain-language phase labels (the original "decode and transport are a bit
 * ambiguous" feedback), the pending/unmatched placeholder rows this rewrite adds for a query span
 * without a `clickhouse` child yet (B5), and that a child outliving its root (B4/B7 — the `render`
 * span closing after `executeQuery` ends the action) doesn't get clipped off the waterfall.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { __resetForTests, startAction } from '../../../diag/tracer';
import { Waterfall } from '../Waterfall';

beforeEach(() => {
  __resetForTests();
});

describe('Waterfall', () => {
  it('shows plain-language labels for structural phase spans, not bare jargon', () => {
    const action = startAction('a');
    const decode = action.child('decode', 'decode');
    decode.end('ok');
    render(<Waterfall root={action.span} />);
    expect(screen.getByText(/decode \(parse response\)/i)).toBeInTheDocument();
  });

  it('shows a pending placeholder for transport/clickhouse while enrichment is still in flight', () => {
    const action = startAction('a');
    const logs = action.child('logs', 'logs');
    logs.setAttrs({ sql: 'SELECT 1' });
    logs.end('ok');
    action.setAttrs({ serverStatsStatus: 'pending' });
    render(<Waterfall root={action.span} />);
    expect(screen.getAllByText(/transport \(network round-trip\)/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/clickhouse \(server execution\)/i).length).toBeGreaterThan(0);
  });

  // Regression (B5): a fast enrichment round can match some of an action's queries and not
  // others — the root ends up 'ok' even though this particular span never got a row. The
  // placeholder must say so plainly instead of rendering nothing (which reads as a bug).
  it('explains an unmatched query distinctly from a still-pending one', () => {
    const action = startAction('a');
    const logs = action.child('logs', 'logs');
    logs.setAttrs({ sql: 'SELECT 1' });
    logs.end('ok');
    action.setAttrs({ serverStatsStatus: 'ok' }); // root got data, but not for this span
    render(<Waterfall root={action.span} />);
    expect(screen.getAllByTitle(/no server stats matched this query/i).length).toBeGreaterThan(0);
  });

  it('does not render a pending placeholder once the clickhouse split has actually landed', () => {
    const action = startAction('a');
    const logs = action.child('logs', 'logs');
    logs.setAttrs({ sql: 'SELECT 1' });
    Object.assign(logs.span, { startMs: 0, endMs: 100 });
    logs.child('clickhouse', 'clickhouse').end('ok');
    logs.end('ok');
    action.setAttrs({ serverStatsStatus: 'ok' });
    render(<Waterfall root={action.span} />);
    expect(screen.queryByText(/no server stats matched this query/i)).not.toBeInTheDocument();
  });

  // Regression (B4): LogsExplorer.tsx's executeQuery ends the action once logs+volume settle, but
  // the `render` child closes later on the next rAF — the root's own endMs is earlier than a child
  // it caused. The waterfall's scale must cover the whole tree (treeEndMs), not just root.endMs, or
  // the render bar's width gets clamped and it visually clips at the right edge.
  it('scales the waterfall to the whole tree, not just the root — a later child does not clip', () => {
    const action = startAction('a');
    const renderSpan = action.child('render', 'render');
    action.end('ok');
    renderSpan.end('ok');
    // Deterministic relative shape: root runs [1000,1040] (40ms), its render child runs
    // [1040,1100] (60ms) — ending 60ms after the root itself did. treeEndMs must scale the
    // waterfall to 100ms (root start to the render child's end), not 40ms (root's own duration).
    Object.assign(action.span, { startMs: 1000, endMs: 1040 });
    Object.assign(renderSpan.span, { startMs: 1040, endMs: 1100 });

    render(<Waterfall root={action.span} />);
    const bar = screen.getByTitle(/render \(ui paint\): 60ms/i);
    // With the correct total (100ms): offset = (1040-1000)/100 = 40%, width = 60/100 = 60% —
    // exactly reaching the right edge, not clipped to 0% the way it would be if the waterfall had
    // scaled to root.endMs (40ms) alone, where offset would already be 100%.
    expect(bar.style.left).toBe('40%');
    expect(bar.style.width).toBe('60%');
  });
});
