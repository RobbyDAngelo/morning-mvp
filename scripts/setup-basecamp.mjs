#!/usr/bin/env node
// One-shot Basecamp OAuth helper. Walks you through:
//   1. Register a Basecamp OAuth app (opens the page; one-time, 30 seconds)
//   2. Paste client_id + client_secret
//   3. Authorize in your browser
//   4. Paste the redirect URL
//   5. Exchange the code for access_token + refresh_token
//   6. Discover your account_id and user_id automatically
//   7. Write config.local.json
//
// Usage:
//   node ~/.claude/skills/morning-mvp/scripts/setup-basecamp.mjs

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openExternal } from "./lib/cli.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, "..", "config.local.json");
const REDIRECT_URI = "https://launchpad.37signals.com/authorization/done";

const rl = createInterface({ input, output });
const ask = (q) => rl.question(q);

function openUrl(url) {
  // Cross-platform, never crashes the wizard if no browser launcher exists.
  openExternal(url, {
    onError: () => process.stderr.write(`(could not auto-open; open this URL yourself: ${url})\n`),
  });
}

console.log("");
console.log("==============================================");
console.log("  Basecamp OAuth setup for morning-mvp");
console.log("==============================================");
console.log("");
console.log("Step 1 of 4: register an OAuth app");
console.log("");
console.log("Opening https://launchpad.37signals.com/integrations/new ...");
console.log("");
console.log("In the form, paste these exactly:");
console.log("  Name of your application:       morning-mvp");
console.log("  Company:                        (your own)");
console.log("  Website URL:                    (your own website, or https://example.com)");
console.log("  Products used:                  check 'Basecamp 4' (or whichever you use)");
console.log("  Redirect URI:                   " + REDIRECT_URI);
console.log("");
console.log("Click 'Register this application'. You'll see a page with Client ID + Client Secret.");
console.log("");

openUrl("https://launchpad.37signals.com/integrations/new");

await ask("Press Enter once you have the Client ID and Client Secret in front of you... ");

const clientId = (await ask("Client ID:     ")).trim();
const clientSecret = (await ask("Client Secret: ")).trim();
if (!clientId || !clientSecret) {
  console.error("\nERROR: client_id and client_secret are required.");
  rl.close();
  process.exit(2);
}

console.log("");
console.log("Step 2 of 4: authorize in your browser");
console.log("");
const authUrl =
  "https://launchpad.37signals.com/authorization/new" +
  `?type=web_server&client_id=${encodeURIComponent(clientId)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
console.log("Opening: " + authUrl);
console.log("");
console.log("Sign in (if needed) and click 'Yes, I'll allow access'.");
console.log("You'll land on a page whose URL looks like:");
console.log("  " + REDIRECT_URI + "?code=ABCDEFG...");
console.log("");
openUrl(authUrl);

const redirectUrl = (await ask("Paste the full URL of the page you landed on: ")).trim();
let code;
try {
  code = new URL(redirectUrl).searchParams.get("code");
} catch {
  code = null;
}
if (!code) {
  console.error("\nERROR: couldn't extract `code` from that URL.");
  rl.close();
  process.exit(2);
}
console.log(`  Got code: ${code.slice(0, 8)}...`);

console.log("");
console.log("Step 3 of 4: exchange code for access_token");
const tokenUrl =
  "https://launchpad.37signals.com/authorization/token" +
  `?type=web_server&client_id=${encodeURIComponent(clientId)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&client_secret=${encodeURIComponent(clientSecret)}` +
  `&code=${encodeURIComponent(code)}`;

const tokenRes = await fetch(tokenUrl, { method: "POST" });
if (!tokenRes.ok) {
  console.error(`\nERROR: token exchange failed: ${tokenRes.status} ${tokenRes.statusText}`);
  console.error(await tokenRes.text());
  rl.close();
  process.exit(2);
}
const tokenData = await tokenRes.json();
const accessToken = tokenData.access_token;
const refreshToken = tokenData.refresh_token;
console.log(`  Got access_token: ${accessToken.slice(0, 10)}...`);

console.log("");
console.log("Step 4 of 4: discover account_id and user_id");
const authRes = await fetch("https://launchpad.37signals.com/authorization.json", {
  headers: {
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "morning-mvp setup",
  },
});
if (!authRes.ok) {
  console.error(`\nERROR: discovery failed: ${authRes.status} ${authRes.statusText}`);
  rl.close();
  process.exit(2);
}
const authData = await authRes.json();
const userId = String(authData.identity?.id ?? "");
const accounts = (authData.accounts || []).filter((a) => /basecamp/i.test(a.product));
if (accounts.length === 0) {
  console.error("\nERROR: no Basecamp accounts found on this user.");
  rl.close();
  process.exit(2);
}

let accountId = String(accounts[0].id);
if (accounts.length > 1) {
  console.log("Multiple Basecamp accounts found:");
  accounts.forEach((a, i) => console.log(`  ${i + 1}. ${a.name} (id ${a.id})`));
  const pick = (await ask(`Pick one (1-${accounts.length}, default 1): `)).trim();
  const idx = (Number(pick) || 1) - 1;
  accountId = String(accounts[idx]?.id || accounts[0].id);
}
console.log(`  user_id:    ${userId}`);
console.log(`  account_id: ${accountId}`);

let existing = {};
if (existsSync(CONFIG_PATH)) {
  try {
    existing = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch {
    existing = {};
  }
}
const cfg = {
  ...existing,
  basecamp: {
    account_id: accountId,
    user_id: userId,
    access_token: accessToken,
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    user_agent: existing?.basecamp?.user_agent || "morning-mvp",
  },
  filters: existing.filters || {
    always_include_senders: [],
    always_drop_senders: [],
    always_include_domains: [],
    always_drop_domains: [],
  },
};
await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2));
console.log("");
console.log(`Wrote ${CONFIG_PATH}`);
console.log("");
console.log("Smoke test:");
const todoRes = await fetch(`https://3.basecampapi.com/${accountId}/projects.json`, {
  headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": cfg.basecamp.user_agent },
});
if (todoRes.ok) {
  const projects = await todoRes.json();
  console.log(`  Success. ${projects.length} active projects visible to this token.`);
} else {
  console.log(`  WARNING: projects.json returned ${todoRes.status}. Token works but something is off.`);
}
console.log("");
console.log("Done. The morning-mvp skill will now pull your assigned todos.");
rl.close();
