import { useEffect, useRef, useState } from 'react';
import { analyzeVideo, type AnalysisResult } from './engine/engine';
import { AuthProvider, useAuth } from './lib/auth';
import { isFirebaseConfigured } from './lib/firebase';
import {
  saveAnalysis,
  saveTrainingExample,
  toCueEventDoc,
  getStoredProfileId,
  DETECTOR_VERSION,
} from './lib/firestore';
import { putVideo } from './lib/videoStore';
import { SignIn } from './components/SignIn';
import { ProfileSwitcher } from './components/ProfileSwitcher';
import { HistoryView } from './components/HistoryView';
import { LibraryView } from './components/LibraryView';
import { TrendsView } from './components/TrendsView';
import { DetectorCheckView } from './components/DetectorCheckView';
import { page, h1, tabBar, tabBtn, btnPrimary, btnPrimaryDisabled, btnQuiet, btnSmall, card, input, select, muted, faint, faultDot, c, hero, heroSub, uploadCard, uploadCardTitle, uploadCardSub, verdict, climberLabel } from './theme';

declare const Pose: any;

const CUE_OPTIONS = ['foot_cut', 'bent_arms', 'sagging_hips', 'hesitation'];
const MAX_UPLOADS = 5;
const MIN_TRIM_WINDOW_MS = 1000;

const VIDEO_LOAD_TIMEOUT_MS = 20_000;
const POSE_INIT_TIMEOUT_MS = 45_000;
const ANALYSIS_TIMEOUT_MS = 180_000;

/** Race a promise against a timeout so a stalled step can't hang the UI forever. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timer));
}

function fmtSec(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Load a video's duration without rendering it. Returns 0 when unknown. */
function loadDurationMs(url: string): Promise<number> {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    const done = (ms: number) => {
      v.src = '';
      resolve(ms);
    };
    const timer = window.setTimeout(() => done(0), VIDEO_LOAD_TIMEOUT_MS);
    v.onloadedmetadata = () => {
      window.clearTimeout(timer);
      const d = v.duration;
      done(Number.isFinite(d) && d > 0 ? Math.round(d * 1000) : 0);
    };
    v.onerror = () => {
      window.clearTimeout(timer);
      done(0);
    };
    v.src = url;
  });
}

type UploadItem = {
  id: string;
  file: File;
  url: string;
  durationMs: number; // 0 = unknown (trim disabled)
  trimStartMs: number;
  trimEndMs: number;
  status: 'queued' | 'analyzing' | 'done' | 'error';
  progress: string;
  progressPct: number | null;
  result: AnalysisResult | null;
  errorMsg: string | null;
};

function isTrimmed(item: UploadItem): boolean {
  return item.durationMs > 0 && (item.trimStartMs > 0 || item.trimEndMs < item.durationMs);
}

