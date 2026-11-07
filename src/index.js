import { ZipWriter } from "@zip.js/zip.js";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import "dotenv/config";

const SESSION_SECONDS = 60 * 60 * 12;
const API_ROOT = "https://www.googleapis.com/drive/v3";
let tokenCache;
let tokenRefresh;

async function handleRequest(request, env) {
  try {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health") return new Response("ok", { headers: noStore() });

    const apiMatch = path.match(/^\/api\/gallery\/([a-z0-9][a-z0-9-]{0,62})$/);
    const imageMatch = path.match(/^\/(image|thumb)\/([a-z0-9][a-z0-9-]{0,62})\/([\w-]+)$/);
    const downloadMatch = path.match(/^\/download-all\/([a-z0-9][a-z0-9-]{0,62})$/);
    const highResDownloadMatch = path.match(/^\/download-highres\/([a-z0-9][a-z0-9-]{0,62})$/);
    const loginMatch = path.match(/^\/login\/([a-z0-9][a-z0-9-]{0,62})$/);

    if (request.method === "POST" && loginMatch) return login(request, env, loginMatch[1]);
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });

    const slug = apiMatch?.[1] || imageMatch?.[2] || downloadMatch?.[1] || highResDownloadMatch?.[1];
    if (!slug) return new Response("Not found", { status: 404 });

    const session = await readSession(request, env, slug, url.searchParams.get("token"));
    if (!session) return new Response("Unauthorized", { status: 401, headers: noStore() });

    if (apiMatch) {
      const images = await listImages(env, session.folderId, session.manifestId);
      const highResArchiveId = await getHighResArchiveId(env, session.folderId);
      return json({ title: session.title, hasHighResArchive: Boolean(highResArchiveId), images: images.map(file => ({
        id: file.id,
        name: file.galleryPath || file.name,
        width: file.imageMediaMetadata?.width || null,
        height: file.imageMediaMetadata?.height || null,
        url: `/image/${slug}/${file.id}`,
        thumb: `/thumb/${slug}/${file.id}`
      })) });
    }
    if (imageMatch) return serveImage(env, session, imageMatch[1], imageMatch[3]);
    if (downloadMatch) return downloadAll(env, session, slug);
    if (highResDownloadMatch) return downloadHighResArchive(env, session, slug);
    return new Response("Not found", { status: 404 });
  } catch (error) {
    console.error("Client gallery request failed:", error);
    return json({ error: "The gallery service could not complete this request." }, 500);
  }
}

function allowedOrigins(env) {
  return String(env.FRONTEND_ORIGINS || "").split(",").map(origin => origin.trim()).filter(Boolean);
}

async function fetchHandler(request, env) {
  const origin = request.headers.get("Origin");
  const permitted = origin && allowedOrigins(env).includes(origin);
  if (request.method === "OPTIONS") {
    if (!permitted) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (origin && !permitted) return new Response("Origin not allowed", { status: 403, headers: noStore() });
  const response = await handleRequest(request, env);
  const headers = new Headers(response.headers);
  if (permitted) for (const [key, value] of Object.entries(corsHeaders(origin))) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin"
  };
}

const server = createServer(async (incoming, outgoing) => {
  const origin = `http://${incoming.headers.host || "localhost"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  const init = { method: incoming.method, headers };
  if (!new Set(["GET", "HEAD", "OPTIONS"]).has(incoming.method || "GET")) {
    init.body = Readable.toWeb(incoming);
    init.duplex = "half";
  }
  try {
    const request = new Request(new URL(incoming.url || "/", origin), init);
    const response = await fetchHandler(request, process.env);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body || incoming.method === "HEAD") { outgoing.end(); return; }
    Readable.fromWeb(response.body).pipe(outgoing);
  } catch (error) {
    console.error("HTTP adapter failed:", error);
    outgoing.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end("Internal server error");
  }
});

const port = Number(process.env.PORT || 10000);
server.listen(port, process.env.PORT ? "0.0.0.0" : "127.0.0.1", () => console.log(`Client gallery API listening on http://localhost:${port}`));

function noStore() {
  return {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY"
  };
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...noStore(), "Content-Type": "application/json; charset=utf-8" } });
}
function googleApiUrl(path, params) {
  const url = new URL(`${API_ROOT}/${path}`);
  if (params) for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }
  return url;
}

