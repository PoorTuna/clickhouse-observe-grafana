/**
 * Verifies the drawer's follow/pin behaviour — the part of the diagnostics plan most likely to
 * regress silently: staying open across repeated searches is the primary use case, not an edge
 * case (see the plan's "Live behaviour while the drawer is open" section).
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { __resetForTests, startAction } from '../../../diag/tracer';
import { DiagnosticsDrawer } from '../DiagnosticsDrawer';

beforeEach(() => {
  __resetForTests();
});

describe('DiagnosticsDrawer — empty state', () => {
  it('shows an empty-state message when nothing has been traced yet', () => {
    render(<DiagnosticsDrawer onClose={jest.fn()} />);
    expect(screen.getByText(/nothing recorded yet/i)).toBeInTheDocument();
  });

  it('does not show the copy-bundle button when there is nothing to copy', () => {
    render(<DiagnosticsDrawer onClose={jest.fn()} />);
    expect(screen.queryByText('Copy diagnostics bundle')).not.toBeInTheDocument();
  });
});

describe('DiagnosticsDrawer — copy diagnostics bundle', () => {
  it('shows the copy button once an action exists, and clicking it does not throw', () => {
    startAction('Search submit').end('ok');
    render(<DiagnosticsDrawer onClose={jest.fn()} />);
    const button = screen.getByText('Copy diagnostics bundle');
    expect(button).toBeInTheDocument();
    expect(() => fireEvent.click(button)).not.toThrow();
  });
});

describe('DiagnosticsDrawer — following vs pinned', () => {
  it('auto-selects the newest action while following (the default)', () => {
    startAction('First search').end('ok');
    render(<DiagnosticsDrawer onClose={jest.fn()} />);
    // Rendered twice: once as the rail row, once as the (auto-selected, since it's the only and
    // therefore newest) root row in the Timeline tab.
    expect(screen.getAllByText('First search')).toHaveLength(2);
  });

  it('clicking an older rail entry pins the view instead of following the newest', () => {
    startAction('First search').end('ok');
    startAction('Second search').end('ok');
    render(<DiagnosticsDrawer onClose={jest.fn()} />);

    // Rail shows newest first — "Second search" is the default (following) selection.
    const railButtons = screen.getAllByRole('button', { name: /search/i });
    const firstSearchRailButton = railButtons.find((b) => b.textContent?.includes('First search'));
    expect(firstSearchRailButton).toBeDefined();

    fireEvent.click(firstSearchRailButton!);

    // Pin toggle now reflects "pinned" — clicking the older item stopped following.
    expect(screen.getByRole('button', { name: /pinned — click to follow again/i })).toBeInTheDocument();
  });

  it('selecting the newest entry again resumes following', () => {
    startAction('First search').end('ok');
    startAction('Second search').end('ok');
    render(<DiagnosticsDrawer onClose={jest.fn()} />);

    const railButtons = screen.getAllByRole('button', { name: /search/i });
    const firstSearchRailButton = railButtons.find((b) => b.textContent?.includes('First search'))!;
    fireEvent.click(firstSearchRailButton);
    expect(screen.getByRole('button', { name: /pinned — click to follow again/i })).toBeInTheDocument();

    const secondSearchRailButton = screen
      .getAllByRole('button', { name: /search/i })
      .find((b) => b.textContent?.includes('Second search'))!;
    fireEvent.click(secondSearchRailButton);
    expect(screen.getByRole('button', { name: /following — click to pin the current selection/i })).toBeInTheDocument();
  });
});

describe('DiagnosticsDrawer — tabs', () => {
  it('switches between Timeline and Queries tabs', () => {
    const action = startAction('Search submit');
    const query = action.child('logs', 'logs');
    query.setAttrs({ sql: 'SELECT 1' });
    query.end('ok');
    action.end('ok');

    render(<DiagnosticsDrawer onClose={jest.fn()} />);
    expect(screen.queryByText('SELECT 1')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Queries' }));
    expect(screen.getByText('SELECT 1')).toBeInTheDocument();
  });
});
