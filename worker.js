// ================================================================
// fastwebtools-admin  —  Admin API Backend
// Bindings required:  DB (D1: fastwebtools-db)
// ================================================================

const WORKER_VERSION = "1.3.0-github";
const DEPLOYED_AT = "2026-09-29";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Pragma": "no-cache",
      ...CORS,
    },
  });

const BLOG_WHERE = `(
  article_id LIKE 'https://www.fastwebtools.online/20__/__/%.html'
  OR article_id LIKE 'http://www.fastwebtools.online/20__/__/%.html'
  OR article_id LIKE 'https://fastwebtools.online/20__/__/%.html'
  OR article_id LIKE 'http://fastwebtools.online/20__/__/%.html'
  OR article_id LIKE '/20__/__/%.html'
  OR article_id GLOB 'www-fastwebtools-online-20??-??-*-html'
)`;

function parseDateRange(url) {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!from || !to) return null;
  const reDate = /^\d{4}-\d{2}-\d{2}$/;
  if (!reDate.test(from) || !reDate.test(to)) return null;
  const fromISO = from + "T00:00:00.000Z";
  const toISO = to + "T23:59:59.999Z";
  const fromMs = new Date(fromISO).getTime();
  const toMs = new Date(toISO).getTime();
  if (isNaN(fromMs) || isNaN(toMs) || fromMs > toMs) return null;
  return { fromMs, toMs, from, to, fromISO, toISO };
}

const DATE_FILTER = `(
  (typeof(created_at)='integer' AND created_at > 9999999999 AND created_at BETWEEN ? AND ?)
  OR (typeof(created_at)='integer' AND created_at <= 9999999999 AND created_at BETWEEN CAST(? / 1000 AS INTEGER) AND CAST(? / 1000 AS INTEGER))
  OR (typeof(created_at)='text' AND datetime(created_at) BETWEEN datetime(?) AND datetime(?))
)`;
function dfBinds(r) { return [r.fromMs, r.toMs, r.fromMs, r.toMs, r.fromISO, r.toISO]; }
function normalizedTimeMs(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "number") return value > 9999999999 ? value : value * 1000;
  const raw=String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(raw)) { const n=Number(raw); return Number.isFinite(n) ? (n > 9999999999 ? n : n*1000) : 0; }
  const parsed=Date.parse(raw); return Number.isFinite(parsed) ? parsed : 0;
}

const DAY_EXPR = `CASE
  WHEN typeof(created_at)='integer' AND created_at > 9999999999 THEN date(created_at/1000, 'unixepoch')
  WHEN typeof(created_at)='integer' AND created_at <= 9999999999 THEN date(created_at, 'unixepoch')
  WHEN typeof(created_at)='text' THEN date(created_at)
  ELSE NULL
END`;

