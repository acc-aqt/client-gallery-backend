import "dotenv/config";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { google } from "googleapis";
import sharp from "sharp";

const MAX_BYTES = 10 * 1024 ** 3;
const SUPPORTED = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif"]);
const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".avif": "image/avif", ".gif": "image/gif" };
const args = process.argv.slice(2);
const [command, slug, directory] = args;

function help() {
  console.log(`Usage:\n  npm run gallery -- import <job-slug>\n  npm run gallery -- edit <job-slug>\n  npm run gallery -- refresh-previews <job-slug>\n  npm run gallery -- attach-highres <job-slug>\n  npm run gallery -- upload <job-slug> <folder-with-images>\n  npm run gallery -- delete <job-slug>\n\n"import" opens Google Drive Picker so you can select existing Drive photos without copying them.\n"edit" lets you remove listed photos and/or add more Drive photos to a Picker-linked gallery.\n"refresh-previews" creates sharper, compressed gallery previews for an existing Picker-linked gallery.\n"attach-highres" links one .tar.gz archive already stored in Drive to a gallery.\nJob slugs use lowercase letters, numbers, and hyphens, for example: wedding-2026.`);
}
if (!command || command === "--help" || command === "help") { help(); process.exit(0); }
if (!["import", "edit", "refresh-previews", "attach-highres", "upload", "delete"].includes(command) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug || "")) {
  help(); process.exit(2);
}

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
if (!clientId || !clientSecret || !refreshToken) {
  console.error("Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN in .env first.");
  process.exit(2);
}
const auth = new google.auth.OAuth2(clientId, clientSecret);
auth.setCredentials({ refresh_token: refreshToken });
const drive = google.drive({ version: "v3", auth });

if (command === "import") await importGallery(slug);
else if (command === "edit") await editGallery(slug);
else if (command === "refresh-previews") await refreshGalleryPreviews(slug);
else if (command === "attach-highres") await attachHighResArchive(slug);
else if (command === "upload") await uploadGallery(slug, directory);
else await deleteGallery(slug);

async function attachHighResArchive(jobSlug) {
  const gallery = await findGallery(jobSlug);
  if (!gallery) throw new Error(`Gallery ${jobSlug} was not found in the connected Google Drive.`);
  const { file, pickerDrive, tokens } = await pickHighResArchive();
  const manifestId = gallery.appProperties?.clientGalleryManifestId;
  const existingBytes = manifestId
    ? (await readDriveManifest(manifestId)).reduce((sum, image) => sum + BigInt(image.size || 0) + BigInt(image.previewSize || 0), 0n)
    : 0n;
  if (existingBytes + BigInt(file.size || 0) > BigInt(MAX_BYTES)) {
    throw new Error(`Gallery photos and the high-res archive would exceed the 10 GiB per-job limit. Nothing was attached.`);
  }
  await pickerDrive.files.update({
    fileId: gallery.id,
    requestBody: { appProperties: {
      ...(gallery.appProperties || {}),
      clientGalleryHighResArchiveId: file.id
    } },
    fields: "id,appProperties"
  });
  console.log(`Attached ${file.name} to ${jobSlug}; the gallery will stream this archive directly to clients.`);
  printGalleryLink(jobSlug);
  printRefreshTokenNotice(tokens);
}

async function pickHighResArchive() {
  const redirectUri = "http://localhost:53682/oauth2callback";
  const pickerAuth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const authUrl = pickerAuth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/drive.file"],
    trigger_onepick: "true",
    allow_multiple: "false"
  });
  const result = await waitForDrivePicker(redirectUri, authUrl, 1, "single .tar.gz archive");
  if (result.pickedFileIds.length !== 1) throw new Error("Select exactly one .tar.gz archive.");
  const tokens = (await pickerAuth.getToken(result.code)).tokens;
  pickerAuth.setCredentials(tokens);
  const pickerDrive = google.drive({ version: "v3", auth: pickerAuth });
  const { data: file } = await pickerDrive.files.get({
    fileId: result.pickedFileIds[0],
    supportsAllDrives: true,
    fields: "id,name,mimeType,size,trashed"
  });
  if (file.trashed || !file.name?.toLowerCase().endsWith(".tar.gz") || !file.mimeType?.startsWith("application/") || file.mimeType.startsWith("application/vnd.google-apps.")) {
    throw new Error(`“${file.name}” is not a supported .tar.gz archive.`);
  }
  return { file, pickerDrive, tokens };
}

