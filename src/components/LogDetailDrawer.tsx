import React, { useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2, Drawer, Button, Icon } from '@grafana/ui';
import { LogRow, FilterPill, SourceConfig } from '../types';
import { groupAttributes } from '../sql/schema';
import { makeFilter } from '../sql/filters';

interface LogDetailDrawerProps {
  row: LogRow;
  config: SourceConfig;
  onClose: () => void;
  onAddFilter: (filter: FilterPill) => void;
  onViewTrace?: (traceId: string) => void;
}


export function LogDetailDrawer({
  row,
  config,
  onClose,
  onAddFilter,
  onViewTrace,
}: LogDetailDrawerProps) {
  const styles = useStyles2(getStyles);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(['logLine', 'resource', 'log'])
  );
  const [searchAttr, setSearchAttr] = useState('');

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  };

  const traceId = row['traceId'] ? String(row['traceId']) : null;
  const attrGroups = groupAttributes(row, config.columns);

  const filterMatch = (key: string, value: string): boolean => {
    if (!searchAttr) {
      return true;
    }
    const q = searchAttr.toLowerCase();
    return key.toLowerCase().includes(q) || String(value).toLowerCase().includes(q);
  };

  const renderAttrRow = (field: string, value: string, mapCol?: string) => {
    const clickhouseField = mapCol ? `${mapCol}['${field}']` : field;
    return (
      <div key={field} className={`${styles.attrRow} attr-row`}>
        <div className={`${styles.attrActions} attr-actions`}>
          <button
            className={styles.attrAction}
            title="Include in filter"
            onClick={() => onAddFilter(makeFilter(clickhouseField, value, '='))}
          >
            +
          </button>
          <button
            className={styles.attrAction}
            title="Exclude from filter"
            onClick={() => onAddFilter(makeFilter(clickhouseField, value, '!='))}
          >
            −
          </button>
        </div>
        <span className={styles.attrKey}>{field}</span>
        <span className={styles.attrValue}>{value}</span>
      </div>
    );
  };

  return (
    <Drawer title="Log Detail" onClose={onClose} size="md" scrollableContent>
      <div className={styles.content}>
        {/* Search within attributes */}
        <div className={styles.attrSearch}>
          <input
            className={styles.attrSearchInput}
            placeholder="Search field names and values"
            value={searchAttr}
            onChange={(e) => setSearchAttr(e.target.value)}
          />
        </div>

        {/* Log line */}
        <section className={styles.section}>
          <button className={styles.sectionHeader} onClick={() => toggleSection('logLine')}>
            <Icon name={expandedSections.has('logLine') ? 'angle-down' : 'angle-right'} />
            <span>Log line</span>
          </button>
          {expandedSections.has('logLine') && (
            <div className={styles.logLine}>{String(row['body'] ?? '')}</div>
          )}
        </section>

        {/* Trace / Log links */}
        {(traceId || onViewTrace) && (
          <section className={styles.section}>
            <button className={styles.sectionHeader} onClick={() => toggleSection('links')}>
              <Icon name={expandedSections.has('links') ? 'angle-down' : 'angle-right'} />
              <span>Links</span>
            </button>
            {expandedSections.has('links') && traceId && (
              <div className={styles.linksBody}>
                <span className={styles.attrKey}>traceID</span>
                <span className={styles.attrValue}>{traceId}</span>
                {onViewTrace && (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon="link"
                    onClick={() => onViewTrace(traceId)}
                    className={styles.linkBtn}
                  >
                    View trace
                  </Button>
                )}
              </div>
            )}
          </section>
        )}

        {/* OTel attribute groups */}
        {attrGroups.map(({ group, label, col, attrs }) => {
          const visible = Object.entries(attrs).filter(([k, v]) => filterMatch(k, v));
          if (visible.length === 0 && searchAttr) {
            return null;
          }
          return (
            <section key={group} className={styles.section}>
              <button className={styles.sectionHeader} onClick={() => toggleSection(group)}>
                <Icon
                  name={expandedSections.has(group) ? 'angle-down' : 'angle-right'}
                />
                <span>{label}</span>
                <span className={styles.attrCount}>{visible.length}</span>
              </button>
              {expandedSections.has(group) && (
                <div className={styles.attrList}>
                  {visible.map(([k, v]) => renderAttrRow(k, v, col))}
                </div>
              )}
            </section>
          );
        })}

        {/* All fields: every column from SELECT *, deduped against fixed aliases and mapped columns */}
        <section className={styles.section}>
          <button className={styles.sectionHeader} onClick={() => toggleSection('raw')}>
            <Icon name={expandedSections.has('raw') ? 'angle-down' : 'angle-right'} />
            <span>All fields</span>
          </button>
          {expandedSections.has('raw') && (
            <div className={styles.attrList}>
              {(() => {
                // Keys shown in dedicated sections (aliases + their source columns) — skip in All fields.
                const c = config.columns;
                const hidden = new Set([
                  // Fixed core aliases always added by buildLogsQuery
                  'timestamp', 'body', 'severity', 'traceId', 'spanId', 'serviceName',
                  // Raw mapped column names projected by SELECT * (duplicates of the aliases)
                  c.timestamp, c.body, c.severity, c.traceId, c.spanId, c.serviceName,
                  // Attribute map columns shown in their own groups
                  'ResourceAttributes', 'LogAttributes', 'ScopeAttributes', 'SpanAttributes',
                  c.resourceAttributes, c.logAttributes, c.scopeAttributes, c.spanAttributes,
                ]);
                return Object.entries(row)
                  .filter(([k]) => !hidden.has(k) && k !== '')
                  .filter(([k, v]) => filterMatch(k, String(v ?? '')))
                  .map(([k, v]) =>
                    renderAttrRow(k, v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v ?? ''), undefined)
                  );
              })()}
            </div>
          )}
        </section>
      </div>
    </Drawer>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  content: css`
    padding: ${theme.spacing(1)};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  attrSearch: css`
    margin-bottom: ${theme.spacing(1)};
  `,
  attrSearchInput: css`
    width: 100%;
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.medium};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(0.5)} ${theme.spacing(1)};
    color: ${theme.colors.text.primary};
    font-size: ${theme.typography.bodySmall.fontSize};
    outline: none;
    &:focus {
      border-color: ${theme.colors.primary.border};
    }
  `,
  section: css`
    margin-bottom: ${theme.spacing(0.5)};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    overflow: hidden;
  `,
  sectionHeader: css`
    width: 100%;
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    padding: ${theme.spacing(0.75)} ${theme.spacing(1)};
    background: ${theme.colors.background.secondary};
    border: none;
    cursor: pointer;
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.primary};
    text-align: left;
    &:hover {
      background: ${theme.colors.action.hover};
    }
  `,
  attrCount: css`
    margin-left: auto;
    color: ${theme.colors.text.secondary};
    font-size: 11px;
    font-weight: normal;
  `,
  logLine: css`
    padding: ${theme.spacing(1)};
    font-family: ${theme.typography.fontFamilyMonospace};
    white-space: pre-wrap;
    word-break: break-all;
    color: ${theme.colors.text.primary};
    background: ${theme.colors.background.canvas};
  `,
  linksBody: css`
    padding: ${theme.spacing(0.75)} ${theme.spacing(1)};
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    flex-wrap: wrap;
  `,
  linkBtn: css`
    margin-left: auto;
  `,
  attrList: css`
    padding: ${theme.spacing(0.5)};
  `,
  attrRow: css`
    display: flex;
    align-items: flex-start;
    gap: ${theme.spacing(0.5)};
    padding: ${theme.spacing(0.25)} ${theme.spacing(0.5)};
    border-radius: ${theme.shape.radius.default};
    &:hover {
      background: ${theme.colors.action.hover};
    }
    &:hover .attr-actions {
      opacity: 1;
    }
  `,
  attrActions: css`
    display: flex;
    gap: 2px;
    flex-shrink: 0;
    opacity: 0;
    transition: opacity 0.1s;
  `,
  attrAction: css`
    width: 18px;
    height: 18px;
    border: 1px solid ${theme.colors.border.medium};
    border-radius: 3px;
    background: ${theme.colors.background.secondary};
    cursor: pointer;
    font-size: 12px;
    line-height: 1;
    color: ${theme.colors.text.primary};
    display: flex;
    align-items: center;
    justify-content: center;
    &:hover {
      background: ${theme.colors.primary.main};
      color: ${theme.colors.primary.contrastText};
      border-color: ${theme.colors.primary.main};
    }
  `,
  attrKey: css`
    font-family: ${theme.typography.fontFamilyMonospace};
    color: ${theme.colors.text.secondary};
    min-width: 140px;
    flex-shrink: 0;
    word-break: break-all;
  `,
  attrValue: css`
    font-family: ${theme.typography.fontFamilyMonospace};
    color: ${theme.colors.text.primary};
    word-break: break-all;
    flex: 1;
  `,
});
