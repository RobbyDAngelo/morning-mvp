// Tests for scripts/save-mail.mjs. Covers Gmail-API raw shape,
// Pipedream pre-flattened shape, bare-array shape, multi-account merge.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, "..", "scripts", "save-mail.mjs");

function runSaveMail(args) {
  return new Promise((resolveP) => {
    const child = spawn("node", [SCRIPT, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
    child.on("close", (code) => resolveP({ code, stdout, stderr }));
  });
}

async function setupTmp() {
  const dir = await mkdtemp(join(tmpdir(), "mmvp-save-mail-"));
  const rawPath = join(dir, "raw-test.json");
  const initialRaw = { generated_at: "2026-05-01T08:00:00Z", window_days: 7, mail: null };
  await writeFile(rawPath, JSON.stringify(initialRaw));
  return { dir, rawPath };
}

test("SAVE-MAIL-1: handles raw Gmail API shape (payload.headers)", async () => {
  const { dir, rawPath } = await setupTmp();
  try {
    const payload = {
      messages: [
        {
          id: "abc123",
          threadId: "t-123",
          labelIds: ["INBOX", "UNREAD", "IMPORTANT"],
          snippet: "Hey, quick question about the proposal.",
          internalDate: "1746000000000",
          payload: {
            headers: [
              { name: "From", value: "Brian Test <brian@example.com>" },
              { name: "To", value: "user@example.com" },
              { name: "Subject", value: "Re: proposal draft" },
              { name: "Date", value: "Mon, 28 Apr 2026 14:00:00 +0000" },
              { name: "Message-ID", value: "<msg-abc-123@mail.example.com>" },
            ],
          },
        },
      ],
    };
    const payloadPath = join(dir, "gmail-response.json");
    await writeFile(payloadPath, JSON.stringify(payload));

    const res = await runSaveMail([
      "--raw",
      rawPath,
      "--file",
      payloadPath,
      "--account",
      "user@example.com",
    ]);
    assert.equal(res.code, 0, `stderr: ${res.stderr}`);

    const raw = JSON.parse(await readFile(rawPath, "utf8"));
    assert.equal(raw.mail.unread.length, 1);
    assert.equal(raw.mail.recent_inbox.length, 1); // unread counts as recent
    assert.equal(raw.mail.sent_in_window.length, 0);

    const msg = raw.mail.unread[0];
    assert.equal(msg.sender, "Brian Test <brian@example.com>");
    assert.equal(msg.from, "Brian Test <brian@example.com>");
    assert.equal(msg.subject, "Re: proposal draft");
    assert.equal(msg.message_id, "<msg-abc-123@mail.example.com>");
    assert.equal(msg.account, "user@example.com");
    assert.equal(msg.mailbox, "INBOX");
    assert.equal(msg.read, false);
    assert.deepEqual(msg.recipients_to, ["user@example.com"]);
    assert.equal(msg.source, "gmail");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SAVE-MAIL-2: handles pre-flattened Pipedream shape", async () => {
  const { dir, rawPath } = await setupTmp();
  try {
    const payload = {
      messages: [
        {
          id: "x1",
          from: "Dave <dave@example.com>",
          to: "user@example.com, cc@example.com",
          subject: "Lunch Thursday?",
          date: "2026-04-29T12:34:00Z",
          snippet: "Want to grab lunch?",
          labels: ["INBOX"],
          message_id: "<x1@mail>",
        },
      ],
    };
    const payloadPath = join(dir, "pd-response.json");
    await writeFile(payloadPath, JSON.stringify(payload));

    const res = await runSaveMail([
      "--raw",
      rawPath,
      "--file",
      payloadPath,
      "--account",
      "user@example.com",
    ]);
    assert.equal(res.code, 0, `stderr: ${res.stderr}`);
    const raw = JSON.parse(await readFile(rawPath, "utf8"));
    const m = raw.mail.recent_inbox[0];
    assert.equal(m.from, "Dave <dave@example.com>");
    assert.equal(m.subject, "Lunch Thursday?");
    assert.deepEqual(m.recipients_to, ["user@example.com", "cc@example.com"]);
    assert.equal(m.read, true); // no UNREAD label
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SAVE-MAIL-3: --target flag forces bucket assignment", async () => {
  const { dir, rawPath } = await setupTmp();
  try {
    const payload = {
      messages: [{ id: "s1", from: "me@x", subject: "out", date: "2026-04-29T00:00:00Z" }],
    };
    const payloadPath = join(dir, "sent.json");
    await writeFile(payloadPath, JSON.stringify(payload));

    const res = await runSaveMail([
      "--raw",
      rawPath,
      "--file",
      payloadPath,
      "--target",
      "sent_in_window",
    ]);
    assert.equal(res.code, 0, `stderr: ${res.stderr}`);
    const raw = JSON.parse(await readFile(rawPath, "utf8"));
    assert.equal(raw.mail.sent_in_window.length, 1);
    assert.equal(raw.mail.unread.length, 0);
    assert.equal(raw.mail.recent_inbox.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SAVE-MAIL-4: dedupes by message_id across multiple runs (multi-account merge)", async () => {
  const { dir, rawPath } = await setupTmp();
  try {
    const payloadA = {
      messages: [
        {
          id: "a1",
          from: "Alice <alice@x.com>",
          subject: "shared thread",
          date: "2026-04-29T00:00:00Z",
          labels: ["INBOX"],
          message_id: "<shared@x.com>",
        },
      ],
    };
    const payloadB = {
      messages: [
        {
          id: "a1-different-gmail-id",
          from: "Alice <alice@x.com>",
          subject: "shared thread",
          date: "2026-04-29T00:00:00Z",
          labels: ["INBOX"],
          message_id: "<shared@x.com>", // same message_id, second account
        },
      ],
    };
    const pA = join(dir, "a.json");
    const pB = join(dir, "b.json");
    await writeFile(pA, JSON.stringify(payloadA));
    await writeFile(pB, JSON.stringify(payloadB));

    await runSaveMail(["--raw", rawPath, "--file", pA, "--account", "first@x.com"]);
    await runSaveMail(["--raw", rawPath, "--file", pB, "--account", "second@x.com"]);

    const raw = JSON.parse(await readFile(rawPath, "utf8"));
    assert.equal(raw.mail.recent_inbox.length, 1, "duplicate by message_id should be dropped");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SAVE-MAIL-5: handles bare array payload", async () => {
  const { dir, rawPath } = await setupTmp();
  try {
    const payload = [
      { id: "b1", from: "X <x@y.com>", subject: "bare", date: "2026-04-29T00:00:00Z", labels: ["INBOX", "UNREAD"] },
    ];
    const pp = join(dir, "bare.json");
    await writeFile(pp, JSON.stringify(payload));
    const res = await runSaveMail(["--raw", rawPath, "--file", pp]);
    assert.equal(res.code, 0, `stderr: ${res.stderr}`);
    const raw = JSON.parse(await readFile(rawPath, "utf8"));
    assert.equal(raw.mail.unread.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SAVE-MAIL-6: rejects invalid --target", async () => {
  const { dir, rawPath } = await setupTmp();
  try {
    const pp = join(dir, "x.json");
    await writeFile(pp, JSON.stringify({ messages: [] }));
    const res = await runSaveMail(["--raw", rawPath, "--file", pp, "--target", "garbage"]);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /invalid --target/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SAVE-MAIL-7: bails cleanly on missing args", async () => {
  const res = await runSaveMail([]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /usage:/);
});

test("SAVE-MAIL-8: handles Gmail SENT label and routes to sent_in_window", async () => {
  const { dir, rawPath } = await setupTmp();
  try {
    const payload = {
      messages: [
        {
          id: "s9",
          labelIds: ["SENT"],
          payload: {
            headers: [
              { name: "From", value: "me@x" },
              { name: "Subject", value: "outgoing reply" },
              { name: "Date", value: "Mon, 28 Apr 2026 14:00:00 +0000" },
            ],
          },
        },
      ],
    };
    const pp = join(dir, "sent.json");
    await writeFile(pp, JSON.stringify(payload));
    const res = await runSaveMail(["--raw", rawPath, "--file", pp]);
    assert.equal(res.code, 0, `stderr: ${res.stderr}`);
    const raw = JSON.parse(await readFile(rawPath, "utf8"));
    assert.equal(raw.mail.sent_in_window.length, 1);
    assert.equal(raw.mail.sent_in_window[0].mailbox, "Sent");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SAVE-MAIL-9: converts Gmail internalDate (epoch ms) to ISO", async () => {
  const { dir, rawPath } = await setupTmp();
  try {
    const payload = {
      messages: [
        {
          id: "d1",
          labelIds: ["INBOX"],
          internalDate: "1746000000000", // ms
          payload: {
            headers: [
              { name: "From", value: "x@y" },
              { name: "Subject", value: "date check" },
            ],
          },
        },
      ],
    };
    const pp = join(dir, "d.json");
    await writeFile(pp, JSON.stringify(payload));
    await runSaveMail(["--raw", rawPath, "--file", pp]);
    const raw = JSON.parse(await readFile(rawPath, "utf8"));
    const got = raw.mail.recent_inbox[0].date_received;
    assert.match(got, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
