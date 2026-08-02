import { SourceConfig } from '../types';

export interface ViewCapabilities {
  /** Whether a timestamp column is mapped (enables time picker + histogram). */
  hasTime: boolean;
  /** Whether a severity/level column is mapped (enables histogram legend + level coloring). */
  hasSeverity: boolean;
  /** Whether a service-name column is mapped (enables Service column + filter alias). */
  hasService: boolean;
}

/**
 * Derive view capabilities from a SourceConfig.
 * A capability is active only when its required mapping fields are non-empty strings.
 * Use this to gate UI elements — never show chrome for unmapped columns.
 */
export function viewCapabilities(config: SourceConfig): ViewCapabilities {
  const c = config.columns;
  return {
    hasTime: Boolean(c.timestamp),
    hasSeverity: Boolean(c.severity),
    hasService: Boolean(c.serviceName),
  };
}
