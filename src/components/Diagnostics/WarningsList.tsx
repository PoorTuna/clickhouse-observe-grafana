/**
 * Warnings tab body — the reason to open the drawer even when nothing feels slow. Ranked
 * error/warning/info (computeWarnings already sorts), each entry icon + text per `color-not-only`
 * (never color alone to convey severity).
 */
import React from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Icon, IconName, useStyles2 } from '@grafana/ui';
import { Warning, WarningSeverity } from '../../diag/warnings';
import { DiagEmptyState } from './DiagEmptyState';

interface WarningsListProps {
  warnings: Warning[];
}

export function WarningsList({ warnings }: WarningsListProps) {
  const styles = useStyles2(getStyles);

  if (warnings.length === 0) {
    return (
      <DiagEmptyState
        icon="check-circle"
        tone="success"
        title="No integrity issues found"
        description="Every query in this action came back clean — no truncation, no overflow-mode data loss, no server-side exceptions the page missed."
      />
    );
  }

  return (
    <ul className={styles.list}>
      {warnings.map((warning) => (
        <li key={warning.id} className={styles.entry}>
          <SeverityIcon severity={warning.severity} />
          <span className={styles.message}>{warning.message}</span>
        </li>
      ))}
    </ul>
  );
}

const SEVERITY_ICON: Record<WarningSeverity, IconName> = {
  error: 'exclamation-triangle',
  warning: 'exclamation-triangle',
  info: 'info-circle',
};

function SeverityIcon({ severity }: { severity: WarningSeverity }) {
  const styles = useStyles2(getStyles);
  const cls = severity === 'error' ? styles.iconError : severity === 'warning' ? styles.iconWarning : styles.iconInfo;
  return <Icon name={SEVERITY_ICON[severity]} size="sm" className={cls} />;
}

const getStyles = (theme: GrafanaTheme2) => ({
  list: css`
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
  `,
  entry: css`
    display: flex;
    align-items: flex-start;
    gap: ${theme.spacing(1)};
    padding: ${theme.spacing(1)};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
  `,
  message: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.primary};
  `,
  iconError: css`
    color: ${theme.colors.error.text};
    flex-shrink: 0;
    margin-top: 2px;
  `,
  iconWarning: css`
    color: ${theme.colors.warning.text};
    flex-shrink: 0;
    margin-top: 2px;
  `,
  iconInfo: css`
    color: ${theme.colors.info.text};
    flex-shrink: 0;
    margin-top: 2px;
  `,
});