async function getAccessToken(env) {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.accessToken;
  if (tokenRefresh) return tokenRefresh;
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) {
    throw new Error("Google Drive OAuth secrets are not configured.");
  }
  tokenRefresh = (async () => {
    const body = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token"
    });
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    if (!response.ok) throw new Error("Google Drive could not refresh its access token.");
    const data = await response.json();
    tokenCache = { accessToken: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
    return tokenCache.accessToken;
  })();
  try { return await tokenRefresh; }
  finally { tokenRefresh = undefined; }
}

async function driveRequest(env, path, { params, method = "GET", body, contentType, signal } = {}) {
  const token = await getAccessToken(env);
  const headers = { Authorization: `Bearer ${token}` };
  if (contentType) headers["Content-Type"] = contentType;
  return fetch(googleApiUrl(path, params), { method, headers, body, redirect: "follow", signal });
}

async function driveJson(env, path, options) {
  const response = await driveRequest(env, path, options);
  if (!response.ok) throw new Error(`Google Drive API request failed (${response.status}).`);
  return response.json();
}

async function findGallery(env, slug) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) return null;
  const q = `mimeType = 'application/vnd.google-apps.folder' and trashed = false and appProperties has { key='clientGallerySlug' and value='${slug}' }`;
  const data = await driveJson(env, "files", { params: {
    q,
    pageSize: "1",
    includeItemsFromAllDrives: "true",
    supportsAllDrives: "true",
    fields: "files(id,name,appProperties)"
  } });
  const folder = data.files?.[0];
  const props = folder?.appProperties || {};
  if (!folder || props.clientGalleryPasswordHash === undefined || props.clientGalleryPasswordSalt === undefined) return null;
  return {
    id: folder.id,
    title: props.clientGalleryTitle || folder.name,
    passwordHash: props.clientGalleryPasswordHash,
    passwordSalt: props.clientGalleryPasswordSalt,
    manifestId: props.clientGalleryManifestId || null
  };
}

async function getHighResArchiveId(env, folderId) {
  const folder = await driveJson(env, `files/${encodeURIComponent(folderId)}`, {
    params: { fields: "appProperties", supportsAllDrives: "true" }
  });
  const archiveId = folder.appProperties?.clientGalleryHighResArchiveId;
  return typeof archiveId === "string" && /^[\w-]{10,200}$/.test(archiveId) ? archiveId : null;
}

