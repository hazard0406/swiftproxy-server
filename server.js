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

// Main proxy endpoint
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
    const base = getBase(req);

    if (contentType.includes("text/html")) {
      let body = await response.text();
      body = rewriteHtml(body, targetUrl.toString(), base);
      res.set({ ...CORS, "Content-Type": "text/html", "X-Proxied-URL": targetUrl.toString() });
      return res.send(body);
    }

    if (contentType.includes("javascript")) {
      let body = await response.text();
      body = rewriteJs(body, targetUrl.toString(), base);
      res.set({ ...CORS, "Content-Type": contentType });
      return res.send(body);
    }

    if (contentType.includes("css")) {
      let body = await response.text();
      body = rewriteCss(body, targetUrl.toString(), base);
      res.set({ ...CORS, "Content-Type": contentType });
      return res.send(body);
    }

    // Binary assets — stream directly
    const buffer = await response.buffer();
    res.set({ ...CORS, "Content-Type": contentType });
    return res.send(buffer);

  } catch (err) {
    res.status(502).set(CORS).send(`
      <html><body style="font-family:sans-serif;padding:2rem;text-align:center">
        <h2>⚠️ Proxy Error</h2>
        <p>${err.message}</p>
        <p>The site may be blocking proxy access.</p>
      </body></html>`);
  }
});

// Fallback
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`SwiftProxy running on port ${PORT}`));

// ── Helpers ─────────────────────────────────────────────
function getBase(req) {
  return `${req.protocol}://${req.get("host")}`;
}

function toProxyUrl(href, baseUrl, serverBase) {
  if (!href) return href;
  href = href.trim();
  if (/^(javascript:|mailto:|#|data:|blob:)/.test(href)) return href;
  try {
    const abs = new URL(href, baseUrl).href;
    return `${serverBase}/proxy?url=${encodeURIComponent(abs)}`;
  } catch { return href; }
}

function rewriteHtml(html, baseUrl, serverBase) {
  // Remove CSP headers that would block our rewrites
  html = html.replace(/<meta[^>]+Content-Security-Policy[^>]+>/gi, '');

  // Rewrite href (links)
  html = html.replace(/\bhref=(["'])([^"']*)\1/gi, (m, q, val) => {
    if (/\.(css|woff|woff2|ttf|eot)(\?|$)/i.test(val)) {
      // stylesheets/fonts go through proxy too
      return `href=${q}${toProxyUrl(val, baseUrl, serverBase)}${q}`;
    }
    return `href=${q}${toProxyUrl(val, baseUrl, serverBase)}${q}`;
  });

  // Rewrite src (scripts, images, iframes)
  html = html.replace(/\bsrc=(["'])([^"']*)\1/gi, (m, q, val) => {
    return `src=${q}${toProxyUrl(val, baseUrl, serverBase)}${q}`;
  });

  // Rewrite srcset
  html = html.replace(/\bsrcset=(["'])([^"']+)\1/gi, (m, q, val) => {
    const rewritten = val.split(',').map(part => {
      const [u, ...rest] = part.trim().split(/\s+/);
      return [toProxyUrl(u, baseUrl, serverBase), ...rest].join(' ');
    }).join(', ');
    return `srcset=${q}${rewritten}${q}`;
  });

  // Rewrite form action
  html = html.replace(/\baction=(["'])([^"']*)\1/gi, (m, q, val) => {
    return `action=${q}${toProxyUrl(val, baseUrl, serverBase)}${q}`;
  });

  // Rewrite inline style url()
  html = html.replace(/url\((['"]?)([^)'"]+)\1\)/gi, (m, q, val) => {
    if (val.startsWith('data:')) return m;
    return `url(${q}${toProxyUrl(val, baseUrl, serverBase)}${q})`;
  });

  // Inject script to intercept JS navigation
  const intercept = `
<script>
(function(){
  var base = ${JSON.stringify(serverBase)};
  function proxify(u){
    if(!u||/^(javascript:|mailto:|#|data:|blob:|\/proxy\?)/.test(u)) return u;
    try{ return base+'/proxy?url='+encodeURIComponent(new URL(u,location.href).href); }
    catch(e){ return u; }
  }
  // Override fetch
  var _fetch = window.fetch;
  window.fetch = function(url, opts){
    return _fetch.call(this, proxify(url), opts);
  };
  // Override XMLHttpRequest
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(m,u){
    return _open.call(this, m, proxify(u));
  };
  // Override window.location assignment
  var _assign = window.location.assign.bind(window.location);
  var _replace = window.location.replace.bind(window.location);
  window.location.assign = function(u){ _assign(proxify(u)); };
  window.location.replace = function(u){ _replace(proxify(u)); };
  // Override window.open
  var _wopen = window.open;
  window.open = function(u,t,f){ return _wopen.call(this, proxify(u), t, f); };
})();
</script>`;

  html = html.replace(/<head([^>]*)>/i, `<head$1>${intercept}`);
  return html;
}

function rewriteJs(body, baseUrl, serverBase) {
  // Rewrite fetch() and XHR calls in JS files
  body = body.replace(/fetch\((['"`])([^'"`]+)\1/g, (m, q, url) => {
    try {
      const abs = new URL(url, baseUrl).href;
      return `fetch(${q}${serverBase}/proxy?url=${encodeURIComponent(abs)}${q}`;
    } catch { return m; }
  });
  return body;
}

function rewriteCss(body, baseUrl, serverBase) {
  return body.replace(/url\((['"]?)([^)'"]+)\1\)/gi, (m, q, val) => {
    if (val.startsWith('data:')) return m;
    try {
      const abs = new URL(val, baseUrl).href;
      return `url(${q}${serverBase}/proxy?url=${encodeURIComponent(abs)}${q})`;
    } catch { return m; }
  });
}
