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
 * Joins a query's body lines with a single trailing `SETTINGS` clause built from `fragments`
 * (e.g. a builder's own guardrails followed by configSettingsFragments(config)) — later entries
 * win on key collision, so a builder should list its own defaults first and config-derived
 * fragments last if config is meant to be able to override them.
 *
 * Two `SETTINGS` clauses in one query is a syntax error, so every builder must route its output
 * through this instead of appending its own `SETTINGS ...` line directly.
 */
export function withSettings(lines: Array<string | null | undefined | false>, fragments: string[]): string {
  const body = lines.filter((l): l is string => Boolean(l));

  const merged = new Map<string, string>();
  for (const fragment of fragments) {
    merged.set(settingKey(fragment), fragment);
  }

  if (merged.size === 0) {
    return body.join('\n');
  }
  return [...body, `SETTINGS ${[...merged.values()].join(', ')}`].join('\n');
}
