import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import QRCode from 'qrcode';
import { generateQuestions, regenerateOne } from './lib/generate.js';
import { track, summary } from './lib/analytics.js';
import { FREE_PLAYER_LIMIT, MAX_PLAYERS, QUESTION_SECONDS } from './public/shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'letmein';
const GAME_TTL_MS = 12 * 60 * 60 * 1000;
const REVEAL_AUTO_ADVANCE = false; // host taps "Next" so the room can laugh at the answer

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 20000 });

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

/** @type {Map<string, any>} */
const games = new Map();

// ---------- helpers ----------
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion
function newCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  } while (games.has(code));
  return code;
}
const token = () => crypto.randomBytes(16).toString('hex');
const clip = (s, n) => String(s ?? '').slice(0, n);

function publicBase(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

function getGame(req, res) {
  const game = games.get(String(req.params.code).toUpperCase());
  if (!game) {
    res.status(404).json({ error: 'Game not found. It may have expired.' });
    return null;
  }
  return game;
}
function requireHost(game, req, res) {
  if ((req.get('x-host-token') || req.body?.hostToken) !== game.hostToken) {
    res.status(403).json({ error: 'Not the host of this game.' });
    return false;
  }
  return true;
}

function sanitizeInput(body) {
  return {
    honoree: clip(body.honoree, 40).trim() || 'The Guest of Honor',
    occasion: clip(body.occasion, 60).trim(),
    answers: (Array.isArray(body.answers) ? body.answers : []).slice(0, 20).map((a) => ({ id: clip(a.id, 30), answer: clip(a.answer, 300) })),
    stories: clip(body.stories, 4000),
    photos: (Array.isArray(body.photos) ? body.photos : []).slice(0, 8).map((p, i) => ({
      id: `p${i}`,
      kind: ['whose', 'where', 'what'].includes(p.kind) ? p.kind : 'whose',
      answer: clip(p.answer, 80).trim(),
      dataUrl: typeof p.dataUrl === 'string' && p.dataUrl.startsWith('data:image/') ? p.dataUrl : null,
    })).filter((p) => p.dataUrl && p.answer),
  };
}

function sanitizeQuestions(list, game) {
  return (Array.isArray(list) ? list : []).slice(0, 30).map((q, i) => {
    const options = (Array.isArray(q.options) ? q.options : []).map((o) => clip(o, 80).trim()).filter(Boolean).slice(0, 4);
    return {
      id: clip(q.id, 40) || `e${i}`,
      text: clip(q.text, 200).trim(),
      options,
      correct: Math.min(Math.max(0, Number(q.correct) || 0), Math.max(0, options.length - 1)),
      photoId: q.photoId && game.photos.has(q.photoId) ? q.photoId : null,
    };
  }).filter((q) => q.text && q.options.length >= 2);
}

// ---------- REST: setup + review ----------
app.post('/api/track', (req, res) => {
  const allowed = ['setup_started', 'review_opened', 'endscreen_view'];
  if (allowed.includes(req.body?.event)) track(req.body.event, { code: clip(req.body.code, 10) });
  res.json({ ok: true });
});

app.post('/api/games', async (req, res) => {
  const input = sanitizeInput(req.body || {});
  const filled = input.answers.filter((a) => a.answer.trim()).length;
  if (filled + input.photos.length < 3 && !input.stories.trim()) {
    return res.status(400).json({ error: 'Give us at least 3 answers or photos to work with.' });
  }
  const started = Date.now();
  const { questions, ai, error } = await generateQuestions(input);
  const code = newCode();
  const game = {
    code,
    hostToken: token(),
    createdAt: Date.now(),
    input: { ...input, photos: input.photos.map(({ dataUrl, ...p }) => p) },
    photos: new Map(input.photos.map((p) => [p.id, p.dataUrl])),
    questions,
    players: new Map(),
    state: 'draft', // draft → lobby → question → reveal → leaderboard → final
    qIndex: -1,
    qStartedAt: 0,
    answers: new Map(),
    timer: null,
    paywall: { shown: false, clicked: false, open: false },
  };
  games.set(code, game);
  track('game_created', { code, ai, questions: questions.length, photos: input.photos.length, ms: Date.now() - started, aiError: error });
  res.json({ code, hostToken: game.hostToken, questions, ai, photoIds: [...game.photos.keys()] });
});

app.get('/api/games/:code/draft', (req, res) => {
  const game = getGame(req, res);
  if (!game || !requireHost(game, req, res)) return;
  res.json({ code: game.code, honoree: game.input.honoree, occasion: game.input.occasion, questions: game.questions, state: game.state });
});

app.put('/api/games/:code/questions', (req, res) => {
  const game = getGame(req, res);
  if (!game || !requireHost(game, req, res)) return;
  if (game.state !== 'draft' && game.state !== 'lobby') return res.status(409).json({ error: 'Game already started.' });
  const qs = sanitizeQuestions(req.body.questions, game);
  if (!qs.length) return res.status(400).json({ error: 'Keep at least one question.' });
  game.questions = qs;
  res.json({ ok: true, count: qs.length });
});

app.post('/api/games/:code/regenerate', async (req, res) => {
  const game = getGame(req, res);
  if (!game || !requireHost(game, req, res)) return;
  const existing = sanitizeQuestions(req.body.questions, game);
  const q = await regenerateOne(game.input, existing.length ? existing : game.questions);
  if (!q) return res.status(500).json({ error: 'Could not write a new question. Try editing this one instead.' });
  res.json({ question: q });
});

app.get('/api/games/:code/photo/:id', (req, res) => {
  const game = getGame(req, res);
  if (!game) return;
  const dataUrl = game.photos.get(req.params.id);
  if (!dataUrl) return res.status(404).end();
  const [, mime, b64] = dataUrl.match(/^data:([^;]+);base64,(.*)$/) || [];
  if (!b64) return res.status(404).end();
  res.set('Content-Type', mime).set('Cache-Control', 'private, max-age=3600').send(Buffer.from(b64, 'base64'));
});

app.get('/api/games/:code/join-info', async (req, res) => {
  const game = getGame(req, res);
  if (!game) return;
  const url = `${publicBase(req)}/play?code=${game.code}`;
  const qr = await QRCode.toDataURL(url, { margin: 1, width: 600, color: { dark: '#1b1035', light: '#ffffff' } });
  res.json({ url, qr, host: publicBase(req).replace(/^https?:\/\//, '') });
});

// Tracked "make your own" link from the end screen.
app.get('/go', (req, res) => {
  track('cta_click', { src: clip(req.query.src, 20), code: clip(req.query.code, 10) });
  res.redirect('/?ref=' + encodeURIComponent(clip(req.query.src, 20) || 'end'));
});

app.get('/api/stats', (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'bad key' });
  res.json({ liveGames: games.size, ...summary() });
});

// ---------- Game engine ----------
const leaderboard = (game) =>
  [...game.players.values()].sort((a, b) => b.score - a.score).map((p, i) => ({ id: p.id, name: p.name, score: p.score, rank: i + 1, connected: p.connected }));

function currentQuestion(game) {
  return game.questions[game.qIndex];
}

function questionPayload(game, includeAnswer) {
  const q = currentQuestion(game);
  if (!q) return null;
  return {
    index: game.qIndex,
    total: game.questions.length,
    text: q.text,
    options: q.options,
    photoUrl: q.photoId ? `/api/games/${game.code}/photo/${q.photoId}` : null,
    endsAt: game.qStartedAt + QUESTION_SECONDS * 1000,
    seconds: QUESTION_SECONDS,
    ...(includeAnswer ? { correct: q.correct } : {}),
  };
}

function distribution(game) {
  const q = currentQuestion(game);
  const counts = new Array(q?.options.length || 4).fill(0);
  for (const a of game.answers.values()) counts[a.choice] = (counts[a.choice] || 0) + 1;
  return counts;
}

function hostView(game) {
  const reveal = ['reveal', 'leaderboard', 'final'].includes(game.state);
  return {
    role: 'host',
    code: game.code,
    honoree: game.input.honoree,
    occasion: game.input.occasion,
    state: game.state,
    players: leaderboard(game),
    playerCount: game.players.size,
    freeLimit: FREE_PLAYER_LIMIT,
    maxPlayers: MAX_PLAYERS,
    paywall: game.paywall,
    question: game.state === 'question' || game.state === 'reveal' ? questionPayload(game, reveal) : null,
    answeredCount: game.answers.size,
    distribution: game.state === 'reveal' ? distribution(game) : null,
    isLast: game.qIndex >= game.questions.length - 1,
    questionCount: game.questions.length,
  };
}

function playerView(game, player) {
  const board = leaderboard(game);
  const me = board.find((p) => p.id === player.id);
  const mine = game.answers.get(player.id);
  const q = currentQuestion(game);
  const view = {
    role: 'player',
    code: game.code,
    honoree: game.input.honoree,
    state: game.state,
    me: { id: player.id, name: player.name, score: player.score, rank: me?.rank, streak: player.streak },
    playerCount: game.players.size,
  };
  if (game.state === 'question') {
    view.question = questionPayload(game, false);
    view.answered = mine ? mine.choice : null;
  }
  if (game.state === 'reveal') {
    view.question = questionPayload(game, true);
    view.answered = mine ? mine.choice : null;
    view.result = player.lastResult;
  }
  if (game.state === 'final' || game.state === 'leaderboard') view.top = board.slice(0, 5);
  if (game.state === 'final') view.podium = board.slice(0, 3);
  void q;
  return view;
}

function broadcast(game) {
  io.to(`host:${game.code}`).emit('state', hostView(game));
  for (const p of game.players.values()) {
    if (p.socketId) io.to(p.socketId).emit('state', playerView(game, p));
  }
}

function startQuestion(game) {
  clearTimeout(game.timer);
  game.state = 'question';
  game.qStartedAt = Date.now();
  game.answers = new Map();
  for (const p of game.players.values()) p.lastResult = null;
  game.timer = setTimeout(() => revealAnswer(game), QUESTION_SECONDS * 1000 + 300);
  broadcast(game);
}

function revealAnswer(game) {
  if (game.state !== 'question') return;
  clearTimeout(game.timer);
  const q = currentQuestion(game);
  for (const p of game.players.values()) {
    const a = game.answers.get(p.id);
    if (a && a.choice === q.correct) {
      p.streak += 1;
      const speed = Math.max(0, 1 - a.ms / (QUESTION_SECONDS * 1000));
      const streakBonus = Math.min(300, 100 * (p.streak - 1));
      const points = Math.round(500 + 500 * speed) + streakBonus;
      p.score += points;
      p.lastResult = { correct: true, points, streakBonus };
    } else {
      p.streak = 0;
      p.lastResult = { correct: false, points: 0, missed: !a };
    }
  }
  game.state = 'reveal';
  broadcast(game);
  if (REVEAL_AUTO_ADVANCE) game.timer = setTimeout(() => advance(game), 6000);
}

function advance(game) {
  clearTimeout(game.timer);
  if (game.state === 'lobby') {
    game.qIndex = 0;
    track('game_started', { code: game.code, players: game.players.size, questions: game.questions.length });
    return startQuestion(game);
  }
  if (game.state === 'question') return revealAnswer(game);
  if (game.state === 'reveal') {
    if (game.qIndex >= game.questions.length - 1) {
      game.state = 'final';
      track('game_finished', { code: game.code, players: game.players.size });
      return broadcast(game);
    }
    game.state = 'leaderboard';
    return broadcast(game);
  }
  if (game.state === 'leaderboard') {
    game.qIndex += 1;
    return startQuestion(game);
  }
}

function uniqueName(game, name, exceptId) {
  const taken = new Set([...game.players.values()].filter((p) => p.id !== exceptId).map((p) => p.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name} ${i}`.toLowerCase())) return `${name} ${i}`;
}

io.on('connection', (socket) => {
  socket.on('host:join', ({ code, hostToken } = {}, ack) => {
    const game = games.get(String(code || '').toUpperCase());
    if (!game || game.hostToken !== hostToken) return ack?.({ error: 'Game not found or not yours.' });
    if (game.state === 'draft') game.state = 'lobby';
    socket.join(`host:${game.code}`);
    socket.data = { role: 'host', code: game.code };
    ack?.({ ok: true });
    broadcast(game);
  });

  socket.on('host:action', ({ action } = {}) => {
    const { role, code } = socket.data || {};
    const game = games.get(code);
    if (role !== 'host' || !game) return;
    if (action === 'next') advance(game);
    if (action === 'paywall_click') {
      game.paywall = { ...game.paywall, clicked: true, open: false };
      track('paywall_click', { code, players: game.players.size });
      broadcast(game);
    }
    if (action === 'paywall_dismiss') {
      game.paywall = { ...game.paywall, open: false };
      track('paywall_dismiss', { code, players: game.players.size });
      broadcast(game);
    }
    if (action === 'restart') {
      for (const p of game.players.values()) Object.assign(p, { score: 0, streak: 0, lastResult: null });
      game.qIndex = -1;
      game.state = 'lobby';
      broadcast(game);
    }
  });

  socket.on('host:kick', ({ playerId } = {}) => {
    const { role, code } = socket.data || {};
    const game = games.get(code);
    if (role !== 'host' || !game) return;
    const p = game.players.get(playerId);
    if (!p) return;
    game.players.delete(playerId);
    if (p.socketId) io.to(p.socketId).emit('kicked');
    broadcast(game);
  });

  socket.on('player:join', ({ code, name, playerId } = {}, ack) => {
    const game = games.get(String(code || '').toUpperCase());
    if (!game || game.state === 'draft') return ack?.({ error: "Hmm, we can't find that game. Check the code on the TV." });
    let player = playerId && game.players.get(playerId);
    if (player) {
      // Reconnect: same person, keep their score.
      player.socketId = socket.id;
      player.connected = true;
    } else {
      const clean = clip(name, 20).trim();
      if (!clean) return ack?.({ error: 'Pick a name first!' });
      if (game.players.size >= MAX_PLAYERS) return ack?.({ error: `This game is full (${MAX_PLAYERS} players max).` });
      player = { id: token(), name: uniqueName(game, clean), score: 0, streak: 0, socketId: socket.id, connected: true, lastResult: null };
      game.players.set(player.id, player);
      track('player_joined', { code: game.code, n: game.players.size });
      // Fake door: the 9th guest triggers the "Party Pass" upsell on the host screen.
      // Nobody is blocked; we only measure who'd pay.
      if (game.players.size > FREE_PLAYER_LIMIT && !game.paywall.shown) {
        game.paywall = { shown: true, clicked: false, open: true };
        track('paywall_shown', { code: game.code, players: game.players.size });
      }
    }
    socket.data = { role: 'player', code: game.code, playerId: player.id };
    socket.join(`players:${game.code}`);
    ack?.({ ok: true, playerId: player.id, name: player.name });
    broadcast(game);
  });

  socket.on('player:answer', ({ choice } = {}) => {
    const { role, code, playerId } = socket.data || {};
    const game = games.get(code);
    if (role !== 'player' || !game || game.state !== 'question') return;
    if (game.answers.has(playerId)) return; // first answer is final
    const q = currentQuestion(game);
    const c = Number(choice);
    if (!Number.isInteger(c) || c < 0 || c >= q.options.length) return;
    game.answers.set(playerId, { choice: c, ms: Date.now() - game.qStartedAt });
    const connected = [...game.players.values()].filter((p) => p.connected).length;
    if (game.answers.size >= connected) return revealAnswer(game);
    broadcast(game);
  });

  socket.on('disconnect', () => {
    const { role, code, playerId } = socket.data || {};
    const game = games.get(code);
    if (role !== 'player' || !game) return;
    const p = game.players.get(playerId);
    if (p && p.socketId === socket.id) {
      p.connected = false;
      p.socketId = null;
      broadcast(game);
    }
  });
});

// Games are ephemeral: sweep anything older than 12h.
setInterval(() => {
  const cutoff = Date.now() - GAME_TTL_MS;
  for (const [code, g] of games) if (g.createdAt < cutoff) {
    clearTimeout(g.timer);
    games.delete(code);
  }
}, 10 * 60 * 1000).unref();

app.get('/stats', (req, res) => res.sendFile(path.join(__dirname, 'public', 'stats.html')));

server.listen(PORT, () => {
  console.log(`QuizzlyPop running on http://localhost:${PORT}`);
  console.log(process.env.ANTHROPIC_API_KEY ? `AI questions: Claude (${process.env.CLAUDE_MODEL || 'claude-opus-5-5'})` : 'AI questions: OFF (no ANTHROPIC_API_KEY) — using templates');
});