let adminCommentSchemaInit = false;
async function adminBestEffort(db, sql) { try { await db.prepare(sql).run(); } catch (e) {} }
async function ensureAdminCommentSchema(db) {
  if (adminCommentSchemaInit) return;
  await adminBestEffort(db, "ALTER TABLE comments ADD COLUMN owner_token_hash TEXT");
  await adminBestEffort(db, "ALTER TABLE comments ADD COLUMN edited_once INTEGER NOT NULL DEFAULT 0");
  await adminBestEffort(db, "ALTER TABLE comments ADD COLUMN edited_at INTEGER");
  await adminBestEffort(db, "ALTER TABLE comments ADD COLUMN edited_by_admin INTEGER NOT NULL DEFAULT 0");
  await adminBestEffort(db, "ALTER TABLE comments ADD COLUMN admin_edit_reason TEXT");
  await adminBestEffort(db, "ALTER TABLE comments ADD COLUMN original_comment TEXT");
  await adminBestEffort(db, "ALTER TABLE comments ADD COLUMN updated_at INTEGER");
  await adminBestEffort(db, "CREATE TABLE IF NOT EXISTS comment_reactions (id INTEGER PRIMARY KEY AUTOINCREMENT, comment_id INTEGER NOT NULL, visitor_id TEXT NOT NULL, reaction INTEGER NOT NULL CHECK(reaction IN (-1,1)), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(comment_id,visitor_id))");
  await adminBestEffort(db, "CREATE INDEX IF NOT EXISTS idx_cr_comment ON comment_reactions(comment_id)");
  await adminBestEffort(db, "CREATE TABLE IF NOT EXISTS comment_replies (id INTEGER PRIMARY KEY AUTOINCREMENT, comment_id INTEGER NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'published', is_official INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  await adminBestEffort(db, "ALTER TABLE comment_replies ADD COLUMN name TEXT");
  await adminBestEffort(db, "ALTER TABLE comment_replies ADD COLUMN owner_token_hash TEXT");
  await adminBestEffort(db, "CREATE INDEX IF NOT EXISTS idx_reply_comment ON comment_replies(comment_id)");
  await adminBestEffort(db, "CREATE TABLE IF NOT EXISTS comment_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, comment_id INTEGER NOT NULL, visitor_id TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, UNIQUE(comment_id, visitor_id))");
  await adminBestEffort(db, "CREATE INDEX IF NOT EXISTS idx_report_comment ON comment_reports(comment_id)");
  await adminBestEffort(db, "CREATE TABLE IF NOT EXISTS reply_reactions (id INTEGER PRIMARY KEY AUTOINCREMENT, reply_id INTEGER NOT NULL, visitor_id TEXT NOT NULL, reaction INTEGER NOT NULL CHECK(reaction IN (-1,1)), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(reply_id,visitor_id))");
  await adminBestEffort(db, "CREATE INDEX IF NOT EXISTS idx_rr_reply ON reply_reactions(reply_id)");
  await adminBestEffort(db, "CREATE TABLE IF NOT EXISTS comment_audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, comment_id INTEGER, reply_id INTEGER, admin_username TEXT, old_text TEXT, new_text TEXT, reason TEXT, created_at INTEGER NOT NULL)");
  adminCommentSchemaInit = true;
}
async function auditComment(db, data) {
  try { await db.prepare("INSERT INTO comment_audit_log (action,comment_id,reply_id,admin_username,old_text,new_text,reason,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)").bind(data.action||"unknown",data.comment_id||null,data.reply_id||null,data.admin||"admin",data.old_text||null,data.new_text||null,data.reason||null,Date.now()).run(); } catch(e) {}
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
  const a = new Uint8Array(32);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function checkAuth(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { ok: false };
  const row = await env.DB.prepare(
    "SELECT username, expires_at FROM admin_sessions WHERE token = ?"
  ).bind(token).first();
  if (!row) return { ok: false };
  if (row.expires_at && row.expires_at < Date.now()) return { ok: false };
  return { ok: true, username: row.username };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/version" && request.method === "GET") {
        return json({
          success: true,
          worker: "fastwebtools-admin",
          version: WORKER_VERSION,
          deployed_at: DEPLOYED_AT,
          source: "github.com/FastWebTools/fastwebtools-admin-worker",
          server_time: new Date().toISOString(),
        });
      }

      if (path === "/admin/login" && request.method === "POST") {
        const { username, password } = await request.json();
        if (!username || !password) return json({ success: false, error: "Missing fields" }, 400);
        const hash = await sha256(password);
        const admin = await env.DB.prepare(
          "SELECT id, username FROM admins WHERE username = ? AND password_hash = ?"
        ).bind(username, hash).first();
        if (!admin) return json({ success: false, error: "Invalid credentials" }, 401);
        const token = randomToken();
        const expires = Date.now() + 7 * 24 * 60 * 60 * 1000;
        await env.DB.prepare(
          "INSERT INTO admin_sessions (token, username, expires_at) VALUES (?, ?, ?)"
        ).bind(token, username, expires).run();
        return json({ success: true, token, username });
      }

      if (path === "/admin/check" && request.method === "GET") {
        const auth = await checkAuth(request, env);
        return json({ success: auth.ok, username: auth.username || null });
      }

      if (path === "/admin/logout" && request.method === "POST") {
        const header = request.headers.get("Authorization") || "";
        const token = header.replace(/^Bearer\s+/i, "").trim();
        if (token) await env.DB.prepare("DELETE FROM admin_sessions WHERE token = ?").bind(token).run();
        return json({ success: true });
      }

      const auth = await checkAuth(request, env);
      if (!auth.ok) return json({ success: false, error: "Unauthorized" }, 401);

      // ---------- DIAGNOSTIC (v1.0.8: also reports event log stats) ----------
      if (path === "/admin/diag" && request.method === "GET") {
        const v = await env.DB.prepare("SELECT id, article_id, created_at, typeof(created_at) AS ct FROM visits ORDER BY id DESC LIMIT 5").all();
        const c = await env.DB.prepare("SELECT id, article_id, created_at, typeof(created_at) AS ct FROM comments ORDER BY id DESC LIMIT 5").all();
        const al = await env.DB.prepare("SELECT article_id, likes FROM article_likes ORDER BY likes DESC LIMIT 10").all();
        let tueStats = null, tleStats = null, aleStats = null;
        try { tueStats = (await env.DB.prepare("SELECT COUNT(*) AS n, MIN(created_at) AS min_ts, MAX(created_at) AS max_ts FROM tool_usage_events").first()) || null; } catch (e) { tueStats = { error: String(e && e.message || e) }; }
        try { tleStats = (await env.DB.prepare("SELECT COUNT(*) AS n, MIN(created_at) AS min_ts, MAX(created_at) AS max_ts FROM tool_like_events").first()) || null; } catch (e) { tleStats = { error: String(e && e.message || e) }; }
        try { aleStats = (await env.DB.prepare("SELECT COUNT(*) AS n, MIN(created_at) AS min_ts, MAX(created_at) AS max_ts FROM article_like_events").first()) || null; } catch (e) { aleStats = { error: String(e && e.message || e) }; }
        return json({
          success: true,
          worker_version: WORKER_VERSION,
          server_time: new Date().toISOString(),
          now_ms: Date.now(),
          sample_visits: v.results || [],
          sample_comments: c.results || [],
          sample_article_likes: al.results || [],
          tool_usage_events_stats: tueStats,
          tool_like_events_stats: tleStats,
          article_like_events_stats: aleStats,
        });
      }

      // ---------- STATS ----------
      if (path === "/admin/stats" && request.method === "GET") {
        const range = parseDateRange(url);
        let totalVisitsRow, uniqueVisitorsRow, totalBlogViewsRow, totalCommentsRow;
        if (range) {
          const df = dfBinds(range);
          totalVisitsRow = await env.DB.prepare(
            `SELECT COUNT(*) AS n FROM visits WHERE ${DATE_FILTER}`
          ).bind(...df).first();
          uniqueVisitorsRow = await env.DB.prepare(
            `SELECT COUNT(DISTINCT visitor_id) AS n FROM visits WHERE ${DATE_FILTER}`
          ).bind(...df).first();
          totalBlogViewsRow = await env.DB.prepare(
            `SELECT COUNT(*) AS n FROM visits WHERE ${BLOG_WHERE} AND ${DATE_FILTER}`
          ).bind(...df).first();
          totalCommentsRow = await env.DB.prepare(
            `SELECT COUNT(*) AS n FROM comments WHERE ${DATE_FILTER}`
          ).bind(...df).first();
        } else {
          totalVisitsRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM visits").first();
          uniqueVisitorsRow = await env.DB.prepare("SELECT COUNT(DISTINCT visitor_id) AS n FROM visits").first();
          totalBlogViewsRow = await env.DB.prepare(
            `SELECT COUNT(*) AS n FROM visits WHERE ${BLOG_WHERE}`
          ).first();
          totalCommentsRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM comments").first();
        }
        let articleLikesRow, toolLikesRow, toolUsesRow;
        if (range) {
          const df = dfBinds(range);
          try { articleLikesRow = await env.DB.prepare(`SELECT COALESCE(SUM(delta),0) AS n FROM article_like_events WHERE ${DATE_FILTER}`).bind(...df).first(); } catch (e) { articleLikesRow = { n: 0 }; }
          try { toolLikesRow = await env.DB.prepare(`SELECT COALESCE(SUM(delta),0) AS n FROM tool_like_events WHERE ${DATE_FILTER}`).bind(...df).first(); } catch (e) { toolLikesRow = { n: 0 }; }
          try { toolUsesRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM tool_usage_events WHERE ${DATE_FILTER}`).bind(...df).first(); } catch (e) { toolUsesRow = { n: 0 }; }
        } else {
          articleLikesRow = await env.DB.prepare("SELECT COALESCE(SUM(likes),0) AS n FROM article_likes").first();
          toolLikesRow = await env.DB.prepare("SELECT COALESCE(SUM(likes),0) AS n FROM tool_likes").first();
          toolUsesRow = await env.DB.prepare("SELECT COALESCE(SUM(uses),0) AS n FROM tool_usage").first();
        }
        const articleLikes = Math.max(0, Number(articleLikesRow?.n || 0));
        const toolLikes = Math.max(0, Number(toolLikesRow?.n || 0));
        const totalVisitsN = Number(totalVisitsRow?.n || 0);
        const uniqueN = Number(uniqueVisitorsRow?.n || 0);
        const totalBlogViewsN = Number(totalBlogViewsRow?.n || 0);
        return json({
          success: true,
          filtered: !!range,
          range: range ? { from: range.from, to: range.to } : null,
          stats: {
            total_visits: totalVisitsN,
            unique_visitors: uniqueN,
            total_visitors: totalVisitsN,
            total_blog_views: totalBlogViewsN,
            total_comments: Number(totalCommentsRow?.n || 0),
            total_article_likes: articleLikes,
            total_tool_likes: toolLikes,
            total_likes: articleLikes + toolLikes,
            total_tool_uses: Number(toolUsesRow?.n || 0),
          },
        });
      }

      if (path === "/admin/visitors/realtime" && request.method === "GET") {
        const now = Date.now();
        const liveThreshold = now - 30 * 1000;
        const staleThreshold = now - 2 * 60 * 1000;
        await env.DB.prepare(
          "DELETE FROM active_sessions WHERE last_seen < ?"
        ).bind(staleThreshold).run();
        const row = await env.DB.prepare(
          "SELECT COUNT(*) AS live FROM active_sessions WHERE last_seen > ?"
        ).bind(liveThreshold).first();
        const totalRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM visits").first();
        const blogRow = await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM visits WHERE ${BLOG_WHERE}`
        ).first();
        return json({
          success: true,
          live: row?.live || 0,
          threshold_seconds: 30,
          total_visits: Number(totalRow?.n || 0),
          total_blog_views: Number(blogRow?.n || 0),
        });
      }

      if (path === "/admin/popular-articles" && request.method === "GET") {
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "10", 10), 1000);
        const range = parseDateRange(url);
        let results;
        if (range) {
          const df = dfBinds(range);
          const r = await env.DB.prepare(
            `SELECT article_id AS name, article_id AS url, COUNT(*) AS count
             FROM visits
             WHERE ${BLOG_WHERE} AND ${DATE_FILTER}
             GROUP BY article_id
             ORDER BY count DESC
             LIMIT ?`
          ).bind(...df, limit).all();
          results = r.results;
        } else {
          const r = await env.DB.prepare(
            `SELECT article_id AS name, article_id AS url, COUNT(*) AS count
             FROM visits
             WHERE ${BLOG_WHERE}
             GROUP BY article_id
             ORDER BY count DESC
             LIMIT ?`
          ).bind(limit).all();
          results = r.results;
        }
        return json({ success: true, filtered: !!range, articles: results || [] });
      }

      // v1.0.8: when date range is present, query tool_usage_events log
      // (each POST /tool-usage inserts an event via api-worker v1.0.5+) so
      // Top Tools filters correctly. Without range, keep the fast counter
      // path for backwards compatibility.
      if (path === "/admin/popular-tools" && request.method === "GET") {
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "10", 10), 1000);
        const range = parseDateRange(url);
        let results;
        if (range) {
          const df = dfBinds(range);
          try {
            const r = await env.DB.prepare(
              `SELECT tool_id AS name, COUNT(*) AS count
               FROM tool_usage_events
               WHERE ${DATE_FILTER}
               GROUP BY tool_id
               ORDER BY count DESC
               LIMIT ?`
            ).bind(...df, limit).all();
            results = r.results;
          } catch (e) {
            // Table not created yet — api-worker still on pre-v1.0.5.
            results = [];
          }
        } else {
          const r = await env.DB.prepare(
            "SELECT tool_id AS name, uses AS count FROM tool_usage WHERE uses > 0 ORDER BY uses DESC LIMIT ?"
          ).bind(limit).all();
          results = r.results;
        }
        return json({ success: true, filtered: !!range, tools: results || [] });
      }

      // v1.0.8: when date range is present, SUM(delta) from tool_like_events
      // per tool. delta is +1 for like, -1 for unlike so net likes shown.
      if (path === "/admin/tool-likes" && request.method === "GET") {
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 1000);
        const range = parseDateRange(url);
        let results;
        if (range) {
          const df = dfBinds(range);
          try {
            const r = await env.DB.prepare(
              `SELECT tool_id AS name, SUM(delta) AS count
               FROM tool_like_events
               WHERE ${DATE_FILTER}
               GROUP BY tool_id
               HAVING SUM(delta) > 0
               ORDER BY count DESC
               LIMIT ?`
            ).bind(...df, limit).all();
            results = r.results;
          } catch (e) {
            results = [];
          }
        } else {
          const r = await env.DB.prepare(
            "SELECT tool_id AS name, likes AS count FROM tool_likes WHERE likes > 0 ORDER BY likes DESC LIMIT ?"
          ).bind(limit).all();
          results = r.results;
        }
        return json({ success: true, filtered: !!range, tools: results || [] });
      }

      if (path === "/admin/article-likes" && request.method === "GET") {
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 1000);
        const range = parseDateRange(url);
        let results;
        if (range) {
          const df = dfBinds(range);
          try {
            const r = await env.DB.prepare(
              `SELECT article_id AS name, article_id AS url, SUM(delta) AS count
               FROM article_like_events
               WHERE ${DATE_FILTER}
               GROUP BY article_id
               HAVING SUM(delta) > 0
               ORDER BY count DESC
               LIMIT ?`
            ).bind(...df, limit).all();
            results = r.results;
          } catch (e) {
            results = [];
          }
        } else {
          const r = await env.DB.prepare(
            "SELECT article_id AS name, article_id AS url, likes AS count FROM article_likes WHERE likes > 0 ORDER BY likes DESC LIMIT ?"
          ).bind(limit).all();
          results = r.results;
        }
        return json({ success: true, filtered: !!range, articles: results || [] });
      }

      // ---------- DAILY ACTIVITY ----------
      if (path === "/admin/daily-activity" && request.method === "GET") {
        const range = parseDateRange(url);
        let results;
        if (range) {
          const df = dfBinds(range);
          const r = await env.DB.prepare(
            `SELECT ${DAY_EXPR} AS day, COUNT(*) AS visits
             FROM visits
             WHERE ${DATE_FILTER}
             GROUP BY day
             ORDER BY day ASC`
          ).bind(...df).all();
          results = r.results;
        } else {
          const days = Math.min(parseInt(url.searchParams.get("days") || "30", 10), 90);
          const untilMs = Date.now();
          const sinceMs = untilMs - days * 24 * 60 * 60 * 1000;
          const sinceISO = new Date(sinceMs).toISOString();
          const untilISO = new Date(untilMs).toISOString();
          const df = [sinceMs, untilMs, sinceMs, untilMs, sinceISO, untilISO];
          const r = await env.DB.prepare(
            `SELECT ${DAY_EXPR} AS day, COUNT(*) AS visits
             FROM visits
             WHERE ${DATE_FILTER}
             GROUP BY day
             ORDER BY day ASC`
          ).bind(...df).all();
          results = r.results;
        }
        return json({ success: true, filtered: !!range, activity: results || [] });
      }

      if (path === "/admin/comments" && request.method === "GET") {
        await ensureAdminCommentSchema(env.DB);
        const range=parseDateRange(url); let results;
        const select=`SELECT c.id,c.article_id,c.name,c.comment,c.status,c.created_at,c.edited_once,c.edited_at,c.edited_by_admin,c.admin_edit_reason,c.original_comment,c.updated_at,
          COALESCE((SELECT SUM(CASE WHEN reaction=1 THEN 1 ELSE 0 END) FROM comment_reactions r WHERE r.comment_id=c.id),0) AS likes,
          COALESCE((SELECT SUM(CASE WHEN reaction=-1 THEN 1 ELSE 0 END) FROM comment_reactions r WHERE r.comment_id=c.id),0) AS dislikes,
          COALESCE((SELECT COUNT(*) FROM comment_replies p WHERE p.comment_id=c.id),0) AS reply_count, COALESCE((SELECT COUNT(*) FROM comment_reports q WHERE q.comment_id=c.id AND q.status='pending'),0) AS report_count FROM comments c`;
        {const r=await env.DB.prepare(`${select} ORDER BY c.id DESC LIMIT 1000`).all();results=r.results||[];}
        for(const c of results){c.created_at_raw=c.created_at;c.created_at_ms=normalizedTimeMs(c.created_at);c.created_at_iso=c.created_at_ms?new Date(c.created_at_ms).toISOString():null;}
        if(range)results=results.filter(c=>c.created_at_ms>=range.fromMs&&c.created_at_ms<=range.toMs);
        results.sort((a,b)=>(b.created_at_ms-a.created_at_ms)||(Number(b.id)-Number(a.id)));
        const ids=results.map(x=>Number(x.id)).filter(Boolean);let replies=[];
        if(ids.length){const qs=ids.map(()=>"?").join(",");const rr=await env.DB.prepare(`SELECT p.id,p.comment_id,p.name,p.body,p.status,p.is_official,p.created_at,p.updated_at,
          COALESCE((SELECT SUM(CASE WHEN reaction=1 THEN 1 ELSE 0 END) FROM reply_reactions x WHERE x.reply_id=p.id),0) AS likes,
          COALESCE((SELECT SUM(CASE WHEN reaction=-1 THEN 1 ELSE 0 END) FROM reply_reactions x WHERE x.reply_id=p.id),0) AS dislikes
          FROM comment_replies p WHERE p.comment_id IN (${qs}) ORDER BY p.id ASC`).bind(...ids).all();replies=rr.results||[];}
        const map={};for(const r of replies){r.created_at_raw=r.created_at;r.created_at_ms=normalizedTimeMs(r.created_at);r.created_at_iso=r.created_at_ms?new Date(r.created_at_ms).toISOString():null;const k=String(r.comment_id);if(!map[k])map[k]=[];map[k].push(r);}for(const c of results)c.replies=(map[String(c.id)]||[]).sort((a,b)=>(a.created_at_ms-b.created_at_ms)||(Number(a.id)-Number(b.id)));
        return json({success:true,filtered:!!range,comments:results});
      }

      const commentMatch = path.match(/^\/admin\/comment\/(\d+)$/);
      if (commentMatch) {
        await ensureAdminCommentSchema(env.DB);
        const id=parseInt(commentMatch[1],10);
        if(request.method==="DELETE"){
          const row=await env.DB.prepare("SELECT comment FROM comments WHERE id=?1").bind(id).first();
          await auditComment(env.DB,{action:"delete_comment",comment_id:id,admin:auth.username,old_text:row&&row.comment});
          await env.DB.batch([env.DB.prepare("DELETE FROM reply_reactions WHERE reply_id IN (SELECT id FROM comment_replies WHERE comment_id=?1)").bind(id),env.DB.prepare("DELETE FROM comment_reactions WHERE comment_id=?1").bind(id),env.DB.prepare("DELETE FROM comment_replies WHERE comment_id=?1").bind(id),env.DB.prepare("DELETE FROM comments WHERE id=?1").bind(id)]);
          return json({success:true,deleted:true});
        }
        if(request.method==="PUT"){
          const body=await request.json();
          if(typeof body.comment==="string"){
            const text=body.comment.trim().slice(0,400),reason=String(body.reason||"Moderated by admin").slice(0,160);if(!text)return json({success:false,error:"Comment text is required"},400);
            const old=await env.DB.prepare("SELECT comment,original_comment FROM comments WHERE id=?1").bind(id).first();if(!old)return json({success:false,error:"Comment not found"},404);
            const now=Date.now();await env.DB.prepare("UPDATE comments SET original_comment=COALESCE(original_comment,comment),comment=?1,edited_once=1,edited_by_admin=1,edited_at=?2,updated_at=?2,admin_edit_reason=?3 WHERE id=?4").bind(text,now,reason,id).run();
            await auditComment(env.DB,{action:"edit_user_comment",comment_id:id,admin:auth.username,old_text:old.comment,new_text:text,reason});return json({success:true,edited:true});
          }
          const status=body.status;if(!["published","pending","spam"].includes(status))return json({success:false,error:"Invalid status"},400);
          await env.DB.prepare("UPDATE comments SET status=?1,updated_at=?2 WHERE id=?3").bind(status,Date.now(),id).run();await auditComment(env.DB,{action:"status_change",comment_id:id,admin:auth.username,reason:status});return json({success:true});
        }
      }

      const replyCreate=path.match(/^\/admin\/comment\/(\d+)\/reply$/);
      if(replyCreate&&request.method==="POST"){
        await ensureAdminCommentSchema(env.DB);const commentId=Number(replyCreate[1]),body=await request.json(),text=String(body.reply||"").trim().slice(0,800);if(!text)return json({success:false,error:"Reply is required"},400);
        const exists=await env.DB.prepare("SELECT id FROM comments WHERE id=?1").bind(commentId).first();if(!exists)return json({success:false,error:"Comment not found"},404);
        const now=Date.now(),official=body.is_official===false?0:1;const r=await env.DB.prepare("INSERT INTO comment_replies (comment_id,body,status,is_official,created_at,updated_at) VALUES (?1,?2,'published',?3,?4,?4)").bind(commentId,text,official,now).run();const replyId=Number(r&&r.meta&&r.meta.last_row_id||0);
        await auditComment(env.DB,{action:"create_admin_reply",comment_id:commentId,reply_id:replyId,admin:auth.username,new_text:text});return json({success:true,reply:{id:replyId,comment_id:commentId,body:text,status:"published",is_official:official,created_at:now,likes:0,dislikes:0}});
      }

      const replyMatch=path.match(/^\/admin\/reply\/(\d+)$/);
      if(replyMatch){
        await ensureAdminCommentSchema(env.DB);const id=Number(replyMatch[1]);
        if(request.method==="DELETE"){const old=await env.DB.prepare("SELECT comment_id,body FROM comment_replies WHERE id=?1").bind(id).first();await auditComment(env.DB,{action:"delete_admin_reply",comment_id:old&&old.comment_id,reply_id:id,admin:auth.username,old_text:old&&old.body});await env.DB.batch([env.DB.prepare("DELETE FROM reply_reactions WHERE reply_id=?1").bind(id),env.DB.prepare("DELETE FROM comment_replies WHERE id=?1").bind(id)]);return json({success:true,deleted:true});}
        if(request.method==="PUT"){const body=await request.json(),old=await env.DB.prepare("SELECT comment_id,body FROM comment_replies WHERE id=?1").bind(id).first();if(!old)return json({success:false,error:"Reply not found"},404);const text=String(body.reply==null?old.body:body.reply).trim().slice(0,800);if(!text)return json({success:false,error:"Reply is required"},400);const official=body.is_official===false?0:1,status=["published","pending"].includes(body.status)?body.status:"published";await env.DB.prepare("UPDATE comment_replies SET body=?1,is_official=?2,status=?3,updated_at=?4 WHERE id=?5").bind(text,official,status,Date.now(),id).run();await auditComment(env.DB,{action:"edit_admin_reply",comment_id:old.comment_id,reply_id:id,admin:auth.username,old_text:old.body,new_text:text});return json({success:true,edited:true});}
      }

      if (path === "/admin/change-password" && request.method === "POST") {
        const { oldPassword, newPassword } = await request.json();
        if (!oldPassword || !newPassword) return json({ success: false, error: "Missing fields" }, 400);
        const oldHash = await sha256(oldPassword);
        const admin = await env.DB.prepare(
          "SELECT id FROM admins WHERE username = ? AND password_hash = ?"
        ).bind(auth.username, oldHash).first();
        if (!admin) return json({ success: false, error: "Old password galat" }, 401);
        const newHash = await sha256(newPassword);
        await env.DB.prepare("UPDATE admins SET password_hash = ? WHERE username = ?")
          .bind(newHash, auth.username).run();
        return json({ success: true });
      }

      if (path === "/admin/clear-all" && request.method === "POST") {
        await env.DB.batch([
          env.DB.prepare("DELETE FROM visits"),
          env.DB.prepare("DELETE FROM comments"),
          env.DB.prepare("DELETE FROM article_likes"),
          env.DB.prepare("DELETE FROM tool_likes"),
          env.DB.prepare("DELETE FROM tool_usage"),
          env.DB.prepare("DELETE FROM active_sessions"),
        ]);
        // v1.0.8: also clear event logs when they exist.
        try { await env.DB.prepare("DELETE FROM tool_usage_events").run(); } catch (e) {}
        try { await env.DB.prepare("DELETE FROM tool_like_events").run(); } catch (e) {}
        try { await env.DB.prepare("DELETE FROM article_like_events").run(); } catch (e) {}
        try { await env.DB.prepare("DELETE FROM reply_reactions").run(); } catch (e) {}
        try { await env.DB.prepare("DELETE FROM comment_reactions").run(); } catch (e) {}
        try { await env.DB.prepare("DELETE FROM comment_replies").run(); } catch (e) {}
        try { await env.DB.prepare("DELETE FROM comment_audit_log").run(); } catch (e) {}
        return json({ success: true, cleared: true });
      }

      return json({ success: false, error: "Not found", path }, 404);
    } catch (err) {
      return json({ success: false, error: String(err && err.message || err) }, 500);
    }
  },
};
