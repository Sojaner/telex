/** Thin Telegram Bot API client plus an on-demand long-poll loop per bot token. */

export type Update = {
  update_id: number;
  message?: { message_id: number; chat: { id: number }; text?: string };
  callback_query?: { id: string; data?: string; message?: { message_id: number; chat: { id: number } } };
};

export type Fetcher = (method: string, params: Record<string, unknown>) => Promise<any>;

export class TelegramError extends Error {
  method: string;
  description: string;
  constructor(method: string, description: string) {
    super(`telegram ${method} failed: ${description}`);
    this.method = method;
    this.description = description;
  }
}

export function apiFor(token: string): Fetcher {
  return async (method, params) => {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    const body = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
    if (!body.ok) throw new TelegramError(method, body.description ?? `HTTP ${res.status}`);
    return body.result;
  };
}

/** Telegram's HTML subset only needs these three escaped in text nodes. */
export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

type CallbackWaiter = (payload: string, ctx: { callbackId: string }) => void;

/**
 * One session per bot token. Polling runs only while something is waiting, so an
 * idle server makes no network calls and never fights another poller for updates.
 */
export class BotSession {
  private offset = 0;
  private looping = false;
  private callbackWaiters = new Map<string, CallbackWaiter>();
  private textWaiters = new Map<string, (text: string) => void>();

  readonly api: Fetcher;
  private readonly pollTimeout: number;

  constructor(api: Fetcher, pollTimeout = 30) {
    this.api = api;
    this.pollTimeout = pollTimeout;
  }

  onCallback(requestId: string, fn: CallbackWaiter): () => void {
    this.callbackWaiters.set(requestId, fn);
    this.ensureLoop();
    return () => this.callbackWaiters.delete(requestId);
  }

  onText(chatId: number | string, fn: (text: string) => void): () => void {
    this.textWaiters.set(String(chatId), fn);
    this.ensureLoop();
    return () => this.textWaiters.delete(String(chatId));
  }

  private get idle() {
    return this.callbackWaiters.size === 0 && this.textWaiters.size === 0;
  }

  private ensureLoop() {
    if (this.looping) return;
    this.looping = true;
    void this.loop().finally(() => (this.looping = false));
  }

  private async loop() {
    while (!this.idle) {
      let updates: Update[];
      try {
        updates = await this.api("getUpdates", {
          offset: this.offset,
          timeout: this.pollTimeout,
          allowed_updates: ["message", "callback_query"],
        });
      } catch {
        // Network blip or a competing getUpdates; back off briefly and retry.
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      for (const u of updates) this.dispatch(u);
    }
  }

  /** Exposed for tests: route one update to whoever is waiting for it. */
  dispatch(u: Update) {
    this.offset = Math.max(this.offset, u.update_id + 1);
    const cq = u.callback_query;
    if (cq?.data?.startsWith("telex:")) {
      const [, requestId, payload] = cq.data.split(":");
      this.callbackWaiters.get(requestId)?.(payload ?? "", { callbackId: cq.id });
      return;
    }
    const text = u.message?.text;
    if (text !== undefined && u.message) this.textWaiters.get(String(u.message.chat.id))?.(text);
  }
}

const sessions = new Map<string, BotSession>();
export const sessionFor = (token: string) =>
  sessions.get(token) ?? (sessions.set(token, new BotSession(apiFor(token))), sessions.get(token)!);
