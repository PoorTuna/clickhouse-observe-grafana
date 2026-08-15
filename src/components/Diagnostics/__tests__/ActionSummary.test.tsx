import React from 'react';
import { render, screen } from '@testing-library/react';
import { __resetForTests, startAction } from '../../../diag/tracer';
import { ActionSummary } from '../ActionSummary';

beforeEach(() => {
  __resetForTests();
});

describe('ActionSummary', () => {
  it('shows the action name and query count', () => {
    const action = startAction('Search submit');
    const logs = action.child('logs', 'logs');
    logs.setAttrs({ sql: 'SELECT 1' });
    logs.end('ok');
    action.end('ok');
    render(<ActionSummary root={action.span} />);
    expect(screen.getByText('Search submit')).toBeInTheDocument();
    expect(screen.getByText(/1 query/)).toBeInTheDocument();
  });

  it('pluralizes query count', () => {
    const action = startAction('a');
    const logs = action.child('logs', 'logs');
    logs.setAttrs({ sql: 'SELECT 1' });
    logs.end('ok');
    const vol = action.child('volume', 'volume');
    vol.setAttrs({ sql: 'SELECT 2' });
    vol.end('ok');
    action.end('ok');
    render(<ActionSummary root={action.span} />);
    expect(screen.getByText(/2 queries/)).toBeInTheDocument();
  });

  // Regression (B4): the summary's duration must cover the whole tree, not just root.endMs — a
  // render child ending after the action itself must still be reflected here.
  it('reports a duration covering the whole tree, including a child that outlives the root', () => {
    const action = startAction('a');
    const renderSpan = action.child('render', 'render');
    action.end('ok');
    renderSpan.end('ok');
    Object.assign(action.span, { startMs: 1000, endMs: 1040 });
    Object.assign(renderSpan.span, { startMs: 1040, endMs: 1100 });
    render(<ActionSummary root={action.span} />);
    expect(screen.getByText(/100ms/)).toBeInTheDocument();
  });

  it('renders the action-slot content (e.g. the copy button) when given one', () => {
    const action = startAction('a');
    action.end('ok');
    render(<ActionSummary root={action.span} action={<button>Copy diagnostics bundle</button>} />);
    expect(screen.getByText('Copy diagnostics bundle')).toBeInTheDocument();
  });

  it('includes aggregate rows-read once server-side stats have landed', () => {
    const action = startAction('a');
    const logs = action.child('logs', 'logs');
    logs.setAttrs({ sql: 'SELECT 1', serverReadRows: 12400000, serverReadBytes: 310000000 });
    logs.end('ok');
    action.end('ok');
    render(<ActionSummary root={action.span} />);
    expect(screen.getByText(/12,400,000 rows read/)).toBeInTheDocument();
  });
});
