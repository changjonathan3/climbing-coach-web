# Firebase setup for climbing-coach-web

One-time setup (~15 min). The app works in local-only mode until this is done.

## 1. Create the project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) → **Add project**.
2. Name it `climbing-coach` (any name works). Disable Google Analytics (not needed).

## 2. Enable services

- **Authentication** → Sign-in method → enable **Google** (and Email/Password if you want it).
- **Firestore Database** → Create database → **production mode**, pick the region closest to you.
- **Storage** → Get started → production mode, same region.

## 3. Register the web app

Project settings (gear icon) → **Your apps** → `</>` web → nickname `climbing-coach-web`.
Copy the `firebaseConfig` values. No SDK install needed (already in `package.json`).

## 4. Local config

```sh
cd climbing-coach-web
cp .env.example .env
```

Fill `.env` with the values from step 3. Never commit `.env`.

## 5. Deploy rules and indexes

```sh
npm install -g firebase-tools
firebase login
firebase init firestore,storage   # select this project; it picks up firestore.rules,
                                  # firestore.indexes.json, storage.rules automatically
firebase deploy --only firestore:rules,firestore:indexes,storage
```

## 6. Migrate existing data (optional)

Sign in to the app once (any page using auth), then copy your **UID** from
Authentication → Users.

```sh
# service account: Project settings → Service accounts → Generate new private key
bun scripts/migrate-to-firestore.ts \
  --service-account ./service-account.json \
  --uid <YOUR_UID> \
  --sqlite /path/to/artifact.sqlite \
  --blobs-dir /path/to/artifact-blobs \
  --dry-run   # remove to write for real
```

`--sqlite` reads the artifact DB directly (tables: profiles, analyses,
cue_events, training_examples, pending_label_candidates). Use `--json` with a
`{ profiles: [...], ... }` dump instead if you prefer. Blob files are matched
by key under `--blobs-dir`; missing files are logged and their storage paths
are still recorded so a later re-upload lands correctly.

## 7. Build and deploy

```sh
npm run build   # .env is baked in at build time
```

Push to `main` — GitHub Pages redeploys automatically.

---

**Notes**

- Data layout: `users/{uid}/profiles`, `analyses`, `trainingExamples`,
  `labelCandidates`, `detectorCheckRuns`. Rules restrict each user to their own
  subtree; Storage mirrors it under `users/{uid}/`.
- Cue events are embedded in each analysis doc (one read per analysis).
  Detector traces go to Storage (`traces/`) — too large for Firestore docs.
- `legacyId` on every doc preserves the artifact SQLite row id.
