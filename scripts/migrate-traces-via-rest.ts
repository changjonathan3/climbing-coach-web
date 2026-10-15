#!/usr/bin/env bun
/**
 * One-shot: migrate pose traces (sampled_frames) from the detector export JSON
 * into the existing Firestore trainingExamples docs, as the `trace` field.
 *
 * Uses the Firestore REST API (gRPC is blocked in this environment).
 *
 * Usage:
 *   bun scripts/migrate-traces-via-rest.ts \
 *     --service-account ./.service-account.json \
 *     --uid FIREBASE_UID \
 *     --export ~/workspace/detector-export-2026-10-12.json \
 *     [--dry-run]
 */

import { existsSync, readFileSync } from "node:fs";
import { createSign } from "node:crypto";

function parseArgs(argv: string[]) {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const serviceAccount = get("--service-account");
  const uid = get("--uid");
  const exportPath = get("--export");
  if (!serviceAccount || !uid || !exportPath) {
    console.error(
      "Usage: bun scripts/migrate-traces-via-rest.ts --service-account <path> --uid <uid> --export <path> [--dry-run]",
    );
    process.exit(1);
  }
  return { serviceAccount, uid, exportPath, dryRun: argv.includes("--dry-run") };
}

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
  const jwt = `${signingInput}.${base64url(signer.sign(sa.private_key))}`;
  const res = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { access_token: string };
  return { token: data.access_token, projectId: sa.project_id };
}

type FirestoreValue = Record<string, unknown>;

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

/** PATCH the trace field onto one doc. Retries 429s with 2s backoff, max 3 retries. */
async function patchTrace(
  projectId: string,
  token: string,
  uid: string,
  docId: string,
  trace: unknown[],
): Promise<void> {
  const url =
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/` +
    `users/${uid}/trainingExamples/${docId}?updateMask.fieldPaths=trace`;
  const body = JSON.stringify({ fields: { trace: toFirestoreValue(trace) } });
  let lastStatus = 0;
  let lastBody = "";
  for (let attempt = 0; attempt <= 3; attempt++) {
    const res = await fetch(url, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
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
  throw new Error(`patch ${docId} failed: ${lastStatus} ${lastBody}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  for (const p of [args.serviceAccount, args.exportPath]) {
    if (!existsSync(p)) {
      console.error(`File not found: ${p}`);
      process.exit(1);
    }
  }

  const exportData = JSON.parse(readFileSync(args.exportPath, "utf8")) as {
    shared_labeled_examples?: Array<{ id: number; sampled_frames?: unknown[] }>;
  };
  const examples = exportData.shared_labeled_examples ?? [];
  const withTrace = examples.filter((ex) => Array.isArray(ex.sampled_frames) && ex.sampled_frames.length > 0);
  console.log(`Export examples: ${examples.length}, with sampled_frames: ${withTrace.length}`);
  if (withTrace.length === 0) {
    console.error("No traces found in export.");
    process.exit(1);
  }
  const totalBytes = withTrace.reduce(
    (n, ex) => n + JSON.stringify(ex.sampled_frames).length,
    0,
  );
  console.log(`Total trace payload: ${(totalBytes / 1024).toFixed(0)} KB`);

  if (args.dryRun) {
    console.log("Dry run — nothing written.");
    const first = withTrace[0]!;
    console.log(
      `  example ${first.id} -> example-${first.id}: ${(first.sampled_frames as unknown[]).length} frames, ` +
        `${JSON.stringify(first.sampled_frames).length} bytes`,
    );
    return;
  }

  const { token, projectId } = await getAccessToken(args.serviceAccount);
  console.log(`Authenticated for project ${projectId}. Patching ${withTrace.length} docs...`);

  let ok = 0;
  const failed: Array<{ id: number; error: string }> = [];
  let i = 0;
  for (const ex of withTrace) {
    const docId = `example-${ex.id}`;
    try {
      await patchTrace(projectId, token, args.uid, docId, ex.sampled_frames as unknown[]);
      ok++;
    } catch (err) {
      failed.push({ id: ex.id, error: String(err).slice(0, 200) });
    }
    i++;
    if (i % 20 === 0) console.log(`  patched ${i}/${withTrace.length}`);
  }

  console.log(`Done. Traces migrated: ${ok}/${withTrace.length}`);
  if (failed.length > 0) {
    console.log("Failures:");
    for (const f of failed) console.log(`  example ${f.id}: ${f.error}`);
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