async function listImages(env, folderId, manifestId = null) {
  if (manifestId) {
    const manifest = await readManifest(env, manifestId);
    return manifest.map(file => ({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      size: file.size,
      imageMediaMetadata: file.width && file.height ? { width: file.width, height: file.height } : null
    }));
  }
  const files = [];
  const pending = [{ id: folderId, path: "" }];
  const visited = new Set([folderId]);
  while (pending.length) {
    const current = pending.shift();
    let pageToken;
    do {
      const data = await driveJson(env, "files", { params: {
        q: `'${current.id}' in parents and trashed = false`,
        pageSize: "1000",
        pageToken,
        includeItemsFromAllDrives: "true",
        supportsAllDrives: "true",
        orderBy: "name",
        fields: "nextPageToken,files(id,name,mimeType,size,thumbnailLink,imageMediaMetadata(width,height))"
      } });
      for (const file of data.files || []) {
        if (file.mimeType === "application/vnd.google-apps.folder" && !visited.has(file.id)) {
          visited.add(file.id);
          pending.push({ id: file.id, path: current.path ? `${current.path}/${file.name}` : file.name });
        } else if (isDisplayImage(file)) {
          const relativePath = current.path ? `${current.path}/${file.name}` : file.name;
          files.push({ ...file, galleryPath: relativePath });
        }
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
  }
  files.sort((a, b) => a.galleryPath.localeCompare(b.galleryPath, undefined, { numeric: true, sensitivity: "base" }));
  return files;
}

async function readManifest(env, manifestId) {
  const response = await driveRequest(env, `files/${encodeURIComponent(manifestId)}`, { params: { alt: "media" } });
  if (!response.ok) throw new Error("Google Drive could not read this gallery's photo list.");
  const manifest = await response.json();
  if (!Array.isArray(manifest)) throw new Error("This gallery's photo list is invalid.");
  return manifest.filter(file => typeof file.id === "string" && typeof file.name === "string" && isDisplayImage(file));
}

function isDisplayImage(file) {
  return typeof file.id === "string" && typeof file.name === "string" &&
    ["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"].includes(file.mimeType);
}

async function getCheckedImage(env, folderId, fileId, manifestId = null) {
  if (!/^[\w-]{10,200}$/.test(fileId)) return null;
  let manifestEntry = null;
  if (manifestId) {
    manifestEntry = (await readManifest(env, manifestId)).find(entry => entry.id === fileId);
    if (!manifestEntry) return null;
  }
  const file = await driveJson(env, `files/${encodeURIComponent(fileId)}`, {
    params: { fields: "id,name,mimeType,parents,size,thumbnailLink,imageMediaMetadata(width,height)", supportsAllDrives: "true" }
  });
  if (!isDisplayImage(file)) return null;
  if (manifestEntry && file.mimeType !== manifestEntry.mimeType) return null;
  if (!manifestEntry && !(await isGalleryDescendant(env, file.parents || [], folderId))) return null;
  if (manifestEntry) file.name = manifestEntry.name;
  return file;
}

async function isGalleryDescendant(env, initialParents, folderId) {
  const pending = [...initialParents];
  const visited = new Set();
  while (pending.length && visited.size < 100) {
    const parentId = pending.shift();
    if (parentId === folderId) return true;
    if (visited.has(parentId)) continue;
    visited.add(parentId);
    const parent = await driveJson(env, `files/${encodeURIComponent(parentId)}`, {
      params: { fields: "id,mimeType,parents", supportsAllDrives: "true" }
    });
    if (parent.mimeType !== "application/vnd.google-apps.folder") continue;
    for (const ancestor of parent.parents || []) if (!visited.has(ancestor)) pending.push(ancestor);
  }
  return false;
}

async function serveImage(env, session, type, fileId) {
  const file = await getCheckedImage(env, session.folderId, fileId, session.manifestId);
  if (!file) return new Response("Not found", { status: 404, headers: noStore() });
  const response = await driveRequest(env, `files/${encodeURIComponent(fileId)}`, { params: { alt: "media", supportsAllDrives: "true" } });
  if (!response.ok || !response.body) return new Response("Photo unavailable", { status: response.status || 502, headers: noStore() });
  const headers = { ...noStore(), "Content-Type": file.mimeType };
  if (file.size) headers["Content-Length"] = file.size;
  if (type === "image") headers["Content-Disposition"] = `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`;
  return new Response(response.body, { headers });
}

async function login(request, env, slug) {
  const gallery = await findGallery(env, slug);
  if (!gallery) return new Response("Gallery not found", { status: 404 });
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Enter the gallery password." }, 400); }
  const password = body?.password;
  if (typeof password !== "string" || password.length > 256 || !(await verifyPassword(password, gallery))) return json({ error: "That password did not match. Please try again." }, 401);
  const token = await makeSession(slug, gallery, env.SESSION_SECRET);
  return json({ token, expiresIn: SESSION_SECONDS, title: gallery.title });
}

async function verifyPassword(password, gallery) {
  const salt = hexToBytes(gallery.passwordSalt);
  const expected = hexToBytes(gallery.passwordHash);
  if (!salt || !expected || expected.length !== 32) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 310000 }, key, 256);
  return constantTimeEqual(new Uint8Array(bits), expected);
}

async function makeSession(slug, gallery, secret) {
  if (!secret) throw new Error("SESSION_SECRET is not configured.");
  const payload = JSON.stringify({ slug, folderId: gallery.id, manifestId: gallery.manifestId || null, title: gallery.title, expiresAt: Math.floor(Date.now() / 1000) + SESSION_SECONDS });
  const encoded = bytesToBase64Url(new TextEncoder().encode(payload));
  const sig = bytesToBase64Url(await hmac(secret, `gallery-session-v1:${encoded}`));
  return `${encoded}.${sig}`;
}

