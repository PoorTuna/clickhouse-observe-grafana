import { SourceConfig } from '../types';

export interface ViewCapabilities {
  /** Whether a timestamp column is mapped (enables time picker + histogram). */
  hasTime: boolean;
  /** Whether a severity/level column is mapped (enables histogram legend + level coloring). */
  hasSeverity: boolean;
  /** Whether a service-name column is mapped (enables Service column + filter alias). */
  hasService: boolean;
  /** Whether trace ID + traces table are both set (enables trace-jump links). */
  hasTraces: boolean;
  /** Whether ResourceAttributes Map is mapped (enables resource attr group in drawer). */
  hasResourceAttrs: boolean;
  /** Whether LogAttributes Map is mapped (enables log attr group + dotted-key filters). */
  hasLogAttrs: boolean;
  /** Whether SpanKind is mapped (enables span-kind icon/filter). */
  hasSpanKind: boolean;
  /** Whether StatusMessage is mapped (enables status message row in span drawer). */
  hasStatusMessage: boolean;
  /**
   * Whether the traces feature can show span Events (exception stack traces, etc).
   * Traces is OTel-only by design, so this always tracks hasTraces — the `Events.*`
   * nested-array columns are a fixed part of the assumed schema, not user-mapped.
   */
  hasSpanEvents: boolean;
  /** Same rationale as hasSpanEvents — Links.* is a fixed OTel column, tracks hasTraces. */
  hasSpanLinks: boolean;
}

/**
 * Derive view capabilities from a SourceConfig.
 * A capability is active only when its required mapping fields are non-empty strings.
 * Use this to gate UI elements — never show chrome for unmapped columns.
 */
export function viewCapabilities(config: SourceConfig): ViewCapabilities {
  const c = config.columns;
  const hasTraces = Boolean(c.traceId && config.tracesTable);
  return {
    hasTime: Boolean(c.timestamp),
    hasSeverity: Boolean(c.severity),
    hasService: Boolean(c.serviceName),
    hasTraces,
    hasResourceAttrs: Boolean(c.resourceAttributes),
    hasLogAttrs: Boolean(c.logAttributes),
    hasSpanKind: Boolean(c.spanKind),
    hasStatusMessage: Boolean(c.statusMessage),
    hasSpanEvents: hasTraces,
    hasSpanLinks: hasTraces,
  };
}
