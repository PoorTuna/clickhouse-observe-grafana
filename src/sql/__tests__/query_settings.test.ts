/**
 * Unit tests for sql/settings.ts — the shared SETTINGS-clause builder every query builder in
 * this file routes through, so the list query and the drawer's point lookup can never disagree
 * on consistency again (see queryBuilder.ts's buildLogsQuery/buildLogDetailQuery).
 */

import { configSettingsFragments, withSettings } from '../settings';
import { EMPTY_COLUMN_MAPPING, SourceConfig } from '../../types';

const config: SourceConfig = {
  datasourceUid: 'test',
  database: 'default',
  logsTable: 'my_table',
  isOtel: false,
  columns: { ...EMPTY_COLUMN_MAPPING },
};

describe('configSettingsFragments', () => {
  it('enables select_sequential_consistency by default (undefined == enabled, for legacy views)', () => {
    expect(configSettingsFragments(config)).toContain('select_sequential_consistency = 1');
  });

  it('respects an explicit false', () => {
    expect(configSettingsFragments({ ...config, sequentialConsistency: false })).not.toContain(
      'select_sequential_consistency = 1'
    );
  });

  it('splits extraQuerySettings on commas and drops blanks', () => {
    const fragments = configSettingsFragments({
      ...config,
      extraQuerySettings: 'max_replica_delay_for_distributed_queries = 30, , fallback_to_stale_replicas_for_distributed_queries = 1',
    });
    expect(fragments).toContain('max_replica_delay_for_distributed_queries = 30');
    expect(fragments).toContain('fallback_to_stale_replicas_for_distributed_queries = 1');
    expect(fragments.length).toBe(3); // + select_sequential_consistency
  });
});

describe('withSettings', () => {
  it('emits a single trailing SETTINGS clause', () => {
    const sql = withSettings(['SELECT 1', 'FROM t'], ['a = 1', 'b = 2']);
    expect(sql).toBe('SELECT 1\nFROM t\nSETTINGS a = 1, b = 2');
    expect(sql.match(/SETTINGS/g)?.length).toBe(1);
  });

  it('omits the SETTINGS clause entirely when there are no fragments', () => {
    const sql = withSettings(['SELECT 1', 'FROM t'], []);
    expect(sql).toBe('SELECT 1\nFROM t');
    expect(sql).not.toContain('SETTINGS');
  });

  it('drops falsy body lines before joining', () => {
    const sql = withSettings(['SELECT 1', null, 'FROM t', false], ['a = 1']);
    expect(sql).toBe('SELECT 1\nFROM t\nSETTINGS a = 1');
  });

  it('later fragments win on key collision — a config override beats a builder default', () => {
    const sql = withSettings(['SELECT 1'], ['max_execution_time = 10', 'max_execution_time = 30']);
    expect(sql).toContain('SETTINGS max_execution_time = 30');
    expect(sql).not.toContain('max_execution_time = 10');
  });
});
