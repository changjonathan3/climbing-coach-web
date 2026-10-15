import { useEffect, useMemo, useState } from 'react';
import {
  listTrainingExamples,
  listSharedTrainingExamples,
  mergeExamples,
  type ExampleWithSource,
} from '../lib/firestore';
import type { ExampleQuality } from '../lib/db-models';
import { select, card, muted, faint, faultDot, faultText, c, sectionTitle, sectionSub } from '../theme';

type Props = {
  uid: string;
  profileId: string;
};

type SourceFilter = 'all' | 'shared' | 'mine';

const ALL_CUES = ['foot_cut', 'bent_arms', 'sagging_hips', 'hesitation'];

export function LibraryView({ uid, profileId }: Props) {
  const [examples, setExamples] = useState<ExampleWithSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cueFilter, setCueFilter] = useState<string>('all');
  const [qualityFilter, setQualityFilter] = useState<'all' | ExampleQuality>('all');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');

  useEffect(() => {
    let cancelled = false;
    setExamples(null);
    setError(null);
    Promise.all([listSharedTrainingExamples(profileId), listTrainingExamples(uid, profileId)])
      .then(([sharedExs, mineExs]) => {
        if (!cancelled) setExamples(mergeExamples(sharedExs, mineExs));
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load library');
      });
    return () => {
      cancelled = true;
    };
  }, [uid, profileId]);

  const filtered = useMemo(() => {
    if (!examples) return null;
    return examples.filter((ex) => {
      if (cueFilter !== 'all' && ex.cueCode !== cueFilter) return false;
      if (qualityFilter !== 'all' && ex.quality !== qualityFilter) return false;
      if (sourceFilter !== 'all' && ex.source !== sourceFilter) return false;
      return true;
    });
  }, [examples, cueFilter, qualityFilter, sourceFilter]);

  if (error) return <p style={faultText}>{error}</p>;
  if (filtered === null) return <p style={muted}>Loading library…</p>;

  return (
    <div>
      <h2 style={sectionTitle}>Library</h2>
      <p style={sectionSub}>Training examples — shared corpus and your labels.</p>
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <select value={cueFilter} onChange={(e) => setCueFilter(e.target.value)} style={select} aria-label="Filter by cue">
          <option value="all">All cues</option>
          {ALL_CUES.map((cue) => (
            <option key={cue} value={cue}>
              {cue}
            </option>
          ))}
        </select>
        <select
          value={qualityFilter}
          onChange={(e) => setQualityFilter(e.target.value as 'all' | ExampleQuality)}
          style={select}
          aria-label="Filter by quality"
        >
          <option value="all">Good + Bad</option>
          <option value="bad">Bad only</option>
          <option value="good">Good only</option>
        </select>
        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value as SourceFilter)}
          style={select}
          aria-label="Filter by source"
        >
          <option value="all">Shared + Mine</option>
          <option value="shared">Shared corpus</option>
          <option value="mine">My labels</option>
        </select>
        <span style={{ ...faint, alignSelf: 'center', marginLeft: 'auto' }}>
          {filtered.length} example{filtered.length === 1 ? '' : 's'}
        </span>
      </div>

      {filtered.length === 0 ? (
        <p style={muted}>No examples match these filters.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {filtered.map((ex) => {
            const isBad = ex.quality === 'bad';
            return (
              <li key={`${ex.source}-${ex.id}`} style={card}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <span style={{ ...faultDot, backgroundColor: isBad ? c.fault : c.textFaint }} />
                  <strong style={{ fontSize: '15px', color: c.text }}>{ex.cueCode ?? '(not a fault)'}</strong>
                  <span
                    style={{
                      fontSize: '12px',
                      padding: '2px 8px',
                      borderRadius: '10px',
                      border: `1px solid ${isBad ? c.fault : c.borderStrong}`,
                      color: isBad ? c.fault : c.textMuted,
                    }}
                  >
                    {isBad ? 'BAD' : 'GOOD'}
                  </span>
                  {ex.source === 'shared' && (
                    <span style={{ fontSize: '12px', ...faint }}>shared</span>
                  )}
                  <span style={{ ...faint, marginLeft: 'auto' }}>
                    {(ex.momentMs / 1000).toFixed(1)}s
                  </span>
                </div>
                <div style={{ marginTop: '6px', fontSize: '13px', ...faint }}>
                  {ex.sourceVideoName}
                </div>
                {ex.notes && (
                  <div style={{ marginTop: '6px', fontSize: '14px', ...muted }}>{ex.notes}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
