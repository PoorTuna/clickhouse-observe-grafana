/**
 * Turns one action's span tree into a single pasteable JSON blob — "Copy diagnostics bundle"
 * (diagnostics plan Phase 4). The point is turning a slow/broken session into one paste instead of
 * a screenshot-and-explain; redaction has to be real, not implied, since the whole reason this
 * exists is to be handed to someone else.
 *
 * Two things get redacted before anything leaves the browser:
 * 1. SourceConfig — table/database names and `extraQuerySettings` can name internal systems or
 *    carry cluster-specific detail nobody outside the team should see in a bug report.
 * 2. Every captured SQL string — a WHERE clause's literal values are exactly what the user was
 *    searching for, which can be anything (an IP, an email, a customer id).
 */
import pluginJson from '../plugin.json';
import { SourceConfig } from '../types';
import { Span } from './types';
import { computeWarnings, Warning } from './warnings';
import { stripLiterals } from './sqlIntegrity';

/**
 * Redacts every single-quoted string literal (and comment) in `sql` except a small keyword
 * allowlist of ClickHouse SETTINGS values this codebase's own query builders emit — see
 * sqlIntegrity.ts's `stripLiterals` doc comment for the allowlist and why it's shared with that
 * module's own text-level integrity checks rather than duplicated here. Keeping those specific
 * values (e.g. `timeout_overflow_mode = 'break'`) is what lets a shared bundle still show *why* a
 * query was slow (see diag/warnings.ts) instead of redacting the one detail that finding depends
 * on. Everything else quoted is user data and gets replaced unconditionally — a strict allowlist,
 * not a denylist of "things that look sensitive", precisely so nothing new slips through
 * unredacted by default.
 */
export const redactSql = stripLiterals;

/**
 * Redacts bare (unquoted) occurrences of the data view's own database/table name — `redactSql`
 * only strips quoted string literals, so `FROM internal_prod_db.customer_events` sailed through
 * untouched even though `redactConfig` was carefully stripping the same names from the config
 * object sitting right next to it. Whole-word matched so a name that happens to be a short common
 * token doesn't over-redact unrelated text.
 */
function redactIdentifiers(text: string, identifiers: readonly string[]): string {
  let out = text;
  for (const id of identifiers) {
    if (!id) {
      continue;
    }
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\b${escaped}\\b`, 'g'), '<redacted>');
  }
  return out;
}

/** Full text redaction pipeline for anything that might carry SQL or a schema name — quoted
 *  literals via `redactSql`, then bare database/table identifiers via `redactIdentifiers`. Used for
 *  every free-text field the bundle exports: query SQL, error strings, and warning messages all
 *  echo user data or schema names the same way (see the module doc comment). */
function redactText(text: string, identifiers: readonly string[]): string {
  return redactIdentifiers(redactSql(text), identifiers);
}

export interface RedactedConfig {
  isOtel: boolean;
  sequentialConsistency: boolean;
  hasExtraQuerySettings: boolean;
  hasClusterName: boolean;
  /** Which logical fields (timestamp, body, severity, …) are mapped — not what they're mapped to. */
  mappedFields: string[];
}

/** Strips everything from `config` that could name the user's own schema or infrastructure,
 *  keeping only shape/structure useful for debugging (see the module doc comment). */
export function redactConfig(config: SourceConfig): RedactedConfig {
  const mappedFields = Object.entries(config.columns)
    .filter(([, value]) => typeof value === 'string' && value.length > 0)
    .map(([key]) => key);
  return {
    isOtel: config.isOtel,
    sequentialConsistency: config.sequentialConsistency ?? true,
    hasExtraQuerySettings: Boolean(config.extraQuerySettings?.trim()),
    hasClusterName: Boolean(config.clusterName?.trim()),
    mappedFields,
  };
}

export interface RedactedSpan {
  id: string;
  parentId: string | null;
  rootId: string;
  name: string;
  kind: string;
  startMs: number;
  endMs: number | null;
  durationMs: number | null;
  status: string;
  error?: string;
  attrs: Record<string, unknown>;
  children: RedactedSpan[];
}

// Attrs whose value is free text that can carry the same user data / schema names as `sql` —
// `serverException` is ClickHouse's own `system.query_log.exception` column (diag/autoEnrich.ts),
// which routinely echoes the failing query verbatim, exactly like a client-side error string does.
const TEXT_ATTR_KEYS = new Set(['sql', 'executedSql', 'serverException']);

function redactSpan(span: Span, identifiers: readonly string[]): RedactedSpan {
  const attrs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(span.attrs)) {
    attrs[key] = TEXT_ATTR_KEYS.has(key) && typeof value === 'string' ? redactText(value, identifiers) : value;
  }
  return {
    id: span.id,
    parentId: span.parentId,
    rootId: span.rootId,
    name: span.name,
    kind: span.kind,
    startMs: span.startMs,
    endMs: span.endMs,
    durationMs: span.endMs != null ? span.endMs - span.startMs : null,
    status: span.status,
    // span.error is formatDataQueryError's output (runQuery.ts) — for a ClickHouse exception this
    // routinely echoes the failing query back verbatim (e.g. "...while processing query: 'SELECT
    // ... WHERE body LIKE '%someone@example.com%''"), so it needs the same redaction as sql/
    // executedSql, not a pass-through. See the module doc comment.
    error: span.error ? redactText(span.error, identifiers) : span.error,
    attrs,
    children: span.children.map((child) => redactSpan(child, identifiers)),
  };
}

/** Same redaction as `redactSpan`'s `error` field, for warnings.ts's `Warning.message` — several
 *  of those messages embed `span.error` or ClickHouse's own exception text verbatim (see
 *  warnings.ts's serverException and FAILED findings), so they carry the identical leak risk. */
function redactWarning(warning: Warning, identifiers: readonly string[]): Warning {
  return { ...warning, message: redactText(warning.message, identifiers) };
}

export interface DiagnosticsBundle {
  generatedAt: string;
  pluginVersion: string;
  root: RedactedSpan;
  warnings: Warning[];
  config: RedactedConfig;
}

export function buildDiagnosticsBundle(root: Span, config: SourceConfig): DiagnosticsBundle {
  // The database/table names redactConfig strips from the config object are the same names that
  // can appear unquoted inside SQL text (FROM/JOIN) or an echoed-back error string — redact them
  // there too rather than only in the structured config field sitting next to it.
  const identifiers = [config.database, config.logsTable].filter((s): s is string => Boolean(s && s.trim()));
  return {
    generatedAt: new Date().toISOString(),
    pluginVersion: pluginJson.info.version,
    root: redactSpan(root, identifiers),
    warnings: computeWarnings(root).map((w) => redactWarning(w, identifiers)),
    config: redactConfig(config),
  };
}
