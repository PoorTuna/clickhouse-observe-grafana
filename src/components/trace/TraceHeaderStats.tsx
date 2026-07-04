import React from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2, Badge, Icon, Tooltip } from '@grafana/ui';
import { serviceColor } from '../../constants';
import { formatMs } from '../../utils/traceFormat';

interface TraceHeaderStatsProps {
  traceId: string;
  rootServiceName: string;
  rootOperationName: string;
  durationMs: number;
  spanCount: number;
  serviceCount: number;
  errorCount: number;
  maxDepth: number;
}

/** Compact Jaeger-style summary strip shown above the waterfall/service-map/JSON views. */
export function TraceHeaderStats({
  traceId,
  rootServiceName,
  rootOperationName,
  durationMs,
  spanCount,
  serviceCount,
  errorCount,
  maxDepth,
}: TraceHeaderStatsProps) {
  const styles = useStyles2(getStyles);

  return (
    <div className={styles.container}>
      <div className={styles.rootOp}>
        <span className={styles.serviceDot} style={{ background: serviceColor(rootServiceName) }} />
        <span className={styles.serviceName}>{rootServiceName || '(unknown)'}</span>
        <span className={styles.opName}>{rootOperationName || '(unnamed root)'}</span>
      </div>
      <div className={styles.stats}>
        <Tooltip content="Total trace duration">
          <span className={styles.stat}>
            <Icon name="clock-nine" size="sm" />
            {formatMs(durationMs)}
          </span>
        </Tooltip>
        <Tooltip content="Span count">
          <span className={styles.stat}>
            <Icon name="brackets-curly" size="sm" />
            {spanCount} span{spanCount === 1 ? '' : 's'}
          </span>
        </Tooltip>
        <Tooltip content="Services involved">
          <span className={styles.stat}>
            <Icon name="apps" size="sm" />
            {serviceCount} service{serviceCount === 1 ? '' : 's'}
          </span>
        </Tooltip>
        <Tooltip content="Max nesting depth">
          <span className={styles.stat}>
            <Icon name="code-branch" size="sm" />
            depth {maxDepth}
          </span>
        </Tooltip>
        {errorCount > 0 && <Badge color="red" text={`${errorCount} error${errorCount === 1 ? '' : 's'}`} icon="exclamation-triangle" />}
      </div>
      <span className={styles.traceId} title={traceId}>
        {traceId}
      </span>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(2)};
    padding: ${theme.spacing(1)} ${theme.spacing(1.5)};
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    flex-wrap: wrap;
  `,
  rootOp: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    font-weight: ${theme.typography.fontWeightMedium};
    min-width: 0;
  `,
  serviceDot: css`
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  `,
  serviceName: css`
    color: ${theme.colors.text.secondary};
    flex-shrink: 0;
  `,
  opName: css`
    color: ${theme.colors.text.primary};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  stats: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1.5)};
    flex-shrink: 0;
  `,
  stat: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  traceId: css`
    margin-left: auto;
    font-family: ${theme.typography.fontFamilyMonospace};
    font-size: 11px;
    color: ${theme.colors.text.disabled};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 220px;
  `,
});
