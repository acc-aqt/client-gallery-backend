# Carrels client galleries

This is the separate Node.js backend for the static client gallery pages in the `carrels-photography.github.io` repository. Client galleries use the same warm colors, navigation, masonry layout, and lightbox as the main portfolio. Clients can download one photograph or the complete gallery as a ZIP.

The original photos stay private in Google Drive. This service checks gallery passwords, refreshes your Google OAuth access token, and streams authorized images and ZIP downloads to the static site. Galleries store compressed WebP previews in the app-managed Drive folder so the grid stays sharp without loading full-resolution originals. For Picker-linked galleries, originals are never copied. The 10 GiB gallery limit includes previews.

## How the two repos fit together

- The GitHub Pages site hosts `/clients/` and `/client-gallery/?slug=...`.
- This repo provides the JSON API and streams the photos from Drive.
- `js/client-gallery-config.js` in the website repo points to the backend service URL. Update it if Render assigns a different URL.
- The API accepts browser requests only from the configured website origins (`FRONTEND_ORIGINS`).

## Google Drive setup

Use the existing Google Cloud OAuth app and refresh token configured for the gallery importer. The OAuth client should be a **Web application** with `http://localhost:53682/oauth2callback` as an authorized redirect URI. Enable the Google Drive API and Google Picker API. The app uses the narrow `drive.file` scope and does not browse your whole Drive.

Create a private local `.env` from `.env.example` and fill in:

```dotenv
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
SESSION_SECRET=use-a-long-random-secret
FRONTEND_ORIGINS=https://www.carrels.photography,https://carrels.photography,http://localhost:8000,http://127.0.0.1:8000
```

Keep `.env` private; Git ignores it. `SESSION_SECRET` should contain at least 32 random bytes. You can create a value with `openssl rand -hex 32`.

Install Node.js 20 or newer and dependencies:

```sh
npm ci
```

If you still need a refresh token, run `npm run google-auth`, approve Drive access, and save the printed refresh token in `.env`.

## Run both repos locally

Start the API in one terminal:

```sh
npm run dev
```

It listens on `http://localhost:10000`. In the website repo, set `window.CLIENT_GALLERY_API` in `js/client-gallery-config.js` to `http://localhost:10000` while developing. Serve the static site from its repo root in another terminal:

```sh
python3 -m http.server 8000
```

Open `http://localhost:8000/clients/`. Add both local origins shown above to `FRONTEND_ORIGINS` (they are included in the example). Restore the Render URL in the website config before committing the website changes for publication.

## Create and remove galleries

To link existing photos from Drive:

```sh
npm run gallery -- import wedding-2026
```

The command opens Google Picker filtered to supported image types, with multi-select enabled. Open the job folder and, on Mac, try **Command+A** to select all visible images in that batch, then confirm. If the Picker limits a selection to 100 files, the importer asks whether to choose another batch; repeat until all photos are included, then answer `N`. It combines the batches, skips files already selected, and applies the 10 GiB limit to the originals and previews together. Each batch opens another Picker authorization flow. Enter a title and password after the final batch, or press Enter to generate a strong password. The script records selected file IDs in a private Drive manifest, creates small compressed previews in an app-managed Drive folder, and leaves the source photos untouched.

Selecting a folder itself does not automatically grant the app access to all its child photos under the current narrow `drive.file` scope; this matches the empty-folder result seen in testing. Automatically enumerating folder contents would need a broader scope such as `drive.readonly`. Google classifies that scope as restricted and requires verification, including an annual security assessment for restricted-scope apps, so the importer keeps the narrower Picker based flow. See [Google Drive scope definitions](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) and [restricted-scope requirements](https://support.google.com/cloud/answer/13464321).

The command prints the website link and password. Send the link and password to the client through your usual private channel. The gallery also has a password form at `/clients/`.

To change a Picker-linked gallery later, run:

```sh
npm run gallery -- edit wedding-2026
```

The command lists the current photos by number. Enter numbers or ranges to remove (for example `2,4-6`), then choose whether to add more photos through Picker. You can add multiple batches if the Picker limits each selection. New photos get compressed previews; removing a photo deletes only its generated preview and unlinks the original from the gallery. The original Drive photo stays untouched. The gallery title and password remain the same. This edit command currently works with galleries made by the `import` command.

For an existing Picker-linked gallery created before previews were added, generate them once with:

```sh
npm run gallery -- refresh-previews wedding-2026
```

This adds compressed WebP previews in the app-managed Drive folder and updates the gallery manifest. It does not change the original photos.

The **Download all (low-res)** button bundles the gallery's selected Drive photos into a ZIP. To provide a high-resolution download without building a large archive on the backend, upload one `.tar.gz` archive to Drive and attach it to the gallery:

```sh
npm run gallery -- attach-highres wedding-2026
```

Google Drive Picker opens without a file-type filter; select exactly one `.tar.gz` file. The gallery then streams that archive to clients through the password-protected backend. Replacing the attached archive only changes the gallery link; it leaves the previous archive in Drive. Delete it there when it is no longer needed.

To upload a local folder of final images into Drive instead:

```sh
npm run gallery -- upload wedding-2026 /path/to/final-images
```

Supported formats are JPG, PNG, WebP, AVIF, and GIF. The importer only reads files directly inside the chosen folder; nested items are skipped. It saves the uploaded photos and their compressed previews in a Drive manifest-backed gallery, with both counted toward the 10 GiB limit.

After the client has finished downloading, remove the gallery record:

```sh
npm run gallery -- delete wedding-2026
```

For linked Drive photos, this removes only the gallery's manifest and app-managed folder; the original photos remain where they are. For local uploads, it permanently deletes the uploaded Drive copies.

## Deploy this repo to Render

1. Push this repository to its own GitHub repo.
2. In Render, create a Blueprint from that repo. `render.yaml` defines a Node web service, `/health` check, and the required environment variables. Render prompts for the Google credentials when creating the service.
3. Copy the deployed service URL (the default service name is `carrels-client-galleries`) and set it as `window.CLIENT_GALLERY_API` in the static website repo's `js/client-gallery-config.js`.
4. Confirm `FRONTEND_ORIGINS` includes both `https://www.carrels.photography` and `https://carrels.photography`, then deploy the website repo to GitHub Pages.

The Blueprint starts on Render's Free plan, which is suitable for trying the flow. Free web services sleep after 15 minutes without requests and can take about a minute to wake. Render notes that Free services are not intended for production; outbound bandwidth also counts toward workspace usage. Review current [Render free-service limits](https://render.com/docs/free) before sharing a production gallery. Paid Render services avoid the free-plan sleep behavior but are billed while provisioned.

## Security and limits

- Google OAuth credentials are server environment variables and never go to the browser.
- Password verifiers use salted PBKDF2-SHA-256. The plaintext password is not stored.
- A signed 12-hour session authorizes listing and image streaming. The browser keeps the token in tab-scoped session storage; tokenized media requests use no-store and no-referrer headers.
- The site pages are marked `noindex,nofollow`.
- Download All streams a Zip64 archive from Drive through the backend. The server does not store the archive. Clients need an archive utility that supports Zip64 for ZIP files above 4 GiB.
- There is no admin dashboard. Use the local CLI to create and remove galleries. Removing the gallery metadata disables access immediately.
