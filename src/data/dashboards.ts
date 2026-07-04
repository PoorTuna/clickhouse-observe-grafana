/**
 * Thin wrappers around the Grafana dashboard REST API.
 * Mirrors the getBackendSrv() pattern already used in AppConfig.updatePlugin
 * (src/components/AppConfig/AppConfig.tsx) — no dashboard API was called anywhere before this.
 */
import { getBackendSrv } from '@grafana/runtime';

export interface DashboardHit {
  uid: string;
  title: string;
  url: string;
  folderTitle?: string;
}

export interface DashboardGetResult {
  dashboard: Record<string, unknown>;
  meta: { folderUid?: string };
}

export interface SaveDashboardResult {
  uid: string;
  url: string;
}

/** Search existing dashboards (type=dash-db excludes folders) for the "add to existing" picker. */
export async function searchDashboards(query = ''): Promise<DashboardHit[]> {
  const params = new URLSearchParams({ type: 'dash-db' });
  if (query.trim()) {
    params.set('query', query.trim());
  }
  return getBackendSrv().get<DashboardHit[]>(`/api/search?${params.toString()}`);
}

/** Fetch a dashboard's full JSON model by uid, so panels can be appended to it. */
export async function getDashboard(uid: string): Promise<DashboardGetResult> {
  return getBackendSrv().get<DashboardGetResult>(`/api/dashboards/uid/${uid}`);
}

/** Create or update a dashboard. Set overwrite=true when saving an appended-to existing dashboard. */
export async function saveDashboard(
  dashboard: Record<string, unknown>,
  opts: { folderUid?: string; overwrite?: boolean } = {}
): Promise<SaveDashboardResult> {
  return getBackendSrv().post<SaveDashboardResult>('/api/dashboards/db', {
    dashboard,
    folderUid: opts.folderUid,
    overwrite: opts.overwrite ?? false,
  });
}
