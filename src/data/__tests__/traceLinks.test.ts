/**
 * Unit tests for traceLinks.ts — verifies the "View trace" DataLink that
 * grafana-clickhouse-datasource stamps onto a traceID field gets interpolated into a real
 * Explore href (not the raw `${__value.raw}` placeholder), that a missing/disabled link
 * degrades to `undefined`, and that the probe query only runs once per datasource.
 */
import { DataFrame, DataLink, FieldType as GrafanaFieldType, TimeRange, dateTime } from '@grafana/data';
import { buildTraceExploreHref, getTraceLinkTemplate, resetTraceLinkCache } from '../traceLinks';
import { runQuery } from '../runQuery';

jest.mock('../runQuery');
jest.mock('@grafana/runtime', () => ({
  getTemplateSrv: () => ({
    // Real templateSrv substitutes ${varName} occurrences anywhere within the string (e.g. inside
    // a larger rawSql fragment), not just on an exact match — mirror that here.
    replace: (value: string, scopedVars: any) => {
      const raw = scopedVars?.__value?.value?.raw;
      return raw === undefined ? value : value.split('${__value.raw}').join(raw);
    },
  }),
}));

const mockRunQuery = runQuery as jest.MockedFunction<typeof runQuery>;

const timeRange: TimeRange = {
  from: dateTime('2026-01-01T00:00:00Z'),
  to: dateTime('2026-01-01T01:00:00Z'),
  raw: { from: 'now-1h', to: 'now' },
};

const VIEW_TRACE_LINK: DataLink = {
  title: 'View trace',
  url: '',
  targetBlank: false,
  internal: {
    datasourceUid: 'ch-uid',
    datasourceName: 'grafana-clickhouse-datasource',
    query: {
      refId: 'Trace ID',
      editorType: 'builder',
      rawSql: "SELECT ... WHERE traceID = '${__value.raw}'",
      builderOptions: {
        database: 'default',
        table: 'otel_traces',
        queryType: 'traces',
        meta: { isTraceIdMode: true, minimized: true, traceId: '${__value.raw}' },
      },
    } as any,
  },
};

function frameWithLink(link: DataLink | undefined): DataFrame[] {
  return [
    {
      refId: 'ch-observe-tracelink',
      length: 1,
      fields: [
        {
          name: 'traceID',
          type: GrafanaFieldType.string,
          config: link ? { links: [link] } : {},
          values: [''],
        },
      ],
    } as unknown as DataFrame,
  ];
}

beforeEach(() => {
  resetTraceLinkCache();
  mockRunQuery.mockReset();
});

describe('getTraceLinkTemplate', () => {
  it('probes once per datasource and caches the result across calls', async () => {
    mockRunQuery.mockResolvedValue(frameWithLink(VIEW_TRACE_LINK));

    const first = await getTraceLinkTemplate('ch-uid', timeRange);
    const second = await getTraceLinkTemplate('ch-uid', timeRange);

    expect(first?.link.title).toBe('View trace');
    expect(second).toBe(first);
    expect(mockRunQuery).toHaveBeenCalledTimes(1);
    expect(mockRunQuery.mock.calls[0][0]).toMatchObject({ datasourceUid: 'ch-uid', sql: "SELECT '' AS traceID" });
  });

  it('returns null when the datasource has no Traces config (no link in the frame)', async () => {
    mockRunQuery.mockResolvedValue(frameWithLink(undefined));
    const template = await getTraceLinkTemplate('ch-uid-no-traces', timeRange);
    expect(template).toBeNull();
  });

  it('returns null instead of throwing when the probe query fails', async () => {
    mockRunQuery.mockRejectedValue(new Error('boom'));
    const template = await getTraceLinkTemplate('ch-uid-broken', timeRange);
    expect(template).toBeNull();
  });

  it('falls back to a link whose query is in trace-ID mode when the title differs', async () => {
    const renamed: DataLink = { ...VIEW_TRACE_LINK, title: 'Some other title' };
    mockRunQuery.mockResolvedValue(frameWithLink(renamed));
    const template = await getTraceLinkTemplate('ch-uid-renamed', timeRange);
    expect(template?.link.title).toBe('Some other title');
  });
});

describe('buildTraceExploreHref', () => {
  it('interpolates the real trace id into the Explore href, not the raw placeholder', async () => {
    mockRunQuery.mockResolvedValue(frameWithLink(VIEW_TRACE_LINK));
    const template = await getTraceLinkTemplate('ch-uid', timeRange);
    expect(template).not.toBeNull();

    const href = buildTraceExploreHref(template!, '4bf92f3577b34da6a3ce929d0e0e4736', timeRange);

    expect(href).toBeDefined();
    expect(href).toContain('/explore?left=');
    const leftParam = new URLSearchParams(href!.split('?')[1]).get('left')!;
    const decoded = JSON.parse(decodeURIComponent(leftParam));
    expect(decoded.queries[0].builderOptions.meta.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(decoded.queries[0].rawSql).toContain('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(JSON.stringify(decoded)).not.toContain('${__value.raw}');
  });

  it('rejects a non-hex trace id', async () => {
    mockRunQuery.mockResolvedValue(frameWithLink(VIEW_TRACE_LINK));
    const template = await getTraceLinkTemplate('ch-uid', timeRange);
    expect(buildTraceExploreHref(template!, 'not-hex!!', timeRange)).toBeUndefined();
  });
});