/** Per-video trim UI: preview player, start/end sliders, and a window timeline. */
function TrimRow({
  item,
  onTrim,
}: {
  item: UploadItem;
  onTrim: (id: string, startMs: number, endMs: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const dur = item.durationMs;

  function seekTo(ms: number) {
    const v = videoRef.current;
    if (v && Number.isFinite(v.duration)) {
      v.currentTime = Math.min(Math.max(ms / 1000, 0), v.duration);
    }
  }

  function setStart(ms: number) {
    const s = Math.max(0, Math.min(ms, item.trimEndMs - MIN_TRIM_WINDOW_MS));
    onTrim(item.id, Math.round(s), item.trimEndMs);
    seekTo(s);
  }

  function setEnd(ms: number) {
    const e = Math.min(dur, Math.max(ms, item.trimStartMs + MIN_TRIM_WINDOW_MS));
    onTrim(item.id, item.trimStartMs, Math.round(e));
    seekTo(e);
  }

  const startPct = dur > 0 ? (item.trimStartMs / dur) * 100 : 0;
  const endPct = dur > 0 ? (item.trimEndMs / dur) * 100 : 100;

  return (
    <div style={{ ...card, marginBottom: '16px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px' }}>
        <strong style={{ fontSize: '15px', color: c.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.file.name}
        </strong>
        {dur > 0 && <span style={faint}>{fmtSec(dur)}</span>}
      </div>

      <video
        ref={videoRef}
        src={item.url}
        controls
        playsInline
        muted
        preload="metadata"
        style={{
          width: '100%',
          maxHeight: '32vh',
          borderRadius: '10px',
          backgroundColor: '#000',
          marginTop: '12px',
        }}
      />

      {dur > 0 ? (
        <div style={{ marginTop: '12px' }}>
          {/* Window timeline — tap to preview that point */}
          <div
            style={{
              position: 'relative',
              height: '22px',
              backgroundColor: '#2e2e2e',
              borderRadius: '6px',
              cursor: 'pointer',
              marginBottom: '8px',
            }}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const frac = (e.clientX - rect.left) / rect.width;
              seekTo(frac * dur);
            }}
            title="Tap to preview"
          >
            <div
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: `${startPct}%`,
                width: `${Math.max(endPct - startPct, 0)}%`,
                backgroundColor: '#555',
                borderRadius: '6px',
              }}
            />
          </div>
          <label style={{ ...muted, fontSize: '13px', display: 'block', marginBottom: '4px' }}>
            Climb start: {fmtSec(item.trimStartMs)}
            <input
              type="range"
              min={0}
              max={dur}
              step={100}
              value={item.trimStartMs}
              onChange={(e) => setStart(Number(e.target.value))}
              style={{ width: '100%', accentColor: '#888' }}
            />
          </label>
          <label style={{ ...muted, fontSize: '13px', display: 'block' }}>
            Climb end: {fmtSec(item.trimEndMs)}
            <input
              type="range"
              min={0}
              max={dur}
              step={100}
              value={item.trimEndMs}
              onChange={(e) => setEnd(Number(e.target.value))}
              style={{ width: '100%', accentColor: '#888' }}
            />
          </label>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '6px' }}>
            <span style={faint}>
              Analyzing {fmtSec(item.trimStartMs)} – {fmtSec(item.trimEndMs)} (
              {fmtSec(item.trimEndMs - item.trimStartMs)})
            </span>
            {isTrimmed(item) && (
              <button onClick={() => onTrim(item.id, 0, dur)} style={btnSmall}>
                Use full video
              </button>
            )}
          </div>
        </div>
      ) : (
        <p style={{ ...faint, marginTop: '8px' }}>
          Duration unknown — the full video will be analyzed.
        </p>
      )}
    </div>
  );
}

