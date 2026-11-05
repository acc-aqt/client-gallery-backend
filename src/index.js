import { Zip, ZipPassThrough } from "fflate";

const COOKIE_NAME = "client_gallery";
const SESSION_SECONDS = 60 * 60 * 12;
const IMAGE_TYPES = new Set(["jpg", "jpeg", "png", "webp", "avif"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health") return new Response("ok", { headers: { "Cache-Control": "no-store" } });
    const galleryMatch = path.match(/^\/([a-z0-9][a-z0-9-]{0,62})\/?$/);
    const apiMatch = path.match(/^\/api\/gallery\/([a-z0-9][a-z0-9-]{0,62})$/);
    const imageMatch = path.match(/^\/image\/([a-z0-9][a-z0-9-]{0,62})\/([^/]+)$/);
    const downloadMatch = path.match(/^\/download-all\/([a-z0-9][a-z0-9-]{0,62})$/);
    const loginMatch = path.match(/^\/login\/([a-z0-9][a-z0-9-]{0,62})$/);
    const logoutMatch = path.match(/^\/logout\/([a-z0-9][a-z0-9-]{0,62})$/);

    if (request.method === "POST" && loginMatch) return login(request, env, loginMatch[1]);
    if (request.method === "POST" && logoutMatch) return logout(env, logoutMatch[1]);
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });

    const slug = galleryMatch?.[1] || apiMatch?.[1] || imageMatch?.[1] || downloadMatch?.[1];
    if (!slug) return new Response("Not found", { status: 404 });

    const manifest = await getManifest(env, slug);
    if (!manifest) return new Response("Gallery not found", { status: 404 });
    const session = await readSession(request, env, slug);

    if (galleryMatch) {
      if (!session) return pageResponse(loginPage(slug, manifest.title));
      return pageResponse(galleryPage(slug, manifest.title));
    }
    if (!session) return new Response("Unauthorized", { status: 401, headers: noStore() });

    if (apiMatch) {
      const objects = await listImages(env, slug);
      return json({ title: manifest.title, images: objects.map(({ name, key }) => ({ name, url: `/image/${slug}/${encodeURIComponent(name)}` })) });
    }
    if (imageMatch) {
      let filename;
      try { filename = decodeURIComponent(imageMatch[2]); } catch { return new Response("Not found", { status: 404 }); }
      if (!isSafeImageName(filename)) return new Response("Not found", { status: 404 });
      const object = await env.GALLERIES.get(imageKey(slug, filename));
      if (!object) return new Response("Not found", { status: 404 });
      return new Response(object.body, { headers: { ...noStore(), "Content-Type": object.httpMetadata?.contentType || imageMime(filename), "Content-Length": String(object.size), "X-Content-Type-Options": "nosniff" } });
    }
    if (downloadMatch) return downloadAll(env, slug);
    return new Response("Not found", { status: 404 });
  }
};

function noStore() { return { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" }; }
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { ...noStore(), "Content-Type": "application/json; charset=utf-8" } }); }
function pageResponse(html, status = 200) { return new Response(html, { status, headers: { ...noStore(), "Content-Type": "text/html; charset=utf-8" } }); }
function isSafeImageName(name) { return typeof name === "string" && name.length > 0 && name.length <= 240 && !name.includes("/") && !name.includes("\\") && name !== "." && name !== ".." && IMAGE_TYPES.has((name.split(".").pop() || "").toLowerCase()); }
function imageMime(name) { const ext = name.toLowerCase().split(".").pop(); return ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", avif: "image/avif" })[ext] || "application/octet-stream"; }
function imageKey(slug, name) { return `galleries/${slug}/images/${name}`; }

async function getManifest(env, slug) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) return null;
  const object = await env.GALLERIES.get(`galleries/${slug}/manifest.json`);
  if (!object) return null;
  try {
    const manifest = await object.json();
    if (manifest.version !== 1 || typeof manifest.title !== "string" || typeof manifest.passwordHash !== "string" || typeof manifest.passwordSalt !== "string") return null;
    return manifest;
  } catch { return null; }
}

