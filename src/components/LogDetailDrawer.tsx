import React, { useEffect, useMemo, useState } from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import {
  useStyles2,
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
import { JsonTree, allContainerPaths } from './JsonTree';

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
   *  from Map-typed ones so flattened attribute rows get the right SQL accessor. Optional: omitted
   *  callers fall back to treating every attribute column as Map. */
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

/** Kibana shows 50 keys per page in the flat field list — mirrored here. */
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
  const [searchAttr, setSearchAttr] = useState('');
  const [activeTab, setActiveTab] = useState<DrawerTab>('table');
  const [selectedOnly, setSelectedOnly] = useState(false);
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

  // Header summary reads the narrow `row` directly — it must render instantly, before/without
  // the full row ever arriving. The flat field/value table below reads `effectiveRow`, which is
  // the hydrated full row once available, falling back to the narrow row (never blank).
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

  // Kibana's JSON tab renders fully expanded by default — every object/array node open, not
  // just the root.
  const jsonExpandedPaths = useMemo(() => allContainerPaths(effectiveRow), [effectiveRow]);

  // Flat Field | Value table (Kibana's default) — no OTel category grouping. Map/JSON container
  // columns (ResourceAttributes, LogAttributes, …) are excluded in their raw blob form and
  // replaced by their already-flattened dotted-path children from groupAttributes, so
  // "LogAttributes.http.method" is its own row instead of one giant stringified-object row.
  const c = config.columns;
  const containerCols = useMemo(
    () => new Set([c.resourceAttributes, c.logAttributes, c.scopeAttributes, c.spanAttributes].filter(Boolean)),
    [c.resourceAttributes, c.logAttributes, c.scopeAttributes, c.spanAttributes]
  );
  const attrGroups = useMemo(
    () => groupAttributes(effectiveRow, config.columns, jsonColumns),
    [effectiveRow, config.columns, jsonColumns]
  );
  const allRows = useMemo(() => {
    const flat: Array<{ key: string; value: string; sqlExpr: string }> = [];
    for (const [k, v] of Object.entries(effectiveRow)) {
      if (!k || containerCols.has(k)) {
        continue;
      }
      // The mapped timestamp column (and its OTel alias) renders as a raw epoch/DateTime value
      // otherwise — every other timestamp-shaped value in this UI (header, table) goes through
      // formatTimestamp, so this flat list shouldn't be the one place that doesn't.
      const isTimestampField = k === c.timestamp || k === CORE_ALIAS.timestamp;
      flat.push({
        key: k,
        value: isTimestampField
          ? formatTimestamp(v)
          : v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v ?? ''),
        sqlExpr: k,
      });
    }
    for (const g of attrGroups) {
      for (const r of g.rows) {
        flat.push({ key: `${g.col}.${r.key}`, value: r.value, sqlExpr: r.sqlExpr });
      }
    }
    return flat.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }, [effectiveRow, containerCols, attrGroups]);

  // Reset per-log UI state (not the search/selected-only filters, which the user likely wants to
  // keep applied while stepping through prev/next) whenever a new log is opened.
  useEffect(() => {
    setExpandedValues(new Set());
    setFieldsPage(0);
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
          {onViewTrace && clickhouseField === config.columns.traceId && (
            <IconButton
              name="link"
              size="sm"
              tooltip="View trace"
              onClick={() => onViewTrace(value)}
            />
          )}
        </div>
      </div>
    );
  };

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
          <JsonTree data={effectiveRow} defaultExpanded={jsonExpandedPaths} />
        </div>
      ) : (
        <div className={styles.content}>
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
            {hydrating && <Spinner size="sm" />}
          </div>

          {/* Flat Field | Value table — Kibana's default, no OTel category grouping. */}
          {(() => {
            const visible = allRows
              .filter((r) => filterMatch(r.key, r.value))
              .filter((r) => !selectedOnly || isColumnSelected(r.sqlExpr));
            const numberOfPages = Math.max(1, Math.ceil(visible.length / FIELDS_PAGE_SIZE));
            const page = Math.min(fieldsPage, numberOfPages - 1);
            const pageRows = visible.slice(page * FIELDS_PAGE_SIZE, (page + 1) * FIELDS_PAGE_SIZE);
            return (
              <>
                <div className={styles.attrListHeader}>
                  <span className={styles.attrKey}>Field</span>
                  <span className={styles.attrValue}>Value</span>
                </div>
                <div className={styles.attrList}>
                  {pageRows.map((r) => renderAttrRow(r.key, r.value, r.sqlExpr))}
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
    font-size: 13px;
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
    font-size: ${theme.typography.body.fontSize};
    color: ${theme.colors.text.secondary};
    font-variant-numeric: tabular-nums;
  `,
  severityChip: css`
    font-size: 13px;
    font-weight: ${theme.typography.fontWeightMedium};
    border: 1px solid;
    border-radius: ${theme.shape.radius.default};
    padding: 1px ${theme.spacing(0.75)};
  `,
  serviceChip: css`
    display: inline-flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    font-size: ${theme.typography.body.fontSize};
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
    font-size: 13px;
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
    font-size: ${theme.typography.body.fontSize};
    color: ${theme.colors.text.secondary};
    margin-right: auto;
  `,
  // ── Table tab ─────────────────────────────────────────────────────────────
  content: css`
    padding: ${theme.spacing(1)};
    font-size: ${theme.typography.body.fontSize};
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
    font-size: ${theme.typography.body.fontSize};
    color: ${theme.colors.text.secondary};
    white-space: nowrap;
    cursor: pointer;
  `,
  attrListHeader: css`
    display: flex;
    gap: ${theme.spacing(1.5)};
    padding: ${theme.spacing(0.5)} ${theme.spacing(0.75)};
    font-size: ${theme.typography.body.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.secondary};
    border-bottom: 1px solid ${theme.colors.border.weak};
    & > span:first-of-type {
      width: 40%;
      min-width: 100px;
      flex-shrink: 0;
    }
  `,
  attrList: css`
    padding: ${theme.spacing(0.5)};
  `,
  attrRow: css`
    display: flex;
    align-items: flex-start;
    gap: ${theme.spacing(1.5)};
    padding: ${theme.spacing(0.75)};
    border-radius: ${theme.shape.radius.default};
    font-size: ${theme.typography.body.fontSize};
    line-height: 1.6;
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
});
