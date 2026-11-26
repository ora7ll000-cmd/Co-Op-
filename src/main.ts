// Co-Op Web Application - Multi-Group Rooms & Showcase Logic
import { registerSW } from 'virtual:pwa-register';
import { defaultGames } from './initialData';
import {
  type GroupRecord,
  type GroupGameRecord,
  type VoteSummary,
  sha256Hex,
  normalizeGroupNameSlug,
  sanitizeId,
  sanitizeGroupCode,
  checkGroupNameAvailable,
  createGroupInFirebase,
  getGroupFromFirebase,
  getGroupByNameFromFirebase,
  getGroupMemberNamesFromFirebase,
  registerGroupMemberInFirebase,
  subscribeToGroupGames,
  upsertGroupGameInFirebase,
  deleteGroupGameInFirebase,
  subscribeToGroupVotes,
  syncUserGroupVoteToFirebase,
  resetGroupFirebaseVotes
} from './firebase';

type Game = GroupGameRecord;

type GroupSession = {
  code: string;
  name: string;
  adminName: string;
  memberName: string;
  isCreatorAdmin: boolean;
  adminPin?: string;
};

type MediaSlide =
  | { kind: 'image'; src: string; imgIdx: number; label: string }
  | { kind: 'art'; label: string }
  | { kind: 'trailer'; trailerType: 'youtube' | 'video'; src: string; poster: string; label: string };

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const on = <K extends keyof HTMLElementEventMap>(
  id: string,
  ev: K,
  fn: (e: HTMLElementEventMap[K]) => unknown
) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener(ev, fn as EventListener);
};

async function cleanupDevServiceWorkerIfNeeded(): Promise<boolean> {
  try {
    if (import.meta.env.DEV && 'serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      let hadReg = false;
      for (const r of regs) {
        await r.unregister();
        hadReg = true;
      }
      if ('caches' in window) {
        const keys = await caches.keys();
        for (const k of keys) await caches.delete(k);
      }
      const staleDom = !document.getElementById('gate') || !document.getElementById('gax') || !document.getElementById('gsdlg');
      if ((hadReg || staleDom) && !sessionStorage.getItem('coop_sw_reloaded')) {
        sessionStorage.setItem('coop_sw_reloaded', '1');
        location.reload();
        return true;
      }
    }
  } catch (e) {}
  return false;
}

try {
  const t = localStorage.getItem('theme');
  if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
} catch (e) {}

try {
  history.scrollRestoration = 'manual';
} catch (e) {}

let moved = false;
['wheel', 'touchstart', 'touchmove', 'keydown', 'mousedown'].forEach(ev =>
  addEventListener(ev, () => { moved = true; }, { once: true, passive: true })
);

const toTop = () => {
  if (!moved) window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
};
toTop();
addEventListener('load', toTop);
[300, 900, 1800].forEach(t => setTimeout(toTop, t));

const INFO: Record<string, [string, string, string]> = {
  'Lethal Company': [
    '1-4',
    'لعبة رعب تعاونية: تنزلون كفريق على كواكب مهجورة وتجمعون الغنائم وتبيعونها للشركة وانتم تتجنبون المخلوقات اللي تتربص فيكم.',
    'حقّقوا الحصة المطلوبة من المبيعات قبل انتهاء المهلة، وارجعوا سالمين.'
  ],
  'Sons Of The Forest': [
    '1-8',
    'لعبة بقاء ورعب في جزيرة معزولة بعد تحطم الطائرة، تبنون وتستكشفون الكهوف وتواجهون سكان الجزيرة.',
    'انجوا، وابحثوا عن المفقود، واكتشفوا أسرار الجزيرة.'
  ]
};

const goalOf = (g: Game) => g.goal || (INFO[g.name] ? INFO[g.name][2] : '');
const playersOf = (g: Game) => g.players || (INFO[g.name] ? INFO[g.name][0] : '');

let backendAvailable = true;
let currentSession: GroupSession | null = null;
let groupMemberNames: string[] = [];
let unsubGroupGames: (() => void) | null = null;
let unsubGroupVotes: (() => void) | null = null;
let sseSource: EventSource | null = null;
let syncTimer: ReturnType<typeof setInterval> | null = null;

let games: Game[] = [];
let adminMode = false;
let curId: string | null = null;
let imgAr = 0.8;
let pref = 0;
let relIds: string[] = [];
let lastT = 0;
let lastVotesT = 0;

let votes: VoteSummary = {};
let myV = new Set<string>();
let uid = '';
let vTotal = 0;
let nick = '';

try {
  nick = localStorage.getItem('nick') || '';
  uid = localStorage.getItem('user_uid') || '';
  if (!uid) {
    uid = 'u_' + Math.random().toString(36).slice(2, 10);
    localStorage.setItem('user_uid', uid);
  }
} catch (e) {
  uid = 'u_' + Math.random().toString(36).slice(2, 10);
}

function getLocalGroupsRegistry(): Record<string, GroupRecord & { games: Game[] }> {
  try {
    const raw = localStorage.getItem('coop_local_groups');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch (e) {}
  return {};
}

function saveLocalGroupRecord(grp: GroupRecord, grpGames?: Game[]) {
  try {
    const reg = getLocalGroupsRegistry();
    reg[grp.code] = { ...grp, games: grpGames ?? reg[grp.code]?.games ?? [] };
    localStorage.setItem('coop_local_groups', JSON.stringify(reg));
  } catch (e) {}
}

function saveSession(session: GroupSession | null) {
  currentSession = session;
  try {
    if (session) {
      localStorage.setItem('coop_group_session', JSON.stringify(session));
      localStorage.setItem('nick', session.memberName);
    } else {
      localStorage.removeItem('coop_group_session');
    }
  } catch (e) {}
  nick = session?.memberName || '';
}

function loadSavedSession(): GroupSession | null {
  try {
    const raw = localStorage.getItem('coop_group_session');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.code && parsed.name && parsed.memberName) {
        return parsed as GroupSession;
      }
    }
  } catch (e) {}
  return null;
}

function loadGroupCachedGames(code: string): Game[] {
  try {
    const saved = localStorage.getItem(`coop_group_games_${code}`);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) {}
  return (defaultGames as Game[]).map(g => ({ ...g }));
}

function saveGamesToLocal(newGames: Game[]) {
  games = newGames;
  if (currentSession) {
    try {
      localStorage.setItem(`coop_group_games_${currentSession.code}`, JSON.stringify(games));
    } catch (e) {}
  }
  render();
  syncDet();
  updStamp();
}

function loadGroupCachedVotes(code: string) {
  votes = {};
  myV = new Set();
  vTotal = 0;
  try {
    const storedVotes = localStorage.getItem(`coop_group_myv_${code}`);
    if (storedVotes) {
      const arr = JSON.parse(storedVotes);
      if (Array.isArray(arr)) myV = new Set(arr);
    }
    const storedSummary = localStorage.getItem(`coop_group_votes_${code}`);
    if (storedSummary) {
      const parsed = JSON.parse(storedSummary);
      if (parsed && parsed.votes) {
        votes = parsed.votes;
        vTotal = parsed.vTotal || 0;
      }
    }
  } catch (e) {}
}

function saveGroupVotesCache() {
  if (!currentSession) return;
  try {
    localStorage.setItem(`coop_group_myv_${currentSession.code}`, JSON.stringify([...myV]));
    localStorage.setItem(`coop_group_votes_${currentSession.code}`, JSON.stringify({ votes, vTotal }));
  } catch (e) {}
}

function syncLocalVotesSummary() {
  const localVotesMap: VoteSummary = { ...votes };
  for (const g of games) {
    if (!localVotesMap[g.id]) {
      localVotesMap[g.id] = { n: 0, uids: [], names: [] };
    }
  }
  games.forEach(g => {
    const isMine = myV.has(g.id);
    const existing = localVotesMap[g.id] || { n: 0, uids: [], names: [] };
    const hadMine = existing.uids.includes(uid);
    if (isMine && !hadMine) {
      existing.n++;
      existing.uids.push(uid);
      if (nick && !existing.names.includes(nick)) existing.names.push(nick);
    } else if (!isMine && hadMine) {
      existing.n = Math.max(0, existing.n - 1);
      existing.uids = existing.uids.filter(x => x !== uid);
      if (nick) existing.names = existing.names.filter(x => x !== nick);
    }
    localVotesMap[g.id] = existing;
  });
  votes = localVotesMap;
  vTotal = Math.max(myV.size > 0 ? 1 : 0, Object.values(votes).some(v => v.n > 0) ? 1 : 0);
  saveGroupVotesCache();
}

let audioCtx: AudioContext | null = null;
function playSound(type: 'vote' | 'unvote' | 'click') {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    if (type === 'vote') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(440, t);
      osc.frequency.exponentialRampToValueAtTime(880, t + 0.12);
      gain.gain.setValueAtTime(0.22, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      osc.start(t);
      osc.stop(t + 0.16);
    } else if (type === 'unvote') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(480, t);
      osc.frequency.exponentialRampToValueAtTime(260, t + 0.1);
      gain.gain.setValueAtTime(0.12, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
      osc.start(t);
      osc.stop(t + 0.12);
    } else {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(650, t);
      osc.frequency.exponentialRampToValueAtTime(320, t + 0.05);
      gain.gain.setValueAtTime(0.08, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
      osc.start(t);
      osc.stop(t + 0.05);
    }
  } catch (e) {}
}

const vN = (g: Game) => (votes[g.id] ? votes[g.id].n : 0);
const FI = `<svg viewBox="0 0 24 24" class="flame-ico"><path class="flame-out" d="M12 2c1 4 5 5 5 10a5 5 0 01-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-4-1-6 1-9z"/><path class="flame-in" d="M12 13c.6 0 1.2.5 1.2 1.2a1.2 1.2 0 01-2.4 0c0-.7.6-1.2 1.2-1.2z"/></svg>`;
const voteBtn = (g: Game, big?: boolean) =>
  `<button class="vote${big ? ' det-vote' : ''}${myV.has(g.id) ? ' on' : ''}" data-v="${g.id}"${big ? ' id="dv"' : ''} aria-label="${myV.has(g.id) ? 'إلغاء التصويت' : 'تصويت للعبة'}">
    <span class="v-ico">${FI}</span>
    <span class="v-txt">${myV.has(g.id) ? 'اخترتها' : 'أبي ألعبها'}</span>
    <b class="v-num">${vN(g)}</b>
  </button>`;

try {
  pref = +(localStorage.getItem('cols_v3') || 0);
} catch (e) {}

const innerW = () => {
  const gs = $('grid');
  if (!gs) return window.innerWidth;
  const cs = getComputedStyle(gs);
  return gs.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
};

const defaultCols = (w: number) => (w <= 768 ? 2 : 3);
const maxFit = (w: number) => (w <= 768 ? 2 : Math.max(1, Math.floor((w + 30) / 180)));

const layoutN = (w: number) => {
  const def = defaultCols(w);
  const target = pref || def;
  return Math.max(1, Math.min(target, maxFit(w)));
};

const szIcon = (n: number) => {
  const g = 2, w = (22 - (n - 1) * g) / n;
  return `<svg viewBox="0 0 22 16">${Array.from({ length: n }, (_, i) => `<rect x="${i * (w + g)}" y="0" width="${w}" height="16" rx="2"/>`).join('')}</svg>`;
};

const szHTML = (cur: number, m: number) =>
  `<span class="sl">حجم العرض</span>` +
  [4, 3, 2, 1]
    .filter(n => n <= m)
    .map(n => `<button class="sz${n === cur ? ' on' : ''}" data-n="${n}" title="${n} ${n === 1 ? 'عمود' : 'أعمدة'}" aria-label="${n} أعمدة">${szIcon(n)}</button>`)
    .join('');

const relW = () => $('dx').clientWidth || Math.min(1050, innerWidth * 0.9);
const relN = (w: number) => Math.max(1, Math.min(pref || (w <= 768 ? 2 : 3), maxFit(w)));

function buildSizes() {
  const w = innerW();
  $('sizes').innerHTML = szHTML(layoutN(w), maxFit(w));
  const s2 = $('sizes2');
  if (s2) {
    const rw = relW();
    s2.innerHTML = szHTML(relN(rw), maxFit(rw));
  }
}

function relArrows() {
  const el = $('rel');
  if (!el) return;
  const max = el.scrollWidth - el.clientWidth - 3;
  const pos = Math.abs(el.scrollLeft);
  $('rnl').classList.toggle('off', pos >= max);
  $('rpr').classList.toggle('off', pos <= 3);
}

function relGo(d: number) {
  const el = $('rel');
  el.scrollBy({ left: d * el.clientWidth * 0.96, behavior: 'smooth' });
}

function buildRel() {
  const el = $('rel');
  if (!el) return;
  const n = relN(relW()), w = el.parentElement as HTMLElement;
  el.style.setProperty('--rn', String(n));
  w.style.setProperty('--rn', String(n));
  w.className = 'relw r' + n;
  el.scrollLeft = 0;
  el.innerHTML = relIds
    .map(id => games.find(x => x.id === id))
    .filter(Boolean)
    .map(r => r ? `<div class="rc" data-o="${r.id}"><div class="cv">${cover(r)}<button class="zoom" data-z="${r.id}" aria-label="تكبير الصورة">${ZI}</button>${adminMode ? `<button class="redit" data-e="${r.id}">تعديل</button>` : ''}</div><b>${esc(r.name)}</b><span>${(+r.price).toFixed(2)} SR</span></div>` : '')
    .join('');

  const cv = el.querySelector('.cv') as HTMLElement | null;
  if (cv) w.style.setProperty('--ah', (cv.offsetHeight / 2 + 12) + 'px');
  relArrows();
}

function relPref(n: number, b: HTMLElement) {
  pref = n;
  try {
    localStorage.setItem('cols', String(pref));
  } catch (e) {}
  document.querySelectorAll('#sizes2 .sz').forEach(x => x.classList.toggle('on', x === b));
  b.classList.remove('pop');
  void b.offsetWidth;
  b.classList.add('pop');
  const el = $('rel');
  el.classList.add('swap');
  setTimeout(() => {
    buildRel();
    el.classList.remove('swap');
    (render as unknown as { done?: boolean }).done = true;
    render();
  }, 280);
}

function askC(msg: string): Promise<boolean> {
  return new Promise(res => {
    $('cmsg').textContent = msg;
    const d = $('cdlg') as HTMLDialogElement;
    const done = (v: boolean) => {
      d.close();
      res(v);
    };
    $('cok').onclick = () => done(true);
    $('cno').onclick = () => done(false);
    d.oncancel = () => res(false);
    d.showModal();
  });
}

async function delGame(id: string) {
  if (!adminMode || !currentSession) return toast('التعديل متاح لأدمن القروب فقط');
  if (!(await askC('متأكد تبي تحذف اللعبة؟'))) return;
  const code = currentSession.code;
  const nextGames = games.filter(g => g.id !== id);
  saveGamesToLocal(nextGames);

  await commit(async () => {
    let synced = false;
    try {
      await deleteGroupGameInFirebase(code, id);
      synced = true;
    } catch (e) {}
    if (backendAvailable) {
      try {
        const res = await fetch(`/api/groups/${code}/games/${id}`, { method: 'DELETE' });
        if (res.status === 404) backendAvailable = false;
        else if (res.ok) synced = true;
      } catch (e) {}
    }
    if (!synced) throw new Error('offline');
  }, 'تم الحذف وتحدّثت القائمة عند أعضاء القروب', 'تم الحذف محلياً');
}

function setSv(st: string) {
  const e = $('sv');
  if (!e) return;
  e.className = 'sv ' + st;
  e.textContent = st === 'saving' ? 'جارٍ الحفظ…' : st === 'ok' ? 'تم الحفظ ووصل للقروب' : st === 'err' ? 'حفظ محلي' : 'متصل';
}

async function commit(fn: () => Promise<unknown>, okMsg?: string, errMsg?: string) {
  setSv('saving');
  try {
    await fn();
    setSv('ok');
    toast(okMsg || 'تم الحفظ، وتحدّث عند أعضاء القروب');
    setTimeout(() => setSv('idle'), 4500);
    return true;
  } catch (e) {
    setSv('err');
    toast(errMsg || 'تم الحفظ محلياً في جهازك');
    setTimeout(() => setSv('idle'), 4500);
    return false;
  }
}

function updStamp() {
  const e = $('stamp');
  if (!e) return;
  if (!lastT) {
    e.textContent = '';
    return;
  }
  const m = Math.round((Date.now() - lastT) / 6e4);
  e.textContent = 'آخر تحديث للقائمة: ' + (m < 1 ? 'قبل لحظات' : m < 60 ? 'قبل ' + m + ' دقيقة' : m < 1440 ? 'قبل ' + Math.round(m / 60) + ' ساعة' : 'قبل ' + Math.round(m / 1440) + ' يوم');
}
setInterval(updStamp, 30000);

function syncDet() {
  if (!$('det').classList.contains('on')) return;
  const g = games.find(x => x.id === curId);
  if (!g) return closeDet();
  openDet(g, true);
}

const GR = [
  ['#1b365d', '#0d1b2d'],
  ['#264873', '#11243a'],
  ['#334e7d', '#162847'],
  ['#424d7e', '#1c2445'],
  ['#5a4263', '#281d33'],
  ['#6a523b', '#2b2018'],
  ['#244b66', '#102536']
];
const EM = ['🎮', '🕹️', '👾', '🎲', '🧩', '🚀', '🔥'];

