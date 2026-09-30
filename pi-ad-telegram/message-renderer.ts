import { DEFAULT_TELEGRAM_SETTINGS } from "./config.ts";

export const MAX_TELEGRAM_MESSAGE_LENGTH = DEFAULT_TELEGRAM_SETTINGS.messageChunkLimit;

export type TelegramTextFormat = "plain" | "markdown" | "html";

export interface TelegramMessageSpec {
  text: string;
  format?: TelegramTextFormat;
  replyToMessageId?: number;
  replyMarkup?: Record<string, unknown>;
  disableWebPagePreview?: boolean;
}

export interface TelegramSentMessage {
  message_id: number;
}

export type TelegramRequester = <T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<T>;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlAttribute(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function markdownToTelegramHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const rendered: string[] = [];
  let codeLines: string[] | undefined;
  let codeLanguage = "";

  const renderInline = (source: string): string => {
    const protectedHtml: string[] = [];
    const protect = (html: string) => `\u0000${protectedHtml.push(html) - 1}\u0000`;
    let text = source.replace(/`([^`\n]+)`/g, (_match, code: string) => protect(`<code>${escapeHtml(code)}</code>`));
    text = escapeHtml(text);
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label: string, url: string) =>
      protect(`<a href="${escapeHtmlAttribute(url)}">${label}</a>`),
    );
    text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/__(.+?)__/g, "<b>$1</b>");
    text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<i>$1</i>");
    text = text.replace(/(?<![\w])_([^_\n]+)_(?![\w])/g, "<i>$1</i>");
    return text.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => protectedHtml[Number(index)]);
  };

  for (const line of lines) {
    const fence = /^\s*```/.exec(line);
    if (fence) {
      if (codeLines) {
        const language = /^[\w+-]+$/.test(codeLanguage) ? ` class="language-${codeLanguage}"` : "";
        rendered.push(`<pre><code${language}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        codeLines = undefined;
        codeLanguage = "";
      } else {
        codeLines = [];
        codeLanguage = line.slice(fence[0].length).trim().split(/\s+/, 1)[0] ?? "";
      }
      continue;
    }
    if (codeLines) {
      codeLines.push(line);
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    const listItem = /^\s{0,3}[-*+]\s+(.*)$/.exec(line);
    if (heading) rendered.push(`<b>${renderInline(heading[1])}</b>`);
    else if (listItem) rendered.push(`• ${renderInline(listItem[1])}`);
    else rendered.push(renderInline(line));
  }
  if (codeLines) {
    const language = /^[\w+-]+$/.test(codeLanguage) ? ` class="language-${codeLanguage}"` : "";
    rendered.push(`<pre><code${language}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
  }
  return rendered.join("\n");
}

function splitPlainText(text: string, maxLength: number): string[] {
  let rest = text || "(empty response)";
  const parts: string[] = [];
  while (rest.length > 0) {
    let end = Math.min(rest.length, maxLength);
    if (end < rest.length) {
      const newline = rest.lastIndexOf("\n", end - 1);
      if (newline > maxLength / 2) end = newline + 1;
      const before = rest.charCodeAt(end - 1);
      const after = rest.charCodeAt(end);
      if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end--;
    }
    parts.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  return parts;
}

function splitHtml(text: string, maxLength: number): string[] {
  const tokens = text.match(/<[^>]*>|&(?:#[0-9]+|#x[0-9a-f]+|[a-z]+);|[\s\S]/giu) ?? [];
  const stack: Array<{ name: string; open: string; close: string }> = [];
  const chunks: string[] = [];
  let current = "";
  const openTags = () => stack.map((tag) => tag.open).join("");
  const closeTags = () => [...stack].reverse().map((tag) => tag.close).join("");

  for (const token of tokens) {
    const prefix = openTags();
    if (current.length > prefix.length && current.length + token.length + closeTags().length > maxLength) {
      chunks.push(current + closeTags());
      current = prefix;
    }
    current += token;
    const closing = /^<\/([a-z][\w-]*)\s*>$/i.exec(token);
    if (closing) {
      const index = stack.map((tag) => tag.name).lastIndexOf(closing[1].toLowerCase());
      if (index >= 0) stack.splice(index, 1);
    } else {
      const opening = /^<([a-z][\w-]*)(?:\s[^>]*)?>$/i.exec(token);
      if (opening && !/\/>$/.test(token)) {
        const name = opening[1].toLowerCase();
        stack.push({ name, open: token, close: `</${name}>` });
      }
    }
  }
  if (current || chunks.length === 0) chunks.push(current + closeTags());
  return chunks;
}

export interface RenderedTelegramPart {
  text: string;
  plainText: string;
}

function splitMarkdownText(text: string, maxLength: number): RenderedTelegramPart[] {
  let rest = text || "(empty response)";
  const parts: RenderedTelegramPart[] = [];
  while (rest.length > 0) {
    let low = 1;
    let high = Math.min(rest.length, maxLength);
    let end = 0;
    while (low <= high) {
      const candidateEnd = Math.floor((low + high) / 2);
      if (markdownToTelegramHtml(rest.slice(0, candidateEnd)).length <= maxLength) {
        end = candidateEnd;
        low = candidateEnd + 1;
      } else {
        high = candidateEnd - 1;
      }
    }
    if (end === 0) throw new RangeError("maxLength is too small for one rendered Markdown character");
    if (end < rest.length) {
      const newline = rest.lastIndexOf("\n", end - 1);
      if (newline > end / 2) end = newline + 1;
      const before = rest.charCodeAt(end - 1);
      const after = rest.charCodeAt(end);
      if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end--;
    }
    const plainText = rest.slice(0, end);
    parts.push({ text: markdownToTelegramHtml(plainText), plainText });
    rest = rest.slice(end);
  }
  return parts;
}

function htmlToPlainText(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

export function renderTelegramMessageParts(
  text: string,
  format: TelegramTextFormat = "plain",
  maxLength = MAX_TELEGRAM_MESSAGE_LENGTH,
): RenderedTelegramPart[] {
  if (format === "html") {
    return splitHtml(text || "(empty response)", maxLength).map((part) => ({ text: part, plainText: htmlToPlainText(part) }));
  }
  if (format === "markdown") return splitMarkdownText(text, maxLength);
  return splitPlainText(text, maxLength).map((part) => ({ text: part, plainText: part }));
}

export function renderTelegramMessage(
  text: string,
  format: TelegramTextFormat = "plain",
  maxLength = MAX_TELEGRAM_MESSAGE_LENGTH,
): string[] {
  return renderTelegramMessageParts(text, format, maxLength).map((part) => part.text);
}

function isTelegramFormattingError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = (error as { status?: unknown }).status;
  const message = error instanceof Error ? error.message : String(error);
  return status === 400 && /can't parse entities|can't find end of the entity|unsupported (?:start|end) tag|unexpected end tag|tag is not allowed/i.test(message);
}

function messageBody(
  chatId: number,
  message: TelegramMessageSpec,
  text: string,
  format: TelegramTextFormat,
  index: number,
  partCount: number,
): Record<string, unknown> {
  return {
    chat_id: chatId,
    text,
    ...(format === "markdown" || format === "html" ? { parse_mode: "HTML" } : {}),
    ...(message.disableWebPagePreview ? { disable_web_page_preview: true } : {}),
    ...(index === 0 && message.replyToMessageId !== undefined
      ? { reply_parameters: { message_id: message.replyToMessageId } }
      : {}),
    ...(index === partCount - 1 && message.replyMarkup ? { reply_markup: message.replyMarkup } : {}),
  };
}

export async function sendTelegramMessage(
  request: TelegramRequester,
  token: string,
  chatId: number,
  message: TelegramMessageSpec,
  signal: AbortSignal,
  maxLength = MAX_TELEGRAM_MESSAGE_LENGTH,
): Promise<number[]> {
  const format = message.format ?? "plain";
  const parts = renderTelegramMessageParts(message.text, format, maxLength);
  const ids: number[] = [];
  for (const [index, part] of parts.entries()) {
    let sent: TelegramSentMessage;
    try {
      sent = await request<TelegramSentMessage>(token, "sendMessage", messageBody(chatId, message, part.text, format, index, parts.length), signal);
    } catch (error) {
      if (signal.aborted || format === "plain" || !isTelegramFormattingError(error)) throw error;
      sent = await request<TelegramSentMessage>(token, "sendMessage", messageBody(chatId, message, part.plainText, "plain", index, parts.length), signal);
    }
    ids.push(sent.message_id);
  }
  return ids;
}

export async function editTelegramMessage(
  request: TelegramRequester,
  token: string,
  chatId: number,
  messageId: number,
  message: TelegramMessageSpec,
  signal: AbortSignal,
  maxLength = MAX_TELEGRAM_MESSAGE_LENGTH,
): Promise<void> {
  const format = message.format ?? "plain";
  const parts = renderTelegramMessageParts(message.text, format, maxLength);
  if (parts.length !== 1) throw new Error("An edited Telegram message must render to exactly one message part");
  const body = (text: string, currentFormat: TelegramTextFormat): Record<string, unknown> => ({
    chat_id: chatId,
    message_id: messageId,
    text,
    ...(currentFormat === "markdown" || currentFormat === "html" ? { parse_mode: "HTML" } : {}),
    ...(message.disableWebPagePreview ? { disable_web_page_preview: true } : {}),
    ...(message.replyMarkup ? { reply_markup: message.replyMarkup } : {}),
  });
  try {
    await request<unknown>(token, "editMessageText", body(parts[0].text, format), signal);
  } catch (error) {
    if (signal.aborted || format === "plain" || !isTelegramFormattingError(error)) throw error;
    await request<unknown>(token, "editMessageText", body(parts[0].plainText, "plain"), signal);
  }
}
