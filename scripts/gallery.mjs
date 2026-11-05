import "dotenv/config";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const PREFIX = "galleries/";
const MAX_BYTES = 10 * 1024 ** 3;
const SUPPORTED = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif"]);
const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".avif": "image/avif" };
const args = process.argv.slice(2);
const [command, slug, directory] = args;

function help() {
  console.log(`Usage:\n  npm run gallery -- upload <job-slug> <folder-with-images>\n  npm run gallery -- delete <job-slug>\n\nJob slugs use lowercase letters, numbers, and hyphens, for example: wedding-2026.`);
}
if (!command || command === "--help" || command === "help") { help(); process.exit(0); }
if (!["upload", "delete"].includes(command) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug || "")) {
  help(); process.exit(2);
}

const bucket = process.env.R2_BUCKET_NAME || "carrels-client-galleries";
const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
if (!accountId || !accessKeyId || !secretAccessKey) {
  console.error("Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY in a local .env file first.");
  process.exit(2);
}
const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId, secretAccessKey },
  forcePathStyle: true,
});

if (command === "upload") await uploadGallery(slug, directory);
else await deleteGallery(slug);

async function uploadGallery(jobSlug, sourceDirectory) {
  if (!sourceDirectory) throw new Error("Provide a folder containing the finished gallery images.");
  const absoluteDir = path.resolve(sourceDirectory);
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const imageEntries = entries.filter(entry => entry.isFile() && SUPPORTED.has(path.extname(entry.name).toLowerCase()));
  if (!imageEntries.length) throw new Error("No JPG, PNG, WebP, or AVIF images found directly in that folder.");
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

  const existing = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${PREFIX}${jobSlug}/`, MaxKeys: 1 }));
  if (existing.Contents?.length) throw new Error(`Gallery ${jobSlug} already exists. Delete it first if you intend to replace it.`);

  const rl = createInterface({ input: stdin, output: stdout });
  const titleInput = await rl.question(`Gallery title [${jobSlug.replaceAll("-", " ")}]: `);
  const title = titleInput.trim() || jobSlug.replaceAll("-", " ");
  let password = await rl.question("Gallery password (press Enter to generate a strong one): ");
  rl.close();
  if (!password) password = randomBytes(18).toString("base64url");
  if (password.length < 12 || password.length > 256) throw new Error("Use a gallery password between 12 and 256 characters.");

  const salt = randomBytes(16);
  const passwordHash = pbkdf2Sync(password, salt, 310000, 32, "sha256");
  const uploaded = [];
  try {
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      const key = `${PREFIX}${jobSlug}/images/${file.name}`;
      const body = await import("node:fs").then(({ createReadStream }) => createReadStream(file.filePath));
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentLength: file.size, ContentType: file.type, CacheControl: "private, no-store" }));
      uploaded.push({ Key: key });
      console.log(`Uploaded ${index + 1}/${files.length}: ${file.name}`);
    }
    const manifest = {
      version: 1,
      title,
      passwordSalt: salt.toString("hex"),
      passwordHash: passwordHash.toString("hex"),
      createdAt: new Date().toISOString(),
    };
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: manifestKey, Body: JSON.stringify(manifest), ContentType: "application/json", CacheControl: "private, no-store" }));
  } catch (error) {
    if (uploaded.length) await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: uploaded, Quiet: true } }));
    throw error;
  }
  console.log(`\nGallery ready: https://clients.carrels.photography/${jobSlug}`);
  console.log(`Password (copy it now; it is not saved in this repo): ${password}`);
  console.log(`${files.length} photos · ${(totalBytes / 1024 ** 3).toFixed(2)} GiB`);
}

async function deleteGallery(jobSlug) {
  const rl = createInterface({ input: stdin, output: stdout });
  const confirmation = await rl.question(`Type ${jobSlug} to permanently delete that gallery and its photos: `);
  rl.close();
  if (confirmation !== jobSlug) throw new Error("The gallery slug did not match; nothing was deleted.");
  let token;
  let deleted = 0;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${PREFIX}${jobSlug}/`, ContinuationToken: token }));
    const objects = (page.Contents || []).map(item => ({ Key: item.Key }));
    if (objects.length) {
      await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
      deleted += objects.length;
      console.log(`Deleted ${deleted} object(s)…`);
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  console.log(`Gallery ${jobSlug} deleted (${deleted} object(s)).`);
}
