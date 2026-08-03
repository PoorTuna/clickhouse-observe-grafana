import React, { Suspense, lazy } from 'react';
import { AppPlugin, PluginExtensionPoints, type AppRootProps } from '@grafana/data';
import { LoadingPlaceholder } from '@grafana/ui';
import type { AppConfigProps } from './components/AppConfig/AppConfig';
import { AppJsonData } from './types';
import { buildTraceToLogsPath, TraceViewLinkContext } from './data/traceToLogsLink';
import { PLUGIN_BASE_URL } from './constants';

const LazyApp = lazy(() => import('./components/App/App'));
const LazyAppConfig = lazy(() => import('./components/AppConfig/AppConfig'));

const App = (props: AppRootProps<AppJsonData>) => (
  <Suspense fallback={<LoadingPlaceholder text="" />}>
    <LazyApp {...props} />
  </Suspense>
);

const AppConfig = (props: AppConfigProps) => (
  <Suspense fallback={<LoadingPlaceholder text="" />}>
    <LazyAppConfig {...props} />
  </Suspense>
);

export const plugin = new AppPlugin<AppJsonData>()
  .setRootPage(App)
  .addConfigPage({
    title: 'Configuration',
    icon: 'cog',
    body: AppConfig,
    id: 'configuration',
  })
  // Reverse half of the trace<->logs integration (see data/traceToLogsLink.ts): a button in
  // Explore's ClickHouse trace view header that jumps back into our Logs Explorer, filtered to
  // that trace. `title` here must match plugin.json's extensions.addedLinks[].title exactly —
  // Grafana refuses to register a link extension that isn't also declared in the manifest.
  .addLink<TraceViewLinkContext>({
    title: 'View logs in ClickHouse Observe',
    description: "Open this trace's logs in the ClickHouse Observe log explorer",
    targets: [PluginExtensionPoints.TraceViewHeaderActions],
    icon: 'document-info',
    // Grafana validates path/onClick synchronously at registration time (module load), before
    // `configure` ever runs per-context — an addLink with no top-level path/onClick is rejected
    // outright, never reaching `configure`. This placeholder is never actually navigated to:
    // `configure` below always overrides `path` with the real trace-scoped one, or returns
    // `undefined` to hide the link entirely when the context doesn't match our datasource.
    path: `${PLUGIN_BASE_URL}/logs`,
    configure: (ctx) => {
      const path = buildTraceToLogsPath(ctx);
      return path ? { path } : undefined;
    },
  });
