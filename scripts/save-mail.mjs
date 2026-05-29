#!/usr/bin/env node
// Merges Gmail (or Outlook / other MCP-fetched) mail data into raw-DATE.json
// under raw.mail. Called by the skill workflow AFTER Claude pulls messages
// via a plugin MCP (e.g. mcp__plugin_small-business_gmail__*).
//
// Why this exists: MCP tools live in Claude's tool space, not Node's. Claude
// calls Gmail (or any mail MCP), gets a JSON payload, then runs this script
// to commit the messages in the apple-mail-mcp message shape that the rest
// of the pipeline expects.
//
// Usage:
//   save-mail.mjs --raw raw.json (--json '<json>' | --file response.json)
//     [--account "robby@example.com"]   account name to attach to messages
//                                       (defaults to "gmail" if not in payload)
//     [--target unread|recent_inbox|sent_in_window]
//                                       which raw.mail bucket to write into.
//                                       If omitted, the script splits by label
//                                       (UNREAD -> unread, SENT -> sent_in_window,
//                                       everything else -> recent_inbox).
//
// Accepts multiple Gmail shapes:
//   - Raw Gmail API: { messages: [{id, threadId, labelIds, snippet, payload: { headers, body, parts } }] }
//   - Pre-flattened (Pipedream): { messages: [{id, from, to, subject, date, snippet, labels: []}] }
//   - Bare array: [{...}, {...}]

import { readFile, writeFile } from "node:fs/promises";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, arr) => {
    if (arg.startsWith("--")) acc.push([arg.replace(/^--/, ""), arr[i + 1]]);
    return acc;
  }, []),
);
if (!args.raw || (!args.json && !args.file)) {
  process.stderr.write(
    "usage: save-mail.mjs --raw raw.json (--json '<json>' | --file response.json)\n" +
      "  [--account name] [--target unread|recent_inbox|sent_in_window]\n",
  );
  process.exit(2);
}

let payload;
try {
  const text = args.file ? await readFile(args.file, "utf8") : args.json;
  payload = JSON.parse(text);
} catch (err) {
  process.stderr.write(`[save-mail] could not parse input: ${err.message}\n`);
  process.exit(1);
}

// Extract messages array regardless of wrapper shape.
const messages = Array.isArray(payload)
  ? payload
  : payload.messages ?? payload.items ?? payload.data ?? [];

if (!Array.isArray(messages)) {
  process.stderr.write("[save-mail] payload had no messages array\n");
  process.exit(1);
}

const accountFallback = args.account ?? payload.account ?? "gmail";

/**
 * Pull a header value from a Gmail API payload.headers[] array. Returns "" if
 * no such header. Case-insensitive on header name.
 */
function header(headers, name) {
  if (!Array.isArray(headers)) return "";
  const lc = name.toLowerCase();
  const h = headers.find((x) => (x?.name ?? "").toLowerCase() === lc);
  return h?.value ?? "";
}

/**
 * Translate one message into apple-mail-mcp canonical shape. Tolerant of
 * raw-Gmail-API and pre-flattened-Pipedream shapes.
 */
