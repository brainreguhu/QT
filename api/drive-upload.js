const { createSign } = require("crypto");

const SUPABASE_URL = "https://clcqnbnbbtzzuctaspfn.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_1PJYZvRhU8qgCnwit6EG7Q_xjKq49oD";
const DEFAULT_FOLDER_ID = "1CpedoUN1qgIP3g_jmgbTCo6GRIbvXu6G";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,webContentLink";
const MAX_BYTES = 4 * 1024 * 1024;

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
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-File-Name");
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", chunk => {
      total += chunk.length;
      if (total > MAX_BYTES + 1024) {
        reject(new Error("檔案超過 4 MB 上限"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "";
  if (!raw) {
    throw new Error("尚未設定 GOOGLE_SERVICE_ACCOUNT_JSON");
  }
  const text = raw.trim().startsWith("{")
    ? raw
    : Buffer.from(raw, "base64").toString("utf8");
  const account = JSON.parse(text);
  if (!account.client_email || !account.private_key) {
    throw new Error("服務帳戶金鑰格式不正確");
  }
  return account;
}

function toBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function createSignedJwt(account) {
  const now = Math.floor(Date.now() / 1000);
  const header = toBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = toBase64Url(JSON.stringify({
    iss: account.client_email,
    scope: DRIVE_SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600
  }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  const signature = signer.sign(account.private_key, "base64url");
  return `${unsigned}.${signature}`;
}

async function getAccessToken(account) {
  const assertion = createSignedJwt(account);
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion
  });
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
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

function safeFileName(rawName) {
  const decoded = decodeURIComponent(String(rawName || "").trim()) || "upload.bin";
  return decoded.replace(/[\\/:*?"<>|]/g, "_").slice(0, 180);
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

    const fileBuffer = await readRawBody(req);
    if (!fileBuffer.length) {
      sendJson(res, 400, { error: "沒有收到檔案" });
      return;
    }

    const fileName = safeFileName(req.headers["x-file-name"]);
    const mimeType = String(req.headers["content-type"] || "application/octet-stream").split(";")[0];
    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID || DEFAULT_FOLDER_ID;
    const account = parseServiceAccount();
    const accessToken = await getAccessToken(account);
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
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Google Drive 上傳失敗" });
  }
};

module.exports.config = {
  api: {
    bodyParser: false
  }
};
