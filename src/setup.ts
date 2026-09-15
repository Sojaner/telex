#!/usr/bin/env node
/** Interactive setup: validate a token, learn the chat id by watching for a message, write the config. */
import { createInterface } from "node:readline/promises";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import { apiFor, type Update } from "./telegram.ts";
import type { Config } from "./config.ts";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const path =
  process.env.TELEX_CONFIG ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "telex", "config.json");

const say = (s = "") => console.log(s);

try {
  say("telex setup\n");
  say("1. Open https://t.me/BotFather, send /newbot and follow the prompts.");
  say("   BotFather replies with a token like 8123456789:AAH...\n");

  const token = (await rl.question("Paste the bot token: ")).trim();
  const api = apiFor(token);
  const me = await api("getMe", {}).catch(() => {
    throw new Error("Telegram rejected that token. Copy the whole line BotFather sent, including the digits before the colon.");
  });
  say(`\n✓ Token belongs to @${me.username}\n`);

  say(`2. Open https://t.me/${me.username} and send it any message (say "hi").`);
  say("   Waiting...");
  const { chatId, userId, chatType } = await waitForFirstMessage(api);
  say(`\n✓ Chat id ${chatId}${chatType === "private" ? "" : ` (${chatType})`}, your user id ${userId}\n`);

  const existing: Config | undefined = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
  const suggested = existing ? "" : "main";
  const name =
    (await rl.question(`Name for this bot${suggested ? ` [${suggested}]` : ""}: `)).trim() || suggested;
  if (!name) throw new Error("a name is required");

  const config: Config = existing ?? { defaultBot: name, bots: {} };
  config.bots[name] = { token, chatId, allowFrom: [userId] };
  config.defaultBot ??= name;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  say(`\n✓ Wrote ${path} (default bot: ${config.defaultBot})`);

  await api("sendMessage", {
    chat_id: chatId,
    text: `<b>telex</b>\n\nSetup complete — bot "${name}" is ready.`,
    parse_mode: "HTML",
  });
  say("✓ Sent a test message; check Telegram.\n");

  const entry = join(resolve(import.meta.dirname), "index.ts");
  say("3. Register the server with your agent:\n");
  say(`   claude mcp add telex -- node ${entry}\n`);
  say("   ...or add to any MCP client config:\n");
  say(`   ${JSON.stringify({ mcpServers: { telex: { command: "node", args: [entry] } } })}\n`);
} catch (err) {
  console.error(`\n✗ ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  rl.close();
}

/** Long-poll until the user messages the bot, skipping whatever was already queued. */
async function waitForFirstMessage(api: ReturnType<typeof apiFor>) {
  const seen: Update[] = await api("getUpdates", { offset: -1, timeout: 0 });
  let offset = seen.length ? seen[seen.length - 1].update_id + 1 : 0;
  for (;;) {
    const updates: Update[] = await api("getUpdates", { offset, timeout: 30, allowed_updates: ["message"] });
    for (const u of updates) {
      offset = Math.max(offset, u.update_id + 1);
      const msg = u.message as (Update["message"] & { chat: { type: string } }) | undefined;
      if (msg) return { chatId: msg.chat.id, userId: msg.from?.id ?? msg.chat.id, chatType: msg.chat.type };
    }
  }
}
