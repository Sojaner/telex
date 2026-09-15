import { test } from "node:test";
import assert from "node:assert/strict";
import { BotSession, type Update } from "../src/telegram.ts";
import { ask } from "../src/ask.ts";

/** Fake Bot API: records calls, answers getUpdates with nothing so we can inject updates by hand. */
function fakeSession() {
  const calls: { method: string; params: any }[] = [];
  let messageId = 100;
  const session = new BotSession(async (method, params) => {
    if (method === "getUpdates") return await new Promise((r) => setTimeout(() => r([]), 10));
    calls.push({ method, params });
    if (method === "sendMessage") return { message_id: ++messageId };
    return true;
  }, 0);
  return { session, calls, last: (m: string) => [...calls].reverse().find((c) => c.method === m) };
}

const tick = () => new Promise((r) => setTimeout(r, 30));

const callbackUpdate = (data: string): Update => ({
  update_id: 1,
  callback_query: { id: "cb1", data, message: { message_id: 101, chat: { id: 7 } } },
});

test("button choice is returned and the message is settled without a keyboard", async () => {
  const { session, calls, last } = fakeSession();
  const pending = ask(session, 7, { project: "Telex", message: "Deploy?", options: ["Yes", "No"], timeoutSeconds: 5 });
  await tick();

  const keyboard = calls[0].params.reply_markup.inline_keyboard;
  assert.equal(calls[0].params.parse_mode, "HTML");
  assert.match(calls[0].params.text, /^<b>Telex<\/b>/);
  session.dispatch(callbackUpdate(keyboard[1][0].callback_data));

  assert.deepEqual(await pending, { status: "answered", response: "No", kind: "choice", message_id: 101 });
  assert.deepEqual(last("editMessageText")!.params.reply_markup, { inline_keyboard: [] });
  assert.match(last("editMessageText")!.params.text, /✅ <b>No<\/b>/);
});

test("free-text reply is captured after the Reply button", async () => {
  const { session, calls, last } = fakeSession();
  const pending = ask(session, 7, { project: "Telex", message: "Name?", expectText: true, timeoutSeconds: 5 });
  await tick();

  session.dispatch(callbackUpdate(calls[0].params.reply_markup.inline_keyboard[0][0].callback_data));
  await tick();
  assert.equal(last("sendMessage")!.params.reply_markup.force_reply, true);

  session.dispatch({ update_id: 2, message: { message_id: 9, chat: { id: 7 }, text: "telex" } });
  assert.deepEqual(await pending, { status: "answered", response: "telex", kind: "text", message_id: 101 });
  assert.equal(last("deleteMessage")!.params.message_id, 102);
});

test("no answer before the deadline marks the message stale", async () => {
  const { session, last } = fakeSession();
  const result = await ask(session, 7, { project: "Telex", message: "Deploy?", options: ["Yes"], timeoutSeconds: 0.05 as number });
  assert.deepEqual(result, { status: "timeout", message_id: 101 });
  assert.match(last("editMessageText")!.params.text, /stale/);
  assert.deepEqual(last("editMessageText")!.params.reply_markup, { inline_keyboard: [] });
});

test("HTML is escaped in the project heading", async () => {
  const { session, calls } = fakeSession();
  await ask(session, 7, { project: "a<b>&c", message: "hi", timeoutSeconds: 5 });
  assert.match(calls[0].params.text, /^<b>a&lt;b&gt;&amp;c<\/b>/);
});