let editing: Game | null = null;
let imgData = '';
let filter = 'all';
let favs = new Set<string>();

try {
  favs = new Set(JSON.parse(localStorage.getItem('favs') || '[]'));
} catch (e) {}

const saveFavs = () => {
  try {
    localStorage.setItem('favs', JSON.stringify([...favs]));
  } catch (e) {}
};

const esc = (s: unknown) =>
  String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c));

const steam = (g: Game) => g.link || 'https://store.steampowered.com/search/?term=' + encodeURIComponent(g.name);
const hash = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
const disc = (g: Game) => ((g.old || 0) > g.price ? Math.round((1 - g.price / (g.old || 1)) * 100) : 0);

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(t: string) {
  const e = $('toast');
  e.textContent = t;
  e.classList.add('on');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => e.classList.remove('on'), 2800);
}

// Hero letters
'CO-OP'.split('').forEach((c, i) => {
  const s = document.createElement('i');
  s.textContent = c;
  s.style.animationDelay = (1 + i * 0.08) + 's';
  $('h1').appendChild(s);
});

const ZI = `<svg viewBox="0 0 24 24"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>`;
const heart = () => `<svg viewBox="0 0 24 24"><path d="M12 21s-8-5.2-8-11a4.5 4.5 0 018-2.8A4.5 4.5 0 0120 10c0 5.8-8 11-8 11z"/></svg>`;
const arOf = (g: Game) => (g.img ? Math.min(2.2, Math.max(0.7, +(g.ar || 0.8) || 0.8)) : [0.8, 0.92, 1, 0.86][hash(g.name) % 4]);

function cover(g: Game, withBackdrop = false) {
  const h = hash(g.name), c = GR[h % GR.length];
  const fallbackArt = `<div class="art" style="background:linear-gradient(145deg,${c[0]},${c[1]})"><b>${esc(g.name)}</b><em>${EM[h % EM.length]}</em></div>`;
  if (!g.img) return fallbackArt;
  return `${withBackdrop ? `<div class="bg" style="background-image:url('${esc(g.img)}')"></div>` : ''}<img src="${esc(g.img)}" alt="${esc(g.name)}" referrerpolicy="no-referrer" onerror="this.style.display='none';if(this.nextElementSibling)this.nextElementSibling.hidden=false"><div class="art art-fb" hidden style="background:linear-gradient(145deg,${c[0]},${c[1]})"><b>${esc(g.name)}</b><em>${EM[h % EM.length]}</em></div>`;
}

function renderHeroGroupBar() {
  const bar = $('heroGroupBar');
  const meta = $('hgMeta');
  if (!bar || !meta) return;
  if (!currentSession) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const roleLabel = adminMode ? 'أدمن القروب' : currentSession.isCreatorAdmin ? 'منشئ القروب (متفرج)' : 'عضو مصوّت';
  meta.innerHTML =
    `<div class="hg-primary">` +
      `<span class="hg-item">قروب: <strong>${esc(currentSession.name)}</strong></span>` +
    `</div>` +
    `<div class="hg-sub">` +
      `<span>أنت: <strong>${esc(currentSession.memberName)}</strong></span>` +
      `<span class="sep" aria-hidden="true">·</span>` +
      `<span class="hg-role">${roleLabel}</span>` +
    `</div>`;
}

function render() {
  let a = [...games];
  const q = ($('q') as HTMLInputElement).value.trim().toLowerCase();
  if (q) a = a.filter(g => g.name.toLowerCase().includes(q));
  if (filter === 'sale') a = a.filter(g => disc(g) > 0);
  if (filter === 'fav') a = a.filter(g => favs.has(g.name));
  if (filter === 'votes') a = a.filter(g => vN(g) > 0);

  a.sort((x, y) =>
    filter === 'votes'
      ? vN(y) - vN(x) || (x.order || 0) - (y.order || 0)
      : filter === 'lo'
      ? x.price - y.price
      : filter === 'hi'
      ? y.price - x.price
      : (x.order || 0) - (y.order || 0)
  );

  const maxV = Math.max(0, ...games.map(x => vN(x)));
  const isTopVoted = (g: Game) => maxV > 0 && vN(g) === maxV;

  const card = (g: Game, i: number) => `<div class="item in" data-id="${g.id}">
   <div class="cv${adminMode ? ' has-adm' : ''}" data-o="${g.id}" style="aspect-ratio:${arOf(g)}">${cover(g)}${disc(g) ? `<span class="sale">-${disc(g)}%</span>` : ''}${isTopVoted(g) ? `<span class="top-vote-tag">🔥 متصدرة التصويت</span>` : ''}
   <button class="heart ${favs.has(g.name) ? 'on' : ''}" data-h="${esc(g.name)}" aria-label="مفضلة">${heart()}</button>
   <button class="zoom" data-z="${g.id}" aria-label="تكبير الصورة">${ZI}</button><span class="qv">نظرة سريعة</span>
   ${adminMode ? `<div class="adm"><button data-e="${g.id}">تعديل</button><button class="d" data-d="${g.id}">حذف</button></div>` : ''}</div>
   <div class="meta"><h3>${esc(g.name)}</h3><small>#${g.order || i + 1}${playersOf(g) ? ` · ${esc(playersOf(g))} لاعبين` : ''}</small><div class="pr">${(+g.price).toFixed(2)} SR${disc(g) ? `<s>${(+(g.old || 0)).toFixed(2)} SR</s>` : ''}</div>${voteBtn(g)}</div></div>`;

  if (!a.length) {
    $('grid').innerHTML = `<div class="empty">😴 ما فيه ألعاب مطابقة</div>`;
    buildSizes();
    syncMobileFilterUI(0);
  } else {
    const gs = $('grid');
    const inner = innerW();
    const n = layoutN(inner);
    const cw = (inner - (n - 1) * 30) / n;
    [1, 2, 3, 4].forEach(k => gs.classList.toggle('n' + k, k === n));
    const hs = Array(n).fill(0);
    const bins: string[][] = Array.from({ length: n }, () => []);
    a.forEach((g, i) => {
      const k = hs.indexOf(Math.min(...hs));
      const estAr = window.innerWidth <= 768 ? (n === 2 ? 1.6 : 1.778) : arOf(g);
      bins[k].push(card(g, i));
      hs[k] += cw / estAr + 160;
    });
    buildSizes();
    syncMobileFilterUI(a.length);
    (render as unknown as { cols?: number }).cols = n;
    $('grid').innerHTML = bins.map(b => `<div class="col">${b.join('')}</div>`).join('');
  }
}

on('grid', 'click', (e: MouseEvent) => {
  const target = e.target as HTMLElement;
  const b = target.closest('button');
  if (b) {
    e.stopPropagation();
    e.preventDefault();
    if (b.dataset.v) toggleVote(b.dataset.v, b);
    else if (b.dataset.h) {
      const n = b.dataset.h;
      favs.has(n) ? favs.delete(n) : favs.add(n);
      saveFavs();
      b.classList.toggle('on');
      toast(favs.has(n) ? 'أضيفت للمفضلة ♥' : 'أزيلت من المفضلة');
      if (filter === 'fav') setTimeout(render, 350);
    } else if (b.dataset.e) {
      const gm = games.find(g => g.id === b.dataset.e);
      if (gm) openForm(gm);
    } else if (b.dataset.d) {
      delGame(b.dataset.d);
    }
    return;
  }
  const c = target.closest('[data-o]') as HTMLElement | null;
  if (c && c.dataset.o) {
    const gm = games.find(g => g.id === c.dataset.o);
    if (gm) openDet(gm);
  }
});

let touchTimer: ReturnType<typeof setTimeout> | null = null;
let activeTouchedCard: HTMLElement | null = null;
let touchStartY = 0;
let touchStartX = 0;

document.addEventListener('touchstart', (e: TouchEvent) => {
  if (e.touches.length !== 1) return;
  touchStartX = e.touches[0].clientX;
  touchStartY = e.touches[0].clientY;

  const item = (e.target as HTMLElement).closest('.item') as HTMLElement | null;
  if (!item) {
    if (activeTouchedCard) {
      activeTouchedCard.classList.remove('touched');
      activeTouchedCard = null;
    }
    return;
  }

  if (activeTouchedCard && activeTouchedCard !== item) {
    activeTouchedCard.classList.remove('touched');
  }

  item.classList.add('touched');
  activeTouchedCard = item;

  if (touchTimer) clearTimeout(touchTimer);
  touchTimer = setTimeout(() => {
    item.classList.remove('touched');
    if (activeTouchedCard === item) activeTouchedCard = null;
  }, 2500);
}, { passive: true });

document.addEventListener('touchmove', (e: TouchEvent) => {
  if (!activeTouchedCard || e.touches.length !== 1) return;
  const dy = Math.abs(e.touches[0].clientY - touchStartY);
  const dx = Math.abs(e.touches[0].clientX - touchStartX);
  if (dy > 8 || dx > 8) {
    activeTouchedCard.classList.remove('touched');
    activeTouchedCard = null;
    if (touchTimer) clearTimeout(touchTimer);
  }
}, { passive: true });

window.addEventListener('scroll', () => {
  if (activeTouchedCard) {
    activeTouchedCard.classList.remove('touched');
    activeTouchedCard = null;
    if (touchTimer) clearTimeout(touchTimer);
  }
}, { passive: true });

const luxCornersHTML = () =>
  `<div class="lux-corners" aria-hidden="true"><span class="c-tl"></span><span class="c-tr"></span><span class="c-bl"></span><span class="c-br"></span></div>`;

function getGalleryImages(g: Game): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (src?: string) => {
    const s = (src || '').trim();
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  };
  push(g.img);
  if (Array.isArray(g.screenshots)) {
    g.screenshots.forEach(push);
  }
  return out;
}

