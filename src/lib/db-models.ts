/**
 * Firestore data model for climbing-coach-web.
 *
 * Layout: every collection lives under `users/{uid}/...` so security rules can
 * scope all reads/writes to the signed-in user. IDs are Firestore auto-IDs
 * (strings); `legacyId` preserves the artifact SQLite row id for traceability.
 *
 * All timestamps are epoch millis (matching the artifact's `created_at`
 * integer convention) rather than Firestore Timestamps, keeping docs
 * JSON-serializable and portable.
 */

/** Active detector cue codes. Legacy labels may still reference retired codes. */
export type CueCode = 'foot_cut' | 'bent_arms' | 'sagging_hips' | 'hesitation';

/** Retired codes that can appear on historical labels. */
export type LegacyCueCode = 'static_lockoff' | 'hand_readjustments';

export type AnyCueCode = CueCode | LegacyCueCode | string;

export type ExampleQuality = 'good' | 'bad';

export type CandidateStatus = 'pending' | 'saved' | 'skipped' | 'dismissed';

/** Climber profile (Jon, Kai, ...). Mirrors artifact `profiles`. */
export type ProfileDoc = {
  name: string;
  createdAt: number;
  legacyId?: number;
};

/** A detected fault on an analyzed climb. Mirrors artifact `cue_events`. */
export type CueEventDoc = {
  code: AnyCueCode;
  title: string;
  suggestion: string;
  severity: number;
  durationMs: number;
  startMs: number;
  endMs: number;
  peakMs: number;
  jointName: string | null;
  side: string | null;
  isFused: boolean;
  /** User-flagged "not a fault"; hidden from counts but kept for audit. */
  dismissed?: boolean;
  dismissedAt?: number;
};

/**
 * One analyzed climb attempt. Mirrors artifact `analyses`.
 *
 * Cue events are embedded (not a subcollection): they are always read with
 * the analysis and number in the single digits, so one read fetches everything.
 * The full pose trace is too large for a Firestore doc (1MB limit) and lives
 * in Storage; `traceStoragePath` points at it when present.
 */
export type AnalysisDoc = {
  profileId: string;
  videoName: string;
  climbLabel: string | null;
  attemptTag: string | null;
  durationMs: number;
  grade: number | null;
  analyzedFrames: number;
  reliableFrames: number;
  detectorVersion: string;
  fileFingerprint: string | null;
  fileSizeBytes: number | null;
  cueEvents: CueEventDoc[];
  traceStoragePath: string | null;
  createdAt: number;
  legacyId?: number;
  /**
   * Pre-analysis trim window (absolute video ms). When set, only this portion
   * was analyzed; cue event timestamps remain absolute video times so the
   * fault timeline still lines up with full-video playback.
   */
  trimStartMs?: number | null;
  trimEndMs?: number | null;
};

/**
 * A labeled training clip. Mirrors artifact `training_examples`.
 * Media lives in Storage; the doc stores paths (resolved to download URLs at
 * read time via getDownloadURL).
 */
export type TrainingExampleDoc = {
  profileId: string;
  sourceVideoName: string;
  momentMs: number;
  clipStartMs: number | null;
  clipEndMs: number | null;
  quality: ExampleQuality;
  /** Labeled cue; null means "not a fault" (GOOD example). */
  cueCode: AnyCueCode | null;
  suggestedCue: AnyCueCode | null;
  notes: string;
  imageStoragePath: string | null;
  clipStoragePath: string | null;
  source: string | null;
  createdAt: number;
  legacyId?: number;
  /**
   * Pose trace for the detector check (sampled frames, same shape as the
   * engine's GradingSample). Backfilled by a separate migration; absent until
   * then, in which case the detector check skips the example.
   */
  trace?: {
    time_s: number;
    landmarks: { index: number; x: number; y: number; z?: number; visibility?: number }[];
  }[] | null;
};

/**
 * A label candidate awaiting Jon's Save/Skip. Mirrors artifact
 * `pending_label_candidates`.
 */
export type LabelCandidateDoc = {
  profileId: string;
  sourceVideoName: string;
  sourceVideoFingerprint: string;
  cueCode: AnyCueCode;
  quality: ExampleQuality;
  momentMs: number;
  startMs: number;
  endMs: number;
  confidencePpm: number;
  sectionKey: string | null;
  imageStoragePath: string | null;
  clipStoragePath: string | null;
  status: CandidateStatus;
  createdAt: number;
  legacyId?: number;
};

/**
 * Persisted summary of a Detector Check run (what the task's
 * `detectorCheckRuns` collection stores). The full per-example results are
 * ephemeral to the run UI; this doc keeps the trend-worthy summary.
 */
export type DetectorCheckRunSaveDoc = {
  profileId: string;
  detectorVersion: string;
  generatedAt: number;
  agreementPct: number;
  perCue: Record<string, { passed: number; total: number }>;
  disagreementCount: number;
  checkCount: number;
};

/** Storage layout (paths stored in the docs above). */

export type DetectorCheckResult = {
  exampleId: string;
  cueCode: AnyCueCode;
  /** 'good' | 'bad' label on the example. */
  expected: ExampleQuality;
  detectedCues: AnyCueCode[];
  hit: boolean;
};

/**
 * One Detector Check run over the shared label corpus. There is no equivalent
 * table in the artifact (results were ephemeral); persisted here so agreement
 * trends are visible over time.
 */
export type DetectorCheckRunDoc = {
  detectorVersion: string;
  totalChecks: number;
  hits: number;
  agreementPct: number;
  perCue: Record<string, { checks: number; hits: number }>;
  results: DetectorCheckResult[];
  createdAt: number;
};

/** Storage layout (paths stored in the docs above). */
