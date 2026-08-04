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
import { FieldModel, FieldType } from '../sql/fieldModel';
import { groupAttributes, flattenJson, parseJsonColumnValue, GroupedAttrRow } from '../sql/schema';
import { makeFilter } from '../sql/filters';
import { CORE_ALIAS } from '../sql/queryBuilder';
import { formatTimestamp } from './LogsTable';
import { makeColumnKey, fieldToColumn } from './FieldSidebar/FieldSidebar';
import { FIELD_TYPE_ICONS } from './FieldSidebar/fieldIcons';
import { JsonTree, allContainerPaths } from './JsonTree';

interface FlatAttrRow {
  key: string;
  value: string;
  sqlExpr: string;
  type: FieldType;
}

/**
 * Flattens effectiveRow's plain top-level entries into flat Field|Value rows, skipping container
 * columns (handled separately by flattenAttrGroups, below, via their already-flattened dotted-path
 * children). A JSON-typed column that isn't one of the configured attribute containers gets its
 * own dotted-path flattening here too — the same treatment every other JSON column in this app
 * gets, instead of falling through to a single stringified blob row.
 */
function flattenRowEntries(
  row: Record<string, unknown>,
  containerCols: Set<string>,
  jsonColumns: Set<string>,
  timestampSqlExpr: string,
  resolveType: (sqlExpr: string) => FieldType
): FlatAttrRow[] {
  const flat: FlatAttrRow[] = [];
  for (const [k, v] of Object.entries(row)) {
    if (!k || containerCols.has(k)) {
      continue;
    }
    // The mapped timestamp column (and its OTel alias) renders as a raw epoch/DateTime value
    // otherwise — every other timestamp-shaped value in this UI (header, table) goes through
    // formatTimestamp, so this flat list shouldn't be the one place that doesn't.
    const isTimestampField = k === timestampSqlExpr || k === CORE_ALIAS.timestamp;
    if (jsonColumns.has(k)) {
      const leaves = flattenJson(parseJsonColumnValue(v));
      if (leaves.length > 0) {
        for (const leaf of leaves) {
          flat.push({ key: `${k}.${leaf.key}`, value: leaf.value, sqlExpr: `${k}.${leaf.key}`, type: 'string' });
        }
        continue;
      }
    }
    flat.push({
      key: k,
      value: isTimestampField
        ? formatTimestamp(v)
        : v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v ?? ''),
      sqlExpr: k,
      type: resolveType(k),
    });
  }
  return flat;
}

/** Flattens groupAttributes()'s per-column groups (Map/JSON attribute containers) into the same
 *  flat Field|Value row shape flattenRowEntries produces, so both merge into one sortable list. */
function flattenAttrGroups(
  attrGroups: Array<{ col: string; rows: GroupedAttrRow[] }>,
  resolveType: (sqlExpr: string) => FieldType
): FlatAttrRow[] {
  const flat: FlatAttrRow[] = [];
  for (const g of attrGroups) {
    for (const r of g.rows) {
      flat.push({ key: `${g.col}.${r.key}`, value: r.value, sqlExpr: r.sqlExpr, type: resolveType(r.sqlExpr) });
    }
  }
  return flat;
}

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
  /** "Expand" toggle — grows the detail pane to near-full width. Omit to hide the button. */
  expanded?: boolean;
  onToggleExpanded?: () => void;
  onAddFilter: (filter: FilterPill) => void;
  onToggleColumn?: (col: SelectedColumn) => void;
  /** Resolves the mapped traceId column's value to a ClickHouse Explore trace-view URL (see
   *  data/traceLinks.ts). Returns undefined while resolving or when the datasource has no
   *  Traces config — the traceId then renders as plain text instead of a link. */
  getTraceHref?: (traceId: string) => string | undefined;
  /** Step to the previous/next row on the current page. Omit to hide the nav control. */
  onPrev?: () => void;
  onNext?: () => void;
  /** e.g. "3 of 50" */
  navLabel?: string;
}

type DrawerTab = 'table' | 'json';