function parseTrailerEmbed(url?: string): { type: 'youtube' | 'video'; src: string } | null {
  const raw = (url || '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    let ytId = '';
    if (host === 'youtu.be') {
      ytId = u.pathname.replace(/^\//, '').split('/')[0];
    } else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
      if (u.pathname.startsWith('/embed/')) ytId = u.pathname.split('/')[2] || '';
      else if (u.pathname.startsWith('/shorts/')) ytId = u.pathname.split('/')[2] || '';
      else ytId = u.searchParams.get('v') || '';
    }
    if (ytId) {
      return {
        type: 'youtube',
        src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(ytId)}?autoplay=1&rel=0`
      };
    }
  } catch (e) {}
  if (/^(https?:|data:video\/|blob:|\/)/i.test(raw)) {
    return { type: 'video', src: raw };
  }
  return null;
}

function buildCoverBackedSlides(g: Game): MediaSlide[] {
  const slides: MediaSlide[] = [];
  const imgs = getGalleryImages(g);
  if (imgs.length > 0) {
    imgs.forEach((src, i) => {
      slides.push({
        kind: 'image',
        src,
        imgIdx: i,
        label: i === 0 ? 'غلاف اللعبة' : `لقطة شاشة ${i}`
      });
    });
  } else {
    slides.push({ kind: 'art', label: 'غلاف اللعبة' });
  }

  const trailerInfo = parseTrailerEmbed(g.trailer);
  if (trailerInfo) {
    const poster = (g.trailerPoster || g.img || '').trim();
    slides.push({
      kind: 'trailer',
      trailerType: trailerInfo.type,
      src: trailerInfo.src,
      poster,
      label: 'العرض الدعائي (فيديو)'
    });
  }
  return slides;
}

function buildCoverDeckHTML(g: Game, slides: MediaSlide[]): string {
  const discountPct = disc(g);
  const hasMultiple = slides.length > 1;
  const prevBtn = hasMultiple
    ? `<button type="button" class="g-nav-ext prev" aria-label="السابق"><svg viewBox="0 0 24 24"><polyline points="9 6 15 12 9 18"/></svg></button>`
    : '';
  const nextBtn = hasMultiple
    ? `<button type="button" class="g-nav-ext next" aria-label="التالي"><svg viewBox="0 0 24 24"><polyline points="15 6 9 12 15 18"/></svg></button>`
    : '';

  const firstSlide = slides[0];
  const h = hash(g.name);
  const c = GR[h % GR.length];

  let initialStage = '';
  if (firstSlide.kind === 'image') {
    initialStage = `<div class="cv-frame" data-zoom-trigger="1">
        <div class="bg" style="background-image:url('${esc(firstSlide.src)}')"></div>
        <img class="g-main-img" src="${esc(firstSlide.src)}" alt="${esc(g.name)}" referrerpolicy="no-referrer">
      </div>
      <button type="button" class="zoom" data-z="${g.id}" data-gallery="1" aria-label="تكبير الصورة">${ZI}</button>`;
  } else {
    initialStage = `<div class="art" style="background:linear-gradient(145deg,${c[0]},${c[1]})"><b>${esc(g.name)}</b><em>${EM[h % EM.length]}</em></div>`;
  }

  const thumbs = hasMultiple
    ? `<div class="gallery-thumbs-wrap"><div class="gallery-thumbs">${slides
        .map((sl, idx) => {
          if (sl.kind === 'trailer') {
            const thumbImg = sl.poster || g.img || '';
            return `<button type="button" class="g-thumb is-trailer${idx === 0 ? ' active' : ''}" data-idx="${idx}" aria-label="${esc(sl.label)}" aria-pressed="${idx === 0 ? 'true' : 'false'}">
              ${thumbImg
                ? `<img src="${esc(thumbImg)}" alt="${esc(sl.label)}" referrerpolicy="no-referrer" loading="lazy">`
                : `<div style="width:100%;height:100%;background:linear-gradient(135deg,${c[0]},${c[1]})"></div>`}
              <span class="g-thumb-play" aria-hidden="true"><svg viewBox="0 0 24 24"><polygon points="7 4 20 12 7 20 7 4"/></svg></span>
            </button>`;
          }
          if (sl.kind === 'image') {
            return `<button type="button" class="g-thumb${idx === 0 ? ' active' : ''}" data-idx="${idx}" aria-label="${esc(sl.label)}" aria-pressed="${idx === 0 ? 'true' : 'false'}"><img src="${esc(sl.src)}" alt="${esc(g.name)} - ${idx + 1}" referrerpolicy="no-referrer" loading="lazy"></button>`;
          }
          return `<button type="button" class="g-thumb${idx === 0 ? ' active' : ''}" data-idx="${idx}" aria-label="${esc(sl.label)}" aria-pressed="${idx === 0 ? 'true' : 'false'}"><div style="width:100%;height:100%;background:linear-gradient(135deg,${c[0]},${c[1]})"></div></button>`;
        })
        .join('')}</div></div>`
    : '';

  return `<div class="gallery-showcase lux-card" data-active-idx="0" data-active-img-idx="0">
    ${luxCornersHTML()}
    <div class="deck-stage-row">
      ${prevBtn}
      <div class="gallery-main">
        <div class="deck-stage-content" id="deckStageContent" style="width:100%;height:100%">
          ${initialStage}
        </div>
        ${discountPct ? `<span class="sale">-${discountPct}%</span>` : ''}
        ${hasMultiple ? `<div class="gallery-counter">1 / ${slides.length}</div>` : ''}
      </div>
      ${nextBtn}
    </div>
    ${thumbs}
  </div>`;
}

function wireCoverDeck(container: HTMLElement | null, g: Game, slides: MediaSlide[]) {
  if (!container || slides.length === 0) return;
  const showcase = container.querySelector('.gallery-showcase') as HTMLElement | null;
  if (!showcase) return;
  const stage = showcase.querySelector('#deckStageContent') as HTMLElement | null;
  const counterEl = showcase.querySelector('.gallery-counter') as HTMLElement | null;
  const thumbBtns = [...showcase.querySelectorAll('.g-thumb')] as HTMLButtonElement[];
  const h = hash(g.name);
  const c = GR[h % GR.length];

  let activeIdx = 0;

  const stopRunningVideo = () => {
    if (!stage) return;
    const vid = stage.querySelector('video') as HTMLVideoElement | null;
    if (vid) {
      try {
        vid.pause();
        vid.removeAttribute('src');
      } catch (e) {}
    }
    const iframe = stage.querySelector('iframe');
    if (iframe) iframe.remove();
  };

  const renderSlide = (idx: number) => {
    if (!stage) return;
    stopRunningVideo();
    activeIdx = ((idx % slides.length) + slides.length) % slides.length;
    const sl = slides[activeIdx];
    showcase.dataset.activeIdx = String(activeIdx);
    showcase.dataset.activeImgIdx = sl.kind === 'image' ? String(sl.imgIdx) : '0';

    if (counterEl) {
      counterEl.textContent = `${activeIdx + 1} / ${slides.length}`;
    }

    thumbBtns.forEach((btn, bIdx) => {
      const isAct = bIdx === activeIdx;
      btn.classList.toggle('active', isAct);
      btn.setAttribute('aria-pressed', isAct ? 'true' : 'false');
      if (isAct) {
        btn.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
      }
    });

    if (sl.kind === 'image') {
      stage.innerHTML = `<div class="cv-frame" data-zoom-trigger="1">
          <div class="bg" style="background-image:url('${esc(sl.src)}')"></div>
          <img class="g-main-img" src="${esc(sl.src)}" alt="${esc(g.name)}" referrerpolicy="no-referrer">
        </div>
        <button type="button" class="zoom" data-z="${g.id}" data-gallery="1" aria-label="تكبير الصورة">${ZI}</button>`;

      const frame = stage.querySelector('[data-zoom-trigger="1"]') as HTMLElement | null;
      if (frame) {
        frame.onclick = () => openLb(g.id, showcase.querySelector('.gallery-main') as HTMLElement, sl.imgIdx);
      }
    } else if (sl.kind === 'art') {
      stage.innerHTML = `<div class="art" style="background:linear-gradient(145deg,${c[0]},${c[1]})"><b>${esc(g.name)}</b><em>${EM[h % EM.length]}</em></div>`;
    } else {
      const posterVisual = sl.poster
        ? `<img src="${esc(sl.poster)}" alt="${esc(g.name)} trailer" referrerpolicy="no-referrer">`
        : `<div class="art" style="background:linear-gradient(145deg,${c[0]},${c[1]})"><b>${esc(g.name)}</b></div>`;
      stage.innerHTML = `<div class="trailer-slide" id="dtrailer">
        <div class="trailer-poster" id="dtrailerBtn" role="button" tabindex="0" aria-label="تشغيل العرض الدعائي">
          ${posterVisual}
          <div class="trailer-scrim">
            <span class="trailer-play"><svg viewBox="0 0 24 24"><polygon points="7 4 20 12 7 20 7 4"/></svg></span>
            <span class="trailer-caption">تشغيل العرض الدعائي</span>
          </div>
        </div>
      </div>`;

      const startTrailer = () => {
        const box = $('dtrailer');
        if (!box) return;
        box.innerHTML =
          sl.trailerType === 'youtube'
            ? `<iframe class="trailer-player" src="${esc(sl.src)}" title="${esc(g.name)} Trailer" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`
            : `<video class="trailer-player" src="${esc(sl.src)}" ${sl.poster ? `poster="${esc(sl.poster)}"` : ''} controls autoplay playsinline></video>`;
      };
      const tBtn = $('dtrailerBtn');
      if (tBtn) {
        tBtn.onclick = startTrailer;
        tBtn.onkeydown = (ev: KeyboardEvent) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            startTrailer();
          }
        };
      }
    }
  };

  // Wire initial slide click-to-zoom if cover is an image
  const initialFrame = showcase.querySelector('[data-zoom-trigger="1"]') as HTMLElement | null;
  if (initialFrame) {
    initialFrame.onclick = () => openLb(g.id, showcase.querySelector('.gallery-main') as HTMLElement, 0);
  }

  thumbBtns.forEach(btn => {
    btn.onclick = (e: MouseEvent) => {
      e.stopPropagation();
      const idx = +(btn.dataset.idx || 0);
      if (idx !== activeIdx) renderSlide(idx);
    };
  });

  const prevBtn = showcase.querySelector('.g-nav-ext.prev') as HTMLButtonElement | null;
  const nextBtn = showcase.querySelector('.g-nav-ext.next') as HTMLButtonElement | null;
  if (prevBtn) prevBtn.onclick = (e: MouseEvent) => { e.stopPropagation(); renderSlide(activeIdx - 1); };
  if (nextBtn) nextBtn.onclick = (e: MouseEvent) => { e.stopPropagation(); renderSlide(activeIdx + 1); };
}

function openDet(g: Game, keep?: boolean) {
  if (!g) return;
  curId = g.id;
  if (!keep) void trackInteraction('details', currentSession?.code);
  const detEl = $('det');
  detEl.classList.toggle('nr', !!keep);

  let ambientEl = detEl.querySelector('.det-ambient') as HTMLElement | null;
  if (!ambientEl) {
    ambientEl = document.createElement('div');
    ambientEl.className = 'det-ambient';
    detEl.insertBefore(ambientEl, detEl.firstChild);
  }
  ambientEl.style.backgroundImage = g.img ? `url('${g.img}')` : 'none';

  const o = [...games].sort((a, b) => (a.order || 0) - (b.order || 0));
  const k = o.findIndex(x => x.id === g.id);
  const rel = [...o.slice(k + 1), ...o.slice(0, k)].slice(0, 12);
  relIds = rel.map(r => r.id);
  const url = esc(steam(g));

  const slides = buildCoverBackedSlides(g);

  const kickerParts = ['لعبة جماعية', 'CO-OP'];
  if (g.order) kickerParts.push(`#${g.order}`);
  if (playersOf(g)) kickerParts.push(`${esc(playersOf(g))} لاعبين`);
  const kickerHtml = kickerParts.map(p => `<span>${p}</span>`).join('<span class="sep">·</span>');

  const leadText = g.desc ? esc(g.desc) : goalOf(g) ? esc(goalOf(g)) : 'تجربة لعب جماعية مميزة مع أصدقائك عبر ستيم.';
  const discountPct = disc(g);
  const priceHtml = `<span>${(+g.price).toFixed(2)} SR</span>${discountPct ? `<s>${(+(g.old || 0)).toFixed(2)} SR</s><span class="det-disc-txt">خصم ${discountPct}%</span>` : ''}`;

  const shareIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg>`;
  const steamIcon = `<svg viewBox="0 0 24 24" class="steam-ico" aria-hidden="true"><path fill="currentColor" d="M11.979 0C5.678 0 .511 4.86.022 11.037l6.432 2.658c.545-.371 1.203-.59 1.912-.59.063 0 .125.004.188.006l2.861-4.142V8.91c0-2.495 2.028-4.524 4.524-4.524 2.494 0 4.524 2.029 4.524 4.524s-2.03 4.524-4.524 4.524h-.105l-4.076 2.811c0 .052.005.105.005.159 0 1.875-1.515 3.396-3.39 3.396-1.635 0-3.016-1.173-3.331-2.727L.436 14.819C1.94 20.05 6.705 24 12 24c6.627 0 12-5.373 12-12S18.627 0 11.979 0zM7.54 18.216c-.98 0-1.774-.794-1.774-1.774 0-.413.142-.793.38-1.096l1.966.812a1.764 1.764 0 0 0 1.202 2.058c-.538.165-1.115.148-1.774 0zm8.4-7.078c-1.255 0-2.272-1.018-2.272-2.273s1.017-2.273 2.272-2.273c1.256 0 2.273 1.018 2.273 2.273 0 1.255-1.017 2.273-2.273 2.273zm-4.708 6.002a2.02 2.02 0 0 1-1.396.586c-1.115 0-2.02-.904-2.02-2.02 0-.256.05-.499.138-.724l2.126.88a1.01 1.01 0 0 0 1.152 1.278z"/></svg>`;
  const arrowIcon = `<svg viewBox="0 0 24 24" class="arr-ico" aria-hidden="true"><path d="M19 12H5M12 19l-7-7 7-7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  $('dg').innerHTML = `
  <div class="dt">
    <div class="det-kicker">${kickerHtml}</div>
    <h2>${esc(g.name)}</h2>
    ${adminMode ? `<div class="abx"><button class="sbtn" id="de">تعديل اللعبة</button><button class="sbtn" id="dc">تكرار</button><button class="sbtn del" id="dd">حذف</button></div>` : ''}
    <p class="det-lead">${leadText}</p>
    <div class="pr">${priceHtml}</div>
    <div class="det-actions">
      <a class="btn btn-primary-lux steam-cta" href="${url}" target="_blank" rel="noopener">
        ${steamIcon}
        <span>افتح في ستيم</span>
        ${arrowIcon}
      </a>
      ${voteBtn(g, true)}
      <button type="button" class="det-share" id="dshare">${shareIcon}<span>مشاركة اللعبة</span></button>
    </div>
    <div id="dvn" class="vn"></div>
  </div>
  <div class="dl">
    ${buildCoverDeckHTML(g, slides)}
  </div>`;

  wireCoverDeck($('dg'), g, slides);

  const goalMain = goalOf(g) ? esc(goalOf(g)) : 'ما أضيف هدف لهذي اللعبة بعد.';
  const showDescSub = g.desc && goalOf(g) && g.desc.trim() !== goalOf(g).trim();
  const goalCard = `<div class="blk lux-card" data-dpanel="goal">
    ${luxCornersHTML()}
    <h4>هدف اللعبة وتفاصيلها</h4>
    <p>${goalMain}</p>
    ${showDescSub ? `<p class="blk-sub">${esc(g.desc)}</p>` : ''}
  </div>`;

  const infoCard = `<div class="info lux-card" data-dpanel="info">
    ${luxCornersHTML()}
    <div class="info-title"><span>معلومات اللعبة</span><small>CO-OP · STEAM</small></div>
    <div class="info-row"><span>عدد اللاعبين</span><b dir="ltr">${esc(playersOf(g) || '-')}</b></div>
    <div class="info-row"><span>الترتيب</span><b>#${g.order || '-'}</b></div>
    <div class="info-row"><span>الخصم</span><b>${discountPct ? discountPct + '%' : 'بدون'}</b></div>
    <div class="info-row"><span>المنصة</span><b>Steam</b></div>
    ${g.sp ? `<div class="info-row"><span>تقييم ستيم</span><b>${esc(g.sp)}% إيجابي</b></div>` : ''}
  </div>`;

  const quickCard = adminMode
    ? `<div class="steam qe lux-card" data-dpanel="quick">${luxCornersHTML()}<h4>تعديل سريع</h4><div class="row"><div><label>السعر</label><input id="qp" type="number" step="0.01" value="${g.price}"></div><div><label>قبل الخصم</label><input id="qo" type="number" step="0.01" value="${g.old || ''}"></div></div><label>عدد اللاعبين</label><input id="qpl" value="${esc(playersOf(g))}"><label>هدف اللعبة</label><textarea id="qg" rows="3">${esc(goalOf(g))}</textarea><button class="btn btn-primary-lux" id="qs" style="margin-top:14px;width:100%">حفظ التعديلات</button></div>`
    : '';

  const detTabsHTML = `<div class="det-tabs" role="tablist" aria-label="أقسام التفاصيل">
    <button type="button" class="det-tab on" data-dtab="goal" role="tab" aria-selected="true">الوصف والهدف</button>
    <button type="button" class="det-tab" data-dtab="info" role="tab" aria-selected="false">المعلومات</button>
    ${adminMode ? `<button type="button" class="det-tab" data-dtab="quick" role="tab" aria-selected="false">تعديل سريع</button>` : ''}
  </div>`;

  const dinfoEl = $('dinfo');
  dinfoEl.dataset.activeTab = 'goal';
  dinfoEl.innerHTML = `${detTabsHTML}<div class="det-cards-grid">${goalCard}${infoCard}</div>${quickCard}`;

  dinfoEl.querySelectorAll('.det-tab').forEach(tb => {
    (tb as HTMLButtonElement).onclick = () => {
      const targetTab = (tb as HTMLElement).dataset.dtab || 'goal';
      dinfoEl.dataset.activeTab = targetTab;
      dinfoEl.querySelectorAll('.det-tab').forEach(other => {
        const on = other === tb;
        other.classList.toggle('on', on);
        other.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    };
  });

  $('dg').querySelectorAll('.dt,.dl').forEach(c => [...c.children].forEach((x, i) => (x as HTMLElement).style.setProperty('--i', String(i))));
  $('dx').innerHTML = `<div class="sec"><div class="sh"><h3>ألعاب أخرى قد تعجبك</h3><div class="sizes" id="sizes2"></div></div><div class="relw" id="relw"><button class="rarr rl" id="rnl" aria-label="التالي"><svg viewBox="0 0 24 24"><polyline points="15 6 9 12 15 18"/></svg></button><div class="rel" id="rel"></div><button class="rarr rr" id="rpr" aria-label="السابق"><svg viewBox="0 0 24 24"><polyline points="9 6 15 12 9 18"/></svg></button></div></div>`;

  buildRel();
  buildSizes();
  $('rel').onscroll = relArrows;
  $('rnl').onclick = () => relGo(-1);
  $('rpr').onclick = () => relGo(1);

  const shareBtn = $('dshare');
  if (shareBtn) {
    shareBtn.onclick = async () => {
      const shareUrl = g.link || location.href;
      try {
        await navigator.clipboard.writeText(shareUrl);
        shareBtn.classList.add('copied');
        const lbl = shareBtn.querySelector('span');
        if (lbl) lbl.textContent = 'تم نسخ الرابط';
        toast('تم نسخ رابط اللعبة بنجاح');
        setTimeout(() => {
          shareBtn.classList.remove('copied');
          if (lbl) lbl.textContent = 'مشاركة اللعبة';
        }, 2200);
      } catch (e) {
        toast('انسخ الرابط من المتصفح للمشاركة');
      }
    };
  }

  if (adminMode && currentSession) {
    const code = currentSession.code;
    $('de').onclick = () => openForm(g);
    $('dd').onclick = () => delGame(g.id);
    $('dc').onclick = async () => {
      const { id: _oldId, ...rest } = g;
      const newId = 'g_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const duplicated: Game = { ...rest, id: newId, name: g.name + ' (نسخة)', order: games.length + 1 };
      saveGamesToLocal([duplicated, ...games]);
      await commit(async () => {
        let synced = false;
        try {
          await upsertGroupGameInFirebase(code, duplicated);
          synced = true;
        } catch (e) {}
        if (backendAvailable) {
          try {
            const res = await fetch(`/api/groups/${code}/games`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(duplicated)
            });
            if (res.status === 404) backendAvailable = false;
            else if (res.ok) synced = true;
          } catch (e) {}
        }
        if (!synced) throw new Error('offline');
      }, 'تم تكرار اللعبة', 'تم التكرار محلياً');
    };
    $('qs').onclick = async () => {
      const qUpdates: Partial<Game> = {
        price: +($('qp') as HTMLInputElement).value || 0,
        old: +($('qo') as HTMLInputElement).value || 0,
        players: ($('qpl') as HTMLInputElement).value.trim(),
        goal: ($('qg') as HTMLTextAreaElement).value.trim()
      };
      const idx = games.findIndex(x => x.id === g.id);
      if (idx < 0) return;
      const updatedGame: Game = { ...games[idx], ...qUpdates };
      games[idx] = updatedGame;
      saveGamesToLocal([...games]);
      await commit(async () => {
        let synced = false;
        try {
          await upsertGroupGameInFirebase(code, updatedGame);
          synced = true;
        } catch (e) {}
        if (backendAvailable) {
          try {
            const res = await fetch(`/api/groups/${code}/games/${g.id}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(qUpdates)
            });
            if (res.status === 404) backendAvailable = false;
            else if (res.ok) synced = true;
          } catch (e) {}
        }
        if (!synced) throw new Error('offline');
      }, 'تم تحديث اللعبة عند الجميع');
    };
  }

  $('dv').onclick = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    toggleVote(g.id, $('dv'));
  };
  refreshDetVote();

  detEl.classList.add('on');
  if (!keep) detEl.scrollTo({ top: 0, behavior: 'smooth' });
  document.body.classList.add('det-open');
}

on('dx', 'click', (e: MouseEvent) => {
  const target = e.target as HTMLElement;
  const z = target.closest('.sz') as HTMLElement | null;
  if (z && z.dataset.n) return relPref(+z.dataset.n, z);
  const ed = target.closest('[data-e]') as HTMLElement | null;
  if (ed && ed.dataset.e) {
    const gm = games.find(g => g.id === ed.dataset.e);
    if (gm) return openForm(gm);
  }
  const c = target.closest('[data-o]') as HTMLElement | null;
  if (c && c.dataset.o) {
    const gm = games.find(g => g.id === c.dataset.o);
    if (gm) openDet(gm);
  }
});

const closeDet = () => {
  const det = $('det');
  const vid = det?.querySelector('video') as HTMLVideoElement | null;
  if (vid) {
    try {
      vid.pause();
    } catch (e) {}
  }
  const iframe = det?.querySelector('iframe');
  if (iframe) iframe.remove();
  det?.classList.remove('on');
  document.body.classList.remove('det-open');
  document.body.style.overflow = '';
  syncMobNav();
};
on('bk', 'click', closeDet);

on('bs', 'click', () => {
  setMobileFilterMenu(false);
  $('sbar')?.classList.toggle('on');
  if ($('sbar')?.classList.contains('on')) setTimeout(() => $('q')?.focus(), 300);
});
on('q', 'input', render);

const FILTER_LABELS: Record<string, string> = {
  all: 'الكل',
  sale: 'العروض',
  fav: 'المفضلة',
  lo: 'الأرخص',
  hi: 'الأغلى',
  votes: 'الأكثر تصويتاً'
};