/** Verdict-first result card for one analyzed video (player, fault timeline, fixes, labeling, save). */
function ResultCard({
  item,
  uid,
  profileId,
}: {
  item: UploadItem;
  uid: string | null;
  profileId: string | null;
}) {
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [missTs, setMissTs] = useState('');
  const [missCue, setMissCue] = useState(CUE_OPTIONS[0]);
  const [missSaving, setMissSaving] = useState(false);
  const [missSaved, setMissSaved] = useState(false);
  const [missError, setMissError] = useState<string | null>(null);
  const playbackVideoRef = useRef<HTMLVideoElement>(null);

  const result = item.result;
  if (!result) return null;
  const faultCount = result.cues.length;
  const canSave = isFirebaseConfigured && uid && profileId;
  const trimmed = isTrimmed(item);

  function seekTo(ms: number) {
    const v = playbackVideoRef.current;
    if (v && Number.isFinite(v.duration)) {
      v.currentTime = Math.min(Math.max(ms / 1000, 0), v.duration);
      v.play().catch(() => {});
    }
  }

  async function handleSave() {
    const r = item.result;
    if (!r || !uid || !profileId || saveState === 'saving') return;
    setSaveState('saving');
    try {
      const analysisId = await saveAnalysis(uid, {
        profileId,
        videoName: item.file.name || 'untitled.mp4',
        climbLabel: null,
        attemptTag: null,
        durationMs: item.durationMs,
        grade: null,
        analyzedFrames: r.totalFrames,
        reliableFrames: r.reliableFrames,
        detectorVersion: DETECTOR_VERSION,
        fileFingerprint: null,
        fileSizeBytes: item.file.size,
        cueEvents: r.detectorCues.map(toCueEventDoc),
        traceStoragePath: null,
        trimStartMs: trimmed ? item.trimStartMs : null,
        trimEndMs: trimmed ? item.trimEndMs : null,
      });
      // Keep the video playable in History on this device (local-only).
      void putVideo(analysisId, item.file);
      setSaveState('saved');
    } catch {
      setSaveState('error');
    }
  }

  async function handleMissedSubmit() {
    if (!uid || !profileId || missSaving) return;
    const seconds = parseFloat(missTs);
    if (!Number.isFinite(seconds) || seconds < 0) {
      setMissError('Enter a valid timestamp in seconds.');
      return;
    }
    setMissSaving(true);
    setMissError(null);
    try {
      await saveTrainingExample(uid, {
        profileId,
        sourceVideoName: item.file.name || 'untitled.mp4',
        momentMs: Math.round(seconds * 1000),
        clipStartMs: trimmed ? item.trimStartMs : null,
        clipEndMs: trimmed ? item.trimEndMs : null,
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
      setMissError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setMissSaving(false);
    }
  }

  return (
    <div style={{ ...card, marginBottom: '20px' }}>
      <h2 style={{ ...verdict, fontSize: '30px', margin: '0 0 4px 0' }}>
        {faultCount === 0 ? 'Clean climbing' : `${faultCount} ${faultCount === 1 ? 'fault' : 'faults'}`}
      </h2>
      <p style={{ ...faint, margin: '0 0 12px 0' }}>
        {item.file.name}
        {trimmed && ` · trimmed ${fmtSec(item.trimStartMs)}–${fmtSec(item.trimEndMs)}`}
      </p>

      <video
        ref={playbackVideoRef}
        src={item.url}
        controls
        playsInline
        muted
        style={{
          width: '100%',
          maxHeight: '50vh',
          borderRadius: '12px',
          backgroundColor: '#000',
          marginBottom: '4px',
        }}
      />
      {/* Fault timeline */}
      {faultCount > 0 && item.durationMs > 0 && (
        <div
          style={{
            position: 'relative',
            height: '24px',
            marginTop: '8px',
            backgroundColor: '#2e2e2e',
            borderRadius: '6px',
            cursor: 'pointer',
          }}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const frac = (e.clientX - rect.left) / rect.width;
            seekTo(frac * item.durationMs);
          }}
        >
          {result.cues.map((event: any, i: number) => {
            const midMs = (event.start_ms + event.end_ms) / 2;
            const left = Math.min(Math.max((midMs / item.durationMs) * 100, 0), 100);
            return (
              <span
                key={i}
                title={`${event.title} at ${(midMs / 1000).toFixed(1)}s`}
                onClick={(e) => {
                  e.stopPropagation();
                  seekTo(midMs);
                }}
                style={{
                  ...faultDot,
                  position: 'absolute',
                  left: `calc(${left}% - 5px)`,
                  top: '7px',
                  cursor: 'pointer',
                  width: '10px',
                  height: '10px',
                }}
              />
            );
          })}
        </div>
      )}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          margin: '16px 0 12px 0',
        }}
      >
        <span style={muted}>Fixes</span>
        {canSave && (
          <button
            onClick={handleSave}
            disabled={saveState === 'saving' || saveState === 'saved'}
            style={saveState === 'saved' || saveState === 'saving' ? btnPrimaryDisabled : btnPrimary}
          >
            {saveState === 'saving'
              ? 'Saving…'
              : saveState === 'saved'
                ? 'Saved ✓'
                : saveState === 'error'
                  ? 'Retry save'
                  : 'Save to History'}
          </button>
        )}
      </div>
      {faultCount === 0 ? (
        <p style={muted}>No faults detected.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {result.cues.map((event: any, i: number) => (
            <li
              key={i}
              style={{ ...card, cursor: 'pointer', marginBottom: '10px' }}
              onClick={() => seekTo((event.start_ms + event.end_ms) / 2)}
              title="Tap to jump the video to this fault"
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={faultDot} />
                <h3 style={{ margin: 0, fontSize: '17px', fontWeight: 600, color: '#e8e8e8' }}>
                  {event.title}
                </h3>
              </div>
              <p style={{ ...muted, margin: '8px 0 8px 18px' }}>{event.suggestion}</p>
              <p style={{ ...faint, margin: '0 0 0 18px' }}>
                {(event.start_ms / 1000).toFixed(1)}s – {(event.end_ms / 1000).toFixed(1)}s
              </p>
            </li>
          ))}
        </ul>
      )}
      {canSave ? (
        <div style={{ ...card, marginTop: '16px' }}>
          <p style={{ margin: '0 0 4px 0', fontSize: '15px', fontWeight: 600, color: c.text }}>
            Missed a fix?
          </p>
          <p style={{ ...faint, margin: '0 0 12px 0' }}>
            Log a fault the detector didn't catch — it becomes a training example for the
            detector check.
          </p>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
            <label style={{ fontSize: '14px', ...muted }}>
              Timestamp (s):{' '}
              <input
                type="number"
                min="0"
                step="0.1"
                value={missTs}
                onChange={(e) => {
                  setMissTs(e.target.value);
                  setMissSaved(false);
                }}
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
              onClick={handleMissedSubmit}
              disabled={missSaving}
              style={missSaving ? btnPrimaryDisabled : btnPrimary}
            >
              {missSaving ? 'Saving…' : missSaved ? 'Saved ✓' : 'Save example'}
            </button>
          </div>
          {missError && (
            <p style={{ ...faint, margin: '8px 0 0 0', color: c.fault }}>{missError}</p>
          )}
          {missSaved && !missError && (
            <p style={{ ...faint, margin: '8px 0 0 0' }}>
              Saved as a bad example — it'll show up in Detector Check.
            </p>
          )}
        </div>
      ) : (
        <p style={{ ...faint, marginTop: '12px' }}>
          Sign in and select a profile to label missed faults.
        </p>
      )}
    </div>
  );
}

