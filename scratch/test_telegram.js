const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const apiId = parseInt(process.env.TELEGRAM_API_ID, 10);
const apiHash = process.env.TELEGRAM_API_HASH;
const stringSession = new StringSession(process.env.TELEGRAM_SESSION || '');
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

async function test() {
  const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
  await client.start({ botAuthToken: botToken });
  console.log('Bot logged in:', (await client.getMe()).username);

  // Send a test text message to verify permissions
  const sent = await client.sendMessage(chatId, { message: '🎬 Antigravity Stream: Testing GramJS connection...' });
  console.log('Message sent! ID:', sent.id);

  await client.disconnect();
}

test().catch(console.error);
