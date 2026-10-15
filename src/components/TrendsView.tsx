import { useEffect, useMemo, useState } from 'react';
import { listAnalyses, type DocWithId } from '../lib/firestore';
import type { AnalysisDoc } from '../lib/db-models';
import { isFirebaseConfigured } from '../lib/firebase';
import { card, muted, faint, faultDot, faultText, c, sectionTitle, sectionSub } from '../theme';

type Props = {
  uid: string;
  profileId: string;
};

const PRIORITY_CUES = ['foot_cut', 'bent_arms', 'sagging_hips', 'hesitation'] as const;

/** Delta thresholds (task spec): ±0.12 second-half rate vs first-half rate. */
const TREND_DELTA = 0.12;

type Trend = 'rising' | 'improving' | 'stable';

function trendBadge(firstRate: number, secondRate: number, enough: boolean): Trend {
  if (!enough) return 'stable';
  const delta = secondRate - firstRate;
  if (delta > TREND_DELTA) return 'rising';
  if (delta < -TREND_DELTA) return 'improving';
  return 'stable';
}

const BADGE_LABEL: Record<Trend, string> = {
  rising: '↑ rising',
  improving: '↓ improving',
  stable: '→ stable',
};

type CueRow = {
  code: string;
  fireCount: number;
  coverage: number;
  firstRate: number;
  secondRate: number;
  trend: Trend;
};

export function TrendsView({ uid, profileId }: Props) {
  const [analyses, setAnalyses] = useState<DocWithId<AnalysisDoc>[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isFirebaseConfigured) return;
    let cancelled = false;
    setAnalyses(null);
    setError(null);
    listAnalyses(uid, profileId)
      .then((docs) => {
        if (!cancelled) setAnalyses(docs);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load analyses');
      });
    return () => {
      cancelled = true;
    };
  }, [uid, profileId]);

  const { rows, total, dismissedCount } = useMemo(() => {
    if (!analyses) return { rows: null as CueRow[] | null, total: 0, dismissedCount: 0 };
    // Oldest → newest for half-vs-half trend comparison.
    const ordered = [...analyses].sort((a, b) => a.createdAt - b.createdAt);
    const n = ordered.length;
    const half = Math.floor(n / 2);
    const firstHalf = half > 0 ? ordered.slice(0, half) : [];
    const secondHalf = half > 0 ? ordered.slice(n - half) : [];
    const dismissedCount = ordered.reduce(
      (sum, a) => sum + a.cueEvents.filter((e) => e.dismissed).length,
      0,
    );
    const firedIn = (list: DocWithId<AnalysisDoc>[], code: string) =>
      list.filter((a) => a.cueEvents.some((e) => e.code === code && !e.dismissed)).length;
    const rows: CueRow[] = PRIORITY_CUES.map((code) => {
      const fireCount = firedIn(ordered, code);
      const firstRate = firstHalf.length > 0 ? firedIn(firstHalf, code) / firstHalf.length : 0;
      const secondRate = secondHalf.length > 0 ? firedIn(secondHalf, code) / secondHalf.length : 0;
      return {
        code,
        fireCount,
        coverage: n > 0 ? fireCount / n : 0,
        firstRate,
        secondRate,
        trend: trendBadge(firstRate, secondRate, half > 0),
      };
    });
    rows.sort((a, b) => b.fireCount - a.fireCount);
    return { rows, total: n, dismissedCount };
  }, [analyses]);

  if (!isFirebaseConfigured) {
    return <p style={muted}>Sign in to use Trends.</p>;
  }
  if (error) return <p style={faultText}>{error}</p>;
  if (rows === null) return <p style={muted}>Loading analyses…</p>;
  if (total === 0) return <p style={muted}>No saved analyses yet.</p>;

  return (
    <div>
      <h2 style={sectionTitle}>Trends</h2>
      <p style={sectionSub}>How your faults are trending over time.</p>
      <p style={{ ...muted, fontSize: '14px', marginTop: 0 }}>
        {total} saved analysis{total === 1 ? '' : 'es'}
        {dismissedCount > 0 && ` · ${dismissedCount} dismissed fault${dismissedCount === 1 ? '' : 's'} excluded from counts`}
      </p>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {rows.map((r) => (
          <li key={r.code} style={card}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
              <span style={faultDot} />
              <strong style={{ fontSize: '15px', color: c.text }}>{r.code}</strong>
              <span style={{ marginLeft: 'auto', ...muted, fontSize: '14px' }}>
                {BADGE_LABEL[r.trend]}
              </span>
            </div>
            <div style={{ marginTop: '6px', fontSize: '14px', ...muted }}>
              Fired in {r.fireCount} of {total} analyses ({(r.coverage * 100).toFixed(0)}%
              coverage)
            </div>
            <div style={{ marginTop: '2px', fontSize: '13px', ...faint }}>
              First half: {(r.firstRate * 100).toFixed(0)}% · Second half:{' '}
              {(r.secondRate * 100).toFixed(0)}%
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
