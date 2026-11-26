import 'dotenv/config';
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
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
const DEV_ADMIN_FILE = path.join(DATA_DIR, 'dev-admin.json');
const ANALYTICS_FILE = path.join(DATA_DIR, 'analytics.json');

const DEV_SESSION_SECRET = process.env.DEV_SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const revokedDevTokenIds = new Set<string>();
const devLoginRateMap = new Map<string, { count: number; resetAt: number }>();

function hashSecret(salt: string, secret: string): string {
  return crypto.createHash('sha256').update(salt + secret).digest('hex');
}

function normalizeGroupSlug(name: string): string {
  const norm = name.trim().replace(/\s+/g, ' ').toLowerCase();
  return crypto.createHash('sha256').update('coop-group-name:' + norm).digest('hex');
}

function sanitizeCode(raw: string): string {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 16);
}

function generateCode(existing: Record<string, any>): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 40; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[crypto.randomInt(0, chars.length)];
    }
    if (!existing[code]) return code;
  }
  return 'GRP' + Date.now().toString(36).toUpperCase().slice(-5);
}

type StoredVote = { v: string[]; t: number; name?: string };
type StoredGroup = {
  code: string;
  name: string;
  slug: string;
  adminName: string;
  adminPinSalt: string;
  adminPinHash: string;
  joinPassSalt?: string;
  joinPassHash?: string;
  createdAt: string;
  updatedAt?: string;
  lastUpdated: number;
  votesVersion: number;
  games: any[];
  votes: Record<string, StoredVote>;
};

function getGroupsStore(): Record<string, StoredGroup> {
  if (fs.existsSync(GROUPS_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf-8'));
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (e) {
      console.error(e);
    }
  }
  return {};
}

function saveGroupsStore(store: Record<string, StoredGroup>) {
  fs.writeFileSync(GROUPS_FILE, JSON.stringify(store, null, 2), 'utf-8');
}

type DevAdminConfig = {
  salt: string;
  hash: string;
  createdAt: string;
};

type VisitorStat = {
  firstSeen: string;
  lastSeen: string;
  visits: number;
  interacted: boolean;
  interactions: number;
};

type AnalyticsEventItem = {
  id: string;
  type: 'visit' | 'create_group' | 'join_group' | 'vote' | 'game_edit' | 'delete_group';
  label: string;
  groupCode?: string;
  groupName?: string;
  actor?: string;
  at: string;
};

type AnalyticsStore = {
  totalGroupsCreated: number;
  deletedGroupsCount: number;
  deletedCodes: Record<string, { code: string; slug?: string; name?: string; deletedAt: string }>;
  deletedSlugs: Record<string, string>;
  visitors: Record<string, VisitorStat>;
  totalVisits: number;
  totalInteractions: number;
  breakdown: {
    groupCreates: number;
    groupJoins: number;
    votes: number;
    gameEdits: number;
    detailsViews: number;
  };
  recentEvents: AnalyticsEventItem[];
};

function defaultAnalyticsStore(): AnalyticsStore {
  return {
    totalGroupsCreated: 0,
    deletedGroupsCount: 0,
    deletedCodes: {},
    deletedSlugs: {},
    visitors: {},
    totalVisits: 0,
    totalInteractions: 0,
    breakdown: {
      groupCreates: 0,
      groupJoins: 0,
      votes: 0,
      gameEdits: 0,
      detailsViews: 0
    },
    recentEvents: []
  };
}

function getAnalyticsStore(): AnalyticsStore {
  const base = defaultAnalyticsStore();
  if (fs.existsSync(ANALYTICS_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(ANALYTICS_FILE, 'utf-8'));
      if (parsed && typeof parsed === 'object') {
        return {
          ...base,
          ...parsed,
          deletedCodes: parsed.deletedCodes && typeof parsed.deletedCodes === 'object' ? parsed.deletedCodes : {},
          deletedSlugs: parsed.deletedSlugs && typeof parsed.deletedSlugs === 'object' ? parsed.deletedSlugs : {},
          visitors: parsed.visitors && typeof parsed.visitors === 'object' ? parsed.visitors : {},
          breakdown: { ...base.breakdown, ...(parsed.breakdown || {}) },
          recentEvents: Array.isArray(parsed.recentEvents) ? parsed.recentEvents : []
        };
      }
    } catch (e) {
      console.error(e);
    }
  }
  return base;
}

function saveAnalyticsStore(analytics: AnalyticsStore) {
  if (analytics.recentEvents.length > 60) {
    analytics.recentEvents = analytics.recentEvents.slice(0, 60);
  }
  fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(analytics, null, 2), 'utf-8');
}

