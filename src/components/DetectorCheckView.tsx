import { useCallback, useEffect, useState } from 'react';
import { gradeReferenceTrace, type GradingSample } from '../engine/engine';
import { CORE_CUE_CODES, type CoreCueCode } from '../engine/references';
import { isFirebaseConfigured } from '../lib/firebase';
import {
  listTrainingExamples,
  listSharedTrainingExamples,
  mergeExamples,
  listDetectorCheckRuns,
  saveDetectorCheckRun,
  DETECTOR_VERSION,
  type DocWithId,
  type ExampleWithSource,
} from '../lib/firestore';
import type { TrainingExampleDoc, DetectorCheckRunSaveDoc } from '../lib/db-models';
import { btnPrimary, btnPrimaryDisabled, btnSmall, card, muted, faint, faultDot, faultText, c, sectionTitle, sectionSub } from '../theme';

type Props = {
  uid: string;
  profileId: string;
};

/**
 * Artifact parity: legacy labels map to their current core family.
 * `static_lockoff` merged into `bent_arms`; `hand_readjustments` was removed
 * with no core equivalent, so such examples are skipped.
 */
function coreFamily(code: string | null): CoreCueCode | 'good' | null {
  if (code === null) return 'good';
  const map: Record<string, CoreCueCode | null> = {
    foot_cut: 'foot_cut',
    bent_arms: 'bent_arms',
    sagging_hips: 'sagging_hips',
    hesitation: 'hesitation',
    static_lockoff: 'bent_arms',
    hand_readjustments: null,
  };
  return code in map ? map[code] : null;
}

function getTrace(ex: DocWithId<TrainingExampleDoc>): GradingSample[] | null {
  const t = ex.trace;
  if (!Array.isArray(t) || t.length === 0) return null;
  return t as GradingSample[];
}

type Disagreement = {
  exampleId: string;
  source: 'shared' | 'mine';
  videoName: string;
  expected: string;
  detected: string;
  notes: string;
};

type CheckSummary = {
  generatedAt: number;
  checkCount: number;
  hits: number;
  agreementPct: number;
  perCue: Record<string, { passed: number; total: number }>;
  disagreementCount: number;
  skipped: number;
  noTraceCount: number;
  disagreements: Disagreement[];
};

function pct(passed: number, total: number): string {
  return total > 0 ? `${((passed / total) * 100).toFixed(1)}%` : '—';
}

const sectionStyle: React.CSSProperties = card;

const summaryStyle: React.CSSProperties = {
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: '15px',
  color: c.text,
};