async function importGallery(jobSlug) {
  if (await findGallery(jobSlug)) throw new Error(`Gallery ${jobSlug} already exists. Delete it first if you intend to replace it.`);
  const { files, pickerDrive, tokens } = await pickDriveFilesInBatches();
  const existing = await pickerDrive.files.list({
    q: `mimeType = 'application/vnd.google-apps.folder' and trashed = false and appProperties has { key='clientGallerySlug' and value='${jobSlug}' }`,
    pageSize: 1,
    fields: "files(id,name)"
  });
  if (existing.data.files?.length) throw new Error(`Gallery ${jobSlug} already exists. Delete it first if you intend to replace it.`);
  if (!files.length) throw new Error("No supported photos were selected.");
  assignUniqueGalleryNames(files);
  const totalBytes = files.reduce((sum, file) => sum + BigInt(file.size || 0), 0n);
  if (totalBytes > BigInt(MAX_BYTES)) throw new Error(`This gallery is ${(Number(totalBytes) / 1024 ** 3).toFixed(2)} GiB. The configured per-job limit is 10 GiB.`);

  const { title, password, salt, passwordHash } = await promptGalleryDetails(jobSlug, jobSlug.replaceAll("-", " "));
  const createdFolder = await pickerDrive.files.create({
    requestBody: { name: `Carrels client gallery ${jobSlug}`, mimeType: "application/vnd.google-apps.folder" },
    fields: "id,name"
  });
  const folderId = createdFolder.data.id;
  let manifestId;
  const createdPreviewIds = [];
  let previewBytes = 0n;
  try {
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      const preview = await createPreviewFile(pickerDrive, file.id, folderId);
      file.previewId = preview.id;
      file.previewSize = preview.size;
      createdPreviewIds.push(preview.id);
      previewBytes += BigInt(preview.size || 0);
      if (totalBytes + previewBytes > BigInt(MAX_BYTES)) {
        throw new Error(`Originals plus previews exceed the 10 GiB gallery limit. No gallery was created.`);
      }
      console.log(`Prepared gallery preview ${index + 1}/${files.length}: ${file.name}`);
    }
    const manifest = files.map(manifestEntry);
    const manifestFile = await pickerDrive.files.create({
      requestBody: { name: "gallery-manifest.json", mimeType: "application/json", parents: [folderId] },
      media: { mimeType: "application/json", body: JSON.stringify(manifest) },
      fields: "id"
    });
    manifestId = manifestFile.data.id;
    const appProperties = {
      clientGallerySlug: jobSlug,
      clientGalleryTitle: title,
      clientGalleryPasswordSalt: salt.toString("hex"),
      clientGalleryPasswordHash: passwordHash,
      clientGallerySource: "picked-files",
      clientGalleryManifestId: manifestId
    };
    await pickerDrive.files.update({ fileId: folderId, requestBody: { appProperties }, fields: "id,appProperties" });
  } catch (error) {
    if (manifestId) await pickerDrive.files.delete({ fileId: manifestId }).catch(() => {});
    for (const previewId of createdPreviewIds) await pickerDrive.files.delete({ fileId: previewId }).catch(() => {});
    await pickerDrive.files.delete({ fileId: folderId }).catch(() => {});
    throw error;
  }
  printGalleryLink(jobSlug);
  console.log(`${files.length} selected photos were linked without copying them`);
  console.log(`Password (copy it now; it is not saved in this repo): ${password}`);
  console.log(`${files.length} photos · ${(Number(totalBytes + previewBytes) / 1024 ** 3).toFixed(2)} GiB including previews`);
  printRefreshTokenNotice(tokens);
}

