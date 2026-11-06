import "dotenv/config";
import { createServer } from "node:http";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { google } from "googleapis";

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first.");
  process.exit(2);
}
const redirectUri = "http://localhost:53682/oauth2callback";
const oauth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
const authUrl = oauth.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: ["https://www.googleapis.com/auth/drive.file"]
});
const server = createServer(async (request, response) => {
  const url = new URL(request.url, redirectUri);
  const code = url.searchParams.get("code");
  if (url.pathname !== "/oauth2callback" || !code) {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Authorization did not complete. You can close this tab.");
    return;
  }
  try {
    const { tokens } = await oauth.getToken(code);
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("<p>Google Drive is connected. Return to your terminal.</p>");
    server.close();
    console.log("\nGoogle OAuth connected.");
    if (tokens.refresh_token) {
      console.log("Add this refresh token to your private .env and the Render environment variable GOOGLE_REFRESH_TOKEN:");
      console.log(tokens.refresh_token);
    } else {
      console.log("Google did not issue a new refresh token. Revoke this app in your Google Account permissions and run npm run google-auth again.");
    }
    process.exit(tokens.refresh_token ? 0 : 1);
  } catch (error) {
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end("Google authorization failed. Return to your terminal for details.");
    server.close();
    console.error("Could not exchange the OAuth code for tokens.");
    console.error(error.message);
    process.exit(1);
  }
});
server.listen(53682, "127.0.0.1", () => {
  console.log("Open this URL in your browser and sign in with the Google account that owns the gallery images:\n");
  console.log(authUrl);
  console.log("\nWaiting for Google to return to localhost:53682…");
});

const rl = createInterface({ input: stdin, output: stdout });
rl.on("SIGINT", () => { server.close(); process.exit(130); });
