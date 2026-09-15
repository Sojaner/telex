#!/usr/bin/env node
import { parseArgs, type ParseArgsConfig } from "node:util";
import { fileURLToPath } from "node:url";
import { readConfig, writeConfig, configPath, maskToken, type Bot } from "./config.ts";
import { addBotInteractive } from "./setup.ts";

const USAGE = `telex — send messages from local AI agents to Telegram

  telex serve                         run the MCP server (stdio); what agents launch
  telex add [name]                    add a bot, guided; or pass --token/--chat-id
  telex list                          show configured bots
  telex set <name> [options]          change a bot
  telex remove <name>                 delete a bot
  telex config [name]                 print the MCP registration for a project

Options for add/set:
  --token <token>       bot token from @BotFather
  --chat-id <id>        chat the bot writes to (negative ids: --chat-id=-1001234567890)
  --allow <id,id>       Telegram user ids allowed to answer ("any" to clear)
  --default             make this the default bot

Config lives at ${configPath()} (override with TELEX_CONFIG).`;

const serverEntry = fileURLToPath(new URL("index.ts", import.meta.url));

/** Group chat ids are negative, and parseArgs reads a leading dash as another flag. */
const { values: flags, positionals } = parseArgsFriendly({
  allowPositionals: true,
  options: {
    token: { type: "string" },
    "chat-id": { type: "string" },
    allow: { type: "string" },
    default: { type: "boolean" },
    json: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

const [command, arg] = positionals;

function parseArgsFriendly<T extends ParseArgsConfig>(options: T): ReturnType<typeof parseArgs<T>> {
  try {
    return parseArgs(options);
  } catch (err) {
    const message = (err as Error).message;
    const negative = message.match(/Option '(--[a-z-]+)' argument is ambiguous/i);
    if (negative) {
      console.error(`✗ ${negative[1]} looks like it got a negative value. Write it as ${negative[1]}=-1001234567890.`);
      process.exit(1);
    }
    console.error(`✗ ${message.split("\n")[0]}`);
    process.exit(1);
  }
}

async function run(command: string, name?: string) {
  switch (command) {
    case "serve":
      await import("./index.ts");
      return;

    case "add": {
      const config = readConfig();
      if (name && config.bots[name]) throw new Error(`bot "${name}" already exists — use "telex set ${name}"`);
      // A token on the command line means the caller already knows everything; don't make them talk to a wizard.
      if (!flags.token) {
        const added = await addBotInteractive(name);
        if (flags.default) setDefault(added);
        return;
      }
      if (!flags["chat-id"]) throw new Error("--token also needs --chat-id");
      if (!name) throw new Error("give the bot a name: telex add <name> --token ... --chat-id ...");
      config.bots[name] = { token: flags.token, chatId: numeric(flags["chat-id"]), allowFrom: parseAllow(flags.allow) };
      config.defaultBot = flags.default || !config.defaultBot ? name : config.defaultBot;
      writeConfig(config);
      console.log(`✓ Added "${name}"${config.defaultBot === name ? " (default)" : ""}`);
      return;
    }

    case "set": {
      const config = readConfig();
      const bot = required(config.bots, name);
      if (flags.token) bot.token = flags.token;
      if (flags["chat-id"]) bot.chatId = numeric(flags["chat-id"]);
      if (flags.allow !== undefined) bot.allowFrom = parseAllow(flags.allow);
      if (flags.default) config.defaultBot = name;
      writeConfig(config);
      console.log(`✓ Updated "${name}"`);
      return;
    }

    case "remove": {
      const config = readConfig();
      required(config.bots, name);
      delete config.bots[name!];
      // Never leave defaultBot pointing at a bot that no longer exists.
      if (config.defaultBot === name) config.defaultBot = Object.keys(config.bots)[0];
      writeConfig(config);
      console.log(`✓ Removed "${name}"`);
      return;
    }

    case "list": {
      const config = readConfig();
      const names = Object.keys(config.bots);
      if (!names.length) return console.log(`No bots configured. Run "telex add".`);
      if (flags.json) return console.log(JSON.stringify(redact(config), null, 2));
      for (const n of names) {
        const bot = config.bots[n];
        const allow = bot.allowFrom?.length ? bot.allowFrom.join(", ") : "anyone in chat";
        console.log(`${n === config.defaultBot ? "*" : " "} ${n.padEnd(16)} chat ${String(bot.chatId).padEnd(16)} ${maskToken(bot.token)}  allow: ${allow}`);
      }
      console.log(`\n* = default. Config: ${configPath()}`);
      return;
    }

    case "config": {
      const config = readConfig();
      if (name) required(config.bots, name);
      const entry = {
        command: "telex",
        args: ["serve"],
        ...(name ? { env: { TELEX_BOT: name } } : {}),
      };
      if (flags.json) return console.log(JSON.stringify({ mcpServers: { telex: entry } }, null, 2));
      console.log(`Register telex with this project's agent:\n`);
      console.log(`  claude mcp add --scope project telex${name ? ` --env TELEX_BOT=${name}` : ""} -- telex serve\n`);
      console.log(`...or add to .mcp.json / any MCP client config:\n`);
      console.log(`${JSON.stringify({ mcpServers: { telex: entry } }, null, 2)}\n`);
      if (name) console.log(`Messages from this project default to "${name}"; the agent can still pass another bot.`);
      else console.log(`Pass a bot name to pin this project to one: telex config <name>`);
      console.log(`\nIf "telex" is not on PATH, use: "command": "node", "args": ["${serverEntry}"]`);
      return;
    }

    default:
      throw new Error(`unknown command "${command}"\n\n${USAGE}`);
  }
}

function required(bots: Record<string, Bot>, name?: string): Bot {
  if (!name) throw new Error("which bot? pass its name");
  const bot = bots[name];
  if (!bot) throw new Error(`unknown bot "${name}". Configured: ${Object.keys(bots).join(", ") || "none"}`);
  return bot;
}

function setDefault(name: string) {
  const config = readConfig();
  config.defaultBot = name;
  writeConfig(config);
}

const numeric = (v: string) => (/^-?\d+$/.test(v.trim()) ? Number(v.trim()) : v.trim());

function parseAllow(value?: string): number[] | undefined {
  if (!value || value === "any") return undefined;
  return value.split(",").map((v) => {
    const id = Number(v.trim());
    if (!Number.isInteger(id)) throw new Error(`--allow takes numeric Telegram user ids, got "${v.trim()}"`);
    return id;
  });
}

const redact = (config: ReturnType<typeof readConfig>) => ({
  ...config,
  bots: Object.fromEntries(Object.entries(config.bots).map(([n, b]) => [n, { ...b, token: maskToken(b.token) }])),
});

try {
  if (flags.help || !command) {
    console.log(USAGE);
  } else {
    await run(command, arg);
  }
} catch (err) {
  console.error(`✗ ${(err as Error).message}`);
  process.exitCode = 1;
}
