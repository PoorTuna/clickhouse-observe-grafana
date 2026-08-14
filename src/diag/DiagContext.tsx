/**
 * Thin React adapter over tracer.ts's module-scoped span store. Deliberately NOT a React Context
 * carrying the span tree as state — spans mutate very frequently while a query is in flight (the
 * plan's "live behaviour while the drawer is open" section), and re-rendering on every mutation
 * would mean every span update re-renders everything under the provider, including the log grid.
 *
 * Instead: useSyncExternalStore subscribes to tracer's version counter (a plain number, cheap to
 * compare) and only the components that actually call useDiagnostics() re-render when it changes.
 * The logs grid, histogram, etc. never subscribe to this at all, so tracing is zero-cost for them.
 */
import { useSyncExternalStore } from 'react';
import { getRoots, getVersion, subscribe } from './tracer';
import { Span } from './types';

export interface DiagnosticsSnapshot {
  /** Root spans (actions + orphaned background roots), oldest first. Read live off the tracer —
   *  safe because React re-renders exactly when `version` changes, i.e. exactly when this could be
   *  stale otherwise. */
  roots: readonly Span[];
  version: number;
}

/** Subscribes to the diagnostics tracer. Only components that render diagnostics UI should call
 *  this — everything else in the app should be unaffected by tracing activity. */
export function useDiagnostics(): DiagnosticsSnapshot {
  const version = useSyncExternalStore(subscribe, getVersion, getVersion);
  return { roots: getRoots(), version };
}
