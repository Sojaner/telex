/** Interactive bot onboarding: validate a token, learn the chat id by watching for a message. */
import { createInterface } from "node:readline/promises";
import { apiFor } from "./telegram.js";
import { readConfig, writeConfig, configPath } from "./config.js";
const say = (s = "") => console.log(s);
export async function addBotInteractive(preferredName) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
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
        const config = readConfig();
        const fallback = preferredName ?? (Object.keys(config.bots).length ? "" : "main");
        const name = preferredName ?? ((await rl.question(`Name for this bot${fallback ? ` [${fallback}]` : ""}: `)).trim() || fallback);
        if (!name)
            throw new Error("a name is required");
        const bot = { token, chatId, allowFrom: [userId] };
        config.bots[name] = bot;
        config.defaultBot ??= name;
        writeConfig(config);
        say(`✓ Wrote ${configPath()} (default bot: ${config.defaultBot})`);
        await api("sendMessage", {
            chat_id: chatId,
            text: `<b>telex</b>\n\nSetup complete — bot "${name}" is ready.`,
            parse_mode: "HTML",
        });
        say("✓ Sent a test message; check Telegram.\n");
        return name;
    }
    finally {
        rl.close();
    }
}
/** Long-poll until the user messages the bot, skipping whatever was already queued. */
async function waitForFirstMessage(api) {
    const seen = await api("getUpdates", { offset: -1, timeout: 0 });
    let offset = seen.length ? seen[seen.length - 1].update_id + 1 : 0;
    for (;;) {
        const updates = await api("getUpdates", { offset, timeout: 30, allowed_updates: ["message"] });
        for (const u of updates) {
            offset = Math.max(offset, u.update_id + 1);
            const msg = u.message;
            if (msg)
                return { chatId: msg.chat.id, userId: msg.from?.id ?? msg.chat.id, chatType: msg.chat.type };
        }
    }
}
//# sourceMappingURL=setup.js.map