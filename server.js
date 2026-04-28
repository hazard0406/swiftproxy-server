import express from "express";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));

// ── Proxy route ─────────────────────────────────────────
app.get("/proxy", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.redirect("/");

  let targetUrl;
  try { targetUrl = new URL(target); }
  catch { return res.redirect("/"); }

  try {
    const response = await fetch(targetUrl.toString(), {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "identity",
        "Referer": targetUrl.origin,
      },
      redirect: "follow",
    });

    const contentType = response.headers.get("content-type") || "text/html";
    const serverBase = `${req.protocol}://${req.get("host")}`;

    if (contentType.includes("text/html")) {
      let body = await response.text();
      body = rewriteHtml(body, targetUrl.toString(), serverBase);
      res.setHeader("Content-Type", "text/html");
      res.setHeader("X-Proxied-URL", targetUrl.toString());
      return res.send(body);
    }

    if (contentType.includes("css")) {
      let body = await response.text();
      body = rewriteCss(body, targetUrl.toString(), serverBase);
      res.setHeader("Content-Type", contentType);
      return res.send(body);
    }

    if (contentType.includes("javascript")) {
      let body = await response.text();
      res.setHeader("Content-Type", contentType);
      return res.send(body);
    }

    // Binary (images, fonts, etc) — pipe directly
    const buffer = await response.buffer();
    res.setHeader("Content-Type", contentType);
    return res.send(buffer);

  } catch (err) {
    return res.redirect(`/?error=${encodeURIComponent(err.message)}`);
  }
});

// POST proxy (form submissions)
app.post("/proxy", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.redirect("/");
  try {
    const response = await fetch(target, {
      method: "POST",
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(req.body).toString(),
      redirect: "follow",
    });
    const serverBase = `${req.protocol}://${req.get("host")}`;
    let body = await response.text();
    body = rewriteHtml(body, target, serverBase);
    res.setHeader("Content-Type", "text/html");
    res.send(body);
  } catch (err) {
    res.redirect(`/?error=${encodeURIComponent(err.message)}`);
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`SwiftProxy on port ${PORT}`));

