import pluginJson from './plugin.json';

export const PLUGIN_BASE_URL = `/a/${pluginJson.id}`;

export enum ROUTES {
  Logs = 'logs',
  Traces = 'traces',
}

export const SEVERITY_COLORS: Record<string, string> = {
  critical: '#ff0000',
  fatal: '#ff0000',
  error: '#e74c3c',
  err: '#e74c3c',
  warn: '#f39c12',
  warning: '#f39c12',
  info: '#27ae60',
  information: '#27ae60',
  debug: '#3498db',
  trace: '#9b59b6',
  unknown: '#95a5a6',
};

export const SEVERITY_ORDER = [
  'critical', 'fatal', 'error', 'err', 'warn', 'warning',
  'info', 'information', 'debug', 'trace', 'unknown',
];
