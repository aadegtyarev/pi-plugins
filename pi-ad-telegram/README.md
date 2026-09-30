# pi-ad-telegram

A Pi extension that connects one running Pi session to a private Telegram bot using long polling. It needs no public URL or webhook.

## Install and start

Install the repository package once from the [root instructions](../README.md). If a standalone copy of this extension is already configured, resolve that duplicate before installing the package; do not delete an unknown extension path.

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Find your numeric Telegram user ID. Only IDs in the allow-list and private chats are accepted.
3. Start Pi with the credentials and opt-in flag:

   ```sh
   export PI_TELEGRAM_BOT_TOKEN='token-from-BotFather'
   export PI_TELEGRAM_ALLOWED_USER_IDS='123456789'
   pi --telegram
   ```

   Alternatively, set `PI_TELEGRAM_ENABLED=1`. The extension is off by default; `/telegram on` enables it in the current session.
4. Open a private chat with the bot, send `/start`, then send a task.

Keep the bot token secret. Every allowed Telegram user can issue commands with the Pi process's permissions. In particular, `/bash` runs arbitrary shell commands in the current project.

## Documentation

- [Bot and Pi commands](commands.md)
- [Settings and environment variables](configuration.md)
- [Queues, offline messages, attachments, and delivery](operations.md)
- [Telegram surface contract](../docs/contracts/surfaces/pi-ad-telegram.md)
