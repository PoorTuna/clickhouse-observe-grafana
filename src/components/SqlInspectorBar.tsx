/**
 * SQL preview/edit bar for LogsExplorer's toolbar — "Edit as SQL" (raw-SQL mode toggle + editor),
 * "Inspect SQL" (read-only preview of the builder-generated query), and the Saved-searches /
 * Add-to-dashboard actions that live alongside them. Split out of LogsExplorer.tsx purely to keep
 * that page's file size down — no behavior change, same props the inline block already closed
 * over.
 */
import React from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2, TimeRange } from '@grafana/data';
import { Button, ClipboardButton, Icon, useStyles2 } from '@grafana/ui';
import { LogsQueryState, SavedSearch } from '../types';
import { SavedSearchMenu } from './SavedSearches/SavedSearchMenu';

interface SqlInspectorBarProps {
  queryState: LogsQueryState;
  timeRange: TimeRange;
  activeViewId?: string;
  onLoadSaved: (search: SavedSearch, newTimeRange?: TimeRange) => void;
  canAddToDashboard: boolean;
  onOpenAddToDashboard: () => void;

  onToggleRawSql: () => void;
  showSqlInspect: boolean;
  onToggleShowSqlInspect: () => void;

  rawSqlDraft: string;
  onRawSqlDraftChange: (sql: string) => void;
  onRunRawSql: () => void;

  /** Builder-generated SQL — always current, used both for the "Inspect SQL" preview/copy and as
   *  the caller's seed value when switching into raw-SQL mode. */
  builderSql: string;
}

export function SqlInspectorBar({
  queryState,
  timeRange,
  activeViewId,
  onLoadSaved,
  canAddToDashboard,
  onOpenAddToDashboard,
  onToggleRawSql,
  showSqlInspect,
  onToggleShowSqlInspect,
  rawSqlDraft,
  onRawSqlDraftChange,
  onRunRawSql,
  builderSql,
}: SqlInspectorBarProps) {
  const styles = useStyles2(getStyles);

  return (
    <div className={styles.sqlRow}>
      <div className={styles.sqlActions}>
        <div className={styles.sqlActionsLeft}>
          <button
            className={styles.sqlToggle}
            onClick={onToggleRawSql}
            title={
              queryState.useRawSql
                ? 'Discard raw SQL and go back to the visual query builder'
                : 'For regex, ClickHouse functions, and other advanced queries, switch to raw SQL'
            }
          >
            <Icon name={queryState.useRawSql ? 'angle-down' : 'angle-right'} size="xs" />
            {queryState.useRawSql ? 'Back to query builder' : 'Edit as SQL'}
          </button>
          <button
            className={styles.sqlToggle}
            onClick={onToggleShowSqlInspect}
            title="Inspect the SQL query that will be sent to ClickHouse"
          >
            <Icon name={showSqlInspect ? 'angle-down' : 'angle-right'} size="xs" />
            {showSqlInspect ? 'Hide SQL' : 'Inspect SQL'}
          </button>
        </div>
        <div className={styles.sqlActionsRight}>
          <SavedSearchMenu
            queryState={queryState}
            timeRange={timeRange}
            onLoad={onLoadSaved}
            activeDataViewId={activeViewId}
          />
          <Button
            variant="secondary"
            size="sm"
            icon="apps"
            onClick={onOpenAddToDashboard}
            disabled={!canAddToDashboard}
            tooltip={canAddToDashboard ? 'Add to dashboard' : 'You do not have permission to create dashboards'}
          >
            Add to dashboard
          </Button>
        </div>
      </div>
      {queryState.useRawSql && (
        <>
          <textarea
            className={styles.sqlEditor}
            value={rawSqlDraft}
            onChange={(e) => onRawSqlDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                onRunRawSql();
              }
            }}
            rows={6}
          />
          <div className={styles.sqlRunRow}>
            <Button size="sm" variant="primary" onClick={onRunRawSql}>
              Run query
            </Button>
            <span className={styles.sqlRunHint}>Ctrl+Enter</span>
          </div>
        </>
      )}
      {showSqlInspect && !queryState.useRawSql && (
        <div className={styles.sqlInspect}>
          <pre className={styles.sqlInspectPre}>{builderSql}</pre>
          <ClipboardButton
            className={styles.sqlCopyBtn}
            size="sm"
            variant="secondary"
            icon="clipboard-alt"
            getText={() => builderSql}
          >
            Copy
          </ClipboardButton>
        </div>
      )}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  sqlRow: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.5)};
  `,
  sqlActions: css`
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    row-gap: ${theme.spacing(0.5)};
  `,
  sqlActionsLeft: css`
    display: flex;
    gap: ${theme.spacing(2)};
    align-items: center;
  `,
  sqlActionsRight: css`
    display: flex;
    gap: ${theme.spacing(1)};
    align-items: center;
  `,
  sqlToggle: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    background: transparent;
    border: none;
    cursor: pointer;
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.body.fontSize};
    text-align: left;
    padding: 0;
    &:hover { color: ${theme.colors.text.primary}; }
  `,
  sqlInspect: css`
    position: relative;
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.medium};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(1)};
  `,
  sqlInspectPre: css`
    font-family: ${theme.typography.fontFamilyMonospace};
    font-size: ${theme.typography.body.fontSize};
    color: ${theme.colors.text.primary};
    margin: 0;
    white-space: pre-wrap;
    word-break: break-all;
    padding-right: ${theme.spacing(7)};
  `,
  sqlCopyBtn: css`
    position: absolute;
    top: ${theme.spacing(1)};
    right: ${theme.spacing(1)};
    background: ${theme.colors.background.primary};
    border: 1px solid ${theme.colors.border.medium};
    border-radius: ${theme.shape.radius.default};
    cursor: pointer;
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.body.fontSize};
    padding: ${theme.spacing(0.25)} ${theme.spacing(1)};
    &:hover { color: ${theme.colors.text.primary}; background: ${theme.colors.action.hover}; }
  `,
  sqlEditor: css`
    width: 100%;
    font-family: ${theme.typography.fontFamilyMonospace};
    font-size: ${theme.typography.body.fontSize};
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.medium};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(1)};
    color: ${theme.colors.text.primary};
    resize: vertical;
    outline: none;
  `,
  sqlRunRow: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
  `,
  sqlRunHint: css`
    font-size: 13px;
    color: ${theme.colors.text.disabled};
  `,
});
