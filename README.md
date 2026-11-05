# Carrels client galleries

A private photo gallery service for client jobs, separate from the public portfolio. The gallery page uses a dark, minimal photo grid with a lightbox, individual downloads, and a **Download all images** ZIP. Each gallery has its own password. Photos stay in a private Cloudflare R2 bucket; this repository contains only the application and upload tooling.

## Storage and cost fit

Use **Cloudflare R2 Standard** for the photos and a **Cloudflare Worker** for authentication and delivery. Render's persistent disks require a paid service and keep their monthly cost while the disk is attached. Render's free service has ephemeral storage and is not recommended for production; it also spins down and can charge for outbound bandwidth. R2 keeps the images independent from app deploys and charges by storage and requests. The published R2 free tier includes 10 GB-month of Standard storage, 1 million Class A operations, 10 million Class B operations, and free internet egress. Above the free storage allowance, Standard storage is $0.015/GB-month; delete a finished job to stop accruing storage. A 10 GiB job may be slightly above the 10 GB free allowance depending on how the provider measures the stored bytes.

Cloudflare Workers Free includes 100,000 requests/day but limits CPU to 10 ms/invocation. Password verification uses PBKDF2 (310,000 iterations), which may exceed that CPU budget, so use the Workers Paid plan for reliable authentication. Workers Paid currently has a $5/month minimum with included request and CPU allowances. If you enable it for a job, downgrade the Workers subscription to Free before the next renewal once the gallery is gone. Downgrades take effect at the end of the current billing period; the $5 is not prorated. Confirm current pricing and billing dates before enabling it.

Current provider references: [R2 pricing](https://developers.cloudflare.com/r2/pricing/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Render free service limits](https://render.com/docs/free), [Render persistent disks](https://render.com/docs/disks).

## URL and the existing portfolio

The site is deployed on a separate hostname, for example `https://clients.carrels.photography/wedding-2026`. This keeps the public portfolio on GitHub Pages untouched. The root-domain URL pattern `carrels.photography/client-job-xy` cannot be routed to a different server while the existing root domain goes directly to GitHub Pages; that requires moving the root-domain DNS/proxy/site routing to Cloudflare. A dedicated `clients` subdomain is the low-change option. To attach it as a Worker custom domain, the domain's DNS zone must be managed in Cloudflare. Until then, the Worker can be previewed on its `workers.dev` hostname.

## 1. Create the private bucket

1. Create a Cloudflare account and enable R2 billing. Create a **private** Standard bucket named `carrels-client-galleries`.
2. Do not enable public `r2.dev` access or a public bucket custom domain.
3. Create an R2 API token scoped to this bucket. The upload/delete script needs object read, write, and delete permissions. Keep the credentials out of Git.
4. Copy `.env.example` to `.env` and fill in the R2 account ID, API key, and secret. `.env` is ignored by Git.

The Worker uses an R2 binding and does not need the S3 credentials. The bucket must remain private; the Worker checks the gallery password before returning any image or ZIP.

## 2. Deploy the Worker

Install Node.js 20 or newer and run:

```sh
npm install
npx wrangler login
npx wrangler secret put SESSION_SECRET
```

For `SESSION_SECRET`, provide at least 32 random bytes, for example the output of `openssl rand -hex 32`. Then:

```sh
npm run deploy
```

Wrangler creates/updates the Worker and binds the existing R2 bucket. In the Cloudflare dashboard, add `clients.carrels.photography` as a custom domain for this Worker. Add the corresponding DNS zone to Cloudflare if needed; do not change the existing root domain record as part of this setup.

For local preview, copy `.dev.vars.example` to `.dev.vars`, set a random `SESSION_SECRET`, then run `npm run dev`. Local preview still needs an R2 bucket binding; use a separate test bucket by changing `bucket_name` in `wrangler.jsonc` before testing.

## 3. Upload a client job

In the bucket's R2 API settings, create credentials and fill in `.env`. Then run:

```sh
npm run gallery -- upload wedding-2026 /path/to/final-web-sized-images
```

The tool accepts JPG, PNG, WebP, and AVIF files directly inside the folder, skips nested folders and other files, and refuses galleries above 10 GiB. It asks for a display title and a password; press Enter at the password prompt to generate a strong random password. The script uploads photos first and publishes the password verifier last, so a partly uploaded gallery is not exposed. Give the client the printed URL and password using your normal private channel. With no other R2 usage, a 10 GiB job is about 0.74 GB above the 10 GB-month free allowance, or roughly $0.01 for a full month; a shorter job is prorated by stored days.

Use web-sized/preview-resolution JPEGs appropriate for client selection and delivery. Avoid uploading camera originals unless you intend clients to download those full-size files.

## 4. Remove the gallery

After the client has downloaded everything, run:

```sh
npm run gallery -- delete wedding-2026
```

The script requires typing the exact slug, then deletes every object under that job prefix. R2 object deletion is free. The app code and empty bucket can remain; storage charges stop once the objects are deleted. Keep your normal offline/archive backup before deletion if you may need to restore the job later. Downgrade the Workers subscription to Free before its next billing date if you do not need the paid plan for another gallery; the subscription downgrade takes effect at the billing-period boundary.

## Security and behavior

- The R2 bucket is private; images and ZIP data are fetched only after a valid password session.
- Password verifiers use per-gallery salts and PBKDF2-SHA-256; passwords never appear in the repo or in the gallery manifest as plaintext.
- A signed, HttpOnly, Secure, SameSite=Strict cookie grants access to only the matching gallery for 12 hours. The gallery API, each photo, and the ZIP endpoint all check the session.
- Responses use `no-store`, and client galleries are marked `noindex,nofollow`.
- The ZIP is generated as a stream on demand, so the Worker does not need to store a second archive or buffer the whole job in memory.
- This starter does not provide an owner dashboard. Use the local CLI to create/delete jobs. Rotating `SESSION_SECRET` logs out all existing sessions.
- Password sharing cannot prevent a client from copying or redistributing downloaded images. Send a long, unique password to each job and delete the job when delivery is complete.
