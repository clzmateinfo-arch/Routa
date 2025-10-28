require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

console.log('Send a message to your bot now — this will print the chat id and exit.');
bot.on('message', (msg) => {
  console.log('CHAT ID:', msg.chat.id, 'TYPE:', msg.chat.type, 'FROM:', msg.from.username || msg.from.first_name);
  process.exit(0);
});
