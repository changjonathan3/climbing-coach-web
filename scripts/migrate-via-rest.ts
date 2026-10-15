#!/usr/bin/env bun
/**
 * One-shot migration: artifact database -> Firestore via the REST API.
 *
 * Same data loading/planning as migrate-to-firestore.ts, but writes through
 * the Firestore REST API instead of the firebase-admin SDK (gRPC), which is
 * blocked in some environments.
 *
 * Storage uploads are skipped entirely (Firebase Storage not enabled).
 *
 * Usage:
 *   bun scripts/migrate-via-rest.ts \
 *     --service-account ./.service-account.json \
 *     --uid FIREBASE_UID \
 *     --sqlite /path/to/artifact.sqlite \
 *     [--json ./db-dump.json] \
 *     [--dry-run]
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createSign } from "node:crypto";

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

type Args = {
  serviceAccount: string;
  uid: string;
  sqlite?: string;
  json?: string;
  dryRun: boolean;
};

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const serviceAccount = get("--service-account");
  const uid = get("--uid");
  const sqlite = get("--sqlite");
  const json = get("--json");
  if (!serviceAccount || !uid) {
    console.error(
      "Usage: bun scripts/migrate-via-rest.ts --service-account <path> --uid <firebase-uid> " +
        "(--sqlite <path> | --json <path>) [--dry-run]",
    );
    process.exit(1);
  }
  if (!sqlite && !json) {
    console.error("Provide --sqlite <path> or --json <path>.");
    process.exit(1);
  }
  return { serviceAccount, uid, sqlite, json, dryRun: argv.includes("--dry-run") };
}

// ---------------------------------------------------------------------------
// table loading (mirrors migrate-to-firestore.ts)
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
// mapping (artifact snake_case rows -> Firestore docs; mirrors migrate-to-firestore.ts)
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

function plan(tables: Tables, uid: string): { docs: PlannedDoc[]; uploads: PlannedUpload[]; missingBlobs: string[] } {
  const docs: PlannedDoc[] = [];
  const uploads: PlannedUpload[] = [];
  const missingBlobs: string[] = [];
  const profileIdMap = new Map<number, string>();

  // No blob dir in REST mode — record storage paths but never upload.
  const maybeUpload = (key: string | null, kind: "image" | "clip"): string | null => {
    if (!key) return null;
    const clean = stripBlobsPrefix(key);
    const path = kind === "image" ? storagePath.image(uid, clean) : storagePath.clip(uid, clean);
    missingBlobs.push(key);
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
// service-account OAuth (JWT RS256 -> access token)
// ---------------------------------------------------------------------------

function base64url(input: Buffer | string): string {
  const b = typeof input === "string" ? Buffer.from(input) : input;
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getAccessToken(saPath: string): Promise<{ token: string; projectId: string }> {
  const sa = JSON.parse(readFileSync(saPath, "utf8")) as {
    client_email: string;
    private_key: string;
    token_uri: string;
    project_id: string;
  };
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: sa.token_uri,
    exp: now + 3600,
    iat: now,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  const signature = signer.sign(sa.private_key);
  const jwt = `${signingInput}.${base64url(signature)}`;

  const res = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string };
  return { token: data.access_token, projectId: sa.project_id };
}

// ---------------------------------------------------------------------------
// Firestore REST value conversion
// ---------------------------------------------------------------------------

type FirestoreValue = Record<string, unknown>;

/** JS value -> Firestore REST value. Epoch-millis timestamps stay integerValue. */
function toFirestoreValue(v: unknown): FirestoreValue {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) {
    return v.length === 0 ? { arrayValue: {} } : { arrayValue: { values: v.map(toFirestoreValue) } };
  }
  if (typeof v === "object") {
    const fields: Record<string, FirestoreValue> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      fields[k] = toFirestoreValue(val);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** PATCH (create-or-replace) one document. Retries 429s with 2s backoff, max 3 retries. */
async function writeDoc(projectId: string, token: string, docPath: string, data: Record<string, unknown>): Promise<void> {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${docPath}`;
  const body = JSON.stringify({
    fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toFirestoreValue(v)])),
  });
  let lastStatus = 0;
  let lastBody = "";
  for (let attempt = 0; attempt <= 3; attempt++) {
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body,
    });
    if (res.ok) return;
    lastStatus = res.status;
    lastBody = await res.text();
    if (res.status === 429 && attempt < 3) {
      await sleep(2000);
      continue;
    }
    break;
  }
  throw new Error(`write ${docPath} failed: ${lastStatus} ${lastBody}`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.sqlite && !existsSync(args.sqlite)) {
    console.error(`SQLite file not found: ${args.sqlite}`);
    process.exit(1);
  }
  if (args.json && !existsSync(args.json)) {
    console.error(`JSON file not found: ${args.json}`);
    process.exit(1);
  }
  if (!existsSync(args.serviceAccount)) {
    console.error(`Service account file not found: ${args.serviceAccount}`);
    process.exit(1);
  }

  const tables = args.sqlite ? await loadFromSqlite(args.sqlite) : loadFromJson(args.json as string);
  const { docs, uploads, missingBlobs } = plan(tables, args.uid);

  const counts = new Map<string, number>();
  for (const d of docs) counts.set(d.collection, (counts.get(d.collection) ?? 0) + 1);

  console.log("Planned writes:");
  for (const [collection, n] of counts) console.log(`  ${collection}: ${n}`);
  console.log(`Skipped storage uploads: ${uploads.length} (Firebase Storage not enabled)`);
  if (missingBlobs.length > 0) {
    console.log(`Blobs referenced but not uploaded: ${missingBlobs.length}`);
  }

  if (args.dryRun) {
    console.log("Dry run — nothing written.");
    // sanity-check the value converter on the first doc of each collection
    const seen = new Set<string>();
    for (const d of docs) {
      if (seen.has(d.collection)) continue;
      seen.add(d.collection);
      const converted = toFirestoreValue(d.data) as { mapValue: { fields: Record<string, FirestoreValue> } };
      const keys = Object.keys(converted.mapValue.fields);
      console.log(`  [${d.collection}] ${d.id}: converted OK (${keys.length} fields, e.g. ${keys.slice(0, 3).join(", ")})`);
    }
    return;
  }

  const { token, projectId } = await getAccessToken(args.serviceAccount);
  console.log(`Authenticated for project ${projectId}. Writing ${docs.length} documents...`);

  const written = new Map<string, number>();
  let i = 0;
  for (const d of docs) {
    const docPath = `users/${args.uid}/${d.collection}/${d.id}`;
    await writeDoc(projectId, token, docPath, d.data);
    written.set(d.collection, (written.get(d.collection) ?? 0) + 1);
    i++;
    if (i % 25 === 0) console.log(`  wrote ${i}/${docs.length}`);
  }

  console.log("Migration complete. Documents written per collection:");
  for (const [collection, n] of written) console.log(`  ${collection}: ${n}`);
  console.log(`Skipped storage uploads: ${uploads.length} (Firebase Storage not enabled)`);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