async function readSession(request, env, slug, queryToken = null) {
  if (!env.SESSION_SECRET) return null;
  const bearer = request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const tokenValue = bearer || queryToken;
  if (!tokenValue || tokenValue.length > 2048) return null;
  const token = tokenValue.split(".");
  if (token.length !== 2) return null;
  const payloadBytes = base64UrlToBytes(token[0]);
  const receivedSig = base64UrlToBytes(token[1]);
  if (!payloadBytes || !receivedSig) return null;
  const encoded = token[0];
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(payloadBytes)); } catch { return null; }
  if (payload.slug !== slug || !/^[\w-]{10,200}$/.test(payload.folderId || "") || !Number.isInteger(payload.expiresAt) || payload.expiresAt < Date.now() / 1000) return null;
  const expected = await hmac(env.SESSION_SECRET, `gallery-session-v1:${encoded}`);
  if (!constantTimeEqual(receivedSig, expected)) return null;
  if (payload.manifestId !== null && payload.manifestId !== undefined && !/^[\w-]{10,200}$/.test(payload.manifestId)) return null;
  return { folderId: payload.folderId, manifestId: payload.manifestId || null, title: String(payload.title || "Client gallery") };
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
function hexToBytes(hex) {
  if (typeof hex !== "string" || !/^(?:[\da-f]{2})+$/i.test(hex)) return null;
  return new Uint8Array(hex.match(/.{2}/g).map(byte => parseInt(byte, 16)));
}
function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64UrlToBytes(value) {
  if (!/^[\w-]+$/.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4));
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  } catch { return null; }
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function loginPage(slug, title, error = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)} · carrels.photography</title><link href="https://fonts.googleapis.com/css?family=Poppins:400,500,600,700%7CAllura" rel="stylesheet"><style>${styles}</style></head><body><header><a class="brand" href="https://www.carrels.photography">carrels.photography</a></header><main class="login"><p class="eyebrow">PRIVATE CLIENT GALLERY</p><h1>${escapeHtml(title)}</h1><p class="description">Enter the password to view this gallery.</p>${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}<form method="post" action="/login/${encodeURIComponent(slug)}"><label for="password">Gallery password</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="256"><button type="submit">Open gallery</button></form></main></body></html>`;
}

function galleryPage(slug, title) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)} · carrels.photography</title><link href="https://fonts.googleapis.com/css?family=Poppins:400,500,600,700%7CAllura" rel="stylesheet"><style>${styles}</style></head><body><header><a class="brand" href="https://www.carrels.photography">carrels.photography</a><nav><a href="mailto:carrelsphotography@icloud.com">Contact</a><a href="https://www.instagram.com/carrels.photography/" aria-label="Instagram">Instagram</a><form method="post" action="/logout/${encodeURIComponent(slug)}"><button type="submit">Log out</button></form></nav></header><main><section class="portfolio-heading"><p class="eyebrow">PRIVATE CLIENT GALLERY</p><h1>${escapeHtml(title)}</h1><p id="count">Loading photographs…</p><a class="download-all" href="/download-all/${encodeURIComponent(slug)}">Download all images <span aria-hidden="true">↓</span></a></section><section class="main-section"><div class="photo-grid" id="grid"></div></section></main><dialog id="viewer" aria-label="Photo viewer"><button class="close" aria-label="Close">×</button><button class="prev" aria-label="Previous photo">‹</button><img alt=""><button class="next" aria-label="Next photo">›</button><div class="view-caption"><span class="counter"></span><a class="single-download" download>Download image</a></div></dialog><script>
const slug=${JSON.stringify(slug)};const grid=document.querySelector('#grid');const count=document.querySelector('#count');const dialog=document.querySelector('#viewer');const viewImg=dialog.querySelector('img');let images=[];let current=0;
function show(i){current=(i+images.length)%images.length;viewImg.src=images[current].url;viewImg.alt=images[current].name;dialog.querySelector('.counter').textContent=(current+1)+' / '+images.length;const link=dialog.querySelector('.single-download');link.href=images[current].url;link.download=images[current].name;dialog.showModal()}
dialog.querySelector('.close').onclick=()=>dialog.close();dialog.querySelector('.prev').onclick=()=>show(current-1);dialog.querySelector('.next').onclick=()=>show(current+1);dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close()});document.addEventListener('keydown',e=>{if(!dialog.open)return;if(e.key==='ArrowLeft')show(current-1);if(e.key==='ArrowRight')show(current+1)});
fetch('/api/gallery/'+encodeURIComponent(slug)).then(r=>{if(!r.ok)throw Error();return r.json()}).then(data=>{images=data.images;count.textContent=images.length+' photographs';if(!images.length){grid.innerHTML='<p class="empty">This gallery has no photographs yet.</p>';return}for(let i=0;i<images.length;i++){const item=images[i];const card=document.createElement('button');card.className='photo';card.type='button';card.setAttribute('aria-label','View '+item.name);const img=document.createElement('img');img.loading='lazy';img.decoding='async';img.src=item.thumb;img.alt=item.name;if(item.width&&item.height)img.style.aspectRatio=item.width+'/'+item.height;card.append(img);card.onclick=()=>show(i);grid.append(card)}}).catch(()=>{count.textContent='Could not load this gallery. Please refresh the page.'});
</script></body></html>`;
}