function setMobileFilterMenu(open: boolean) {
  const menu = $('mobFilterMenu');
  const btn = $('mobFilterBtn');
  if (!menu || !btn) return;
  menu.hidden = !open;
  menu.classList.toggle('on', open);
  btn.classList.toggle('on', open);
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function syncMobileFilterUI(visibleCount?: number) {
  const curEl = $('mobFilterCurrent');
  if (curEl) curEl.textContent = FILTER_LABELS[filter] || 'الكل';

  document.querySelectorAll('#mobFilterMenu .mf-opt').forEach(opt => {
    const el = opt as HTMLElement;
    const isAct = el.dataset.mf === filter;
    el.classList.toggle('on', isAct);
    if (el.getAttribute('role') === 'menuitemradio') {
      el.setAttribute('aria-checked', isAct ? 'true' : 'false');
    }
  });

  const activeCols = layoutN(innerW());
  document.querySelectorAll('#mobSizeBtns .mf-sz').forEach(btn => {
    const el = btn as HTMLElement;
    el.classList.toggle('on', +(el.dataset.n || 0) === activeCols);
  });

  const countEl = $('mobCount');
  if (countEl && typeof visibleCount === 'number') {
    countEl.textContent = visibleCount === 0
      ? 'لا توجد نتائج'
      : visibleCount === 1
      ? 'لعبة واحدة'
      : visibleCount === 2
      ? 'لعبتان'
      : visibleCount <= 10
      ? `${visibleCount} ألعاب`
      : `${visibleCount} لعبة`;
  }
}

on('mobFilterBtn', 'click', (e: MouseEvent) => {
  e.stopPropagation();
  const menu = $('mobFilterMenu');
  if (!menu) return;
  setMobileFilterMenu(!menu.classList.contains('on'));
});

on('mobFilterMenu', 'click', (e: MouseEvent) => {
  const target = e.target as HTMLElement;
  const fBtn = target.closest('.mf-opt') as HTMLElement | null;
  if (fBtn) {
    if (fBtn.id === 'mfVoteOpt') {
      setMobileFilterMenu(false);
      openVP();
      return;
    }
    const nextF = fBtn.dataset.mf || 'all';
    filter = nextF;
    document.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', (c as HTMLElement).dataset.f === nextF));
    setMobileFilterMenu(false);
    render();
    return;
  }

  const sBtn = target.closest('.mf-sz') as HTMLElement | null;
  if (sBtn && sBtn.dataset.n) {
    pref = +sBtn.dataset.n;
    try {
      localStorage.setItem('cols_v3', String(pref));
    } catch (err) {}
    setMobileFilterMenu(false);
    const gs = $('grid');
    gs.classList.add('swap');
    setTimeout(() => {
      (render as unknown as { done?: boolean }).done = false;
      render();
      gs.classList.remove('swap');
      setTimeout(() => { (render as unknown as { done?: boolean }).done = true; }, 1500);
    }, 220);
  }
});

document.addEventListener('click', (e: MouseEvent) => {
  const wrap = $('mobFilterWrap');
  const menu = $('mobFilterMenu');
  if (!wrap || !menu || menu.hidden) return;
  if (!wrap.contains(e.target as Node)) {
    setMobileFilterMenu(false);
  }
});

on('chips', 'click', (e: MouseEvent) => {
  const b = (e.target as HTMLElement).closest('.chip') as HTMLElement | null;
  if (!b) return;
  if (b.id === 'vchip') return openVP();
  filter = b.dataset.f || 'all';
  document.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c === b));
  render();
});

const themeNow = () => document.documentElement.dataset.theme || 'dark';

function setTheme(t: string) {
  document.documentElement.dataset.theme = t;
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.setAttribute('content', t === 'light' ? '#f2f5fa' : '#08111f');
  try {
    localStorage.setItem('theme', t);
  } catch (e) {}
  document.querySelectorAll('.tseg').forEach(x => {
    x.classList.toggle('dark', t === 'dark');
    x.querySelectorAll('button').forEach(b => b.classList.toggle('on', (b as HTMLElement).dataset.t === t));
  });
}

function toggleTheme(ev: { currentTarget?: EventTarget | null; clientX?: number; clientY?: number }, want?: string) {
  if (want && want === themeNow()) return;
  const next = want || (themeNow() === 'dark' ? 'light' : 'dark');
  const targetEl = ev && ev.currentTarget ? (ev.currentTarget as HTMLElement) : null;
  const b = targetEl ? targetEl.getBoundingClientRect() : null;
  const hasPointerXY = typeof ev?.clientX === 'number' && typeof ev?.clientY === 'number' && (ev.clientX > 0 || ev.clientY > 0);
  const baseX = b ? b.left + b.width / 2 : hasPointerXY ? ev.clientX! : innerWidth / 2;
  const baseY = b ? b.top + b.height / 2 : hasPointerXY ? ev.clientY! : innerHeight / 2;
  const vv = window.visualViewport;
  const x = Math.round(baseX + (vv ? vv.offsetLeft : 0));
  const y = Math.round(baseY + (vv ? vv.offsetTop : 0));
  const h = document.documentElement;

  const docWithTransition = document as Document & {
    startViewTransition?: (cb: () => void) => { ready: Promise<void> };
  };
  if (docWithTransition.startViewTransition && !matchMedia('(prefers-reduced-motion:reduce)').matches) {
    try {
      const vt = docWithTransition.startViewTransition(() => setTheme(next));
      vt.ready.then(() => {
        const vw = vv ? vv.width : innerWidth;
        const vh = vv ? vv.height : innerHeight;
        const r = Math.hypot(Math.max(x, vw - x), Math.max(y, vh - y));
        h.animate(
          { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
          { duration: 780, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', pseudoElement: '::view-transition-new(root)' }
        );
      }).catch(() => {});
      return;
    } catch (e) {}
  }
  h.classList.add('tm');
  setTheme(next);
  setTimeout(() => h.classList.remove('tm'), 900);
}

function buildMenu() {
  const dk = themeNow() === 'dark';

  const closeIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>`;
  const chevIcon = `<svg class="mrow-chv" viewBox="0 0 24 24" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>`;
  const shareIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/><line x1="15.4" y1="6.5" x2="8.6" y2="10.5"/></svg>`;
  const switchIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 014-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>`;
  const addIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>`;
  const eyeIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>`;
  const keyIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>`;
  const installIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0l-4-4m4 4l4-4"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg>`;
  const leaveIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`;

  const headerHTML = `<div class="menu-head">
    <div class="menu-title">القائمة</div>
    <button type="button" class="menu-close" data-act="close" aria-label="إغلاق القائمة">${closeIcon}</button>
  </div>`;

  const roleLabel = currentSession
    ? adminMode
      ? 'أدمن القروب'
      : currentSession.isCreatorAdmin
      ? 'متفرج'
      : 'عضو'
    : '';

  const grpCard = currentSession
    ? `<div class="menu-grp-card">
      <div class="menu-grp-top">
        <div class="menu-grp-title">${esc(currentSession.name)}</div>
        <span class="menu-grp-role">${roleLabel}</span>
      </div>
      <div class="menu-grp-meta">
        <span>الأدمن: <b>${esc(currentSession.adminName)}</b></span>
        <span aria-hidden="true">·</span>
        <span>أنت: <b>${esc(currentSession.memberName)}</b></span>
      </div>
      <div class="menu-grp-actions">
        <button type="button" data-act="gshare">${shareIcon}<span>مشاركة الرابط</span></button>
        <button type="button" data-act="gswitch">${switchIcon}<span>تبديل القروب</span></button>
      </div>
    </div>`
    : `<div class="menu-grp-card" hidden></div>`;

  const themeHTML = `<div class="trow"><span>المظهر</span><div class="tseg${dk ? ' dark' : ''}"><i class="pill"></i><button data-act="theme" data-t="light" class="${dk ? '' : 'on'}" aria-label="المظهر الفاتح"><svg class="sn" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>فاتح</button><button data-act="theme" data-t="dark" class="${dk ? 'on' : ''}" aria-label="المظهر الداكن"><svg class="mn" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/></svg>داكن</button></div></div>`;

  const rowBtn = (label: string, idx: number, act: string, icon: string, extraCls = '') =>
    `<button type="button" class="mrow${extraCls}" style="--i:${idx}" data-act="${act}"><span class="mrow-ico" aria-hidden="true">${icon}</span><span class="mrow-lbl">${label}</span>${chevIcon}</button>`;

  const actionRows: string[] = [];
  if (adminMode) {
    actionRows.push(rowBtn('إضافة لعبة جديدة', 0, 'add', addIcon));
    actionRows.push(rowBtn('عرض كمتفرج', 1, 'out', eyeIcon));
  } else {
    actionRows.push(rowBtn('دخول كأدمن القروب', 0, 'adminpin', keyIcon));
  }
  if (!isPwaInstalled) {
    actionRows.push(rowBtn('تثبيت التطبيق على جهازك', actionRows.length, 'install', installIcon));
  }

  const controlsHTML = `<div class="menu-sec">
    <div class="menu-sec-lbl">${adminMode ? 'إدارة القروب' : 'خيارات القروب'}</div>
    <div class="menu-group">${actionRows.join('')}</div>
  </div>`;

  const footerHTML = currentSession
    ? `<div class="menu-foot">${rowBtn('خروج من القروب', actionRows.length + 1, 'gleave', leaveIcon, ' danger')}</div>`
    : '';

  $('menu').innerHTML = `<div class="mw">${headerHTML}${grpCard}${themeHTML}${controlsHTML}${footerHTML}</div>`;
}

function drawer(on: boolean) {
  if (on) {
    setMobileFilterMenu(false);
    buildMenu();
  }
  $('menu').classList.toggle('on', on);
  $('shade').classList.toggle('on', on);
  $('bm').classList.toggle('on', on);
  document.body.classList.toggle('menu-open', on);
  syncMobNav();
}

on('shade', 'click', () => drawer(false));
on('bm', 'click', () => drawer(!$('menu')?.classList.contains('on')));

on('menu', 'click', (e: MouseEvent) => {
  const b = (e.target as HTMLElement).closest('button');
  if (!b) return;
  const a = b.dataset.act;
  if (a === 'close') {
    drawer(false);
  } else if (a === 'install') {
    drawer(false);
    triggerPwaInstall();
  } else if (a === 'theme') {
    toggleTheme({ currentTarget: b, clientX: e.clientX, clientY: e.clientY }, b.dataset.t);
  } else if (a === 'add') {
    drawer(false);
    openForm();
  } else if (a === 'gshare') {
    drawer(false);
    openGroupShareModal();
  } else if (a === 'gswitch') {
    drawer(false);
    openGate('join');
  } else if (a === 'adminpin') {
    drawer(false);
    openAdminPinDialog();
  } else if (a === 'out') {
    drawer(false);
    setAdmin(false);
    toast('أنت الحين تشوف القروب مثل أصدقائك 👁️');
  } else if (a === 'gleave') {
    drawer(false);
    leaveCurrentGroup();
  }
});

function setAdmin(on: boolean) {
  adminMode = on && !!currentSession;
  document.body.classList.toggle('admin-active', adminMode);
  renderHeroGroupBar();
  render();
  syncDet();
}

/* ===== Admin Number & Share Modals ===== */
function openAdminPinDialog() {
  if (!currentSession) return;
  if (currentSession.isCreatorAdmin && currentSession.adminPin) {
    setAdmin(true);
    toast('تم تفعيل وضع أدمن القروب 🔐');
    return;
  }
  const inp = $('gaPin') as HTMLInputElement | null;
  if (inp) inp.value = '';
  ($('gadlg') as HTMLDialogElement | null)?.showModal();
  inp?.focus();
}

on('gax', 'click', () => ($('gadlg') as HTMLDialogElement | null)?.close());

on('gaf', 'submit', async (e: SubmitEvent) => {
  e.preventDefault();
  if (!currentSession) return;
  const pinInput = ($('gaPin') as HTMLInputElement).value.trim();
  if (!pinInput) return toast('أدخل رقم الآدمن');

  const code = currentSession.code;
  let verified = false;

  try {
    const grp = await getGroupFromFirebase(code);
    if (grp) {
      const hUpper = await sha256Hex(grp.adminPinSalt + pinInput.toUpperCase());
      const hRaw = await sha256Hex(grp.adminPinSalt + pinInput);
      if (hUpper === grp.adminPinHash || hRaw === grp.adminPinHash) {
        verified = true;
      }
    }
  } catch (err) {}

  if (!verified && backendAvailable) {
    try {
      const res = await fetch(`/api/groups/${code}/admin-verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminPin: pinInput })
      });
      if (res.ok) verified = true;
    } catch (err) {}
  }

  if (!verified) {
    const localGrp = getLocalGroupsRegistry()[code];
    if (localGrp) {
      const hUpper = await sha256Hex(localGrp.adminPinSalt + pinInput.toUpperCase());
      const hRaw = await sha256Hex(localGrp.adminPinSalt + pinInput);
      if (hUpper === localGrp.adminPinHash || hRaw === localGrp.adminPinHash) verified = true;
    }
  }

  if (verified) {
    saveSession({ ...currentSession, isCreatorAdmin: true, adminPin: pinInput.toUpperCase() });
    setAdmin(true);
    ($('gadlg') as HTMLDialogElement).close();
    toast('تم التحقق من رقم الآدمن — مرحباً بك 🔐');
  } else {
    toast('رقم الآدمن غير صحيح');
  }
});

function buildInviteLink(code: string): string {
  const u = new URL(location.href);
  u.searchParams.set('group', code);
  u.hash = '';
  return u.toString();
}

function openGroupShareModal() {
  if (!currentSession) return;
  $('gsGroupName').textContent = `قروب: ${currentSession.name}`;
  ($('gsLink') as HTMLInputElement).value = buildInviteLink(currentSession.code);

  const nativeShareBtn = $('gsNativeShare');
  if (nativeShareBtn) {
    nativeShareBtn.hidden = typeof navigator.share !== 'function';
  }

  const pinRow = $('gsPinRow');
  if (currentSession.isCreatorAdmin && currentSession.adminPin) {
    pinRow.hidden = false;
    $('gsAdminPin').textContent = currentSession.adminPin;
  } else {
    pinRow.hidden = true;
  }
  ($('gsdlg') as HTMLDialogElement | null)?.showModal();
}

on('gsClose', 'click', () => ($('gsdlg') as HTMLDialogElement | null)?.close());
on('gsCopyLink', 'click', async () => {
  if (!currentSession) return;
  const link = buildInviteLink(currentSession.code);
  try {
    await navigator.clipboard.writeText(link);
    toast('تم نسخ رابط المشاركة 🔗');
  } catch (e) {
    toast('انسخ الرابط من الحقل أعلاه');
  }
});
on('gsNativeShare', 'click', async () => {
  if (!currentSession || typeof navigator.share !== 'function') return;
  const link = buildInviteLink(currentSession.code);
  try {
    await navigator.share({
      title: `Co-Op | ${currentSession.name}`,
      text: `انضم لقروب "${currentSession.name}" وصوّت للألعاب معنا:`,
      url: link
    });
  } catch (e) {}
});
on('gsCopyPin', 'click', async () => {
  if (!currentSession?.adminPin) return;
  try {
    await navigator.clipboard.writeText(currentSession.adminPin);
    toast('تم نسخ رقم الآدمن 🔐');
  } catch (e) {}
});

on('hgShare', 'click', openGroupShareModal);
on('hgCreate', 'click', () => openGate('create'));
on('hgJoin', 'click', () => openGate('join'));

let mobSleepTimer: ReturnType<typeof setTimeout> | null = null;

function positionMobPill() {
  const nav = $('mobNav');
  const pill = $('mobPill');
  if (!nav || !pill || window.innerWidth > 768) return;
  const active = nav.querySelector('.mob-tab.on') as HTMLElement | null;
  if (!active || active.offsetWidth === 0) return;
  pill.style.width = `${active.offsetWidth}px`;
  pill.style.transform = `translateX(${active.offsetLeft}px)`;
  pill.classList.add('ready');
}

function canMobNavSleep(): boolean {
  if (window.innerWidth > 768) return false;
  if ($('menu')?.classList.contains('on')) return false;
  if ($('vp')?.classList.contains('on')) return false;
  if ($('det')?.classList.contains('on')) return false;
  if (document.body.classList.contains('gate-open')) return false;
  if ($('mobFilterMenu')?.classList.contains('on')) return false;
  return true;
}

function wakeMobNav(holdLonger = false) {
  const nav = $('mobNav');
  if (!nav) return;
  const wasSleeping = nav.classList.contains('sleeping');
  nav.classList.remove('sleeping');
  if (wasSleeping) requestAnimationFrame(positionMobPill);
  if (mobSleepTimer) clearTimeout(mobSleepTimer);
  mobSleepTimer = setTimeout(() => {
    if (canMobNavSleep()) {
      nav.classList.add('sleeping');
    }
  }, holdLonger ? 4500 : 3200);
}

window.addEventListener('scroll', () => wakeMobNav(), { passive: true });
document.addEventListener('touchstart', () => wakeMobNav(), { passive: true });
document.addEventListener('pointerdown', () => wakeMobNav(), { passive: true });

function syncMobNav() {
  const nav = $('mobNav');
  if (!nav) return;
  const menuOpen = $('menu')?.classList.contains('on');
  const vpOpen = $('vp')?.classList.contains('on');
  const activeTab = menuOpen ? 'menu' : vpOpen ? 'votes' : 'games';
  nav.querySelectorAll('.mob-tab').forEach(btn => {
    btn.classList.toggle('on', (btn as HTMLElement).dataset.mtab === activeTab);
  });
  wakeMobNav();
  requestAnimationFrame(positionMobPill);
}

on('mobNav', 'click', (e: MouseEvent) => {
  const btn = (e.target as HTMLElement).closest('.mob-tab') as HTMLElement | null;
  if (!btn) return;
  wakeMobNav(true);
  const tab = btn.dataset.mtab;
  if (tab === 'games') {
    drawer(false);
    closeVP();
    closeDet();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    syncMobNav();
  } else if (tab === 'votes') {
    drawer(false);
    closeDet();
    openVP();
  } else if (tab === 'share') {
    drawer(false);
    if (currentSession) openGroupShareModal();
    else openGate('join');
  } else if (tab === 'menu') {
    closeVP();
    drawer(!$('menu')?.classList.contains('on'));
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    setMobileFilterMenu(false);
    if ($('vp').classList.contains('on')) {
      closeVP();
      return;
    }
    closeDet();
    drawer(false);
  }
});