export function DetectorCheckView({ uid, profileId }: Props) {
  const [examples, setExamples] = useState<ExampleWithSource[] | null>(null);
  const [recentRun, setRecentRun] = useState<DocWithId<DetectorCheckRunSaveDoc> | null>(null);
  const [results, setResults] = useState<CheckSummary | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isFirebaseConfigured) return;
    let cancelled = false;
    setExamples(null);
    setRecentRun(null);
    setResults(null);
    setError(null);
    Promise.all([
      listSharedTrainingExamples(profileId),
      listTrainingExamples(uid, profileId),
      listDetectorCheckRuns(uid, profileId),
    ])
      .then(([sharedExs, mineExs, runs]) => {
        if (cancelled) return;
        setExamples(mergeExamples(sharedExs, mineExs));
        setRecentRun(runs[0] ?? null);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      });
    return () => {
      cancelled = true;
    };
  }, [uid, profileId]);

  const runCheck = useCallback(async () => {
    if (!examples || running) return;
    setRunning(true);
    setError(null);
    setResults(null);
    setCopied(false);
    try {
      const noTrace = examples.filter((ex) => getTrace(ex) === null);
      const gradable = examples.filter((ex) => getTrace(ex) !== null);
      const perCue: Record<string, { passed: number; total: number }> = {};
      const disagreements: Disagreement[] = [];
      let checks = 0;
      let hits = 0;
      let skipped = 0;
      for (let i = 0; i < gradable.length; i++) {
        const ex = gradable[i];
        const trace = getTrace(ex);
        if (!trace) continue;
        const family = coreFamily(ex.quality === 'bad' ? ex.cueCode : null);
        if (family === null) {
          skipped++;
          continue;
        }
        let detected: string[];
        try {
          detected = gradeReferenceTrace(trace, 'video');
        } catch {
          skipped++;
          continue;
        }
        const hit = family === 'good' ? detected.length === 0 : detected.includes(family);
        const bucket = perCue[family] ?? (perCue[family] = { passed: 0, total: 0 });
        bucket.total++;
        if (hit) bucket.passed++;
        checks++;
        if (hit) hits++;
        if (!hit) {
          disagreements.push({
            exampleId: ex.id,
            source: ex.source,
            videoName: ex.sourceVideoName,
            expected: family === 'good' ? 'no fault' : family,
            detected: detected.join(', ') || 'none',
            notes: ex.notes || '',
          });
        }
        if (i % 3 === 0) {
          setProgress(`Checked ${i + 1} of ${gradable.length}…`);
          // Yield so the progress indicator paints between heavy grading calls.
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      const agreementPct = checks > 0 ? (hits / checks) * 100 : 0;
      await saveDetectorCheckRun(uid, {
        profileId,
        detectorVersion: DETECTOR_VERSION,
        agreementPct,
        perCue,
        disagreementCount: disagreements.length,
        checkCount: checks,
      });
      const summary: CheckSummary = {
        generatedAt: Date.now(),
        checkCount: checks,
        hits,
        agreementPct,
        perCue,
        disagreementCount: disagreements.length,
        skipped,
        noTraceCount: noTrace.length,
        disagreements,
      };
      setResults(summary);
      const runs = await listDetectorCheckRuns(uid, profileId);
      setRecentRun(runs[0] ?? null);
      setProgress('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Check failed');
      setProgress('');
    } finally {
      setRunning(false);
    }
  }, [examples, running, uid, profileId]);

  const summaryText = useCallback((): string | null => {
    const src = results ?? recentRun;
    if (!src) return null;
    const hitsPart = results ? `${results.hits}/` : '';
    const lines: string[] = [
      'Detector Check results for Jett',
      `Detector: ${DETECTOR_VERSION}`,
      `Run: ${new Date(src.generatedAt).toLocaleString()}`,
      `Agreement: ${src.agreementPct.toFixed(1)}% (${hitsPart}${src.checkCount} checks)`,
      'Per cue:',
    ];
    const keys = Object.keys(src.perCue).sort();
    for (const cue of keys) {
      const { passed, total } = src.perCue[cue];
      lines.push(`- ${cue}: ${passed}/${total} (${pct(passed, total)})`);
    }
    lines.push(`Disagreements: ${src.disagreementCount}`);
    if (results) {
      for (const d of results.disagreements) {
        lines.push(
          `- ${d.videoName} [${d.exampleId}${d.source === 'shared' ? ' shared' : ''}]: expected ${d.expected}, detected ${d.detected}${d.notes ? ` — notes: ${d.notes}` : ''}`,
        );
      }
      if (results.skipped > 0) lines.push(`Skipped (unmappable label or grading error): ${results.skipped}`);
      if (results.noTraceCount > 0)
        lines.push(`Examples without a trace (not checked): ${results.noTraceCount}`);
    }
    return lines.join('\n');
  }, [results, recentRun]);

  async function copyForJett() {
    const text = summaryText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Clipboard unavailable — copy failed');
    }
  }

  if (!isFirebaseConfigured) {
    return <p style={muted}>Sign in to use Detector Check.</p>;
  }
  if (error) return <p style={faultText}>{error}</p>;
  if (examples === null) return <p style={muted}>Loading training examples…</p>;

  const noTraceCount = examples.filter((ex) => getTrace(ex) === null).length;
  const gradableCount = examples.length - noTraceCount;
  const display: CheckSummary | null =
    results ??
    (recentRun
      ? {
          generatedAt: recentRun.generatedAt,
          checkCount: recentRun.checkCount,
          hits: 0,
          agreementPct: recentRun.agreementPct,
          perCue: recentRun.perCue,
          disagreementCount: recentRun.disagreementCount,
          skipped: 0,
          noTraceCount: 0,
          disagreements: [],
        }
      : null);
  const cueKeys = display ? [...CORE_CUE_CODES, 'good'].filter((c) => display.perCue[c]) : [];

  return (
    <div>
      <h2 style={sectionTitle}>Detector Check</h2>
      <p style={sectionSub}>Grade the detector against labeled examples.</p>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap' }}>
        <button
          onClick={runCheck}
          disabled={running || gradableCount === 0}
          style={running || gradableCount === 0 ? btnPrimaryDisabled : btnPrimary}
        >
          {running ? 'Checking…' : 'Run check'}
        </button>
        <span style={{ ...muted, fontSize: '14px' }}>
          {gradableCount} gradable of {examples.length} examples
          {examples.some((ex) => ex.source === 'shared') &&
            ` · ${examples.filter((ex) => ex.source === 'shared').length} shared`}
          {noTraceCount > 0 && ` · ${noTraceCount} without trace`}
        </span>
        {(results || recentRun) && (
          <button
            onClick={copyForJett}
            style={{ ...btnSmall, marginLeft: 'auto' }}
          >
            {copied ? 'Copied!' : 'Copy results for Jett'}
          </button>
        )}
      </div>

      {progress && <p style={muted}>{progress}</p>}

      {examples.length === 0 && (
        <p style={muted}>No training examples for this profile yet.</p>
      )}

      {noTraceCount > 0 && (
        <details style={sectionStyle}>
          <summary style={summaryStyle}>
            {noTraceCount} example{noTraceCount === 1 ? '' : 's'} without a trace (skipped)
          </summary>
          <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0 0', fontSize: '14px' }}>
            {examples
              .filter((ex) => getTrace(ex) === null)
              .map((ex) => (
                <li key={`${ex.source}-${ex.id}`} style={{ padding: '4px 0', ...muted }}>
                  {ex.sourceVideoName} · {ex.quality === 'bad' ? (ex.cueCode ?? 'unlabeled') : 'good'} — trace
                  not available{ex.source === 'shared' ? ' · shared' : ''}
                </li>
              ))}
          </ul>
        </details>
      )}

      {display && (
        <>
          <details style={sectionStyle} open>
            <summary style={summaryStyle}>Summary</summary>
            <div style={{ marginTop: '8px', fontSize: '14px' }}>
              <p style={{ margin: '4px 0', color: c.text }}>
                Run: {new Date(display.generatedAt).toLocaleString()}
              </p>
              <p style={{ margin: '4px 0', color: c.text }}>
                Agreement: <strong>{display.agreementPct.toFixed(1)}%</strong> ({display.checkCount}{' '}
                checks, {display.disagreementCount} disagreement
                {display.disagreementCount === 1 ? '' : 's'})
              </p>
              {results && results.skipped > 0 && (
                <p style={{ margin: '4px 0', ...muted }}>
                  Skipped: {results.skipped} (unmappable label or grading error)
                </p>
              )}
            </div>
          </details>

          <details style={sectionStyle} open>
            <summary style={summaryStyle}>Per-cue breakdown</summary>
            <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0 0' }}>
              {cueKeys.map((cue) => {
                const { passed, total } = display.perCue[cue];
                const rate = total > 0 ? (passed / total) * 100 : 0;
                return (
                  <li key={cue} style={{ marginBottom: '10px', fontSize: '14px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span>
                        <span
                          style={{
                            ...faultDot,
                            backgroundColor: cue === 'good' ? c.textFaint : c.fault,
                            marginRight: '8px',
                          }}
                        />
                        <strong style={{ color: c.text }}>{cue === 'good' ? 'good (no fault expected)' : cue}</strong>
                      </span>
                      <span style={muted}>
                        {passed}/{total} ({pct(passed, total)})
                      </span>
                    </div>
                    <div
                      style={{
                        height: '6px',
                        backgroundColor: c.border,
                        borderRadius: '3px',
                        marginTop: '4px',
                      }}
                    >
                      <div
                        style={{
                          height: '100%',
                          width: `${rate}%`,
                          backgroundColor: c.textMuted,
                          borderRadius: '3px',
                        }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          </details>

          <details style={sectionStyle} open>
            <summary style={summaryStyle}>
              Disagreements ({display.disagreementCount})
            </summary>
            {display.disagreementCount === 0 ? (
              <p style={{ ...muted, fontSize: '14px', margin: '8px 0 0 0' }}>
                {results
                  ? 'None — detector matched every label.'
                  : 'No disagreement detail on a saved run; run the check again for the full list.'}
              </p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0 0' }}>
                {display.disagreements.map((d) => (
                  <li
                    key={`${d.source}-${d.exampleId}`}
                    style={{
                      padding: '8px 0',
                      borderTop: `1px solid ${c.border}`,
                      fontSize: '14px',
                    }}
                  >
                    <span style={{ ...faultDot, marginRight: '8px' }} />
                    <strong style={{ color: c.text }}>{d.videoName}</strong>
                    {d.source === 'shared' && <span style={{ ...faint, fontSize: '12px' }}> · shared</span>}
                    <span style={faint}> · expected {d.expected}</span>
                    <span style={faultText}> · detected {d.detected}</span>
                    {d.notes && <div style={{ ...muted, marginTop: '4px' }}>{d.notes}</div>}
                  </li>
                ))}
              </ul>
            )}
          </details>
        </>
      )}
    </div>
  );
}
