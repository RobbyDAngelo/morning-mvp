// Priority scoring + ranking. Pure functions over normalized messages.
// Higher score = higher in the ranked output.
//
// Formula:
//   priority = (waiting_signal * 3) + (deadline_48h_signal * 4) + (vip_signal * 2) + recency
//
// Each signal is 0 or 1 except recency, which is 0..2.

import {
  urgencyScore,
  asksForReply,
  detectDeadlineHoursAhead,
  isPersonalSender,
  senderDomain,
} from "./filters.mjs";

const HOURS = 60 * 60 * 1000;

export function recencyScore(dateStr, now = Date.now()) {
  const t = Date.parse(normalizeAppleDate(dateStr));
  if (Number.isNaN(t)) return 0;
  const ageHours = (now - t) / HOURS;
  if (ageHours < 24) return 2;
  if (ageHours < 72) return 1;
  return 0;
}

// Strip the leading weekday and " at " from Apple-locale date strings so
// Date.parse can handle them. (Same logic as apple-mail-mcp's parser.)
function normalizeAppleDate(s) {
  if (!s) return "";
  return s.replace(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,\s*/i, "").replace(/\s+at\s+/i, " ").trim();
}

export function vipBoost(senderEmail, vipSet = new Set()) {
  if (!senderEmail) return 0;
  return vipSet.has(senderEmail.toLowerCase()) ? 1 : 0;
}

// VIP = a real human Robby has a bidirectional relationship with in the window.
//
// Two qualifying conditions, EITHER is sufficient:
//   (a) Robby has sent at least 1 message to this person AND received >= 1.
//       This is the strongest signal: an actual two-way relationship.
//   (b) The inbound sender uses a personal-name pattern AND has sent >= threshold
//       messages. Required to catch personal contacts Robby hasn't replied to
//       yet but who are clearly real humans (e.g., a new intro from a friend).
//
// What this filters out: bulk senders ("Walmart.com", "AInfluencer", "Info@...")
// who blast many messages but Robby has never replied to and aren't personal.
export function buildVipSet(messages, sent, threshold = 3) {
  const inboundCounts = new Map();
  const inboundPersonal = new Map();
  for (const m of messages) {
    const e = extractEmail(m.sender);
    if (!e) continue;
    inboundCounts.set(e, (inboundCounts.get(e) ?? 0) + 1);
    if (isPersonalSender(m.sender)) {
      inboundPersonal.set(e, (inboundPersonal.get(e) ?? 0) + 1);
    }
  }
  const sentTo = new Set();
  for (const m of sent) {
    for (const addr of (m.recipients_to ?? "").split(/[,;]\s*/)) {
      const e = addr.trim().toLowerCase();
      if (e) sentTo.add(e);
    }
  }

  const vips = new Set();
  for (const [email, count] of inboundCounts) {
    // (a) reciprocal: at least one outbound to them + any inbound
    if (sentTo.has(email) && count >= 1) {
      vips.add(email);
      continue;
    }
    // (b) personal sender past the threshold even without our reply
    if ((inboundPersonal.get(email) ?? 0) >= threshold) {
      vips.add(email);
    }
  }
  return vips;
}

function extractEmail(senderRaw) {
  if (!senderRaw) return "";
  const m = senderRaw.match(/<([^>]+)>/);
  return (m ? m[1] : senderRaw).trim().toLowerCase();
}

// Build the index of replied conversations: any inbound message with Message-ID
// referenced in a Sent message's body/subject is considered "replied".
//
// AppleScript surface doesn't expose In-Reply-To / References headers cheaply,
// so we use two heuristics:
//   1. Sent message subject equals "Re: <inbound subject>" AND the sent's date
//      is later AND it goes to the inbound sender.
//   2. The Message-ID appears in any Sent message body (rare but cheap).
//
// This is conservative: a true unreplied message may be marked replied if Robby
// replied via another channel, but a true replied message will rarely be marked
// unreplied. False unreplied is annoying but not catastrophic.
export function buildRepliedIndex(inbound, sent) {
  const replied = new Set();

  // Primary signal: Mail's per-message reply flag (the IMAP \Answered flag,
  // exposed as `was_replied_to`). True when the user replied from ANY client
  // (Mail.app, web, phone), so it works even when the Sent folder is not
  // synced locally. No false positives: a set \Answered flag means a reply
  // was sent.
  for (const m of inbound) {
    if (m.was_replied_to === true && m.message_id) replied.add(m.message_id);
  }

  // Supplemental signal: Sent-folder subject + date cross-reference. Only adds
  // value when the Sent folder is actually synced locally.
  const normSubj = (s) => (s ?? "").replace(/^(re|fwd):\s*/i, "").trim().toLowerCase();
  const inboundBySubj = new Map();
  for (const m of inbound) {
    const k = normSubj(m.subject);
    if (!inboundBySubj.has(k)) inboundBySubj.set(k, []);
    inboundBySubj.get(k).push(m);
  }

  for (const s of sent) {
    const subj = normSubj(s.subject);
    if (!subj) continue;
    const candidates = inboundBySubj.get(subj);
    if (!candidates) continue;
    const sentDate = Date.parse(normalizeAppleDate(s.date_received));
    if (Number.isNaN(sentDate)) continue;
    for (const c of candidates) {
      const inDate = Date.parse(normalizeAppleDate(c.date_received));
      if (Number.isNaN(inDate)) continue;
      if (sentDate > inDate) replied.add(c.message_id);
    }
  }
  return replied;
}

export function scoreMessage(msg, { repliedIndex, vipSet }) {
  const senderEmail = extractEmail(msg.sender);
  const unreplied = !repliedIndex.has(msg.message_id);
  // Personal = actual human sender ("First Last <...>" pattern). Tightens
  // waiting_on_me to suppress marketing emails that survived newsletter
  // filtering but happen to use question-mark subjects.
  const personal = isPersonalSender(msg.sender) || vipSet.has(senderEmail);
  const asks = asksForReply(msg.subject, msg.preview || msg.body || "");
  const urgency = urgencyScore(msg.subject, msg.preview || msg.body || "");
  const deadlineHoursAhead = detectDeadlineHoursAhead(msg.subject, msg.preview || msg.body || "");
  const waiting_signal = unreplied && personal && (asks || urgency > 0) ? 1 : 0;
  const deadline_signal = deadlineHoursAhead !== null && deadlineHoursAhead <= 48 ? 1 : 0;
  const vip = vipBoost(senderEmail, vipSet);
  const recency = recencyScore(msg.date_received);

  const priority = waiting_signal * 3 + deadline_signal * 4 + vip * 2 + recency + urgency * 0.5;

  return {
    ...msg,
    sender_email: senderEmail,
    unreplied,
    waiting_on_me: !!waiting_signal,
    deadline_hours_ahead: deadlineHoursAhead,
    has_deadline_48h: !!deadline_signal,
    vip,
    urgency_score: urgency,
    priority,
  };
}

export function rankMessages(messages, ctx) {
  return messages.map((m) => scoreMessage(m, ctx)).sort((a, b) => b.priority - a.priority);
}
