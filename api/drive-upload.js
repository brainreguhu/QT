const https = require("https");
const SUPABASE_URL = "https://clcqnbnbbtzzuctaspfn.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_1PJYZvRhU8qgCnwit6EG7Q_xjKq49oD";
const DEFAULT_FOLDER_ID = "1CpedoUN1qgIP3g_jmgbTCo6GRIbvXu6G";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink,webContentLink";
const DRIVE_SESSION_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,webViewLink,webContentLink";
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
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Content-Range, X-File-Name, X-Upload-Url, X-Upload-Start, X-Upload-End, X-Upload-Total, X-Content-Range, X-Drive-Action");
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
}

function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let failed = false;
    req.on("data", chunk => {
      if (failed) return;
      total += chunk.length;
      if (total > maxBytes + 1024) {
        failed = true;
        const error = new Error("檔案超過上限");
        error.statusCode = 413;
        reject(error);
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on("error", error => {
      if (!failed) reject(error);
    });
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

function extractDriveFileId(filePath) {
  const path = String(filePath || "").trim();
  const rest = path.startsWith("gdrive:") ? path.slice("gdrive:".length) : path;
  const fromUrl = rest.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (fromUrl) return fromUrl[1];
  if (/^[a-zA-Z0-9_-]+$/.test(rest)) return rest;
  return "";
}

function contentDisposition(fileName) {
  const safe = String(fileName || "download").replace(/[^\x20-\x7E]/g, "_") || "download";
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(fileName || "download")}`;
}

function isAllowedUploadUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ""));
    const host = url.hostname;
    const googleHost = host === "googleapis.com"
      || host.endsWith(".googleapis.com")
      || host === "googleusercontent.com"
      || host.endsWith(".googleusercontent.com");
    return url.protocol === "https:"
      && googleHost
      && (url.pathname.startsWith("/upload/") || host.endsWith("googleusercontent.com"));
  } catch (_) {
    return false;
  }
}

function headerValue(headers, name) {
  const value = headers?.[String(name || "").toLowerCase()];
  if (Array.isArray(value)) return String(value[0] || "");
  return String(value || "");
}

function isAllowedBrowserOrigin(origin, host) {
  let url;
  try {
    url = new URL(String(origin || ""));
  } catch (_) {
    return false;
  }
  if (url.origin !== origin) return false;
  if (host && url.host === host) return url.protocol === "https:" || url.protocol === "http:";
  if (url.protocol === "https:" && /(^|\.)vercel\.app$/i.test(url.hostname)) return true;
  return (url.protocol === "http:" || url.protocol === "https:")
    && /^(localhost|127\.0\.0\.1)$/i.test(url.hostname);
}

function resolveUploadOrigin(req, requestedOrigin) {
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  const candidates = [requestedOrigin, req.headers.origin];
  for (const candidate of candidates) {
    const origin = String(candidate || "").trim();
    if (isAllowedBrowserOrigin(origin, host)) return origin;
  }
  if (host && !/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)) return `https://${host}`;
  return "";
}

function parseGoogleBody(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer || "");
  try {
    return JSON.parse(text || "{}");
  } catch (_) {
    return { raw: text };
  }
}

function googleErrorText(detail, status) {
  const err = detail?.error;
  if (err && typeof err === "object") {
    const parts = [];
    if (err.message) parts.push(String(err.message));
    if (Array.isArray(err.errors)) {
      err.errors.forEach((item) => {
        const bit = [item?.reason, item?.message].filter(Boolean).join(" ");
        if (bit && !parts.includes(bit)) parts.push(bit);
      });
    }
    if (parts.length) return parts.join("：");
  }
  if (typeof err === "string" && err) return err;
  if (detail?.error_description) return String(detail.error_description);
  const raw = String(detail?.raw || "").trim();
  if (raw) return raw.slice(0, 300);
  return `Google 回應 ${status}`;
}

function googleRawRequest(rawUrl, { method = "GET", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(rawUrl);
    const payload = body == null ? null : (Buffer.isBuffer(body) ? body : Buffer.from(body));
    const reqHeaders = { ...headers };
    if (payload) reqHeaders["Content-Length"] = String(payload.length);
    const req = https.request(target, { method, headers: reqHeaders }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          status: response.statusCode || 0,
          headers: response.headers || {},
          body: Buffer.concat(chunks)
        });
      });
    });
    req.setTimeout(120000, () => {
      req.destroy(new Error("Google 上傳逾時"));
    });
    req.on("error", reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

async function startResumableUpload({ accessToken, metadata, mimeType, fileSize, origin }) {
  let url = DRIVE_SESSION_URL;
  const body = JSON.stringify(metadata);
  for (let hop = 0; hop < 5; hop += 1) {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": mimeType,
      "X-Upload-Content-Length": String(fileSize)
    };
    if (origin) headers.Origin = origin;
    const response = await googleRawRequest(url, { method: "POST", headers, body });
    if ([301, 302, 303, 307].includes(response.status)) {
      const next = headerValue(response.headers, "location");
      if (!next) throw new Error("Google 重新導向時沒有提供上傳網址");
      url = new URL(next, url).toString();
      continue;
    }
    const location = headerValue(response.headers, "location");
    const uploadUrl = location ? new URL(location, url).toString() : "";
    if (!uploadUrl || !isAllowedUploadUrl(uploadUrl)) {
      const detail = parseGoogleBody(response.body);
      throw new Error(googleErrorText(detail, response.status));
    }
    return uploadUrl;
  }
  throw new Error("Google 重新導向次數過多");
}

