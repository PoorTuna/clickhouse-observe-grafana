import React, { createContext, Suspense, useCallback, useMemo, useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { AppRootProps } from '@grafana/data';
import { LoadingPlaceholder } from '@grafana/ui';
import { ROUTES } from '../../constants';
import {
  AiProviderConfig,
  AppJsonData,
  DataView,
  DEFAULT_SOURCE_CONFIG,
  SourceConfig,
} from '../../types';
import {
  deletePersonalView as deletePVStorage,
  getActiveViewId,
  loadPersonalViews,
  mergeViews,
  migrateLegacyConfig,
  persistActiveViewId,
  savePersonalView,
  updatePersonalView as updatePVStorage,
} from '../../data/dataViews';

const LogsExplorer = React.lazy(() =>
  import('../../pages/LogsExplorer').then((m) => ({ default: m.LogsExplorer }))
);
const TraceExplorer = React.lazy(() =>
  import('../../pages/TraceExplorer').then((m) => ({ default: m.TraceExplorer }))
);

/** Shared context so all pages can access the current SourceConfig (= active DataView). */
export const SourceConfigContext = createContext<SourceConfig>(DEFAULT_SOURCE_CONFIG);

/** AI column-mapping assist settings (admin-configured) — null when never configured. */
export const AiConfigContext = createContext<AiProviderConfig | null>(null);

export interface DataViewContextValue {
  views: DataView[];
  activeView: DataView | null;
  setActiveViewId: (id: string) => void;
  createPersonalView: (view: Omit<DataView, 'id' | 'createdAt' | 'origin'>) => DataView;
  updatePersonalView: (id: string, updates: Omit<DataView, 'id' | 'createdAt' | 'origin'>) => void;
  deletePersonalView: (id: string) => void;
}

export const DataViewContext = createContext<DataViewContextValue>({
  views: [],
  activeView: null,
  setActiveViewId: () => {},
  createPersonalView: () => { throw new Error('DataViewContext not mounted'); },
  updatePersonalView: () => {},
  deletePersonalView: () => {},
});

// Stable fallback so `jsonData` doesn't get a fresh object identity every render when
// `props.meta.jsonData` is unset — otherwise the useMemo below would never hit its cache.
const EMPTY_JSON_DATA: AppJsonData = {};

function App(props: AppRootProps<AppJsonData>) {
  const jsonData = props.meta.jsonData ?? EMPTY_JSON_DATA;

  // Shared views from jsonData (admin-managed); migrate from legacy sourceConfig if needed.
  const sharedViews = useMemo(() => migrateLegacyConfig(jsonData), [jsonData]);

  // Personal views from localStorage (per-browser, per-user).
  const [personalViews, setPersonalViews] = useState<DataView[]>(() => loadPersonalViews());

  const allViews = useMemo(() => mergeViews(sharedViews, personalViews), [sharedViews, personalViews]);

  // Active view ID: prefer stored value, fall back to defaultDataViewId, then first view.
  const [activeViewId, setActiveViewIdState] = useState<string | null>(() => {
    const stored = getActiveViewId();
    const available = [...sharedViews, ...loadPersonalViews()];
    if (stored && available.some((v) => v.id === stored)) {
      return stored;
    }
    return jsonData.defaultDataViewId ?? available[0]?.id ?? null;
  });

  const activeView = useMemo(
    () => allViews.find((v) => v.id === activeViewId) ?? allViews[0] ?? null,
    [allViews, activeViewId]
  );

  const setActiveViewId = useCallback((id: string) => {
    setActiveViewIdState(id);
    persistActiveViewId(id);
  }, []);

  const createPersonalView = useCallback(
    (view: Omit<DataView, 'id' | 'createdAt' | 'origin'>) => {
      const saved = savePersonalView(view);
      setPersonalViews((prev) => [...prev, saved]);
      return saved;
    },
    []
  );

  const updatePersonalView = useCallback(
    (id: string, updates: Omit<DataView, 'id' | 'createdAt' | 'origin'>) => {
      const saved = updatePVStorage(id, updates);
      if (saved) {
        setPersonalViews((prev) => prev.map((v) => (v.id === id ? saved : v)));
      }
    },
    []
  );

  const deletePersonalView = useCallback((id: string) => {
    deletePVStorage(id);
    setPersonalViews((prev) => prev.filter((v) => v.id !== id));
    // If deleted view was active, fall back to first remaining view.
    setActiveViewIdState((prev) => {
      if (prev !== id) {
        return prev;
      }
      const remaining = allViews.filter((v) => v.id !== id);
      return remaining[0]?.id ?? null;
    });
  }, [allViews]);

  // The active view (a DataView) is assignable to SourceConfig — existing consumers unchanged.
  const sourceConfig: SourceConfig = activeView ?? DEFAULT_SOURCE_CONFIG;

  return (
    <DataViewContext.Provider
      value={{ views: allViews, activeView, setActiveViewId, createPersonalView, updatePersonalView, deletePersonalView }}
    >
      <AiConfigContext.Provider value={jsonData.ai ?? null}>
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
      </AiConfigContext.Provider>
    </DataViewContext.Provider>
  );
}

export default App;
