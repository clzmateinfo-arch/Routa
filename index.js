// index.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN in .env');
  process.exit(1);
}
const PORT = process.env.PORT || 3000;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || null;
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN || 'CHANGE_ME';

const SUBSCRIBERS_FILE = path.join(__dirname, 'subscribers.json');
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const BUSES_FILE = path.join(__dirname, 'buses.json');
const BOOKINGS_FILE = path.join(__dirname, 'bookings.json');

const BROADCAST_BATCH_SIZE = parseInt(process.env.BROADCAST_BATCH_SIZE || '20', 10);
const BROADCAST_BATCH_DELAY_MS = parseInt(process.env.BROADCAST_BATCH_DELAY_MS || '1000', 10);

// --- simple file stores ---
function safeReadJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}
function safeWriteJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// subscribers store (same as before)
function loadStore() {
  return safeReadJSON(SUBSCRIBERS_FILE, { chats: [] });
}
function saveStore(s) {
  safeWriteJSON(SUBSCRIBERS_FILE, s);
}
const store = loadStore();

// sessions per-chat (multi-step conversation)
let sessions = safeReadJSON(SESSIONS_FILE, {}); // { chatId: { step, data } }
function saveSessions() { safeWriteJSON(SESSIONS_FILE, sessions); }

// buses and bookings
let buses = safeReadJSON(BUSES_FILE, []);
function saveBuses() { safeWriteJSON(BUSES_FILE, buses); }
let bookings = safeReadJSON(BOOKINGS_FILE, []);
function saveBookings() { safeWriteJSON(BOOKINGS_FILE, bookings); }

// polling bot
const pollingOptions = { interval: 1000, autoStart: true, params: { timeout: 30 } };
const bot = new TelegramBot(BOT_TOKEN, { polling: pollingOptions });

bot.on('polling_error', (err) => {
  console.error('Polling error', err.code || '', err.message || err);
});

// helper: add subscriber
function addSubscriber(chatId) {
  if (!store.chats.includes(chatId)) {
    store.chats.push(chatId);
    saveStore(store);
    console.log('Added subscriber', chatId);
  }
}

// util: parse "HH:MM" -> minutes
function timeToMinutes(t) {
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  let h = parseInt(m[1], 10), mm = parseInt(m[2], 10);
  return h * 60 + mm;
}
function minutesToTime(m) {
  const h = Math.floor(m / 60).toString().padStart(2, '0');
  const mm = (m % 60).toString().padStart(2, '0');
  return `${h}:${mm}`;
}

// find matching buses
function findBuses({ start, end, time, pax, needBoth }) {
  const requested = timeToMinutes(time);
  const timeWindow = 30; // minutes tolerance each side
  const matches = [];

  for (const bus of buses) {
    // capacity check
    if (bus.capacity < pax) continue;
    // service check
    if (needBoth && bus.service !== 'both') continue; // user required both up&down service
    // start/end existence & order
    const idxStart = bus.route.findIndex(r => r.toLowerCase() === start.toLowerCase());
    const idxEnd = bus.route.findIndex(r => r.toLowerCase() === end.toLowerCase());
    if (idxStart === -1 || idxEnd === -1) continue;
    // ensure direction: for 'up' routes usually start->...->school, for 'down' maybe inverse.
    // Simple rule: start index < end index means direction matches
    if (!(idxStart < idxEnd)) continue;

    // time matching
    let timeMatch = false;
    for (const t of bus.times) {
      const tm = timeToMinutes(t);
      if (tm === null) continue;
      if (Math.abs(tm - requested) <= timeWindow) {
        timeMatch = true;
        break;
      }
    }
    if (!timeMatch) continue;

    matches.push(bus);
  }

  return matches;
}

// reset session
function clearSession(chatId) {
  delete sessions[chatId];
  saveSessions();
}

// format a bus option text
function formatBusOption(bus) {
  return `${bus.name}\nRoute: ${bus.route.join(' → ')}\nTimes: ${bus.times.join(', ')}\nCapacity left: ${bus.capacity}\nDriver: ${bus.driver.name} (${bus.driver.phone})`;
}

