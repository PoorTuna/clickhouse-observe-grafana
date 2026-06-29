import { parseKql } from '../_parser';
import { kqlToSql } from '../toSql';
import { SourceConfig, OTEL_COLUMN_MAPPING } from '../../../types';

const config: SourceConfig = {
  datasourceUid: 'test',
  database: 'default',
  logsTable: 'otel_logs',
  tracesTable: 'otel_traces',
  isOtel: true,
  columns: OTEL_COLUMN_MAPPING,
};

function sql(kql: string): string {
  return kqlToSql(parseKql(kql), config);
}

describe('kqlToSql', () => {
  // ── Body search ───────────────────────────────────────────────────────────
  it('bare term → hasToken OR ILIKE on body', () => {
    const result = sql('hello');
    expect(result).toContain('hasToken(Body');
    expect(result).toContain("ILIKE '%hello%'");
  });

  it('bare quoted phrase → body ILIKE', () => {
    const result = sql('"hello world"');
    expect(result).toContain("ILIKE '%hello world%'");
    expect(result).not.toContain('hasToken');
  });

  // ── Level ─────────────────────────────────────────────────────────────────
  it('level:error → IN clause on SeverityText', () => {
    const result = sql('level:error');
    expect(result).toContain('SeverityText');
    expect(result).toContain('IN');
    expect(result).toContain("'error'");
  });

  it('level:warn → IN with warn/warning variants', () => {
    const result = sql('level:warn');
    expect(result).toContain("'warn'");
    expect(result).toContain("'warning'");
  });

  // ── Exact match ───────────────────────────────────────────────────────────
  it('service:payment → = on serviceName column', () => {
    const result = sql('service:payment');
    expect(result).toContain("= 'payment'");
  });

  // ── Wildcard ─────────────────────────────────────────────────────────────
  it('service:pay* → ILIKE with % substitution', () => {
    const result = sql('service:pay*');
    expect(result).toContain("ILIKE 'pay%'");
  });

  it('host:web?.local → ILIKE with _ substitution', () => {
    const result = sql('host:web?.local');
    expect(result).toContain("ILIKE 'web_.local'");
  });

  // ── Exists ────────────────────────────────────────────────────────────────
  it('traceId:* → notEmpty(toString(...))', () => {
    const result = sql('traceId:*');
    expect(result).toContain('notEmpty(toString(');
  });

  // ── Ranges ────────────────────────────────────────────────────────────────
  it('responseTime >= 500 → numeric >= literal', () => {
    const result = sql('responseTime >= 500');
    expect(result).toContain('>= 500');
    expect(result).not.toContain("'500'");
  });

  it('responseTime < 100 → < literal', () => {
    const result = sql('responseTime < 100');
    expect(result).toContain('< 100');
  });

  // ── NOT ──────────────────────────────────────────────────────────────────
  it('not level:debug → NOT (...)', () => {
    const result = sql('not level:debug');
    expect(result).toMatch(/^NOT \(/);
  });

  // ── AND ──────────────────────────────────────────────────────────────────
  it('AND → both clauses joined with AND', () => {
    const result = sql('level:error and service:api');
    expect(result).toContain(') AND (');
  });

  // ── OR ───────────────────────────────────────────────────────────────────
  it('OR → both clauses joined with OR', () => {
    const result = sql('level:error or level:warn');
    expect(result).toContain(') OR (');
  });

  // ── Nested conjunction ────────────────────────────────────────────────────
  it('nested and/or → correct parenthesisation', () => {
    const result = sql('(level:error or level:warn) and service:api');
    // Should have an OR wrapped in AND
    expect(result).toContain(') AND (');
    expect(result).toContain(') OR (');
  });

  // ── Value list ────────────────────────────────────────────────────────────
  it('level:(error or warn) → OR of two level clauses', () => {
    const result = sql('level:(error or warn)');
    expect(result).toContain(') OR (');
    expect(result).toContain('SeverityText');
  });

  // ── Dotted field name (pass-through via resolveField) ────────────────────
  it('http.method:GET → passed through as-is (resolveField dot pass-through)', () => {
    // resolveField returns sqlExpr='http.method', kind='exact' for dotted names
    // (the map-accessor path only fires for raw.includes('[') after the dot check)
    const result = sql('http.method:GET');
    expect(result).toContain("= 'GET'");
    expect(result).toContain('http.method');
  });

  // ── Unknown field falls back to body ────────────────────────────────────
  it('completely unknown field falls back to body search', () => {
    // With no logAttributes/resourceAttributes AND a truly unknown field (not dotted),
    // we need a config without map columns.
    const noMapConfig: SourceConfig = {
      ...config,
      columns: { ...config.columns, logAttributes: '', resourceAttributes: '' },
    };
    const result = kqlToSql(parseKql('unknownfield:value'), noMapConfig);
    expect(result).toContain('Body');
  });
});
