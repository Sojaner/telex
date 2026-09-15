# telex

An MCP server that lets local AI agents talk to you through Telegram bots — ask a question,
offer buttons, collect a typed reply, and give up gracefully when you are away.

Not a public service: it runs over stdio next to your agent and only ever messages the chat
ids in your config.

## Setup

```sh
npm install
cp config.example.json ~/.config/telex/config.json   # then fill in tokens and chat ids
```

Each bot needs a token from [@BotFather](https://t.me/BotFather) and the `chatId` of the chat
it should write to (message the bot, then open
`https://api.telegram.org/bot<token>/getUpdates` and read `message.chat.id`).

Config is read from `$TELEX_CONFIG`, else `~/.config/telex/config.json`.

Register with your agent:

```json
{
  "mcpServers": {
    "telex": { "command": "node", "args": ["/path/to/telex/src/index.ts"] }
  }
}
```

Requires Node 22.6+ (TypeScript runs directly, no build step).

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

## Tests

```sh
npm test        # node:test, no network
npm run typecheck
```
