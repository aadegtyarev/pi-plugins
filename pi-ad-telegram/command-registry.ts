import { normalizeTelegramCommand } from "./commands.ts";

export type TelegramCommandHandler<TContext> = (context: TContext, args: string) => Promise<void>;

/** Routes canonical commands and aliases to registered behavior without coupling handlers to Telegram parsing. */
export class TelegramCommandRegistry<TContext> {
  private readonly handlers = new Map<string, TelegramCommandHandler<TContext>>();

  register(command: string, handler: TelegramCommandHandler<TContext>): void {
    const canonical = normalizeTelegramCommand(command) ?? command.toLowerCase();
    if (this.handlers.has(canonical)) throw new Error(`Telegram command handler already registered: ${canonical}`);
    this.handlers.set(canonical, handler);
  }

  async dispatch(command: string | undefined, args: string, context: TContext): Promise<boolean> {
    if (!command) return false;
    const canonical = normalizeTelegramCommand(command) ?? command.toLowerCase();
    const handler = this.handlers.get(canonical);
    if (!handler) return false;
    await handler(context, args);
    return true;
  }
}
