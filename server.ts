import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const GAMES_FILE = path.join(DATA_DIR, 'games.json');
const VOTES_FILE = path.join(DATA_DIR, 'votes.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// Helper to hash password
function hashPassword(salt: string, pass: string): string {
  return crypto.createHash('sha256').update(salt + pass).digest('hex');
}

// Load or initialize config
function getConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    } catch (e) {
      console.error(e);
    }
  }
  return null;
}

function saveConfig(data: any) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// Load or initialize games
function getGames(): any[] {
  if (fs.existsSync(GAMES_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(GAMES_FILE, 'utf-8'));
    } catch (e) {
      console.error(e);
    }
  }
  return [];
}

let lastUpdated = Date.now();
let votesVersion = Date.now();

function saveGames(games: any[]) {
  fs.writeFileSync(GAMES_FILE, JSON.stringify(games, null, 2), 'utf-8');
  lastUpdated = Date.now();
  notifyClients('games', { games, lastUpdated });
}

// Load or initialize votes
function getVotes(): Record<string, { v: string[]; t: number; name?: string }> {
  if (fs.existsSync(VOTES_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(VOTES_FILE, 'utf-8'));
    } catch (e) {
      console.error(e);
    }
  }
  return {};
}

function saveVotes(votes: any) {
  fs.writeFileSync(VOTES_FILE, JSON.stringify(votes, null, 2), 'utf-8');
  votesVersion = Date.now();
  notifyClients('votes', formatVotes(votes));
}

function formatVotes(rawVotes: Record<string, { v: string[]; t: number; name?: string }>) {
  const votesSummary: Record<string, { n: number; uids: string[]; names: string[] }> = {};
  let totalVoters = 0;
  
  for (const [uid, userVote] of Object.entries(rawVotes)) {
    const list = userVote.v || [];
    if (list.length > 0) totalVoters++;
    for (const gameId of list) {
      if (!votesSummary[gameId]) {
        votesSummary[gameId] = { n: 0, uids: [], names: [] };
      }
      votesSummary[gameId].n++;
      votesSummary[gameId].uids.push(uid);
      if (userVote.name) {
        votesSummary[gameId].names.push(userVote.name);
      }
    }
  }
  return { summary: votesSummary, totalVoters };
}

// SSE clients
type Client = { id: number; res: express.Response };
let clients: Client[] = [];

function notifyClients(type: string, data: any) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(c => c.res.write(payload));
}

const app = express();
app.use(express.json({ limit: '50mb' }));

// Version check endpoint for ultra-lightweight instant background sync
app.get('/api/version', (req, res) => {
  res.json({ lastUpdated, votesVersion });
});

// SSE endpoint for instant real-time synchronization
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const clientId = Date.now() + Math.random();
  clients.push({ id: clientId, res });

  // Send initial data
  res.write(`event: games\ndata: ${JSON.stringify({ games: getGames(), lastUpdated })}\n\n`);
  res.write(`event: votes\ndata: ${JSON.stringify(formatVotes(getVotes()))}\n\n`);

  req.on('close', () => {
    clients = clients.filter(c => c.id !== clientId);
  });
});

// Heartbeat ping to keep SSE connection alive through Cloud Run & proxies
setInterval(() => {
  clients.forEach(c => {
    try {
      c.res.write(': ping\n\n');
    } catch (e) {}
  });
}, 15000);

// Games API
app.get('/api/games', (req, res) => {
  res.json({ games: getGames(), lastUpdated });
});

app.post('/api/games', (req, res) => {
  const newGame = req.body;
  if (!newGame.id) {
    newGame.id = 'g_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  const games = getGames();
  const existingIdx = games.findIndex(g => g.id === newGame.id);
  if (existingIdx >= 0) {
    games[existingIdx] = { ...games[existingIdx], ...newGame };
  } else {
    games.push(newGame);
  }
  saveGames(games);
  res.json({ success: true, game: newGame });
});

app.put('/api/games/:id', (req, res) => {
  const id = req.params.id;
  const updates = req.body;
  const games = getGames();
  const idx = games.findIndex(g => g.id === id);
  if (idx >= 0) {
    games[idx] = { ...games[idx], ...updates, id };
    saveGames(games);
    res.json({ success: true, game: games[idx] });
  } else {
    res.status(404).json({ error: 'Game not found' });
  }
});

app.delete('/api/games/:id', (req, res) => {
  const id = req.params.id;
  let games = getGames();
  games = games.filter(g => g.id !== id);
  saveGames(games);
  res.json({ success: true });
});

app.post('/api/games/seed', (req, res) => {
  const defaultList = req.body.games;
  if (Array.isArray(defaultList)) {
    saveGames(defaultList);
    res.json({ success: true, count: defaultList.length });
  } else {
    res.status(400).json({ error: 'Invalid games array' });
  }
});

// Votes API
app.get('/api/votes', (req, res) => {
  res.json(formatVotes(getVotes()));
});

app.post('/api/votes', (req, res) => {
  const { uid, v, name } = req.body;
  if (!uid) return res.status(400).json({ error: 'Missing uid' });
  const votes = getVotes();
  votes[uid] = { v: Array.isArray(v) ? v : [], t: Date.now(), name: name || '' };
  saveVotes(votes);
  res.json({ success: true });
});

app.post('/api/votes/reset', (req, res) => {
  saveVotes({});
  res.json({ success: true });
});

// Admin Auth API
app.get('/api/admin/status', (req, res) => {
  const cfg = getConfig();
  res.json({ hasPassword: !!cfg });
});

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  const cfg = getConfig();
  if (!cfg) {
    // If no password set yet, any password of >= 4 chars sets it!
    if (!password || password.length < 4) {
      return res.status(400).json({ error: 'الرمز قصير جداً' });
    }
    const salt = crypto.randomBytes(8).toString('hex');
    const hash = hashPassword(salt, password);
    saveConfig({ salt, hash });
    return res.json({ success: true, initialized: true });
  }
  const calcHash = hashPassword(cfg.salt, password);
  if (calcHash === cfg.hash) {
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'الرمز غير صحيح' });
  }
});

app.post('/api/admin/set-password', (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 4) {
    return res.status(400).json({ error: 'الرمز قصير جداً' });
  }
  const salt = crypto.randomBytes(8).toString('hex');
  const hash = hashPassword(salt, password);
  saveConfig({ salt, hash });
  res.json({ success: true });
});

// Setup Vite or static serving
const port = Number(process.env.PORT) || 3000;

async function start() {
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`Server running on port ${port}`);
  });
}

start();
