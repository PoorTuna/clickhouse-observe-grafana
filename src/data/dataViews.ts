import { DataView, AppJsonData } from '../types';

const PERSONAL_VIEWS_KEY = 'poortuna-clickhouse-observe:data-views';
const ACTIVE_VIEW_KEY = 'poortuna-clickhouse-observe:active-data-view';

function readAll(): DataView[] {
  try {
    const raw = localStorage.getItem(PERSONAL_VIEWS_KEY);
    return raw ? (JSON.parse(raw) as DataView[]) : [];
  } catch {
    return [];
  }
}

function writeAll(views: DataView[]): void {
  try {
    localStorage.setItem(PERSONAL_VIEWS_KEY, JSON.stringify(views));
  } catch {
    // Storage full or unavailable — silently swallow.
  }
}

export function loadPersonalViews(): DataView[] {
  return readAll();
}

export function savePersonalView(view: Omit<DataView, 'id' | 'createdAt' | 'origin'>): DataView {
  const all = readAll();
  const entry: DataView = {
    ...view,
    id: `dv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    origin: 'personal',
    createdAt: new Date().toISOString(),
  };
  writeAll([...all, entry]);
  return entry;
}

export function deletePersonalView(id: string): void {
  writeAll(readAll().filter((v) => v.id !== id));
}

/** Combined list: shared views first, then personal. */
export function mergeViews(shared: DataView[], personal: DataView[]): DataView[] {
  return [...shared, ...personal];
}

export function getActiveViewId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_VIEW_KEY);
  } catch {
    return null;
  }
}

export function persistActiveViewId(id: string): void {
  try {
    localStorage.setItem(ACTIVE_VIEW_KEY, id);
  } catch {}
}

/**
 * If jsonData has no dataViews but has a legacy sourceConfig, synthesize one shared
 * view from it so existing installs work without reconfiguration.
 * Non-destructive — does not persist; only persisted when admin next saves config.
 */
export function migrateLegacyConfig(jsonData: AppJsonData): DataView[] {
  if (jsonData.dataViews && jsonData.dataViews.length > 0) {
    return jsonData.dataViews;
  }
  if (!jsonData.sourceConfig?.datasourceUid) {
    return [];
  }
  const sc = jsonData.sourceConfig;
  const view: DataView = {
    ...sc,
    id: 'default',
    name: sc.logsTable || 'Default',
    origin: 'shared',
    createdAt: new Date().toISOString(),
  };
  return [view];
}
