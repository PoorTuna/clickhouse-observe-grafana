import pluginJson from './plugin.json';

export const PLUGIN_BASE_URL = `/a/${pluginJson.id}`;

export enum ROUTES {
  Logs = 'logs',
  Traces = 'traces',
}

// EUI colorblind-safe viz palette (Kibana-style — calmer than pure RGB)
export const SEVERITY_COLORS: Record<string, string> = {
  critical:    '#BD271E',
  fatal:       '#BD271E',
  error:       '#E7664C',
  err:         '#E7664C',
  warn:        '#D6BF57',
  warning:     '#D6BF57',
  info:        '#54B399',
  information: '#54B399',
  debug:       '#6092C0',
  trace:       '#9170B8',
  unknown:     '#98A2B3',
};

export const SEVERITY_ORDER = [
  'critical', 'fatal', 'error', 'err', 'warn', 'warning',
  'info', 'information', 'debug', 'trace', 'unknown',
];

/** Accent color for single-stack bars when no severity column is mapped. */
export const SINGLE_STACK_COLOR = '#54B399';

/**
 * 10-hue categorical palette for breakdown field series.
 * Mirrors the EUI colorblind-safe palette used in SEVERITY_COLORS.
 */
export const BREAKDOWN_PALETTE = [
  '#54B399',
  '#6092C0',
  '#D36086',
  '#9170B8',
  '#CA8EAE',
  '#D6BF57',
  '#B9A888',
  '#DA8B45',
  '#AA6556',
  '#E7664C',
];

/** Color used for the "Other" series in breakdown mode. */
export const OTHER_COLOR = '#98A2B3';

/**
 * Deterministic service → color mapping, shared by the trace list, waterfall, and service map so
 * the same service always renders the same color everywhere. Uses the same BREAKDOWN_PALETTE as
 * the logs histogram for visual consistency across the plugin.
 */
export function serviceColor(serviceName: string): string {
  let hash = 0;
  for (let i = 0; i < serviceName.length; i++) {
    hash = (hash * 31 + serviceName.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % BREAKDOWN_PALETTE.length;
  return BREAKDOWN_PALETTE[idx];
}
