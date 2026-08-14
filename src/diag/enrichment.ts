/**
 * The diagnostics drawer's ClickHouse server-side enrichment tier (Phase 2 of the diagnostics
 * plan) is off by default and toggled explicitly, not tied to the drawer's open/closed state. Two
 * reasons, both from the plan:
 *
 * 1. A `log_comment` that varies per query defeats ClickHouse's query cache, since settings
 *    participate in the cache key — enabling it is a real trade the user should make on purpose.
 * 2. Capture must happen whether or not the drawer is open, since the action you want to inspect
 *    already finished by the time you notice something was wrong and go open it. Tying enrichment
 *    to drawer visibility would mean the interesting action never got tagged in the first place.
 *
 * Sticky via localStorage so the choice survives a reload; falls back to disabled (never throws)
 * if storage is unavailable — e.g. private browsing.
 */

const STORAGE_KEY = 'chobs.diagnostics.enrichmentEnabled';

export function isEnrichmentEnabled(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setEnrichmentEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // Storage unavailable — the toggle just won't persist across reloads; not worth surfacing an
    // error for a session-scoped convenience setting.
  }
}
