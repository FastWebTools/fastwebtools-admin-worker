# fastwebtools-admin-worker

Cloudflare Worker source for the **fastwebtools-admin** admin API backend.

## Bindings required

- **D1 Database:** binding name `DB` → database `fastwebtools-db`

## Auto-deploy

This repo is connected to Cloudflare Worker `fastwebtools-admin`. Every push to `main` deploys automatically.

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/admin/login` | — | Login with username + password |
| GET | `/admin/check` | Bearer | Verify session |
| POST | `/admin/logout` | Bearer | Invalidate session |
| GET | `/admin/stats` | Bearer | Total visits, unique visitors, comments, likes |
| GET | `/admin/visitors/realtime` | Bearer | Unique visitors in last 3 minutes |
| GET | `/admin/popular-articles?limit=N` | Bearer | Top visited blog posts (full URLs only) |
| GET | `/admin/popular-tools?limit=N` | Bearer | Top used tools |
| GET | `/admin/daily-activity?days=N` | Bearer | Visits per day |
| GET | `/admin/comments` | Bearer | Latest 200 comments |
| PUT | `/admin/comment/{id}` | Bearer | Update comment status |
| DELETE | `/admin/comment/{id}` | Bearer | Delete comment |
| POST | `/admin/change-password` | Bearer | Change admin password |
| POST | `/admin/clear-all` | Bearer | Wipe all analytics data |
