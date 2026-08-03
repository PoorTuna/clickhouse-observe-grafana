/**
 * Shown when an inbound trace->logs link (see ../data/traceViewChoice.ts) can't be resolved to a
 * single Data View on its own — either several views share the trace's datasource, or none do.
 * App.tsx renders this instead of <LogsExplorer/> while unresolved; LogsExplorer never mounts (and
 * never queries) against a guessed view.
 */
import React, { useState } from 'react';
import { Button, Checkbox, Modal } from '@grafana/ui';
import { DataView } from '../types';
import { TraceLanding } from '../data/traceViewChoice';

interface TraceViewPickerModalProps {
  landing: Extract<TraceLanding, { status: 'choosing' }>;
  onChoose: (view: DataView, remember: boolean) => void;
  /** Dismissed without picking (backdrop/Esc/close) — caller falls through to its normal
   *  stored/default view selection, same as if the link had carried no dsUid at all. */
  onDismiss: () => void;
}

function ViewRow({
  view,
  disabledReason,
  selected,
  onSelect,
}: {
  view: DataView;
  disabledReason?: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        width: '100%',
        textAlign: 'left',
        padding: '8px 12px',
        marginBottom: 4,
        borderRadius: 4,
        cursor: 'pointer',
        border: selected ? '1px solid var(--color-primary-border, #3d71d9)' : '1px solid transparent',
        background: selected ? 'var(--color-primary-transparent, rgba(61,113,217,0.1))' : 'var(--color-background-secondary)',
      }}
    >
      <span>{view.name}</span>
      <span style={{ fontSize: '0.8em', color: 'var(--color-text-secondary)' }}>
        {view.database}.{view.logsTable}
        {disabledReason ? ` — ${disabledReason}` : ''}
      </span>
    </button>
  );
}

export function TraceViewPickerModal({ landing, onChoose, onDismiss }: TraceViewPickerModalProps) {
  const [selectedId, setSelectedId] = useState<string | undefined>(
    landing.matching[0]?.id ?? landing.others[0]?.id
  );
  const [remember, setRemember] = useState(false);

  const allCandidates = [...landing.matching, ...landing.others];
  const selected = allCandidates.find((v) => v.id === selectedId);

  const title = landing.reason === 'no-match' ? 'No data view for this datasource' : 'Which data view?';

  return (
    <Modal title={title} isOpen onDismiss={onDismiss}>
      {landing.reason === 'no-match' ? (
        <p>
          This trace&rsquo;s ClickHouse datasource isn&rsquo;t used by any configured data view, so we
          can&rsquo;t tell which log table to filter. Pick one below to view its logs unfiltered, or set
          up a matching data view from Configuration.
        </p>
      ) : (
        <p>More than one data view uses this trace&rsquo;s datasource. Which one has this trace&rsquo;s logs?</p>
      )}

      {landing.matching.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          {landing.reason === 'ambiguous' && (
            <div style={{ fontSize: '0.85em', color: 'var(--color-text-secondary)', marginBottom: 4 }}>
              Available
            </div>
          )}
          {landing.matching.map((v) => (
            <ViewRow key={v.id} view={v} selected={v.id === selectedId} onSelect={() => setSelectedId(v.id)} />
          ))}
        </div>
      )}

      {landing.others.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: '0.85em', color: 'var(--color-text-secondary)', marginBottom: 4 }}>
            {landing.reason === 'no-match' ? 'All data views' : 'Without trace ID column'}
          </div>
          {landing.others.map((v) => (
            <ViewRow
              key={v.id}
              view={v}
              disabledReason={landing.reason === 'ambiguous' ? 'no trace filter — column not mapped' : undefined}
              selected={v.id === selectedId}
              onSelect={() => setSelectedId(v.id)}
            />
          ))}
        </div>
      )}

      <Checkbox
        label="Remember my choice for this datasource"
        value={remember}
        onChange={(e) => setRemember(e.currentTarget.checked)}
      />

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <Button variant="primary" disabled={!selected} onClick={() => selected && onChoose(selected, remember)}>
          Open logs
        </Button>
      </div>
    </Modal>
  );
}
