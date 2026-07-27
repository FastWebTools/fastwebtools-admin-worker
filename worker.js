// ================================================================
// fastwebtools-admin  —  Admin API Backend
// Bindings required:  DB (D1: fastwebtools-db)
// ================================================================

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
        const expires = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 din
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

      // ---- Har endpoint ke aage auth check ----
      const auth = await checkAuth(request, env);
      if (!auth.ok) return json({ success: false, error: "Unauthorized" }, 401);

      // ---------- STATS ----------
      if (path === "/admin/stats" && request.method === "GET") {
        const totalVisits = await env.DB.prepare("SELECT COUNT(*) AS n FROM visits").first();
        const uniqueVisitors = await env.DB.prepare("SELECT COUNT(DISTINCT visitor_id) AS n FROM visits").first();
        const totalComments = await env.DB.prepare("SELECT COUNT(*) AS n FROM comments").first();
        const totalLikes = await env.DB.prepare(
          "SELECT (SELECT COALESCE(SUM(likes),0) FROM article_likes) + (SELECT COALESCE(SUM(likes),0) FROM tool_likes) AS n"
        ).first();
        return json({
          success: true,
          stats: {
            total_visits: totalVisits?.n || 0,
            unique_visitors: uniqueVisitors?.n || 0,
            total_comments: totalComments?.n || 0,
            total_likes: totalLikes?.n || 0,
          },
        });
      }

      // ---------- LIVE NOW (last 3 min unique visitors) ----------
      if (path === "/admin/visitors/realtime" && request.method === "GET") {
        const threeMinAgo = Date.now() - 3 * 60 * 1000;
        const row = await env.DB.prepare(
          "SELECT COUNT(DISTINCT visitor_id) AS live FROM visits WHERE created_at > ?"
        ).bind(threeMinAgo).first();
        return json({ success: true, live: row?.live || 0 });
      }

      // ---------- POPULAR ARTICLES (sirf real .html URLs) ----------
      if (path === "/admin/popular-articles" && request.method === "GET") {
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "10", 10), 50);
        const { results } = await env.DB.prepare(
          `SELECT article_id AS name, article_id AS url, COUNT(*) AS count
           FROM visits
           WHERE article_id LIKE 'https://www.fastwebtools.online/2%/%.html'
           GROUP BY article_id
           ORDER BY count DESC
           LIMIT ?`
        ).bind(limit).all();
        return json({ success: true, articles: results || [] });
      }

      // ---------- POPULAR TOOLS ----------
      if (path === "/admin/popular-tools" && request.method === "GET") {
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "10", 10), 50);
        const { results } = await env.DB.prepare(
          "SELECT tool_id AS name, uses AS count FROM tool_usage ORDER BY uses DESC LIMIT ?"
        ).bind(limit).all();
        return json({ success: true, tools: results || [] });
      }

      // ---------- DAILY ACTIVITY (last 14 days) ----------
      if (path === "/admin/daily-activity" && request.method === "GET") {
        const days = Math.min(parseInt(url.searchParams.get("days") || "14", 10), 60);
        const since = Date.now() - days * 24 * 60 * 60 * 1000;
        const { results } = await env.DB.prepare(
          `SELECT date(created_at/1000, 'unixepoch') AS day, COUNT(*) AS visits
           FROM visits
           WHERE created_at > ?
           GROUP BY day
           ORDER BY day ASC`
        ).bind(since).all();
        return json({ success: true, activity: results || [] });
      }

      // ---------- COMMENTS LIST ----------
      if (path === "/admin/comments" && request.method === "GET") {
        const { results } = await env.DB.prepare(
          "SELECT id, article_id, name, comment, status, created_at FROM comments ORDER BY id DESC LIMIT 200"
        ).all();
        return json({ success: true, comments: results || [] });
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
        ]);
        return json({ success: true, cleared: true });
      }

      return json({ success: false, error: "Not found", path }, 404);
    } catch (err) {
      return json({ success: false, error: String(err && err.message || err) }, 500);
    }
  },
};