// handle callback queries (user pressed an inline button)
bot.on('callback_query', async (cq) => {
  try {
    const chatId = cq.message.chat.id;
    const data = cq.data || '';
    // selection payloads:
    // select:<busId>  -> user selects a bus option to confirm
    // confirm:<busId> -> user confirms booking
    // cancel         -> user cancels flow
    if (data === 'cancel') {
      clearSession(chatId);
      await bot.answerCallbackQuery(cq.id, { text: 'Cancelled.' });
      await bot.sendMessage(chatId, 'Booking cancelled. Type "ser" to start again.');
      return;
    }

    if (data.startsWith('select:')) {
      const busId = data.split(':')[1];
      const session = sessions[chatId];
      if (!session || !session.data) {
        await bot.answerCallbackQuery(cq.id, { text: 'Session expired. Start again with "ser".' });
        return;
      }
      // prepare booking summary
      const bus = buses.find(b => b.id === busId);
      if (!bus) {
        await bot.answerCallbackQuery(cq.id, { text: 'Bus no longer available.' });
        return;
      }

      const { start, end, time, pax, needBoth } = session.data;
      const summary = [
        `You selected:`,
        `${formatBusOption(bus)}`,
        ``,
        `Passengers: ${pax}`,
        `Journey: ${start} → ${end}`,
        `Requested time: ${time}`,
        `Needs both up+down: ${needBoth ? 'Yes' : 'No'}`
      ].join('\n');

      // show confirm / cancel buttons
      const opts = {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Confirm booking', callback_data: `confirm:${bus.id}` }],
            [{ text: 'Cancel', callback_data: 'cancel' }]
          ]
        }
      };

      await bot.answerCallbackQuery(cq.id);
      await bot.sendMessage(chatId, summary, opts);
      return;
    }

    if (data.startsWith('confirm:')) {
      const busId = data.split(':')[1];
      const session = sessions[chatId];
      if (!session || !session.data) {
        await bot.answerCallbackQuery(cq.id, { text: 'Session expired. Start again with "ser".' });
        return;
      }
      const busIndex = buses.findIndex(b => b.id === busId);
      if (busIndex === -1) {
        await bot.answerCallbackQuery(cq.id, { text: 'Selected bus not found.' });
        return;
      }
      const bus = buses[busIndex];
      const { start, end, time, pax, needBoth, userName } = session.data;

      // final capacity check
      if (bus.capacity < pax) {
        await bot.answerCallbackQuery(cq.id, { text: 'Not enough seats available.' });
        await bot.sendMessage(chatId, 'Sorry — that bus no longer has enough seats. Try another option.');
        return;
      }

      // create booking
      const booking = {
        id: `bk-${Date.now()}`,
        chatId,
        userName: userName || (session.user && session.user.username) || 'unknown',
        busId: bus.id,
        busName: bus.name,
        driver: bus.driver,
        start, end, time, pax, needBoth,
        createdAt: new Date().toISOString()
      };
      bookings.push(booking);
      saveBookings();

      // decrement capacity and persist
      buses[busIndex].capacity -= pax;
      saveBuses();

      clearSession(chatId);

      await bot.answerCallbackQuery(cq.id, { text: 'Booking confirmed.' });
      await bot.sendMessage(chatId, `✅ Booking confirmed!\nBooking ID: ${booking.id}\nDriver: ${booking.driver.name} (${booking.driver.phone})\nWe notified the admin.`);

      // notify admin if configured
      if (ADMIN_CHAT_ID) {
        const adminMsg = [
          `🚌 New booking: ${booking.id}`,
          `User: ${booking.userName} (chat ${booking.chatId})`,
          `Bus: ${booking.busName} (${booking.busId})`,
          `Driver: ${booking.driver.name} ${booking.driver.phone}`,
          `Route: ${booking.start} → ${booking.end}`,
          `Time: ${booking.time}`,
          `Pax: ${booking.pax}`,
          `Both up+down: ${booking.needBoth ? 'Yes' : 'No'}`,
          `Created: ${booking.createdAt}`
        ].join('\n');
        try { await bot.sendMessage(ADMIN_CHAT_ID, adminMsg); } catch (e) { console.warn('Failed to notify admin', e.message || e); }
      }

      return;
    }

    // fallback
    await bot.answerCallbackQuery(cq.id, { text: 'Unknown action' });
  } catch (err) {
    console.error('callback_query handler error', err);
  }
});