function recordAnalyticsActivity(opts: {
  visitorId?: string;
  interacted?: boolean;
  type?: AnalyticsEventItem['type'];
  label?: string;
  groupCode?: string;
  groupName?: string;
  actor?: string;
  incrementVisit?: boolean;
  incrementGroupCreated?: boolean;
  breakdownKey?: keyof AnalyticsStore['breakdown'];
}) {
  const analytics = getAnalyticsStore();
  const now = new Date().toISOString();

  if (opts.visitorId) {
    const cleanVid = String(opts.visitorId).replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 80);
    if (cleanVid) {
      const cur = analytics.visitors[cleanVid] || {
        firstSeen: now,
        lastSeen: now,
        visits: 0,
        interacted: false,
        interactions: 0
      };
      cur.lastSeen = now;
      if (opts.incrementVisit) {
        cur.visits += 1;
        analytics.totalVisits += 1;
      }
      if (opts.interacted) {
        cur.interacted = true;
        cur.interactions += 1;
        analytics.totalInteractions += 1;
      }
      analytics.visitors[cleanVid] = cur;
    }
  } else if (opts.interacted) {
    analytics.totalInteractions += 1;
  }

  if (opts.incrementGroupCreated) {
    analytics.totalGroupsCreated += 1;
  }
  if (opts.breakdownKey) {
    analytics.breakdown[opts.breakdownKey] = (analytics.breakdown[opts.breakdownKey] || 0) + 1;
  }
  if (opts.type && opts.label) {
    analytics.recentEvents.unshift({
      id: 'ev_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
      type: opts.type,
      label: opts.label.slice(0, 180),
      groupCode: opts.groupCode,
      groupName: opts.groupName,
      actor: opts.actor,
      at: now
    });
  }

  saveAnalyticsStore(analytics);
  return analytics;
}

function getDevAdminConfig(): DevAdminConfig | null {
  if (fs.existsSync(DEV_ADMIN_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(DEV_ADMIN_FILE, 'utf-8'));
      if (parsed && typeof parsed.salt === 'string' && typeof parsed.hash === 'string') {
        return parsed as DevAdminConfig;
      }
    } catch (e) {
      console.error(e);
    }
  }
  return null;
}

function getEnvDevPassword(): string {
  return String(process.env.DEV_ADMIN_PASSWORD || '');
}

function scryptHashSecret(secret: string, saltHex?: string): { salt: string; hash: string } {
  const salt = saltHex || crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(secret, salt, 64).toString('hex');
  return { salt, hash: derived };
}

function timingSafeEqualDigest(a: string, b: string): boolean {
  const da = crypto.createHash('sha256').update(a, 'utf8').digest();
  const db = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(da, db);
}

function verifyDevPassword(candidate: string): boolean {
  const envPass = getEnvDevPassword();
  if (envPass.length > 0) {
    return timingSafeEqualDigest(candidate, envPass);
  }
  const cfg = getDevAdminConfig();
  if (!cfg) return false;
  const derived = crypto.scryptSync(candidate, cfg.salt, 64);
  const stored = Buffer.from(cfg.hash, 'hex');
  if (derived.length !== stored.length) return false;
  return crypto.timingSafeEqual(derived, stored);
}

function signDevToken(): string {
  const payload = {
    jti: crypto.randomBytes(12).toString('hex'),
    role: 'dev_admin',
    iat: Date.now(),
    exp: Date.now() + 6 * 60 * 60 * 1000
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', DEV_SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyDevToken(token: string): { valid: boolean; jti?: string } {
  if (!token || typeof token !== 'string') return { valid: false };
  const parts = token.split('.');
  if (parts.length !== 2) return { valid: false };
  const [body, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', DEV_SESSION_SECRET).update(body).digest('base64url');
  const sigBuf = Buffer.from(sig, 'utf8');
  const expBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { valid: false };
  }
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (
      !payload ||
      payload.role !== 'dev_admin' ||
      typeof payload.exp !== 'number' ||
      payload.exp < Date.now() ||
      (payload.jti && revokedDevTokenIds.has(payload.jti))
    ) {
      return { valid: false };
    }
    return { valid: true, jti: payload.jti };
  } catch (e) {
    return { valid: false };
  }
}

function requireDevAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const authHeader = String(req.headers.authorization || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const check = verifyDevToken(token);
  if (!check.valid) {
    return res.status(401).json({ error: 'جلسة المطور غير صالحة أو منتهية' });
  }
  next();
}

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
  notifyClients('games', { games, lastUpdated }, '');
}

function getVotes(): Record<string, StoredVote> {
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
  notifyClients('votes', formatVotes(votes), '');
}

function formatVotes(rawVotes: Record<string, StoredVote>) {
  const votesSummary: Record<string, { n: number; uids: string[]; names: string[] }> = {};
  const memberNames: string[] = [];
  let totalVoters = 0;

  for (const [uid, userVote] of Object.entries(rawVotes)) {
    const list = userVote.v || [];
    const cleanName = (userVote.name || '').trim();
    if (cleanName && !memberNames.includes(cleanName)) memberNames.push(cleanName);
    if (list.length > 0) totalVoters++;
    for (const gameId of list) {
      if (!votesSummary[gameId]) {
        votesSummary[gameId] = { n: 0, uids: [], names: [] };
      }
      votesSummary[gameId].n++;
      votesSummary[gameId].uids.push(uid);
      if (cleanName && !votesSummary[gameId].names.includes(cleanName)) {
        votesSummary[gameId].names.push(cleanName);
      }
    }
  }
  return { summary: votesSummary, totalVoters, memberNames };
}

