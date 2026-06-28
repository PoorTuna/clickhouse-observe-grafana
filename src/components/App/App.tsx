import React, { createContext, Suspense, useContext } from 'react';
import { Route, Routes } from 'react-router-dom';
import { AppRootProps } from '@grafana/data';
import { LoadingPlaceholder } from '@grafana/ui';
import { ROUTES } from '../../constants';
import { AppJsonData, DEFAULT_SOURCE_CONFIG, SourceConfig } from '../../types';

const LogsExplorer = React.lazy(() =>
  import('../../pages/LogsExplorer').then((m) => ({ default: m.LogsExplorer }))
);
const TraceExplorer = React.lazy(() =>
  import('../../pages/TraceExplorer').then((m) => ({ default: m.TraceExplorer }))
);

/** Shared context so all pages can access the current SourceConfig. */
export const SourceConfigContext = createContext<SourceConfig>(DEFAULT_SOURCE_CONFIG);

function App(props: AppRootProps<AppJsonData>) {
  const sourceConfig = props.meta.jsonData?.sourceConfig ?? DEFAULT_SOURCE_CONFIG;

  return (
    <SourceConfigContext.Provider value={sourceConfig}>
      <Suspense fallback={<LoadingPlaceholder text="Loading…" />}>
        <Routes>
          <Route path={`${ROUTES.Traces}/:traceId`} element={<TraceExplorer />} />
          <Route path={ROUTES.Traces} element={<TraceExplorer />} />
          {/* Default: Logs Explorer */}
          <Route path="*" element={<LogsExplorer />} />
        </Routes>
      </Suspense>
    </SourceConfigContext.Provider>
  );
}

export default App;
