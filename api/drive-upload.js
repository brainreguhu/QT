const SUPABASE_URL = "https://clcqnbnbbtzzuctaspfn.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_1PJYZvRhU8qgCnwit6EG7Q_xjKq49oD";
const DEFAULT_FOLDER_ID = "1CpedoUN1qgIP3g_jmgbTCo6GRIbvXu6G";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink,webContentLink";
const DRIVE_SESSION_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true";
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 100 * 1024 * 1024;

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
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Content-Range, X-File-Name, X-Upload-Url");
}

function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", chunk => {
      total += chunk.length;
      if (total > maxBytes + 1024) {
        reject(new Error("檔案超過上限"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function safeFileName(rawName) {
  const raw = String(rawName || "").trim() || "upload.bin";
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch (_) {
    decoded = raw;
  }
  return decoded.replace(/[\\/:*?"<>|]/g, "_").slice(0, 180);
}

async function readGoogleError(response) {
  const text = await response.text().catch(() => "");
  try {
    const detail = JSON.parse(text);
    return detail.error?.message || detail.error_description || detail.error || text || `Google 回應 ${response.status}`;
  } catch (_) {
    return text || `Google 回應 ${response.status}`;
  }
}

function isAllowedUploadUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ""));
    return url.protocol === "https:"
      && url.hostname === "www.googleapis.com"
      && url.pathname.startsWith("/upload/drive/");
  } catch (_) {
    return false;
  }
}

function buildMultipart(metadata, fileBuffer, mimeType) {
  const boundary = `qt_drive_${Date.now()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--`);
  return {
    body: Buffer.concat([head, fileBuffer, tail]),
    contentType: `multipart/related; boundary=${boundary}`
  };
}

async function getAccessToken() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || "";
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || "";
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN || "";
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("尚未完成 Google 擁有者授權，請先開啟 /api/drive-oauth 設定");
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

async function verifySupabaseUser(authorization) {
  const token = String(authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: SUPABASE_ANON_KEY
    }
  });
  if (!response.ok) return null;
  return response.json();
}

async function handleSession(req, res) {
  const raw = await readRawBody(req, MAX_BYTES);
  let body = {};
  try {
    body = JSON.parse(raw.toString("utf8") || "{}");
  } catch (_) {
    sendJson(res, 400, { error: "工作階段請求格式不正確" });
    return;
  }
  const fileName = safeFileName(body.fileName);
  const mimeType = String(body.mimeType || "application/octet-stream").split(";")[0] || "application/octet-stream";
  const fileSize = Number(body.fileSize || 0);
  if (!fileSize || fileSize < 1) {
    sendJson(res, 400, { error: "檔案是空的" });
    return;
  }
  if (fileSize > MAX_FILE_BYTES) {
    sendJson(res, 400, { error: "檔案超過 100 MB 上限" });
    return;
  }

  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID || DEFAULT_FOLDER_ID;
  const accessToken = await getAccessToken();
  const initRes = await fetch(DRIVE_SESSION_URL, {
    method: "POST",
    redirect: "manual",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": mimeType,
      "X-Upload-Content-Length": String(fileSize)
    },
    body: JSON.stringify({
      name: fileName,
      parents: [folderId]
    })
  });

  const uploadUrl = initRes.headers.get("location") || initRes.headers.get("Location");
  if (!uploadUrl) {
    throw new Error(await readGoogleError(initRes));
  }

  sendJson(res, 200, { uploadUrl, mimeType, fileSize });
}

async function handleChunk(req, res) {
  const uploadUrl = req.headers["x-upload-url"];
  const contentRange = req.headers["content-range"];
  const mimeType = String(req.headers["content-type"] || "application/octet-stream").split(";")[0];
  if (!isAllowedUploadUrl(uploadUrl)) {
    sendJson(res, 400, { error: "上傳網址不正確" });
    return;
  }
  if (!contentRange) {
    sendJson(res, 400, { error: "缺少 Content-Range" });
    return;
  }

  const chunk = await readRawBody(req, MAX_BYTES);
  if (!chunk.length) {
    sendJson(res, 400, { error: "沒有收到分塊" });
    return;
  }

  const googleRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": mimeType,
      "Content-Length": String(chunk.length),
      "Content-Range": contentRange
    },
    body: chunk
  });

  if (googleRes.status === 308) {
    sendJson(res, 200, { ok: true, incomplete: true });
    return;
  }

  const uploaded = await googleRes.json().catch(() => ({}));
  if (!googleRes.ok) {
    throw new Error(uploaded.error?.message || "Google Drive 分塊上傳失敗");
  }

  sendJson(res, 200, {
    id: uploaded.id,
    name: uploaded.name,
    webViewLink: uploaded.webViewLink || (uploaded.id ? `https://drive.google.com/file/d/${uploaded.id}/view` : "")
  });
}

async function handleLegacyUpload(req, res, fileBuffer) {
  const fileName = safeFileName(req.headers["x-file-name"]);
  const mimeType = String(req.headers["content-type"] || "application/octet-stream").split(";")[0];
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID || DEFAULT_FOLDER_ID;
  const accessToken = await getAccessToken();
  const { body, contentType } = buildMultipart(
    {
      name: fileName,
      parents: [folderId]
    },
    fileBuffer,
    mimeType
  );

  const uploadRes = await fetch(DRIVE_UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": contentType
    },
    body
  });
  const uploaded = await uploadRes.json();
  if (!uploadRes.ok) {
    throw new Error(uploaded.error?.message || "Google Drive 上傳失敗");
  }

  sendJson(res, 200, {
    id: uploaded.id,
    name: uploaded.name,
    webViewLink: uploaded.webViewLink || `https://drive.google.com/file/d/${uploaded.id}/view`
  });
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
    const user = await verifySupabaseUser(req.headers.authorization);
    if (!user?.id) {
      sendJson(res, 401, { error: "請先登入後再上傳" });
      return;
    }

    const contentType = String(req.headers["content-type"] || "");
    if (req.headers["x-upload-url"]) {
      await handleChunk(req, res);
      return;
    }
    if (contentType.includes("application/json")) {
      await handleSession(req, res);
      return;
    }

    const fileBuffer = await readRawBody(req, MAX_BYTES);
    if (!fileBuffer.length) {
      sendJson(res, 400, { error: "沒有收到檔案" });
      return;
    }
    await handleLegacyUpload(req, res, fileBuffer);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Google Drive 上傳失敗" });
  }
};

module.exports.config = {
  api: {
    bodyParser: false
  }
};
