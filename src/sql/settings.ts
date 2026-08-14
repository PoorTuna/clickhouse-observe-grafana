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
 * Every guardrail in this codebase pairs `max_execution_time` with `timeout_overflow_mode =
 * 'throw'`, on the assumption that a query is interrupted at N seconds. It isn't: ClickHouse's
 * default `timeout_before_checking_execution_speed = 10` grants a query 10s of grace before
 * `max_execution_time` starts being enforced at all, so e.g. `DETAIL_QUERY_SETTINGS`'s "10 second
 * cap" (queryBuilder.ts) was really an ~20 second cap. If `max_execution_time` is present and
 * nothing (builder or config) already set `timeout_before_checking_execution_speed` explicitly,
 * default it to 0 here so the advertised cap is the real, wall-clock one. An explicit fragment —
 * from a builder or from a user's `extraQuerySettings` — still wins, since this only fills a gap.
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

  if (merged.has('max_execution_time') && !merged.has('timeout_before_checking_execution_speed')) {
    merged.set('timeout_before_checking_execution_speed', 'timeout_before_checking_execution_speed = 0');
  }

  if (merged.size === 0) {
    return body.join('\n');
  }
  return [...body, `SETTINGS ${[...merged.values()].join(', ')}`].join('\n');
}