async function pickDriveFilesInBatches(existingFiles = []) {
  const files = [];
  const selectedIds = new Set(existingFiles.map(file => file.id));
  let pickerDrive;
  let tokens;
  let newlyIssuedRefreshToken;
  let batchNumber = 1;
  let totalBytes = existingFiles.reduce((sum, file) => sum + BigInt(file.size || 0), 0n);

  do {
    const result = await pickDriveFiles(batchNumber);
    pickerDrive = result.pickerDrive;
    tokens = result.tokens;
    if (result.tokens.refresh_token && result.tokens.refresh_token !== refreshToken) newlyIssuedRefreshToken = result.tokens.refresh_token;
    const batchFiles = result.files.filter(file => !selectedIds.has(file.id));
    for (const file of batchFiles) selectedIds.add(file.id);
    const batchBytes = batchFiles.reduce((sum, file) => sum + BigInt(file.size || 0), 0n);
    totalBytes += batchBytes;
    if (totalBytes > BigInt(MAX_BYTES)) {
      throw new Error(`This gallery would exceed the 10 GiB limit (${(Number(totalBytes) / 1024 ** 3).toFixed(2)} GiB). No manifest changes were saved.`);
    }
    files.push(...batchFiles);
    console.log(`Batch ${batchNumber}: added ${batchFiles.length} new photo(s); ${files.length} photo(s) selected in this edit · ${(Number(totalBytes) / 1024 ** 3).toFixed(2)} GiB total.`);
    batchNumber++;
  } while (await askYesNo("Select another batch of photos? (y/N): "));

  if (newlyIssuedRefreshToken) tokens = { ...tokens, refresh_token: newlyIssuedRefreshToken };
  return { files, pickerDrive, tokens };
}

async function pickDriveFiles(batchNumber = 1) {
  const redirectUri = "http://localhost:53682/oauth2callback";
  const pickerAuth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const authUrl = pickerAuth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/drive.file"],
    trigger_onepick: "true",
    allow_multiple: "true",
    mimetypes: "image/jpeg,image/png,image/webp,image/avif,image/gif"
  });
  const result = await waitForDrivePicker(redirectUri, authUrl, batchNumber);
  const tokens = (await pickerAuth.getToken(result.code)).tokens;
  pickerAuth.setCredentials(tokens);
  const pickerDrive = google.drive({ version: "v3", auth: pickerAuth });
  const files = [];
  for (const fileId of [...new Set(result.pickedFileIds)]) {
    const { data: file } = await pickerDrive.files.get({
      fileId,
      supportsAllDrives: true,
      fields: "id,name,mimeType,size,trashed,driveId,imageMediaMetadata(width,height)"
    });
    if (file.trashed || !["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"].includes(file.mimeType)) {
      throw new Error(`“${file.name}” is not an active supported photo. Pick JPG, PNG, WebP, AVIF, or GIF images only.`);
    }
    files.push(file);
  }
  return { files, pickerDrive, tokens };
}

async function askYesNo(question) {
  const rl = createInterface({ input: stdin, output: stdout });
  try { return /^y(es)?$/i.test((await rl.question(question)).trim()); }
  finally { rl.close(); }
}

function manifestEntry(file) {
  return {
    id: file.id,
    name: file.galleryName || file.name,
    mimeType: file.mimeType,
    size: file.size || "0",
    width: file.imageMediaMetadata?.width || null,
    height: file.imageMediaMetadata?.height || null,
    ...(file.previewId ? { previewId: file.previewId, previewMimeType: "image/webp", previewSize: file.previewSize || "0" } : {})
  };
}

async function createPreviewFile(driveClient, sourceFileId, galleryFolderId) {
  const { data: source } = await driveClient.files.get(
    { fileId: sourceFileId, alt: "media", supportsAllDrives: true },
    { responseType: "stream" }
  );
  const previewStream = sharp()
    .rotate()
    .resize({ width: 1800, height: 1800, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 84, effort: 4 });
  source.once("error", error => previewStream.destroy(error));
  source.pipe(previewStream);
  try {
    const uploaded = await driveClient.files.create({
      requestBody: { name: `preview-${sourceFileId}.webp`, mimeType: "image/webp", parents: [galleryFolderId] },
      media: { mimeType: "image/webp", body: previewStream },
      uploadType: "resumable",
      fields: "id,size"
    });
    return { id: uploaded.data.id, size: uploaded.data.size || "0" };
  } catch (error) {
    source.destroy(error);
    previewStream.destroy(error);
    throw error;
  }
}

function assignUniqueGalleryNames(files, existingNames = []) {
  const usedNames = new Set(existingNames.map(name => name.toLocaleLowerCase()));
  for (const file of files) {
    const dot = file.name.lastIndexOf(".");
    const stem = dot > 0 ? file.name.slice(0, dot) : file.name;
    const extension = dot > 0 ? file.name.slice(dot) : "";
    let candidate = file.name;
    let duplicate = 2;
    while (usedNames.has(candidate.toLocaleLowerCase())) candidate = `${stem} (${duplicate++})${extension}`;
    usedNames.add(candidate.toLocaleLowerCase());
    file.galleryName = candidate;
  }
}

