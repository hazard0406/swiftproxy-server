import express from "express";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

// Serve frontend
app.use(express.static(path.join(__dirname, "public")));

// OPTIONS preflight
app.options("/proxy", (req, res) => res.set(CORS).sendStatus(204));

// Main proxy endpoint: GET /proxy?url=https://example.com
app.get("/proxy", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).json({ error: "Missing ?url= parameter" });

  let targetUrl;
  try { targetUrl = new URL(target); } 
  catch { return res.status(400).json({ error: "Invalid URL" }); }

  try {
    const response = await fetch(targetUrl.toString(), {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "identity",
        "Upgrade-Insecure-Requests": "1",
      },
      redirect: "follow",
    });

    const contentType = response.headers.get("content-type") || "text/html";
    let body = await response.text();

    if (contentType.includes("text/html")) {
      body = rewriteHtml(body, targetUrl.toString(), req);
    } else if (contentType.includes("javascript") || contentType.includes("css")) {
      body = rewriteAsset(body, targetUrl.toString(), req);
    }

    res.set({ ...CORS, "Content-Type": contentType, "X-Proxied-URL": targetUrl.toString() });
    res.send(body);

  } catch (err) {
    res.status(502).set(CORS).json({ error: err.message });
  }
});

// Asset proxy: GET /asset?url=https://example.com/style.css
app.get("/asset", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).end();
  try {
    const response = await fetch(target, {
      headers: { "User-Agent": "Mozilla/5.0" },
      redirect: "follow",
    });
    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const buffer = await response.buffer();
    res.set({ ...CORS, "Content-Type": contentType });
    res.send(buffer);
  } catch {
    res.status(502).end();
  }
});

// Fallback to index.html
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`SwiftProxy running on port ${PORT}`));

// ── HTML Rewriting ──────────────────────────────────────
function proxyPrefix(req) {
  return `${req.protocol}://${req.get("host")}/proxy?url=`;
}
function assetPrefix(req) {
  return `${req.protocol}://${req.get("host")}/asset?url=`;
}

function rewriteHtml(html, baseUrl, req) {
  const pp = proxyPrefix(req);
  const ap = assetPrefix(req);

  const toProxy = (href) => {
    if (!href) return href;
    href = href.trim();
    if (href.startsWith("javascript:") || href.startsWith("mailto:") || href.startsWith("#") || href.startsWith("data:")) return href;
    try {
      const abs = new URL(href, baseUrl).href;
      // navigable links go through /proxy, assets through /asset
      return abs;
    } catch { return href; }
  };

  const toAbs = (href, base) => {
    if (!href) return href;
    href = href.trim();
    if (/^(javascript:|mailto:|#|data:)/.test(href)) return href;
    try { return new URL(href, base).href; } catch { return href; }
  };

  // rewrite href (navigation)
  html = html.replace(/\bhref=(["'])([^"']*)\1/gi, (m, q, val) => {
    const abs = toAbs(val, baseUrl);
    if (!abs || /^(javascript:|mailto:|#|data:)/.test(abs)) return m;
    return `href=${q}${pp}${encodeURIComponent(abs)}${q}`;
  });

  // rewrite src (assets)
  html = html.replace(/\bsrc=(["'])([^"']*)\1/gi, (m, q, val) => {
    const abs = toAbs(val, baseUrl);
    if (!abs || /^(data:)/.test(abs)) return m;
    return `src=${q}${ap}${encodeURIComponent(abs)}${q}`;
  });

  // rewrite action (forms)
  html = html.replace(/\baction=(["'])([^"']*)\1/gi, (m, q, val) => {
    const abs = toAbs(val, baseUrl);
    if (!abs) return m;
    return `action=${q}${pp}${encodeURIComponent(abs)}${q}`;
  });

  // rewrite CSS url() in style tags
  html = html.replace(/url\((['"]?)([^)'"]+)\1\)/gi, (m, q, val) => {
    const abs = toAbs(val, baseUrl);
    if (!abs || abs.startsWith("data:")) return m;
    return `url(${q}${ap}${encodeURIComponent(abs)}${q})`;
  });

  // rewrite <link rel stylesheet>
  html = html.replace(/\bhref=(["'])([^"']*\.css[^"']*)\1/gi, (m, q, val) => {
    const abs = toAbs(val, baseUrl);
    if (!abs) return m;
    return `href=${q}${ap}${encodeURIComponent(abs)}${q}`;
  });

  // inject base + override window.open / window.location
  const inject = `
<script>
(function(){
  var _pp = ${JSON.stringify(pp)};
  var _open = window.open;
  window.open = function(url){ if(url && !/^(javascript:|#)/.test(url)) url = _pp + encodeURIComponent(new URL(url, location.href).href); return _open.call(window, url); };
})();
</script>`;
  html = html.replace(/<head([^>]*)>/i, `<head$1>${inject}`);

  return html;
}

function rewriteAsset(body, baseUrl, req) {
  const ap = assetPrefix(req);
  return body.replace(/url\((['"]?)([^)'"]+)\1\)/gi, (m, q, val) => {
    if (val.startsWith("data:")) return m;
    try {
      const abs = new URL(val, baseUrl).href;
      return `url(${q}${ap}${encodeURIComponent(abs)}${q})`;
    } catch { return m; }
  });
}
