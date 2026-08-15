/**
 * The single diagnostics entry point — one Drawer, an activity rail on the left, Timeline/Queries
 * tabs on the right. Deliberately not per-surface chips (see the diagnostics plan's "One entry
 * point, not per-surface chips" section): Grafana's own panel inspector is one entry with tabs
 * inside, and that's the precedent this follows.
 *
 * Live behaviour: the rail defaults to "Following" — a new root pushes to the top and the
 * timeline switches to it automatically. Clicking an older entry pins the view; selecting the
 * newest entry (or the Live toggle) resumes following. See the plan's "Live behaviour while the
 * drawer is open" section for the full reasoning.
 */
import React, { useContext, useEffect, useMemo, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { ClipboardButton, Drawer, Icon, IconButton, Switch, Tab, TabsBar, useStyles2 } from '@grafana/ui';
import { useDiagnostics } from '../../diag/DiagContext';
import { Span, SpanStatus } from '../../diag/types';
import { spanDurationMs } from '../../diag/formatDuration';
import { treeEndMs } from '../../diag/spanTree';
import { useLiveNow } from '../../diag/useLiveNow';
import { computeWarnings, Warning } from '../../diag/warnings';
import { isEnrichmentEnabled, setEnrichmentEnabled } from '../../diag/enrichment';
import { buildDiagnosticsBundle } from '../../diag/bundle';
import { clearRoots } from '../../diag/tracer';
import { SourceConfigContext } from '../App/App';
import { Waterfall } from './Waterfall';
import { PhaseBreakdown } from './PhaseBreakdown';
import { ActionSummary } from './ActionSummary';
import { QueryList } from './QueryList';
import { WarningsList } from './WarningsList';
import { StatsTable } from './StatsTable';
import { DiagEmptyState } from './DiagEmptyState';
import { labelForKind } from './phaseColors';

type DrawerTab = 'warnings' | 'timeline' | 'queries' | 'stats';

interface RailGroup {
  key: string;
  name: string;
  /** The run's most recent member — what a click on a collapsed group actually selects. Reaching
   *  an older member of a fully healthy run isn't worth an expand affordance: they're identical in
   *  every way that matters (same query, same outcome), which is exactly why they collapsed. */
  newest: Span;
  count: number;
}

/**
 * Collapses a run of consecutive, healthy, same-named rail entries into one row — see the
 * diagnostics plan's "auto-refresh floods the rail" note, generalized past just auto-refresh:
 * rapid typing in the search bar fires one independent `logs` root per debounced keystroke (they
 * don't share an action — see LogsExplorer.tsx's actionRef doc comment on why those effects are
 * deliberately left ungrouped), and untreated that floods the rail exactly the way repeated
 * auto-refresh ticks would. A run breaks the moment a member isn't `ok` or carries a warning —
 * those always get their own row, since they're the ones worth looking at individually.
 *
 * `warningCountOf` is injected rather than calling computeWarnings itself (see B6): the drawer
 * already computes warnings once per root per tracer version for the rail/content — recomputing
 * them a second time here, on every render, was a real perf finding (~40 tree+regex scans per
 * notify with a full 20-root buffer, during exactly the burst of activity being traced).
 */
function groupRailItems(items: readonly Span[], warningCountOf: (root: Span) => number): RailGroup[] {
  const groups: RailGroup[] = [];
  let runIsBoring = false;
  for (const root of items) {
    const boring = root.status === 'ok' && warningCountOf(root) === 0;
    const last = groups[groups.length - 1];
    if (boring && runIsBoring && last && last.name === root.name) {
      last.count += 1;
    } else {
      groups.push({ key: root.id, name: root.name, newest: root, count: 1 });
    }
    runIsBoring = boring;
  }
  return groups;
}

/** "2m ago"-style relative time, diffed on the same performance.now() timeline as span timestamps
 *  themselves (see tracer.ts's nowMs()) rather than wall-clock Date.now() — the two share a clock
 *  with `now`/`root.startMs` already in scope, so this needs no separate impure time read. */
function relativeTime(startMs: number, now: number): string {
  const diffMs = Math.max(0, now - startMs);
  if (diffMs < 1000) {
    return 'just now';
  }
  if (diffMs < 60000) {
    return `${Math.round(diffMs / 1000)}s ago`;
  }
  if (diffMs < 3600000) {
    return `${Math.round(diffMs / 60000)}m ago`;
  }
  return `${Math.round(diffMs / 3600000)}h ago`;
}

interface DiagnosticsDrawerProps {
  onClose: () => void;
}

export function DiagnosticsDrawer({ onClose }: DiagnosticsDrawerProps) {
  const styles = useStyles2(getStyles);
  const { roots, version } = useDiagnostics();
  const config = useContext(SourceConfigContext);
  const [activeTab, setActiveTab] = useState<DrawerTab>('timeline');
  const [following, setFollowing] = useState(true);
  const [selectedRootId, setSelectedRootId] = useState<string | null>(null);
  // Local mirror of the sticky localStorage toggle (diag/enrichment.ts) — that module isn't itself
  // reactive, so this component owns the piece of state React needs to re-render the Switch and
  // the StatsTable's "off" empty-state when the user flips it.
  const [enrichmentEnabled, setEnrichmentEnabledState] = useState(() => isEnrichmentEnabled());

  // roots is oldest-first (tracer.ts's ring buffer); the rail displays newest-first.
  const railItems = useMemo(() => [...roots].reverse(), [roots]);
  const latest = roots[roots.length - 1];
  // Single shared tick for every rail row's live duration — see useLiveNow's doc comment for why
  // this can't just call performance.now() during render.
  const anyRunning = roots.some((r) => r.status === 'running');
  const now = useLiveNow(anyRunning);

  // B6: one computeWarnings pass per root per tracer version, not one per root per render (the
  // rail previously called it again inside every RailItem, and the drawer re-renders on every
  // span mutation — create, end, attr-set — plus every useLiveNow tick while anything runs).
  // `roots` is included for correctness (clearRoots() reassigns the array reference) even though
  // `version` is what actually signals a content change in the common case.
  const warningsByRootId = useMemo(() => {
    const map = new Map<string, Warning[]>();
    for (const root of roots) {
      map.set(root.id, computeWarnings(root));
    }
    return map;
    // `roots` is a plain array mutated in place by the tracer (see tracer.ts) — its reference only
    // changes on clearRoots(), so `version` (bumped on every span mutation) is the real recompute
    // signal here even though it isn't read in the body directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roots, version]);
  const warningsFor = (root: Span): Warning[] => warningsByRootId.get(root.id) ?? [];

  const railGroups = useMemo(
    () => groupRailItems(railItems, (root) => warningsByRootId.get(root.id)?.length ?? 0),
    [railItems, warningsByRootId]
  );
  const maxDuration = Math.max(
    1,
    ...railGroups.map((g) => spanDurationMs(g.newest.startMs, treeEndMs(g.newest), now))
  );

  useEffect(() => {
    if (following) {
      // Syncing local selection state to the external tracer store's latest root — same
      // "subscribe to an external system" shape as useLiveNow, not state derived from props.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedRootId(latest?.id ?? null);
    }
    // Deliberately keyed on latest?.id, not `following` alone — a version bump on the *selected*
    // root (e.g. a child span ending) must not re-trigger this and fight a user who just pinned.
  }, [following, latest?.id]);

  const selected = roots.find((r) => r.id === selectedRootId) ?? latest;
  const selectedWarnings = selected ? warningsFor(selected) : [];

  function selectRoot(root: Span): void {
    if (root.id === latest?.id) {
      setFollowing(true);
    } else {
      setFollowing(false);
    }
    setSelectedRootId(root.id);
  }

  return (
    <Drawer
      title="Inspect"
      subtitle="Query timings, SQL, and warnings for recent actions in this session."
      size="lg"
      onClose={onClose}
      tabs={
        <TabsBar>
          {/* Warnings & Errors first — leftmost, per the diagnostics plan's "ranked above
              Timeline": this tab is the reason to open the drawer even when nothing feels slow. */}
          <Tab
            label="Warnings & Errors"
            active={activeTab === 'warnings'}
            onChangeTab={() => setActiveTab('warnings')}
            counter={selectedWarnings.length || null}
          />
          <Tab label="Timeline" active={activeTab === 'timeline'} onChangeTab={() => setActiveTab('timeline')} />
          <Tab label="Queries" active={activeTab === 'queries'} onChangeTab={() => setActiveTab('queries')} />
          <Tab label="Stats" active={activeTab === 'stats'} onChangeTab={() => setActiveTab('stats')} />
        </TabsBar>
      }
    >
      <div className={styles.layout}>
        <div className={styles.rail}>
          <div className={styles.railHeader}>
            <span>Activity</span>
            <div className={styles.railHeaderActions}>
              <IconButton
                name="trash-alt"
                tooltip="Clear activity history — does not affect the page, only this drawer's memory"
                onClick={() => {
                  clearRoots();
                  setSelectedRootId(null);
                }}
                aria-label="Clear activity history"
              />
              <IconButton
                name={following ? 'sync' : 'gf-pin'}
                tooltip={following ? 'Following — click to pin the current selection' : 'Pinned — click to follow again'}
                onClick={() => setFollowing((f) => !f)}
                aria-label={following ? 'Stop following new activity' : 'Follow new activity'}
              />
            </div>
          </div>
          {railItems.length === 0 ? (
            <div className={styles.railEmpty}>Nothing recorded yet — run a search to see it here.</div>
          ) : (
            <ul className={styles.railList}>
              {railGroups.map((group) => (
                <RailItem
                  key={group.key}
                  root={group.newest}
                  count={group.count}
                  now={now}
                  maxDuration={maxDuration}
                  hasWarnings={warningsFor(group.newest).length > 0}
                  selected={group.newest.id === selected?.id}
                  onSelect={() => selectRoot(group.newest)}
                />
              ))}
            </ul>
          )}
          <div className={styles.railFooter}>
            <label
              className={styles.enrichmentToggle}
              title="Tags every query with a correlation id and looks up its real ClickHouse execution stats. Costs one extra query per batch of finished actions and defeats ClickHouse's query cache while on (settings are part of the cache key) — off by default."
            >
              <Switch
                value={enrichmentEnabled}
                onChange={(e) => {
                  const next = e.currentTarget.checked;
                  setEnrichmentEnabled(next);
                  setEnrichmentEnabledState(next);
                }}
              />
              <span>Server-side stats</span>
            </label>
          </div>
        </div>
        <div className={styles.content}>
          {!selected ? (
            <DiagEmptyState icon="info-circle" title="Select an action on the left" />
          ) : (
            <>
              <ActionSummary
                root={selected}
                action={
                  <ClipboardButton
                    size="sm"
                    variant="secondary"
                    icon="copy"
                    getText={() => JSON.stringify(buildDiagnosticsBundle(selected, config), null, 2)}
                    tooltip="Copies a redacted JSON bundle — span tree, timings, SQL, warnings, and stats for this action. Table/database names, extraQuerySettings, and SQL literal values are stripped."
                  >
                    Copy diagnostics bundle
                  </ClipboardButton>
                }
              />
              {activeTab === 'warnings' ? (
                <WarningsList warnings={selectedWarnings} />
              ) : activeTab === 'timeline' ? (
                <>
                  <PhaseBreakdown root={selected} />
                  <Waterfall root={selected} />
                </>
              ) : activeTab === 'queries' ? (
                <QueryList root={selected} />
              ) : (
                <StatsTable root={selected} />
              )}
            </>
          )}
        </div>
      </div>
    </Drawer>
  );
}

function RailItem({
  root,
  count,
  now,
  maxDuration,
  hasWarnings,
  selected,
  onSelect,
}: {
  root: Span;
  count: number;
  now: number;
  maxDuration: number;
  hasWarnings: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const styles = useStyles2(getStyles);
  const duration = spanDurationMs(root.startMs, treeEndMs(root), now);
  const barPct = Math.min(100, Math.round((duration / maxDuration) * 100));
  const startedAt = typeof root.attrs.startedAt === 'number' ? new Date(root.attrs.startedAt) : null;
  const isBackground = root.kind !== 'action';
  // Rail names are read by anyone opening this drawer, not just whoever wrote the tracer — a raw
  // op string like 'jsonPaths' or 'traceLink' is an internal identifier, not a name. See
  // phaseColors.ts's QUERY_OP_LABELS.
  const label = labelForKind(root.kind, root.name);
  return (
    <li>
      <button
        type="button"
        className={selected ? `${styles.railItem} ${styles.railItemSelected}` : styles.railItem}
        onClick={onSelect}
        title={
          count > 1
            ? `${count}× ${label} — showing the most recent; all were healthy`
            : startedAt
              ? `${label} — ${startedAt.toLocaleTimeString()}`
              : label
        }
      >
        <StatusIcon status={root.status} hasWarnings={hasWarnings} />
        {isBackground && (
          <Icon name="sync" size="xs" className={styles.railItemBgGlyph} title="Background — no user gesture behind it" />
        )}
        <span className={styles.railItemBody}>
          <span className={styles.railItemTopRow}>
            <span className={styles.railItemName}>{label}</span>
            {count > 1 && <span className={styles.railItemCount}>×{count}</span>}
            <span className={styles.railItemDuration}>{formatDurationShort(duration)}</span>
          </span>
          <span className={styles.railItemBottomRow}>
            <span className={styles.railItemBar}>
              <span className={styles.railItemBarFill} style={{ width: `${barPct}%` }} />
            </span>
            <span className={styles.railItemTime}>{relativeTime(root.startMs, now)}</span>
          </span>
        </span>
      </button>
    </li>
  );
}

// Local, not formatDuration.ts's formatDurationMs, to keep the rail's already-tight row width — no
// import needed beyond what this file already touches for the ms/s distinction.
function formatDurationShort(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function StatusIcon({ status, hasWarnings }: { status: SpanStatus; hasWarnings: boolean }) {
  const styles = useStyles2(getStyles);
  if (status === 'error') {
    return <Icon name="exclamation-triangle" size="xs" className={styles.dotError} />;
  }
  if (status === 'cancelled') {
    return <Icon name="minus-circle" size="xs" className={styles.dotCancelled} />;
  }
  if (status === 'running') {
    return <Icon name="circle-mono" size="xs" className={styles.dotRunning} />;
  }
  if (hasWarnings) {
    return <Icon name="exclamation-triangle" size="xs" className={styles.dotWarning} />;
  }
  return <Icon name="check-circle" size="xs" className={styles.dotOk} />;
}

const getStyles = (theme: GrafanaTheme2) => ({
  layout: css`
    display: flex;
    height: 100%;
    gap: ${theme.spacing(2)};
  `,
  rail: css`
    width: 240px;
    flex-shrink: 0;
    border-right: 1px solid ${theme.colors.border.weak};
    padding-right: ${theme.spacing(2)};
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
  `,
  railHeader: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
  `,
  railHeaderActions: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
  `,
  railEmpty: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
    padding: ${theme.spacing(1)} 0;
  `,
  railList: css`
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.25)};
    overflow-y: auto;
    flex: 1;
  `,
  railFooter: css`
    border-top: 1px solid ${theme.colors.border.weak};
    padding-top: ${theme.spacing(1)};
  `,
  enrichmentToggle: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    cursor: pointer;
  `,
  railItem: css`
    display: flex;
    align-items: flex-start;
    gap: ${theme.spacing(0.75)};
    width: 100%;
    background: transparent;
    border: none;
    border-left: 3px solid transparent;
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(0.75)};
    padding-left: ${theme.spacing(0.5)};
    cursor: pointer;
    text-align: left;
    &:hover {
      background: ${theme.colors.action.hover};
    }
  `,
  railItemSelected: css`
    background: ${theme.colors.action.selected};
    border-left-color: ${theme.colors.primary.border};
  `,
  railItemBgGlyph: css`
    color: ${theme.colors.text.disabled};
    flex-shrink: 0;
    margin-top: 2px;
  `,
  railItemBody: css`
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.25)};
  `,
  railItemTopRow: css`
    display: flex;
    align-items: baseline;
    gap: ${theme.spacing(0.5)};
  `,
  railItemName: css`
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  railItemCount: css`
    font-family: ${theme.typography.fontFamilyMonospace};
    font-variant-numeric: tabular-nums;
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.disabled};
    flex-shrink: 0;
  `,
  railItemDuration: css`
    font-family: ${theme.typography.fontFamilyMonospace};
    font-variant-numeric: tabular-nums;
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    flex-shrink: 0;
  `,
  railItemBottomRow: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.75)};
  `,
  railItemBar: css`
    position: relative;
    flex: 1;
    height: 3px;
    background: ${theme.colors.background.secondary};
    border-radius: 2px;
    overflow: hidden;
  `,
  railItemBarFill: css`
    display: block;
    height: 100%;
    background: ${theme.colors.text.disabled};
    border-radius: 2px;
  `,
  railItemTime: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.disabled};
    flex-shrink: 0;
  `,
  content: css`
    flex: 1;
    min-width: 0;
    overflow-y: auto;
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
  dotWarning: css`
    color: ${theme.colors.warning.text};
  `,
});