/** Flat field list is paginated 50 keys per page. */
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
  expanded,
  onToggleExpanded,
  onAddFilter,
  onToggleColumn,
  getTraceHref,
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
  const effectiveRow = detailRow ?? row;
  const hydrating = Boolean(detailLoading) && !detailRow;
  const c = config.columns;
  const jsonColumns = useMemo(
    () =>
      new Set(
        (fields ?? []).filter((f) => f.source === 'column' && f.type === 'json').map((f) => f.name)
      ),
    [fields]
  );
  // Auto-detected Map-typed columns (no config mapping required, same as jsonColumns above) —
  // any of these gets flattened into dotted-path rows by groupAttributes below, instead of
  // requiring the 3 "Resource/Log/Scope Attributes" fields the Logs data-view editor used to have.
  const mapColumns = useMemo(
    () =>
      new Set(
        (fields ?? []).filter((f) => f.source === 'column' && f.type === 'map').map((f) => f.name)
      ),
    [fields]
  );
  // sqlExpr -> discovered type, used to prefix each flat row with a type icon.
  const typeByExpr = useMemo(
    () => new Map((fields ?? []).map((f) => [f.sqlExpr, f.type] as const)),
    [fields]
  );
  const resolveType = (sqlExpr: string): FieldType => {
    if (sqlExpr === c.timestamp || sqlExpr === CORE_ALIAS.timestamp) {
      return 'time';
    }
    return typeByExpr.get(sqlExpr) ?? 'string';
  };

  // The JSON tab renders fully expanded by default — every object/array node open, not
  // just the root.
  const jsonExpandedPaths = useMemo(() => allContainerPaths(effectiveRow), [effectiveRow]);

  // Flat Field | Value table — no OTel category grouping. Map/JSON container
  // columns (ResourceAttributes, LogAttributes, …) are excluded in their raw blob form and
  // replaced by their already-flattened dotted-path children from groupAttributes, so
  // "LogAttributes.http.method" is its own row instead of one giant stringified-object row.
  const containerCols = useMemo(
    () => new Set([...mapColumns, ...jsonColumns, ...(c.spanAttributes ? [c.spanAttributes] : [])]),
    [mapColumns, jsonColumns, c.spanAttributes]
  );
  const attrGroups = useMemo(
    () => groupAttributes(effectiveRow, config.columns, mapColumns, jsonColumns),
    [effectiveRow, config.columns, mapColumns, jsonColumns]
  );
  const allRows = useMemo(() => {
    const flat = [
      ...flattenRowEntries(effectiveRow, containerCols, jsonColumns, c.timestamp, resolveType),
      ...flattenAttrGroups(attrGroups, resolveType),
    ];
    return flat.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveRow, containerCols, attrGroups, c.timestamp, jsonColumns, typeByExpr]);

  // Reset per-log UI state (not the search/selected-only filters, which the user likely wants to
  // keep applied while stepping through prev/next) whenever a new log is opened.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
    // Reuse the discovered FieldModel (same id/key the sidebar would produce via fieldToColumn)
    // when one matches this sqlExpr, so adding the same field from the drawer vs. the sidebar
    // converges on one column instead of two — a raw `id: clickhouseField` here previously
    // diverged from the sidebar's `id: field.id`, letting the same field be added twice, and
    // `'fld_' + makeColumnKey(...)` double-prefixed the alias (makeColumnKey already adds `fld_`).
    const discovered = fields?.find((f) => f.sqlExpr === clickhouseField);
    onToggleColumn(
      discovered
        ? fieldToColumn(discovered)
        : {
            id: clickhouseField,
            key: makeColumnKey(clickhouseField),
            sqlExpr: clickhouseField,
            displayName: field,
            type: 'string',
            isCore: false,
          }
    );
  };

  const filterMatch = (key: string, value: string): boolean => {
    if (!searchAttr) {
      return true;
    }
    const q = searchAttr.toLowerCase();
    return key.toLowerCase().includes(q) || String(value).toLowerCase().includes(q);
  };

  const renderAttrRow = (field: string, value: string, sqlExpr: string = field, type: FieldType = 'string') => {
    const clickhouseField = sqlExpr;
    const isSelected = isColumnSelected(clickhouseField);
    if (selectedOnly && !isSelected) {
      return null;
    }
    const valueKey = `${field}:${clickhouseField}`;
    const isLong = value.length > VALUE_TRUNCATE_LEN;
    const isValueExpanded = expandedValues.has(valueKey);
    const displayValue = isLong && !isValueExpanded ? value.slice(0, VALUE_TRUNCATE_LEN) + '…' : value;
    const traceHref =
      clickhouseField === config.columns.traceId ? getTraceHref?.(value) : undefined;
    return (
      <div key={field} className={styles.attrRow}>
        <span className={styles.attrKey} title={field}>
          <Icon className={styles.attrTypeIcon} name={FIELD_TYPE_ICONS[type] as any} size="sm" />
          {field}
        </span>
        {traceHref ? (
          <a
            className={styles.traceIdButton}
            title="Open trace in Explore"
            href={traceHref}
            target="_blank"
            rel="noreferrer"
          >
            {displayValue}
            <Icon name="external-link-alt" size="sm" className={styles.traceIdIcon} />
          </a>
        ) : (
          <span className={styles.attrValue}>
            {displayValue}
            {isLong && (
              <button className={styles.showMoreBtn} onClick={() => toggleValueExpanded(valueKey)}>
                {isValueExpanded ? 'Show less' : 'Show more'}
              </button>
            )}
          </span>
        )}
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

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <div className={styles.panelTitleRow}>
          <span className={styles.summaryTime}>{timestamp}</span>
          <div className={styles.summarySpacer} />
          {(onPrev || onNext) && (
            <div className={styles.navGroup}>
              <IconButton name="angle-up" size="sm" tooltip="Previous log" onClick={onPrev} disabled={!onPrev} />
              {navLabel && <span className={styles.navLabel}>{navLabel}</span>}
              <IconButton name="angle-down" size="sm" tooltip="Next log" onClick={onNext} disabled={!onNext} />
            </div>
          )}
          {onToggleExpanded && (
            <IconButton
              name={expanded ? 'angle-double-right' : 'angle-double-left'}
              size="lg"
              tooltip={expanded ? 'Shrink' : 'Expand'}
              aria-label={expanded ? 'Shrink log detail' : 'Expand log detail'}
              onClick={onToggleExpanded}
            />
          )}
          <IconButton name="times" size="lg" tooltip="Close" aria-label="Close log detail" onClick={onClose} />
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

          {/* Flat Field | Value table — no OTel category grouping. */}
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
                  {pageRows.map((r) => renderAttrRow(r.key, r.value, r.sqlExpr, r.type))}
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
    width: 100%;
    height: 100%;
    background: ${theme.colors.background.primary};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    overflow: hidden;
    box-sizing: border-box;
  `,
  panelHeader: css`
    flex-shrink: 0;
    padding: ${theme.spacing(1.25)} ${theme.spacing(1.5)} 0;
    border-bottom: 1px solid ${theme.colors.border.weak};
  `,
  panelTitleRow: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    margin-bottom: ${theme.spacing(1)};
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
  summaryTime: css`
    font-family: ${theme.typography.fontFamilyMonospace};
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    font-variant-numeric: tabular-nums;
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
    padding: ${theme.spacing(0.5)} ${theme.spacing(1)};
    font-size: ${theme.typography.bodySmall.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.secondary};
    text-transform: uppercase;
    letter-spacing: 0.02em;
    & > span:first-of-type {
      width: 44%;
      min-width: 110px;
      flex-shrink: 0;
    }
  `,
  attrList: css``,
  attrRow: css`
    display: flex;
    align-items: flex-start;
    gap: ${theme.spacing(1.5)};
    padding: ${theme.spacing(1)};
    font-size: ${theme.typography.body.fontSize};
    line-height: 1.7;
    border-bottom: 1px solid ${theme.colors.border.weak};
    &:nth-of-type(even) {
      background: ${theme.colors.background.secondary};
    }
    &:hover {
      background: ${theme.colors.action.hover};
    }
    &:hover .attr-actions {
      opacity: 1;
    }
  `,
  attrKey: css`
    display: flex;
    align-items: flex-start;
    gap: ${theme.spacing(0.75)};
    color: ${theme.colors.text.primary};
    width: 44%;
    min-width: 110px;
    flex-shrink: 0;
    word-break: break-word;
    overflow-wrap: anywhere;
  `,
  attrTypeIcon: css`
    flex-shrink: 0;
    margin-top: 3px;
    color: ${theme.colors.text.secondary};
  `,
  attrValue: css`
    font-family: ${theme.typography.fontFamilyMonospace};
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.primary};
    word-break: break-word;
    overflow-wrap: anywhere;
    flex: 1;
  `,
  traceIdButton: css`
    display: inline-flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    font-family: ${theme.typography.fontFamilyMonospace};
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.link};
    text-decoration: underline;
    cursor: pointer;
    word-break: break-word;
    overflow-wrap: anywhere;
    flex: 1;

    &:hover {
      color: ${theme.colors.text.maxContrast};
    }
  `,
  traceIdIcon: css`
    flex-shrink: 0;
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
