import { collection, doc, query, where, getDoc, getDocs, addDoc, updateDoc } from 'firebase/firestore';
import { db } from './firebase';
import type {
  ProfileDoc,
  AnalysisDoc,
  TrainingExampleDoc,
  CueEventDoc,
  DetectorCheckRunSaveDoc,
} from './db-models';
import type { CueEvent } from '../engine/engine';

/** Bump when the detector engine changes so saved analyses stay comparable. */
export const DETECTOR_VERSION = 'web-2026-10-14';

export type DocWithId<T> = T & { id: string };

const PROFILE_STORAGE_KEY = 'cc-profile-id';

function userCol(uid: string, name: string) {
  if (!db) throw new Error('Firestore is not configured');
  return collection(db, 'users', uid, name);
}

export async function listProfiles(uid: string): Promise<DocWithId<ProfileDoc>[]> {
  const snap = await getDocs(userCol(uid, 'profiles'));
  const docs = snap.docs.map((d) => ({ id: d.id, ...(d.data() as ProfileDoc) }));
  docs.sort((a, b) => a.name.localeCompare(b.name));
  return docs;
}

export async function listAnalyses(
  uid: string,
  profileId: string,
): Promise<DocWithId<AnalysisDoc>[]> {
  const q = query(userCol(uid, 'analyses'), where('profileId', '==', profileId));
  const snap = await getDocs(q);
  const docs = snap.docs.map((d) => ({ id: d.id, ...(d.data() as AnalysisDoc) }));
  docs.sort((a, b) => b.createdAt - a.createdAt);
  return docs;
}

export async function listTrainingExamples(
  uid: string,
  profileId?: string,
): Promise<DocWithId<TrainingExampleDoc>[]> {
  const col = userCol(uid, 'trainingExamples');
  const q = profileId ? query(col, where('profileId', '==', profileId)) : query(col);
  const snap = await getDocs(q);
  const docs = snap.docs.map((d) => ({ id: d.id, ...(d.data() as TrainingExampleDoc) }));
  docs.sort((a, b) => b.createdAt - a.createdAt);
  return docs;
}

/**
 * The shared training corpus: labels visible to every signed-in user.
 * Read-only from the app (rules deny writes); populated by admin migration.
 */
export async function listSharedTrainingExamples(
  profileId?: string,
): Promise<DocWithId<TrainingExampleDoc>[]> {
  if (!db) throw new Error('Firestore is not configured');
  const col = collection(db, 'sharedTrainingExamples');
  const q = profileId ? query(col, where('profileId', '==', profileId)) : query(col);
  const snap = await getDocs(q);
  const docs = snap.docs.map((d) => ({ id: d.id, ...(d.data() as TrainingExampleDoc) }));
  docs.sort((a, b) => b.createdAt - a.createdAt);
  return docs;
}

/** A training example tagged with where it came from. */
export type ExampleSource = 'shared' | 'mine';
export type ExampleWithSource = DocWithId<TrainingExampleDoc> & { source: ExampleSource };

/**
 * Combine the shared corpus with the user's own labels.
 * Per-user labels win on ID overlap (a user may have re-labeled a copy).
 */
export function mergeExamples(
  shared: DocWithId<TrainingExampleDoc>[],
  mine: DocWithId<TrainingExampleDoc>[],
): ExampleWithSource[] {
  const byId = new Map<string, ExampleWithSource>();
  for (const ex of shared) byId.set(ex.id, { ...ex, source: 'shared' });
  for (const ex of mine) byId.set(ex.id, { ...ex, source: 'mine' });
  const docs = [...byId.values()];
  docs.sort((a, b) => b.createdAt - a.createdAt);
  return docs;
}

/** Map the engine's snake_case CueEvent to the Firestore camelCase doc. */
export function toCueEventDoc(e: CueEvent): CueEventDoc {
  return {
    code: e.code,
    title: e.title,
    suggestion: e.suggestion,
    severity: e.severity,
    durationMs: e.duration_ms,
    startMs: e.start_ms,
    endMs: e.end_ms,
    peakMs: e.peak_ms,
    jointName: e.joint_name,
    side: e.side,
    isFused: e.is_fused,
  };
}

export type NewAnalysis = Omit<AnalysisDoc, 'createdAt' | 'cueEvents'> & {
  cueEvents: CueEventDoc[];
};

export async function saveAnalysis(uid: string, doc: NewAnalysis): Promise<string> {
  const ref = await addDoc(userCol(uid, 'analyses'), { ...doc, createdAt: Date.now() });
  return ref.id;
}

/** Create a training example (e.g. fix-feedback from History, or a label save). */
export type NewTrainingExample = Omit<TrainingExampleDoc, 'createdAt'>;

export async function saveTrainingExample(
  uid: string,
  doc: NewTrainingExample,
): Promise<string> {
  const ref = await addDoc(userCol(uid, 'trainingExamples'), {
    ...doc,
    createdAt: Date.now(),
  });
  return ref.id;
}

/** Persist a detector-check run summary for agreement trends over time. */
export type NewDetectorCheckRun = Omit<DetectorCheckRunSaveDoc, 'generatedAt'>;

export async function saveDetectorCheckRun(
  uid: string,
  run: NewDetectorCheckRun,
): Promise<string> {
  const ref = await addDoc(userCol(uid, 'detectorCheckRuns'), {
    ...run,
    generatedAt: Date.now(),
  });
  return ref.id;
}

export async function listDetectorCheckRuns(
  uid: string,
  profileId: string,
): Promise<DocWithId<DetectorCheckRunSaveDoc>[]> {
  const q = query(userCol(uid, 'detectorCheckRuns'), where('profileId', '==', profileId));
  const snap = await getDocs(q);
  const docs = snap.docs.map((d) => ({ id: d.id, ...(d.data() as DetectorCheckRunSaveDoc) }));
  docs.sort((a, b) => b.generatedAt - a.generatedAt);
  return docs;
}

/**
 * Flip the dismissed flag on one embedded cue event of an analysis.
 * Cue events are embedded in the analysis doc, so this rewrites the array.
 */
export async function setCueEventDismissed(
  uid: string,
  analysisId: string,
  eventIndex: number,
  dismissed: boolean,
): Promise<void> {
  const ref = doc(userCol(uid, 'analyses'), analysisId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('Analysis not found');
  const data = snap.data() as AnalysisDoc;
  const cueEvents = [...data.cueEvents];
  const target = cueEvents[eventIndex];
  if (!target) throw new Error('Cue event not found');
  const updated: CueEventDoc = { ...target, dismissed };
  if (dismissed) {
    updated.dismissedAt = Date.now();
  } else {
    delete updated.dismissedAt;
  }
  await updateDoc(ref, { cueEvents });
}

export function getStoredProfileId(): string | null {
  try {
    return localStorage.getItem(PROFILE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredProfileId(id: string) {
  try {
    localStorage.setItem(PROFILE_STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
}