async function editGallery(jobSlug) {
  const gallery = await findGallery(jobSlug);
  if (!gallery) throw new Error(`Gallery ${jobSlug} was not found in the connected Google Drive.`);
  const props = gallery.appProperties || {};
  const manifestId = props.clientGalleryManifestId;
  if (!manifestId || props.clientGallerySource !== "picked-files") {
    throw new Error("Editing is currently available for galleries created with the Drive Picker import command.");
  }
  let manifest = await readDriveManifest(manifestId);
  if (!manifest.length) throw new Error("This gallery's photo list is empty or invalid.");
  console.log(`\nPhotos in ${props.clientGalleryTitle || gallery.name}:`);
  manifest.forEach((file, index) => console.log(`  ${index + 1}. ${file.name}`));

  const rl = createInterface({ input: stdin, output: stdout });
  let removeAnswer;
  let addAnswer;
  try {
    removeAnswer = await rl.question("Remove photo numbers (for example 2,4-6), or press Enter to keep all: ");
    addAnswer = await rl.question("Add photos from Google Drive Picker? (y/N): ");
  } finally { rl.close(); }

  const removeIndexes = parsePhotoIndexes(removeAnswer, manifest.length);
  let updated = manifest.filter((_, index) => !removeIndexes.has(index));
  const removedEntries = manifest.filter((_, index) => removeIndexes.has(index));
  let pickedFiles = [];
  let pickerDrive = null;
  let tokens = null;
  const createdPreviewIds = [];
  if (/^y(es)?$/i.test(addAnswer.trim())) {
    ({ files: pickedFiles, pickerDrive, tokens } = await pickDriveFilesInBatches(updated));
    assignUniqueGalleryNames(pickedFiles, updated.map(file => file.name));
    try {
      for (const file of pickedFiles) {
        const preview = await createPreviewFile(pickerDrive, file.id, gallery.id);
        file.previewId = preview.id;
        file.previewSize = preview.size;
        createdPreviewIds.push(preview.id);
        console.log(`Prepared gallery preview: ${file.galleryName}`);
      }
    } catch (error) {
      for (const previewId of createdPreviewIds) await pickerDrive.files.delete({ fileId: previewId }).catch(() => {});
      throw error;
    }
    updated = [...updated, ...pickedFiles.map(manifestEntry)];
  }
  if (removeIndexes.size === 0 && pickedFiles.length === 0) throw new Error("No gallery changes were selected.");
  if (!updated.length) throw new Error("A gallery must contain at least one photo; nothing was changed.");
  const totalBytes = updated.reduce((sum, file) => sum + BigInt(file.size || 0) + BigInt(file.previewSize || 0), 0n);
  if (totalBytes > BigInt(MAX_BYTES)) {
    for (const previewId of createdPreviewIds) await (pickerDrive || drive).files.delete({ fileId: previewId }).catch(() => {});
    throw new Error(`This gallery would be ${(Number(totalBytes) / 1024 ** 3).toFixed(2)} GiB including previews. The configured per-job limit is 10 GiB; nothing was changed.`);
  }

  try {
    await writeDriveManifest(manifestId, updated, pickerDrive || drive);
  } catch (error) {
    for (const previewId of createdPreviewIds) await (pickerDrive || drive).files.delete({ fileId: previewId }).catch(() => {});
    throw error;
  }
  for (const file of removedEntries) {
    if (file.previewId) await (pickerDrive || drive).files.delete({ fileId: file.previewId }).catch(() => {});
  }
  console.log(`\nUpdated ${jobSlug}: removed ${removeIndexes.size}, added ${pickedFiles.length}, now ${updated.length} photos · ${(Number(totalBytes) / 1024 ** 3).toFixed(2)} GiB.`);
  if (removeIndexes.size) console.log("Removed photos are unlinked from the gallery; the original files remain in Google Drive.");
  printGalleryLink(jobSlug);
  if (tokens) printRefreshTokenNotice(tokens);
}