type Client = { id: number; groupCode: string; res: express.Response };
let clients: Client[] = [];

function notifyClients(type: string, data: any, groupCode = '') {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(c => {
    if (c.groupCode === groupCode) {
      try {
        c.res.write(payload);
      } catch (e) {}
    }
  });
}

const app = express();
app.use(express.json({ limit: '50mb' }));

// Global & group-scoped SSE
app.get('/api/events', (req, res) => {
  const groupCode = sanitizeCode(String(req.query.group || ''));
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const clientId = Date.now() + Math.random();
  clients.push({ id: clientId, groupCode, res });

  if (groupCode) {
    const analytics = getAnalyticsStore();
    if (analytics.deletedCodes[groupCode]) {
      res.write(`event: group_deleted\ndata: ${JSON.stringify({ code: groupCode, reason: 'deleted_by_developer' })}\n\n`);
    } else {
      const store = getGroupsStore();
      const grp = store[groupCode];
      if (grp) {
        res.write(`event: games\ndata: ${JSON.stringify({ games: grp.games || [], lastUpdated: grp.lastUpdated })}\n\n`);
        res.write(`event: votes\ndata: ${JSON.stringify(formatVotes(grp.votes || {}))}\n\n`);
      }
    }
  } else {
    res.write(`event: games\ndata: ${JSON.stringify({ games: getGames(), lastUpdated })}\n\n`);
    res.write(`event: votes\ndata: ${JSON.stringify(formatVotes(getVotes()))}\n\n`);
  }

  req.on('close', () => {
    clients = clients.filter(c => c.id !== clientId);
  });
});

setInterval(() => {
  clients.forEach(c => {
    try {
      c.res.write(': ping\n\n');
    } catch (e) {}
  });
}, 15000);

/* ===== Multi-Group APIs ===== */

app.post('/api/groups', (req, res) => {
  const { name, adminName, adminPin, code: requestedCode, slug: requestedSlug, games, uid } = req.body || {};
  const cleanName = String(name || '').trim().slice(0, 80);
  const cleanAdmin = String(adminName || '').trim().slice(0, 60);

  if (cleanName.length < 2) {
    return res.status(400).json({ error: 'اكتب اسم القروب (حرفين على الأقل)' });
  }
  if (cleanAdmin.length < 2) {
    return res.status(400).json({ error: 'اكتب اسمك كأدمن للقروب' });
  }

  const store = getGroupsStore();
  const slug = String(requestedSlug || normalizeGroupSlug(cleanName));
  const duplicate = Object.values(store).find(g => g.slug === slug);
  if (duplicate) {
    return res.status(409).json({ error: 'اسم القروب مستخدم مسبقاً، اختر اسماً آخر حتى لا تتكرر الإدارة' });
  }

  const code = requestedCode && !store[sanitizeCode(requestedCode)]
    ? sanitizeCode(requestedCode)
    : generateCode(store);

  const plainPin = String(adminPin || crypto.randomBytes(3).toString('hex').toUpperCase());
  const adminPinSalt = crypto.randomBytes(8).toString('hex');
  const adminPinHash = hashSecret(adminPinSalt, plainPin);
  const nowIso = new Date().toISOString();
  const nowTs = Date.now();

  const initialGames = Array.isArray(games) ? games : [];
  store[code] = {
    code,
    name: cleanName,
    slug,
    adminName: cleanAdmin,
    adminPinSalt,
    adminPinHash,
    createdAt: nowIso,
    lastUpdated: nowTs,
    votesVersion: nowTs,
    games: initialGames,
    votes: {}
  };
  saveGroupsStore(store);

  const analytics = getAnalyticsStore();
  if (analytics.deletedSlugs[slug]) {
    delete analytics.deletedSlugs[slug];
    saveAnalyticsStore(analytics);
  }
  recordAnalyticsActivity({
    visitorId: uid ? String(uid) : undefined,
    interacted: true,
    incrementGroupCreated: true,
    breakdownKey: 'groupCreates',
    type: 'create_group',
    label: `إنشاء قروب جديد «${cleanName}»`,
    groupCode: code,
    groupName: cleanName,
    actor: cleanAdmin
  });

  res.json({
    success: true,
    group: {
      code,
      name: cleanName,
      slug,
      adminName: cleanAdmin,
      adminPinSalt,
      adminPinHash,
      createdAt: nowIso
    },
    adminPin: plainPin
  });
});

