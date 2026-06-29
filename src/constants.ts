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
