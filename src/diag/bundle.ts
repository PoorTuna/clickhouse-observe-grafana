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

/**
 * SETTINGS-clause keyword values kept even under redaction — a small, fixed, non-exhaustive set of
 * ClickHouse enum values this codebase's own query builders emit (see sql/queryBuilder.ts,
 * sql/settings.ts), never user-entered data. Keeping them is what lets a shared bundle still show
 * *why* a query was slow (e.g. `timeout_overflow_mode = 'break'` — see diag/warnings.ts) instead of
 * redacting the one detail that finding depends on. Everything else quoted is user data and gets
 * replaced unconditionally — this is a strict allowlist, not a denylist of "things that look
 * sensitive", precisely so nothing new slips through unredacted by default.
 */
const SAFE_STRING_LITERALS = new Set(['throw', 'break', 'any', 'browser', 'dashboard', 'sql', 'Table']);

const STRING_LITERAL_RE = /'((?:[^'\\]|\\.)*)'/g;

/** Redacts every single-quoted string literal in `sql` except the small keyword allowlist above. */
export function redactSql(sql: string): string {
  return sql.replace(STRING_LITERAL_RE, (match, inner: string) =>
    SAFE_STRING_LITERALS.has(inner) ? match : `'<redacted>'`
  );
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

function redactSpan(span: Span): RedactedSpan {
  const attrs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(span.attrs)) {
    attrs[key] = (key === 'sql' || key === 'executedSql') && typeof value === 'string' ? redactSql(value) : value;
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
    error: span.error,
    attrs,
    children: span.children.map(redactSpan),
  };
}

export interface DiagnosticsBundle {
  generatedAt: string;
  pluginVersion: string;
  root: RedactedSpan;
  warnings: Warning[];
  config: RedactedConfig;
}

export function buildDiagnosticsBundle(root: Span, config: SourceConfig): DiagnosticsBundle {
  return {
    generatedAt: new Date().toISOString(),
    pluginVersion: pluginJson.info.version,
    root: redactSpan(root),
    warnings: computeWarnings(root),
    config: redactConfig(config),
  };
}
