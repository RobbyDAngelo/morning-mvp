// People-centric collapse. Pure functions over normalized message data.
//
// The hard part: Brian Toelle writes from briantoelle@gmail.com, Brian@narrowgate.group,
// and brian@sellformillions.com. Three emails, one person, one row in the brief.
//
// Strategy: canonicalize by display name. For each personal sender ("First Last <email>"),
// group emails under the most-used email for that name. Non-personal senders stay as-is.

import { senderEmail, isPersonalSender } from "./filters.mjs";

function displayName(sender) {
  if (!sender) return "";
  // Strip the <email@addr> tail; trim quotes; collapse whitespace.
  const name = sender.replace(/\s*<[^>]+>\s*$/, "").replace(/^["']|["']$/g, "").trim();
  return name;
}

function normalizedName(sender) {
  // Lowercased, single-spaced, middle initials/periods removed. Used as the
  // canonicalization key for personal senders.
  return displayName(sender)
    .toLowerCase()
    .replace(/\b[a-z]\.\s+/g, "") // strip middle initials like "J."
    .replace(/[.,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildPersonAliases(messages) {
  // For each personal sender, count uses per (name, email) pair, then pick the
  // most-used email per name as the canonical address. Returns Map<email, canonical_email>.
  const nameToEmailCounts = new Map();
  for (const m of messages) {
    const s = m.sender ?? "";
    if (!isPersonalSender(s)) continue;
    const name = normalizedName(s);
    const email = senderEmail(s);
    if (!name || !email) continue;
    if (!nameToEmailCounts.has(name)) nameToEmailCounts.set(name, new Map());
    const inner = nameToEmailCounts.get(name);
    inner.set(email, (inner.get(email) ?? 0) + 1);
  }

  const aliases = new Map();
  for (const [name, emailCounts] of nameToEmailCounts) {
    const sorted = [...emailCounts.entries()].sort((a, b) => b[1] - a[1]);
    const canonical = sorted[0][0];
    for (const [email] of sorted) aliases.set(email, canonical);
  }
  return aliases;
}

function canonicalEmail(sender, aliases) {
  const e = senderEmail(sender);
  return aliases.get(e) ?? e;
}

export function buildPeopleView({
  inbound,
  threads,
  notion,
  basecamp,
  vipSet,
  repliedIndex,
}) {
  const allMessages = inbound ?? [];
  const aliases = buildPersonAliases(allMessages);

  const byPerson = new Map();
  function get(person, displayPrefer) {
    if (!byPerson.has(person)) {
      byPerson.set(person, {
        counterparty_email: person,
        counterparty_name: displayPrefer ?? person,
        vip: vipSet.has(person),
        is_personal: false,
        mail: { unreplied: [], replied: [], all_subjects: new Set() },
        threads: [],
        notion: [],
        basecamp: [],
        message_count: 0,
        unreplied_count: 0,
        last_activity: null,
      });
    }
    return byPerson.get(person);
  }

  // 1. Mail messages. Skip non-personal, non-VIP senders. The people view is
  // about HUMANS Robby needs to think about, not bulk senders that survived
  // the newsletter filter. Walmart, AInfluencer, etc. don't belong here.
  for (const m of allMessages) {
    const canon = canonicalEmail(m.sender, aliases);
    const isReal = isPersonalSender(m.sender) || vipSet.has(canon);
    if (!isReal) continue;
    const name = displayName(m.sender) || canon;
    const p = get(canon, name);
    if (isPersonalSender(m.sender)) p.is_personal = true;
    p.counterparty_name = name; // most recently seen display
    p.message_count += 1;
    p.mail.all_subjects.add((m.subject ?? "").replace(/^(re|fwd):\s*/i, "").trim());
    const unreplied = !repliedIndex.has(m.message_id);
    if (unreplied) {
      p.mail.unreplied.push({
        message_id: m.message_id,
        subject: m.subject,
        date: m.date_received,
        account: m.account,
        mailbox: m.mailbox,
      });
      p.unreplied_count += 1;
    } else {
      p.mail.replied.push({
        message_id: m.message_id,
        subject: m.subject,
        date: m.date_received,
      });
    }
    if (!p.last_activity || (m.date_received ?? "") > (p.last_activity ?? "")) {
      p.last_activity = m.date_received;
    }
  }

  // 2. Active threads: attribute the thread to the latest non-self sender.
  for (const t of threads ?? []) {
    const canon = canonicalEmail(t.latest_from, aliases);
    const name = displayName(t.latest_from) || canon;
    const p = get(canon, name);
    p.threads.push({
      subject: t.subject,
      messages: t.messages,
      latest_from: t.latest_from,
      latest_date: t.latest_date,
      account: t.account,
    });
  }

  // 3. Notion call notes: attribute to the People relation if present (rare
  // because Notion search snippets don't always expose People), else to a
  // synthetic "Notion" bucket so we don't drop them.
  for (const n of notion ?? []) {
    const peopleField = Array.isArray(n.people) ? n.people : [];
    if (peopleField.length === 0) {
      const p = get("__notion__", "Notion call notes");
      p.notion.push({ title: n.title, url: n.url, date: n.date, project: n.project });
      continue;
    }
    for (const personName of peopleField) {
      // Match by name to an already-known counterparty if possible.
      const norm = normalizedName(`${personName} <x@x>`);
      let matched = null;
      for (const [email, entry] of byPerson) {
        if (normalizedName(`${entry.counterparty_name} <x@x>`) === norm) {
          matched = email;
          break;
        }
      }
      const key = matched ?? `notion:${personName.toLowerCase()}`;
      const p = get(key, personName);
      p.notion.push({ title: n.title, url: n.url, date: n.date, project: n.project });
    }
  }

  // 4. Basecamp todos: attribute to assignees. If self-assigned only, bucket
  // under "Basecamp self".
  for (const t of basecamp?.todos ?? []) {
    const assignees = t.assignees ?? [];
    if (assignees.length === 0) continue;
    for (const a of assignees) {
      const key = `bc:${a.toLowerCase()}`;
      const p = get(key, a);
      p.basecamp.push({
        title: t.title,
        due_on: t.due_on,
        project: t.project,
        url: t.url,
      });
    }
  }

  // Finalize: convert subject sets to arrays, sort by activity, compute scores.
  const rows = [];
  for (const [, p] of byPerson) {
    p.mail.all_subjects = [...p.mail.all_subjects].filter(Boolean).slice(0, 8);
    p.activity_score =
      p.unreplied_count * 3 +
      p.threads.length * 2 +
      p.mail.replied.length +
      p.notion.length +
      p.basecamp.length +
      (p.vip ? 4 : 0);
    rows.push(p);
  }
  rows.sort((a, b) => b.activity_score - a.activity_score);
  return rows;
}

export const __test = { displayName, normalizedName, canonicalEmail };
