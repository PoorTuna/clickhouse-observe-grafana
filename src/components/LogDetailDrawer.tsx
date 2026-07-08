import React, { useEffect, useMemo, useState } from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import {
  useStyles2,
  Button,
  Icon,
  IconButton,
  ClipboardButton,
  Input,
  Switch,
  TabsBar,
  Tab,
  Spinner,
  Pagination,
} from '@grafana/ui';
import { LogRow, FilterPill, SourceConfig, SelectedColumn } from '../types';
import { FieldModel } from '../sql/fieldModel';
import { groupAttributes } from '../sql/schema';
import { makeFilter } from '../sql/filters';
import { CORE_ALIAS } from '../sql/queryBuilder';
import { formatTimestamp, severityColor } from './LogsTable';
import { makeColumnKey } from './FieldSidebar/FieldSidebar';
import { JsonTree } from './JsonTree';

interface LogDetailDrawerProps {
  /** Narrow (grid-projection) row — always present, used for the header summary which must
   * open instantly regardless of whether the full row has hydrated yet. */
  row: LogRow;
  /**
   * Full-row data (all columns, incl. Map attribute columns), fetched lazily by the caller and
   * matched to `row` by content key — see logRowKey() in sql/queryBuilder.ts. Undefined while
   * unhydrated/hydrating, or in raw-SQL mode where `row` already *is* the full row. Attribute
   * groups, "All fields", and the JSON tab fall back to `row` when this is absent, so they never
   * show nothing — just less than once hydration lands.
   */
  detailRow?: LogRow;
  /** True while a hydrate fetch for detailRow's page is in flight. */
  detailLoading?: boolean;
  config: SourceConfig;
  /** Discovered fields (from useFieldDiscovery) — used to tell JSON-typed attribute columns apart
   *  from Map-typed ones so attribute rows get the right SQL accessor. Optional: omitted callers
   *  fall back to treating every attribute column as Map, matching prior behavior. */
  fields?: FieldModel[];
  /** Currently-selected table columns — drives the "selected only" toggle and the add/remove-column action. */
  columns: SelectedColumn[];
  onClose: () => void;
  onAddFilter: (filter: FilterPill) => void;
  onToggleColumn?: (col: SelectedColumn) => void;
  onViewTrace?: (traceId: string) => void;
  /** Step to the previous/next row on the current page. Omit to hide the nav control. */
  onPrev?: () => void;
  onNext?: () => void;
  /** e.g. "3 of 50" */
  navLabel?: string;
}

type DrawerTab = 'table' | 'json';

interface SelectionPopover {
  left: number;
  top: number;
  text: string;
}

/** Kibana shows 50 keys per page in the "All fields" list — mirrored here. */
const FIELDS_PAGE_SIZE = 50;
/** Attribute values longer than this render truncated, with a "Show more" toggle. */
const VALUE_TRUNCATE_LEN = 300;