app.post('/api/groups/join-by-name', (req, res) => {
  const { groupName, memberName, uid } = req.body || {};
  const cleanGroup = String(groupName || '').trim().slice(0, 80);
  const cleanMember = String(memberName || '').trim().slice(0, 60);

  if (cleanGroup.length < 2) return res.status(400).json({ error: 'اكتب اسم القروب الصحيح' });
  if (cleanMember.length < 2) return res.status(400).json({ error: 'اكتب اسمك في القروب' });

  const slug = normalizeGroupSlug(cleanGroup);
  const analytics = getAnalyticsStore();
  if (analytics.deletedSlugs[slug]) {
    return res.status(410).json({ deleted: true, error: 'تم حذف هذا القروب من قِبل مطور الموقع' });
  }

  const store = getGroupsStore();
  const grp = Object.values(store).find(g => g.slug === slug);
  if (!grp) return res.status(404).json({ error: 'لم يتم العثور على قروب بهذا الاسم' });

  const lowerMember = cleanMember.toLowerCase();
  const adminTaken = grp.adminName.trim().toLowerCase() === lowerMember;
  const takenByOther = Object.entries(grp.votes || {}).some(
    ([otherUid, rec]) => otherUid !== uid && (rec.name || '').trim().toLowerCase() === lowerMember
  );

  if (adminTaken || takenByOther) {
    return res.status(409).json({ error: 'هذا الاسم مستخدم داخل القروب، اختر اسماً مميزاً' });
  }

  if (uid) {
    grp.votes = grp.votes || {};
    const existingVotes = grp.votes[uid]?.v || [];
    grp.votes[uid] = { v: existingVotes, t: Date.now(), name: cleanMember };
    grp.votesVersion = Date.now();
    saveGroupsStore(store);
    notifyClients('votes', formatVotes(grp.votes), grp.code);
  }

  recordAnalyticsActivity({
    visitorId: uid ? String(uid) : undefined,
    interacted: true,
    breakdownKey: 'groupJoins',
    type: 'join_group',
    label: `انضمام «${cleanMember}» إلى قروب «${grp.name}»`,
    groupCode: grp.code,
    groupName: grp.name,
    actor: cleanMember
  });

  res.json({
    success: true,
    group: {
      code: grp.code,
      name: grp.name,
      slug: grp.slug,
      adminName: grp.adminName,
      adminPinSalt: grp.adminPinSalt,
      adminPinHash: grp.adminPinHash,
      createdAt: grp.createdAt
    }
  });
});

app.get('/api/groups/:code', (req, res) => {
  const code = sanitizeCode(req.params.code);
  const analytics = getAnalyticsStore();
  if (analytics.deletedCodes[code]) {
    return res.status(410).json({ deleted: true, error: 'تم حذف هذا القروب من قِبل مطور الموقع' });
  }
  const store = getGroupsStore();
  const grp = store[code];
  if (!grp) return res.status(404).json({ error: 'القروب غير موجود' });
  res.json({
    group: {
      code: grp.code,
      name: grp.name,
      slug: grp.slug,
      adminName: grp.adminName,
      adminPinSalt: grp.adminPinSalt,
      adminPinHash: grp.adminPinHash,
      createdAt: grp.createdAt,
      updatedAt: grp.updatedAt
    },
    lastUpdated: grp.lastUpdated,
    votesVersion: grp.votesVersion
  });
});

app.post('/api/groups/:code/join', (req, res) => {
  const code = sanitizeCode(req.params.code);
  const { memberName, uid } = req.body || {};
  const cleanMember = String(memberName || '').trim().slice(0, 60);

  const analytics = getAnalyticsStore();
  if (analytics.deletedCodes[code]) {
    return res.status(410).json({ deleted: true, error: 'تم حذف هذا القروب من قِبل مطور الموقع' });
  }

  const store = getGroupsStore();
  const grp = store[code];
  if (!grp) return res.status(404).json({ error: 'رابط الدعوة غير صحيح أو القروب غير موجود' });
  if (cleanMember.length < 2) return res.status(400).json({ error: 'اكتب اسمك في القروب' });

  const lowerMember = cleanMember.toLowerCase();
  const adminTaken = grp.adminName.trim().toLowerCase() === lowerMember;
  const takenByOther = Object.entries(grp.votes || {}).some(
    ([otherUid, rec]) => otherUid !== uid && (rec.name || '').trim().toLowerCase() === lowerMember
  );

  if (adminTaken || takenByOther) {
    return res.status(409).json({ error: 'هذا الاسم مستخدم داخل القروب، اختر اسماً مميزاً' });
  }

  if (uid) {
    grp.votes = grp.votes || {};
    const existingVotes = grp.votes[uid]?.v || [];
    grp.votes[uid] = { v: existingVotes, t: Date.now(), name: cleanMember };
    grp.votesVersion = Date.now();
    saveGroupsStore(store);
    notifyClients('votes', formatVotes(grp.votes), code);
  }

  recordAnalyticsActivity({
    visitorId: uid ? String(uid) : undefined,
    interacted: true,
    breakdownKey: 'groupJoins',
    type: 'join_group',
    label: `انضمام «${cleanMember}» عبر رابط الدعوة إلى «${grp.name}»`,
    groupCode: grp.code,
    groupName: grp.name,
    actor: cleanMember
  });

  res.json({
    success: true,
    group: {
      code: grp.code,
      name: grp.name,
      slug: grp.slug,
      adminName: grp.adminName,
      adminPinSalt: grp.adminPinSalt,
      adminPinHash: grp.adminPinHash,
      createdAt: grp.createdAt
    }
  });
});

