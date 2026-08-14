/**
 * Queries tab: every ClickHouse query issued under the selected root, with both the builder SQL
 * (what runQuery.ts was asked to run) and the executed SQL (post-macro, from
 * frame.meta.executedQueryString — see runQuery.ts's fetchFrames) when it's landed and differs.
 * This is the tab that actually closes the plan's stated gap: SqlInspectorBar's "Inspect SQL" has
 * only ever shown the logs query, pre-expansion; every other query builder here (volume, presence,
 * field discovery, detail hydration, load-more, the setup wizard) has never been inspectable
 * before this drawer.
 */
import React from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { ClipboardButton, Icon, Spinner, useStyles2 } from '@grafana/ui';
import { Span, SpanStatus } from '../../diag/types';
import { querySpans } from '../../diag/spanTree';

interface QueryListProps {
  root: Span;
}

export function QueryList({ root }: QueryListProps) {
  const styles = useStyles2(getStyles);
  const spans = querySpans(root);

  if (spans.length === 0) {
    return <div className={styles.empty}>No queries recorded for this action yet.</div>;
  }

  return (
    <div className={styles.container}>
      {spans.map((span) => {
        const sql = typeof span.attrs.sql === 'string' ? span.attrs.sql : '';
        const executedSql = typeof span.attrs.executedSql === 'string' ? span.attrs.executedSql : undefined;
        // Only worth a separate "Executed SQL" block when it actually differs from the builder
        // SQL — a raw-SQL-mode query or one with no macros will be byte-identical, and showing the
        // same text twice is noise, not information.
        const showExecuted = executedSql != null && executedSql.trim() !== sql.trim();
        return (
          <div key={span.id} className={styles.entry}>
            <div className={styles.entryHeader}>
              <StatusDot status={span.status} />
              <span className={styles.entryName}>{span.name}</span>
              {span.error && <span className={styles.entryError}>{span.error}</span>}
            </div>
            <SqlBlock label="SQL" sql={sql} styles={styles} />
            {showExecuted && executedSql && <SqlBlock label="Executed (post-macro)" sql={executedSql} styles={styles} />}
          </div>
        );
      })}
    </div>
  );
}

function SqlBlock({ label, sql, styles }: { label: string; sql: string; styles: ReturnType<typeof getStyles> }) {
  return (
    <div className={styles.sqlBlock}>
      <div className={styles.sqlBlockHeader}>
        <span className={styles.sqlBlockLabel}>{label}</span>
        <ClipboardButton size="sm" variant="secondary" icon="clipboard-alt" getText={() => sql} fill="text">
          Copy
        </ClipboardButton>
      </div>
      <pre className={styles.sqlPre}>{sql}</pre>
    </div>
  );
}

function StatusDot({ status }: { status: SpanStatus }) {
  const styles = useStyles2(getStyles);
  if (status === 'error') {
    return <Icon name="exclamation-triangle" size="sm" className={styles.dotError} />;
  }
  if (status === 'cancelled') {
    return <Icon name="minus-circle" size="sm" className={styles.dotCancelled} />;
  }
  if (status === 'running') {
    return <Spinner size="sm" className={styles.dotRunning} />;
  }
  return <Icon name="check-circle" size="sm" className={styles.dotOk} />;
}

const getStyles = (theme: GrafanaTheme2) => ({
  empty: css`
    color: ${theme.colors.text.secondary};
    padding: ${theme.spacing(2)};
    text-align: center;
  `,
  container: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(2)};
  `,
  entry: css`
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(1)};
  `,
  entryHeader: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    margin-bottom: ${theme.spacing(0.5)};
  `,
  entryName: css`
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  entryError: css`
    color: ${theme.colors.error.text};
    font-size: ${theme.typography.bodySmall.fontSize};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  sqlBlock: css`
    & + & {
      margin-top: ${theme.spacing(1)};
    }
  `,
  sqlBlockHeader: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
  `,
  sqlBlockLabel: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
  `,
  sqlPre: css`
    font-family: ${theme.typography.fontFamilyMonospace};
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.primary};
    background: ${theme.colors.background.secondary};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(1)};
    margin: 0;
    white-space: pre-wrap;
    word-break: break-all;
  `,
  dotOk: css`
    color: ${theme.colors.success.text};
  `,
  dotError: css`
    color: ${theme.colors.error.text};
  `,
  dotCancelled: css`
    color: ${theme.colors.text.disabled};
  `,
  dotRunning: css`
    color: ${theme.colors.info.text};
  `,
});