// main text message handler with multi-step flow
async function handleMessage(msg) {
  try {
    const chatId = msg.chat && msg.chat.id;
    if (!chatId) return;
    const text = (msg.text || '').trim();
    const lc = text.toLowerCase();

    // global cancel
    if (lc === 'cancel') {
      clearSession(chatId);
      await bot.sendMessage(chatId, 'Flow cancelled. Type "ser" to search for services.');
      return;
    }

    // basic commands
    if (text === '/start') {
      addSubscriber(chatId);
      await bot.sendMessage(chatId, `Welcome! You're now subscribed to Bus Fare messages service. Send "help" for commands.`);
      return;
    }
    if (lc === '/report' || lc.startsWith('/report ')) {
      const payload = `📣 Report from ${msg.from.username ? '@' + msg.from.username : (msg.from.first_name || 'user')} (id:${chatId}):\n${text.replace(/^\/report/i, '').trim() || '(no text)'}`;
      if (ADMIN_CHAT_ID) {
        await bot.sendMessage(ADMIN_CHAT_ID, payload);
        await bot.sendMessage(chatId, 'Thanks — your report was forwarded to the admins.');
      } else {
        await bot.sendMessage(chatId, 'Admin chat not configured.');
      }
      return;
    }
    if (/^help$/i.test(text)) {
      const reply = [
        'Commands:',
        '/start - subscribe',
        'help - show commands',
        'status - app status',
        'ser - find bus service and book',
        'cancel - cancel current flow',
        '/report <text> - send report to admins'
      ].join('\n');
      await bot.sendMessage(chatId, reply);
      return;
    }
    if (/^status$/i.test(text)) {
      await bot.sendMessage(chatId, 'All systems operational ✅');
      return;
    }

    // start booking flow
    const session = sessions[chatId] || { step: null, data: {}, user: { username: msg.from.username, first_name: msg.from.first_name } };

    // if user types 'ser' or 'search' start flow
    if (!session.step && (/^ser$/i.test(text) || /^search$/i.test(text) || /^book$/i.test(text))) {
      session.step = 'await_start';
      session.data = {};
      sessions[chatId] = session;
      saveSessions();
      await bot.sendMessage(chatId, 'Where is your START location? (Type street / stop name)');
      return;
    }

    // step-by-step
    if (session.step === 'await_start') {
      session.data.start = text;
      session.step = 'await_end';
      sessions[chatId] = session;
      saveSessions();
      await bot.sendMessage(chatId, 'Where is your END location? (Type street / stop name)');
      return;
    }

    if (session.step === 'await_end') {
      session.data.end = text;
      session.step = 'await_time';
      sessions[chatId] = session;
      saveSessions();
      await bot.sendMessage(chatId, 'At what time do you need the bus? (HH:MM, 24h — e.g. 07:30)');
      return;
    }

    if (session.step === 'await_time') {
      // basic validation
      if (!/^\d{1,2}:\d{2}$/.test(text)) {
        await bot.sendMessage(chatId, 'Please provide time in HH:MM format (e.g. 07:30).');
        return;
      }
      session.data.time = text;
      session.step = 'await_pax';
      sessions[chatId] = session;
      saveSessions();
      await bot.sendMessage(chatId, 'How many passengers (pax)? Enter a number.');
      return;
    }

    if (session.step === 'await_pax') {
      const n = parseInt(text.replace(/\D/g, ''), 10);
      if (!n || n <= 0) {
        await bot.sendMessage(chatId, 'Please provide a valid number of passengers (e.g. 2).');
        return;
      }
      session.data.pax = n;
      session.step = 'await_both';
      sessions[chatId] = session;
      saveSessions();
      await bot.sendMessage(chatId, 'Do you need both up and down services? (yes/no)');
      return;
    }

    if (session.step === 'await_both') {
      const yes = /^(y|yes)$/i.test(text);
      const no = /^(n|no)$/i.test(text);
      if (!yes && !no) {
        await bot.sendMessage(chatId, 'Reply "yes" or "no".');
        return;
      }
      session.data.needBoth = yes;
      session.data.userName = msg.from.username || msg.from.first_name || 'user';
      // now compute matches
      sessions[chatId] = session;
      saveSessions();

      await bot.sendMessage(chatId, 'Searching for matching buses…');

      const matches = findBuses(session.data);
      if (!matches.length) {
        clearSession(chatId);
        await bot.sendMessage(chatId, 'No matching buses found for your request. You can try changing time, route or pax. Type "ser" to start again.');
        return;
      }

      // build inline keyboard with options
      const keyboard = matches.map(bus => ([{
        text: `${bus.name} — driver ${bus.driver.name} (${bus.driver.phone}) — seats ${bus.capacity}`,
        callback_data: `select:${bus.id}`
      }]));
      // add cancel button
      keyboard.push([{ text: 'Cancel', callback_data: 'cancel' }]);

      await bot.sendMessage(chatId, `Found ${matches.length} option(s). Please choose one:`, {
        reply_markup: { inline_keyboard: keyboard }
      });
      return;
    }

    // fallback default text outside of flow
    await bot.sendMessage(chatId, `Sorry, I didn't understand that. Type "help" to see options, or "ser" to search for a bus.`);
  } catch (err) {
    console.error('handleMessage error', err);
  }
}

