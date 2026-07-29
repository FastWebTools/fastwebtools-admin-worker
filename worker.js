// ================================================================
// fastwebtools-admin  —  Admin API Backend
// Bindings required:  DB (D1: fastwebtools-db)
// Deployed from: github.com/FastWebTools/fastwebtools-admin-worker
// ================================================================

const WORKER_VERSION = "1.0.6-github";
const DEPLOYED_AT = "2026-07-29";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });

// SQL fragment matching a real blog article URL, e.g.
//   https://www.fastwebtools.online/2026/07/some-post.html
const BLOG_ARTICLE_LIKE = "https://www.fastwebtools.online/2%/%.html";

// v1.0.6: parse optional ?from=YYYY-MM-DD&to=YYYY-MM-DD query params into ms.
// Returns null if not both present or invalid. Range is inclusive of both days.
function parseDateRange(url) {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!from || !to) return null;
  const reDate = /^\d{4}-\d{2}-\d{2}$/;
  if (!reDate.test(from) || !reDate.test(to)) return null;
  const fromMs = new Date(from + "T00:00:00.000Z").getTime();
  const toMs = new Date(to + "T23:59:59.999Z").getTime();
  if (isNaN(fromMs) || isNaN(toMs) || fromMs > toMs) return null;
  return { fromMs, toMs, from, to };
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
      // ---------- VERSION (public, no auth) ----------
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

      // ---------- LOGIN ----------
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

      // ---------- CHECK ----------
      if (path === "/admin/check" && request.method === "GET") {
        const auth = await checkAuth(request, env);
        return json({ success: auth.ok, username: auth.username || null });
      }

      // ---------- LOGOUT ----------
      if (path === "/admin/logout" && request.method === "POST") {
        const header = request.headers.get("Authorization") || "";
        const token = header.replace(/^Bearer\s+/i, "").trim();
        if (token) await env.DB.prepare("DELETE FROM admin_sessions WHERE token = ?").bind(token).run();
        return json({ success: true });
      }

      // ---- Auth check ----
      const auth = await checkAuth(request, env);
      if (!auth.ok) return json({ success: false, error: "Unauthorized" }, 401);

      // ---------- STATS ----------
      // v1.0.6: Optional ?from=YYYY-MM-DD&to=YYYY-MM-DD filters visits, unique
      // visitors, blog views, and comments. Likes and tool usage stay all-time
      // because their tables store aggregate counts (no per-event timestamps).
      if (path === "/admin/stats" && request.method === "GET") {
        const range = parseDateRange(url);
        let totalVisitsRow, uniqueVisitorsRow, totalBlogViewsRow, totalCommentsRow;
        if (range) {
          totalVisitsRow = await env.DB.prepare(
            "SELECT COUNT(*) AS n FROM visits WHERE created_at BETWEEN ? AND ?"
          ).bind(range.fromMs, range.toMs).first();
          uniqueVisitorsRow = await env.DB.prepare(
            "SELECT COUNT(DISTINCT visitor_id) AS n FROM visits WHERE created_at BETWEEN ? AND ?"
          ).bind(range.fromMs, range.toMs).first();
          totalBlogViewsRow = await env.DB.prepare(
            "SELECT COUNT(*) AS n FROM visits WHERE article_id LIKE ? AND created_at BETWEEN ? AND ?"
          ).bind(BLOG_ARTICLE_LIKE, range.fromMs, range.toMs).first();
          totalCommentsRow = await env.DB.prepare(
            "SELECT COUNT(*) AS n FROM comments WHERE created_at BETWEEN ? AND ?"
          ).bind(range.fromMs, range.toMs).first();
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
            total_comments: totalCommentsRow?.n || 0,
            total_article_likes: articleLikes,
            total_tool_likes: toolLikes,
            total_likes: articleLikes + toolLikes,
            total_tool_uses: toolUsesRow?.n || 0,
          },
        });
      }

      // ---------- LIVE NOW ----------
      // Live count + all-time visitors/blog-views. Ignores date filter
      // (this endpoint is polled every 3s for real-time header).
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

      // ---------- POPULAR ARTICLES ----------
      // v1.0.6: Supports ?from=&to= date filter (uses visits.created_at).
      if (path === "/admin/popular-articles" && request.method === "GET") {
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "10", 10), 50);
        const range = parseDateRange(url);
        let results;
        if (range) {
          const r = await env.DB.prepare(
            `SELECT article_id AS name, article_id AS url, COUNT(*) AS count
             FROM visits
             WHERE article_id LIKE ? AND created_at BETWEEN ? AND ?
             GROUP BY article_id
             ORDER BY count DESC
             LIMIT ?`
          ).bind(BLOG_ARTICLE_LIKE, range.fromMs, range.toMs, limit).all();
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

      // ---------- POPULAR TOOLS (aggregate, no date) ----------
      if (path === "/admin/popular-tools" && request.method === "GET") {
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "10", 10), 100);
        const { results } = await env.DB.prepare(
          "SELECT tool_id AS name, uses AS count FROM tool_usage WHERE uses > 0 ORDER BY uses DESC LIMIT ?"
        ).bind(limit).all();
        return json({ success: true, tools: results || [] });
      }

      // ---------- TOOL LIKES (aggregate, no date) ----------
      if (path === "/admin/tool-likes" && request.method === "GET") {
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 100);
        const { results } = await env.DB.prepare(
          "SELECT tool_id AS name, likes AS count FROM tool_likes WHERE likes > 0 ORDER BY likes DESC LIMIT ?"
        ).bind(limit).all();
        return json({ success: true, tools: results || [] });
      }

      // ---------- ARTICLE LIKES (aggregate, no date) ----------
      if (path === "/admin/article-likes" && request.method === "GET") {
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 100);
        const { results } = await env.DB.prepare(
          "SELECT article_id AS name, article_id AS url, likes AS count FROM article_likes WHERE likes > 0 ORDER BY likes DESC LIMIT ?"
        ).bind(limit).all();
        return json({ success: true, articles: results || [] });
      }

      // ---------- DAILY ACTIVITY ----------
      // v1.0.6: Supports ?from=&to= date filter, falls back to legacy ?days=.
      if (path === "/admin/daily-activity" && request.method === "GET") {
        const range = parseDateRange(url);
        let sinceMs, untilMs;
        if (range) {
          sinceMs = range.fromMs;
          untilMs = range.toMs;
        } else {
          const days = Math.min(parseInt(url.searchParams.get("days") || "14", 10), 62);
          sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
          untilMs = Date.now();
        }
        const { results } = await env.DB.prepare(
          `SELECT date(created_at/1000, 'unixepoch') AS day, COUNT(*) AS visits
           FROM visits
           WHERE created_at BETWEEN ? AND ?
           GROUP BY day
           ORDER BY day ASC`
        ).bind(sinceMs, untilMs).all();
        return json({ success: true, filtered: !!range, activity: results || [] });
      }

      // ---------- COMMENTS LIST ----------
      // v1.0.6: Supports ?from=&to= date filter, raises limit when filtered.
      if (path === "/admin/comments" && request.method === "GET") {
        const range = parseDateRange(url);
        let results;
        if (range) {
          const r = await env.DB.prepare(
            "SELECT id, article_id, name, comment, status, created_at FROM comments WHERE created_at BETWEEN ? AND ? ORDER BY id DESC LIMIT 500"
          ).bind(range.fromMs, range.toMs).all();
          results = r.results;
        } else {
          const r = await env.DB.prepare(
            "SELECT id, article_id, name, comment, status, created_at FROM comments ORDER BY id DESC LIMIT 500"
          ).all();
          results = r.results;
        }
        return json({ success: true, filtered: !!range, comments: results || [] });
      }

      // ---------- COMMENT DELETE / STATUS ----------
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

      // ---------- CHANGE PASSWORD ----------
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

      // ---------- CLEAR ALL ----------
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