app.post('/api/groups/:code/admin-verify', (req, res) => {
  const code = sanitizeCode(req.params.code);
  const { adminPin } = req.body || {};
  const store = getGroupsStore();
  const grp = store[code];
  if (!grp) return res.status(404).json({ error: 'القروب غير موجود' });

  const calc = hashSecret(grp.adminPinSalt, String(adminPin || '').trim().toUpperCase());
  const calcRaw = hashSecret(grp.adminPinSalt, String(adminPin || '').trim());
  if (calc === grp.adminPinHash || calcRaw === grp.adminPinHash) {
    return res.json({ success: true });
  }
  return res.status(401).json({ error: 'رقم الآدمن غير صحيح' });
});

app.get('/api/groups/:code/version', (req, res) => {
  const code = sanitizeCode(req.params.code);
  const analytics = getAnalyticsStore();
  if (analytics.deletedCodes[code]) {
    return res.status(410).json({ deleted: true, error: 'تم حذف هذا القروب من قِبل مطور الموقع' });
  }
  const store = getGroupsStore();
  const grp = store[code];
  if (!grp) return res.status(404).json({ error: 'القروب غير موجود' });
  res.json({ lastUpdated: grp.lastUpdated, votesVersion: grp.votesVersion });
});

app.get('/api/groups/:code/games', (req, res) => {
  const code = sanitizeCode(req.params.code);
  const store = getGroupsStore();
  const grp = store[code];
  if (!grp) return res.status(404).json({ error: 'القروب غير موجود' });
  res.json({ games: grp.games || [], lastUpdated: grp.lastUpdated });
});