async function listImages(env, slug) {
  const prefix = `galleries/${slug}/images/`;
  const images = [];
  let cursor;
  do {
    const result = await env.GALLERIES.list({ prefix, cursor, limit: 1000 });
    for (const object of result.objects) {
      const name = object.key.slice(prefix.length);
      if (isSafeImageName(name)) images.push({ name, key: object.key, size: object.size });
    }
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);
  images.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  return images;
}

async function login(request, env, slug) {
  if (request.headers.get("Origin") !== new URL(request.url).origin) return new Response("Forbidden", { status: 403 });
  const manifest = await getManifest(env, slug);
  if (!manifest) return new Response("Gallery not found", { status: 404 });
  let form;
  try { form = await request.formData(); } catch { return pageResponse(loginPage(slug, manifest.title, "Enter the password to view this gallery."), 400); }
  const password = form.get("password");
  if (typeof password !== "string" || password.length > 256 || !(await verifyPassword(password, manifest, env.SESSION_SECRET))) {
    return pageResponse(loginPage(slug, manifest.title, "That password did not match. Please try again."), 401);
  }
  const token = await makeSession(slug, env.SESSION_SECRET);
  return new Response(null, { status: 303, headers: { Location: `/${slug}`, "Set-Cookie": `${COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`, ...noStore() } });
}

async function logout(env, slug) {
  return new Response(null, { status: 303, headers: { Location: `/${slug}`, "Set-Cookie": `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`, ...noStore() } });
}

async function verifyPassword(password, manifest, secret) {
  if (!secret) return false;
  const salt = hexToBytes(manifest.passwordSalt);
  const expected = hexToBytes(manifest.passwordHash);
  if (!salt || !expected || expected.length !== 32) return false;
  const peppered = await hmac(secret, `gallery-password-v1:${password}`);
  const key = await crypto.subtle.importKey("raw", peppered, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 310000 }, key, 256);
  return constantTimeEqual(new Uint8Array(bits), expected);
}

async function makeSession(slug, secret) {
  const payload = `${slug}.${Math.floor(Date.now() / 1000) + SESSION_SECONDS}`;
  const sig = bytesToBase64Url(await hmac(secret, `gallery-session-v1:${payload}`));
  return `${bytesToBase64Url(new TextEncoder().encode(payload))}.${sig}`;
}

async function readSession(request, env, slug) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.split(";").map(part => part.trim()).find(part => part.startsWith(`${COOKIE_NAME}=`));
  if (!match || !env.SESSION_SECRET) return false;
  const token = match.slice(COOKIE_NAME.length + 1).split(".");
  if (token.length !== 2) return false;
  const payloadBytes = base64UrlToBytes(token[0]);
  const receivedSig = base64UrlToBytes(token[1]);
  if (!payloadBytes || !receivedSig) return false;
  const payload = new TextDecoder().decode(payloadBytes);
  const [tokenSlug, expires, extra] = payload.split(".");
  if (extra || tokenSlug !== slug || !/^\d+$/.test(expires) || Number(expires) < Date.now() / 1000) return false;
  const expected = await hmac(env.SESSION_SECRET, `gallery-session-v1:${payload}`);
  return constantTimeEqual(receivedSig, expected);
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}
function constantTimeEqual(a, b) { if (a.length !== b.length) return false; let diff = 0; for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]; return diff === 0; }
function hexToBytes(hex) { if (!/^(?:[\da-f]{2})+$/i.test(hex)) return null; return new Uint8Array(hex.match(/.{2}/g).map(x => parseInt(x, 16))); }
function bytesToBase64Url(bytes) { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function base64UrlToBytes(value) { if (!/^[\w-]+$/.test(value)) return null; try { const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4)); return Uint8Array.from(binary, char => char.charCodeAt(0)); } catch { return null; } }