// ── Rewriters ───────────────────────────────────────────
function proxify(href, baseUrl, serverBase) {
  if (!href) return href;
  href = href.trim();
  if (/^(javascript:|mailto:|#|data:|blob:|about:)/.test(href)) return href;
  if (href.startsWith(`${serverBase}/proxy`)) return href;
  try {
    const abs = new URL(href, baseUrl).href;
    return `${serverBase}/proxy?url=${encodeURIComponent(abs)}`;
  } catch { return href; }
}

function rewriteHtml(html, baseUrl, serverBase) {
  // Strip CSP
  html = html.replace(/<meta[^>]+content-security-policy[^>]+>/gi, "");
  html = html.replace(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]+>/gi, "");

  // Rewrite href
  html = html.replace(/\bhref=(["'])([^"']*)\1/gi, (m, q, v) =>
    `href=${q}${proxify(v, baseUrl, serverBase)}${q}`);

  // Rewrite src
  html = html.replace(/\bsrc=(["'])([^"']*)\1/gi, (m, q, v) =>
    `src=${q}${proxify(v, baseUrl, serverBase)}${q}`);

  // Rewrite srcset
  html = html.replace(/\bsrcset=(["'])([^"']+)\1/gi, (m, q, v) => {
    const rw = v.split(",").map(p => {
      const [u, ...rest] = p.trim().split(/\s+/);
      return [proxify(u, baseUrl, serverBase), ...rest].join(" ");
    }).join(", ");
    return `srcset=${q}${rw}${q}`;
  });

  // Rewrite form action
  html = html.replace(/\baction=(["'])([^"']*)\1/gi, (m, q, v) =>
    `action=${q}${proxify(v, baseUrl, serverBase)}${q}`);

  // Rewrite inline style url()
  html = html.replace(/url\((['"]?)([^)'"\s]+)\1\)/gi, (m, q, v) => {
    if (v.startsWith("data:")) return m;
    return `url(${q}${proxify(v, baseUrl, serverBase)}${q})`;
  });

  // Inject toolbar + JS intercept
  const toolbar = buildToolbar(baseUrl, serverBase);
  const intercept = buildIntercept(serverBase);

  html = html.replace(/<head([^>]*)>/i, `<head$1>${intercept}`);
  html = html.replace(/<body([^>]*)>/i, `<body$1>${toolbar}`);

  return html;
}

function rewriteCss(body, baseUrl, serverBase) {
  return body.replace(/url\((['"]?)([^)'"\s]+)\1\)/gi, (m, q, v) => {
    if (v.startsWith("data:")) return m;
    return `url(${q}${proxify(v, baseUrl, serverBase)}${q})`;
  });
}

function buildIntercept(serverBase) {
  return `
<script>
(function(){
  var SB = ${JSON.stringify(serverBase)};
  function px(u){
    if(!u||typeof u!=='string') return u;
    if(/^(javascript:|mailto:|#|data:|blob:|about:)/.test(u)) return u;
    if(u.startsWith(SB+'/proxy')) return u;
    try{ return SB+'/proxy?url='+encodeURIComponent(new URL(u, location.href).href); }
    catch(e){ return u; }
  }
  // XHR
  var xopen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(m,u){
    try{ u = px(u); } catch(e){}
    return xopen.apply(this, arguments);
  };
  // fetch
  var _f = window.fetch;
  window.fetch = function(u,o){
    try{ u = px(u); } catch(e){}
    return _f.call(this,u,o);
  };
  // pushState / replaceState
  var _ps = history.pushState, _rs = history.replaceState;
  history.pushState = function(s,t,u){ return _ps.call(this,s,t,u?px(u):u); };
  history.replaceState = function(s,t,u){ return _rs.call(this,s,t,u?px(u):u); };
  // window.open
  var _wo = window.open;
  window.open = function(u,t,f){ return _wo.call(this,px(u),t,f); };
  // intercept all clicks
  document.addEventListener('click', function(e){
    var a = e.target.closest('a[href]');
    if(!a) return;
    var h = a.getAttribute('href');
    if(!h||/^(javascript:|mailto:|#)/.test(h)) return;
    e.preventDefault();
    try{ location.href = px(h); } catch(err){}
  }, true);
})();
</script>`;
}

function buildToolbar(currentUrl, serverBase) {
  return `
<div id="__sp_bar" style="position:fixed;top:0;left:0;right:0;z-index:2147483647;height:48px;background:#1e1b4b;display:flex;align-items:center;gap:6px;padding:0 10px;box-shadow:0 2px 8px #0005;font-family:sans-serif">
  <a href="/" style="color:#fff;text-decoration:none;font-weight:700;font-size:1rem;white-space:nowrap;margin-right:4px">🌐 SP</a>
  <button onclick="history.back()" style="${btnStyle()}">◀</button>
  <button onclick="history.forward()" style="${btnStyle()}">▶</button>
  <button onclick="location.reload()" style="${btnStyle()}">↺</button>
  <input id="__sp_url" type="text" value="${escAttr(currentUrl)}"
    onkeydown="if(event.key==='Enter'){var u=this.value.trim();if(!/^https?:\\/\\//.test(u))u='https://'+u;location.href='${serverBase}/proxy?url='+encodeURIComponent(u);}"
    style="flex:1;background:#ffffff15;border:1px solid #ffffff30;border-radius:6px;padding:5px 10px;color:#fff;font-size:.82rem;outline:none;min-width:0"/>
  <button onclick="(function(){var u=document.getElementById('__sp_url').value.trim();if(!/^https?:\\/\\//.test(u))u='https://'+u;location.href='${serverBase}/proxy?url='+encodeURIComponent(u);})()" style="${btnStyle('background:#4f46e5')}">Go</button>
  <a href="/" style="${btnStyle()}">🏠</a>
</div>
<div style="height:48px"></div>`;
}

function btnStyle(extra) {
  return `background:#ffffff18;color:#fff;border:none;border-radius:6px;padding:5px 10px;cursor:pointer;font-size:.8rem;white-space:nowrap;text-decoration:none;display:inline-flex;align-items:center;${extra||''}`;
}
function escAttr(s) { return s.replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