type Phase = 'idle' | 'trim' | 'analyzing' | 'results';

let itemSeq = 0;

/** Bulk upload + pre-trim + sequential analysis, matching the artifact flow. */
function Analyzer({ uid, profileId }: { uid: string | null; profileId: string | null }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [items, setItems] = useState<UploadItem[]>([]);
  const [batchNote, setBatchNote] = useState<string>('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Revoke all item object URLs on unmount.
  useEffect(() => {
    return () => {
      setItems((prev) => {
        prev.forEach((it) => URL.revokeObjectURL(it.url));
        return prev;
      });
    };
  }, []);

  function resetAll() {
    items.forEach((it) => URL.revokeObjectURL(it.url));
    setItems([]);
    setBatchNote('');
    setPhase('idle');
  }

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    // Replace any previous batch; cap at MAX_UPLOADS.
    items.forEach((it) => URL.revokeObjectURL(it.url));
    const files = Array.from(fileList)
      .filter((f) => f.type.startsWith('video/') || /\.(mp4|mov|webm)$/i.test(f.name))
      .slice(0, MAX_UPLOADS);
    if (files.length === 0) {
      setBatchNote('No video files found in that selection.');
      return;
    }
    const newItems: UploadItem[] = files.map((file) => ({
      id: `up-${++itemSeq}`,
      file,
      url: URL.createObjectURL(file),
      durationMs: 0,
      trimStartMs: 0,
      trimEndMs: 0,
      status: 'queued',
      progress: '',
      progressPct: null,
      result: null,
      errorMsg: null,
    }));
    setItems(newItems);
    setBatchNote(
      fileList.length > MAX_UPLOADS
        ? `Kept the first ${MAX_UPLOADS} videos.`
        : '',
    );
    setPhase('trim');
    // Load durations in the background; trim unlocks per video as they arrive.
    newItems.forEach(async (it) => {
      const dur = await loadDurationMs(it.url);
      setItems((prev) =>
        prev.map((p) =>
          p.id === it.id
            ? { ...p, durationMs: dur, trimStartMs: 0, trimEndMs: dur }
            : p,
        ),
      );
    });
  }

  function handleTrim(id: string, startMs: number, endMs: number) {
    setItems((prev) => prev.map((p) => (p.id === id ? { ...p, trimStartMs: startMs, trimEndMs: endMs } : p)));
  }

  function setItem(id: string, patch: Partial<UploadItem>) {
    setItems((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  async function analyzeOne(item: UploadItem, pose: any, index: number, total: number) {
    const video = videoRef.current;
    if (!video) throw new Error('Video element not ready.');
    setItem(item.id, { status: 'analyzing', progressPct: 0, progress: 'Loading video…', errorMsg: null });
    video.src = item.url;
    video.load();
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        video.onloadeddata = () => resolve();
        video.onerror = () => reject(new Error('Could not load that video file.'));
      }),
      VIDEO_LOAD_TIMEOUT_MS,
      'Loading the video took too long. Try a shorter clip.',
    );
    const trimmed = isTrimmed({ ...item });
    const window = trimmed
      ? { startSeconds: item.trimStartMs / 1000, endSeconds: item.trimEndMs / 1000 }
      : undefined;
    const analysisResult = await withTimeout(
      analyzeVideo(video, pose, (pct, detail) => {
        // engine reports pct as 0–100.
        setItem(item.id, {
          progress: `Analyzing ${index + 1} of ${total} — ${Math.round(pct)}% — ${detail}`,
          progressPct: pct / 100,
        });
      }, undefined, window),
      ANALYSIS_TIMEOUT_MS,
      'Analysis timed out. Try a shorter video clip.',
    );
    setItem(item.id, { status: 'done', result: analysisResult, progress: 'Done!', progressPct: 1 });
  }

  async function handleAnalyzeAll() {
    if (items.length === 0) return;
    if (typeof Pose === 'undefined') {
      setBatchNote("Couldn't load the pose detector. Check your connection and reload the page.");
      return;
    }
    setPhase('analyzing');
    setBatchNote('');
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    let pose: any = null;
    try {
      // Initialize the pose model once for the whole batch (~15 MB download).
      setItems((prev) =>
        prev.map((p) => ({ ...p, progress: 'Loading pose model…' })),
      );
      pose = new Pose({
        locateFile: (f: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${f}`,
      });
      pose.setOptions({
        modelComplexity: isMobile ? 0 : 1,
        smoothLandmarks: true,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      await withTimeout(
        pose.initialize(),
        POSE_INIT_TIMEOUT_MS,
        'Loading the pose model timed out. Check your connection and try again.',
      );
      // Analyze sequentially — safer on mobile.
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        try {
          await analyzeOne(item, pose, i, items.length);
        } catch (error) {
          setItem(item.id, {
            status: 'error',
            errorMsg: error instanceof Error ? error.message : 'Something went wrong during analysis.',
            progress: '',
            progressPct: null,
          });
        }
      }
    } catch (error) {
      // Pose init failed: mark everything errored.
      const msg = error instanceof Error ? error.message : 'Could not start analysis.';
      setItems((prev) => prev.map((p) => ({ ...p, status: 'error' as const, errorMsg: msg })));
    } finally {
      if (pose) {
        try {
          await pose.close();
        } catch {
          /* ignore cleanup failures */
        }
      }
      setPhase('results');
    }
  }

  const analyzingItem = items.find((it) => it.status === 'analyzing');
  const doneCount = items.filter((it) => it.status === 'done').length;
  const errorCount = items.filter((it) => it.status === 'error').length;

  return (
    <div>
      <input
        ref={fileInputRef}
        type="file"
        accept="video/*,.mp4,.mov,.webm"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = '';
        }}
      />

      {/* Hidden analysis video (offscreen, never display:none for iOS decode). */}
      <video
        ref={videoRef}
        muted
        playsInline
        preload="auto"
        style={{
          position: 'absolute',
          left: '-9999px',
          width: '2px',
          height: '2px',
          opacity: 0,
          pointerEvents: 'none',
        }}
      />

      {/* Hero — artifact-style upload prompt */}
      {phase === 'idle' && (
        <>
          <h2 style={hero}>Upload climbs</h2>
          <p style={heroSub}>
            Add up to five separate climbs or attempts. Trim setup and stopping time before
            analysis.
          </p>
          <button onClick={() => fileInputRef.current?.click()} style={uploadCard}>
            <div style={{ fontSize: '40px', color: c.textMuted, lineHeight: 1 }}>+</div>
            <p style={uploadCardTitle}>Choose climb videos</p>
            <p style={uploadCardSub}>Up to 5 separate climbs · MP4, MOV, or WebM</p>
          </button>
          {batchNote && <p style={{ ...faint, marginTop: '12px' }}>{batchNote}</p>}
        </>
      )}

      {/* Trim step */}
      {phase === 'trim' && (
        <>
          <h2 style={hero}>Trim climbs</h2>
          <p style={heroSub}>
            Set the climb start and end for each video — setup and stopping time get cut
            before analysis.
          </p>
          {items.map((it) => (
            <TrimRow key={it.id} item={it} onTrim={handleTrim} />
          ))}
          {batchNote && <p style={{ ...faint, marginBottom: '12px' }}>{batchNote}</p>}
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginTop: '8px' }}>
            <button onClick={handleAnalyzeAll} style={btnPrimary}>
              Analyze {items.length} video{items.length === 1 ? '' : 's'}
            </button>
            <button onClick={resetAll} style={btnQuiet}>
              Choose different videos
            </button>
          </div>
        </>
      )}

      {/* Batch analysis progress */}
      {phase === 'analyzing' && (
        <div style={{ marginTop: '8px' }}>
          <h2 style={hero}>Analyzing…</h2>
          <p style={heroSub}>
            {doneCount} of {items.length} done{errorCount > 0 ? ` · ${errorCount} failed` : ''}
          </p>
          {items.map((it) => (
            <div key={it.id} style={{ ...card, marginBottom: '10px', padding: '12px 16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'baseline' }}>
                <strong style={{ fontSize: '14px', color: c.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {it.file.name}
                </strong>
                <span style={faint}>
                  {it.status === 'done' ? '✓' : it.status === 'error' ? '⚠' : it.status === 'analyzing' ? '…' : '·'}
                </span>
              </div>
              {it.status === 'analyzing' && (
                <div style={{ marginTop: '8px' }}>
                  <div
                    style={{
                      height: '4px',
                      backgroundColor: '#2e2e2e',
                      borderRadius: '2px',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        height: '100%',
                        width: it.progressPct == null ? '30%' : `${Math.round(it.progressPct * 100)}%`,
                        backgroundColor: '#888',
                        borderRadius: '2px',
                        transition: 'width 0.2s',
                        ...(it.progressPct == null
                          ? { animation: 'indeterminate-slide 1.2s linear infinite' }
                          : {}),
                      }}
                    />
                  </div>
                  {it.progress && <p style={{ ...muted, marginTop: '6px', fontSize: '13px' }}>{it.progress}</p>}
                </div>
              )}
              {it.status === 'error' && it.errorMsg && (
                <p style={{ ...muted, marginTop: '6px', fontSize: '13px' }}>⚠ {it.errorMsg}</p>
              )}
            </div>
          ))}
          {analyzingItem == null && <p style={muted}>Wrapping up…</p>}
        </div>
      )}

      {/* Results */}
      {phase === 'results' && (
        <>
          <h2 style={hero}>
            {doneCount === 0 ? 'No results' : doneCount === 1 ? 'Result' : `${doneCount} results`}
          </h2>
          <p style={heroSub}>
            {doneCount} of {items.length} analyzed
            {errorCount > 0 ? ` · ${errorCount} failed` : ''}
          </p>
          {items
            .filter((it) => it.status === 'done')
            .map((it) => (
              <ResultCard key={it.id} item={it} uid={uid} profileId={profileId} />
            ))}
          {items
            .filter((it) => it.status === 'error')
            .map((it) => (
              <div key={it.id} style={{ ...card, marginBottom: '12px' }}>
                <strong style={{ fontSize: '14px', color: c.text }}>{it.file.name}</strong>
                <p style={{ ...muted, marginTop: '6px' }}>⚠ {it.errorMsg || 'Analysis failed.'}</p>
              </div>
            ))}
          <div style={{ marginTop: '8px', textAlign: 'center', display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap' }}>
            <button onClick={resetAll} style={btnQuiet}>
              Analyze more videos
            </button>
          </div>
        </>
      )}
    </div>
  );
}

type Tab = 'analyze' | 'history' | 'library' | 'trends' | 'detector';

function MainApp({ uid }: { uid: string }) {
  const { signOut } = useAuth();
  const [tab, setTab] = useState<Tab>('analyze');
  const [profileId, setProfileId] = useState<string | null>(() => getStoredProfileId());
  const [profileName, setProfileName] = useState<string>('');

  return (
    <div style={page}>
      {/* Header: centered title */}
      <div style={{ textAlign: 'center', marginBottom: '4px' }}>
        <h1 style={{ ...h1, fontSize: '22px' }}>Climbing Coach</h1>
      </div>

      {/* Climber row: CLIMBER [Name] + sign out */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '12px',
          marginBottom: '4px',
          flexWrap: 'wrap',
        }}
      >
        <span style={climberLabel}>Climber</span>
        <ProfileSwitcher
          uid={uid}
          profileId={profileId}
          onSelect={(id, name) => {
            setProfileId(id);
            setProfileName(name || '');
          }}
        />
        <button onClick={signOut} style={{ ...btnQuiet, padding: '6px 10px', fontSize: '12px' }}>
          Sign out
        </button>
      </div>
      {profileName && (
        <p style={{ ...faint, textAlign: 'center', margin: '0 0 8px 0' }}>
          Saving to {profileName}'s history
        </p>
      )}

      <div style={tabBar}>
        <button onClick={() => setTab('analyze')} style={tabBtn(tab === 'analyze')}>
          Analyze
        </button>
        <button onClick={() => setTab('history')} style={tabBtn(tab === 'history')}>
          History
        </button>
        <button onClick={() => setTab('library')} style={tabBtn(tab === 'library')}>
          Library
        </button>
        <button onClick={() => setTab('trends')} style={tabBtn(tab === 'trends')}>
          Trends
        </button>
        <button onClick={() => setTab('detector')} style={tabBtn(tab === 'detector')}>
          Detector Check
        </button>
      </div>

      {tab === 'analyze' && <Analyzer uid={uid} profileId={profileId} />}
      {tab === 'history' &&
        (profileId ? (
          <HistoryView uid={uid} profileId={profileId} />
        ) : (
          <p style={muted}>Select a profile to view history.</p>
        ))}
      {tab === 'library' &&
        (profileId ? (
          <LibraryView uid={uid} profileId={profileId} />
        ) : (
          <p style={muted}>Select a profile to view the library.</p>
        ))}
      {tab === 'trends' &&
        (profileId ? (
          <TrendsView uid={uid} profileId={profileId} />
        ) : (
          <p style={muted}>Sign in and select a profile to view trends.</p>
        ))}
      {tab === 'detector' &&
        (profileId ? (
          <DetectorCheckView uid={uid} profileId={profileId} />
        ) : (
          <p style={muted}>Sign in and select a profile to run the detector check.</p>
        ))}
    </div>
  );
}

function Shell() {
  const { user, loading } = useAuth();

  // Local-only mode: Firebase not configured, original behavior.
  if (!isFirebaseConfigured) {
    return (
      <div style={page}>
        <h1 style={h1}>Climbing Coach</h1>
        <Analyzer uid={null} profileId={null} />
      </div>
    );
  }

  if (loading) {
    return (
      <div style={page}>
        <p style={muted}>Loading…</p>
      </div>
    );
  }

  if (!user) return <SignIn />;

  return <MainApp uid={user.uid} />;
}

function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}

export default App;
