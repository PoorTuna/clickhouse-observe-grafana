/**
 * Column-mapping field metadata — pure data, no @grafana/ui import. Split out of
 * ColumnMappingForm.tsx so it can be imported from Node scripts (src/ai/columnGuess.eval.ts) that
 * don't have a browser `window` — @grafana/ui/@grafana/data pull in browser-only globals at
 * import time, which crashes under plain ts-node.
 */

import { ColumnMapping } from './types';

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
    description: 'Enables the "open trace in Explore" link on the trace ID in the log detail drawer.',
  },
  {
    key: 'serviceName',
    label: 'Service name expression (can be Map accessor)',
    description: 'Enables the Service column and service-based filtering.',
  },
  {
    key: 'spanAttributes',
    label: 'Span Attributes Map column',
    description: 'Adds a "Span Attributes" section to the log detail drawer and enables autocomplete for its keys.',
  },
];