// wire bot message event
bot.on('message', (msg) => {
  handleMessage(msg).catch(err => console.error(err));
});

// --- admin REST endpoints (keep existing /send plus a couple bus management helpers) ---
const app = express();
app.use(bodyParser.json());

app.post('/send', async (req, res) => {
  const token = req.headers['x-admin-token'] || req.body.adminToken;
  if (token !== ADMIN_API_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  const { chatId, text, broadcast } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });
  try {
    if (broadcast) {
      const results = [];
      const targets = Array.from(new Set(store.chats));
      for (let i = 0; i < targets.length; i += BROADCAST_BATCH_SIZE) {
        const batch = targets.slice(i, i + BROADCAST_BATCH_SIZE);
        const batchPromises = batch.map(id =>
          bot.sendMessage(id, text).then(() => ({ id, status: 'ok' })).catch(err => ({ id, status: 'error', message: err.message || String(err) }))
        );
        const chunkResults = await Promise.all(batchPromises);
        results.push(...chunkResults);
        if (i + BROADCAST_BATCH_SIZE < targets.length) {
          await new Promise(r => setTimeout(r, BROADCAST_BATCH_DELAY_MS));
        }
      }
      return res.json({ broadcast: true, results });
    } else {
      if (!chatId) return res.status(400).json({ error: 'chatId required when broadcast is false' });
      await bot.sendMessage(chatId, text);
      return res.json({ ok: true });
    }
  } catch (err) {
    console.error('send endpoint error', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
});

// simple admin bus CRUD helpers (protected)
app.get('/admin/buses', (req, res) => {
  const token = req.headers['x-admin-token'] || req.query.adminToken;
  if (token !== ADMIN_API_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  return res.json({ buses });
});
app.post('/admin/buses', (req, res) => {
  const token = req.headers['x-admin-token'] || req.query.adminToken;
  if (token !== ADMIN_API_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  const b = req.body;
  if (!b || !b.id) return res.status(400).json({ error: 'bus object with id required' });
  buses.push(b);
  saveBuses();
  return res.json({ ok: true, bus: b });
});

app.get('/health', (req, res) => res.json({ ok: true }));

const server = app.listen(PORT, () => {
  console.log(`Admin API listening on port ${PORT}`);
  console.log('Bot started in long-polling mode.');
});

// graceful shutdown
async function shutdown() {
  console.log('Shutting down...');
  server.close(() => console.log('HTTP server closed'));
  try { await bot.stopPolling(); console.log('Bot polling stopped'); } catch (e) { console.warn('Error stopping polling', e); }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