function setImg(d: string, ar?: number) {
  imgData = d;
  imgAr = ar || 0.8;
  $('pz').innerHTML = d
    ? `<img src="${d}" alt="">`
    : `<span>📋 الصق الصورة هنا (Ctrl+V)<br><small>أو اضغط لاختيار ملف، أو اسحبها</small></span>`;
}

function openForm(g?: Game) {
  if (!adminMode) return toast('التعديل متاح لأدمن القروب فقط');
  editing = g || null;
  $('dt').textContent = g ? 'تعديل لعبة' : 'إضافة لعبة';
  ($('fn') as HTMLInputElement).value = g ? g.name : '';
  ($('fp') as HTMLInputElement).value = g ? String(g.price) : '';
  ($('fo') as HTMLInputElement).value = g && g.old ? String(g.old) : '';
  ($('fl') as HTMLInputElement).value = g ? g.link || '' : '';
  ($('fr') as HTMLInputElement).value = g ? String(g.order || games.length + 1) : String(games.length + 1);
  ($('fpl') as HTMLInputElement).value = g ? playersOf(g) : '';
  ($('fg') as HTMLTextAreaElement).value = g ? goalOf(g) : '';
  ($('ftr') as HTMLInputElement).value = g ? g.trailer || '' : '';
  ($('fpo') as HTMLInputElement).value = g ? g.trailerPoster || '' : '';
  ($('fss') as HTMLTextAreaElement).value = g && Array.isArray(g.screenshots) ? g.screenshots.join('\n') : '';
  ($('fi') as HTMLInputElement).value = '';
  const fssi = $('fssi') as HTMLInputElement | null;
  if (fssi) fssi.value = '';
  const dlgExtra = $('dlgExtra') as HTMLDetailsElement | null;
  const dlgExtraBadge = $('dlgExtraBadge');
  const mediaCount = (g?.trailer ? 1 : 0) + (Array.isArray(g?.screenshots) ? g.screenshots.length : 0);
  if (dlgExtra) dlgExtra.open = false;
  if (dlgExtraBadge) dlgExtraBadge.textContent = mediaCount ? `${mediaCount} مرفقات` : '';
  setImg(g ? g.img || '' : '', g ? g.ar : 0);
  ($('dlg') as HTMLDialogElement).showModal();
}

on('cx', 'click', () => ($('dlg') as HTMLDialogElement | null)?.close());
on('dlgX', 'click', () => ($('dlg') as HTMLDialogElement | null)?.close());

function resizeBlobToJpeg(f: Blob, maxDim = 760): Promise<{ dataUrl: string; ar: number }> {
  return new Promise(resolve => {
    const u = URL.createObjectURL(f);
    const im = new Image();
    im.onload = () => {
      const m = Math.min(1, maxDim / Math.max(im.width, im.height));
      const w = Math.round(im.width * m);
      const h = Math.round(im.height * m);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d')?.drawImage(im, 0, 0, w, h);
      resolve({ dataUrl: c.toDataURL('image/jpeg', 0.82), ar: w / h });
      URL.revokeObjectURL(u);
    };
    im.onerror = () => {
      URL.revokeObjectURL(u);
      resolve({ dataUrl: '', ar: 0.8 });
    };
    im.src = u;
  });
}

function procBlob(f: Blob) {
  resizeBlobToJpeg(f, 760).then(({ dataUrl, ar }) => {
    if (dataUrl) setImg(dataUrl, ar);
  });
}

on('fi', 'change', (e: Event) => {
  const inp = e.target as HTMLInputElement;
  if (inp.files && inp.files[0]) procBlob(inp.files[0]);
});
if ($('fssBtn') && $('fssi')) {
  on('fssBtn', 'click', () => ($('fssi') as HTMLInputElement | null)?.click());
  on('fssi', 'change', async (e: Event) => {
    const inp = e.target as HTMLInputElement;
    const files = inp.files;
    if (!files || !files.length) return;
    const area = $('fss') as HTMLTextAreaElement;
    const added: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (!f.type.startsWith('image/')) continue;
      const { dataUrl } = await resizeBlobToJpeg(f, 820);
      if (dataUrl) added.push(dataUrl);
    }
    if (added.length) {
      const cur = area.value.trim();
      area.value = cur ? cur + '\n' + added.join('\n') : added.join('\n');
      toast(`تمت إضافة ${added.length} لقطة شاشة`);
    }
    inp.value = '';
  });
}
on('pz', 'click', () => $('fi')?.click());
on('pz', 'dragover', e => e.preventDefault());
on('pz', 'drop', (e: DragEvent) => {
  e.preventDefault();
  const f = e.dataTransfer?.files[0];
  if (f && f.type.startsWith('image/')) procBlob(f);
});

document.addEventListener('paste', e => {
  if (!($('dlg') as HTMLDialogElement | null)?.open) return;
  const items = e.clipboardData ? e.clipboardData.items : [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].type.startsWith('image/')) {
      e.preventDefault();
      const file = items[i].getAsFile();
      if (file) procBlob(file);
      toast('تم لصق الصورة ✅');
      break;
    }
  }
});

on('f', 'submit', async (e: SubmitEvent) => {
  e.preventDefault();
  if (!adminMode || !currentSession) return;
  const code = currentSession.code;
  const rawScreenshots = ($('fss') as HTMLTextAreaElement).value
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 10);

  const d: Partial<Game> = {
    name: ($('fn') as HTMLInputElement).value.trim(),
    price: +($('fp') as HTMLInputElement).value || 0,
    old: +($('fo') as HTMLInputElement).value || 0,
    link: ($('fl') as HTMLInputElement).value.trim(),
    order: +($('fr') as HTMLInputElement).value || games.length + 1,
    img: imgData,
    ar: imgData ? +imgAr.toFixed(3) : 0,
    players: ($('fpl') as HTMLInputElement).value.trim(),
    goal: ($('fg') as HTMLTextAreaElement).value.trim(),
    trailer: ($('ftr') as HTMLInputElement).value.trim(),
    trailerPoster: ($('fpo') as HTMLInputElement).value.trim(),
    screenshots: rawScreenshots
  };

  ($('dlg') as HTMLDialogElement).close();

  const curEditing = editing;
  let savedGame: Game;
  if (curEditing) {
    const idx = games.findIndex(g => g.id === curEditing.id);
    savedGame = { ...games[idx], ...d, id: curEditing.id } as Game;
    if (idx >= 0) games[idx] = savedGame;
  } else {
    const newId = 'g_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    savedGame = { ...d, id: newId } as Game;
    games.unshift(savedGame);
  }
  saveGamesToLocal([...games]);

  await commit(async () => {
    let synced = false;
    try {
      await upsertGroupGameInFirebase(code, savedGame);
      synced = true;
    } catch (err) {}
    if (backendAvailable) {
      try {
        const res = curEditing
          ? await fetch(`/api/groups/${code}/games/${curEditing.id}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(d)
            })
          : await fetch(`/api/groups/${code}/games`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(savedGame)
            });
        if (res.status === 404) backendAvailable = false;
        else if (res.ok) synced = true;
      } catch (err) {}
    }
    if (!synced) throw new Error('offline');
  }, 'تم الحفظ وتحدّثت اللعبة عند أعضاء القروب');
});

/* ===== Votes ===== */
function burst(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  for (let i = 0; i < 16; i++) {
    const d = document.createElement('i');
    d.className = 'pt';
    const a = (i / 16) * 6.283;
    const m = 38 + Math.random() * 45;
    const h = 25 + Math.random() * 45;
    d.style.cssText = `left:${r.left + r.width / 2}px;top:${r.top + r.height / 2}px;--x:${Math.cos(a) * m}px;--y:${Math.sin(a) * m}px;background:hsl(${h},95%,62%);box-shadow:0 0 10px hsl(${h},95%,62%)`;
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 800);
  }
}

let isVoting = false;
async function toggleVote(id: string, btn?: HTMLElement) {
  if (!currentSession) {
    openGate('join');
    return toast('ادخل إلى قروب أولاً للتصويت');
  }
  if (isVoting) return;
  isVoting = true;

  const code = currentSession.code;
  const memberName = currentSession.memberName;
  const n = new Set(myV);
  const wasVoted = n.has(id);
  if (wasVoted) {
    n.delete(id);
    playSound('unvote');
    if (btn) {
      btn.classList.add('pop-press');
      setTimeout(() => btn.classList.remove('pop-press'), 380);
    }
  } else {
    if (n.size >= 3) {
      isVoting = false;
      return toast('أقصى حد 3 أصوات، يمكنك إلغاء صوت واختيار غيره');
    }
    n.add(id);
    playSound('vote');
    if (btn) {
      btn.classList.add('pop-press');
      setTimeout(() => btn.classList.remove('pop-press'), 380);
      burst(btn);
      flyVote(btn, games.find(x => x.id === id));
    }
  }

  myV = n;
  syncLocalVotesSummary();
  if (filter === 'votes') render();
  else updVoteUI();
  refreshDetVote();
  if ($('vp').classList.contains('on')) renderVP(false);

  // Real-time group vote sync to Firestore
  try {
    await syncUserGroupVoteToFirebase(code, uid, [...n], memberName);
  } catch (e) {}

  if (backendAvailable) {
    try {
      const res = await fetch(`/api/groups/${code}/votes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid, v: [...n], name: memberName })
      });
      if (res.status === 404) {
        backendAvailable = false;
      }
      toast(!wasVoted ? 'وصل صوتك لباقي القروب ✅' : 'تم سحب صوتك');
    } catch (e) {
      toast(!wasVoted ? 'وصل صوتك بنجاح ✅' : 'تم سحب صوتك');
    } finally {
      setTimeout(() => { isVoting = false; }, 400);
    }
  } else {
    toast(!wasVoted ? 'وصل صوتك بنجاح ✅' : 'تم سحب صوتك');
    setTimeout(() => { isVoting = false; }, 400);
  }
}

function refreshDetVote() {
  const b = $('dv');
  if (!b || !$('det').classList.contains('on')) return;
  const id = b.dataset.v as string;
  const g = games.find(x => x.id === id);
  if (!g) return;
  b.classList.toggle('on', myV.has(id));
  const txt = b.querySelector('.v-txt');
  if (txt) txt.textContent = myV.has(id) ? 'اخترتها' : 'أبي ألعبها';
  const num = b.querySelector('.v-num') || b.querySelector('b');
  if (num) num.textContent = String(vN(g));

  // Show voter names to ALL group members
  const dv = $('dvn');
  if (votes[id] && votes[id].n > 0) {
    const names = votes[id].names.length ? votes[id].names.map(esc).join('، ') : `${votes[id].n} أصوات`;
    dv.innerHTML = `المصوّتون في القروب (${votes[id].n}): <span>${names}</span>`;
  } else {
    dv.textContent = '';
  }
}

function updVoteUI() {
  document.querySelectorAll('.cb').forEach(c => {
    (c as HTMLElement).textContent = String(myV.size || '');
    (c as HTMLElement).style.display = myV.size ? 'inline-block' : 'none';
  });
  const mfVcb = $('mfVcb');
  if (mfVcb) {
    mfVcb.textContent = myV.size ? String(myV.size) : '';
  }
  const nb = $('nb');
  if (nb) {
    nb.textContent = String(myV.size);
    nb.classList.toggle('z', !myV.size);
  }
  const mobVb = $('mobVb');
  if (mobVb) {
    mobVb.textContent = String(myV.size);
    mobVb.classList.toggle('z', !myV.size);
  }
  document.querySelectorAll('.vote').forEach(btn => {
    const el = btn as HTMLElement;
    const id = el.dataset.v;
    if (!id) return;
    const g = games.find(x => x.id === id);
    if (!g) return;
    const isVoted = myV.has(id);
    el.classList.toggle('on', isVoted);
    const txt = el.querySelector('.v-txt');
    if (txt) txt.textContent = isVoted ? 'اخترتها' : 'أبي ألعبها';
    const num = el.querySelector('.v-num') || el.querySelector('b');
    if (num) num.textContent = String(vN(g));
  });
}

function spark(x: number, y: number) {
  const d = document.createElement('i');
  d.className = 'pt';
  const a = Math.random() * 6.283, m = 14 + Math.random() * 24, z = 4 + Math.random() * 5;
  d.style.cssText = `left:${x}px;top:${y}px;width:${z}px;height:${z}px;--x:${Math.cos(a) * m}px;--y:${Math.sin(a) * m}px;background:hsl(${20 + Math.random() * 40},95%,62%)`;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 700);
}

function ring(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  const z = Math.max(r.width, r.height);
  const d = document.createElement('i');
  d.className = 'ring';
  d.style.cssText = `left:${r.left + r.width / 2 - z / 2}px;top:${r.top + r.height / 2 - z / 2}px;width:${z}px;height:${z}px`;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 900);
}

function hit(t: HTMLElement) {
  ring(t);
  burst(t);
  const hitTarget = (t.closest('.mob-tab') as HTMLElement | null) || t;
  hitTarget.classList.remove('hit');
  void hitTarget.offsetWidth;
  hitTarget.classList.add('hit');
  document.querySelectorAll('.cb,#nb,#mobVb').forEach(x => {
    x.classList.remove('pop2');
    void (x as HTMLElement).offsetWidth;
    x.classList.add('pop2');
  });
}

function flyVote(btn: HTMLElement, g?: Game) {
  if (!g || $('det').classList.contains('on') || matchMedia('(prefers-reduced-motion:reduce)').matches) return;
  if (window.innerWidth <= 768) wakeMobNav(true);
  const item = btn.closest('.item');
  const cv = item ? (item.querySelector('.cv') as HTMLElement | null) : null;
  if (!cv) return;
  const r = cv.getBoundingClientRect();
  const navEl = document.querySelector('nav') as HTMLElement | null;
  const navB = window.innerWidth <= 768 ? 0 : Math.max(0, navEl ? navEl.getBoundingClientRect().bottom : 0);
  const vis = Math.min(r.bottom, innerHeight) - Math.max(r.top, navB);
  if (vis < r.height * 0.45) return;
  const el = document.createElement('div');
  el.className = 'fly';
  el.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
  el.innerHTML = cover(g);
  document.body.appendChild(el);

  const pick = () => {
    if ($('det').classList.contains('on')) return $('dvt');
    if (window.innerWidth <= 768) {
      const mobVoteIco = document.querySelector('#mobNav [data-mtab="votes"] .mob-tab-ico') as HTMLElement | null;
      const mobVoteTab = document.querySelector('#mobNav [data-mtab="votes"]') as HTMLElement | null;
      if (mobVoteIco && mobVoteIco.getBoundingClientRect().width > 0) return mobVoteIco;
      if (mobVoteTab && mobVoteTab.getBoundingClientRect().width > 0) return mobVoteTab;
    }
    if (innerWidth > 768) {
      const nv = (document.querySelector('nav') as HTMLElement).getBoundingClientRect();
      const c = $('vchip').getBoundingClientRect();
      if (c.top > nv.bottom && c.bottom < innerHeight && c.left >= 0 && c.right <= innerWidth) return $('vchip');
    }
    return $('bv');
  };

  const pt = (e: HTMLElement) => {
    const b = e.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  };

  const S = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  const w = r.width;
  const dur = 1000;
  const lift = Math.min(115, Math.abs(pt(pick()).y - S.y) * 0.25 + 48);

  let tgt = pick();
  const D = pt(tgt);
  const t0 = performance.now();
  let last = 0;

  const step = (now: number) => {
    const p = Math.min(1, (now - t0) / dur);
    tgt = pick();
    const T = pt(tgt);
    const k = p > 0.8 ? 1 : 0.25;
    D.x += (T.x - D.x) * k;
    D.y += (T.y - D.y) * k;
    const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
    const x = S.x + (D.x - S.x) * e;
    const y = S.y + (D.y - S.y) * e - lift * 4 * e * (1 - e);
    const sc = (26 + (w - 26) * Math.pow(1 - e, 2.4)) / w;
    const a = Math.sin(e * Math.PI * 2) * 8;
    el.style.transform = `translate(${x - S.x}px,${y - S.y}px) scale(${sc}) rotate(${a}deg)`;
    el.style.opacity = p > 0.88 ? String(1 - ((p - 0.88) / 0.12) * 0.7) : '1';
    if (now - last > 40) {
      last = now;
      spark(x, y);
    }
    if (p < 1) requestAnimationFrame(step);
    else {
      el.remove();
      hit(tgt);
    }
  };
  requestAnimationFrame(step);
}

