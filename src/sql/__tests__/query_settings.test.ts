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

  // Measured against a live server (CH 26.3.17.4): max_execution_time = 3 fires at 3.00s with or
  // without timeout_before_checking_execution_speed set — that setting governs min_execution_speed
  // checking, not the timeout itself, so withSettings must never inject it (see its doc comment;
  // this used to default it to 0 on a since-disproven "10s of grace" theory).
  it('never emits timeout_before_checking_execution_speed, even when max_execution_time is set', () => {
    const sql = withSettings(['SELECT 1'], [`max_execution_time = 10`, `timeout_overflow_mode = 'throw'`]);
    expect(sql).not.toContain('timeout_before_checking_execution_speed');
  });

  it('passes through an explicit timeout_before_checking_execution_speed fragment unchanged', () => {
    // e.g. a user's own extraQuerySettings fragment — withSettings must not touch it either way.
    const sql = withSettings(
      ['SELECT 1'],
      ['max_execution_time = 10', 'timeout_before_checking_execution_speed = 5']
    );
    expect(sql).toContain('timeout_before_checking_execution_speed = 5');
  });

  // See the diagnostics plan's "Hole 1": before this, a later (config-derived) fragment always
  // won on key collision — including for the four overflow-mode keys where a builder's 'throw'
  // exists specifically to prevent a truncated scan from reporting a confidently wrong answer
  // (see VOLUME_QUERY_SETTINGS in queryBuilder.ts). A user typing `timeout_overflow_mode = 'break'`
  // into "Additional query SETTINGS" silently reinstated exactly that bug. These four keys must
  // now resist being overridden by whatever comes after the builder's own value.
  describe('BUILDER_OWNED_SETTINGS — a builder default resists a later override', () => {
    it.each(['timeout_overflow_mode', 'read_overflow_mode', 'result_overflow_mode', 'group_by_overflow_mode'])(
      '%s: keeps the builder value, ignoring a later config-derived override',
      (key) => {
        const sql = withSettings(['SELECT 1'], [`${key} = 'throw'`, `${key} = 'break'`]);
        expect(sql).toContain(`${key} = 'throw'`);
        expect(sql).not.toContain(`${key} = 'break'`);
      }
    );

    it('is not applied when the builder never set the key — config is free to set it', () => {
      const sql = withSettings(['SELECT 1'], [`timeout_overflow_mode = 'break'`]);
      expect(sql).toContain(`timeout_overflow_mode = 'break'`);
    });

    it('does not affect ordinary (non-owned) settings, which still let a later fragment win', () => {
      const sql = withSettings(['SELECT 1'], ['max_execution_time = 10', 'max_execution_time = 30']);
      expect(sql).toContain('max_execution_time = 30');
    });
  });
});
