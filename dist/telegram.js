/** Thin Telegram Bot API client plus an on-demand long-poll loop per bot token. */
export class TelegramError extends Error {
    method;
    description;
    code;
    constructor(method, description, code = 0) {
        super(`telegram ${method} failed: ${description}`);
        this.method = method;
        this.description = description;
        this.code = code;
    }
}
/** Bot tokens appear in API URLs, so they leak through raw fetch errors. */
export const redactToken = (s, token) => (token ? s.split(token).join("<token>") : s);
export function apiFor(token) {
    return async function call(method, params, attempt = 0) {
        let body;
        try {
            const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(params),
            });
            body = (await res.json());
        }
        catch (err) {
            throw new Error(redactToken(`telegram ${method} request failed: ${err.message}`, token));
        }
        if (body.ok)
            return body.result;
        const retryAfter = body.parameters?.retry_after;
        if (retryAfter !== undefined && attempt < 2) {
            await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000));
            return call(method, params, attempt + 1);
        }
        throw new TelegramError(method, redactToken(body.description ?? "unknown error", token), 0);
    };
}
/** Telegram's HTML subset only needs these three escaped in text nodes. */
export const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Telegram counts message length in UTF-16 code units, which is what JS strings already are. */
export const MAX_MESSAGE_LEN = 4000;
/**
 * One session per bot token. Polling runs only while something is waiting, so an
 * idle server makes no network calls and never fights another poller for updates.
 */
export class BotSession {
    api;
    pollTimeout;
    offset = 0;
    backlogSkipped = false;
    looping = false;
    callbackWaiters = new Map();
    textWaiters = new Map();
    constructor(api, pollTimeout = 30) {
        this.api = api;
        this.pollTimeout = pollTimeout;
    }
    onCallback(requestId, fn) {
        this.callbackWaiters.set(requestId, fn);
        this.ensureLoop();
        return () => this.callbackWaiters.delete(requestId);
    }
    onText(chatId, fn) {
        this.textWaiters.set(String(chatId), fn);
        this.ensureLoop();
        return () => this.textWaiters.delete(String(chatId));
    }
    get idle() {
        return this.callbackWaiters.size === 0 && this.textWaiters.size === 0;
    }
    ensureLoop() {
        if (this.looping)
            return;
        this.looping = true;
        void this.loop().finally(() => (this.looping = false));
    }
    /**
     * Messages the user sent before we asked anything must not be read as an answer,
     * so the first poll of a process discards whatever is queued.
     */
    async skipBacklog() {
        if (this.backlogSkipped)
            return;
        this.backlogSkipped = true;
        const updates = await this.api("getUpdates", { offset: -1, timeout: 0 }).catch(() => []);
        for (const u of updates)
            this.offset = Math.max(this.offset, u.update_id + 1);
    }
    async loop() {
        await this.skipBacklog();
        while (!this.idle) {
            let updates;
            try {
                updates = await this.api("getUpdates", {
                    offset: this.offset,
                    timeout: this.pollTimeout,
                    allowed_updates: ["message", "callback_query"],
                });
            }
            catch (err) {
                if (isPollingConflict(err)) {
                    process.stderr.write("telex: getUpdates conflict — another process is polling this bot token. " +
                        "Give telex its own bot, or stop the other poller.\n");
                }
                await new Promise((r) => setTimeout(r, 1000));
                continue;
            }
            for (const u of updates)
                this.dispatch(u);
        }
    }
    /** Exposed for tests: route one update to whoever is waiting for it. */
    dispatch(u) {
        this.offset = Math.max(this.offset, u.update_id + 1);
        const cq = u.callback_query;
        if (cq?.data?.startsWith("telex:")) {
            const [, requestId, payload] = cq.data.split(":");
            this.callbackWaiters.get(requestId)?.(payload ?? "", {
                callbackId: cq.id,
                fromId: cq.from?.id,
                chatId: cq.message?.chat.id,
            });
            return;
        }
        const msg = u.message;
        // Slash commands stay available to whatever else the user runs against this bot.
        if (msg?.text !== undefined && !msg.text.startsWith("/")) {
            this.textWaiters.get(String(msg.chat.id))?.(msg.text, msg.from?.id);
        }
    }
}
export const isPollingConflict = (err) => err instanceof TelegramError && /conflict|terminated by other/i.test(err.description);
const sessions = new Map();
export const sessionFor = (token) => sessions.get(token) ?? (sessions.set(token, new BotSession(apiFor(token))), sessions.get(token));
//# sourceMappingURL=telegram.js.map