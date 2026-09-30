const TELEGRAM_SLASH_COMMAND = /^\/[A-Za-z][A-Za-z0-9_-]{0,31}(?:@[A-Za-z0-9_]{5,32})?(?:\s|$)/;

/** True when the whole incoming text is a Telegram slash command (with optional arguments). */
export function isTelegramSlashCommand(text: string): boolean {
  return TELEGRAM_SLASH_COMMAND.test(text.trim());
}
