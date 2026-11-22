# Co-Op: Cloudflare release checklist

**Do not enable Cloudflare automatic builds or merge the PR until setup is complete.** The existing Worker `coop-games.ora7.workers.dev` is not yet running this code.

## 1. Firebase console (project `gen-lang-client-0374438238`)

- Authentication → Sign-in method: Google must be enabled.
- Authentication → Settings → Authorized domains: add `coop-games.ora7.workers.dev` (no protocol or slash).
- Authentication → Users: find your intended Google account and copy its exact **UID**.
- Cloud Firestore → select database `ai-studio-coop-b9df6e48-7f1c-4ae4-9021-daeae96542b0` (see `firebase-applet-config.json`).
- Data → start collection `admins` → document ID = your copied UID → field `role` (string) = `admin`.
- Rules → paste the contents of **`firestore.rules`** from this branch into the **same database** and publish. Verify in Rules Playground: anonymous client cannot write `catalogOverrides`, normal user cannot write it, and approved admin can.

Note: Firestore security rules are deployed in Firebase separately. Cloudflare and GitHub do NOT publish these rules automatically.

## 2. Cloudflare Worker

Cloudflare Workers & Pages → `coop-games` → Settings → Builds.

Use:
- Git repository: `ora7ll000-cmd/Co-Op-`
- Production branch: `main`
- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`
- Root directory: `/`

The repository has `wrangler.jsonc` with the matching Worker name `coop-games` and Vite static assets under `./dist`.

After the Firebase steps and verification, merge PR into `main`, enable Builds, and review the production build and login at `https://coop-games.ora7.workers.dev`.

## 3. Known limits / follow-ups

- Existing local `coop_games` data is still kept as a local fallback; confirm any customized games were not lost when switching to the cloud catalog. Shared edits now go through Firestore `catalogOverrides` documents.
- The legacy Express server is not deployed on Cloudflare; its unsafe admin and game write endpoints are disabled for other hosting too.
- Votes currently use anonymous client-generated IDs. They remain open to tampering with public Firestore rules; address separately before representing voting as abuse-resistant.
- Weekly Steam price refresh will only apply after merging the GitHub Actions workflow into `main` and receiving a valid SAR price. Unknown Steam prices show a Steam link rather than a fabricated price.
- Try navigation, voting, reload, Google sign-in, creating/updating/deleting a game, and sign-out before treating this release as finished.
