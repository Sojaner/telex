# telex

An MCP server that lets local AI agents talk to you through Telegram — ask a question, offer
buttons, collect a typed reply, and give up gracefully when you are away.

Your agent is running a long task, hits a decision it shouldn't make alone, and you are not at
the keyboard. Instead of guessing or stalling, it sends you a Telegram message with two buttons
and waits. You tap one from your phone; the agent carries on with your answer. If you never
answer, the buttons come off, the message is marked stale, and the agent decides for itself
whether to stop or continue.

telex is local-only: it runs over stdio next to your agent, talks outbound to the Telegram Bot
API, and only ever messages the chats you configured. Nothing listens on a port.

```
┌────────┐   stdio/MCP   ┌───────┐   Bot API   ┌──────────┐
│ agent  │ ────────────▶ │ telex │ ──────────▶ │ Telegram │ ──▶ you
└────────┘   ◀────────── └───────┘   ◀────────  └──────────┘
             the answer               your tap
```

---

## Install

```sh
npm i -g https://github.com/Sojaner/telex/releases/latest/download/telex.tgz
```

Requires Node 22.6 or newer. Every green push to `main` bumps the patch version, tags it and
attaches a freshly built tarball to a GitHub release, so that URL always points at the latest
build.

Pin a version if you prefer:

```sh
npm i -g https://github.com/Sojaner/telex/releases/download/v0.1.2/telex.tgz
```

Or run it from a checkout:

```sh
git clone https://github.com/Sojaner/telex && cd telex
corepack enable && pnpm install
node src/cli.ts --help          # runs the TypeScript directly, no build
pnpm run build && npm i -g .    # or link this checkout as the global telex
```

Upgrade with the same install command; uninstall with `npm rm -g telex`.

---

## Set up a bot

Create the bot in Telegram, then let telex do the rest:

```sh
telex add
```

It walks you through three things:

