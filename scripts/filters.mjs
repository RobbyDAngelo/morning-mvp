// Newsletter / notification / automated-mail heuristics. Used by filter-rank.
// Returns {drop: boolean, reasons: string[], borderline: boolean}.
//
// Why this lives in its own module: every rule here is unit-testable in isolation,
// and the rule set is the most likely thing to need tuning over time.

const NOREPLY_SENDER_RE = /(noreply|no[\-_.]?reply|auto[\-_.]?reply|notifications?|newsletter|digest|marketing|do[\-_]?not[\-_]?reply|mailer[\-_]?daemon|postmaster|automated?|alerts?|reminders?|updates?|bounce|mailbot|notify)@/i;

// Domain blocklist: well-known marketing/automation senders. Conservative; only
// add domains where messages are almost never personal.
const DOMAIN_BLOCKLIST = new Set([
  "mailchimp.com",
  "mcsignup.com",
  "sendgrid.net",
  "sendgrid.com",
  "mail.sendgrid.net",
  "sparkpostmail.com",
  "mta3vrest.sd.prd.sparkpost",
  "amazonses.com",
  "email.amazonses.com",
  "us-west-2.amazonses.com",
  "mailgun.org",
  "mandrillapp.com",
  "postmarkapp.com",
  "constantcontact.com",
  "ccsend.com",
  "convertkit.com",
  "convertkitmail.com",
  "klaviyo.com",
  "klaviyomail.com",
  "kmail-lists.com",
  "hubspot.com",
  "hubspotemail.net",
  "salesforce.com",
  "intercom-mail.com",
  "intercom.io",
  "substack.com",
  "ghost.io",
  "beehiiv.com",
  "campaign-archive.com",
  "youtube.com",
  "linkedin.com",
  "stripe.com",
  "twitch.tv",
  "googlegroups.com",
  "accounts.google.com",
  "applecard.apple",
  "post.applecard.apple",
  "email.apple.com",
  "appleid.com",
  "privaterelay.appleid.com",
  "wixshoutout.com",
  "drive-shares-noreply.google.com",
  "mail.notion.so",
  "vercel.com",
  "github.com",
  "notifications.github.com",
  "news.weather.com",
  "mail.seed.com",
  "gohighlevel.com",
  "email.gohighlevel.com",
  "mg.gohighlevel.com",
  "discountdrugnetwork.com",
  "messages.duolingo.com",
  "mail.calendly.com",
  "shareasale.com",
  "venmo.com",
  "email.venmo.com",
  "service.paypal.com",
  "email.paypal.com",
  "asana.com",
  "mail.asana.com",
  "mail.zoom.us",
  "no-reply.zoom.us",
  "support.apple.com",
  "insideapple.apple.com",
]);

// Heuristic: any sender domain that starts with `mail.`, `email.`, `news.`,
// `notify.`, or `notifications.` is almost always a transactional/marketing
// sender. Use as a secondary signal when the explicit blocklist misses.
const TRANSACTIONAL_SUBDOMAIN_RE = /^(mail|email|news|notify|notifications|hello|info|noreply|no-reply|alerts?|update|reminder)\./i;

// Sender personal-name shape: "First Last <email>" with two or more name tokens
// before the angle bracket. Each token starts with a capital and can contain
// internal apostrophes or hyphens (O'Brien, Anne-Marie). Rough but a strong
// personal-message signal.
const PERSONAL_NAME_RE = /^[A-Z][A-Za-z'\-]+(?:\s+[A-Z][A-Za-z'\-]+)+\s*<[^>]+@[^>]+>$/;

// Subject patterns common to automated messages.
const AUTOMATED_SUBJECT_RE = [
  /^(your receipt|receipt for|order (confirmation|shipped|placed)|payment (received|sent|successfully))/i,
  /^(canceled event|updated invitation|invitation:|accepted:|declined:|tentatively accepted:)/i,
  /^\[?(github|gitlab|vercel|render|fly|netlify|stripe|buy|sell)\]?/i,
  /^(your \w+ statement|monthly statement|monthly report|weekly digest|daily digest)/i,
  /^(welcome to|verify your|confirm your|activate your)/i,
  /^(unsubscribe|view in browser|view as web page)/i,
  /^\d+% off|sale ends|limited time/i,
  /your \w+ is ready/i,
  /^password (reset|change)/i,
  /^security alert/i,
  /^action required(?!.*responding)/i, // "action required" in marketing emails, not in "action required responding to..."
];

// Urgency keywords in subject or body. Used to BOOST priority, not to filter.
const URGENCY_KEYWORDS = [
  "urgent",
  "asap",
  "today",
  "by eod",
  "end of day",
  "please respond",
  "need your",
  "waiting on you",
  "awaiting your",
  "follow up",
  "quick question",
  "approval needed",
  "sign off",
  "decision needed",
];

// Question / reply-prompting patterns in subject or body.
const QUESTION_PATTERNS = [
  /\?/,
  /\bcan you\b/i,
  /\bcould you\b/i,
  /\bwould you\b/i,
  /\bplease (review|sign|approve|confirm|respond|reply)\b/i,
  /\blet me know\b/i,
  /\bthoughts\?/i,
  /\bany update\b/i,
];

export function senderEmail(senderRaw) {
  if (!senderRaw) return "";
  const m = senderRaw.match(/<([^>]+)>/);
  return (m ? m[1] : senderRaw).trim().toLowerCase();
}

export function senderDomain(senderRaw) {
  const email = senderEmail(senderRaw);
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1) : "";
}