function renderVP(anim?: boolean) {
  const a = games.filter(g => vN(g) > 0).sort((x, y) => vN(y) - vN(x) || (x.order || 0) - (y.order || 0));
  const mx = a.length ? vN(a[0]) : 1;

  const grpLabel = currentSession ? `قروب ${currentSession.name} · ` : '';
  $('vps').textContent = a.length ? `${grpLabel}${vTotal} صوّتوا · عندك ${myV.size} من 3 أصوات` : grpLabel.replace(/ · $/, '');
  $('vpl').innerHTML = a.length
    ? a.map((g, i) => {
        const voterNames = (votes[g.id]?.names || []).map(esc);
        const namesLine = voterNames.length ? `<p class="vnm">المصوّتون: ${voterNames.join('، ')}</p>` : '';
        return `<div class="vi${myV.has(g.id) ? ' me' : ''}${anim ? ' an' : ''}" style="--d:${i * 80}ms"><span class="vrk">${i + 1}</span><b>${esc(g.name)}</b><em>${vN(g)}</em><div class="vbar"><i style="--w:${(vN(g) / mx) * 100}%"></i></div>${namesLine}</div>`;
      }).join('')
    : `<p class="vemp">ما أحد صوّت في القروب للحين.<br>كن أول واحد يختار لعبته.</p>`;

  $('vpa').innerHTML = a.length || adminMode
    ? `<div class="row">${a.length ? `<button class="btn" id="vcp" style="flex:1;padding:12px">نسخ الملخص</button>` : ''}${adminMode ? `<button class="btn out" id="vrs" style="padding:12px 18px">تصفير</button>` : ''}</div>`
    : '';

  const vcp = $('vcp');
  if (vcp) {
    vcp.onclick = async () => {
      const t = a.map((g, i) => `${i + 1}. ${g.name}: ${vN(g)} (${(votes[g.id]?.names || []).join('، ')})`).join('\n');
      navigator.clipboard?.writeText(t)
        .then(() => toast('تم نسخ الملخص'))
        .catch(() => toast('ما قدرت أنسخ'));
    };
  }

  if (adminMode && currentSession) {
    const code = currentSession.code;
    const vrs = $('vrs');
    if (vrs) {
      vrs.onclick = async () => {
        if (!(await askC('تصفير كل الأصوات في هذا القروب؟'))) return;
        if (backendAvailable) {
          try {
            await fetch(`/api/groups/${code}/votes/reset`, { method: 'POST' });
          } catch (e) {}
        }
        try {
          await resetGroupFirebaseVotes(code);
        } catch (e) {}
        votes = {};
        myV.clear();
        saveGroupVotesCache();
        renderVP(false);
        render();
        toast('تم تصفير أصوات القروب');
      };
    }
  }
}

function openVP() {
  renderVP(true);
  $('vp').classList.add('on');
  syncMobNav();
}
function closeVP() {
  $('vp').classList.remove('on');
  syncMobNav();
}

on('vpx', 'click', closeVP);
on('vp', 'click', (e: MouseEvent) => {
  if ((e.target as HTMLElement).id === 'vp') closeVP();
});
on('bv', 'click', openVP);
on('dvt', 'click', openVP);

/* ===== Lightbox ===== */
type LbItem = { id: string; name: string; sub: string; img: string; ar: number };
let lbI = 0;
let lbList: LbItem[] = [];
let lbMode: 'games' | 'gallery' = 'games';
let lbReady = false;
let zoomed = false;
let lbBusy = false;

function lbFill(item: LbItem) {
  const h = hash(item.name);
  const c = GR[h % GR.length];
  const inner = item.img
    ? `<div class="bg" style="background-image:url('${esc(item.img)}')"></div><img src="${esc(item.img)}" alt="${esc(item.name)}" referrerpolicy="no-referrer">`
    : `<div class="art" style="background:linear-gradient(145deg,${c[0]},${c[1]})"><b>${esc(item.name)}</b><em>${EM[h % EM.length]}</em></div>`;
  $('lbs').innerHTML = `<div class="cv lbimg" id="lbimg" style="--ar:${item.ar};aspect-ratio:${item.ar}"><div class="zin">${inner}</div><span class="glare"></span></div>`;
  $('lbc').innerHTML = `<b>${esc(item.name)}</b><span>${esc(item.sub)}</span>`;
  $('lbcnt').textContent = `${lbI + 1} / ${lbList.length}`;
  $('lbamb').style.backgroundImage = item.img ? `url('${esc(item.img)}')` : 'none';
  $('lbamb').style.backgroundColor = item.img ? 'transparent' : c[0];
  zoomed = false;
}

function lbSrcFor(item: LbItem) {
  if ($('det').classList.contains('on')) {
    if (lbMode === 'gallery') {
      return document.querySelector('#dg .gallery-main') as HTMLElement;
    }
    return curId === item.id
      ? ((document.querySelector('#dg .gallery-main') || document.querySelector('#dg .cv')) as HTMLElement)
      : (document.querySelector(`#dx .rc[data-o="${item.id}"] .cv`) as HTMLElement);
  }
  return document.querySelector(`#grid .cv[data-o="${item.id}"]`) as HTMLElement;
}

function openLb(id: string, src?: HTMLElement, galleryIdx?: number) {
  if (typeof galleryIdx === 'number') {
    const g = games.find(x => x.id === id);
    const imgs = g ? getGalleryImages(g) : [];
    if (g && imgs.length) {
      lbMode = 'gallery';
      lbList = imgs.map((imgUrl, idx) => ({
        id: g.id,
        name: g.name,
        sub: idx === 0 ? 'غلاف اللعبة' : `لقطة ${idx} من ${imgs.length - 1}`,
        img: imgUrl,
        ar: idx === 0 ? arOf(g) : 1.6
      }));
      lbI = Math.max(0, Math.min(galleryIdx, lbList.length - 1));
    } else {
      lbMode = 'games';
    }
  } else {
    lbMode = 'games';
  }

  if (lbMode === 'games') {
    lbList = [...games]
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map(g => ({
        id: g.id,
        name: g.name,
        sub: `${(+g.price).toFixed(2)} SR${disc(g) ? ` · -${disc(g)}%` : ''}`,
        img: g.img || '',
        ar: arOf(g)
      }));
    lbI = Math.max(0, lbList.findIndex(x => x.id === id));
  }

  lbFill(lbList[lbI]);
  lbReady = false;
  lbBusy = false;
  $('lb').classList.add('on');
  const el = $('lbimg');
  el.style.transition = 'none';
  el.style.transform = '';
  if (src) {
    const r = src.getBoundingClientRect();
    const t = el.getBoundingClientRect();
    el.style.transform = `translate(${r.left + r.width / 2 - (t.left + t.width / 2)}px,${r.top + r.height / 2 - (t.top + t.height / 2)}px) scale(${r.width / t.width})`;
  } else {
    el.style.opacity = '0';
    el.style.transform = 'scale(.82)';
  }
  void el.getBoundingClientRect();
  el.style.transition = 'transform .8s cubic-bezier(.2,.9,.2,1),opacity .5s';
  el.style.transform = '';
  el.style.opacity = '1';
  setTimeout(() => { lbReady = true; }, 800);
}

function closeLb() {
  if (!$('lb').classList.contains('on')) return;
  const item = lbList[lbI];
  const el = $('lbimg');
  const src = item ? lbSrcFor(item) : null;
  lbReady = false;
  const zin = el.querySelector('.zin') as HTMLElement | null;
  if (zin) zin.style.transform = '';
  zoomed = false;
  el.style.transition = 'none';
  el.style.transform = '';

  const t = el.getBoundingClientRect();
  const r = src && src.getBoundingClientRect();
  let tr = '';
  if (r && r.width > 0 && r.bottom > 0 && r.top < innerHeight) {
    tr = `translate(${r.left + r.width / 2 - (t.left + t.width / 2)}px,${r.top + r.height / 2 - (t.top + t.height / 2)}px) scale(${r.width / t.width})`;
  } else {
    tr = 'scale(.85)';
    el.style.opacity = '0';
  }
  void el.getBoundingClientRect();
  el.style.transition = 'transform .65s cubic-bezier(.7,0,.2,1),opacity .5s';
  el.style.transform = tr;
  $('lb').classList.remove('on');
  setTimeout(() => {
    if (!$('lb').classList.contains('on')) $('lbs').innerHTML = '';
  }, 800);
}

function setOrigin(e: MouseEvent) {
  const el = $('lbimg');
  const r = el.getBoundingClientRect();
  const c = (v: number) => Math.max(0, Math.min(100, v));
  const zin = el.querySelector('.zin') as HTMLElement | null;
  if (zin) zin.style.transformOrigin = `${c(((e.clientX - r.left) / r.width) * 100)}% ${c(((e.clientY - r.top) / r.height) * 100)}%`;
}

function setZoom(on: boolean, e?: MouseEvent) {
  const el = $('lbimg');
  if (!el || !lbReady) return;
  zoomed = on;
  const zin = el.querySelector('.zin') as HTMLElement | null;
  if (!zin) return;
  if (on) {
    if (e) setOrigin(e);
    el.style.transition = 'transform .4s';
    el.style.transform = '';
    zin.style.transform = 'scale(2.4)';
    el.classList.add('zm');
  } else {
    zin.style.transform = '';
    el.classList.remove('zm');
  }
}

function lbGo(d: number) {
  if (!lbReady || lbBusy || lbList.length < 2) return;
  lbBusy = true;
  const el = $('lbimg');
  const dir = d > 0 ? -1 : 1;
  el.style.transition = 'none';
  el.style.transform = '';
  el.animate(
    [{ transform: 'none', opacity: 1 }, { transform: `translateX(${dir * 100}px) rotateY(${dir * -20}deg) scale(.88)`, opacity: 0 }],
    { duration: 250, easing: 'ease-in', fill: 'forwards' }
  ).onfinish = () => {
    lbI = (lbI + d + lbList.length) % lbList.length;
    lbFill(lbList[lbI]);
    lbBusy = false;
    $('lbimg').animate(
      [{ transform: `translateX(${-dir * 100}px) rotateY(${dir * 20}deg) scale(.88)`, opacity: 0 }, { transform: 'none', opacity: 1 }],
      { duration: 520, easing: 'cubic-bezier(.2,.9,.2,1)' }
    );
    $('lbc').animate([{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'none' }], { duration: 480 });
  };
}

document.addEventListener('click', (e: MouseEvent) => {
  const z = (e.target as HTMLElement).closest('.zoom') as HTMLElement | null;
  if (z && z.dataset.z) {
    e.stopPropagation();
    e.preventDefault();
    if (z.dataset.gallery === '1') {
      const showcase = z.closest('.gallery-showcase') as HTMLElement | null;
      const idx = +(showcase?.dataset.activeImgIdx || 0);
      openLb(z.dataset.z, (z.closest('.gallery-main') || showcase) as HTMLElement, idx);
    } else {
      openLb(z.dataset.z, z.closest('.cv') as HTMLElement);
    }
  }
}, true);

on('lbx', 'click', closeLb);
on('lbb', 'click', closeLb);
on('lbnx', 'click', () => lbGo(1));
on('lbp', 'click', () => lbGo(-1));
on('lbs', 'click', (e: MouseEvent) => {
  if ((e.target as HTMLElement).closest('#lbimg')) setZoom(!zoomed, e);
  else closeLb();
});

on('lb', 'mousemove', (e: MouseEvent) => {
  if (!lbReady || lbBusy) return;
  const el = $('lbimg');
  if (!el) return;
  if (zoomed) {
    setOrigin(e);
    return;
  }
  const px = e.clientX / innerWidth - 0.5;
  const py = e.clientY / innerHeight - 0.5;
  el.style.transition = 'transform .25s ease-out';
  el.style.transform = `rotateY(${px * 16}deg) rotateX(${-py * 16}deg)`;
  el.style.setProperty('--gx', (px + 0.5) * 100 + '%');
  el.style.setProperty('--gy', (py + 0.5) * 100 + '%');
});

$('lb')?.addEventListener('wheel', (e: WheelEvent) => {
  e.preventDefault();
  const onZoom = e.deltaY < 0;
  if (onZoom !== zoomed) setZoom(onZoom);
}, { passive: false });

let tx0 = 0;
$('lb')?.addEventListener('touchstart', (e: TouchEvent) => {
  tx0 = e.touches[0].clientX;
}, { passive: true });
$('lb')?.addEventListener('touchend', (e: TouchEvent) => {
  const d = e.changedTouches[0].clientX - tx0;
  if (Math.abs(d) > 60 && !zoomed) lbGo(d < 0 ? 1 : -1);
}, { passive: true });

addEventListener('keydown', (e: KeyboardEvent) => {
  if (!$('lb').classList.contains('on')) return;
  if (e.key === 'Escape') {
    e.stopImmediatePropagation();
    closeLb();
  } else if (e.key === 'ArrowLeft') lbGo(1);
  else if (e.key === 'ArrowRight') lbGo(-1);
  else if (e.key === 'Enter' || e.key === '+') setZoom(!zoomed);
}, true);

let rt: ReturnType<typeof setTimeout>;
addEventListener('resize', () => {
  clearTimeout(rt);
  rt = setTimeout(() => {
    if (layoutN(innerW()) !== (render as unknown as { cols?: number }).cols) render();
    else buildSizes();
    relArrows();
    positionMobPill();
  }, 200);
});

on('sizes', 'click', (e: MouseEvent) => {
  const b = (e.target as HTMLElement).closest('.sz') as HTMLElement | null;
  if (!b || !b.dataset.n) return;
  pref = +b.dataset.n;
  try {
    localStorage.setItem('cols_v3', String(pref));
  } catch (err) {}
  document.querySelectorAll('.sz').forEach(x => x.classList.toggle('on', x === b));
  b.classList.remove('pop');
  void b.offsetWidth;
  b.classList.add('pop');
  const gs = $('grid');
  gs.classList.add('swap');
  setTimeout(() => {
    (render as unknown as { done?: boolean }).done = false;
    render();
    gs.classList.remove('swap');
    setTimeout(() => { (render as unknown as { done?: boolean }).done = true; }, 1500);
  }, 280);
});

function gamesEqual(a: Game[], b: Game[]): boolean {
  if (a.length !== b.length) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function applyGamesUpdate(newGames: Game[], newLastT: number) {
  if (games.length > 0 && gamesEqual(newGames, games)) return;

  const prevMap = new Map(games.map(g => [g.id, JSON.stringify(g)]));
  const changedIds: string[] = [];
  newGames.forEach(ng => {
    const prevStr = prevMap.get(ng.id);
    if (!prevStr || prevStr !== JSON.stringify(ng)) {
      changedIds.push(ng.id);
    }
  });

  saveGamesToLocal(newGames);
  lastT = newLastT || Date.now();
  updStamp();

  if (changedIds.length > 0 && prevMap.size > 0) {
    changedIds.forEach(id => {
      const el = document.querySelector(`.item[data-id="${id}"]`);
      if (el) {
        el.classList.remove('flash');
        void (el as HTMLElement).offsetWidth;
        el.classList.add('flash');
      }
    });
  }
}

function applyVotesUpdate(newSummary: VoteSummary, newTotal: number, namesList?: string[]) {
  votes = newSummary || {};
  vTotal = newTotal || 0;
  if (Array.isArray(namesList)) groupMemberNames = namesList;
  const myIds: string[] = [];
  for (const [gid, voteInfo] of Object.entries(votes)) {
    if (voteInfo.uids && voteInfo.uids.includes(uid)) myIds.push(gid);
  }
  myV = new Set(myIds);
  saveGroupVotesCache();
  if (filter === 'votes') render();
  else updVoteUI();
  refreshDetVote();
  if ($('vp').classList.contains('on')) renderVP(false);
}

/* ===== Group Subscriptions & Synchronization ===== */
function teardownGroupSync() {
  if (unsubGroupGames) {
    unsubGroupGames();
    unsubGroupGames = null;
  }
  if (unsubGroupVotes) {
    unsubGroupVotes();
    unsubGroupVotes = null;
  }
  if (sseSource) {
    sseSource.close();
    sseSource = null;
  }
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

function removeLocalGroupEntries(code: string) {
  try {
    const reg = getLocalGroupsRegistry();
    if (reg[code]) {
      delete reg[code];
      localStorage.setItem('coop_local_groups', JSON.stringify(reg));
    }
    localStorage.removeItem(`coop_group_games_${code}`);
    localStorage.removeItem(`coop_group_myv_${code}`);
    localStorage.removeItem(`coop_group_votes_${code}`);
  } catch (e) {}
}

function handleRemoteGroupDeleted(code: string) {
  removeLocalGroupEntries(code);
  if (currentSession && currentSession.code === code) {
    teardownGroupSync();
    closeDet();
    saveSession(null);
    adminMode = false;
    games = [];
    votes = {};
    myV = new Set();
    vTotal = 0;
    renderHeroGroupBar();
    try {
      const u = new URL(location.href);
      u.searchParams.delete('group');
      history.replaceState(null, '', u.toString());
    } catch (e) {}
    openGate('create');
  }
  toast('تم حذف هذا القروب من قِبل مطور الموقع');
}

async function fetchGroupGamesFromBackend(code: string) {
  try {
    const res = await fetch(`/api/groups/${code}/games`);
    if (res.status === 410) {
      handleRemoteGroupDeleted(code);
      return;
    }
    if (res.ok) {
      const data = await res.json();
      backendAvailable = true;
      if (Array.isArray(data.games) && data.games.length > 0) {
        applyGamesUpdate(data.games, data.lastUpdated);
      }
    } else if (res.status === 404) {
      // Group might live in Firebase only
    }
  } catch (e) {
    backendAvailable = false;
  }
}

async function fetchGroupVotesFromBackend(code: string) {
  if (!backendAvailable) return;
  try {
    const res = await fetch(`/api/groups/${code}/votes`);
    if (res.ok) {
      const data = await res.json();
      applyVotesUpdate(data.summary, data.totalVoters, data.memberNames);
    }
  } catch (e) {}
}

function setupGroupSSE(code: string) {
  if (!backendAvailable) return;
  try {
    if (sseSource) sseSource.close();
    sseSource = new EventSource(`/api/events?group=${encodeURIComponent(code)}`);
    sseSource.addEventListener('games', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        if (Array.isArray(data.games)) applyGamesUpdate(data.games, data.lastUpdated);
      } catch (err) {}
    });
    sseSource.addEventListener('votes', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        applyVotesUpdate(data.summary, data.totalVoters, data.memberNames);
      } catch (err) {}
    });
    sseSource.addEventListener('group_deleted', () => {
      handleRemoteGroupDeleted(code);
    });
    sseSource.onerror = () => {
      if (!backendAvailable && sseSource) {
        sseSource.close();
      }
    };
  } catch (e) {}
}

