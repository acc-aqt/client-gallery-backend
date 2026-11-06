# Carrels client galleries

This is the separate Node.js backend for the static client gallery pages in the `carrels-photography.github.io` repository. Client galleries use the same warm colors, navigation, masonry layout, and lightbox as the main portfolio. Clients can download one photograph or the complete gallery as a ZIP.

The photos stay private in Google Drive. This service checks gallery passwords, refreshes your Google OAuth access token, and streams authorized images and ZIP downloads to the static site. It does not publish Drive links or keep a second image copy on the server. Each gallery is limited to 10 GiB.

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

The command opens Google Picker. Select the photos (multi-select is enabled), then enter a title and password, or press Enter to generate a strong password. The script records selected file IDs in a private Drive manifest and does not copy or move the source photos. Google requires selecting the individual files because `drive.file` does not automatically expose every item in a selected folder.

The command prints the website link and password. Send the link and password to the client through your usual private channel. The gallery also has a password form at `/clients/`.

To upload a local folder of final images into Drive instead:

```sh
npm run gallery -- upload wedding-2026 /path/to/final-images
```

Supported formats are JPG, PNG, WebP, AVIF, and GIF. The importer only reads files directly inside the chosen folder; nested items are skipped.

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
