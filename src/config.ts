import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** allowFrom: Telegram user ids permitted to answer. Omit to trust anyone in the chat. */
export type Bot = { token: string; chatId: number | string; allowFrom?: number[] };
export type Config = { defaultBot?: string; bots: Record<string, Bot> };

const configPath = () =>
  process.env.TELEX_CONFIG ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "telex", "config.json");

export function loadConfig(): Config {
  const path = configPath();
  let raw: Config;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`telex: cannot read config at ${path} (set TELEX_CONFIG to override): ${(err as Error).message}`);
  }
  const names = Object.keys(raw.bots ?? {});
  if (names.length === 0) throw new Error(`telex: no bots configured in ${path}`);
  for (const [name, bot] of Object.entries(raw.bots)) {
    if (!bot?.token || bot.chatId === undefined) throw new Error(`telex: bot "${name}" needs both token and chatId`);
  }
  if (raw.defaultBot && !raw.bots[raw.defaultBot]) throw new Error(`telex: defaultBot "${raw.defaultBot}" is not in bots`);
  return { defaultBot: raw.defaultBot ?? names[0], bots: raw.bots };
}

export function pickBot(config: Config, name?: string): { name: string; bot: Bot } {
  const key = name ?? config.defaultBot!;
  const bot = config.bots[key];
  if (!bot) throw new Error(`telex: unknown bot "${key}". Configured: ${Object.keys(config.bots).join(", ")}`);
  return { name: key, bot };
}
