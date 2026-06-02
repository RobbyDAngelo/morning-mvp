#!/usr/bin/env node
// Pulls Basecamp 3/4 todos assigned to the configured user.
// Skips cleanly (exit 0, empty payload) if config.local.json is absent.
//
// Setup:
//   1. Create a personal access token at https://launchpad.37signals.com/integrations
//      OR use an existing OAuth access_token.
//   2. Copy config.example.json to config.local.json, fill in account_id, user_id,
//      access_token, and user_agent.
//
// Output: JSON to stdout: { todos: [...], errors: [...], skipped: bool, reason: str? }

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, "..", "config.local.json");

async function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return null;
  return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
}

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, arr) => {
    if (arg.startsWith("--")) acc.push([arg.replace(/^--/, ""), arr[i + 1]]);
    return acc;
  }, []),
);
const days = Math.max(1, Math.min(Number(args.days ?? 7), 30));

const cfg = await loadConfig();
if (!cfg?.basecamp?.access_token) {
  process.stdout.write(
    JSON.stringify(
      {
        skipped: true,
        reason: "config.local.json missing or basecamp.access_token not set",
        todos: [],
        errors: [],
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

// Refresh the access token if it expires within 24 hours and we have what we
// need to refresh. Writes the new tokens back to config.local.json so the
// next run picks them up. Basecamp's access_token TTL is ~14 days; the
// refresh_token is good for years.
async function maybeRefreshToken(cfgIn) {
  const bc = cfgIn.basecamp;
  if (!bc.refresh_token || !bc.client_id || !bc.client_secret) return cfgIn;
  if (!bc.token_expires_at) return cfgIn;
  const expiry = Date.parse(bc.token_expires_at);
  if (Number.isNaN(expiry)) return cfgIn;
  if (expiry - Date.now() > 24 * 60 * 60 * 1000) return cfgIn;

  process.stderr.write("[collect-basecamp] token within 24h of expiry, refreshing...\n");
  const url =
    "https://launchpad.37signals.com/authorization/token" +
    `?type=refresh&refresh_token=${encodeURIComponent(bc.refresh_token)}` +
    `&client_id=${encodeURIComponent(bc.client_id)}` +
    `&redirect_uri=${encodeURIComponent("https://launchpad.37signals.com/authorization/done")}` +
    `&client_secret=${encodeURIComponent(bc.client_secret)}`;
  const r = await fetch(url, { method: "POST" });
  if (!r.ok) {
    process.stderr.write(`[collect-basecamp] refresh FAILED: ${r.status} ${r.statusText}\n`);
    return cfgIn;
  }
  const tok = await r.json();
  const next = {
    ...cfgIn,
    basecamp: {
      ...bc,
      access_token: tok.access_token,
      refresh_token: tok.refresh_token || bc.refresh_token,
      token_expires_at: new Date(Date.now() + (tok.expires_in ?? 14 * 86400) * 1000).toISOString(),
    },
  };
  await writeFile(CONFIG_PATH, JSON.stringify(next, null, 2) + "\n");
  process.stderr.write(
    `[collect-basecamp] token refreshed, new expiry ${next.basecamp.token_expires_at}\n`,
  );
  return next;
}

const cfgEffective = await maybeRefreshToken(cfg);
const { account_id, user_id, access_token, user_agent } = cfgEffective.basecamp;
const API_BASE = `https://3.basecampapi.com/${account_id}`;
const HEADERS = {
  Authorization: `Bearer ${access_token}`,
  "User-Agent": user_agent || "morning-mvp",
  Accept: "application/json",
};

const errors = [];

async function bcFetch(url) {
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`Basecamp ${r.status} ${r.statusText} ${url}: ${body.slice(0, 200)}`);
  }
  return r.json();
}

// 0. Resolve the per-account user_id. The launchpad identity_id (from
// /authorization.json) is a different number from the Basecamp-internal
// person id used in `assignees[].id`. Always fetch /my/profile.json to get
// the right id for this account. Cache the result back into config.
let effectiveUserId = Number(user_id);
try {
  const me = await bcFetch(`${API_BASE}/my/profile.json`);
  if (me?.id && me.id !== effectiveUserId) {
    process.stderr.write(
      `[collect-basecamp] correcting user_id ${effectiveUserId} -> ${me.id} (per-account id)\n`,
    );
    effectiveUserId = me.id;
    cfgEffective.basecamp.user_id = String(me.id);
    await writeFile(CONFIG_PATH, JSON.stringify(cfgEffective, null, 2) + "\n");
  }
} catch (err) {
  errors.push(`profile_lookup: ${err.message}`);
}

// 1. List active projects.
let projects = [];
try {
  projects = await bcFetch(`${API_BASE}/projects.json`);
} catch (err) {
  errors.push(`list_projects: ${err.message}`);
  process.stdout.write(JSON.stringify({ skipped: false, todos: [], errors }, null, 2));
  process.exit(0);
}
process.stderr.write(`[collect-basecamp] ${projects.length} active projects\n`);

// 2. For each project, find todolists, then todos assigned to user.
const cutoffMs = Date.now() + days * 24 * 60 * 60 * 1000;
const todos = [];

for (const project of projects) {
  const todoSetDock = project.dock?.find((d) => d.name === "todoset");
  if (!todoSetDock?.url) continue;
  let todoSet;
  try {
    todoSet = await bcFetch(todoSetDock.url);
  } catch (err) {
    errors.push(`project[${project.id}].todoset: ${err.message}`);
    continue;
  }
  let lists;
  try {
    lists = await bcFetch(todoSet.todolists_url);
  } catch (err) {
    errors.push(`project[${project.id}].todolists: ${err.message}`);
    continue;
  }
  for (const list of lists) {
    let listTodos;
    try {
      listTodos = await bcFetch(`${list.todos_url}?status=active`);
    } catch (err) {
      errors.push(`project[${project.id}].list[${list.id}].todos: ${err.message}`);
      continue;
    }
    for (const t of listTodos) {
      const mine = (t.assignees || []).some((a) => a.id === effectiveUserId);
      if (!mine) continue;
      const dueMs = t.due_on ? Date.parse(t.due_on + "T17:00:00") : null;
      const within = dueMs && dueMs <= cutoffMs;
      todos.push({
        id: t.id,
        title: t.title || t.content,
        url: t.app_url,
        due_on: t.due_on,
        due_within_window: !!within,
        project: project.name,
        project_id: project.id,
        list: list.title,
        completed: t.completed,
        created_at: t.created_at,
        updated_at: t.updated_at,
        assignees: (t.assignees || []).map((a) => a.name),
      });
    }
  }
}

todos.sort((a, b) => {
  if (a.due_on && b.due_on) return a.due_on.localeCompare(b.due_on);
  if (a.due_on) return -1;
  if (b.due_on) return 1;
  return (b.updated_at || "").localeCompare(a.updated_at || "");
});

process.stdout.write(
  JSON.stringify({ skipped: false, generated_at: new Date().toISOString(), todos, errors }, null, 2),
);
process.stderr.write(`[collect-basecamp] ${todos.length} assigned todos\n`);
