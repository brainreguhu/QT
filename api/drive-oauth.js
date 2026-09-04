const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

function html(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="UTF-8"><title>Google Drive 授權</title>
<style>body{font-family:"Segoe UI","Noto Sans TC","Microsoft JhengHei",sans-serif;background:#0f1419;color:#e7ecf3;padding:32px;max-width:720px;margin:0 auto;line-height:1.6}code,textarea{display:block;width:100%;background:#1e293b;color:#e2e8f0;border:1px solid #475569;border-radius:8px;padding:12px;box-sizing:border-box;word-break:break-all}a{color:#93c5fd}</style>
</head><body>${body}</body></html>`);
}

function redirectUri(req) {
  const host = req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${proto}://${host}/api/drive-oauth`;
}

module.exports = async function handler(req, res) {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || "";
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || "";
  if (!clientId || !clientSecret) {
    html(res, 500, "<h1>尚未設定 OAuth</h1><p>請先在 Vercel 新增 <code>GOOGLE_OAUTH_CLIENT_ID</code> 與 <code>GOOGLE_OAUTH_CLIENT_SECRET</code>，重新部署後再打開此頁。</p>");
    return;
  }

  const url = new URL(req.url, "http://localhost");
  const code = url.searchParams.get("code");
  const callback = redirectUri(req);

  if (!code) {
    const auth = new URL(AUTH_URL);
    auth.searchParams.set("client_id", clientId);
    auth.searchParams.set("redirect_uri", callback);
    auth.searchParams.set("response_type", "code");
    auth.searchParams.set("scope", DRIVE_SCOPE);
    auth.searchParams.set("access_type", "offline");
    auth.searchParams.set("prompt", "consent");
    res.statusCode = 302;
    res.setHeader("Location", auth.toString());
    res.end();
    return;
  }

  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: callback,
      grant_type: "authorization_code"
    })
  });
  const tokens = await tokenRes.json();
  if (!tokenRes.ok || !tokens.refresh_token) {
    html(res, 400, `<h1>授權失敗</h1><p>${tokens.error_description || tokens.error || "沒有取得 refresh token。請用擁有「檔案櫃」的 Google 帳號重試。"}</p>`);
    return;
  }

  html(res, 200, `
    <h1>授權成功</h1>
    <p>請把下面這串加到 Vercel 環境變數 <code>GOOGLE_OAUTH_REFRESH_TOKEN</code>，存檔後重新部署。不要把這串貼到聊天或公開網頁。</p>
    <textarea rows="6" readonly>${tokens.refresh_token}</textarea>
    <p>加完並部署完成後，即可回資料管理系統用 Google Drive Storage 上傳。</p>
  `);
};
