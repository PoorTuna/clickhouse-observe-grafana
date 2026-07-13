/**
 * Column-mapping field metadata — pure data, no @grafana/ui import. Split out of
 * ColumnMappingForm.tsx so it can be imported from Node scripts (src/ai/columnGuess.eval.ts) that
 * don't have a browser `window` — @grafana/ui/@grafana/data pull in browser-only globals at
 * import time, which crashes under plain ts-node.
 */

import { ColumnMapping } from './types';

/** Keys that only affect the Traces page — no effect in the Logs Explorer (see each field's
 * `description` below). Hidden there via `hideTraceFields` so the Logs data-view editor isn't
 * cluttered with mappings it can't use; `traceId` is deliberately NOT in this set since it powers
 * the log→trace jump link, which IS a Logs Explorer feature. */
export const TRACE_ONLY_KEYS: ReadonlySet<keyof ColumnMapping> = new Set([
  'spanId',
  'parentSpanId',
  'duration',
  'spanName',
  'statusCode',
  'statusMessage',
  'spanKind',
  'spanAttributes',
  // Logs auto-detects Map attribute columns via field discovery now (no config needed) — this
  // mapping only still matters for the Traces span-resource-attrs select.
  'resourceAttributes',
]);

// `description` says what mapping the field actually turns on — the field name/label alone
// doesn't communicate that (this was a real source of confusion: none of this requires OTel,
// but the column names below are OTel vocabulary since that's the schema this was adapted from).
export const COL_FIELDS: Array<{
  key: keyof ColumnMapping;
  label: string;
  description: string;
  required?: boolean;
}> = [
  {
    key: 'timestamp',
    label: 'Timestamp column',
    description: 'Enables time-range filtering, sorting, and the volume histogram.',
  },
  {
    key: 'body',
    label: 'Log body / message column',
    description: 'Enables free-text search and the Message column.',
  },
  {
    key: 'severity',
    label: 'Severity / level column',
    description: 'Enables the Level column and severity breakdown in the histogram.',
  },
  {
    key: 'traceId',
    label: 'Trace ID column',
    description: 'Enables the trace-jump link in the log detail drawer (also needs Traces table set).',
  },
  {
    key: 'spanId',
    label: 'Span ID column',
    description: 'Used on the Traces page; no effect in Logs Explorer alone.',
  },
  {
    key: 'parentSpanId',
    label: 'Parent Span ID column',
    description: 'Traces page only — no effect on Logs Explorer.',
  },
  {
    key: 'serviceName',
    label: 'Service name expression (can be Map accessor)',
    description: 'Enables the Service column and service-based filtering.',
  },
  {
    key: 'duration',
    label: 'Duration column (nanoseconds)',
    description: 'Traces page only — no effect on Logs Explorer.',
  },
  {
    key: 'spanName',
    label: 'Span name / operation name column',
    description: 'Traces page only — no effect on Logs Explorer.',
  },
  {
    key: 'statusCode',
    label: 'Span status code column',
    description: 'Traces page only — no effect on Logs Explorer.',
  },
  {
    key: 'statusMessage',
    label: 'Span status message column',
    description: 'Traces page only — shown in the span detail drawer when the span has an error.',
  },
  {
    key: 'spanKind',
    label: 'Span kind column',
    description: 'Traces page only — enables the client/server/internal icon on each waterfall row.',
  },
  {
    key: 'resourceAttributes',
    label: 'Resource Attributes Map column',
    description: 'Traces page only — Logs auto-detects Map attribute columns, no mapping needed there.',
  },
  {
    key: 'spanAttributes',
    label: 'Span Attributes Map column',
    description: 'Adds a "Span Attributes" section to the log detail drawer and enables autocomplete for its keys.',
  },
];
