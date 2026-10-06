# Safety and release guide

This adds checks and documentation only. Runtime source, Wrangler config, bindings, endpoint contracts and Google Analytics G-V45FD5XRVJ are not changed.

## Baseline (2026-10-05)
- Repository: FastWebTools/fastwebtools-admin-worker
- Baseline commit: `ba932d8cdaf6f179db78d116158bb6bb14c8101d`
- Backup branch: `backup/pre-safety-2026-10-05` (confirmed)
- Production Worker: `fastwebtools-admin`
- Baseline deployed version: `75f49cfe-3baa-457c-98ff-01c0c39062eb`
- main triggers `wrangler deploy`; non-main triggers `wrangler versions upload`.

## Release gates
1. Download all repository archives, deployed Worker source/config and D1 SQL export privately. A branch or Time Travel bookmark alone is NOT a permanent offline backup.
2. Confirm the latest PR commit's `check` passes. It checks syntax and a Wrangler dry-run only; it does NOT validate business logic, database schema, credentials, or browser interactions.
3. Review the entire diff. This initial safety PR must not modify runtime files or Wrangler configuration.
4. For runtime changes, use a separate test database and test admin backend. Existing preview bindings point to production; no POST/PUT/DELETE tests there.
5. Test tool launch, favorites, comment read/post/owner edit/delete, official replies, reactions, reports, login/logout, polling, and multi-tab presence in the isolated environment.
6. Record baseline public health responses and only then merge. Observe the Cloudflare build/deployment and rerun safe health checks; those alone cannot prove every feature works.

## Rollback
If a release causes regression, stop further deployments and check for concurrent changes. In Cloudflare > fastwebtools-admin > Deployments, restore the baseline version above, then revert the offending GitHub change through a PR to prevent it deploying again. Do not force-push main.
A Worker rollback does not revert D1 data/schema. Do not restore D1 for code-only failures; that can discard newer comments/visits. Time Travel is retention-limited. Database recovery requires assessment and a current backup first.

## Account settings still required
- Enable 2FA and keep recovery codes private.
- Protect main: PR required, latest `check` required, no force-push or branch deletion.
- Verify secret scanning/push protection availability and enable where supported.
- Do not change repo visibility, workers_dev, Cloudflare Access or production bindings as part of this PR.
- `.gitignore` does not remove previously committed secrets. Backups must NEVER be pushed to public repositories.

## Health testing caution
GET does not inherently mean read-only: current comment handlers bootstrap schema and current likes handlers may create rows. Do not run the original six-endpoint smoke script on production. The corrected API script checks only /version and /popular-tools; it is manual, not an automatic post-deployment hook.
