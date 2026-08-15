/**
 * Header card shown above the tab body on all four Inspect drawer tabs — replaces the old lone
 * Copy-button band, which left every tab starting cold with no context about what's selected. Gives
 * every tab the same at-a-glance facts: what happened, when, how long it took (including everything
 * it caused — see treeEndMs's doc comment for why that's not just root.endMs), how many queries,
 * and — once server-side stats have landed — how much data actually moved.
 */
import React from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Icon, useStyles2 } from '@grafana/ui';
import { Span, SpanStatus } from '../../diag/types';
import { formatDurationMs, spanDurationMs } from '../../diag/formatDuration';
import { querySpans, treeEndMs } from '../../diag/spanTree';
import { useLiveNow } from '../../diag/useLiveNow';
import { formatBytes, formatCount } from './formatNumbers';
import { labelForKind } from './phaseColors';

interface ActionSummaryProps {
  root: Span;
  /** Right-aligned slot on the name row — the drawer passes its Copy diagnostics bundle button. */
  action?: React.ReactNode;
}

function statusIcon(status: SpanStatus): { name: 'check-circle' | 'exclamation-triangle' | 'minus-circle' | 'circle-mono'; className: 'ok' | 'error' | 'cancelled' | 'running' } {
  if (status === 'error') {
    return { name: 'exclamation-triangle', className: 'error' };
  }
  if (status === 'cancelled') {
    return { name: 'minus-circle', className: 'cancelled' };
  }
  if (status === 'running') {
    return { name: 'circle-mono', className: 'running' };
  }
  return { name: 'check-circle', className: 'ok' };
}

export function ActionSummary({ root, action }: ActionSummaryProps) {
  const styles = useStyles2(getStyles);
  const now = useLiveNow(root.status === 'running');
  const icon = statusIcon(root.status);

  const startedAt = typeof root.attrs.startedAt === 'number' ? new Date(root.attrs.startedAt) : null;
  const endMs = treeEndMs(root);
  const duration = spanDurationMs(root.startMs, endMs, now);
  const queries = querySpans(root);

  let readRows = 0;
  let readBytes = 0;
  let hasServerStats = false;
  for (const span of queries) {
    if (typeof span.attrs.serverReadRows === 'number') {
      readRows += span.attrs.serverReadRows;
      hasServerStats = true;
    }
    if (typeof span.attrs.serverReadBytes === 'number') {
      readBytes += span.attrs.serverReadBytes;
    }
  }

  const metaParts = [
    startedAt ? startedAt.toLocaleTimeString() : null,
    endMs != null ? formatDurationMs(duration) : `${formatDurationMs(duration)} (running)`,
    `${queries.length} ${queries.length === 1 ? 'query' : 'queries'}`,
    hasServerStats ? `${formatCount(readRows)} rows read` : null,
    hasServerStats ? formatBytes(readBytes) : null,
  ].filter((p): p is string => Boolean(p));

  return (
    <div className={styles.card}>
      <div className={styles.nameRow}>
        <Icon name={icon.name} size="sm" className={styles[icon.className]} />
        <span className={styles.name}>{labelForKind(root.kind, root.name)}</span>
        {action && <div className={styles.action}>{action}</div>}
      </div>
      <div className={styles.meta}>{metaParts.join(' · ')}</div>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  card: css`
    padding: ${theme.spacing(1.5)} ${theme.spacing(2)};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.secondary};
    margin-bottom: ${theme.spacing(2)};
  `,
  nameRow: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
  `,
  name: css`
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: ${theme.typography.h5.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.primary};
  `,
  action: css`
    flex-shrink: 0;
  `,
  meta: css`
    margin-top: ${theme.spacing(0.5)};
    font-family: ${theme.typography.fontFamilyMonospace};
    font-variant-numeric: tabular-nums;
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
  `,
  ok: css`
    color: ${theme.colors.success.text};
  `,
  error: css`
    color: ${theme.colors.error.text};
  `,
  cancelled: css`
    color: ${theme.colors.text.disabled};
  `,
  running: css`
    color: ${theme.colors.info.text};
  `,
});