function loginPage(slug, title, error = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · carrels.photography</title><style>${styles}</style></head><body><main class="login"><a class="brand" href="https://www.carrels.photography">carrels.photography</a><p class="eyebrow">PRIVATE CLIENT GALLERY</p><h1>${escapeHtml(title)}</h1><p class="muted">Enter the password to view your photographs.</p>${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}<form method="post" action="/login/${encodeURIComponent(slug)}"><label for="password">Gallery password</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="256"><button type="submit">Open gallery</button></form></main></body></html>`;
}

function galleryPage(slug, title) {
  const safeSlug = escapeHtml(slug);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)} · carrels.photography</title><style>${styles}</style></head><body><header class="top"><a class="brand" href="https://www.carrels.photography">carrels.photography</a><form method="post" action="/logout/${encodeURIComponent(slug)}"><button class="quiet" type="submit">Log out</button></form></header><main class="gallery"><div class="gallery-head"><div><p class="eyebrow">PRIVATE CLIENT GALLERY</p><h1>${escapeHtml(title)}</h1><p class="muted" id="count">Loading photographs…</p></div><a class="download" href="/download-all/${encodeURIComponent(slug)}">Download all images</a></div><div class="grid" id="grid"></div></main><dialog id="viewer"><button class="close" aria-label="Close">×</button><button class="prev" aria-label="Previous photo">‹</button><img alt=""><button class="next" aria-label="Next photo">›</button><a class="single-download" download>Download image</a></dialog><script>
const slug=${JSON.stringify(slug)}; const grid=document.querySelector('#grid'); const count=document.querySelector('#count'); const dialog=document.querySelector('#viewer'); const viewImg=dialog.querySelector('img'); let images=[]; let current=0;
function show(i){current=(i+images.length)%images.length;viewImg.src=images[current].url;viewImg.alt=images[current].name;dialog.querySelector('.single-download').href=images[current].url;dialog.querySelector('.single-download').download=images[current].name;dialog.showModal()}
dialog.querySelector('.close').onclick=()=>dialog.close();dialog.querySelector('.prev').onclick=()=>show(current-1);dialog.querySelector('.next').onclick=()=>show(current+1);dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close()});document.addEventListener('keydown',e=>{if(!dialog.open)return;if(e.key==='ArrowLeft')show(current-1);if(e.key==='ArrowRight')show(current+1)});
fetch('/api/gallery/'+encodeURIComponent(slug)).then(r=>{if(!r.ok)throw Error();return r.json()}).then(data=>{images=data.images;count.textContent=images.length+' photographs';if(!images.length){grid.innerHTML='<p class="muted">This gallery has no photographs yet.</p>';return}for(let i=0;i<images.length;i++){const item=images[i];const card=document.createElement('button');card.className='photo';card.type='button';card.setAttribute('aria-label','View '+item.name);const img=document.createElement('img');img.loading='lazy';img.src=item.url;img.alt=item.name;card.append(img);card.onclick=()=>show(i);grid.append(card)}}).catch(()=>{count.textContent='Could not load this gallery. Please refresh the page.'});
</script></body></html>`;
}

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]); }