async function downloadAll(env, session, slug) {
  const images = await listImages(env, session.folderId, session.manifestId);
  if (!images.length) return new Response("This gallery has no images", { status: 404, headers: noStore() });
  let isCancelled = false;
  let outputController;
  let notifyPull;
  const abortController = new AbortController();
  const stream = new ReadableStream({
    start(controller) { outputController = controller; },
    pull() { if (notifyPull) { notifyPull(); notifyPull = undefined; } },
    cancel() { isCancelled = true; abortController.abort(); if (notifyPull) notifyPull(); }
  });
  const zipOutput = new WritableStream({
    async write(chunk) {
      if (isCancelled) return;
      if (outputController.desiredSize <= 0) await new Promise(resolve => { notifyPull = resolve; });
      if (!isCancelled) outputController.enqueue(chunk);
    },
    close() { if (!isCancelled) outputController.close(); },
    abort(error) { if (!isCancelled) outputController.error(error); }
  });
  const zip = new ZipWriter(zipOutput, { zip64: true, compressionMethod: 0, bufferedWrite: false, useWebWorkers: false, signal: abortController.signal });
  (async () => {
    try {
      for (const image of images) {
        if (isCancelled) return;
        const response = await driveRequest(env, `files/${encodeURIComponent(image.id)}`, { params: { alt: "media", supportsAllDrives: "true" }, signal: abortController.signal });
        if (!response.ok || !response.body) throw new Error(`Google Drive could not provide ${image.name}.`);
        const entryName = (image.galleryPath || image.name).split("/").map(part => part.replace(/[\\\x00-\x1f]/g, "_").replace(/^\.+$/, "_")).join("/");
        await zip.add(entryName, response.body, { compressionMethod: 0, zip64: true, signal: abortController.signal });
      }
      if (!isCancelled) await zip.close();
    } catch (error) { if (!isCancelled) { try { outputController.error(error); } catch {} } }
  })();
  return new Response(stream, { headers: { ...noStore(), "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${slug}.zip"` } });
}

async function downloadHighResArchive(env, session, slug) {
  const archiveId = await getHighResArchiveId(env, session.folderId);
  if (!archiveId) return new Response("No high-res archive is configured for this gallery.", { status: 404, headers: noStore() });
  const archive = await driveJson(env, `files/${encodeURIComponent(archiveId)}`, {
    params: { fields: "id,name,mimeType,size,trashed", supportsAllDrives: "true" }
  });
  if (archive.trashed || !String(archive.name || "").toLowerCase().endsWith(".tar.gz")) {
    return new Response("The high-res archive is unavailable.", { status: 404, headers: noStore() });
  }
  const response = await driveRequest(env, `files/${encodeURIComponent(archiveId)}`, { params: { alt: "media", supportsAllDrives: "true" } });
  if (!response.ok || !response.body) return new Response("Google Drive could not provide the high-res archive.", { status: response.status || 502, headers: noStore() });
  const headers = {
    ...noStore(),
    "Content-Type": "application/gzip",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(archive.name)}`,
    "X-Content-Type-Options": "nosniff"
  };
  if (archive.size) headers["Content-Length"] = archive.size;
  return new Response(response.body, { headers });
}

const styles = `:root{--page-x:10px;--header-h:60px;--text:#6c5d53;--hover:#ccc3bd;--bg:#fff;--gap:5px}*{box-sizing:border-box}html{min-height:100%;overflow-x:hidden}body{min-height:100vh;margin:0;padding:60px var(--page-x) 0;font-family:Poppins,Arial,sans-serif;font-size:15px;font-weight:400;line-height:1.4;color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased}a,button{color:inherit;text-decoration:none;transition:color .2s ease,opacity .2s ease}a:hover,button:hover{color:var(--hover)}button{font:inherit;cursor:pointer}header{position:fixed;top:0;left:var(--page-x);right:var(--page-x);height:var(--header-h);z-index:10;background:var(--bg);display:flex;align-items:center;justify-content:space-between;padding:0 15px}.brand{font-family:Allura,cursive;font-size:31px;color:var(--text)}nav{display:flex;align-items:center;gap:30px;font-size:13px}nav form{margin:0}nav button{background:none;border:0;padding:0}.portfolio-heading{text-align:center;padding:20px 20px 20px}.eyebrow{font-size:10px;letter-spacing:2px;text-transform:uppercase;opacity:.65;margin:0 0 4px}.portfolio-heading h1{font-size:28px;letter-spacing:2px;font-weight:400;margin:0 0 8px;line-height:1.3}.portfolio-heading>p:not(.eyebrow){font-size:13px;letter-spacing:1px;opacity:.7;margin:0}.download-all{display:inline-flex;gap:10px;align-items:center;margin-top:17px;padding:10px 17px;border:1px solid #c9c1ba;font-size:12px;letter-spacing:.4px}.download-all:hover{background:#f4f1ee;color:var(--text)}.main-section{position:relative;overflow:visible;margin:0}.photo-grid{column-count:5;column-gap:var(--gap)}.photo{display:block;width:100%;padding:0;margin:0 0 var(--gap);border:0;background:none;line-height:0;overflow:hidden;break-inside:avoid}.photo img{display:block;width:100%;height:auto;object-fit:cover;background:#f3f1ef}.photo:hover img{opacity:.88}.photo:focus-visible,.download-all:focus-visible{outline:2px solid #6c5d53;outline-offset:2px}.empty{text-align:center;padding:60px 0}.login{width:min(420px,calc(100% - 32px));margin:10vh auto}.login .eyebrow{margin-bottom:12px}.login h1{font-weight:400;font-size:30px;line-height:1.2;letter-spacing:1px;margin:0 0 8px}.description{font-size:13px;opacity:.75;margin:0 0 24px}.login form{display:grid;gap:10px}.login label{font-size:12px;letter-spacing:.5px}.login input{font:inherit;padding:12px;border:1px solid #c9c1ba;color:var(--text);background:white}.login form button{justify-self:start;background:#6c5d53;color:white;border:0;padding:13px 20px;margin-top:5px;font-size:12px;letter-spacing:.5px}.login form button:hover{background:#88796f;color:white}.error{font-size:13px;color:#9b3324;margin:0 0 15px}dialog{position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:54px 62px 72px;background:rgba(0,0,0,.96);border:0;color:#fff}dialog::backdrop{background:rgba(0,0,0,.92)}dialog img{display:block;max-width:100%;max-height:calc(100vh - 142px);width:auto;height:auto;object-fit:contain;margin:auto}.close,.prev,.next{position:absolute;border:0;background:none;color:#fff;cursor:pointer;font:38px/1 Arial,sans-serif}.close{top:12px;right:22px;font-size:42px}.prev{left:19px;top:47%}.next{right:19px;top:47%}.view-caption{position:absolute;bottom:18px;left:0;right:0;display:flex;justify-content:center;align-items:center;gap:26px;font-size:12px;color:#d3ccc7}.single-download{color:#eee;text-decoration:underline}.single-download:hover{color:#ccc}.view-caption .counter{min-width:45px;text-align:right}@media(max-width:1200px){.photo-grid{column-count:4}}@media(max-width:900px){.photo-grid{column-count:3}}@media(max-width:600px){body{padding-top:60px}header{left:0;right:0;padding:0 15px}nav{gap:14px;font-size:12px}.brand{font-size:27px}.photo-grid{column-count:2}.portfolio-heading{padding:10px 0 14px}.portfolio-heading h1{font-size:24px;letter-spacing:1.5px}.portfolio-heading>p:not(.eyebrow){font-size:12px}}@media(max-width:420px){.photo-grid{column-count:1}nav{gap:10px}.portfolio-heading h1{font-size:22px}}`;
