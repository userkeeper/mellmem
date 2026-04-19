// bot.js — Telegram-бот для запуска миниапа
import TelegramBot from 'node-telegram-bot-api';

const { BOT_TOKEN, MINIAPP_URL } = process.env;

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is required');
  process.exit(1);
}
if (!MINIAPP_URL) {
  console.error('MINIAPP_URL is required');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const welcomeText = `🎬 *MellMem* — футажи Мелстроя

Библиотека мем-футажей для твоих монтажей.

• 🔍 Поиск по тегам и категориям
• ⬇️ Скачивание в один тап
• 📤 Загрузка своих футажей
• ⭐ Рейтинг авторов

Жми кнопку ниже — откроется каталог.`;

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, welcomeText, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '📂 Открыть каталог', web_app: { url: MINIAPP_URL } }
      ], [
        { text: '📤 Загрузить', web_app: { url: MINIAPP_URL + '?tab=upload' } },
        { text: '⭐ Рейтинг', web_app: { url: MINIAPP_URL + '?tab=leaderboard' } }
      ]]
    }
  });
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    '*Команды:*\n' +
    '/start — открыть каталог\n' +
    '/random — случайный футаж\n' +
    '/top — топ авторов\n' +
    '/help — это сообщение', { parse_mode: 'Markdown' });
});

bot.onText(/\/random/, async (msg) => {
  try {
    const res = await fetch(`${MINIAPP_URL}/api/footage`);
    const items = await res.json();
    if (!items.length) return bot.sendMessage(msg.chat.id, 'Библиотека пока пуста');
    const pick = items[Math.floor(Math.random() * items.length)];
    const uploader = pick.uploader
      ? (pick.uploader.username ? '@' + pick.uploader.username : pick.uploader.name)
      : 'админ';
    await bot.sendVideo(msg.chat.id, pick.video_url, {
      caption: `🎬 *${pick.title}*\n✎ ${uploader}\n\n${(pick.tags || []).map(t => '#' + t).join(' ')}`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '📂 Открыть каталог', web_app: { url: MINIAPP_URL } }
        ]]
      }
    });
  } catch (e) {
    bot.sendMessage(msg.chat.id, 'Ошибка: ' + e.message);
  }
});

bot.onText(/\/top/, async (msg) => {
  try {
    const res = await fetch(`${MINIAPP_URL}/api/leaderboard`);
    const list = await res.json();
    if (!list.length) return bot.sendMessage(msg.chat.id, 'Рейтинг пока пуст');
    const text = '🏆 *Топ авторов:*\n\n' + list.slice(0, 10).map((u, i) => {
      const medal = ['🥇','🥈','🥉'][i] || `${i+1}.`;
      const name = u.username ? '@' + u.username : (u.first_name || 'anon');
      return `${medal} ${name} — ${u.uploads_count} футажей · ${u.total_downloads}↓`;
    }).join('\n');
    bot.sendMessage(msg.chat.id, text, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '📂 Открыть каталог', web_app: { url: MINIAPP_URL } }]]
      }
    });
  } catch (e) {
    bot.sendMessage(msg.chat.id, 'Ошибка: ' + e.message);
  }
});

bot.on('message', (msg) => {
  if (msg.text && !msg.text.startsWith('/')) {
    bot.sendMessage(msg.chat.id, 'Жми /start чтобы открыть каталог', {
      reply_markup: {
        inline_keyboard: [[
          { text: '📂 Открыть каталог', web_app: { url: MINIAPP_URL } }
        ]]
      }
    });
  }
});

console.log('🤖 Bot polling started');
console.log('   Mini app URL:', MINIAPP_URL);
