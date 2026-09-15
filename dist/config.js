import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
export const configPath = () => process.env.TELEX_CONFIG ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "telex", "config.json");
/** Config as it is on disk, or an empty one. For the CLI, which has to cope with "nothing yet". */
export function readConfig() {
    const path = configPath();
    if (!existsSync(path))
        return { bots: {} };
    try {
        const raw = JSON.parse(readFileSync(path, "utf8"));
        return { defaultBot: raw.defaultBot, bots: raw.bots ?? {} };
    }
    catch (err) {
        throw new Error(`telex: ${path} is not valid JSON: ${err.message}`);
    }
}
export function writeConfig(config) {
    const path = configPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
/** Validated config for the server, which cannot do anything useful without at least one bot. */
export function loadConfig() {
    const config = readConfig();
    const names = Object.keys(config.bots);
    if (names.length === 0)
        throw new Error(`telex: no bots configured in ${configPath()} — run "telex add"`);
    for (const [name, bot] of Object.entries(config.bots)) {
        if (!bot?.token || bot.chatId === undefined)
            throw new Error(`telex: bot "${name}" needs both token and chatId`);
    }
    if (config.defaultBot && !config.bots[config.defaultBot]) {
        throw new Error(`telex: defaultBot "${config.defaultBot}" is not in bots`);
    }
    return { defaultBot: config.defaultBot ?? names[0], bots: config.bots };
}
/**
 * Which bot a call goes to: the agent's argument wins, then the bot pinned for this
 * project via TELEX_BOT, then the global default.
 */
export function pickBot(config, name) {
    const key = name || process.env.TELEX_BOT || config.defaultBot;
    const bot = config.bots[key];
    if (!bot)
        throw new Error(`telex: unknown bot "${key}". Configured: ${Object.keys(config.bots).join(", ")}`);
    return { name: key, bot };
}
export const maskToken = (token) => `${token.split(":")[0]}:${"*".repeat(6)}${token.slice(-4)}`;
//# sourceMappingURL=config.js.map