function normalize(m) {
  // Pre-flattened Pipedream shape first (cheapest checks).
  const flatFrom = m.from ?? m.From ?? m.sender ?? null;
  const flatSubject = m.subject ?? m.Subject ?? null;
  const flatDate = m.date ?? m.Date ?? m.internalDate ?? m.received_at ?? null;
  const flatSnippet = m.snippet ?? m.preview ?? m.body_preview ?? null;
  const flatTo = m.to ?? m.To ?? m.recipients ?? m.recipients_to ?? null;
  const flatMessageId = m.message_id ?? m["message-id"] ?? m.messageId ?? null;
  const flatLabels = m.labels ?? m.labelIds ?? [];

  // Raw Gmail API shape (payload.headers).
  const headers = m.payload?.headers ?? [];
  const rawFrom = header(headers, "From");
  const rawSubject = header(headers, "Subject");
  const rawDate = header(headers, "Date");
  const rawTo = header(headers, "To");
  const rawMessageId = header(headers, "Message-ID") || header(headers, "Message-Id");
  const rawListUnsub = header(headers, "List-Unsubscribe");

  const labels = (flatLabels.length ? flatLabels : m.labelIds ?? []).map((s) =>
    String(s).toUpperCase(),
  );

  // Mailbox heuristic from labels.
  let mailbox = "INBOX";
  if (labels.includes("SENT")) mailbox = "Sent";
  else if (labels.includes("DRAFT")) mailbox = "Drafts";
  else if (labels.includes("SPAM")) mailbox = "Spam";
  else if (labels.includes("TRASH")) mailbox = "Trash";

  // Date: Gmail's internalDate is milliseconds since epoch as a string.
  let dateReceived = flatDate ?? rawDate ?? "";
  if (typeof dateReceived === "string" && /^\d+$/.test(dateReceived)) {
    dateReceived = new Date(Number(dateReceived)).toISOString();
  }

  // Recipients: normalize to an array of strings.
  let recipientsTo = flatTo ?? rawTo ?? "";
  if (typeof recipientsTo === "string") {
    recipientsTo = recipientsTo
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (!Array.isArray(recipientsTo)) {
    recipientsTo = [];
  }

  return {
    id: m.id ?? m.gmail_id ?? m.message_id ?? "",
    thread_id: m.threadId ?? m.thread_id ?? "",
    sender: flatFrom ?? rawFrom ?? "",
    from: flatFrom ?? rawFrom ?? "",
    subject: flatSubject ?? rawSubject ?? "",
    date_received: dateReceived,
    snippet: flatSnippet ?? m.payload?.body?.data ?? "",
    preview: flatSnippet ?? "",
    account: m.account ?? accountFallback,
    mailbox,
    message_id: flatMessageId ?? rawMessageId ?? "",
    recipients_to: recipientsTo,
    in_reply_to: header(headers, "In-Reply-To") || m.in_reply_to || "",
    references: header(headers, "References") || m.references || "",
    list_unsubscribe: rawListUnsub || m.list_unsubscribe || "",
    read: !labels.includes("UNREAD"),
    labels,
    source: "gmail",
  };
}

const normalized = messages.map(normalize);

// Bucket assignment.
const target = args.target;
const valid = new Set(["unread", "recent_inbox", "sent_in_window"]);
if (target && !valid.has(target)) {
  process.stderr.write(`[save-mail] invalid --target "${target}"; allowed: ${[...valid].join(", ")}\n`);
  process.exit(2);
}

let unread = [];
let recent = [];
let sent = [];

if (target) {
  if (target === "unread") unread = normalized;
  else if (target === "recent_inbox") recent = normalized;
  else if (target === "sent_in_window") sent = normalized;
} else {
  // Auto-bucket by labels.
  for (const m of normalized) {
    if (m.mailbox === "Sent") sent.push(m);
    else if (m.labels.includes("UNREAD")) {
      unread.push(m);
      recent.push(m); // unread is a subset of recent
    } else {
      recent.push(m);
    }
  }
}

const raw = JSON.parse(await readFile(args.raw, "utf8"));
const prior = raw.mail ?? {};

// Merge into existing mail buckets if any (e.g. multi-account: run save-mail
// once per account, accumulate). Dedupe by message_id when present.
function mergeUnique(prev = [], next = []) {
  const seen = new Set();
  const out = [];
  for (const m of [...prev, ...next]) {
    const key = m.message_id || `${m.id}|${m.subject}|${m.date_received}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

raw.mail = {
  generated_at: new Date().toISOString(),
  provider: prior.provider ?? "gmail",
  accounts: prior.accounts ?? [{ name: accountFallback, type: "gmail", emails: [accountFallback] }],
  window_days: prior.window_days ?? raw.window_days ?? 7,
  unread: mergeUnique(prior.unread, unread),
  recent_inbox: mergeUnique(prior.recent_inbox, recent),
  sent_in_window: mergeUnique(prior.sent_in_window, sent),
  errors: prior.errors ?? [],
  mcp_resolved: true,
};

await writeFile(args.raw, JSON.stringify(raw, null, 2));

process.stderr.write(
  `[save-mail] merged: ${raw.mail.unread.length} unread, ` +
    `${raw.mail.recent_inbox.length} recent, ` +
    `${raw.mail.sent_in_window.length} sent (account=${accountFallback})\n`,
);
process.stdout.write(
  JSON.stringify(
    {
      merged: {
        unread: unread.length,
        recent_inbox: recent.length,
        sent_in_window: sent.length,
      },
      totals: {
        unread: raw.mail.unread.length,
        recent_inbox: raw.mail.recent_inbox.length,
        sent_in_window: raw.mail.sent_in_window.length,
      },
      account: accountFallback,
    },
    null,
    2,
  ),
);
