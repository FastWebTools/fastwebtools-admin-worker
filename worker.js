// ================================================================
// fastwebtools-admin  —  Admin API Backend
// Bindings required:  DB (D1: fastwebtools-db)
// ================================================================

const WORKER_VERSION = "1.0.7-github";
const DEPLOYED_AT = "2026-07-31";

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

const BLOG_ARTICLE_LIKE = "https://www.fastwebtools.online/2%/%.html";

// v1.0.7: parse ?from=&to= into both ms integers AND ISO strings so we can
// filter regardless of whether created_at is stored as integer ms or ISO text.
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

// v1.0.7: robust WHERE clause fragment. created_at may be stored as either
// integer ms since epoch, integer seconds, or ISO 8601 text. This handles all
// three. Bind 6 params: [fromMs, toMs, fromMs, toMs, fromISO, toISO].
const DATE_FILTER = `(
  (typeof(created_at)='integer' AND created_at > 9999999999 AND created_at BETWEEN ? AND ?)
  OR (typeof(created_at)='integer' AND created_at <= 9999999999 AND created_at BETWEEN CAST(? / 1000 AS INTEGER) AND CAST(? / 1000 AS INTEGER))
  OR (typeof(created_at)='text' AND datetime(created_at) BETWEEN datetime(?) AND datetime(?))
)`;
function dfBinds(r) { return [r.fromMs, r.toMs, r.fromMs, r.toMs, r.fromISO, r.toISO]; }

// Normalize created_at to a YYYY-MM-DD string for GROUP BY.
const DAY_EXPR = `CASE
  WHEN typeof(created_at)='integer' AND created_at > 9999999999 THEN date(created_at/1000, 'unixepoch')
  WHEN typeof(created_at)='integer' AND created_at <= 9999999999 THEN date(created_at, 'unixepoch')
  WHEN typeof(created_at)='text' THEN date(created_at)
  ELSE NULL
END`;

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

      // ---------- DIAGNOSTIC (v1.0.7) ----------
      if (path === "/admin/diag" && request.method === "GET") {
        const v = await env.DB.prepare("SELECT id, article_id, created_at, typeof(created_at) AS ct FROM visits ORDER BY id DESC LIMIT 5").all();
        const c = await env.DB.prepare("SELECT id, article_id, created_at, typeof(created_at) AS ct FROM comments ORDER BY id DESC LIMIT 5").all();
        const al = await env.DB.prepare("SELECT article_id, likes FROM article_likes ORDER BY likes DESC LIMIT 10").all();
        return json({
          success: true,
          worker_version: WORKER_VERSION,
          server_time: new Date().toISOString(),
          now_ms: Date.now(),
          sample_visits: v.results || [],
          sample_comments: c.results || [],
          sample_article_likes: al.results || [],
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
            `SELECT COUNT(*) AS n FROM visits WHERE article_id LIKE ? AND ${DATE_FILTER}`
          ).bind(BLOG_ARTICLE_LIKE, ...df).first();
          totalCommentsRow = await env.DB.prepare(
            `SELECT COUNT(*) AS n FROM comments WHERE ${DATE_FILTER}`
          ).bind(...df).first();
        } else {
          totalVisitsRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM visits").first();
          uniqueVisitorsRow = await env.DB.prepare("SELECT COUNT(DISTINCT visitor_id) AS n FROM visits").first();
          totalBlogViewsRow = await env.DB.prepare(
            "SELECT COUNT(*) AS n FROM visits WHERE article_id LIKE ?"
          ).bind(BLOG_ARTICLE_LIKE).first();
          totalCommentsRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM comments").first();
        }
        const articleLikesRow = await env.DB.prepare(
          "SELECT COALESCE(SUM(likes),0) AS n FROM article_likes"
        ).first();
        const toolLikesRow = await env.DB.prepare(
          "SELECT COALESCE(SUM(likes),0) AS n FROM tool_likes"
        ).first();
        const toolUsesRow = await env.DB.prepare(
          "SELECT COALESCE(SUM(uses),0) AS n FROM tool_usage"
        ).first();
        const articleLikes = Number(articleLikesRow?.n || 0);
        const toolLikes = Number(toolLikesRow?.n || 0);
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
          "SELECT COUNT(*) AS n FROM visits WHERE article_id LIKE ?"
        ).bind(BLOG_ARTICLE_LIKE).first();
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
             WHERE article_id LIKE ? AND ${DATE_FILTER}
             GROUP BY article_id
             ORDER BY count DESC
             LIMIT ?`
          ).bind(BLOG_ARTICLE_LIKE, ...df, limit).all();
          results = r.results;
        } else {
          const r = await env.DB.prepare(
            `SELECT article_id AS name, article_id AS url, COUNT(*) AS count
             FROM visits
             WHERE article_id LIKE ?
             GROUP BY article_id
             ORDER BY count DESC
             LIMIT ?`
          ).bind(BLOG_ARTICLE_LIKE, limit).all();
          results = r.results;
        }
        return json({ success: true, filtered: !!range, articles: results || [] });
      }

      if (path === "/admin/popular-tools" && request.method === "GET") {
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "10", 10), 1000);
        const { results } = await env.DB.prepare(
          "SELECT tool_id AS name, uses AS count FROM tool_usage WHERE uses > 0 ORDER BY uses DESC LIMIT ?"
        ).bind(limit).all();
        return json({ success: true, tools: results || [] });
      }

      if (path === "/admin/tool-likes" && request.method === "GET") {
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 1000);
        const { results } = await env.DB.prepare(
          "SELECT tool_id AS name, likes AS count FROM tool_likes WHERE likes > 0 ORDER BY likes DESC LIMIT ?"
        ).bind(limit).all();
        return json({ success: true, tools: results || [] });
      }

      if (path === "/admin/article-likes" && request.method === "GET") {
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 1000);
        const { results } = await env.DB.prepare(
          "SELECT article_id AS name, article_id AS url, likes AS count FROM article_likes WHERE likes > 0 ORDER BY likes DESC LIMIT ?"
        ).bind(limit).all();
        return json({ success: true, articles: results || [] });
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
        const range = parseDateRange(url);
        let results;
        if (range) {
          const df = dfBinds(range);
          const r = await env.DB.prepare(
            `SELECT id, article_id, name, comment, status, created_at FROM comments WHERE ${DATE_FILTER} ORDER BY id DESC LIMIT 1000`
          ).bind(...df).all();
          results = r.results;
        } else {
          const r = await env.DB.prepare(
            "SELECT id, article_id, name, comment, status, created_at FROM comments ORDER BY id DESC LIMIT 1000"
          ).all();
          results = r.results;
        }
        return json({ success: true, filtered: !!range, comments: results || [] });
      }

      const commentMatch = path.match(/^\/admin\/comment\/(\d+)$/);
      if (commentMatch) {
        const id = parseInt(commentMatch[1], 10);
        if (request.method === "DELETE") {
          await env.DB.prepare("DELETE FROM comments WHERE id = ?").bind(id).run();
          return json({ success: true });
        }
        if (request.method === "PUT") {
          const { status } = await request.json();
          await env.DB.prepare("UPDATE comments SET status = ? WHERE id = ?").bind(status, id).run();
          return json({ success: true });
        }
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
        return json({ success: true, cleared: true });
      }

      return json({ success: false, error: "Not found", path }, 404);
    } catch (err) {
      return json({ success: false, error: String(err && err.message || err) }, 500);
    }
  },
};
