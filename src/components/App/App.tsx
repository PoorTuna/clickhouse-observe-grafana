import React, { createContext, Suspense, useCallback, useMemo, useRef, useState } from 'react';
import { AppRootProps } from '@grafana/data';
import { LoadingPlaceholder } from '@grafana/ui';
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
import { decodeLogsState } from '../../data/urlState';
import { getRememberedView, rememberView, resolveTraceLanding, TraceLanding } from '../../data/traceViewChoice';
import { TraceViewPickerModal } from '../TraceViewPickerModal';

const LogsExplorer = React.lazy(() =>
  import('../../pages/LogsExplorer').then((m) => ({ default: m.LogsExplorer }))
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

  // Inbound trace->logs deep link (?traceId=&dsUid=…, see data/traceToLogsLink.ts). Decoded once
  // at mount, independent of react-router — App.tsx renders above LogsExplorer's <Route>-less
  // Suspense boundary and must resolve which Data View to activate *before* LogsExplorer (and its
  // queries) mounts, so it can't wait on router context the way LogsExplorer's own useSearchParams
  // does. window.location.search is read here for that reason, not out of router-avoidance alone.
  const [dsUid] = useState<string | undefined>(
    () => decodeLogsState(new URLSearchParams(window.location.search)).dsUid
  );
  // Once a view is picked (automatically, or via the picker modal below) for this dsUid, later
  // manual view switches during this mount refine the remembered preference for it — see
  // setActiveViewId below. Doesn't persist across an unrelated future visit without its own
  // dsUid, by design: the preference is scoped to "arrived here via a trace from this datasource".
  const traceDsUidRef = useRef<string | undefined>(dsUid);

  // Resolves dsUid -> a single Data View, or flags that a user choice is needed (several views on
  // that datasource, or none) — see traceViewChoice.ts's doc comment for why this can't be a
  // silent guess. `status: 'none'` (no dsUid at all) is the everyday case and short-circuits
  // immediately.
  const [traceLanding, setTraceLanding] = useState<TraceLanding>(() =>
    resolveTraceLanding(allViews, dsUid, dsUid ? getRememberedView(dsUid) : null)
  );

  // Active view ID: an already-resolved trace landing wins over everything else — it's a link the
  // user just clicked, more specific than whatever was merely left over from a prior session.
  // Otherwise: prefer stored value, fall back to defaultDataViewId, then first view.
  const [activeViewId, setActiveViewIdState] = useState<string | null>(() => {
    if (traceLanding.status === 'resolved') {
      return traceLanding.viewId;
    }
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
    // This session was reached via a trace link — a manual switch afterward is the user
    // correcting/refining which view that datasource's traces should land on, so update the
    // remembered choice too (see traceViewChoice.ts).
    if (traceDsUidRef.current) {
      rememberView(traceDsUidRef.current, id);
    }
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

  const handleTraceViewChoice = useCallback(
    (view: DataView, remember: boolean) => {
      setActiveViewId(view.id);
      if (remember && traceDsUidRef.current) {
        rememberView(traceDsUidRef.current, view.id);
      }
      setTraceLanding({ status: 'resolved', viewId: view.id });
    },
    [setActiveViewId]
  );

  // Dismissed without picking — activeViewId was already computed via the ordinary
  // stored/default chain (the 'choosing' branch never wins that initializer), so unblocking
  // LogsExplorer here just lets it mount against whatever that chain already picked.
  const handleTraceViewDismiss = useCallback(() => {
    setTraceLanding({ status: 'none' });
  }, []);

  return (
    <DataViewContext.Provider
      value={{ views: allViews, activeView, setActiveViewId, createPersonalView, updatePersonalView, deletePersonalView }}
    >
      <AiConfigContext.Provider value={jsonData.ai ?? null}>
        <SourceConfigContext.Provider value={sourceConfig}>
          {traceLanding.status === 'choosing' ? (
            <TraceViewPickerModal
              landing={traceLanding}
              onChoose={handleTraceViewChoice}
              onDismiss={handleTraceViewDismiss}
            />
          ) : (
            <Suspense fallback={<LoadingPlaceholder text="Loading…" />}>
              <LogsExplorer />
            </Suspense>
          )}
        </SourceConfigContext.Provider>
      </AiConfigContext.Provider>
    </DataViewContext.Provider>
  );
}

export default App;
