/**
 * Config-derived ClickHouse `SETTINGS` for every query issued against a data view, merged with
 * each query builder's own execution guardrails into a single trailing `SETTINGS` clause.
 *
 * Exists because a round-robin load balancer (e.g. an OpenShift Route in front of a multi-replica
 * cluster) can send two queries from the same user action to two different replicas. If one of
 * them hasn't caught up yet, a point lookup can miss a row that the list query it followed just
 * showed — see select_sequential_consistency below. The list query (buildLogsQuery) previously
 * emitted no SETTINGS at all, so it and the detail-row query it feeds could disagree on
 * consistency; every builder now goes through withSettings so that can't drift again.
 */

import { SourceConfig } from '../types';

/** Key of a `key = value` SETTINGS fragment, used to dedupe on collision. */
function settingKey(fragment: string): string {
  return fragment.split('=')[0].trim();
}

/**
 * Config-derived SETTINGS fragments for every query issued against `config`'s view.
 *
 * select_sequential_consistency = 1 makes whichever replica answers a query check Keeper and
 * catch up to the latest committed block first, instead of answering from whatever it happens to
 * have locally. Every replica still serves traffic — this doesn't disable load balancing, it just
 * stops a lagging replica from silently serving a stale (or missing) answer. Costs one Keeper
 * round-trip per query; a replica that's stalled hard enough errors instead of lying.
 *
 * `config.sequentialConsistency` is `undefined` for views persisted before this setting existed —
 * treated as enabled (`?? true`) so existing multi-replica users get the fix without re-saving.
 */
export function configSettingsFragments(config: SourceConfig): string[] {
  const fragments: string[] = [];
  if (config.sequentialConsistency ?? true) {
    fragments.push('select_sequential_consistency = 1');
  }
  for (const raw of (config.extraQuerySettings ?? '').split(',')) {
    const fragment = raw.trim();
    if (fragment) {
      fragments.push(fragment);
    }
  }
  return fragments;
}

/**
 * Single query-timeout budget shared by every query builder in this codebase (buildLogsQuery,
 * buildVolumeQuery, buildLogDetailQuery, buildMapKeysQuery/buildJsonPathsQuery) — see
 * queryTimeoutFragments below for why one number replaced the old 60s/15s/10s per-query-class
 * spread. 25s sits below a typical reverse-proxy's own hard timeout (e.g. a 30s OpenShift Route),
 * so ClickHouse's own `max_execution_time` throw wins the race instead of the proxy killing the
 * connection first and Grafana surfacing an opaque 502/504 — the 5s of headroom covers
 * proxy/queue overhead that this wall-clock cap alone doesn't see.
 */
export const DEFAULT_QUERY_TIMEOUT_SECONDS = 25;

/**
 * `max_execution_time` + `timeout_overflow_mode = 'throw'` for `config`'s view, using
 * `config.queryTimeoutSeconds` if set, else DEFAULT_QUERY_TIMEOUT_SECONDS. The 60/15/10s spread
 * this replaced across DISCOVERY_SETTINGS/VOLUME_QUERY_SETTINGS/DETAIL_QUERY_SETTINGS (and
 * buildLogsQuery, which previously had no cap at all) was drift, not policy — and the 60s values
 * were exactly the ones that outlived a 30s proxy timeout. Each call site keeps its own doc
 * comment on *why* it throws on timeout; only the number now comes from here.
 */
export function queryTimeoutFragments(config: SourceConfig): string[] {
  const seconds = config.queryTimeoutSeconds ?? DEFAULT_QUERY_TIMEOUT_SECONDS;
  return [`max_execution_time = ${seconds}`, `timeout_overflow_mode = 'throw'`];
}

/**
 * Setting keys that govern what happens when a query hits a scan/row/time cap:
 * `'break'`/`'any'` truncate a result silently, `'throw'` fails loudly. Every builder in this file
 * deliberately picks `'throw'` and documents at length why (see `VOLUME_QUERY_SETTINGS` in
 * queryBuilder.ts, whose comment walks through exactly how a `'break'`-truncated histogram reports
 * "a confidently wrong answer instead of a visibly incomplete one"). That is a correctness
 * decision the builder makes for its own query, not a tunable default — so unlike every other
 * setting, a later (config-derived) fragment for one of these keys must never silently win.
 *
 * `withSettings` enforces this by treating whichever fragment for one of these keys appears
 * *first* in `fragments` as final — see below. Every call site in this codebase passes its own
 * guardrails before `configSettingsFragments(config)`, so "first wins" here means "the builder
 * wins," without `withSettings` needing to know which array a fragment structurally came from.
 */
const BUILDER_OWNED_SETTINGS = new Set([
  'timeout_overflow_mode',
  'read_overflow_mode',
  'result_overflow_mode',
  'group_by_overflow_mode',
]);

/**
 * Joins a query's body lines with a single trailing `SETTINGS` clause built from `fragments`
 * (e.g. a builder's own guardrails followed by configSettingsFragments(config)) — later entries
 * win on key collision, so a builder should list its own defaults first and config-derived
 * fragments last if config is meant to be able to override them. The one exception is
 * `BUILDER_OWNED_SETTINGS` above, where the first (builder) value always wins regardless of order,
 * because letting config override those specific keys reintroduces silent data loss.
 *
 * Two `SETTINGS` clauses in one query is a syntax error, so every builder must route its output
 * through this instead of appending its own `SETTINGS ...` line directly.
 *
 * This used to also default `timeout_before_checking_execution_speed` to 0 whenever
 * `max_execution_time` was present, on the theory that ClickHouse's own default of 10 for that
 * setting granted every capped query ~10s of extra grace before `max_execution_time` started being
 * enforced. Measured against a live server (CH 26.3.17.4): false — `max_execution_time = 3` fires
 * at 3.00s with or without `timeout_before_checking_execution_speed` set. That setting governs
 * `min_execution_speed` checking, not whether/when the timeout itself is enforced, so the
 * injection was a no-op dressed up as a fix. Removed; `max_execution_time` alone is the real cap.
 */
export function withSettings(lines: Array<string | null | undefined | false>, fragments: string[]): string {
  const body = lines.filter((l): l is string => Boolean(l));

  const merged = new Map<string, string>();
  for (const fragment of fragments) {
    const key = settingKey(fragment);
    if (BUILDER_OWNED_SETTINGS.has(key) && merged.has(key)) {
      // A builder guardrail for this key already won — refuse the later (config) override rather
      // than let it silently reinstate a truncate-instead-of-fail data-loss mode. This is the only
      // key class where "first wins" instead of "last wins".
      continue;
    }
    merged.set(key, fragment);
  }

  if (merged.size === 0) {
    return body.join('\n');
  }
  return [...body, `SETTINGS ${[...merged.values()].join(', ')}`].join('\n');
}
