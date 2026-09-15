#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, pickBot, type Bot } from "./config.ts";
import { sessionFor, type BotSession } from "./telegram.ts";
import { ask, receipt, markExpired, heartbeat, deliver } from "./ask.ts";

const config = loadConfig();
const botNames = Object.keys(config.bots);
// A project pins its bot with TELEX_BOT in the MCP registration; the agent can still override per call.
const defaultBot = process.env.TELEX_BOT || config.defaultBot!;

/** Listen to a bot's chat for messages nobody asked for, and acknowledge each one to the user. */
function watch(bot: Bot): BotSession {
  const session = sessionFor(bot.token);
  session.watch(bot.chatId, {
    allowFrom: bot.allowFrom,
    onQueued: (message) => void receipt(session, bot.chatId, message),
    onExpired: (messages) => markExpired(session, bot.chatId, messages),
  });
  return session;
}

const server = new McpServer({ name: "telex", version: "0.1.0" });
/** Heartbeats a message may sit through before telex gives up on the agent's behalf. */
const MISSED_BEATS = 3;

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

server.registerTool(
  "send_to_user",
  {
    title: "Message the user on Telegram",
    description: [
      "Send a message to the user via Telegram and optionally wait for their answer.",
      "Use it to ask for a decision, get missing information, or report that long-running work finished.",
      "",
      `Formatting: 'message' is rendered with Telegram's HTML subset — <b>, <i>, <u>, <s>, <code>, <pre>, <a href="">, <blockquote>.`,
      "Escape any literal &, < and > as &amp; &lt; &gt;. Markdown is NOT rendered.",
      "",
      "Pass 'options' for a multiple-choice question (buttons), or 'expect_text' for a free-text answer.",
      "With neither, the message is a one-way notification and returns immediately.",
      "",
      `If the user does not answer within 'timeout_seconds' the result is {"status":"timeout"}, the buttons`,
      "are removed and the message is marked stale. That means the user is unavailable — decide for yourself",
      "whether to continue, retry or stop.",
      "",
      "If the user messaged the bot while you were not asking anything, the result also carries a 'pending'",
      "array of what they said, delivered the same way a heartbeat would. Read it before you carry on.",
      `Bots: ${botNames.join(", ")} (default for this project: ${defaultBot}).`,
    ].join("\n"),
    inputSchema: {
      project: z.string().min(1).describe("Project or task name, shown as the message heading."),
      message: z.string().min(1).describe("The copy to show the user, in Telegram HTML."),
      options: z.array(z.string().min(1)).min(1).max(10).optional()
        .describe("Single-choice answers, rendered as buttons. Mutually exclusive with expect_text."),
      expect_text: z.boolean().optional()
        .describe("Show a Reply button; the user's next message is returned as the answer."),
      timeout_seconds: z.number().int().min(5).max(86400).default(300)
        .describe("How long to wait for an answer before giving up."),
      bot: z.enum(botNames as [string, ...string[]]).optional()
        .describe(`Which configured bot to send through. Defaults to "${defaultBot}".`),
    },
  },
  async ({ project, message, options, expect_text, timeout_seconds, bot }) => {
    const { bot: target } = pickBot(config, bot);
    const session = sessionFor(target.token);
    const result = await ask(session, target.chatId, {
      project,
      message,
      options,
      expectText: expect_text,
      timeoutSeconds: timeout_seconds,
      allowFrom: target.allowFrom,
    });
    const pending = deliver(watch(target), target.chatId);
    return json(pending.length ? { ...result, pending } : result);
  },
);

server.registerTool(
  "heartbeat",
  {
    title: "Check in and collect anything the user said",
    description: [
      "Call this on a fixed interval for the whole time you are working, and pass that interval as",
      "'interval_seconds'. It returns immediately with whatever the user has messaged the bot since",
      "your last check-in — it never blocks and never waits for them.",
      "",
      "Two jobs in one call. It delivers unprompted messages, and it is your liveness signal: the",
      "user sees each of their messages marked as held, then delivered once a heartbeat collects it.",
      `Miss ${MISSED_BEATS} intervals in a row and anything waiting is marked expired and dropped, which is how`,
      "the user learns you were not listening rather than being ignored in silence.",
      "",
      `The result is {"messages":[...],"interval_seconds":n}. An empty array means nothing was said —`,
      "that is the normal case, keep working and check in again next interval.",
      `Bots: ${botNames.join(", ")} (default for this project: ${defaultBot}).`,
    ].join("\n"),
    inputSchema: {
      interval_seconds: z.number().int().min(10).max(3600).default(60)
        .describe("How often you intend to check in. Messages expire after " + MISSED_BEATS + " missed intervals."),
      bot: z.enum(botNames as [string, ...string[]]).optional()
        .describe(`Which configured bot to listen on. Defaults to "${defaultBot}".`),
    },
  },
  async ({ interval_seconds, bot }) => {
    const { bot: target } = pickBot(config, bot);
    const messages = heartbeat(watch(target), target.chatId, interval_seconds, MISSED_BEATS);
    return json({ messages, interval_seconds });
  },
);

watch(pickBot(config).bot);

const transport = new StdioServerTransport();
// Polling now outlives any single request, so the process has to be told when the agent is gone.
transport.onclose = () => process.exit(0);
await server.connect(transport);
