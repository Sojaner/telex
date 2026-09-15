# telex

An MCP server that lets local AI agents talk to you through Telegram bots — ask a question,
offer buttons, collect a typed reply, and give up gracefully when you are away.

Not a public service: it runs over stdio next to your agent and only ever messages the chat
ids in your config.

## Install

```sh
npm i -g github:Sojaner/telex
```

Requires Node 22.6+. `dist/` is committed so the install needs no build step — run
`npm run build` before committing changes to `src/`.

## Setup

```sh
telex add
```

Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`), paste the token when asked,
then send the bot a message — telex reads the chat id and your user id off that message, writes
the config and sends a test message. Run it again for each further bot.

```
telex add [name]                add a bot, guided; or --token ... --chat-id ...
telex list                      configured bots, tokens masked
telex set <name> [options]      --token, --chat-id, --allow, --default
telex remove <name>
telex config [name]             print the MCP registration for a project
telex serve                     run the MCP server (what the agent launches)
```

To write the config by hand instead, copy `config.example.json` to `~/.config/telex/config.json`.
`chatId` is `message.chat.id` from `https://api.telegram.org/bot<token>/getUpdates`.

Optional `allowFrom` is a list of Telegram user ids allowed to answer. In a group everyone can
see and tap your buttons, so set it there. Give telex its own bot — two processes polling the
same token fight over updates.

Config is read from `$TELEX_CONFIG`, else `~/.config/telex/config.json`.

## One bot per project

`telex config <bot>` prints the registration that pins a project to a bot:

```sh
cd ~/code/some-project
telex config some-project
# claude mcp add --scope project telex --env TELEX_BOT=some-project -- telex serve
```

`TELEX_BOT` is that project's default, so its agent messages its own bot without being told.
The agent can still pass `bot` per call to reach another one, and without `TELEX_BOT` the
global `defaultBot` applies.

## The tool

`send_to_user({ project, message, options?, expect_text?, timeout_seconds?, bot? })`

- **project** — task name, rendered as the bold heading.
- **message** — Telegram HTML (`<b> <i> <u> <s> <code> <pre> <a> <blockquote>`); a message
  with broken tags is re-sent as plain text rather than failing.
- **options** — up to 10 single-choice answers, shown as buttons.
- **expect_text** — shows one *Reply* button; the user's next message becomes the answer.
- Neither → one-way notification, returns immediately.
- **timeout_seconds** — deadline for the whole exchange (default 300).
- **bot** — which configured bot to use; defaults to `defaultBot`.

Returns one of:

```json
{"status": "sent",     "message_id": 101}
{"status": "answered", "response": "Yes", "kind": "choice", "message_id": 101}
{"status": "timeout",  "message_id": 101}
```

On `timeout` the buttons are stripped and the message is marked stale, so a late tap can't
answer a question nobody is listening to any more. What to do next — retry, continue without
the user, stop — is entirely the agent's call; telex has no opinion.

## Behaviour worth knowing

- Messages over Telegram's limit are split; only the last part carries the buttons.
- Choices longer than 24 characters are listed in the message body and the buttons become
  `1`, `2`, `3` — Telegram truncates long button labels.
- Broken HTML is re-sent as plain text instead of failing the call.
- Updates that arrived before the question was asked are discarded, so an old message can't be
  read as an answer. Slash commands are never taken as an answer either.
- `429` responses are honoured (`retry_after`) and bot tokens are stripped from error messages.

## Tests

```sh
npm test        # node:test, no network
npm run typecheck
```
