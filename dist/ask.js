import { TelegramError, escapeHtml, MAX_MESSAGE_LEN } from "./telegram.js";
let counter = 0;
const nextRequestId = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;
/** Telegram truncates long inline-button labels, so long choices move into the body as a numbered list. */
const LABEL_LIMIT = 24;
export function compose(input) {
    const options = input.options ?? [];
    const numbered = options.some((o) => o.length > LABEL_LIMIT);
    const list = numbered ? `\n\n${options.map((o, i) => `${i + 1}. ${escapeHtml(o)}`).join("\n")}` : "";
    return {
        text: `<b>${escapeHtml(input.project)}</b>\n\n${input.message}${list}`,
        buttonLabels: numbered ? options.map((_, i) => String(i + 1)) : options,
    };
}
/** Split on line boundaries where possible; the parse-mode fallback covers chunks that break a tag. */
export function chunk(text, limit = MAX_MESSAGE_LEN) {
    const out = [];
    let rest = text;
    while (rest.length > limit) {
        const cut = rest.lastIndexOf("\n", limit) > limit / 2 ? rest.lastIndexOf("\n", limit) : limit;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^\n/, "");
    }
    out.push(rest);
    return out;
}
/** Send, wait for the user, then always leave the message in a settled state. */
export async function ask(session, chatId, input) {
    const requestId = nextRequestId();
    const options = input.options ?? [];
    if (options.length && input.expectText)
        throw new Error("telex: use either options or expect_text, not both");
    const { text, buttonLabels } = compose(input);
    const keyboard = options.length
        ? buttonLabels.map((label, i) => [{ text: label, callback_data: `telex:${requestId}:${i}` }])
        : input.expectText
            ? [[{ text: "✍️ Reply", callback_data: `telex:${requestId}:text` }]]
            : [];
    // Only the final chunk carries the keyboard, so the buttons sit under the whole question.
    const chunks = chunk(text);
    let sent;
    for (const [i, part] of chunks.entries()) {
        sent = await send(session, chatId, part, i === chunks.length - 1 ? keyboard : []);
    }
    const messageId = sent.message_id;
    const tail = chunks[chunks.length - 1];
    if (!keyboard.length)
        return { status: "sent", message_id: messageId };
    const deadline = Date.now() + input.timeoutSeconds * 1000;
    const answer = await waitForAnswer(session, chatId, requestId, options, deadline, input.allowFrom);
    if (!answer) {
        await settle(session, chatId, messageId, tail, "⏳ <i>No response — stale.</i>");
        return { status: "timeout", message_id: messageId };
    }
    await settle(session, chatId, messageId, tail, `✅ <b>${escapeHtml(answer.value)}</b>`);
    return { status: "answered", response: answer.value, kind: answer.kind, message_id: messageId };
}
/** An inline keyboard is clickable by anyone who can see it, so authorise the tap, not the send. */
function authorized(ctx, chatId, allowFrom) {
    if (ctx.chatId !== undefined && String(ctx.chatId) !== String(chatId))
        return false;
    return !allowFrom?.length || (ctx.fromId !== undefined && allowFrom.includes(ctx.fromId));
}
async function waitForAnswer(session, chatId, requestId, options, deadline, allowFrom) {
    const tap = await until(deadline, (resolve) => session.onCallback(requestId, (payload, ctx) => {
        if (!authorized(ctx, chatId, allowFrom)) {
            void session.api("answerCallbackQuery", {
                callback_query_id: ctx.callbackId,
                text: "⛔ Not your prompt.",
            }).catch(() => { });
            return;
        }
        resolve({ payload, ctx });
    }));
    if (!tap)
        return null;
    const toast = (text) => session.api("answerCallbackQuery", { callback_query_id: tap.ctx.callbackId, text }).catch(() => { });
    if (tap.payload !== "text") {
        const value = options[Number(tap.payload)];
        await toast(value === undefined ? "" : `✓ ${value.slice(0, 60)}`);
        return value === undefined ? null : { value, kind: "choice" };
    }
    await toast("✍️ Type your answer in the chat.");
    const prompt = await send(session, chatId, "✍️ <i>Reply to this message with your response.</i>", [], {
        force_reply: true,
    });
    const text = await until(deadline, (resolve) => session.onText(chatId, (value, fromId) => {
        if (allowFrom?.length && (fromId === undefined || !allowFrom.includes(fromId)))
            return;
        resolve(value);
    }));
    await session.api("deleteMessage", { chat_id: chatId, message_id: prompt.message_id }).catch(() => { });
    return text === null ? null : { value: text, kind: "text" };
}
/** Resolve with the first value the subscriber emits, or null once the deadline passes. */
function until(deadline, subscribe) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (v) => {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            unsubscribe();
            resolve(v);
        };
        const timer = setTimeout(() => finish(null), Math.max(0, deadline - Date.now()));
        const unsubscribe = subscribe((v) => finish(v));
    });
}
/** Drop the keyboard and stamp the outcome onto the message that carried it. */
async function settle(session, chatId, messageId, text, footer) {
    await session.api("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: `${text}\n\n${footer}`,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [] },
    }).catch(() => { }); // "message is not modified" and friends are not worth failing the answer over
}
/** HTML is Telegram's forgiving parse mode, but agents still emit stray tags — fall back to plain text. */
async function send(session, chatId, text, keyboard, extraMarkup = {}) {
    const reply_markup = keyboard.length
        ? { inline_keyboard: keyboard }
        : Object.keys(extraMarkup).length
            ? extraMarkup
            : undefined;
    try {
        return await session.api("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", reply_markup });
    }
    catch (err) {
        if (!(err instanceof TelegramError) || !/parse|entit|tag/i.test(err.description))
            throw err;
        return await session.api("sendMessage", { chat_id: chatId, text, reply_markup });
    }
}
//# sourceMappingURL=ask.js.map