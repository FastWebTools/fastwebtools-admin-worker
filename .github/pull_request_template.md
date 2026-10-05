## What changed?

## Before merging
- [ ] `check` passed for this PR's latest commit (syntax + build only).
- [ ] Full code/config backups downloaded privately; backup branch confirmed.
- [ ] D1 SQL backup captured if any data/schema change is planned.
- [ ] Changed files reviewed; no unintended runtime/API/GA/binding changes.
- [ ] Functional tests run in an ISOLATED test environment if runtime changed.
- [ ] Production health baseline and rollback version recorded.

## Release and rollback
Merging `main` triggers Cloudflare production deploy. Non-main builds upload versions; their bindings are NOT currently isolated from production. Never perform write tests there.
For a code-only regression, roll back the affected Cloudflare Worker and revert the bad GitHub change through a PR. A code rollback does not recover deleted data. Never restore D1 for a code-only issue.
