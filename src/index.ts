#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, pickBot } from "./config.ts";
import { sessionFor } from "./telegram.ts";
import { ask } from "./ask.ts";

const config = loadConfig();
const botNames = Object.keys(config.bots);
// A project pins its bot with TELEX_BOT in the MCP registration; the agent can still override per call.
const defaultBot = process.env.TELEX_BOT || config.defaultBot!;

const server = new McpServer({ name: "telex", version: "0.1.0" });

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
    const result = await ask(sessionFor(target.token), target.chatId, {
      project,
      message,
      options,
      expectText: expect_text,
      timeoutSeconds: timeout_seconds,
      allowFrom: target.allowFrom,
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  },
);

await server.connect(new StdioServerTransport());
