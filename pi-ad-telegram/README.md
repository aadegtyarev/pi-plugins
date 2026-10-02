# pi-ad-telegram

Connect one running Pi session to a private Telegram bot with long polling. No public URL or webhook is needed.

## Connect the bot

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Find your numeric Telegram user ID. Only allow-listed users in private chats can use the bot.
3. Start Pi with the token, allow-list, and opt-in flag:

   ```sh
   export PI_TELEGRAM_BOT_TOKEN='token-from-BotFather'
   export PI_TELEGRAM_ALLOWED_USER_IDS='123456789'
   pi --telegram
   ```

   `PI_TELEGRAM_ENABLED=1` is an equivalent opt-in. Without either setting, the bridge is off; `/telegram on` can enable it for the current session.
4. Open a private chat, send `/start`, then send a task.

Keep the token secret. Every allowed user can issue commands with the Pi process's permissions; in particular, `/bash` runs shell commands in the project.

## Find a command or setting

- [Bot and Pi commands](commands.md)
- [Credentials and optional settings](configuration.md)
- [Input, offline messages, attachments, and delivery](operations.md)
- [Telegram guarantees and limits](../docs/contracts/surfaces/pi-ad-telegram.md)