async function refreshGalleryPreviews(jobSlug) {
  const gallery = await findGallery(jobSlug);
  if (!gallery) throw new Error(`Gallery ${jobSlug} was not found in the connected Google Drive.`);
  const props = gallery.appProperties || {};
  const manifestId = props.clientGalleryManifestId;
  if (!manifestId || props.clientGallerySource !== "picked-files") {
    throw new Error("Preview refresh is available for galleries created with the Drive Picker import command.");
  }
  const manifest = await readDriveManifest(manifestId);
  const missing = manifest.filter(file => !file.previewId);
  if (!missing.length) {
    console.log(`All ${manifest.length} photos in ${jobSlug} already have high-quality previews.`);
    return;
  }
  const createdPreviewIds = [];
  try {
    for (let index = 0; index < missing.length; index++) {
      const file = missing[index];
      const preview = await createPreviewFile(drive, file.id, gallery.id);
      file.previewId = preview.id;
      file.previewMimeType = "image/webp";
      file.previewSize = preview.size;
      createdPreviewIds.push(preview.id);
      console.log(`Prepared gallery preview ${index + 1}/${missing.length}: ${file.name}`);
    }
    const totalBytes = manifest.reduce((sum, file) => sum + BigInt(file.size || 0) + BigInt(file.previewSize || 0), 0n);
    if (totalBytes > BigInt(MAX_BYTES)) throw new Error(`Originals plus previews exceed the 10 GiB gallery limit; no manifest changes were saved.`);
    await writeDriveManifest(manifestId, manifest, drive);
  } catch (error) {
    for (const previewId of createdPreviewIds) await drive.files.delete({ fileId: previewId }).catch(() => {});
    throw error;
  }
  console.log(`\nCreated ${missing.length} sharper previews for ${jobSlug}. The original photos are unchanged.`);
  printGalleryLink(jobSlug);
}

function parsePhotoIndexes(value, count) {
  const selected = new Set();
  const input = value.trim();
  if (!input) return selected;
  for (const part of input.split(",").map(item => item.trim())) {
    const match = part.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) throw new Error(`Invalid photo selection “${part}”. Use numbers such as 2,4-6.`);
    const start = Number(match[1]);
    const end = Number(match[2] || match[1]);
    if (start < 1 || end < start || end > count) throw new Error(`Photo selection “${part}” is outside the listed range 1-${count}.`);
    for (let index = start - 1; index < end; index++) selected.add(index);
  }
  return selected;
}

async function readDriveManifest(manifestId) {
  const { token } = await auth.getAccessToken();
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(manifestId)}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error(`Could not read the gallery photo list (${response.status}).`);
  const manifest = await response.json();
  if (!Array.isArray(manifest)) throw new Error("This gallery's photo list is invalid.");
  return manifest.filter(file => typeof file.id === "string" && typeof file.name === "string");
}

async function writeDriveManifest(manifestId, manifest, driveClient) {
  await driveClient.files.update({
    fileId: manifestId,
    media: { mimeType: "application/json", body: JSON.stringify(manifest) },
    fields: "id"
  });
}

function printGalleryLink(jobSlug) {
  console.log(`\nClient gallery: https://www.carrels.photography/client-gallery/?slug=${jobSlug}`);
}

function printRefreshTokenNotice(tokens) {
  if (tokens.refresh_token && tokens.refresh_token !== refreshToken) {
    console.log("Google issued a new refresh token. Update GOOGLE_REFRESH_TOKEN in your private .env and Render environment settings if deployed.");
    console.log(tokens.refresh_token);
  }
}

function waitForDrivePicker(redirectUri, authUrl, batchNumber = 1, selectionLabel = "photos") {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: stdin, output: stdout });
    const server = createServer((request, response) => {
      const url = new URL(request.url, redirectUri);
      if (url.pathname !== "/oauth2callback") {
        response.writeHead(404).end("Not found");
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const pickedFileIds = (url.searchParams.get("picked_file_ids") || "").split(",").filter(Boolean);
      if (error || !code || pickedFileIds.length < 1) {
        response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end("<p>No files were selected. Return to your terminal and select the requested file.</p>");
        server.close();
        rl.close();
        reject(new Error(error ? `Google Drive authorization failed: ${error}` : "No files were selected. Open Drive Picker and confirm your selection."));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("<p>Drive folder selected. Return to your terminal.</p>");
      server.close();
      rl.close();
      resolve({ code, pickedFileIds });
    });
    server.once("error", error => { rl.close(); reject(error); });
    server.listen(53682, "127.0.0.1", () => {
      console.log(`Google Drive Picker batch ${batchNumber} will open. Select ${selectionLabel}.`);
      if (selectionLabel === "photos") {
        console.log("Open the client folder; supported image files are filtered and multi-select is enabled.");
        if (batchNumber > 1) console.log("Select the next set of photos; files included in earlier batches are automatically skipped.");
        console.log("On Mac, try Command+A to select all visible photos at once, then confirm the selection.");
      }
      console.log(`\n${authUrl}\n`);
      console.log("If it does not open automatically, copy the URL above into your browser. Waiting for selection…");
    });
    rl.on("SIGINT", () => { server.close(); process.exit(130); });
  });
}