// Exact, case-insensitive email match against a user-supplied list.
function inSenderList(email, list) {
  if (!Array.isArray(list) || list.length === 0) return false;
  const e = email.toLowerCase();
  return list.some((s) => String(s).trim().toLowerCase() === e);
}

// Domain match against a user-supplied list. Matches the exact domain OR any
// subdomain of it: "scaleupmedia.com" matches "reply.scaleupmedia.com" too.
// A leading "@" on a list entry is tolerated.
function inDomainList(domain, list) {
  if (!Array.isArray(list) || list.length === 0) return false;
  const d = domain.toLowerCase();
  return list.some((raw) => {
    const dd = String(raw).trim().toLowerCase().replace(/^@/, "");
    if (!dd) return false;
    return d === dd || d.endsWith("." + dd);
  });
}

export function isLikelyNewsletter(msg, overrides = {}) {
  const reasons = [];
  const sender = msg.sender ?? msg.from ?? "";
  const subject = msg.subject ?? "";
  const email = senderEmail(sender);
  const domain = senderDomain(sender);

  const {
    always_include_senders = [],
    always_include_domains = [],
    always_drop_senders = [],
    always_drop_domains = [],
  } = overrides ?? {};

  // User allowlist wins over everything. Never drop a sender the user has
  // explicitly always-included, even if the heuristics would flag it.
  if (
    inSenderList(email, always_include_senders) ||
    inDomainList(domain, always_include_domains)
  ) {
    return { drop: false, reasons: ["user_allowlist"], borderline: false };
  }

  // User droplist. Force-drop a sender or domain the user marked as noise.
  // This is the F-4 mitigation from SECURITY-REVIEW.md: marketing senders
  // with a personal display name (e.g. "Dan Martell <dm@danmartell.com>")
  // bypass the heuristics below, so the user names them explicitly in
  // config.local.json filters.always_drop_senders / always_drop_domains.
  if (inSenderList(email, always_drop_senders)) {
    return { drop: true, reasons: [`user_drop_sender:${email}`], borderline: false };
  }
  if (inDomainList(domain, always_drop_domains)) {
    return { drop: true, reasons: [`user_drop_domain:${domain}`], borderline: false };
  }

  if (NOREPLY_SENDER_RE.test(email)) reasons.push(`sender_pattern:${email}`);
  if (DOMAIN_BLOCKLIST.has(domain)) reasons.push(`domain_blocked:${domain}`);
  if (TRANSACTIONAL_SUBDOMAIN_RE.test(domain)) reasons.push(`transactional_subdomain:${domain}`);
  for (const re of AUTOMATED_SUBJECT_RE) {
    if (re.test(subject)) {
      reasons.push(`subject_pattern:${re.source.slice(0, 40)}`);
      break;
    }
  }

  // List-Unsubscribe header is the strongest single signal but we typically
  // don't get headers from AppleScript. Hook present for future expansion.
  if (msg.list_unsubscribe) reasons.push("list_unsubscribe_header");

  // Calendar invites that already have Accepted/Declined in subject are noise.
  if (/^(Accepted|Declined|Tentatively accepted):/i.test(subject)) {
    reasons.push("calendar_already_resolved");
  }

  // Bounce + automated digests are noise.
  if (/^(Re: )?Delivery Status Notification/i.test(subject)) {
    reasons.push("dsn_bounce");
  }

  const drop = reasons.length > 0;
  return { drop, reasons, borderline: false };
}

export function isPersonalSender(senderRaw) {
  return PERSONAL_NAME_RE.test(senderRaw ?? "");
}

export function urgencyScore(subject, body) {
  const haystack = ((subject ?? "") + " " + (body ?? "")).toLowerCase();
  let score = 0;
  for (const kw of URGENCY_KEYWORDS) {
    if (haystack.includes(kw)) score += 1;
  }
  return Math.min(score, 5);
}

export function asksForReply(subject, body) {
  const haystack = (subject ?? "") + " " + (body ?? "");
  for (const re of QUESTION_PATTERNS) {
    if (re.test(haystack)) return true;
  }
  return false;
}

// Heuristic deadline detection. Returns an ISO-ish date string if a deadline is
// detected inside the next 48 hours, else null. Conservative: only matches when
// a specific date or near-term phrase is found.
const NOW = () => new Date();
const HOURS = 60 * 60 * 1000;

const NEAR_TERM_PHRASES = [
  { re: /\btoday\b/i, offsetHours: 8 },
  { re: /\btonight\b/i, offsetHours: 12 },
  { re: /\btomorrow\b/i, offsetHours: 24 },
  { re: /\bby (eod|end of (day|today))\b/i, offsetHours: 8 },
  { re: /\bin the next (24|48) hours\b/i, offsetHours: 24 },
  { re: /\bby (this )?(morning|afternoon|evening)\b/i, offsetHours: 8 },
];

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function detectDeadlineHoursAhead(subject, body, now = NOW()) {
  const haystack = ((subject ?? "") + " " + (body ?? "")).toLowerCase();

  for (const { re, offsetHours } of NEAR_TERM_PHRASES) {
    if (re.test(haystack)) return offsetHours;
  }

  // "by Friday" style: find the named day, compute hours ahead.
  const dayMatch = haystack.match(/\bby (sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/);
  if (dayMatch) {
    const target = DAY_NAMES.findIndex((d) => d.startsWith(dayMatch[1]));
    const today = now.getDay();
    let delta = target - today;
    if (delta <= 0) delta += 7;
    const hours = delta * 24;
    if (hours <= 72) return hours;
  }

  return null;
}
