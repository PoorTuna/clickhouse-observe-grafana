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
import React, { useContext, useEffect, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { ClipboardButton, Drawer, Icon, IconButton, Switch, Tab, TabsBar, useStyles2 } from '@grafana/ui';
import { useDiagnostics } from '../../diag/DiagContext';
import { Span, SpanStatus } from '../../diag/types';
import { formatDurationMs, spanDurationMs } from '../../diag/formatDuration';
import { useLiveNow } from '../../diag/useLiveNow';
import { computeWarnings } from '../../diag/warnings';
import { isEnrichmentEnabled, setEnrichmentEnabled } from '../../diag/enrichment';
import { buildDiagnosticsBundle } from '../../diag/bundle';
import { SourceConfigContext } from '../App/App';
import { Waterfall } from './Waterfall';
import { QueryList } from './QueryList';
import { WarningsList } from './WarningsList';
import { StatsTable } from './StatsTable';

type DrawerTab = 'warnings' | 'timeline' | 'queries' | 'stats';

interface DiagnosticsDrawerProps {
  onClose: () => void;
}

export function DiagnosticsDrawer({ onClose }: DiagnosticsDrawerProps) {
  const styles = useStyles2(getStyles);
  const { roots } = useDiagnostics();
  const config = useContext(SourceConfigContext);
  const [activeTab, setActiveTab] = useState<DrawerTab>('timeline');
  const [following, setFollowing] = useState(true);
  const [selectedRootId, setSelectedRootId] = useState<string | null>(null);
  // Local mirror of the sticky localStorage toggle (diag/enrichment.ts) — that module isn't itself
  // reactive, so this component owns the piece of state React needs to re-render the Switch and
  // the StatsTable's "off" empty-state when the user flips it.
  const [enrichmentEnabled, setEnrichmentEnabledState] = useState(() => isEnrichmentEnabled());

  // roots is oldest-first (tracer.ts's ring buffer); the rail displays newest-first.
  const railItems = [...roots].reverse();
  const latest = roots[roots.length - 1];
  // Single shared tick for every rail row's live duration — see useLiveNow's doc comment for why
  // this can't just call performance.now() during render.
  const anyRunning = roots.some((r) => r.status === 'running');
  const now = useLiveNow(anyRunning);

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
  const selectedWarnings = selected ? computeWarnings(selected) : [];

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
      title={
        <div className={styles.titleRow}>
          <span>Inspect</span>
          {selected && (
            <ClipboardButton
              size="sm"
              variant="secondary"
              icon="copy"
              disabled={!selected}
              getText={() => JSON.stringify(buildDiagnosticsBundle(selected, config), null, 2)}
              tooltip="Copies a redacted JSON bundle — span tree, timings, SQL, warnings, and stats for this action. Table/database names, extraQuerySettings, and SQL literal values are stripped — see the diagnostics plan's redaction policy."
            >
              Copy diagnostics bundle
            </ClipboardButton>
          )}
        </div>
      }
      subtitle="Query timings, SQL, and warnings for recent actions in this session."
      size="lg"
      onClose={onClose}
      tabs={
        <TabsBar>
          {/* Warnings first — leftmost, per the diagnostics plan's "ranked above Timeline": this
              tab is the reason to open the drawer even when nothing feels slow. */}
          <Tab
            label="Warnings"
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
            <IconButton
              name={following ? 'sync' : 'gf-pin'}
              tooltip={following ? 'Following — click to pin the current selection' : 'Pinned — click to follow again'}
              onClick={() => setFollowing((f) => !f)}
              aria-label={following ? 'Stop following new activity' : 'Follow new activity'}
            />
          </div>
          {railItems.length === 0 ? (
            <div className={styles.railEmpty}>Nothing recorded yet — run a search to see it here.</div>
          ) : (
            <ul className={styles.railList}>
              {railItems.map((root) => (
                <RailItem key={root.id} root={root} now={now} selected={root.id === selected?.id} onSelect={() => selectRoot(root)} />
              ))}
            </ul>
          )}
          <div className={styles.railFooter}>
            <label className={styles.enrichmentToggle} title="Tags every query with a correlation id and looks up its real ClickHouse execution stats. Costs one extra query per action and defeats ClickHouse's query cache while on (settings are part of the cache key) — off by default.">
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
            <div className={styles.railEmpty}>Select an action on the left.</div>
          ) : activeTab === 'warnings' ? (
            <WarningsList warnings={selectedWarnings} />
          ) : activeTab === 'timeline' ? (
            <Waterfall root={selected} />
          ) : activeTab === 'queries' ? (
            <QueryList root={selected} />
          ) : (
            <StatsTable root={selected} />
          )}
        </div>
      </div>
    </Drawer>
  );
}

function RailItem({
  root,
  now,
  selected,
  onSelect,
}: {
  root: Span;
  now: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const styles = useStyles2(getStyles);
  const duration = spanDurationMs(root.startMs, root.endMs, now);
  // Cheap enough per row (small trees, regex over short SQL strings) — a root that finished 'ok'
  // but has warnings still deserves a visual difference from one with nothing to say, so the rail
  // itself hints "look here" without opening every entry.
  const hasWarnings = root.status !== 'running' && computeWarnings(root).length > 0;
  return (
    <li>
      <button type="button" className={selected ? `${styles.railItem} ${styles.railItemSelected}` : styles.railItem} onClick={onSelect}>
        <StatusIcon status={root.status} hasWarnings={hasWarnings} />
        <span className={styles.railItemName} title={root.name}>
          {root.name}
        </span>
        <span className={styles.railItemDuration}>{formatDurationMs(duration)}</span>
      </button>
    </li>
  );
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
  titleRow: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: ${theme.spacing(2)};
    width: 100%;
  `,
  layout: css`
    display: flex;
    height: 100%;
    gap: ${theme.spacing(2)};
  `,
  rail: css`
    width: 220px;
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
    text-transform: uppercase;
    letter-spacing: 0.02em;
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
    align-items: center;
    gap: ${theme.spacing(0.75)};
    width: 100%;
    background: transparent;
    border: none;
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(0.75)};
    cursor: pointer;
    text-align: left;
    &:hover {
      background: ${theme.colors.action.hover};
    }
  `,
  railItemSelected: css`
    background: ${theme.colors.action.selected};
  `,
  railItemName: css`
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  railItemDuration: css`
    font-family: ${theme.typography.fontFamilyMonospace};
    font-variant-numeric: tabular-nums;
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
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