async function enterGroup(session: GroupSession) {
  teardownGroupSync();
  closeDet();
  saveSession(session);
  adminMode = session.isCreatorAdmin;

  // Update browser URL cleanly so user can share or refresh smoothly
  try {
    const u = new URL(location.href);
    u.searchParams.set('group', session.code);
    history.replaceState(null, '', u.toString());
  } catch (e) {}

  games = loadGroupCachedGames(session.code);
  loadGroupCachedVotes(session.code);

  closeGate();
  document.body.style.overflow = '';
  renderHeroGroupBar();
  render();
  updVoteUI();
  syncMobNav();

  // Verify group is not deleted & sync metadata with server analytics
  if (backendAvailable) {
    try {
      const syncRes = await fetch('/api/groups/sync-meta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: session.code,
          name: session.name,
          adminName: session.adminName,
          memberName: session.memberName,
          uid,
          gamesCount: games.length
        })
      });
      if (syncRes.status === 410) {
        handleRemoteGroupDeleted(session.code);
        return;
      }
    } catch (e) {}
  }

  // Live Firestore subscriptions for this group
  try {
    unsubGroupGames = subscribeToGroupGames(session.code, fbGames => {
      if (fbGames.length > 0) {
        applyGamesUpdate(fbGames, Date.now());
      }
    });
  } catch (e) {}

  try {
    unsubGroupVotes = subscribeToGroupVotes(session.code, (summary, total, names) => {
      applyVotesUpdate(summary, total, names);
    });
  } catch (e) {}

  await fetchGroupGamesFromBackend(session.code);
  await fetchGroupVotesFromBackend(session.code);
  if (backendAvailable) {
    setupGroupSSE(session.code);
    syncTimer = setInterval(async () => {
      if (!backendAvailable || !currentSession) return;
      try {
        const res = await fetch(`/api/groups/${currentSession.code}/version`);
        if (res.status === 410) {
          handleRemoteGroupDeleted(currentSession.code);
          return;
        }
        if (res.ok) {
          const v = await res.json();
          if (v.lastUpdated && v.lastUpdated !== lastT) {
            await fetchGroupGamesFromBackend(currentSession.code);
          }
          if (v.votesVersion && v.votesVersion !== lastVotesT) {
            lastVotesT = v.votesVersion;
            await fetchGroupVotesFromBackend(currentSession.code);
          }
        }
      } catch (e) {}
    }, 2500);
  }
}

function leaveCurrentGroup() {
  teardownGroupSync();
  closeDet();
  saveSession(null);
  adminMode = false;
  games = [];
  votes = {};
  myV = new Set();
  vTotal = 0;
  renderHeroGroupBar();
  try {
    const u = new URL(location.href);
    u.searchParams.delete('group');
    history.replaceState(null, '', u.toString());
  } catch (e) {}
  openGate('create');
}

/* ===== Welcome Gate: Create Group & Join Group (Passwordless) ===== */
let activeInviteCode: string | null = null;

function setGateTab(mode: 'create' | 'join', preserveInvite = false) {
  if (!preserveInvite && activeInviteCode) {
    activeInviteCode = null;
    $('gate').classList.remove('invite-mode');
    $('gateInviteBanner').hidden = true;
    $('jgGroupField').hidden = false;
    $('gateSwitchCreate').hidden = true;
  }
  const isCreate = mode === 'create';
  $('tabCreate').classList.toggle('on', isCreate);
  $('tabCreate').setAttribute('aria-selected', isCreate ? 'true' : 'false');
  $('tabJoin').classList.toggle('on', !isCreate);
  $('tabJoin').setAttribute('aria-selected', !isCreate ? 'true' : 'false');
  $('cgForm').classList.toggle('on', isCreate);
  $('jgForm').classList.toggle('on', !isCreate);
  $('cgErr').textContent = '';
  $('jgErr').textContent = '';
}

async function resolveInviteGroupName(code: string) {
  const localGrp = getLocalGroupsRegistry()[code];
  if (localGrp?.name) {
    $('gateInviteGroup').textContent = localGrp.name;
    return;
  }
  try {
    const fbGrp = await getGroupFromFirebase(code);
    if (fbGrp?.name && activeInviteCode === code) {
      $('gateInviteGroup').textContent = fbGrp.name;
      return;
    }
  } catch (e) {}
  if (backendAvailable) {
    try {
      const res = await fetch(`/api/groups/${code}`);
      if (res.ok) {
        const data = await res.json();
        if (data?.group?.name && activeInviteCode === code) {
          $('gateInviteGroup').textContent = data.group.name;
        }
      }
    } catch (e) {}
  }
}

function openGate(mode: 'create' | 'join', inviteCode?: string) {
  const gateEl = $('gate');
  const banner = $('gateInviteBanner');
  const groupField = $('jgGroupField');
  const switchCreate = $('gateSwitchCreate');

  if (inviteCode) {
    activeInviteCode = inviteCode;
    gateEl.classList.add('invite-mode');
    banner.hidden = false;
    groupField.hidden = true;
    switchCreate.hidden = false;
    $('gateInviteGroup').textContent = 'قروب الأصدقاء';
    setGateTab('join', true);
    void resolveInviteGroupName(inviteCode);
  } else {
    activeInviteCode = null;
    gateEl.classList.remove('invite-mode');
    banner.hidden = true;
    groupField.hidden = false;
    switchCreate.hidden = true;
    setGateTab(mode, false);
  }

  const retWrap = $('gateReturnWrap');
  retWrap.hidden = !currentSession;
  gateEl.classList.remove('off');
  document.body.classList.add('gate-open');

  if (inviteCode) {
    setTimeout(() => ($('jgMember') as HTMLInputElement | null)?.focus(), 120);
  }
}

function closeGate() {
  $('gate').classList.add('off');
  document.body.classList.remove('gate-open');
  document.body.style.overflow = '';
  syncMobNav();
}

on('tabCreate', 'click', () => setGateTab('create'));
on('tabJoin', 'click', () => setGateTab('join'));
on('gateSwitchCreate', 'click', () => openGate('create'));
on('gateReturnBtn', 'click', () => closeGate());

function randomRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, b => chars[b % chars.length]).join('');
}

function randomAdminPin(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, b => chars[b % chars.length]).join('');
}

on('cgForm', 'submit', async (e: SubmitEvent) => {
  e.preventDefault();
  const errEl = $('cgErr');
  errEl.textContent = '';

  const name = ($('cgName') as HTMLInputElement).value.trim();
  const adminName = ($('cgAdmin') as HTMLInputElement).value.trim();

  if (name.length < 2) {
    errEl.textContent = 'اكتب اسم القروب (حرفين على الأقل)';
    return;
  }
  if (adminName.length < 2) {
    errEl.textContent = 'اكتب اسمك كأدمن للقروب';
    return;
  }

  const btn = $('cgSubmit') as HTMLButtonElement;
  btn.disabled = true;

  try {
    const slug = await normalizeGroupNameSlug(name);

    const localReg = getLocalGroupsRegistry();
    if (Object.values(localReg).some(g => g.slug === slug)) {
      errEl.textContent = 'اسم القروب مستخدم مسبقاً — اختر اسماً آخر';
      btn.disabled = false;
      return;
    }

    try {
      const available = await checkGroupNameAvailable(name);
      if (!available) {
        errEl.textContent = 'اسم القروب مستخدم مسبقاً — اختر اسماً آخر';
        btn.disabled = false;
        return;
      }
    } catch (fbCheckErr) {}

    const code = randomRoomCode();
    const adminPin = randomAdminPin();
    const adminPinSalt = Array.from(crypto.getRandomValues(new Uint8Array(8)))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    const adminPinHash = await sha256Hex(adminPinSalt + adminPin);
    const createdAt = new Date().toISOString();
    const initialList = (defaultGames as Game[]).map(g => ({ ...g }));

    const grpRecord: GroupRecord = {
      code,
      name,
      slug,
      adminName,
      adminPinHash,
      adminPinSalt,
      createdAt
    };

    let createdInCloud = false;
    try {
      const fbRes = await createGroupInFirebase(grpRecord, initialList);
      if (!fbRes.ok && fbRes.reason === 'duplicate_name') {
        errEl.textContent = 'اسم القروب مستخدم مسبقاً — اختر اسماً آخر';
        btn.disabled = false;
        return;
      }
      if (fbRes.ok) createdInCloud = true;
    } catch (fbErr) {}

    if (backendAvailable) {
      try {
        const res = await fetch('/api/groups', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            adminName,
            adminPin,
            code,
            slug,
            games: initialList,
            uid
          })
        });
        if (res.status === 409) {
          const data = await res.json();
          errEl.textContent = data.error || 'اسم القروب مستخدم مسبقاً';
          btn.disabled = false;
          return;
        }
        if (res.status === 404) backendAvailable = false;
        else if (res.ok) createdInCloud = true;
      } catch (apiErr) {}
    }

    if (createdInCloud) {
      try {
        await registerGroupMemberInFirebase(code, uid, adminName, []);
      } catch (e) {}
    }
    saveLocalGroupRecord(grpRecord, initialList);

    const session: GroupSession = {
      code,
      name,
      adminName,
      memberName: adminName,
      isCreatorAdmin: true,
      adminPin
    };
    await enterGroup(session);
    ($('cgForm') as HTMLFormElement).reset();
    toast(`تم إنشاء قروب «${name}» بنجاح 🎉`);
    setTimeout(openGroupShareModal, 420);
  } catch (err) {
    errEl.textContent = 'حدث خطأ أثناء إنشاء القروب، حاول مرة أخرى';
  } finally {
    btn.disabled = false;
  }
});

on('jgForm', 'submit', async (e: SubmitEvent) => {
  e.preventDefault();
  const errEl = $('jgErr');
  errEl.textContent = '';

  const inviteCode = activeInviteCode;
  const groupNameInput = ($('jgGroupName') as HTMLInputElement).value.trim();
  const memberName = ($('jgMember') as HTMLInputElement).value.trim();

  if (!inviteCode && groupNameInput.length < 2) {
    errEl.textContent = 'اكتب اسم القروب للانضمام';
    return;
  }
  if (memberName.length < 2) {
    errEl.textContent = 'اكتب اسمك ليظهر عند التصويت';
    return;
  }

  const btn = $('jgSubmit') as HTMLButtonElement;
  btn.disabled = true;

  try {
    let grp: GroupRecord | null = null;
    let existingMembers: string[] = [];

    if (inviteCode) {
      try {
        grp = await getGroupFromFirebase(inviteCode);
        if (grp) {
          existingMembers = await getGroupMemberNamesFromFirebase(inviteCode);
        }
      } catch (fbErr) {}

      if (backendAvailable) {
        try {
          const res = await fetch(`/api/groups/${inviteCode}/join`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ memberName, uid })
          });
          if (res.status === 410) {
            const data = await res.json();
            removeLocalGroupEntries(inviteCode);
            errEl.textContent = data.error || 'تم حذف هذا القروب من قِبل مطور الموقع';
            btn.disabled = false;
            return;
          } else if (res.status === 404 && !grp) {
            errEl.textContent = 'رابط الدعوة غير صالح أو القروب غير موجود';
            btn.disabled = false;
            return;
          } else if (res.status === 409 || res.status === 400) {
            const data = await res.json();
            errEl.textContent = data.error || 'تعذّر الدخول للقروب';
            btn.disabled = false;
            return;
          } else if (res.ok) {
            const data = await res.json();
            if (!grp && data.group) grp = data.group as GroupRecord;
          }
        } catch (apiErr) {}
      }

      if (!grp) {
        const localGrp = getLocalGroupsRegistry()[inviteCode];
        if (localGrp) grp = localGrp;
      }

      if (!grp) {
        errEl.textContent = 'رابط الدعوة غير صالح أو القروب غير موجود';
        btn.disabled = false;
        return;
      }
    } else {
      const slug = await normalizeGroupNameSlug(groupNameInput);

      try {
        grp = await getGroupByNameFromFirebase(groupNameInput);
        if (grp) {
          existingMembers = await getGroupMemberNamesFromFirebase(grp.code);
        }
      } catch (fbErr) {}

      if (backendAvailable) {
        try {
          const res = await fetch('/api/groups/join-by-name', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ groupName: groupNameInput, memberName, uid })
          });
          if (res.status === 410) {
            const data = await res.json();
            errEl.textContent = data.error || 'تم حذف هذا القروب من قِبل مطور الموقع';
            btn.disabled = false;
            return;
          } else if (res.status === 404 && !grp) {
            errEl.textContent = 'لم يتم العثور على قروب بهذا الاسم';
            btn.disabled = false;
            return;
          } else if (res.status === 409 || res.status === 400) {
            const data = await res.json();
            errEl.textContent = data.error || 'تعذّر الدخول للقروب';
            btn.disabled = false;
            return;
          } else if (res.ok) {
            const data = await res.json();
            if (!grp && data.group) grp = data.group as GroupRecord;
          }
        } catch (apiErr) {}
      }

      if (!grp) {
        const localMatch = Object.values(getLocalGroupsRegistry()).find(g => g.slug === slug);
        if (localMatch) grp = localMatch;
      }

      if (!grp) {
        errEl.textContent = 'لم يتم العثور على قروب بهذا الاسم';
        btn.disabled = false;
        return;
      }
    }

    const lowerNew = memberName.toLowerCase();
    const isAdminName = grp.adminName.trim().toLowerCase() === lowerNew;
    const isDuplicateOther =
      existingMembers.some(n => n.trim().toLowerCase() === lowerNew) &&
      nick.trim().toLowerCase() !== lowerNew;
    if (isAdminName || isDuplicateOther) {
      errEl.textContent = 'هذا الاسم مستخدم داخل القروب — اختر اسماً مميزاً';
      btn.disabled = false;
      return;
    }

    try {
      await registerGroupMemberInFirebase(grp.code, uid, memberName, []);
    } catch (e) {}

    const session: GroupSession = {
      code: grp.code,
      name: grp.name,
      adminName: grp.adminName,
      memberName,
      isCreatorAdmin: false
    };
    activeInviteCode = null;
    await enterGroup(session);
    ($('jgForm') as HTMLFormElement).reset();
    toast(`أهلاً بك يا ${memberName} في قروب «${grp.name}» 🎮`);
  } catch (err) {
    errEl.textContent = 'تعذر الدخول للقروب، تأكد من الاتصال وحاول مجدداً';
  } finally {
    btn.disabled = false;
  }
});

/* ===== Analytics & Developer Room (/#admin0) ===== */
type DevGroupSummary = {
  code: string;
  name: string;
  adminName: string;
  createdAt: string;
  lastUpdated: number;
  gamesCount: number;
  membersCount: number;
  votesCount: number;
  memberNames: string[];
};

type DevStatsResponse = {
  stats: {
    totalGroupsCreated: number;
    activeGroupsCount: number;
    deletedGroupsCount: number;
    uniqueVisitors: number;
    totalVisits: number;
    engagedUsers: number;
    visitorsLast24h: number;
    totalInteractions: number;
    totalGames: number;
    totalVotes: number;
    breakdown: {
      groupCreates: number;
      groupJoins: number;
      votes: number;
      gameEdits: number;
      detailsViews: number;
    };
  };
  groups: DevGroupSummary[];
  recentEvents: Array<{
    id: string;
    type: string;
    label: string;
    at: string;
  }>;
};

let devAuthToken: string | null = null;
let devNeedsSetup = false;
let devGroupsCache: DevGroupSummary[] = [];
const devSelectedCodes = new Set<string>();

async function trackVisit(groupCode?: string): Promise<boolean> {
  if (!backendAvailable) return false;
  try {
    const res = await fetch('/api/analytics/visit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorId: uid, groupCode: groupCode || '' })
    });
    if (res.ok) {
      const data = await res.json();
      return !!data.groupDeleted;
    }
  } catch (e) {}
  return false;
}

async function trackInteraction(action: string, groupCode?: string): Promise<void> {
  if (!backendAvailable) return;
  try {
    await fetch('/api/analytics/interact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorId: uid, action, groupCode: groupCode || '' })
    });
  } catch (e) {}
}

function isDevRouteActive(): boolean {
  const hash = location.hash.trim().toLowerCase();
  const path = location.pathname.replace(/\/+$/, '').toLowerCase();
  return hash === '#admin0' || hash === '#/admin0' || path === '/admin0';
}