export function LogDetailDrawer({
  row,
  detailRow,
  detailLoading,
  config,
  fields,
  columns,
  onClose,
  onAddFilter,
  onToggleColumn,
  onViewTrace,
  onPrev,
  onNext,
  navLabel,
}: LogDetailDrawerProps) {
  const styles = useStyles2(getStyles);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(['logLine', 'links', 'raw'])
  );
  const [searchAttr, setSearchAttr] = useState('');
  const [activeTab, setActiveTab] = useState<DrawerTab>('table');
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [selectionPopover, setSelectionPopover] = useState<SelectionPopover | null>(null);
  const [expandedValues, setExpandedValues] = useState<Set<string>>(new Set());
  const [fieldsPage, setFieldsPage] = useState(0);

  const toggleValueExpanded = (key: string) => {
    setExpandedValues((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

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

  // Header summary reads the narrow `row` directly — it must render instantly, before/without
  // the full row ever arriving. Attribute groups / All fields / JSON below read `effectiveRow`,
  // which is the hydrated full row once available, falling back to the narrow row (never blank).
  const traceId = row[CORE_ALIAS.traceId] ? String(row[CORE_ALIAS.traceId]) : null;
  const timestamp = formatTimestamp(row[CORE_ALIAS.timestamp]);
  const severity = row[CORE_ALIAS.severity] ? String(row[CORE_ALIAS.severity]) : null;
  const service = row[CORE_ALIAS.serviceName] ? String(row[CORE_ALIAS.serviceName]) : null;
  const effectiveRow = detailRow ?? row;
  const hydrating = Boolean(detailLoading) && !detailRow;
  const jsonColumns = useMemo(
    () =>
      new Set(
        (fields ?? []).filter((f) => f.source === 'column' && f.type === 'json').map((f) => f.name)
      ),
    [fields]
  );
  const attrGroups = useMemo(
    () => groupAttributes(effectiveRow, config.columns, jsonColumns),
    [effectiveRow, config.columns, jsonColumns]
  );

  // Auto-expand every section (Kibana default) whenever a new log is opened. Keyed on `row`
  // identity, not `effectiveRow` — the lazy-hydrated detailRow arriving shouldn't re-collapse
  // sections the user already toggled while viewing the same log.
  useEffect(() => {
    setExpandedSections(new Set(['logLine', 'links', 'raw', ...attrGroups.map((g) => g.group)]));
    setExpandedValues(new Set());
    setFieldsPage(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row]);

  const isColumnSelected = (clickhouseField: string): boolean =>
    columns.some((c) => c.sqlExpr === clickhouseField);

  const toggleAsColumn = (field: string, clickhouseField: string) => {
    if (!onToggleColumn) {
      return;
    }
    const existing = columns.find((c) => c.sqlExpr === clickhouseField);
    if (existing) {
      onToggleColumn(existing);
      return;
    }
    onToggleColumn({
      id: clickhouseField,
      key: 'fld_' + makeColumnKey(clickhouseField),
      sqlExpr: clickhouseField,
      displayName: field,
      type: 'string',
      isCore: false,
    });
  };

  const filterMatch = (key: string, value: string): boolean => {
    if (!searchAttr) {
      return true;
    }
    const q = searchAttr.toLowerCase();
    return key.toLowerCase().includes(q) || String(value).toLowerCase().includes(q);
  };

  const renderAttrRow = (field: string, value: string, sqlExpr: string = field) => {
    const clickhouseField = sqlExpr;
    const isSelected = isColumnSelected(clickhouseField);
    if (selectedOnly && !isSelected) {
      return null;
    }
    const valueKey = `${field}:${clickhouseField}`;
    const isLong = value.length > VALUE_TRUNCATE_LEN;
    const isValueExpanded = expandedValues.has(valueKey);
    const displayValue = isLong && !isValueExpanded ? value.slice(0, VALUE_TRUNCATE_LEN) + '…' : value;
    return (
      <div key={field} className={styles.attrRow}>
        <span className={styles.attrKey} title={field}>{field}</span>
        <span className={styles.attrValue}>
          {displayValue}
          {isLong && (
            <button className={styles.showMoreBtn} onClick={() => toggleValueExpanded(valueKey)}>
              {isValueExpanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </span>
        <div className={styles.attrActions}>
          <IconButton
            name="filter-plus"
            size="sm"
            tooltip="Filter for value"
            onClick={() => onAddFilter(makeFilter(clickhouseField, value, '='))}
          />
          <IconButton
            name="filter-minus"
            size="sm"
            tooltip="Filter out value"
            onClick={() => onAddFilter(makeFilter(clickhouseField, value, '!='))}
          />
          <ClipboardButton
            icon="clipboard-alt"
            size="sm"
            variant="secondary"
            fill="text"
            tooltip="Copy value"
            aria-label={`Copy value of ${field}`}
            getText={() => value}
          />
          {onToggleColumn && (
            <IconButton
              name="plus-square"
              size="sm"
              variant={isSelected ? 'primary' : undefined}
              tooltip={isSelected ? 'Remove column' : 'Add as column'}
              onClick={() => toggleAsColumn(field, clickhouseField)}
            />
          )}
        </div>
      </div>
    );
  };

  const onLogLineMouseUp = () => {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? '';
    if (!text || !sel || sel.rangeCount === 0 || !config.columns.body) {
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    setSelectionPopover({ left: rect.left + rect.width / 2, top: rect.top, text });
  };

  const clearSelectionPopover = () => setSelectionPopover(null);

  const bodyText = String(row[CORE_ALIAS.body] ?? '');

  // Keys shown in dedicated sections (aliases + their source columns) — skip in All fields.
  const c = config.columns;
  const hiddenKeys = useMemo(
    () =>
      new Set([
        CORE_ALIAS.timestamp, CORE_ALIAS.body, CORE_ALIAS.severity,
        CORE_ALIAS.traceId, CORE_ALIAS.spanId, CORE_ALIAS.serviceName,
        c.timestamp, c.body, c.severity, c.traceId, c.spanId, c.serviceName,
        c.resourceAttributes, c.logAttributes, c.scopeAttributes, c.spanAttributes,
      ]),
    [c]
  );

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <div className={styles.panelTitleRow}>
          <span className={styles.panelTitle}>Log detail</span>
          <div className={styles.summarySpacer} />
          <IconButton name="times" size="lg" tooltip="Close" aria-label="Close log detail" onClick={onClose} />
        </div>
        <div className={styles.summary}>
          <span className={styles.summaryTime}>{timestamp}</span>
          {severity && (
            <span
              className={styles.severityChip}
              style={{ color: severityColor(severity), borderColor: severityColor(severity) }}
            >
              {severity.toUpperCase()}
            </span>
          )}
          {service && (
            <span className={styles.serviceChip}>
              <Icon name="apps" size="xs" />
              {service}
            </span>
          )}
          <div className={styles.summarySpacer} />
          {(onPrev || onNext) && (
            <div className={styles.navGroup}>
              <IconButton name="angle-up" size="sm" tooltip="Previous log" onClick={onPrev} disabled={!onPrev} />
              {navLabel && <span className={styles.navLabel}>{navLabel}</span>}
              <IconButton name="angle-down" size="sm" tooltip="Next log" onClick={onNext} disabled={!onNext} />
            </div>
          )}
        </div>
        <TabsBar>
          <Tab
            label="Table"
            icon="table-collapse-all"
            active={activeTab === 'table'}
            onChangeTab={() => setActiveTab('table')}
          />
          <Tab
            label="JSON"
            icon="brackets-curly"
            active={activeTab === 'json'}
            onChangeTab={() => setActiveTab('json')}
          />
        </TabsBar>
      </div>
      <div className={styles.panelBody}>
      {activeTab === 'json' ? (
        <div className={styles.jsonWrap}>
          {hydrating && (
            <span className={styles.hydratingNote}>
              <Spinner size="sm" /> Loading full row…
            </span>
          )}
          <JsonTree data={effectiveRow} defaultExpanded={new Set(['root'])} />
        </div>
      ) : (
        <div className={styles.content} onMouseDown={clearSelectionPopover}>
          {/* Field/value search + selected-only toggle */}
          <div className={styles.toolbarRow}>
            <Input
              prefix={<Icon name="search" />}
              placeholder="Search field names and values"
              value={searchAttr}
              onChange={(e) => setSearchAttr(e.currentTarget.value)}
              className={styles.attrSearch}
            />
            <label className={styles.selectedOnlyLabel}>
              <Switch value={selectedOnly} onChange={(e) => setSelectedOnly(e.currentTarget.checked)} />
              Selected only
            </label>
          </div>

          {/* Log line */}
          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <button className={styles.sectionToggle} onClick={() => toggleSection('logLine')}>
                <Icon name={expandedSections.has('logLine') ? 'angle-down' : 'angle-right'} />
                <span>Log line</span>
              </button>
              <ClipboardButton
                icon="clipboard-alt"
                size="sm"
                variant="secondary"
                fill="text"
                tooltip="Copy log line"
                aria-label="Copy log line"
                getText={() => bodyText}
              />
            </div>
            {expandedSections.has('logLine') && (
              <div className={styles.logLine} onMouseUp={onLogLineMouseUp}>
                {bodyText}
              </div>
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
          {attrGroups.map(({ group, label, rows }) => {
            const visible = rows
              .filter((r) => filterMatch(r.key, r.value))
              .filter((r) => !selectedOnly || isColumnSelected(r.sqlExpr));
            if (visible.length === 0 && (searchAttr || selectedOnly)) {
              return null;
            }
            return (
              <section key={group} className={styles.section}>
                <button className={styles.sectionHeader} onClick={() => toggleSection(group)}>
                  <Icon name={expandedSections.has(group) ? 'angle-down' : 'angle-right'} />
                  <span>{label}</span>
                  <span className={styles.attrCount}>{visible.length}</span>
                </button>
                {expandedSections.has(group) && (
                  <div className={styles.attrList}>
                    {visible.map((r) => renderAttrRow(r.key, r.value, r.sqlExpr))}
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
              {hydrating && <Spinner size="sm" className={styles.hydratingSpinner} />}
            </button>
            {expandedSections.has('raw') &&
              (() => {
                const allFields = Object.entries(effectiveRow)
                  .filter(([k]) => !hiddenKeys.has(k) && k !== '')
                  .filter(([k, v]) => filterMatch(k, String(v ?? '')))
                  .filter(([k]) => !selectedOnly || isColumnSelected(k));
                const numberOfPages = Math.max(1, Math.ceil(allFields.length / FIELDS_PAGE_SIZE));
                const page = Math.min(fieldsPage, numberOfPages - 1);
                const pageFields = allFields.slice(page * FIELDS_PAGE_SIZE, (page + 1) * FIELDS_PAGE_SIZE);
                return (
                  <>
                    <div className={styles.attrList}>
                      {pageFields.map(([k, v]) =>
                        renderAttrRow(k, v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v ?? ''), undefined)
                      )}
                    </div>
                    {numberOfPages > 1 && (
                      <div className={styles.fieldsPagination}>
                        <Pagination
                          currentPage={page + 1}
                          numberOfPages={numberOfPages}
                          onNavigate={(p) => setFieldsPage(p - 1)}
                          hideWhenSinglePage
                        />
                      </div>
                    )}
                  </>
                );
              })()}
          </section>
        </div>
      )}

      {/* Select-text-in-log-line → "line contains" filter, floating near the selection */}
      {selectionPopover && (
        <div
          className={styles.selectionPopover}
          style={{ left: selectionPopover.left, top: selectionPopover.top - 40 }}
        >
          <Button
            size="sm"
            variant="secondary"
            icon="filter-plus"
            onClick={() => {
              onAddFilter(makeFilter(config.columns.body, selectionPopover.text, 'contains'));
              setSelectionPopover(null);
              window.getSelection()?.removeAllRanges();
            }}
          >
            Line contains &ldquo;
            {selectionPopover.text.length > 24 ? selectionPopover.text.slice(0, 24) + '…' : selectionPopover.text}
            &rdquo;
          </Button>
        </div>
      )}
      </div>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  // ── Inline panel chrome (replaces the old overlay Drawer) ─────────────────
  panel: css`
    display: flex;
    flex-direction: column;
    height: 100%;
    background: ${theme.colors.background.primary};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    overflow: hidden;
  `,
  panelHeader: css`
    flex-shrink: 0;
    padding: ${theme.spacing(1)} ${theme.spacing(1.5)} 0;
    border-bottom: 1px solid ${theme.colors.border.weak};
  `,
  panelTitleRow: css`
    display: flex;
    align-items: center;
    margin-bottom: ${theme.spacing(0.5)};
  `,
  panelTitle: css`
    font-size: ${theme.typography.h6.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.primary};
  `,
  panelBody: css`
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  `,
  showMoreBtn: css`
    display: block;
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 0;
    margin-top: ${theme.spacing(0.25)};
    color: ${theme.colors.primary.text};
    font-size: 11px;
    &:hover { text-decoration: underline; }
  `,
  fieldsPagination: css`
    display: flex;
    justify-content: center;
    padding: ${theme.spacing(1)} 0;
  `,
  // ── Header summary ────────────────────────────────────────────────────────
  summary: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    flex-wrap: wrap;
  `,
  summaryTime: css`
    font-family: ${theme.typography.fontFamilyMonospace};
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    font-variant-numeric: tabular-nums;
  `,
  severityChip: css`
    font-size: 11px;
    font-weight: ${theme.typography.fontWeightMedium};
    border: 1px solid;
    border-radius: ${theme.shape.radius.default};
    padding: 1px ${theme.spacing(0.75)};
  `,
  serviceChip: css`
    display: inline-flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
  `,
  summarySpacer: css`
    flex: 1;
  `,
  navGroup: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
  `,
  navLabel: css`
    font-size: 11px;
    color: ${theme.colors.text.secondary};
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  `,

  // ── JSON tab ──────────────────────────────────────────────────────────────
  jsonWrap: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
    padding: ${theme.spacing(1)};
    height: 100%;
  `,
  hydratingNote: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    margin-right: auto;
  `,
  hydratingSpinner: css`
    margin-left: auto;
  `,
  // ── Table tab ─────────────────────────────────────────────────────────────
  content: css`
    padding: ${theme.spacing(1)};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  toolbarRow: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1.5)};
    margin-bottom: ${theme.spacing(1)};
  `,
  attrSearch: css`
    flex: 1;
  `,
  selectedOnlyLabel: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.75)};
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    white-space: nowrap;
    cursor: pointer;
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
  /** Used inside `sectionHeader` when it's a div (not a button) hosting a trailing action —
   *  e.g. Log line's copy button — so we never nest a real <button> inside another <button>. */
  sectionToggle: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    flex: 1;
    background: transparent;
    border: none;
    padding: 0;
    cursor: pointer;
    font: inherit;
    font-weight: inherit;
    color: inherit;
    text-align: left;
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
    word-break: break-word;
    overflow-wrap: anywhere;
    color: ${theme.colors.text.primary};
    background: ${theme.colors.background.canvas};
    user-select: text;
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
    gap: ${theme.spacing(1)};
    padding: ${theme.spacing(0.5)};
    border-radius: ${theme.shape.radius.default};
    &:hover {
      background: ${theme.colors.action.hover};
    }
    &:hover .attr-actions {
      opacity: 1;
    }
  `,
  attrKey: css`
    font-family: ${theme.typography.fontFamilyMonospace};
    color: ${theme.colors.text.secondary};
    width: 40%;
    min-width: 100px;
    flex-shrink: 0;
    word-break: break-word;
    overflow-wrap: anywhere;
  `,
  attrValue: css`
    font-family: ${theme.typography.fontFamilyMonospace};
    color: ${theme.colors.text.primary};
    word-break: break-word;
    overflow-wrap: anywhere;
    flex: 1;
  `,
  attrActions: cx(
    'attr-actions',
    css`
      display: flex;
      gap: 2px;
      flex-shrink: 0;
      opacity: 0;
      transition: opacity 150ms ease;
      @media (prefers-reduced-motion: reduce) {
        transition: none;
      }
    `
  ),

  // ── Select-text → filter popover ─────────────────────────────────────────
  selectionPopover: css`
    position: fixed;
    z-index: 1100;
    transform: translateX(-50%);
    box-shadow: ${theme.shadows.z2};
    border-radius: ${theme.shape.radius.default};
  `,
});