1. **The token.** Open [@BotFather](https://t.me/BotFather), send `/newbot`, pick a display name
   and a username ending in `bot`. BotFather replies with a token like `8123456789:AAH…`. Paste
   it in. telex validates it against `getMe` before going further.
2. **The chat.** telex prints your bot's link and waits. Open the chat and send it anything —
   telex reads the chat id and your Telegram user id straight off that message, so you never
   have to read raw `getUpdates` JSON.
3. **A name.** How you'll refer to this bot later (`main`, `work`, `acme-api`). The first bot
   added becomes the default.

It writes `~/.config/telex/config.json` with mode `0600` and sends a test message so you know the
round trip works.

Run `telex add` again for each additional bot. One bot per project is the point — see
[Per-project configuration](#per-project-configuration).

### Groups

Point a bot at a group instead of a DM: add the bot to the group, run `telex add`, and send the
message from inside the group. Group chat ids are negative; telex picks that up automatically.

Set `allowFrom` for groups. An inline keyboard is tappable by **everyone** who can see it, and
telex checks the tapping user against that list — without it, any group member can answer your
agent's questions.

### Doing it by hand

```sh
telex add work --token '8123456789:AAH…' --chat-id 987654321 --allow 987654321
telex add team --token '8234567890:AAG…' --chat-id=-1001234567890 --allow 987654321,123456789
```

Negative chat ids need `--chat-id=-100…` (with the equals sign), because a bare `-100…` looks
like another flag.

---

## Managing bots

```
telex add [name]              add a bot, guided; or --token … --chat-id …
telex list                    configured bots, tokens masked
telex set <name> [options]    change token / chat / allowlist / default
telex remove <name>           delete a bot
telex config [name]           print the MCP registration for a project
telex serve                   run the MCP server over stdio (what agents launch)
```

Options for `add` and `set`:

| Flag | Meaning |
|---|---|
| `--token <token>` | Bot token from BotFather |
| `--chat-id <id>` | Chat the bot writes to (`--chat-id=-100…` for groups) |
| `--allow <id,id>` | Telegram user ids allowed to answer; `any` clears the list |
| `--default` | Make this the global default bot |

```sh
$ telex list
* work             chat 987654321        8123456789:******bAcD  allow: 987654321
  team             chat -1001234567890   8234567890:******xYzW  allow: 987654321, 123456789

* = default. Config: /home/you/.config/telex/config.json
```

`telex list --json` prints the same thing as JSON, tokens still masked.

---

## The config file

`~/.config/telex/config.json`, or wherever `TELEX_CONFIG` points. `XDG_CONFIG_HOME` is honoured.

```json
{
  "defaultBot": "work",
  "bots": {
    "work": {
      "token": "8123456789:AAH…",
      "chatId": 987654321,
      "allowFrom": [987654321]
    },
    "team": {
      "token": "8234567890:AAG…",
      "chatId": -1001234567890,
      "allowFrom": [987654321, 123456789]
    }
  }
}
```

| Field | Required | Meaning |
|---|---|---|
| `defaultBot` | no | Bot used when nothing else specifies one. Defaults to the first entry. |
| `bots.<name>.token` | yes | BotFather token. Keep this file at `0600`; it is a credential. |
| `bots.<name>.chatId` | yes | Chat the bot writes to. Negative for groups and channels. |
| `bots.<name>.allowFrom` | no | Telegram user ids allowed to answer. Omit to trust anyone in the chat. |

The file is shared by every project on the machine; projects select a bot from it rather than
keeping their own copy of your tokens.

---

## Registering with an agent

```sh
telex config
```

prints the registration to paste. The server command is `telex serve`.

**Claude Code**

```sh
claude mcp add --scope user telex -- telex serve
```

**Any MCP client** (`.mcp.json`, `claude_desktop_config.json`, Cursor, Continue, …):

```json
{
  "mcpServers": {
    "telex": {
      "command": "telex",
      "args": ["serve"]
    }
  }
}
```

If `telex` is not on the agent's `PATH` — GUI apps often have a shorter `PATH` than your shell —
use the absolute path, or point Node at the installed entry point:

```json
{
  "mcpServers": {
    "telex": {
      "command": "node",
      "args": ["/home/you/.npm-global/lib/node_modules/telex/dist/index.js"]
    }
  }
}
```

`telex config` prints that path for your machine.

### Per-project configuration

Give each project its own bot, so a message tells you which project it came from before you even
read it, and you can mute one project's bot without muting the rest.

```sh
cd ~/code/acme-api
telex add acme-api                       # its own bot, its own chat
telex config acme-api
```

which prints:

```sh
claude mcp add --scope project telex --env TELEX_BOT=acme-api -- telex serve
```

```json
{
  "mcpServers": {
    "telex": {
      "command": "telex",
      "args": ["serve"],
      "env": { "TELEX_BOT": "acme-api" }
    }
  }
}
```

Commit that `.mcp.json` and everyone on the project gets the right routing — they each configure
their own bot named `acme-api` with their own token, and nothing secret goes in the repo.

Which bot a message goes to, in order:

1. The `bot` argument on the tool call, if the agent passes one.
2. `TELEX_BOT` from the MCP registration — the project's bot.
3. `defaultBot` from the config file.

So a project's agent messages its own bot without being told to, and can still reach another bot
deliberately (`bot: "oncall"` for something urgent, say).

---

## The tool

The server exposes one tool, `send_to_user`:

| Parameter | Type | Meaning |
|---|---|---|
| `project` | string, required | Task or project name, rendered as the bold heading. |
| `message` | string, required | The copy to show you, in Telegram HTML. |
| `options` | string[], optional | Up to 10 single-choice answers, rendered as buttons. |
| `expect_text` | boolean, optional | Show one *Reply* button; your next message becomes the answer. |
| `timeout_seconds` | number, default 300 | Deadline for the whole exchange, 5s to 24h. |
| `bot` | string, optional | Which configured bot to use. |

`options` and `expect_text` are mutually exclusive. With neither, the message is a one-way
notification and the call returns immediately.

**Formatting.** `message` is rendered with Telegram's HTML subset: `<b> <i> <u> <s> <code> <pre>
<a href=""> <blockquote>`. Literal `&`, `<` and `>` must be escaped as `&amp; &lt; &gt;`.
Markdown is not rendered. A message with broken tags is re-sent as plain text rather than failing
the call.

**Results.**

```json
{"status": "sent",     "message_id": 101}
{"status": "answered", "response": "Yes", "kind": "choice", "message_id": 101}
{"status": "timeout",  "message_id": 101}
```

On `timeout` the buttons are stripped and the message is marked stale, so a late tap can't answer
a question nobody is listening to any more. What happens next — retry, continue without you,
stop — is entirely the agent's call. telex has no opinion.

### Examples

A decision:

```json
{
  "project": "acme-api",
  "message": "Migration <code>0042_drop_legacy_users</code> is destructive and irreversible.\nRun it against <b>production</b>?",
  "options": ["Run it", "Skip for now", "Stop and wait for me"],
  "timeout_seconds": 1800
}
```

Missing information:

```json
{
  "project": "acme-api",
  "message": "What should the new endpoint be called?",
  "expect_text": true,
  "timeout_seconds": 600
}
```

A notification, no answer wanted:

```json
{
  "project": "nightly",
  "message": "✅ Test suite green, 412 passed in 3m12s.\nBranch <code>fix/token-refresh</code> is ready to merge.",
  "bot": "alerts"
}
```

---

## Behaviour worth knowing

- **Long messages** are split at Telegram's limit; only the last part carries the buttons.
- **Long choices** — anything over 24 characters — are listed in the message body and the buttons
  become `1`, `2`, `3`, because Telegram truncates long button labels.
- **Stale updates are discarded.** Messages you sent before the question was asked are never read
  as an answer.
- **Slash commands are ignored** as text answers, so `/start` and friends still work.
- **Rate limits** are honoured: a `429` is retried after the `retry_after` Telegram asks for.
- **Tokens are redacted** from error messages; they appear in the API URL that failed.
- **Polling is on demand.** telex long-polls only while an answer is pending, so an idle server
  makes no network calls at all.
- **One poller per token.** Two processes polling the same bot fight over updates; give telex its
  own bot. It says so explicitly if it detects a conflict.

---

## Security notes

- The config file holds bot tokens. telex writes it `0600`; keep it that way, and don't commit it.
- Set `allowFrom` anywhere the chat has more than you in it. Buttons are visible and tappable by
  every member; telex authorises the tap, not just the send.
- A bot can only message chats it is already in, and telex only ever sends to the configured
  `chatId`. It does not accept inbound commands or expose an HTTP endpoint.
- The agent chooses what to send. Treat the message body as something the agent wrote — don't
  ask it to relay secrets you wouldn't want in a Telegram chat.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `no bots configured` | Run `telex add`, or point `TELEX_CONFIG` at the right file. |
| `Telegram rejected that token` | Paste the whole BotFather line, including the digits before the colon. |
| Nothing arrives, no error | Wrong `chatId`, or you never messaged the bot. Check with `telex list`. |
| `getUpdates conflict` | Another process is polling the same token. Give telex its own bot. |
| Agent can't start the server | `telex` isn't on its `PATH`; use the absolute `node …/dist/index.js` form. |
| Buttons do nothing | The tapping account isn't in `allowFrom`. `telex set <name> --allow <id>`. |

Run the server by hand to see startup errors that an agent would swallow:

```sh
telex serve < /dev/null
```

---

## Development

This repo uses **pnpm** — `package-lock.json` is not accepted, and `npm install` in a checkout
stops with a message telling you so. The published tarball is unaffected: install it with npm,
pnpm or anything else.

```sh
corepack enable   # uses the pnpm version pinned in packageManager
pnpm install
pnpm test         # node:test, no network
pnpm run typecheck
pnpm run build    # tsc → dist/, normally done by CI
node src/cli.ts   # run from source; Node strips the types
```

`dist/` is not committed. CI runs the tests on Node 22 and 24 with a frozen lockfile, then bumps
the version, tags it, and publishes a release with the built tarball attached.

## License

MIT
