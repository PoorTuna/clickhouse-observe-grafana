/**
 * Shared empty state for the Inspect drawer's four tabs — before this each tab (Warnings, Queries,
 * Stats, Timeline) had its own bespoke icon size/padding/copy, which read as inconsistent chrome
 * rather than one drawer. `@grafana/ui`'s own `EmptyState` renders a large illustration meant for a
 * full page, the wrong density for a drawer tab, so this is a small local component instead.
 */
import React from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Icon, IconName, useStyles2 } from '@grafana/ui';

interface DiagEmptyStateProps {
  icon: IconName;
  title: string;
  description?: string;
  /** Tinted success (e.g. "no warnings — good") instead of the default neutral tone. */
  tone?: 'neutral' | 'success' | 'warning';
  action?: React.ReactNode;
}

export function DiagEmptyState({ icon, title, description, tone = 'neutral', action }: DiagEmptyStateProps) {
  const styles = useStyles2(getStyles);
  const iconClass = tone === 'success' ? styles.iconSuccess : tone === 'warning' ? styles.iconWarning : styles.icon;
  return (
    <div className={styles.empty}>
      <Icon name={icon} size="lg" className={iconClass} />
      <div className={styles.title}>{title}</div>
      {description && <div className={styles.description}>{description}</div>}
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  empty: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: ${theme.spacing(1)};
    color: ${theme.colors.text.secondary};
    padding: ${theme.spacing(4)} ${theme.spacing(2)};
    text-align: center;
    max-width: 480px;
    margin: 0 auto;
  `,
  icon: css`
    color: ${theme.colors.text.disabled};
  `,
  iconSuccess: css`
    color: ${theme.colors.success.text};
  `,
  iconWarning: css`
    color: ${theme.colors.warning.text};
  `,
  title: css`
    color: ${theme.colors.text.primary};
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  description: css`
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  action: css`
    margin-top: ${theme.spacing(1)};
  `,
});
