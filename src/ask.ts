import { type BotSession, TelegramError, escapeHtml } from "./telegram.ts";

export type AskInput = {
  project: string;
  message: string;
  options?: string[];
  expectText?: boolean;
  timeoutSeconds: number;
};

export type AskResult =
  | { status: "sent"; message_id: number }
  | { status: "answered"; response: string; kind: "choice" | "text"; message_id: number }
  | { status: "timeout"; message_id: number };

let counter = 0;
const nextRequestId = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

const body = (project: string, message: string) => `<b>${escapeHtml(project)}</b>\n\n${message}`;

/** Send, wait for the user, then always leave the message in a settled state. */
export async function ask(session: BotSession, chatId: number | string, input: AskInput): Promise<AskResult> {
  const requestId = nextRequestId();
  const options = input.options ?? [];
  if (options.length && input.expectText) throw new Error("telex: use either options or expect_text, not both");

  const keyboard = options.length
    ? options.map((label, i) => [{ text: label, callback_data: `telex:${requestId}:${i}` }])
    : input.expectText
      ? [[{ text: "✍️ Reply", callback_data: `telex:${requestId}:text` }]]
      : [];

  const sent = await send(session, chatId, body(input.project, input.message), keyboard);
  const messageId = sent.message_id;
  if (!keyboard.length) return { status: "sent", message_id: messageId };

  const deadline = Date.now() + input.timeoutSeconds * 1000;
  const answer = await waitForAnswer(session, chatId, requestId, options, deadline);

  if (!answer) {
    await settle(session, chatId, messageId, input, "⏳ <i>No response — stale.</i>");
    return { status: "timeout", message_id: messageId };
  }
  await settle(session, chatId, messageId, input, `✅ <b>${escapeHtml(answer.value)}</b>`);
  return { status: "answered", response: answer.value, kind: answer.kind, message_id: messageId };
}

async function waitForAnswer(
  session: BotSession,
  chatId: number | string,
  requestId: string,
  options: string[],
  deadline: number,
): Promise<{ value: string; kind: "choice" | "text" } | null> {
  const tap = await until<{ payload: string; callbackId: string }>(deadline, (resolve) =>
    session.onCallback(requestId, (payload, ctx) => resolve({ payload, callbackId: ctx.callbackId })),
  );
  if (!tap) return null;

  if (tap.payload !== "text") {
    await session.api("answerCallbackQuery", { callback_query_id: tap.callbackId }).catch(() => {});
    const value = options[Number(tap.payload)];
    return value === undefined ? null : { value, kind: "choice" };
  }

  await session.api("answerCallbackQuery", { callback_query_id: tap.callbackId, text: "Send your reply" }).catch(() => {});
  const prompt = await send(session, chatId, "✍️ <i>Reply to this message with your response.</i>", [], {
    force_reply: true,
  });
  const text = await until<string>(deadline, (resolve) => session.onText(chatId, resolve));
  await session.api("deleteMessage", { chat_id: chatId, message_id: prompt.message_id }).catch(() => {});
  return text === null ? null : { value: text, kind: "text" };
}

/** Resolve with the first value the subscriber emits, or null once the deadline passes. */
function until<T>(deadline: number, subscribe: (resolve: (v: T) => void) => () => void): Promise<T | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: T | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), Math.max(0, deadline - Date.now()));
    const unsubscribe = subscribe((v) => finish(v));
  });
}

/** Drop the keyboard and stamp the outcome onto the original message. */
async function settle(
  session: BotSession,
  chatId: number | string,
  messageId: number,
  input: AskInput,
  footer: string,
) {
  await session.api("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: `${body(input.project, input.message)}\n\n${footer}`,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [] },
  }).catch(() => {});
}

/** HTML is Telegram's forgiving parse mode, but agents still emit stray tags — fall back to plain text. */
async function send(
  session: BotSession,
  chatId: number | string,
  text: string,
  keyboard: unknown[],
  extraMarkup: Record<string, unknown> = {},
): Promise<{ message_id: number }> {
  const reply_markup = keyboard.length ? { inline_keyboard: keyboard } : Object.keys(extraMarkup).length ? extraMarkup : undefined;
  try {
    return await session.api("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", reply_markup });
  } catch (err) {
    if (!(err instanceof TelegramError) || !/parse|entit|tag/i.test(err.description)) throw err;
    return await session.api("sendMessage", { chat_id: chatId, text, reply_markup });
  }
}