async function downloadAll(env, slug) {
  const images = await listImages(env, slug);
  if (!images.length) return new Response("This gallery has no images", { status: 404 });
  let notifyPull;
  let isCancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      const zip = new Zip((error, chunk, final) => {
        if (error) { controller.error(error); return; }
        if (isCancelled) return;
        controller.enqueue(chunk);
        if (final) controller.close();
        if (notifyPull) { notifyPull(); notifyPull = undefined; }
      });
      const waitForCapacity = async () => {
        if (controller.desiredSize > 0 || isCancelled) return;
        await new Promise(resolve => { notifyPull = resolve; });
      };
      (async () => {
        try {
          for (const image of images) {
            if (isCancelled) return;
            const object = await env.GALLERIES.get(image.key);
            if (!object) continue;
            const entry = new ZipPassThrough(image.name);
            zip.add(entry);
            const reader = object.body.getReader();
            try {
              while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                entry.push(value, false);
                await waitForCapacity();
              }
            } finally { reader.releaseLock(); }
            entry.push(new Uint8Array(0), true);
            await waitForCapacity();
          }
          zip.end();
        } catch (error) { if (!isCancelled) { try { controller.error(error); } catch {} } }
      })();
    },
    pull() { if (notifyPull) { notifyPull(); notifyPull = undefined; } },
    cancel() { isCancelled = true; if (notifyPull) notifyPull(); }
  });
  return new Response(stream, { headers: { ...noStore(), "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${slug}.zip"` } });
}

const styles = `:root{color-scheme:dark;--bg:#101010;--panel:#171717;--text:#f2f0ec;--muted:#aaa49d;--line:#353535;--accent:#d8c6ad}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh}.brand{font-family:Georgia,serif;font-size:19px;letter-spacing:.02em;color:var(--text);text-decoration:none}.eyebrow{font-size:11px;letter-spacing:.18em;color:var(--accent);margin:0 0 14px}h1{font-family:Georgia,serif;font-weight:400;font-size:clamp(34px,5vw,56px);line-height:1.08;margin:0 0 12px}.muted{color:var(--muted)}.login{width:min(440px,calc(100% - 40px));margin:12vh auto 0}.login .brand{display:inline-block;margin-bottom:78px}.login form{display:grid;gap:10px;margin-top:32px}.login label{font-size:13px;color:#d5d0c9}.login input{font:inherit;padding:14px 15px;background:#202020;color:var(--text);border:1px solid var(--line);border-radius:2px}.login button,.download{display:inline-flex;align-items:center;justify-content:center;background:var(--accent);border:0;border-radius:2px;color:#171512;text-decoration:none;font:600 13px/1.2 inherit;padding:15px 19px;cursor:pointer}.login button{margin-top:8px}.error{background:#311e1b;color:#ffd7cf;border:1px solid #67352d;padding:11px 13px;font-size:14px}.top{height:78px;padding:0 clamp(20px,5vw,76px);border-bottom:1px solid #242424;display:flex;align-items:center;justify-content:space-between}.top form{margin:0}.quiet{border:0;background:none;color:var(--muted);font:inherit;cursor:pointer}.gallery{padding:54px clamp(20px,5vw,76px) 80px}.gallery-head{display:flex;align-items:end;justify-content:space-between;gap:28px;margin:0 0 34px}.gallery-head .muted{margin:0}.download{white-space:nowrap}.grid{columns:3 260px;column-gap:16px}.photo{border:0;padding:0;background:none;display:block;width:100%;margin:0 0 16px;break-inside:avoid;cursor:zoom-in}.photo img{display:block;width:100%;height:auto;background:#202020}.photo img:hover{opacity:.88}dialog{position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:56px 72px 76px;background:rgba(9,9,9,.97);border:0;color:white}dialog::backdrop{background:rgba(0,0,0,.92)}dialog img{display:block;max-width:100%;max-height:calc(100vh - 150px);width:auto;height:auto;object-fit:contain;margin:auto}.close,.prev,.next{position:absolute;border:0;background:none;color:white;cursor:pointer;font:36px/1 Arial}.close{top:15px;right:28px;font-size:42px}.prev{left:20px;top:48%}.next{right:20px;top:48%}.single-download{position:absolute;bottom:20px;left:50%;transform:translateX(-50%);color:var(--accent);font-size:13px}@media(max-width:650px){.gallery{padding-top:36px}.gallery-head{align-items:start;flex-direction:column}.grid{columns:2 140px;column-gap:10px}.photo{margin-bottom:10px}.top{height:64px}.gallery{padding-inline:14px}.gallery-head{gap:18px}dialog{padding:50px 42px 70px}.prev{left:7px}.next{right:7px}}`;