async function promptGalleryDetails(jobSlug, folderName) {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const titleInput = await rl.question(`Gallery title [${folderName}]: `);
    const title = titleInput.trim() || folderName;
    let password = await rl.question("Gallery password (press Enter to generate a strong one): ");
    if (new TextEncoder().encode(title).length > 90) throw new Error("Keep the gallery title to 90 UTF-8 bytes or fewer.");
    if (!password) password = randomBytes(18).toString("base64url");
    if (password.length < 12 || password.length > 256) throw new Error("Use a gallery password between 12 and 256 characters.");
    const salt = randomBytes(16);
    const passwordHash = pbkdf2Sync(password, salt, 310000, 32, "sha256").toString("hex");
    return { title, password, salt, passwordHash };
  } finally { rl.close(); }
}

async function uploadGallery(jobSlug, sourceDirectory) {
  if (!sourceDirectory) throw new Error("Provide a folder containing the finished gallery images.");
  const absoluteDir = path.resolve(sourceDirectory);
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const imageEntries = entries.filter(entry => entry.isFile() && SUPPORTED.has(path.extname(entry.name).toLowerCase()));
  if (!imageEntries.length) throw new Error("No JPG, PNG, WebP, AVIF, or GIF images found directly in that folder.");
  if (imageEntries.length !== entries.length) {
    const ignored = entries.filter(entry => !entry.isFile() || !SUPPORTED.has(path.extname(entry.name).toLowerCase())).map(entry => entry.name);
    console.log(`Skipping ${ignored.length} non-image or nested item(s).`);
  }
  let totalBytes = 0;
  const files = [];
  for (const entry of imageEntries) {
    if (!/^[^/\\]+$/.test(entry.name) || entry.name === "." || entry.name === "..") throw new Error(`Unsafe filename: ${entry.name}`);
    const filePath = path.join(absoluteDir, entry.name);
    const info = await stat(filePath);
    totalBytes += info.size;
    files.push({ name: entry.name, filePath, size: info.size, type: MIME[path.extname(entry.name).toLowerCase()] });
  }
  if (totalBytes > MAX_BYTES) throw new Error(`This gallery is ${(totalBytes / 1024 ** 3).toFixed(2)} GiB. The configured per-job limit is 10 GiB.`);

  const existing = await findGallery(jobSlug);
  if (existing) throw new Error(`Gallery ${jobSlug} already exists. Delete it first if you intend to replace it.`);

  const rl = createInterface({ input: stdin, output: stdout });
  const titleInput = await rl.question(`Gallery title [${jobSlug.replaceAll("-", " ")}]: `);
  const title = titleInput.trim() || jobSlug.replaceAll("-", " ");
  let password = await rl.question("Gallery password (press Enter to generate a strong one): ");
  rl.close();
  if (new TextEncoder().encode(title).length > 90) throw new Error("Keep the gallery title to 90 UTF-8 bytes or fewer.");
  if (!password) password = randomBytes(18).toString("base64url");
  if (password.length < 12 || password.length > 256) throw new Error("Use a gallery password between 12 and 256 characters.");

  const salt = randomBytes(16);
  const passwordHash = pbkdf2Sync(password, salt, 310000, 32, "sha256").toString("hex");
  const created = await drive.files.create({
    requestBody: { name: title, mimeType: "application/vnd.google-apps.folder" },
    fields: "id,name"
  });
  const folderId = created.data.id;
  const uploaded = [];
  const previewIds = [];
  let manifestId;
  let previewBytes = 0;
  try {
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      const result = await drive.files.create({
        requestBody: { name: file.name, parents: [folderId] },
        media: { mimeType: file.type, body: createReadStream(file.filePath) },
        uploadType: "resumable",
        fields: "id,name,size"
      });
      file.id = result.data.id;
      uploaded.push(file.id);
      const preview = await createPreviewFile(drive, file.id, folderId);
      file.previewId = preview.id;
      file.previewSize = preview.size;
      previewIds.push(preview.id);
      previewBytes += Number(preview.size || 0);
      if (totalBytes + previewBytes > MAX_BYTES) {
        throw new Error("Originals plus previews exceed the 10 GiB gallery limit. No gallery was created.");
      }
      console.log(`Uploaded ${index + 1}/${files.length}: ${file.name}`);
    }
    const manifest = files.map(file => ({
      id: file.id,
      name: file.name,
      mimeType: file.type,
      size: String(file.size),
      width: null,
      height: null,
      previewId: file.previewId,
      previewMimeType: "image/webp",
      previewSize: file.previewSize || "0"
    }));
    const manifestFile = await drive.files.create({
      requestBody: { name: "gallery-manifest.json", mimeType: "application/json", parents: [folderId] },
      media: { mimeType: "application/json", body: JSON.stringify(manifest) },
      fields: "id"
    });
    manifestId = manifestFile.data.id;
    await drive.files.update({
      fileId: folderId,
      requestBody: { appProperties: {
        clientGallerySlug: jobSlug,
        clientGalleryTitle: title,
        clientGalleryPasswordSalt: salt.toString("hex"),
        clientGalleryPasswordHash: passwordHash,
        clientGallerySource: "uploaded",
        clientGalleryManifestId: manifestId
      } },
      fields: "id,appProperties"
    });
  } catch (error) {
    if (manifestId) await drive.files.delete({ fileId: manifestId }).catch(() => {});
    for (const fileId of previewIds) await drive.files.delete({ fileId }).catch(() => {});
    for (const fileId of uploaded) await drive.files.delete({ fileId }).catch(() => {});
    await drive.files.delete({ fileId: folderId }).catch(() => {});
    throw error;
  }
  console.log(`\nClient gallery: https://www.carrels.photography/client-gallery/?slug=${jobSlug}`);
  console.log(`Password (copy it now; it is not saved in this repo): ${password}`);
  console.log(`${files.length} photos · ${((totalBytes + previewBytes) / 1024 ** 3).toFixed(2)} GiB including previews`);
}

