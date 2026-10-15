import { useEffect, useRef, useState } from 'react';
import {
  listAnalyses,
  listProfiles,
  saveTrainingExample,
  setCueEventDismissed,
  type DocWithId,
} from '../lib/firestore';
import { getVideo } from '../lib/videoStore';
import type { AnalysisDoc, CueEventDoc } from '../lib/db-models';
import { btnSmall, btnPrimary, btnPrimaryDisabled, card, input, select, muted, faint, faultDot, faultText, c, sectionTitle, sectionSub } from '../theme';

type Props = {
  uid: string;
  profileId: string;
};

const CUE_OPTIONS = ['foot_cut', 'bent_arms', 'sagging_hips', 'hesitation'];

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function fmtTime(ms: number): string {
  return (ms / 1000).toFixed(1) + 's';
}

/** Cue events the user hasn't dismissed; these drive counts and the UI. */
function visibleEvents(a: DocWithId<AnalysisDoc>): { event: CueEventDoc; index: number }[] {
  return a.cueEvents
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => !event.dismissed);
}

const smallBtn: React.CSSProperties = btnSmall;

export function HistoryView({ uid, profileId }: Props) {
  const [analyses, setAnalyses] = useState<DocWithId<AnalysisDoc>[] | null>(null);
  const [profileName, setProfileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [dismissBusy, setDismissBusy] = useState<Set<string>>(new Set());
  const [missedFor, setMissedFor] = useState<string | null>(null);
  const [missTs, setMissTs] = useState('');
  const [missCue, setMissCue] = useState(CUE_OPTIONS[0]);
  const [missSaving, setMissSaving] = useState(false);
  const [missSaved, setMissSaved] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // Browser-local video playback (IndexedDB, keyed by analysis id).
  const [videoUrls, setVideoUrls] = useState<Record<string, string>>({});
  const [videoMissing, setVideoMissing] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setAnalyses(null);
    setError(null);
    Promise.all([listAnalyses(uid, profileId), listProfiles(uid)])
      .then(([docs, profiles]) => {
        if (cancelled) return;
        setAnalyses(docs);
        setProfileName(profiles.find((p) => p.id === profileId)?.name ?? null);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load history');
      });
    return () => {
      cancelled = true;
    };
  }, [uid, profileId]);

  // Load the locally stored video when an analysis is expanded.
  // Guarded by a ref so state updates from the fetch don't retrigger it.
  const videoLoadKey = useRef<string | null>(null);
  useEffect(() => {
    if (!expanded || videoLoadKey.current === expanded) return;
    videoLoadKey.current = expanded;
    const key = expanded;
    let cancelled = false;
    let url: string | null = null;
    getVideo(key)
      .then((blob) => {
        if (cancelled) return;
        if (blob) {
          url = URL.createObjectURL(blob);
          const finalUrl: string = url;
          setVideoUrls((prev) => ({ ...prev, [key]: finalUrl }));
        } else {
          setVideoMissing((prev) => new Set(prev).add(key));
        }
      })
      .catch(() => {
        if (!cancelled) setVideoMissing((prev) => new Set(prev).add(key));
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
      if (videoLoadKey.current === key) videoLoadKey.current = null;
      setVideoUrls((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
    };
  }, [expanded]);

  async function handleDismiss(a: DocWithId<AnalysisDoc>, eventIndex: number) {
    const key = `${a.id}:${eventIndex}`;
    if (dismissBusy.has(key)) return;
    setDismissBusy((prev) => new Set(prev).add(key));
    try {
      await setCueEventDismissed(uid, a.id, eventIndex, true);
      setAnalyses((prev) =>
        prev
          ? prev.map((x) =>
              x.id === a.id
                ? {
                    ...x,
                    cueEvents: x.cueEvents.map((e, i) =>
                      i === eventIndex ? { ...e, dismissed: true, dismissedAt: Date.now() } : e,
                    ),
                  }
                : x,
            )
          : prev,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Dismiss failed');
    } finally {
      setDismissBusy((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  function openMissedForm(a: DocWithId<AnalysisDoc>) {
    setMissedFor(a.id);
    setMissTs('');
    setMissCue(CUE_OPTIONS[0]);
    setMissSaved(false);
  }

  async function handleMissedSubmit(a: DocWithId<AnalysisDoc>) {
    const seconds = parseFloat(missTs);
    if (!Number.isFinite(seconds) || seconds < 0) {
      setError('Enter a valid timestamp in seconds.');
      return;
    }
    setMissSaving(true);
    try {
      await saveTrainingExample(uid, {
        profileId,
        sourceVideoName: a.videoName,
        momentMs: Math.round(seconds * 1000),
        clipStartMs: null,
        clipEndMs: null,
        quality: 'bad',
        cueCode: missCue,
        suggestedCue: null,
        notes: '',
        imageStoragePath: null,
        clipStoragePath: null,
        source: 'fix-feedback',
      });
      setMissSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setMissSaving(false);
    }
  }

  async function handleCopy(a: DocWithId<AnalysisDoc>) {
    const visible = visibleEvents(a);
    const dismissedCount = a.cueEvents.length - visible.length;
    const lines: string[] = [
      'Climbing Coach — analysis summary for Jett',
      `Video: ${a.videoName}`,
      `Date: ${fmtDate(a.createdAt)}`,
      `Profile: ${profileName ?? profileId}`,
      `Detector: ${a.detectorVersion}`,
      visible.length === 0
        ? `Faults: none${dismissedCount > 0 ? ` (${dismissedCount} dismissed)` : ''}`
        : `Faults (${visible.length}${dismissedCount > 0 ? `, ${dismissedCount} dismissed` : ''}):`,
    ];
    for (const { event: e } of visible) {
      lines.push(
        `- ${e.title} [${e.code}] ${fmtTime(e.startMs)}–${fmtTime(e.endMs)}, severity ${e.severity}/5`,
      );
      if (e.suggestion) lines.push(`  Fix: ${e.suggestion}`);
    }
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopiedId(a.id);
      setTimeout(() => setCopiedId((prev) => (prev === a.id ? null : prev)), 2000);
    } catch {
      setError('Clipboard unavailable — copy failed');
    }
  }

  if (error) return <p style={faultText}>{error}</p>;
  if (analyses === null) return <p style={muted}>Loading history…</p>;
  if (analyses.length === 0) return <p style={muted}>No saved analyses yet.</p>;

  return (
    <div>
      <h2 style={sectionTitle}>History</h2>
      <p style={sectionSub}>Your past analyses.</p>
    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {analyses.map((a) => {
        const isOpen = expanded === a.id;
        const visible = visibleEvents(a);
        const topCues = [...new Set(visible.map(({ event }) => event.code))].slice(0, 3);
        return (
          <li
            key={a.id}
            style={{
              ...card,
              cursor: 'pointer',
            }}
            onClick={() => setExpanded(isOpen ? null : a.id)}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <strong style={{ fontSize: '15px', color: c.text }}>{a.videoName}</strong>
              <span style={{ ...faint }}>{fmtDate(a.createdAt)}</span>
            </div>
            <div style={{ marginTop: '6px', fontSize: '14px', ...muted }}>
              {visible.length === 0 ? (
                <span>Clean — no faults</span>
              ) : (
                <span>
                  <span style={{ ...faultDot, marginRight: '6px' }} />
                  {visible.length} fault{visible.length === 1 ? '' : 's'}
                  {topCues.length > 0 && (
                    <span style={{ color: c.textFaint }}> · {topCues.join(', ')}</span>
                  )}
                </span>
              )}
            </div>
            {isOpen && (
              <div onClick={(e) => e.stopPropagation()}>
                {videoUrls[a.id] ? (
                  <>
                    <video
                      src={videoUrls[a.id]}
                      controls
                      playsInline
                      muted
                      onLoadedMetadata={(e) => {
                        // Jump to the trimmed climb start when this analysis was trimmed.
                        if (a.trimStartMs != null && a.trimStartMs > 0) {
                          e.currentTarget.currentTime = a.trimStartMs / 1000;
                        }
                      }}
                      style={{
                        width: '100%',
                        maxHeight: '40vh',
                        borderRadius: '10px',
                        backgroundColor: '#000',
                        marginBottom: '8px',
                      }}
                    />
                    {a.trimStartMs != null && a.trimEndMs != null && (
                      <p style={{ ...faint, margin: '0 0 8px 0' }}>
                        Trimmed clip: {fmtTime(a.trimStartMs)}–{fmtTime(a.trimEndMs)} of the full
                        video.
                      </p>
                    )}
                  </>
                ) : videoMissing.has(a.id) ? (
                  <p style={{ ...faint, margin: '0 0 8px 0' }}>
                    Video not available on this device — clips are stored locally where they were
                    analyzed.
                  </p>
                ) : (
                  <p style={{ ...faint, margin: '0 0 8px 0' }}>Loading video…</p>
                )}
                {visible.length > 0 && (
                  <ul style={{ listStyle: 'none', padding: 0, margin: '10px 0 0 0' }}>
                    {visible.map(({ event: e, index }) => {
                      const key = `${a.id}:${index}`;
                      return (
                        <li
                          key={index}
                          style={{
                            padding: '8px 0',
                            borderTop: `1px solid ${c.border}`,
                            fontSize: '14px',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
                            <span style={faultDot} />
                            <strong style={{ color: c.text }}>{e.title}</strong>
                            <button
                              onClick={() => handleDismiss(a, index)}
                              disabled={dismissBusy.has(key)}
                              style={{ ...smallBtn, marginLeft: 'auto' }}
                            >
                              {dismissBusy.has(key) ? 'Dismissing…' : 'Not a fault'}
                            </button>
                          </div>
                          <span style={{ ...faint }}>
                            {' '}
                            · {fmtTime(e.startMs)}–{fmtTime(e.endMs)} · severity {e.severity}/5
                          </span>
                          {e.suggestion && (
                            <div style={{ ...muted, marginTop: '4px', paddingLeft: '16px' }}>
                              {e.suggestion}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                <div
                  style={{
                    display: 'flex',
                    gap: '8px',
                    marginTop: '12px',
                    flexWrap: 'wrap',
                    borderTop: `1px solid ${c.border}`,
                    paddingTop: '12px',
                  }}
                >
                  <button onClick={() => openMissedForm(a)} style={smallBtn}>
                    Missed a fix?
                  </button>
                  <button onClick={() => handleCopy(a)} style={smallBtn}>
                    {copiedId === a.id ? 'Copied!' : 'Copy for Jett'}
                  </button>
                </div>
                {missedFor === a.id && (
                  <div
                    style={{
                      marginTop: '12px',
                      ...card,
                    }}
                  >
                    <p style={{ margin: '0 0 8px 0', fontSize: '14px', fontWeight: 600, color: c.text }}>
                      Log a missed fault
                    </p>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                      <label style={{ fontSize: '14px', ...muted }}>
                        Timestamp (s):{' '}
                        <input
                          type="number"
                          min="0"
                          step="0.1"
                          value={missTs}
                          onChange={(e) => setMissTs(e.target.value)}
                          placeholder="e.g. 12.5"
                          style={{ ...input, width: '100px' }}
                        />
                      </label>
                      <label style={{ fontSize: '14px', ...muted }}>
                        Cue:{' '}
                        <select
                          value={missCue}
                          onChange={(e) => setMissCue(e.target.value)}
                          style={select}
                        >
                          {CUE_OPTIONS.map((cm) => (
                            <option key={cm} value={cm}>
                              {cm}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        onClick={() => handleMissedSubmit(a)}
                        disabled={missSaving}
                        style={missSaving ? btnPrimaryDisabled : btnPrimary}
                      >
                        {missSaving ? 'Saving…' : missSaved ? 'Saved ✓' : 'Save example'}
                      </button>
                      <button
                        onClick={() => setMissedFor(null)}
                        style={smallBtn}
                      >
                        Cancel
                      </button>
                    </div>
                    {missSaved && (
                      <p style={{ ...faint, margin: '8px 0 0 0' }}>
                        Saved as a bad example (source: fix-feedback) for the detector check.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
    </div>
  );
}