async function putDriveChunk(uploadUrl, { mimeType, contentRange, chunk }) {
  let url = uploadUrl;
  for (let hop = 0; hop < 5; hop += 1) {
    const response = await googleRawRequest(url, {
      method: "PUT",
      headers: {
        "Content-Type": mimeType,
        "Content-Range": contentRange
      },
      body: chunk
    });
    if (response.status === 308 && !headerValue(response.headers, "location")) {
      return response;
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = headerValue(response.headers, "location");
      const nextUrl = next ? new URL(next, url).toString() : "";
      if (!nextUrl || nextUrl === url) return response;
      url = nextUrl;
      continue;
    }
    return response;
  }
  throw new Error("Google 重新導向次數過多");
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

async function handleDownload(req, res) {
  const raw = await readRawBody(req, MAX_BYTES);
  let body = {};
  try {
    body = JSON.parse(raw.toString("utf8") || "{}");
  } catch (_) {
    sendJson(res, 400, { error: "下載請求格式不正確" });
    return;
  }
  const fileId = extractDriveFileId(body.fileId || body.filePath);
  if (!fileId) {
    sendJson(res, 400, { error: "缺少 Google Drive 檔案編號" });
    return;
  }

  const accessToken = await getAccessToken();
  const metaRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=name,size,mimeType&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const meta = await metaRes.json().catch(() => ({}));
  if (!metaRes.ok) {
    throw new Error(meta.error?.message || "找不到 Google Drive 檔案");
  }

  const fileName = meta.name || "download";
  const fileSize = Number(meta.size || 0);
  if (fileSize > MAX_BYTES) {
    sendJson(res, 200, {
      mode: "redirect",
      url: `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`
    });
    return;
  }

  const mediaRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!mediaRes.ok) {
    throw new Error(await readGoogleError(mediaRes));
  }

  const bytes = Buffer.from(await mediaRes.arrayBuffer());
  res.statusCode = 200;
  res.setHeader("Content-Type", meta.mimeType || "application/octet-stream");
  res.setHeader("Content-Disposition", contentDisposition(fileName));
  res.setHeader("Content-Length", String(bytes.length));
  res.end(bytes);
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

  const folderId = String(process.env.GOOGLE_DRIVE_FOLDER_ID || DEFAULT_FOLDER_ID).trim();
  const accessToken = await getAccessToken();
  const origin = resolveUploadOrigin(req, body.origin);
  const metadata = {
    name: fileName,
    parents: [folderId]
  };
  let direct = Boolean(origin);
  let uploadUrl = "";
  try {
    uploadUrl = await startResumableUpload({
      accessToken,
      metadata,
      mimeType,
      fileSize,
      origin: direct ? origin : ""
    });
  } catch (error) {
    if (!direct || String(error?.message || "").trim() !== "Bad Request") throw error;
    direct = false;
    uploadUrl = await startResumableUpload({
      accessToken,
      metadata,
      mimeType,
      fileSize,
      origin: ""
    });
  }

  sendJson(res, 200, { uploadUrl, mimeType, fileSize, direct });
}

function chunkContentRange(req) {
  const explicit = String(req.headers["x-content-range"] || req.headers["content-range"] || "").trim();
  if (explicit) return explicit;
  const start = String(req.headers["x-upload-start"] || "").trim();
  const end = String(req.headers["x-upload-end"] || "").trim();
  const total = String(req.headers["x-upload-total"] || "").trim();
  if (!start || !end || !total) return "";
  if (!/^\d+$/.test(start) || !/^\d+$/.test(end) || !/^\d+$/.test(total)) return "";
  return `bytes ${start}-${end}/${total}`;
}

async function handleChunk(req, res) {
  const uploadUrl = req.headers["x-upload-url"];
  const contentRange = chunkContentRange(req);
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

  const googleRes = await putDriveChunk(uploadUrl, { mimeType, contentRange, chunk });

  if (googleRes.status === 308) {
    sendJson(res, 200, { ok: true, incomplete: true });
    return;
  }

  const uploaded = parseGoogleBody(googleRes.body);
  if (googleRes.status < 200 || googleRes.status >= 300) {
    throw new Error(googleErrorText(uploaded, googleRes.status));
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
  const folderId = String(process.env.GOOGLE_DRIVE_FOLDER_ID || DEFAULT_FOLDER_ID).trim();
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
    throw new Error(googleErrorText(uploaded, uploadRes.status));
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
    if (String(req.headers["x-drive-action"] || "") === "download") {
      await handleDownload(req, res);
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
    if (!res.headersSent && !res.writableEnded) {
      sendJson(res, Number(error.statusCode) || 500, { error: error.message || "Google Drive 上傳失敗" });
    }
  }
};

module.exports.config = {
  api: {
    bodyParser: false
  }
};
