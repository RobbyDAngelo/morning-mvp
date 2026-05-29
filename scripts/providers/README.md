# Providers

This folder holds source-specific implementations behind a stable interface.
The dispatchers (`scripts/collect-mail.mjs`, `scripts/collect-calendar.mjs`)
pick which provider to use based on `config.local.json`'s `providers` block,
falling back to OS-aware defaults in `scripts/lib/os-detect.mjs`.

## Mail provider contract

Every mail provider exports an async `collectMail(opts)` function.

```js
import { collectMail } from "./providers/mail/<name>.mjs";

const result = await collectMail({
  days,    // number, 1 to 30
  config,  // parsed config.local.json (may be {})
});
```

`result` must match this shape (the rest of the pipeline depends on it):

```js
{
  provider: "apple-mail" | "gmail" | "outlook-graph",
  accounts: [{ name, type, emails: [string] }],
  unread: [Message],
  recent_inbox: [Message],
  sent_in_window: [Message],
  errors: [{ label, error }],
}
```

Message fields used downstream by `filters.mjs` and `rank.mjs`:
`id`, `from`, `subject`, `date_received`, `date_sent`, `snippet`, `account`,
`mailbox`, `read`, `message_id`, `in_reply_to`, `references`.

Each provider returns whatever underlying client gives it. Field naming
follows the apple-mail-mcp convention as the de-facto contract.

## Calendar provider contract

```js
import { collectCalendar } from "./providers/calendar/<name>.mjs";

const result = await collectCalendar({
  hours,   // number, 1 to 168
  config,
});
```

`result` shape:

```js
{
  provider: "apple-calendar" | "fantastical" | "google-calendar" | ...,
  window_hours: number,
  events: [Event],
  source: string,
  // Optional fields:
  skipped: boolean,
  reason: string,
  requires_mcp: boolean,        // true if the provider needs Claude-side MCP
  mcp_call: { tool, args },     // hint for the workflow
}
```

Event shape:
`{ calendar, title, start, end, location, attendees: [string], notes_preview }`

## Tasks provider contract

Tasks providers are optional. The skill does not ship with one cross-platform
provider today; `basecamp-only` means "skip the tasks tier, use only the
Basecamp section already in the brief". To add one (e.g. Microsoft To Do),
export `collectTasks({ config, identity })` returning
`{ provider, tasks: [Task] }`.

## Provider matrix

| OS | mail default | calendar default | tasks default |
|---|---|---|---|
| macOS (`darwin`) | `apple-mail` | `fantastical` (fallback `apple-calendar`) | `apple-reminders` (not yet implemented) |
| Windows (`win32`) | `gmail` | `google-calendar` | `basecamp-only` |
| Linux (`linux`) | `gmail` | `google-calendar` | `basecamp-only` |

Override any of these in `config.local.json`:

```json
{
  "providers": {
    "mail": "gmail",
    "calendar": "google-calendar",
    "calendar_fallback": null,
    "tasks": "basecamp-only"
  }
}
```

## Adding a new provider

1. Create `providers/<source>/<name>.mjs`. Export `collectX(opts)`.
2. Return the contract shape above. Do not deviate.
3. Add the provider name to `DEFAULT_PROVIDERS` in `scripts/lib/os-detect.mjs`
   if it should be auto-picked on an OS.
4. Add a test in `test/providers-<source>.test.mjs` that fakes the underlying
   client and asserts the contract shape.
5. Document any OAuth or MCP setup in the provider's source file header and
   in `install.sh` / `install.ps1`.
