#!/usr/bin/env bun
/**
 * One-shot migration: artifact database -> Firestore + Firebase Storage.
 *
 * Reads the artifact's SQLite database directly (via bun:sqlite) or a JSON
 * dump with the same table names, then writes:
 *   Firestore  users/{uid}/profiles, analyses (cue events embedded),
 *              trainingExamples, labelCandidates
 *   Storage    users/{uid}/images/*, users/{uid}/clips/*, users/{uid}/traces/*
 *
 * Usage:
 *   bun scripts/migrate-to-firestore.ts \
 *     --service-account ./service-account.json \
 *     --uid FIREBASE_UID \
 *     --sqlite /path/to/artifact.sqlite \
 *     --blobs-dir /path/to/blobs \
 *     [--dry-run]
 *
 * Or with a JSON dump instead of SQLite:
 *     --json ./db-dump.json   # { profiles: [...], analyses: [...], cue_events: [...],
 *                             #   training_examples: [...], pending_label_candidates: [...] }
 *
 * The Firebase UID is the uid of Jon's account after first sign-in
 * (Firebase console > Authentication > Users). Blobs are matched by key:
 * files must exist at <blobs-dir>/<key> (a leading "blobs/" is stripped).
 * Missing blobs are logged and the doc keeps its storage path so a later
 * re-upload lands in the right place.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

type Args = {
  serviceAccount: string;
  uid: string;
  sqlite?: string;
  json?: string;
  blobsDir?: string;
  dryRun: boolean;
};

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const serviceAccount = get("--service-account");
  const uid = get("--uid");
  if (!serviceAccount || !uid) {
    console.error(
      "Usage: bun scripts/migrate-to-firestore.ts --service-account <path> --uid <firebase-uid> " +
        "(--sqlite <path> | --json <path>) [--blobs-dir <path>] [--dry-run]",
    );
    process.exit(1);
  }
  return {
    serviceAccount,
    uid,
    sqlite: get("--sqlite"),
    json: get("--json"),
    blobsDir: get("--blobs-dir"),
    dryRun: argv.includes("--dry-run"),
  };
}

// ---------------------------------------------------------------------------
// table loading
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

type Tables = {
  profiles: Row[];
  analyses: Row[];
  cue_events: Row[];
  training_examples: Row[];
  pending_label_candidates: Row[];
};

const TABLE_NAMES = ["profiles", "analyses", "cue_events", "training_examples", "pending_label_candidates"] as const;

async function loadFromSqlite(dbPath: string): Promise<Tables> {
  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath, { readonly: true });
  const tables = {} as Tables;
  for (const name of TABLE_NAMES) {
    try {
      tables[name] = db.query(`SELECT * FROM ${name}`).all() as Row[];
    } catch {
      tables[name] = [];
    }
  }
  db.close();
  return tables;
}

function loadFromJson(jsonPath: string): Tables {
  const raw = JSON.parse(readFileSync(jsonPath, "utf8")) as Partial<Record<string, Row[]>>;
  const tables = {} as Tables;
  for (const name of TABLE_NAMES) {
    tables[name] = Array.isArray(raw[name]) ? (raw[name] as Row[]) : [];
  }
  return tables;
}

// ---------------------------------------------------------------------------
// mapping (artifact snake_case rows -> Firestore docs)
// ---------------------------------------------------------------------------

const num = (v: unknown, fallback = 0): number => (typeof v === "number" ? v : fallback);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const bool = (v: unknown): boolean => v === 1 || v === true;

const storagePath = {
  image: (uid: string, key: string) => `users/${uid}/images/${key}`,
  clip: (uid: string, key: string) => `users/${uid}/clips/${key}`,
  trace: (uid: string, name: string) => `users/${uid}/traces/${name}`,
};

type PlannedDoc = { collection: string; id: string; data: Record<string, unknown> };
type PlannedUpload = { storagePath: string; localPath: string; contentType: string };

function stripBlobsPrefix(key: string): string {
  return key.startsWith("blobs/") ? key.slice("blobs/".length) : key;
}

function plan(tables: Tables, uid: string, blobsDir: string | undefined): { docs: PlannedDoc[]; uploads: PlannedUpload[]; missingBlobs: string[] } {
  const docs: PlannedDoc[] = [];
  const uploads: PlannedUpload[] = [];
  const missingBlobs: string[] = [];
  const profileIdMap = new Map<number, string>();

  const maybeUpload = (key: string | null, kind: "image" | "clip"): string | null => {
    if (!key) return null;
    const clean = stripBlobsPrefix(key);
    const path = kind === "image" ? storagePath.image(uid, clean) : storagePath.clip(uid, clean);
    if (blobsDir) {
      const local = join(blobsDir, clean);
      if (existsSync(local)) {
        uploads.push({
          storagePath: path,
          localPath: local,
          contentType: kind === "image" ? "image/jpeg" : "video/mp4",
        });
      } else {
        missingBlobs.push(key);
      }
    }
    return path;
  };

  // profiles
  for (const row of tables.profiles) {
    const legacyId = num(row.id);
    const id = `profile-${legacyId}`;
    profileIdMap.set(legacyId, id);
    docs.push({
      collection: "profiles",
      id,
      data: { name: str(row.name) ?? `profile-${legacyId}`, createdAt: num(row.created_at), legacyId },
    });
  }

  // analyses (+ embedded cue events)
  const eventsByAnalysis = new Map<number, Row[]>();
  for (const row of tables.cue_events) {
    const aid = num(row.analysis_id);
    const list = eventsByAnalysis.get(aid) ?? [];
    list.push(row);
    eventsByAnalysis.set(aid, list);
  }
  for (const row of tables.analyses) {
    const legacyId = num(row.id);
    const id = `analysis-${legacyId}`;
    const cueEvents = (eventsByAnalysis.get(legacyId) ?? []).map((e) => ({
      code: str(e.code) ?? "unknown",
      title: str(e.title) ?? "",
      suggestion: str(e.suggestion) ?? "",
      severity: num(e.severity),
      durationMs: num(e.duration_ms),
      startMs: num(e.start_ms),
      endMs: num(e.end_ms),
      peakMs: num(e.peak_ms),
      jointName: str(e.joint_name),
      side: str(e.side),
      isFused: bool(e.is_fused),
    }));
    const traceJson = str(row.detector_trace_json);
    const tracePath = traceJson ? storagePath.trace(uid, `analysis-${legacyId}.json`) : null;
    if (traceJson) {
      uploads.push({
        storagePath: tracePath as string,
        localPath: "",
        contentType: "application/json",
      });
      // stash inline content for the uploader (no temp file needed)
      (uploads[uploads.length - 1] as PlannedUpload & { inlineText?: string }).inlineText = traceJson;
    }
    docs.push({
      collection: "analyses",
      id,
      data: {
        profileId: profileIdMap.get(num(row.profile_id)) ?? `profile-${num(row.profile_id)}`,
        videoName: str(row.video_name) ?? "",
        climbLabel: str(row.climb_label),
        attemptTag: str(row.attempt_tag),
        durationMs: num(row.duration_ms),
        grade: typeof row.grade === "number" ? row.grade : null,
        analyzedFrames: num(row.analyzed_frames),
        reliableFrames: num(row.reliable_frames),
        detectorVersion: str(row.detector_version) ?? "pre-versioning",
        fileFingerprint: str(row.file_fingerprint),
        fileSizeBytes: typeof row.file_size_bytes === "number" ? row.file_size_bytes : null,
        cueEvents,
        traceStoragePath: tracePath,
        createdAt: num(row.created_at),
        legacyId,
      },
    });
  }

  // training examples
  for (const row of tables.training_examples) {
    const legacyId = num(row.id);
    const quality = str(row.quality);
    docs.push({
      collection: "trainingExamples",
      id: `example-${legacyId}`,
      data: {
        profileId: profileIdMap.get(num(row.profile_id)) ?? `profile-${num(row.profile_id)}`,
        sourceVideoName: str(row.source_video_name) ?? "",
        momentMs: num(row.moment_ms),
        clipStartMs: typeof row.clip_start_ms === "number" ? row.clip_start_ms : null,
        clipEndMs: typeof row.clip_end_ms === "number" ? row.clip_end_ms : null,
        quality: quality === "good" || quality === "bad" ? quality : "bad",
        cueCode: str(row.cue_code),
        suggestedCue: str(row.suggested_cue),
        notes: str(row.notes) ?? "",
        imageStoragePath: maybeUpload(str(row.image_blob_key), "image"),
        clipStoragePath: maybeUpload(str(row.clip_blob_key), "clip"),
        source: str(row.source),
        createdAt: num(row.created_at),
        legacyId,
      },
    });
  }

  // label candidates
  for (const row of tables.pending_label_candidates) {
    const legacyId = num(row.id);
    const quality = str(row.quality);
    docs.push({
      collection: "labelCandidates",
      id: `candidate-${legacyId}`,
      data: {
        profileId: profileIdMap.get(num(row.profile_id)) ?? `profile-${num(row.profile_id)}`,
        sourceVideoName: str(row.source_video_name) ?? "",
        sourceVideoFingerprint: str(row.source_video_fingerprint) ?? "",
        cueCode: str(row.cue_code) ?? "unknown",
        quality: quality === "good" || quality === "bad" ? quality : "bad",
        momentMs: num(row.moment_ms),
        startMs: num(row.start_ms),
        endMs: num(row.end_ms),
        confidencePpm: num(row.confidence_ppm),
        sectionKey: str(row.section_key),
        imageStoragePath: maybeUpload(str(row.image_blob_key), "image"),
        clipStoragePath: maybeUpload(str(row.clip_blob_key), "clip"),
        status: "pending",
        createdAt: num(row.created_at),
        legacyId,
      },
    });
  }

  return { docs, uploads, missingBlobs };
}

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.sqlite && !args.json) {
    console.error("Provide --sqlite <path> or --json <path>.");
    process.exit(1);
  }
  if (args.sqlite && !existsSync(args.sqlite)) {
    console.error(`SQLite file not found: ${args.sqlite}`);
    process.exit(1);
  }
  if (args.json && !existsSync(args.json)) {
    console.error(`JSON file not found: ${args.json}`);
    process.exit(1);
  }

  const tables = args.sqlite ? await loadFromSqlite(args.sqlite as string) : loadFromJson(args.json as string);
  const { docs, uploads, missingBlobs } = plan(tables, args.uid, args.blobsDir);

  const byCollection = new Map<string, number>();
  for (const d of docs) byCollection.set(d.collection, (byCollection.get(d.collection) ?? 0) + 1);
  console.log("Planned writes:");
  for (const [c, n] of byCollection) console.log(`  ${c}: ${n}`);
  console.log(`Planned storage uploads: ${uploads.length}`);
  if (missingBlobs.length) console.log(`Missing blobs (paths kept, files not found): ${missingBlobs.length}`);

  if (args.dryRun) {
    console.log("Dry run — nothing written.");
    return;
  }

  const sa = JSON.parse(readFileSync(args.serviceAccount, "utf8")) as { project_id?: string };
  const bucket = `${sa.project_id}.appspot.com`;
  initializeApp({
    credential: cert(args.serviceAccount),
    storageBucket: bucket,
  });
  const db = getFirestore();
  const storage = getStorage().bucket();

  // batched writes, 400 per batch
  let batch = db.batch();
  let pending = 0;
  let batches = 0;
  const flush = async () => {
    if (pending === 0) return;
    await batch.commit();
    batches += 1;
    batch = db.batch();
    pending = 0;
  };
  for (const doc of docs) {
    const ref = db.collection("users").doc(args.uid).collection(doc.collection).doc(doc.id);
    batch.set(ref, doc.data);
    pending += 1;
    if (pending >= 400) await flush();
  }
  await flush();
  console.log(`Wrote ${docs.length} docs in ${batches} batches.`);

  // uploads
  let uploaded = 0;
  for (const up of uploads) {
    const file = storage.file(up.storagePath);
    const withInline = up as PlannedUpload & { inlineText?: string };
    if (withInline.inlineText !== undefined) {
      await file.save(withInline.inlineText, { contentType: up.contentType });
    } else {
      await storage.upload(up.localPath, { destination: up.storagePath, contentType: up.contentType });
    }
    uploaded += 1;
    if (uploaded % 25 === 0) console.log(`  uploaded ${uploaded}/${uploads.length}`);
  }
  console.log(`Uploaded ${uploaded} files to gs://${bucket}.`);
  console.log("Done.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
