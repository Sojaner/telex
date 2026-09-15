/** Thin Telegram Bot API client plus an on-demand long-poll loop per bot token. */

export type Update = {
  update_id: number;
  message?: { message_id: number; chat: { id: number }; from?: { id: number }; text?: string };
  callback_query?: {
    id: string;
    data?: string;
    from?: { id: number };
    message?: { message_id: number; chat: { id: number } };
  };
};

export type Fetcher = (method: string, params: Record<string, unknown>) => Promise<any>;

export class TelegramError extends Error {
  method: string;
  description: string;
  code: number;
  constructor(method: string, description: string, code = 0) {
    super(`telegram ${method} failed: ${description}`);
    this.method = method;
    this.description = description;
    this.code = code;
  }
}

/** Bot tokens appear in API URLs, so they leak through raw fetch errors. */
export const redactToken = (s: string, token: string) => (token ? s.split(token).join("<token>") : s);

export function apiFor(token: string): Fetcher {
  return async function call(method, params, attempt = 0): Promise<any> {
    let body: { ok: boolean; result?: unknown; description?: string; parameters?: { retry_after?: number } };
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
      });
      body = (await res.json()) as typeof body;
    } catch (err) {
      throw new Error(redactToken(`telegram ${method} request failed: ${(err as Error).message}`, token));
    }
    if (body.ok) return body.result;
    const retryAfter = body.parameters?.retry_after;
    if (retryAfter !== undefined && attempt < 2) {
      await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000));
      return call(method, params, attempt + 1);
    }
    throw new TelegramError(method, redactToken(body.description ?? "unknown error", token), 0);
  } as Fetcher;
}

/** Telegram's HTML subset only needs these three escaped in text nodes. */
export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Telegram counts message length in UTF-16 code units, which is what JS strings already are. */
export const MAX_MESSAGE_LEN = 4000;

export type CallbackCtx = { callbackId: string; fromId?: number; chatId?: number };
type CallbackWaiter = (payload: string, ctx: CallbackCtx) => void;
type TextWaiter = (text: string, fromId?: number) => void;

/** A message the user sent without being asked for one. `receipt_id` is telex's reply to it. */
export type Incoming = { message_id: number; from_id?: number; text: string; received_at: number; receipt_id?: number };

type Watch = {
  allowFrom?: number[];
  onQueued?: (message: Incoming) => void;
  /** Fires for messages no heartbeat collected in time. */
  onExpired?: (messages: Incoming[]) => void;
};

/** An agent that never checks in must not grow the inbox without bound; oldest go first. */
const INBOX_LIMIT = 50;

/**
 * One session per bot token. Polling runs while a question is open and, once a chat is watched,
 * for the rest of the process's life — a project that is not running simply never answers.
 */
export class BotSession {
  readonly api: Fetcher;
  private readonly pollTimeout: number;
  private offset = 0;
  private backlogSkipped = false;
  private looping = false;
  private callbackWaiters = new Map<string, CallbackWaiter>();
  private textWaiters = new Map<string, TextWaiter>();
  private watched = new Map<string, Watch>();
  private inbox = new Map<string, Incoming[]>();
  private ttl = new Map<string, number>();
  private listening = false;

  constructor(api: Fetcher, pollTimeout = 30) {
    this.api = api;
    this.pollTimeout = pollTimeout;
  }

  onCallback(requestId: string, fn: CallbackWaiter): () => void {
    this.callbackWaiters.set(requestId, fn);
    this.ensureLoop();
    return () => this.callbackWaiters.delete(requestId);
  }

  onText(chatId: number | string, fn: TextWaiter): () => void {
    this.textWaiters.set(String(chatId), fn);
    this.ensureLoop();
    return () => this.textWaiters.delete(String(chatId));
  }

  /**
   * Take an interest in a chat and keep polling for the life of the process. Being alive is what
   * makes a project reachable: if nothing polls, nothing acknowledges, and nothing was delivered.
   */
  watch(chatId: number | string, options: Watch = {}) {
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
  setInboxTtl(chatId: number | string, ms: number) {
    this.ttl.set(String(chatId), ms);
  }

  /** Hand over everything held for this chat. */
  take(chatId: number | string): Incoming[] {
    const key = String(chatId);
    const queued = this.inbox.get(key) ?? [];
    this.inbox.delete(key);
    return queued;
  }

  private get idle() {
    return this.callbackWaiters.size === 0 && this.textWaiters.size === 0;
  }

  private ensureLoop() {
    if (this.looping) return;
    this.looping = true;
    void this.loop().finally(() => (this.looping = false));
  }

  /**
   * Messages the user sent before we asked anything must not be read as an answer,
   * so the first poll of a process discards whatever is queued.
   */
  private async skipBacklog() {
    if (this.backlogSkipped) return;
    this.backlogSkipped = true;
    const updates: Update[] = await this.api("getUpdates", { offset: -1, timeout: 0 }).catch(() => []);
    for (const u of updates) this.offset = Math.max(this.offset, u.update_id + 1);
  }

  private async loop() {
    await this.skipBacklog();
    while (this.listening || !this.idle) {
      let updates: Update[];
      try {
        updates = await this.api("getUpdates", {
          offset: this.offset,
          timeout: this.pollTimeout,
          allowed_updates: ["message", "callback_query"],
        });
      } catch (err) {
        if (isPollingConflict(err)) {
          process.stderr.write(
            "telex: getUpdates conflict — another process is polling this bot token. " +
              "Give telex its own bot, or stop the other poller.\n",
          );
        }
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      for (const u of updates) this.dispatch(u);
      this.sweepInbox();
    }
  }

  /** Exposed for tests: route one update to whoever is waiting for it. */
  dispatch(u: Update) {
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
    if (msg?.text === undefined || msg.text.startsWith("/")) return;
    const key = String(msg.chat.id);
    const answering = this.textWaiters.get(key);
    if (answering) return answering(msg.text, msg.from?.id);
    this.queue(key, msg);
  }

  /** Nobody asked for this one, so hold it rather than let it answer whatever gets asked next. */
  private queue(key: string, msg: NonNullable<Update["message"]>, now = Date.now()) {
    const watch = this.watched.get(key);
    if (!watch) return;
    if (watch.allowFrom?.length && !(msg.from && watch.allowFrom.includes(msg.from.id))) return;
    const message: Incoming = { message_id: msg.message_id, from_id: msg.from?.id, text: msg.text!, received_at: now };
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
      if (ttl === undefined) continue;
      const expired = held.filter((m) => now - m.received_at > ttl);
      if (!expired.length) continue;
      this.inbox.set(key, held.filter((m) => now - m.received_at <= ttl));
      this.watched.get(key)?.onExpired?.(expired);
    }
  }
}

export const isPollingConflict = (err: unknown) =>
  err instanceof TelegramError && /conflict|terminated by other/i.test(err.description);

const sessions = new Map<string, BotSession>();
export const sessionFor = (token: string) =>
  sessions.get(token) ?? (sessions.set(token, new BotSession(apiFor(token))), sessions.get(token)!);
