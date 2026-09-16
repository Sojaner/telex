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
/** An agent that never checks in must not grow the inbox without bound; oldest go first. */
const INBOX_LIMIT = 50;
/**
 * One session per bot token. Polling runs while a question is open and, once a chat is watched,
 * for the rest of the process's life — a project that is not running simply never answers.
 */
export class BotSession {
    api;
    pollTimeout;
    offset = 0;
    backlogSkipped = false;
    looping = false;
    callbackWaiters = new Map();
    textWaiters = new Map();
    watched = new Map();
    inbox = new Map();
    ttl = new Map();
    listening = false;
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
    /**
     * Take an interest in a chat and keep polling for the life of the process. Being alive is what
     * makes a project reachable: if nothing polls, nothing acknowledges, and nothing was delivered.
     */
    watch(chatId, options = {}) {
        this.watched.set(String(chatId), options);
        this.listening = true;
        this.ensureLoop();
    }
    /** Stop the permanent poll. The loop still runs out whatever question is currently open. */
    stop() {
        this.listening = false;
        this.watched.clear();
        this.ttl.clear();
    }
    /**
     * How long a message may sit unclaimed. Set from the agent's heartbeat interval, so until it
     * checks in for the first time telex has no idea how long "too long" is and nothing expires.
     */
    setInboxTtl(chatId, ms) {
        this.ttl.set(String(chatId), ms);
    }
    /** Hand over everything held for this chat. */
    take(chatId) {
        const key = String(chatId);
        const queued = this.inbox.get(key) ?? [];
        this.inbox.delete(key);
        return queued;
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
        while (this.listening || !this.idle) {
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
            this.sweepInbox();
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
        if (msg?.text === undefined || msg.text.startsWith("/"))
            return;
        const key = String(msg.chat.id);
        const answering = this.textWaiters.get(key);
        if (answering)
            return answering(msg.text, msg.from?.id);
        this.queue(key, msg);
    }
    /** Nobody asked for this one, so hold it rather than let it answer whatever gets asked next. */
    queue(key, msg, now = Date.now()) {
        const watch = this.watched.get(key);
        if (!watch)
            return;
        if (watch.allowFrom?.length && !(msg.from && watch.allowFrom.includes(msg.from.id)))
            return;
        const message = { message_id: msg.message_id, from_id: msg.from?.id, text: msg.text, received_at: now };
        if (watch.accept && !watch.accept())
            return watch.onRefused?.(message);
        this.inbox.set(key, [...(this.inbox.get(key) ?? []), message].slice(-INBOX_LIMIT));
        watch.onQueued?.(message);
    }
    /**
     * Drop whatever outlived the TTL. Runs on every poll, so a message expires even when the agent
     * has stopped checking in entirely — which is exactly when the user most needs telling.
     */
    sweepInbox(now = Date.now()) {
        for (const [key, held] of this.inbox) {
            const ttl = this.ttl.get(key);
            if (ttl === undefined)
                continue;
            const expired = held.filter((m) => now - m.received_at > ttl);
            if (!expired.length)
                continue;
            this.inbox.set(key, held.filter((m) => now - m.received_at <= ttl));
            this.watched.get(key)?.onExpired?.(expired);
        }
    }
}
export const isPollingConflict = (err) => err instanceof TelegramError && /conflict|terminated by other/i.test(err.description);
const sessions = new Map();
export const sessionFor = (token) => sessions.get(token) ?? (sessions.set(token, new BotSession(apiFor(token))), sessions.get(token));
//# sourceMappingURL=telegram.js.map