async function findGallery(jobSlug) {
  const q = `mimeType = 'application/vnd.google-apps.folder' and trashed = false and appProperties has { key='clientGallerySlug' and value='${jobSlug}' }`;
  const result = await drive.files.list({ q, pageSize: 1, fields: "files(id,name,appProperties)" });
  return result.data.files?.[0] || null;
}

async function deleteGallery(jobSlug) {
  const folder = await findGallery(jobSlug);
  if (!folder) throw new Error(`Gallery ${jobSlug} was not found in the connected Google Drive.`);
  const rl = createInterface({ input: stdin, output: stdout });
  let confirmation;
  if (folder.appProperties?.clientGallerySource === "existing") {
    confirmation = await rl.question(`Unpublish gallery ${jobSlug} and keep the original Drive folder and photos? Type ${jobSlug}: `);
  } else {
    confirmation = await rl.question(`Permanently delete the Drive folder “${folder.name}” and its contents? Type ${jobSlug}: `);
  }
  rl.close();
  if (confirmation !== jobSlug) throw new Error("The gallery slug did not match; nothing was deleted.");
  if (folder.appProperties?.clientGallerySource === "existing") {
    const appProperties = { ...folder.appProperties };
    for (const key of ["clientGallerySlug", "clientGalleryTitle", "clientGalleryPasswordSalt", "clientGalleryPasswordHash", "clientGallerySource"]) delete appProperties[key];
    await drive.files.update({ fileId: folder.id, requestBody: { appProperties }, fields: "id" });
    console.log(`Gallery ${jobSlug} is unpublished. The original folder and photos remain in Google Drive.`);
    return;
  }
  let pageToken;
  let deleted = 0;
  do {
    const page = await drive.files.list({
      q: `'${folder.id}' in parents and trashed = false`,
      pageSize: 1000,
      pageToken,
      fields: "nextPageToken,files(id,name)"
    });
    const children = page.data.files || [];
    for (let offset = 0; offset < children.length; offset += 5) {
      const batch = children.slice(offset, offset + 5);
      await Promise.all(batch.map(file => drive.files.delete({ fileId: file.id })));
      deleted += batch.length;
      if (deleted % 100 === 0 || deleted === children.length) console.log(`Deleted ${deleted} file(s)…`);
    }
    pageToken = page.data.nextPageToken;
  } while (pageToken);
  await drive.files.delete({ fileId: folder.id });
  console.log(`Gallery ${jobSlug} permanently deleted from Google Drive (${deleted} photos).`);
}
