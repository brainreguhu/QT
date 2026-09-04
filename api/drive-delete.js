const SUPABASE_URL = "https://clcqnbnbbtzzuctaspfn.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_1PJYZvRhU8qgCnwit6EG7Q_xjKq49oD";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GDRIVE_PATH_PREFIX = "gdrive:";

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && (/^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("請求格式不正確"));
      }
    });
    req.on("error", reject);
  });
}

function extractDriveFileId(filePath) {
  const path = String(filePath || "").trim();
  const rest = path.startsWith(GDRIVE_PATH_PREFIX) ? path.slice(GDRIVE_PATH_PREFIX.length) : path;
  const fromUrl = rest.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (fromUrl) return fromUrl[1];
  if (/^[a-zA-Z0-9_-]+$/.test(rest)) return rest;
  return "";
}

async function getAccessToken() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || "";
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || "";
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN || "";
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("尚未完成 Google 擁有者授權");
  }

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken
    })
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || "無法取得 Google 授權");
  }
  return data.access_token;
}

async function verifyAdmin(authorization) {
  const token = String(authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;

  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: SUPABASE_ANON_KEY
    }
  });
  if (!userRes.ok) return null;
  const user = await userRes.json();
  if (!user?.id) return null;

  const profileRes = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=permission_level,approved`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: SUPABASE_ANON_KEY
      }
    }
  );
  if (!profileRes.ok) return null;
  const rows = await profileRes.json();
  const profile = Array.isArray(rows) ? rows[0] : null;
  if (Number(profile?.permission_level) !== 0 || profile?.approved === false) return null;
  return user;
}

module.exports = async function handler(req, res) {
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "只接受 POST" });
    return;
  }

  try {
    const admin = await verifyAdmin(req.headers.authorization);
    if (!admin) {
      sendJson(res, 401, { error: "沒有刪除權限" });
      return;
    }

    const body = await readJsonBody(req);
    const fileId = extractDriveFileId(body.fileId || body.filePath);
    if (!fileId) {
      sendJson(res, 400, { error: "缺少 Google Drive 檔案編號" });
      return;
    }

    const accessToken = await getAccessToken();
    const deleteRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` }
      }
    );

    if (!deleteRes.ok && deleteRes.status !== 404) {
      const detail = await deleteRes.json().catch(() => ({}));
      throw new Error(detail.error?.message || "無法從 Google Drive 刪除檔案");
    }

    sendJson(res, 200, { ok: true, missing: deleteRes.status === 404 });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "無法從 Google Drive 刪除檔案" });
  }
};