app.post('/api/groups/:code/games', (req, res) => {
  const code = sanitizeCode(req.params.code);
  const store = getGroupsStore();
  const grp = store[code];
  if (!grp) return res.status(404).json({ error: 'القروب غير موجود' });

  const newGame = req.body;
  if (!newGame.id) {
    newGame.id = 'g_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  const idx = grp.games.findIndex(g => g.id === newGame.id);
  if (idx >= 0) grp.games[idx] = { ...grp.games[idx], ...newGame };
  else grp.games.unshift(newGame);

  grp.lastUpdated = Date.now();
  saveGroupsStore(store);
  notifyClients('games', { games: grp.games, lastUpdated: grp.lastUpdated }, code);
  recordAnalyticsActivity({
    interacted: true,
    breakdownKey: 'gameEdits',
    type: 'game_edit',
    label: `إضافة/تحديث لعبة «${String(newGame.name || 'لعبة').slice(0, 50)}» في قروب «${grp.name}»`,
    groupCode: code,
    groupName: grp.name,
    actor: grp.adminName
  });
  res.json({ success: true, game: newGame });
});

app.put('/api/groups/:code/games/:id', (req, res) => {
  const code = sanitizeCode(req.params.code);
  const id = req.params.id;
  const store = getGroupsStore();
  const grp = store[code];
  if (!grp) return res.status(404).json({ error: 'القروب غير موجود' });

  const idx = grp.games.findIndex(g => g.id === id);
  if (idx >= 0) {
    grp.games[idx] = { ...grp.games[idx], ...req.body, id };
    grp.lastUpdated = Date.now();
    saveGroupsStore(store);
    notifyClients('games', { games: grp.games, lastUpdated: grp.lastUpdated }, code);
    recordAnalyticsActivity({
      interacted: true,
      breakdownKey: 'gameEdits',
      type: 'game_edit',
      label: `تعديل لعبة «${String(grp.games[idx].name || 'لعبة').slice(0, 50)}» في قروب «${grp.name}»`,
      groupCode: code,
      groupName: grp.name,
      actor: grp.adminName
    });
    res.json({ success: true, game: grp.games[idx] });
  } else {
    res.status(404).json({ error: 'Game not found' });
  }
});

app.delete('/api/groups/:code/games/:id', (req, res) => {
  const code = sanitizeCode(req.params.code);
  const id = req.params.id;
  const store = getGroupsStore();
  const grp = store[code];
  if (!grp) return res.status(404).json({ error: 'القروب غير موجود' });

  grp.games = grp.games.filter(g => g.id !== id);
  grp.lastUpdated = Date.now();
  saveGroupsStore(store);
  notifyClients('games', { games: grp.games, lastUpdated: grp.lastUpdated }, code);
  recordAnalyticsActivity({
    interacted: true,
    breakdownKey: 'gameEdits',
    type: 'game_edit',
    label: `حذف لعبة من قروب «${grp.name}»`,
    groupCode: code,
    groupName: grp.name,
    actor: grp.adminName
  });
  res.json({ success: true });
});

app.post('/api/groups/:code/games/seed', (req, res) => {
  const code = sanitizeCode(req.params.code);
  const store = getGroupsStore();
  const grp = store[code];
  if (!grp) return res.status(404).json({ error: 'القروب غير موجود' });

  const list = req.body?.games;
  if (!Array.isArray(list)) return res.status(400).json({ error: 'Invalid games array' });
  grp.games = list;
  grp.lastUpdated = Date.now();
  saveGroupsStore(store);
  notifyClients('games', { games: grp.games, lastUpdated: grp.lastUpdated }, code);
  res.json({ success: true, count: list.length });
});

app.get('/api/groups/:code/votes', (req, res) => {
  const code = sanitizeCode(req.params.code);
  const store = getGroupsStore();
  const grp = store[code];
  if (!grp) return res.status(404).json({ error: 'القروب غير موجود' });
  res.json(formatVotes(grp.votes || {}));
});

app.post('/api/groups/:code/votes', (req, res) => {
  const code = sanitizeCode(req.params.code);
  const { uid, v, name } = req.body || {};
  if (!uid) return res.status(400).json({ error: 'Missing uid' });

  const analytics = getAnalyticsStore();
  if (analytics.deletedCodes[code]) {
    return res.status(410).json({ deleted: true, error: 'تم حذف هذا القروب من قِبل مطور الموقع' });
  }

  const store = getGroupsStore();
  const grp = store[code];
  if (!grp) return res.status(404).json({ error: 'القروب غير موجود' });

  grp.votes = grp.votes || {};
  grp.votes[uid] = { v: Array.isArray(v) ? v.slice(0, 3) : [], t: Date.now(), name: name || '' };
  grp.votesVersion = Date.now();
  saveGroupsStore(store);
  notifyClients('votes', formatVotes(grp.votes), code);
  recordAnalyticsActivity({
    visitorId: String(uid),
    interacted: true,
    breakdownKey: 'votes',
    type: 'vote',
    label: `تصويت «${String(name || 'عضو').slice(0, 40)}» في قروب «${grp.name}»`,
    groupCode: code,
    groupName: grp.name,
    actor: String(name || 'عضو').slice(0, 40)
  });
  res.json({ success: true });
});

app.post('/api/groups/:code/votes/reset', (req, res) => {
  const code = sanitizeCode(req.params.code);
  const store = getGroupsStore();
  const grp = store[code];
  if (!grp) return res.status(404).json({ error: 'القروب غير موجود' });

  const preserved: Record<string, StoredVote> = {};
  for (const [k, rec] of Object.entries(grp.votes || {})) {
    preserved[k] = { v: [], t: Date.now(), name: rec.name || '' };
  }
  grp.votes = preserved;
  grp.votesVersion = Date.now();
  saveGroupsStore(store);
  notifyClients('votes', formatVotes(grp.votes), code);
  res.json({ success: true });
});

/* ===== Site Analytics & Sync Metadata ===== */

app.post('/api/analytics/visit', (req, res) => {
  const { visitorId, groupCode } = req.body || {};
  if (!visitorId || typeof visitorId !== 'string') {
    return res.status(400).json({ error: 'Missing visitorId' });
  }
  const cleanCode = groupCode ? sanitizeCode(String(groupCode)) : '';
  const analytics = getAnalyticsStore();
  if (cleanCode && analytics.deletedCodes[cleanCode]) {
    return res.json({ ok: true, groupDeleted: true });
  }
  recordAnalyticsActivity({
    visitorId,
    incrementVisit: true
  });
  res.json({ ok: true, groupDeleted: false });
});

app.post('/api/analytics/interact', (req, res) => {
  const { visitorId, action, groupCode } = req.body || {};
  if (!visitorId || typeof visitorId !== 'string') {
    return res.status(400).json({ error: 'Missing visitorId' });
  }
  const cleanAction = String(action || '').slice(0, 40);
  const cleanCode = groupCode ? sanitizeCode(String(groupCode)) : undefined;
  recordAnalyticsActivity({
    visitorId,
    interacted: true,
    breakdownKey: cleanAction === 'details' ? 'detailsViews' : undefined,
    groupCode: cleanCode
  });
  res.json({ ok: true });
});

app.post('/api/groups/sync-meta', (req, res) => {
  const { code: rawCode, name, adminName, createdAt, gamesCount, memberName, uid } = req.body || {};
  const code = sanitizeCode(String(rawCode || ''));
  if (!code || code.length < 4) return res.status(400).json({ error: 'Invalid code' });

  const analytics = getAnalyticsStore();
  if (analytics.deletedCodes[code]) {
    return res.status(410).json({ deleted: true, error: 'تم حذف هذا القروب من قِبل مطور الموقع' });
  }

  const store = getGroupsStore();
  if (!store[code]) {
    const cleanName = String(name || '').trim().slice(0, 80);
    const cleanAdmin = String(adminName || '').trim().slice(0, 60);
    if (cleanName.length >= 2 && cleanAdmin.length >= 2) {
      const slug = normalizeGroupSlug(cleanName);
      if (analytics.deletedSlugs[slug]) {
        return res.status(410).json({ deleted: true, error: 'تم حذف هذا القروب من قِبل مطور الموقع' });
      }
      const nowTs = Date.now();
      const placeholderPinSalt = crypto.randomBytes(8).toString('hex');
      const placeholderPinHash = hashSecret(placeholderPinSalt, crypto.randomBytes(12).toString('hex'));
      const votesMap: Record<string, StoredVote> = {};
      if (uid && memberName) {
        votesMap[String(uid).slice(0, 64)] = {
          v: [],
          t: nowTs,
          name: String(memberName).trim().slice(0, 60)
        };
      }
      store[code] = {
        code,
        name: cleanName,
        slug,
        adminName: cleanAdmin,
        adminPinSalt: placeholderPinSalt,
        adminPinHash: placeholderPinHash,
        createdAt: typeof createdAt === 'string' && createdAt.length <= 64 ? createdAt : new Date().toISOString(),
        lastUpdated: nowTs,
        votesVersion: nowTs,
        games: Array.isArray(req.body?.games) ? req.body.games.slice(0, 120) : new Array(Math.min(60, Math.max(0, Number(gamesCount) || 0))).fill(null).map((_, idx) => ({ id: `synced_${idx}`, name: `Game ${idx + 1}`, price: 0 })),
        votes: votesMap
      };
      saveGroupsStore(store);
      recordAnalyticsActivity({
        incrementGroupCreated: true,
        groupCode: code,
        groupName: cleanName
      });
    }
  }
  res.json({ ok: true, deleted: false });
});

/* ===== Developer Room (/#admin0) APIs ===== */

app.get('/api/dev/status', (req, res) => {
  const hasEnv = getEnvDevPassword().length > 0;
  const hasClaimed = !!getDevAdminConfig();
  const authHeader = String(req.headers.authorization || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const authenticated = token ? verifyDevToken(token).valid : false;
  res.json({
    configured: hasEnv || hasClaimed,
    mode: hasEnv || hasClaimed ? 'login' : 'setup',
    authenticated
  });
});

app.post('/api/dev/setup', (req, res) => {
  if (getEnvDevPassword().length > 0 || getDevAdminConfig()) {
    return res.status(409).json({ error: 'تم إعداد كلمة مرور المطور مسبقاً' });
  }
  const password = String(req.body?.password || '');
  if (password.length < 3) {
    return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 3 أحرف أو رموز على الأقل' });
  }
  const { salt, hash } = scryptHashSecret(password);
  const record: DevAdminConfig = {
    salt,
    hash,
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(DEV_ADMIN_FILE, JSON.stringify(record, null, 2), 'utf-8');
  const token = signDevToken();
  res.json({ success: true, token });
});

app.post('/api/dev/login', (req, res) => {
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const rate = devLoginRateMap.get(clientIp);
  if (rate && rate.resetAt > now && rate.count >= 12) {
    return res.status(429).json({ error: 'محاولات كثيرة خاطئة، انتظر قليلاً ثم أعد المحاولة' });
  }

  const hasEnv = getEnvDevPassword().length > 0;
  const hasClaimed = !!getDevAdminConfig();
  if (!hasEnv && !hasClaimed) {
    return res.status(409).json({ error: 'يجب إعداد كلمة مرور المطور أولاً', needsSetup: true });
  }

  const password = String(req.body?.password || '');
  if (!password || !verifyDevPassword(password)) {
    const nextCount = rate && rate.resetAt > now ? rate.count + 1 : 1;
    devLoginRateMap.set(clientIp, { count: nextCount, resetAt: now + 15 * 60 * 1000 });
    return res.status(401).json({ error: 'كلمة مرور المطور غير صحيحة' });
  }

  devLoginRateMap.delete(clientIp);
  const token = signDevToken();
  res.json({ success: true, token });
});

app.post('/api/dev/logout', (req, res) => {
  const authHeader = String(req.headers.authorization || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const check = verifyDevToken(token);
  if (check.valid && check.jti) {
    revokedDevTokenIds.add(check.jti);
  }
  res.json({ success: true });
});

app.get('/api/dev/stats', requireDevAuth, (req, res) => {
  const store = getGroupsStore();
  const analytics = getAnalyticsStore();
  const activeGroupsList = Object.values(store);

  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const visitorsArr = Object.values(analytics.visitors);
  const uniqueVisitors = visitorsArr.length;
  const interactedVisitors = visitorsArr.filter(v => v.interacted).length;
  const visitorsLast24h = visitorsArr.filter(v => {
    const t = Date.parse(v.lastSeen);
    return !Number.isNaN(t) && t >= dayAgo;
  }).length;

  let totalGames = 0;
  let totalVotes = 0;
  const activeMemberIds = new Set<string>();

  const groups = activeGroupsList
    .map(grp => {
      const gamesCount = Array.isArray(grp.games) ? grp.games.length : 0;
      const voteEntries = Object.entries(grp.votes || {});
      let grpVotes = 0;
      const memberNames: string[] = [];
      for (const [mUid, rec] of voteEntries) {
        activeMemberIds.add(mUid);
        const cName = (rec?.name || '').trim();
        if (cName && !memberNames.includes(cName)) memberNames.push(cName);
        if (Array.isArray(rec?.v)) grpVotes += rec.v.length;
      }
      totalGames += gamesCount;
      totalVotes += grpVotes;

      return {
        code: grp.code,
        name: grp.name,
        adminName: grp.adminName,
        createdAt: grp.createdAt,
        lastUpdated: grp.lastUpdated || Date.parse(grp.createdAt) || Date.now(),
        gamesCount,
        membersCount: Math.max(1, voteEntries.length),
        votesCount: grpVotes,
        memberNames
      };
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  const totalGroupsCreated = Math.max(
    analytics.totalGroupsCreated,
    groups.length + analytics.deletedGroupsCount
  );
  const engagedUsers = Math.max(interactedVisitors, activeMemberIds.size);

  res.json({
    stats: {
      totalGroupsCreated,
      activeGroupsCount: groups.length,
      deletedGroupsCount: analytics.deletedGroupsCount,
      uniqueVisitors,
      totalVisits: Math.max(analytics.totalVisits, uniqueVisitors),
      engagedUsers,
      visitorsLast24h,
      totalInteractions: Math.max(analytics.totalInteractions, totalVotes),
      totalGames,
      totalVotes,
      breakdown: analytics.breakdown
    },
    groups,
    recentEvents: analytics.recentEvents.slice(0, 20)
  });
});

function performGroupDeletion(codes: string[]) {
  const store = getGroupsStore();
  const analytics = getAnalyticsStore();
  const deleted: string[] = [];
  const now = new Date().toISOString();

  for (const raw of codes) {
    const code = sanitizeCode(raw);
    const grp = store[code];
    if (!grp) continue;

    analytics.deletedCodes[code] = {
      code,
      slug: grp.slug,
      name: grp.name,
      deletedAt: now
    };
    if (grp.slug) {
      analytics.deletedSlugs[grp.slug] = code;
    }
    analytics.deletedGroupsCount += 1;
    analytics.recentEvents.unshift({
      id: 'ev_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
      type: 'delete_group',
      label: `حذف قروب «${grp.name}» من لوحة المطور`,
      groupCode: code,
      groupName: grp.name,
      actor: 'المطور',
      at: now
    });

    delete store[code];
    deleted.push(code);
    notifyClients('group_deleted', { code, reason: 'deleted_by_developer' }, code);
  }

  if (deleted.length > 0) {
    saveGroupsStore(store);
    saveAnalyticsStore(analytics);
  }
  return deleted;
}

app.delete('/api/dev/groups/:code', requireDevAuth, (req, res) => {
  const code = sanitizeCode(req.params.code);
  const deleted = performGroupDeletion([code]);
  if (deleted.length === 0) {
    return res.status(404).json({ error: 'القروب غير موجود أو تم حذفه مسبقاً' });
  }
  res.json({ success: true, deleted });
});

app.post('/api/dev/groups/bulk-delete', requireDevAuth, (req, res) => {
  const codes = Array.isArray(req.body?.codes) ? req.body.codes.map(String) : [];
  if (codes.length === 0) {
    return res.status(400).json({ error: 'اختر قروباً واحداً على الأقل للحذف' });
  }
  const deleted = performGroupDeletion(codes);
  res.json({ success: true, deleted, count: deleted.length });
});

/* ===== Legacy Global APIs (kept for compatibility) ===== */

app.get('/api/version', (req, res) => {
  res.json({ lastUpdated, votesVersion });
});

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

app.get('/api/admin/status', (req, res) => {
  const cfg = getConfig();
  res.json({ hasPassword: !!cfg });
});

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  const cfg = getConfig();
  if (!cfg) {
    if (!password || password.length < 4) {
      return res.status(400).json({ error: 'الرمز قصير جداً' });
    }
    const salt = crypto.randomBytes(8).toString('hex');
    const hash = hashSecret(salt, password);
    saveConfig({ salt, hash });
    return res.json({ success: true, initialized: true });
  }
  const calcHash = hashSecret(cfg.salt, password);
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
  const hash = hashSecret(salt, password);
  saveConfig({ salt, hash });
  res.json({ success: true });
});

const port = 3000;

async function start() {
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: 'spa'
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
