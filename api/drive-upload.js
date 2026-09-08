
[2 lines collapsed]

const DEFAULT_FOLDER_ID = "1CpedoUN1qgIP3g_jmgbTCo6GRIbvXu6G";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink,webContentLink";
const DRIVE_SESSION_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,webViewLink";
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
function sendJson(res, status, payload) {
  res.statusCode = status;

[8 lines collapsed]

    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-File-Name");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Content-Range, X-File-Name, X-Upload-Url");
}
function readRawBody(req) {
function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", chunk => {
      total += chunk.length;
      if (total > MAX_BYTES + 1024) {
        reject(new Error("檔案超過 4 MB 上限"));
      if (total > maxBytes + 1024) {
        reject(new Error("檔案超過上限"));
        req.destroy();
        return;
      }

[4 lines collapsed]

  });
}
function safeFileName(rawName) {
  const decoded = decodeURIComponent(String(rawName || "").trim()) || "upload.bin";
  return decoded.replace(/[\\/:*?"<>|]/g, "_").slice(0, 180);
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

[4 lines collapsed]

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,

[21 lines collapsed]

  return response.json();
}
function safeFileName(rawName) {
  const decoded = decodeURIComponent(String(rawName || "").trim()) || "upload.bin";
  return decoded.replace(/[\\/:*?"<>|]/g, "_").slice(0, 180);
async function handleSession(req, res) {
  const raw = await readRawBody(req, MAX_BYTES);
  const body = JSON.parse(raw.toString("utf8") || "{}");
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
  const origin = req.headers.origin || `https://${req.headers.host}`;
  const initRes = await fetch(DRIVE_SESSION_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": mimeType,
      "X-Upload-Content-Length": String(fileSize),
      Origin: origin
    },
    body: JSON.stringify({
      name: fileName,
      parents: [folderId]
    })
  });
  const uploadUrl = initRes.headers.get("location");
  if (!initRes.ok || !uploadUrl) {
    const detail = await initRes.json().catch(() => ({}));
    throw new Error(detail.error?.message || "無法建立 Google Drive 上傳工作階段");
  }
  sendJson(res, 200, { uploadUrl, mimeType, fileSize });
}
function buildMultipart(metadata, fileBuffer, mimeType) {
  const boundary = `qt_drive_${Date.now()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
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
  const tail = Buffer.from(`\r\n--${boundary}--`);
  return {
    body: Buffer.concat([head, fileBuffer, tail]),
    contentType: `multipart/related; boundary=${boundary}`
  };
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