function formatArabicDateTime(isoOrTs: string | number): string {
  const d = typeof isoOrTs === 'number' ? new Date(isoOrTs) : new Date(isoOrTs);
  if (Number.isNaN(d.getTime())) return '-';
  try {
    return d.toLocaleString('ar-SA', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch (e) {
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }
}

function renderDevGroupsList() {
  const listEl = $('devGroupsList');
  const selBar = $('devSelectBar');
  const bulkBtn = $('devBulkDelBtn');
  const selCountEl = $('devSelCount');
  const selectAllEl = $('devSelectAll') as HTMLInputElement | null;
  const searchEl = $('devGroupSearch') as HTMLInputElement | null;
  if (!listEl) return;

  const q = (searchEl?.value || '').trim().toLowerCase();
  const filtered = q
    ? devGroupsCache.filter(
        g =>
          g.name.toLowerCase().includes(q) ||
          g.code.toLowerCase().includes(q) ||
          g.adminName.toLowerCase().includes(q)
      )
    : devGroupsCache;

  if (selBar) selBar.hidden = filtered.length === 0;
  if (selectAllEl) {
    selectAllEl.checked = filtered.length > 0 && filtered.every(g => devSelectedCodes.has(g.code));
  }
  if (selCountEl) selCountEl.textContent = String(devSelectedCodes.size);
  if (bulkBtn) bulkBtn.hidden = devSelectedCodes.size === 0;

  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="dev-empty">${
      devGroupsCache.length === 0 ? 'لا توجد قروبات نشطة حالياً.' : 'لا توجد نتائج مطابقة للبحث.'
    }</div>`;
    return;
  }

  const trashSvg = `<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6m3 0V4a1 1 0 011-1h6a1 1 0 011 1v2"/></svg>`;

  listEl.innerHTML = filtered
    .map(g => {
      const checked = devSelectedCodes.has(g.code) ? 'checked' : '';
      return `<article class="dev-grp-row">
        <div class="dev-grp-main">
          <label class="dev-grp-check">
            <input type="checkbox" class="dev-grp-cb" data-code="${esc(g.code)}" ${checked} aria-label="تحديد قروب ${esc(g.name)}">
          </label>
          <div class="dev-grp-info">
            <div class="dev-grp-title-row">
              <strong>${esc(g.name)}</strong>
              <span class="dev-grp-code">${esc(g.code)}</span>
            </div>
            <div class="dev-grp-meta">
              <span>الأدمن: <b>${esc(g.adminName)}</b></span>
              <span>الألعاب: <b>${g.gamesCount}</b></span>
              <span>المشاركون: <b>${g.membersCount}</b></span>
              <span>الأصوات: <b>${g.votesCount}</b></span>
              <span>أُنشئ: <b>${esc(formatArabicDateTime(g.createdAt))}</b></span>
            </div>
          </div>
        </div>
        <div class="dev-grp-actions">
          <button type="button" class="dev-del-btn" data-dev-del="${esc(g.code)}">
            ${trashSvg}
            <span>حذف القروب</span>
          </button>
        </div>
      </article>`;
    })
    .join('');
}

async function loadDevStats(announce = false) {
  if (!devAuthToken) return;
  try {
    const res = await fetch('/api/dev/stats', {
      headers: { Authorization: `Bearer ${devAuthToken}` }
    });
    if (res.status === 401) {
      devAuthToken = null;
      showDevAuthScreen('login');
      toast('انتهت الجلسة، أعد إدخال كلمة المرور');
      return;
    }
    if (!res.ok) throw new Error('stats_failed');
    const data = (await res.json()) as DevStatsResponse;
    const s = data.stats;

    $('kpiRoomsCreated').textContent = String(s.totalGroupsCreated);
    $('kpiRoomsSub').textContent = `نشطة: ${s.activeGroupsCount} · محذوفة: ${s.deletedGroupsCount}`;

    $('kpiVisitors').textContent = String(s.uniqueVisitors);
    $('kpiVisitorsSub').textContent = `إجمالي الزيارات: ${s.totalVisits}`;

    $('kpiEngaged').textContent = String(s.engagedUsers);
    $('kpiEngagedSub').textContent = `إجمالي التفاعلات: ${s.totalInteractions}`;

    $('kpiGamesVotes').textContent = String(s.totalGames + s.totalVotes);
    $('kpiGamesVotesSub').textContent = `ألعاب: ${s.totalGames} · أصوات: ${s.totalVotes}`;

    $('bd24h').textContent = String(s.visitorsLast24h);
    $('bdVotes').textContent = String(s.breakdown.votes);
    $('bdJoins').textContent = String(s.breakdown.groupJoins);
    $('bdEdits').textContent = String(s.breakdown.gameEdits);

    devGroupsCache = data.groups || [];
    for (const code of [...devSelectedCodes]) {
      if (!devGroupsCache.some(g => g.code === code)) devSelectedCodes.delete(code);
    }
    $('devGroupsCountNote').textContent = `القروبات النشطة حالياً: ${devGroupsCache.length} قروب`;
    renderDevGroupsList();

    const actEl = $('devActivityList');
    if (actEl) {
      actEl.innerHTML = (data.recentEvents || []).length
        ? data.recentEvents
            .map(
              ev => `<div class="dev-act-item">
                <span class="dev-act-label">${esc(ev.label)}</span>
                <span class="dev-act-time">${esc(formatArabicDateTime(ev.at))}</span>
              </div>`
            )
            .join('')
        : '<div class="dev-empty">لا توجد تفاعلات مسجلة بعد.</div>';
    }

    if (announce) toast('تم تحديث إحصائيات الموقع');
  } catch (e) {
    toast('تعذر تحميل إحصائيات المطور');
  }
}

function showDevAuthScreen(mode: 'login' | 'setup') {
  devNeedsSetup = mode === 'setup';
  $('devAuthWrap').hidden = false;
  $('devDashWrap').hidden = true;
  $('devAuthErr').textContent = '';

  const passInput = $('devPass') as HTMLInputElement | null;
  const confInput = $('devPassConfirm') as HTMLInputElement | null;
  const confWrap = $('devPassConfirmWrap');
  if (passInput) passInput.value = '';
  if (confInput) confInput.value = '';

  if (devNeedsSetup) {
    $('devAuthTitle').textContent = 'تعيين كلمة مرور المطور';
    $('devAuthSub').textContent = 'إعداد لمرة واحدة لحماية غرفة المطور الخاصة بك.';
    $('devPassLabel').textContent = 'كلمة المرور الجديدة';
    if (confWrap) confWrap.hidden = false;
    $('devAuthSubmit').textContent = 'حفظ كلمة المرور والدخول';
  } else {
    $('devAuthTitle').textContent = 'غرفة المطور الخاصة';
    $('devAuthSub').textContent = 'أدخل كلمة المرور للوصول إلى إحصائيات الموقع وإدارة القروبات.';
    $('devPassLabel').textContent = 'كلمة المرور';
    if (confWrap) confWrap.hidden = true;
    $('devAuthSubmit').textContent = 'دخول إلى غرفة المطور';
  }
  setTimeout(() => passInput?.focus(), 90);
}

function showDevDashboard() {
  $('devAuthWrap').hidden = true;
  $('devDashWrap').hidden = false;
  void loadDevStats(false);
}

async function openDevRoom() {
  const overlay = $('devOverlay');
  if (!overlay) return;
  drawer(false);
  overlay.hidden = false;
  document.body.classList.add('dev-open');

  try {
    const res = await fetch('/api/dev/status', {
      headers: devAuthToken ? { Authorization: `Bearer ${devAuthToken}` } : {}
    });
    if (res.ok) {
      const data = await res.json();
      if (data.authenticated && devAuthToken) {
        showDevDashboard();
        return;
      }
      showDevAuthScreen(data.mode === 'setup' ? 'setup' : 'login');
      return;
    }
  } catch (e) {}
  showDevAuthScreen('login');
}

function closeDevRoom(stripUrl = true) {
  const overlay = $('devOverlay');
  if (overlay) overlay.hidden = true;
  document.body.classList.remove('dev-open');
  if (stripUrl) {
    try {
      const u = new URL(location.href);
      if (u.hash.toLowerCase() === '#admin0' || u.hash.toLowerCase() === '#/admin0') {
        u.hash = '';
      }
      if (u.pathname.replace(/\/+$/, '').toLowerCase() === '/admin0') {
        u.pathname = '/';
      }
      history.replaceState(null, '', u.toString());
    } catch (e) {}
  }
  syncMobNav();
}

on('devPassToggle', 'click', () => {
  const passEl = $('devPass') as HTMLInputElement | null;
  const confEl = $('devPassConfirm') as HTMLInputElement | null;
  if (!passEl) return;
  const nextType = passEl.type === 'password' ? 'text' : 'password';
  passEl.type = nextType;
  if (confEl) confEl.type = nextType;
});

on('devExitAuth', 'click', () => closeDevRoom(true));

on('devAuthForm', 'submit', async (e: SubmitEvent) => {
  e.preventDefault();
  const errEl = $('devAuthErr');
  errEl.textContent = '';

  const pass = ($('devPass') as HTMLInputElement).value;
  const conf = ($('devPassConfirm') as HTMLInputElement).value;
  if (!pass || pass.length < 3) {
    errEl.textContent = 'أدخل كلمة المرور (3 أحرف أو رموز على الأقل)';
    return;
  }
  if (devNeedsSetup && pass !== conf) {
    errEl.textContent = 'كلمتا المرور غير متطابقتين';
    return;
  }

  const btn = $('devAuthSubmit') as HTMLButtonElement;
  btn.disabled = true;
  try {
    const endpoint = devNeedsSetup ? '/api/dev/setup' : '/api/dev/login';
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pass })
    });
    const data = await res.json();
    if (!res.ok) {
      if (data.needsSetup) {
        showDevAuthScreen('setup');
      } else {
        errEl.textContent = data.error || 'تعذر تسجيل الدخول';
      }
      return;
    }
    devAuthToken = data.token;
    showDevDashboard();
    toast('مرحباً بك في غرفة المطور');
  } catch (err) {
    errEl.textContent = 'تعذر الاتصال بالخادم';
  } finally {
    btn.disabled = false;
  }
});

on('devRefreshBtn', 'click', () => void loadDevStats(true));

on('devLogoutBtn', 'click', async () => {
  if (devAuthToken) {
    try {
      await fetch('/api/dev/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${devAuthToken}` }
      });
    } catch (e) {}
  }
  devAuthToken = null;
  devSelectedCodes.clear();
  closeDevRoom(true);
  toast('تم الخروج من غرفة المطور');
});

on('devGroupSearch', 'input', () => renderDevGroupsList());

on('devSelectAll', 'change', (e: Event) => {
  const checked = (e.target as HTMLInputElement).checked;
  const q = (($('devGroupSearch') as HTMLInputElement | null)?.value || '').trim().toLowerCase();
  const filtered = q
    ? devGroupsCache.filter(
        g =>
          g.name.toLowerCase().includes(q) ||
          g.code.toLowerCase().includes(q) ||
          g.adminName.toLowerCase().includes(q)
      )
    : devGroupsCache;
  filtered.forEach(g => {
    if (checked) devSelectedCodes.add(g.code);
    else devSelectedCodes.delete(g.code);
  });
  renderDevGroupsList();
});

on('devGroupsList', 'change', (e: Event) => {
  const cb = (e.target as HTMLElement).closest('.dev-grp-cb') as HTMLInputElement | null;
  if (!cb || !cb.dataset.code) return;
  if (cb.checked) devSelectedCodes.add(cb.dataset.code);
  else devSelectedCodes.delete(cb.dataset.code);
  renderDevGroupsList();
});

on('devGroupsList', 'click', async (e: MouseEvent) => {
  const btn = (e.target as HTMLElement).closest('[data-dev-del]') as HTMLElement | null;
  if (!btn || !btn.dataset.devDel || !devAuthToken) return;
  const code = btn.dataset.devDel;
  const grp = devGroupsCache.find(g => g.code === code);
  const label = grp ? `«${grp.name}» (${code})` : code;
  if (!(await askC(`متأكد من حذف قروب ${label} نهائياً؟`))) return;

  try {
    const res = await fetch(`/api/dev/groups/${encodeURIComponent(code)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${devAuthToken}` }
    });
    if (res.status === 401) {
      devAuthToken = null;
      showDevAuthScreen('login');
      return;
    }
    if (!res.ok) throw new Error('delete_failed');
    removeLocalGroupEntries(code);
    if (currentSession?.code === code) {
      handleRemoteGroupDeleted(code);
    }
    devSelectedCodes.delete(code);
    await loadDevStats(false);
    toast(`تم حذف القروب ${grp?.name || code}`);
  } catch (err) {
    toast('تعذر حذف القروب');
  }
});

on('devBulkDelBtn', 'click', async () => {
  if (!devAuthToken || devSelectedCodes.size === 0) return;
  const codes = [...devSelectedCodes];
  if (!(await askC(`متأكد من حذف ${codes.length} قروبات محددة نهائياً؟`))) return;

  try {
    const res = await fetch('/api/dev/groups/bulk-delete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${devAuthToken}`
      },
      body: JSON.stringify({ codes })
    });
    if (res.status === 401) {
      devAuthToken = null;
      showDevAuthScreen('login');
      return;
    }
    if (!res.ok) throw new Error('bulk_delete_failed');
    codes.forEach(c => {
      removeLocalGroupEntries(c);
      if (currentSession?.code === c) handleRemoteGroupDeleted(c);
    });
    devSelectedCodes.clear();
    await loadDevStats(false);
    toast(`تم حذف ${codes.length} قروبات بنجاح`);
  } catch (err) {
    toast('تعذر حذف القروبات المحددة');
  }
});

window.addEventListener('hashchange', () => {
  if (isDevRouteActive()) {
    void openDevRoom();
  } else if ($('devOverlay') && !$('devOverlay').hidden) {
    closeDevRoom(false);
  }
});

/* ===== App Boot ===== */
(async () => {
  const reloading = await cleanupDevServiceWorkerIfNeeded();
  if (reloading) return;

  const urlParams = new URLSearchParams(window.location.search);
  const inviteCode = sanitizeGroupCode(urlParams.get('group') || '');
  const savedSession = loadSavedSession();

  const groupDeletedOnServer = await trackVisit(savedSession?.code || inviteCode);
  if (groupDeletedOnServer && savedSession) {
    removeLocalGroupEntries(savedSession.code);
    saveSession(null);
  }

  const activeSession = groupDeletedOnServer ? null : savedSession;

  if (activeSession) {
    // Check if the user opened an invite link for a DIFFERENT group
    if (inviteCode && inviteCode !== activeSession.code) {
      await enterGroup(activeSession);
      openGate('join', inviteCode);
    } else {
      await enterGroup(activeSession);
    }
  } else {
    // First visit (no active group session) -> show Welcome Gate
    openGate(inviteCode ? 'join' : 'create', inviteCode || undefined);
  }

  if (isDevRouteActive()) {
    void openDevRoom();
  }
})();

/* ===== PWA Installability & Offline State ===== */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

let deferredInstallPrompt: BeforeInstallPromptEvent | null = null;
let isPwaInstalled =
  window.matchMedia('(display-mode: standalone)').matches ||
  (window.navigator as unknown as { standalone?: boolean }).standalone === true;
const isIosDevice =
  /iphone|ipad|ipod/.test(window.navigator.userAgent.toLowerCase()) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function openInstallGuide(mode: 'ios' | 'desktop') {
  const dlg = $('iosDlg') as HTMLDialogElement | null;
  const steps = $('iosGuideSteps');
  if (!dlg || !steps) return;
  steps.innerHTML =
    mode === 'ios'
      ? `<li>اضغط على زر <strong>المشاركة</strong> في شريط متصفح Safari.</li>
         <li>اسحب للأسفل واختر <strong>إضافة إلى الشاشة الرئيسية (Add to Home Screen)</strong>.</li>
         <li>اضغط <strong>إضافة</strong> ليظهر تطبيق Co-Op على شاشتك الرئيسية.</li>`
      : `<li>افتح الموقع في نافذة متصفح مستقلة (Chrome أو Edge أو Safari).</li>
         <li>اضغط على أيقونة <strong>التثبيت</strong> في شريط العنوان أو قائمة المتصفح (<strong>تثبيت تطبيق Co-Op</strong>).</li>
         <li>سيعمل الموقع كتطبيق مستقل بملء الشاشة ويدعم التشغيل السريع.</li>`;
  dlg.showModal();
}

async function triggerPwaInstall() {
  if (isPwaInstalled) return;
  if (deferredInstallPrompt) {
    await deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') {
      isPwaInstalled = true;
      deferredInstallPrompt = null;
      toast('تم تثبيت التطبيق على جهازك');
    }
    return;
  }
  openInstallGuide(isIosDevice ? 'ios' : 'desktop');
}

const iosDlgClose = $('iosDlgClose');
if (iosDlgClose) iosDlgClose.onclick = () => ($('iosDlg') as HTMLDialogElement | null)?.close();

window.addEventListener('beforeinstallprompt', (e: Event) => {
  e.preventDefault();
  deferredInstallPrompt = e as BeforeInstallPromptEvent;
});

window.addEventListener('appinstalled', () => {
  isPwaInstalled = true;
  deferredInstallPrompt = null;
  toast('تم تثبيت تطبيق Co-Op بنجاح');
});

function syncOnlineState(announce?: boolean) {
  const bar = $('offlineBar');
  const online = navigator.onLine;
  if (bar) bar.hidden = online;
  if (announce) {
    toast(online ? 'عاد الاتصال بالإنترنت' : 'انقطع الاتصال — يتم عرض القائمة المحفوظة');
  }
}

window.addEventListener('online', () => syncOnlineState(true));
window.addEventListener('offline', () => syncOnlineState(true));
syncOnlineState(false);

if (import.meta.env.PROD) {
  try {
    registerSW({
      immediate: true,
      onOfflineReady() {}
    });
  } catch (e) {}
}
