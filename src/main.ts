// Co-Op Web Application - Main Logic

type Game = {
  id: string;
  name: string;
  price: number;
  old: number;
  order: number;
  link: string;
  img: string;
  ar: number;
  players: string;
  desc?: string;
  goal: string;
  sp?: number | string;
  sc?: number;
};

const $ = (id: string) => document.getElementById(id) as HTMLElement;

try {
  const t = localStorage.getItem('theme');
  if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
} catch (e) {}

try {
  history.scrollRestoration = 'manual';
} catch (e) {}

let moved = false;
['wheel', 'touchstart', 'keydown', 'mousedown'].forEach(ev =>
  addEventListener(ev, () => { moved = true; }, { once: true, passive: true })
);

const toTop = () => {
  if (!moved) window.scrollTo({ top: 0, left: 0, behavior: 'instant' as any });
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

let adminMode = false;
let curId: string | null = null;
let imgAr = 0.8;
let pref = 0;
let relIds: string[] = [];
let lastT = 0;

let votes: Record<string, { n: number; uids: string[]; names: string[] }> = {};
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

let audioCtx: AudioContext | null = null;
function playSound(type: 'vote' | 'unvote' | 'click') {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
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
  `<button class="vote${big ? ' big' : ''}${myV.has(g.id) ? ' on' : ''}" data-v="${g.id}"${big ? ' id="dv"' : ''} aria-label="${myV.has(g.id) ? 'إلغاء التصويت' : 'تصويت للعبة'}">
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

const defaultCols = (w: number) => (w < 700 ? 2 : 3);
const maxFit = (w: number) => (w < 700 ? 2 : Math.max(1, Math.floor((w + 30) / 180)));

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
const relN = (w: number) => Math.max(1, Math.min(pref || (w < 700 ? 2 : 3), maxFit(w)));

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
    (render as any).done = true;
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
  if (!(await askC('متأكد تبي تحذف اللعبة؟'))) return;
  await commit(async () => {
    const res = await fetch(`/api/games/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error();
  }, 'تم الحذف وتحدّثت القائمة عند الجميع', 'ما قدرت أحذف');
}

function setSv(st: string) {
  const e = $('sv');
  if (!e) return;
  e.className = 'sv ' + st;
  e.textContent = st === 'saving' ? 'جارٍ الحفظ…' : st === 'ok' ? 'تم الحفظ ووصل للجميع' : st === 'err' ? 'تعذّر الحفظ' : 'متصل';
}

async function commit(fn: () => Promise<any>, okMsg?: string, errMsg?: string) {
  setSv('saving');
  try {
    await fn();
    setSv('ok');
    toast(okMsg || 'تم الحفظ، وتحدّث عند الجميع');
    setTimeout(() => setSv('idle'), 4500);
    return true;
  } catch (e) {
    setSv('err');
    toast(errMsg || 'ما قدرت أحفظ — تأكد من الاتصال');
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
  ['#3fae7a', '#1c6e6a'],
  ['#79b875', '#2f8f83'],
  ['#4fb6d8', '#2a7fa8'],
  ['#8f7be0', '#5a4fc2'],
  ['#f08fb0', '#c4577f'],
  ['#f2b25c', '#d9733a'],
  ['#5cc8a8', '#2e8f70']
];
const EM = ['🎮', '🕹️', '👾', '🎲', '🧩', '🚀', '🔥'];

let games: Game[] = [];
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

const esc = (s: any) =>
  String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c));

const steam = (g: Game) => g.link || 'https://store.steampowered.com/search/?term=' + encodeURIComponent(g.name);
const hash = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
const disc = (g: Game) => (g.old > g.price ? Math.round((1 - g.price / g.old) * 100) : 0);

let toastTimer: any = null;
function toast(t: string) {
  const e = $('toast');
  e.textContent = t;
  e.classList.add('on');
  clearTimeout(toastTimer);
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
const arOf = (g: Game) => (g.img ? Math.min(2.2, Math.max(0.7, +g.ar || 0.8)) : [0.8, 0.92, 1, 0.86][hash(g.name) % 4]);

function cover(g: Game) {
  const h = hash(g.name), c = GR[h % GR.length];
  return g.img
    ? `<div class="bg" style="background-image:url('${g.img}')"></div><img src="${g.img}" alt="${esc(g.name)}">`
    : `<div class="art" style="background:linear-gradient(145deg,${c[0]},${c[1]})"><b>${esc(g.name)}</b><em>${EM[h % EM.length]}</em></div>`;
}

let io = new IntersectionObserver(es => es.forEach(e => {
  if (e.isIntersecting) {
    e.target.classList.add('in');
    io.unobserve(e.target);
  }
}), { threshold: 0.08 });

function render() {
  let a = [...games];
  const q = ($('q') as HTMLInputElement).value.trim().toLowerCase();
  if (q) a = a.filter(g => g.name.toLowerCase().includes(q));
  if (filter === 'sale') a = a.filter(g => disc(g));
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
   <div class="cv" data-o="${g.id}" style="aspect-ratio:${arOf(g)}">${cover(g)}${disc(g) ? `<span class="sale">-${disc(g)}%</span>` : ''}${isTopVoted(g) ? `<span class="top-vote-tag">🔥 متصدرة التصويت</span>` : ''}
   <button class="heart ${favs.has(g.name) ? 'on' : ''}" data-h="${esc(g.name)}" aria-label="مفضلة">${heart()}</button>
   <button class="zoom" data-z="${g.id}" aria-label="تكبير الصورة">${ZI}</button><span class="qv">نظرة سريعة</span>
   ${adminMode ? `<div class="adm"><button data-e="${g.id}">✏️ تعديل</button><button class="d" data-d="${g.id}">🗑️ حذف</button></div>` : ''}</div>
   <div class="meta"><h3>${esc(g.name)}</h3><small>#${g.order || i + 1}${playersOf(g) ? ` · ${esc(playersOf(g))} لاعبين` : ''}</small><div class="pr">${(+g.price).toFixed(2)} SR${disc(g) ? `<s>${(+g.old).toFixed(2)} SR</s>` : ''}</div>${voteBtn(g)}</div></div>`;

  if (!a.length) {
    $('grid').innerHTML = `<div class="empty">😴 ما فيه ألعاب مطابقة</div>`;
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
      bins[k].push(card(g, i));
      hs[k] += cw / arOf(g) + 175;
    });
    buildSizes();
    (render as any).cols = n;
    $('grid').innerHTML = bins.map(b => `<div class="col">${b.join('')}</div>`).join('');
  }
}

$('grid').onclick = (e: MouseEvent) => {
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
};

let touchTimer: any = null;
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

const prHtml = (g: Game) => `${(+g.price).toFixed(2)} SR${disc(g) ? `<s>${(+g.old).toFixed(2)} SR</s>` : ''}`;

function openDet(g: Game, keep?: boolean) {
  if (!g) return;
  curId = g.id;
  $('det').classList.toggle('nr', !!keep);
  const o = [...games].sort((a, b) => (a.order || 0) - (b.order || 0));
  const k = o.findIndex(x => x.id === g.id);
  const rel = [...o.slice(k + 1), ...o.slice(0, k)].slice(0, 12);
  relIds = rel.map(r => r.id);
  const url = esc(steam(g));

  const goalBox = `<div class="blk"><h4>🎯 هدف اللعبة</h4><p>${goalOf(g) ? esc(goalOf(g)) : 'ما أضيف هدف لهذي اللعبة بعد.'}</p></div>`;
  const quick = adminMode
    ? `<div class="steam qe"><h4>تعديل سريع</h4><div class="row"><div><label>السعر</label><input id="qp" type="number" step="0.01" value="${g.price}"></div><div><label>قبل الخصم</label><input id="qo" type="number" step="0.01" value="${g.old || ''}"></div></div><label>عدد اللاعبين</label><input id="qpl" value="${esc(playersOf(g))}"><label>هدف اللعبة</label><textarea id="qg" rows="3">${esc(goalOf(g))}</textarea><button class="btn" id="qs" style="margin-top:14px;width:100%">حفظ التعديلات</button></div>`
    : '';

  $('dg').innerHTML = `<div class="dl"><div class="cv" style="aspect-ratio:${arOf(g)}">${cover(g)}<button class="zoom" data-z="${g.id}" aria-label="تكبير الصورة">${ZI}</button>${disc(g) ? `<span class="sale">-${disc(g)}%</span>` : ''}</div>${goalBox}${quick}</div>
  <div class="dt"><small>لعبة جماعية · CO-OP</small><h2>${esc(g.name)}</h2>
  ${adminMode ? `<div class="abx"><button class="sbtn" id="de">تعديل اللعبة</button><button class="sbtn" id="dc">تكرار</button><button class="sbtn del" id="dd">حذف</button></div>` : ''}
  <div class="pr">${prHtml(g)}</div>
  <div class="info"><div><span>عدد اللاعبين</span><b dir="ltr">${esc(playersOf(g) || '-')}</b></div><div><span>الترتيب</span><b>#${g.order || '-'}</b></div><div><span>الخصم</span><b>${disc(g) ? disc(g) + '%' : 'بدون'}</b></div><div><span>المنصة</span><b>Steam</b></div></div>
  ${voteBtn(g, true)}<div id="dvn" class="vn"></div>
  <a class="btn steam-btn" href="${url}" target="_blank" rel="noopener">
    <span class="btn-start">
      <svg viewBox="0 0 24 24" class="steam-ico" aria-hidden="true"><path fill="currentColor" d="M11.979 0C5.678 0 .511 4.86.022 11.037l6.432 2.658c.545-.371 1.203-.59 1.912-.59.063 0 .125.004.188.006l2.861-4.142V8.91c0-2.495 2.028-4.524 4.524-4.524 2.494 0 4.524 2.029 4.524 4.524s-2.03 4.524-4.524 4.524h-.105l-4.076 2.811c0 .052.005.105.005.159 0 1.875-1.515 3.396-3.39 3.396-1.635 0-3.016-1.173-3.331-2.727L.436 14.819C1.94 20.05 6.705 24 12 24c6.627 0 12-5.373 12-12S18.627 0 11.979 0zM7.54 18.216c-.98 0-1.774-.794-1.774-1.774 0-.413.142-.793.38-1.096l1.966.812a1.764 1.764 0 0 0 1.202 2.058c-.538.165-1.115.148-1.774 0zm8.4-7.078c-1.255 0-2.272-1.018-2.272-2.273s1.017-2.273 2.272-2.273c1.256 0 2.273 1.018 2.273 2.273 0 1.255-1.017 2.273-2.273 2.273zm-4.708 6.002a2.02 2.02 0 0 1-1.396.586c-1.115 0-2.02-.904-2.02-2.02 0-.256.05-.499.138-.724l2.126.88a1.01 1.01 0 0 0 1.152 1.278z"/></svg>
    </span>
    <span class="btn-label">افتح في ستيم</span>
    <span class="btn-end">
      <svg viewBox="0 0 24 24" class="arr-ico" aria-hidden="true"><path d="M19 12H5M12 19l-7-7 7-7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </span>
  </a></div>`;

  $('dg').querySelectorAll('.dt,.dl').forEach(c => [...c.children].forEach((x, i) => (x as HTMLElement).style.setProperty('--i', String(i))));
  $('dx').innerHTML = `<div class="sec"><div class="sh"><h3>ألعاب أخرى قد تعجبك</h3><div class="sizes" id="sizes2"></div></div><div class="relw" id="relw"><button class="rarr rl" id="rnl" aria-label="التالي"><svg viewBox="0 0 24 24"><polyline points="15 6 9 12 15 18"/></svg></button><div class="rel" id="rel"></div><button class="rarr rr" id="rpr" aria-label="السابق"><svg viewBox="0 0 24 24"><polyline points="9 6 15 12 9 18"/></svg></button></div></div>`;
  
  buildRel();
  buildSizes();
  $('rel').onscroll = relArrows;
  $('rnl').onclick = () => relGo(-1);
  $('rpr').onclick = () => relGo(1);

  if (adminMode) {
    $('de').onclick = () => openForm(g);
    $('dd').onclick = () => delGame(g.id);
    $('dc').onclick = async () => {
      const { id, ...d } = g;
      commit(async () => {
        const res = await fetch('/api/games', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...d, name: g.name + ' (نسخة)', order: games.length + 1 })
        });
        if (!res.ok) throw new Error();
      }, 'تم تكرار اللعبة', 'ما قدرت أكرر');
    };
    $('qs').onclick = () => {
      commit(async () => {
        const res = await fetch(`/api/games/${g.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            price: +($('qp') as HTMLInputElement).value,
            old: +($('qo') as HTMLInputElement).value || 0,
            players: ($('qpl') as HTMLInputElement).value.trim(),
            goal: ($('qg') as HTMLTextAreaElement).value.trim()
          })
        });
        if (!res.ok) throw new Error();
      }, 'تم تحديث اللعبة عند الجميع');
    };
  }

  $('dv').onclick = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    toggleVote(g.id, $('dv'));
  };
  refreshDetVote();

  $('det').classList.add('on');
  if (!keep) $('det').scrollTo({ top: 0, behavior: 'smooth' });
  document.body.style.overflow = 'hidden';
}

$('dx').onclick = (e: MouseEvent) => {
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
};

const closeDet = () => {
  $('det').classList.remove('on');
  document.body.style.overflow = '';
};
$('bk').onclick = closeDet;

$('bs').onclick = () => {
  $('sbar').classList.toggle('on');
  if ($('sbar').classList.contains('on')) setTimeout(() => $('q').focus(), 300);
};
$('q').oninput = render;

$('chips').onclick = (e: MouseEvent) => {
  const b = (e.target as HTMLElement).closest('.chip') as HTMLElement | null;
  if (!b) return;
  if (b.id === 'vchip') return openVP();
  filter = b.dataset.f || 'all';
  document.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c === b));
  render();
};

const KEY = `<svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L20 3M16 7l3 3M13 10l2 2"/></svg>`;
const themeNow = () => document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light');

function setTheme(t: string) {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem('theme', t);
  } catch (e) {}
  document.querySelectorAll('.tseg').forEach(x => {
    x.classList.toggle('dark', t === 'dark');
    x.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  });
}

function toggleTheme(ev: any, want?: string) {
  if (want && want === themeNow()) return;
  const next = want || (themeNow() === 'dark' ? 'light' : 'dark');
  const b = ev && ev.currentTarget ? ev.currentTarget.getBoundingClientRect() : null;
  const x = b ? b.left + b.width / 2 : innerWidth / 2;
  const y = b ? b.top + b.height / 2 : innerHeight / 2;
  const h = document.documentElement;

  if ((document as any).startViewTransition && !matchMedia('(prefers-reduced-motion:reduce)').matches) {
    try {
      const vt = (document as any).startViewTransition(() => setTheme(next));
      vt.ready.then(() => {
        const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
        h.animate(
          { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
          { duration: 850, easing: 'cubic-bezier(.6,0,.2,1)', pseudoElement: '::view-transition-new(root)' }
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
  const L = [['all', 'الكل'], ['sale', 'العروض'], ['fav', 'المفضلة'], ['lo', 'الأرخص'], ['hi', 'الأغلى']];
  const dk = themeNow() === 'dark';
  let h = `<div class="trow"><span>المظهر</span><div class="tseg${dk ? ' dark' : ''}"><i class="pill"></i><button data-act="theme" data-t="light" class="${dk ? '' : 'on'}" aria-label="المظهر الفاتح"><svg class="sn" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>فاتح</button><button data-act="theme" data-t="dark" class="${dk ? 'on' : ''}" aria-label="المظهر الداكن"><svg class="mn" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/></svg>داكن</button></div></div>` +
    L.map((x, i) => `<button class="ml" style="--i:${i}" data-f="${x[0]}">${x[1]}</button>`).join('') +
    `<button class="ml" style="--i:5" data-act="vp">الأكثر تصويتاً</button><button class="ml" style="--i:6" data-act="search">بحث</button>`;

  if (adminMode) {
    h += `<div class="msep">أدوات الأدمن</div>` +
      [['vv', 'أصوات الأصدقاء'], ['add', 'إضافة لعبة'], ['seed', 'تحميل القائمة الأولى'], ['pw', 'تغيير كلمة السر'], ['out', 'خروج من وضع الأدمن']]
        .map((x, i) => `<button class="ml sm2" style="--i:${7 + i}" data-act="${x[0]}">${x[1]}</button>`)
        .join('');
  } else {
    // ALWAYS show the Admin Login box in burger menu as requested!
    h += `<div class="admw"><div class="at">دخول الأدمن</div><div class="admb" id="admb"></div></div>`;
  }
  $('menu').innerHTML = `<div class="mw">${h}</div>`;
  if (!adminMode) fillAdminBox();
}

async function fillAdminBox() {
  const bx = $('admb');
  if (!bx) return;
  bx.innerHTML = `<div class="ar"><input id="mpw" type="password" autocomplete="off" placeholder="اكتب الرمز"><button id="mkey" aria-label="دخول">${KEY}</button></div>`;
  $('mkey').onclick = adminLogin;
  const mpw = $('mpw') as HTMLInputElement | null;
  if (mpw) {
    mpw.onkeydown = (e: KeyboardEvent) => {
      if (e.key === 'Enter') adminLogin();
    };
  }
}

function admShake() {
  const b = $('admb');
  if (!b) return;
  b.classList.remove('shake');
  void b.offsetWidth;
  b.classList.add('shake');
}

function unlockAdmin() {
  const k = $('mkey');
  if (k) k.classList.add('ok');
  setTimeout(() => {
    setAdmin(true);
    buildMenu();
    toast('أهلاً بك 🔐');
  }, 450);
}

let fails = 0;
let lockUntil = 0;

async function adminLogin() {
  const mpw = $('mpw') as HTMLInputElement | null;
  const p = mpw ? mpw.value : '';
  if (!p) {
    admShake();
    return toast('اكتب رمز الأدمن');
  }
  if (Date.now() < lockUntil) {
    admShake();
    return toast('انتظر شوي ثم جرّب مرة ثانية');
  }

  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: p })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      fails = 0;
      unlockAdmin();
    } else {
      if (++fails >= 3) {
        lockUntil = Date.now() + 30000;
        fails = 0;
      }
      if (mpw) mpw.value = '';
      admShake();
      toast(data.error || 'الرمز غلط');
    }
  } catch (e) {
    admShake();
    toast('تعذّر الاتصال بالخادم');
  }
}

function drawer(on: boolean) {
  if (on) buildMenu();
  $('menu').classList.toggle('on', on);
  $('shade').classList.toggle('on', on);
  $('bm').classList.toggle('on', on);
}

$('shade').onclick = () => drawer(false);
$('bm').onclick = () => drawer(!$('menu').classList.contains('on'));

$('menu').onclick = (e: MouseEvent) => {
  const b = (e.target as HTMLElement).closest('button');
  if (!b) return;
  const f = b.dataset.f, a = b.dataset.act;
  if (f) {
    filter = f;
    document.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', (c as HTMLElement).dataset.f === f));
    render();
    drawer(false);
    setTimeout(() => $('chips').scrollIntoView({ behavior: 'smooth', block: 'start' }), 300);
  } else if (a === 'search') {
    drawer(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    $('sbar').classList.add('on');
    setTimeout(() => $('q').focus(), 500);
  } else if (a === 'theme') {
    toggleTheme({ currentTarget: b }, b.dataset.t);
  } else if (a === 'vv' || a === 'vp') {
    drawer(false);
    setTimeout(openVP, 350);
  } else if (a === 'add') {
    drawer(false);
    openForm();
  } else if (a === 'seed') {
    seed();
  } else if (a === 'pw') {
    drawer(false);
    openPw('setup');
  } else if (a === 'out') {
    drawer(false);
    setAdmin(false);
  }
};

function setAdmin(on: boolean) {
  adminMode = on;
  try {
    sessionStorage.setItem('adm', adminMode ? '1' : '0');
  } catch (e) {}
  $('abar').classList.toggle('on', adminMode);
  render();
  syncDet();
}

$('aex').onclick = () => {
  setAdmin(false);
  toast('أنت الحين تشوف الموقع مثل أخوياك 👁️');
};

let pmode = 'setup';
function openPw(m: string) {
  pmode = m;
  $('pt').textContent = 'تغيير رمز الأدمن 🔑';
  $('pp').textContent = 'اختر رمزاً جديداً لصفحة الأدمن:';
  $('pw2').style.display = 'block';
  ($('pw') as HTMLInputElement).value = '';
  ($('pw2') as HTMLInputElement).value = '';
  ($('pdlg') as HTMLDialogElement).showModal();
  $('pw').focus();
}

$('pcx').onclick = () => ($('pdlg') as HTMLDialogElement).close();

$('pf').onsubmit = async (e: Event) => {
  e.preventDefault();
  const p = ($('pw') as HTMLInputElement).value;
  const p2 = ($('pw2') as HTMLInputElement).value;
  if (p.length < 4) return toast('الرمز قصير (4 أحرف على الأقل)');
  if (p !== p2) return toast('الرمزين مو متطابقين');

  try {
    const res = await fetch('/api/admin/set-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: p })
    });
    if (res.ok) {
      ($('pdlg') as HTMLDialogElement).close();
      toast('تم حفظ الرمز الجديد 🔑');
    } else {
      toast('ما قدرت أحفظ الرمز');
    }
  } catch (err) {
    toast('حدث خطأ في الاتصال');
  }
};

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
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
  editing = g || null;
  $('dt').textContent = g ? 'تعديل لعبة' : 'إضافة لعبة';
  ($('fn') as HTMLInputElement).value = g ? g.name : '';
  ($('fp') as HTMLInputElement).value = g ? String(g.price) : '';
  ($('fo') as HTMLInputElement).value = g && g.old ? String(g.old) : '';
  ($('fl') as HTMLInputElement).value = g ? g.link || '' : '';
  ($('fr') as HTMLInputElement).value = g ? String(g.order) : String(games.length + 1);
  ($('fpl') as HTMLInputElement).value = g ? playersOf(g) : '';
  ($('fg') as HTMLTextAreaElement).value = g ? goalOf(g) : '';
  ($('fi') as HTMLInputElement).value = '';
  setImg(g ? g.img : '', g ? g.ar : 0);
  ($('dlg') as HTMLDialogElement).showModal();
}

$('cx').onclick = () => ($('dlg') as HTMLDialogElement).close();

function procBlob(f: Blob) {
  const u = URL.createObjectURL(f);
  const im = new Image();
  im.onload = () => {
    const m = Math.min(1, 760 / Math.max(im.width, im.height));
    const w = Math.round(im.width * m);
    const h = Math.round(im.height * m);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d')?.drawImage(im, 0, 0, w, h);
    setImg(c.toDataURL('image/jpeg', 0.82), w / h);
    URL.revokeObjectURL(u);
  };
  im.src = u;
}

$('fi').onchange = (e: any) => {
  if (e.target.files[0]) procBlob(e.target.files[0]);
};
$('pz').onclick = () => $('fi').click();
$('pz').ondragover = e => e.preventDefault();
$('pz').ondrop = (e: DragEvent) => {
  e.preventDefault();
  const f = e.dataTransfer?.files[0];
  if (f && f.type.startsWith('image/')) procBlob(f);
};

document.addEventListener('paste', e => {
  if (!($('dlg') as HTMLDialogElement).open) return;
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

$('f').onsubmit = async (e: Event) => {
  e.preventDefault();
  const d: Partial<Game> = {
    name: ($('fn') as HTMLInputElement).value.trim(),
    price: +($('fp') as HTMLInputElement).value,
    old: +($('fo') as HTMLInputElement).value || 0,
    link: ($('fl') as HTMLInputElement).value.trim(),
    order: +($('fr') as HTMLInputElement).value || games.length + 1,
    img: imgData,
    ar: imgData ? +imgAr.toFixed(3) : 0,
    players: ($('fpl') as HTMLInputElement).value.trim(),
    goal: ($('fg') as HTMLTextAreaElement).value.trim()
  };

  ($('dlg') as HTMLDialogElement).close();

  commit(async () => {
    let res: Response;
    if (editing) {
      res = await fetch(`/api/games/${editing.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(d)
      });
    } else {
      res = await fetch('/api/games', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(d)
      });
    }
    if (!res.ok) throw new Error();
  }, 'تم الحفظ وتحدّثت اللعبة عند الجميع');
};

async function seed() {
  if (games.length && !(await askC('هل تريد إعادة تحميل القائمة الافتراضية؟'))) return;
  drawer(false);
  commit(async () => {
    // Call seed
    const res = await fetch('/api/games/seed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ games: [] })
    });
    if (!res.ok) throw new Error();
  }, 'تم تحميل الألعاب وتحدّثت عند الجميع');
}

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
  if (isVoting) return;
  isVoting = true;

  const prev = new Set(myV);
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
  if (filter === 'votes') render();
  else updVoteUI();
  refreshDetVote();

  try {
    const res = await fetch('/api/votes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid, v: [...n], name: nick })
    });
    if (!res.ok) throw new Error();
    toast(!wasVoted ? 'وصل صوتك مباشرةً ✅' : 'تم سحب صوتك');
  } catch (e) {
    myV = prev;
    if (filter === 'votes') render();
    else updVoteUI();
    refreshDetVote();
    toast('تعذّر تسجيل التصويت');
  } finally {
    setTimeout(() => {
      isVoting = false;
    }, 500);
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

  const dv = $('dvn');
  if (adminMode && votes[id]) {
    const names = votes[id].names.length ? votes[id].names.join('، ') : `${votes[id].n} أصوات`;
    dv.innerHTML = `الأصوات: <span>${names}</span>`;
  } else {
    dv.textContent = '';
  }
}

function updVoteUI() {
  document.querySelectorAll('.cb').forEach(c => {
    (c as HTMLElement).textContent = String(myV.size || '');
    (c as HTMLElement).style.display = myV.size ? 'inline-block' : 'none';
  });
  const nb = $('nb');
  if (nb) {
    nb.textContent = String(myV.size);
    nb.classList.toggle('z', !myV.size);
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
  t.classList.remove('hit');
  void t.offsetWidth;
  t.classList.add('hit');
  document.querySelectorAll('.cb,#nb').forEach(x => {
    x.classList.remove('pop2');
    void (x as HTMLElement).offsetWidth;
    x.classList.add('pop2');
  });
}

function flyVote(btn: HTMLElement, g?: Game) {
  if (!g || $('det').classList.contains('on') || matchMedia('(prefers-reduced-motion:reduce)').matches) return;
  const item = btn.closest('.item');
  const cv = item ? (item.querySelector('.cv') as HTMLElement | null) : null;
  if (!cv) return;
  const r = cv.getBoundingClientRect();
  const navB = (document.querySelector('nav') as HTMLElement).getBoundingClientRect().bottom;
  const vis = Math.min(r.bottom, innerHeight) - Math.max(r.top, navB);
  if (vis < r.height * 0.55) return;
  const el = document.createElement('div');
  el.className = 'fly';
  el.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
  el.innerHTML = cover(g);
  document.body.appendChild(el);

  const pick = () => {
    if ($('det').classList.contains('on')) return $('dvt');
    if (innerWidth > 700) {
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
  const dur = 1100;
  const lift = Math.min(150, Math.abs(pt(pick()).y - S.y) * 0.35 + 70);

  let tgt = pick();
  let D = pt(tgt);
  let t0 = performance.now();
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
    const sc = (26 + (w - 26) * Math.pow(1-e, 2.4)) / w;
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

  $('vps').textContent = a.length ? `${vTotal} صوّتوا · عندك ${myV.size} من 3 أصوات` : '';
  $('vpl').innerHTML = a.length
    ? a.map((g, i) =>
        `<div class="vi${myV.has(g.id) ? ' me' : ''}${anim ? ' an' : ''}" style="--d:${i * 80}ms"><span class="vrk">${i + 1}</span><b>${esc(g.name)}</b><em>${vN(g)}</em><div class="vbar"><i style="--w:${(vN(g) / mx) * 100}%"></i></div>${adminMode && votes[g.id] ? `<p class="vnm">${votes[g.id].names.join('، ')}</p>` : ''}</div>`
      ).join('')
    : `<p class="vemp">ما أحد صوّت للحين.<br>كن أول واحد يختار لعبته.</p>`;

  $('vpa').innerHTML = adminMode
    ? `<div class="row"><button class="btn" id="vcp" style="flex:1;padding:12px">نسخ الملخص</button><button class="btn out" id="vrs" style="padding:12px 18px">تصفير</button></div>`
    : '';

  if (adminMode) {
    const vcp = $('vcp');
    if (vcp) {
      vcp.onclick = async () => {
        const t = a.map((g, i) => `${i + 1}. ${g.name}: ${vN(g)} (${(votes[g.id]?.names || []).join('، ')})`).join('\n');
        navigator.clipboard?.writeText(t)
          .then(() => toast('تم نسخ الملخص'))
          .catch(() => toast('ما قدرت أنسخ'));
      };
    }
    const vrs = $('vrs');
    if (vrs) {
      vrs.onclick = async () => {
        if (!(await askC('تصفير كل الأصوات؟'))) return;
        try {
          await fetch('/api/votes/reset', { method: 'POST' });
          toast('تم تصفير الأصوات');
        } catch (e) {
          toast('ما قدرت أصفّر');
        }
      };
    }
  }
}

function openVP() {
  renderVP(true);
  $('vp').classList.add('on');
}
function closeVP() {
  $('vp').classList.remove('on');
}

$('vpx').onclick = closeVP;
$('vp').onclick = (e: MouseEvent) => {
  if ((e.target as HTMLElement).id === 'vp') closeVP();
};
$('bv').onclick = openVP;
$('dvt').onclick = openVP;

/* ===== Lightbox ===== */
let lbI = 0;
let lbList: Game[] = [];
let lbReady = false;
let zoomed = false;
let lbBusy = false;

function lbFill(g: Game) {
  $('lbs').innerHTML = `<div class="cv lbimg" id="lbimg" style="--ar:${arOf(g)};aspect-ratio:${arOf(g)}"><div class="zin">${cover(g)}</div><span class="glare"></span></div>`;
  $('lbc').innerHTML = `<b>${esc(g.name)}</b><span>${(+g.price).toFixed(2)} SR${disc(g) ? ` · -${disc(g)}%` : ''}</span>`;
  $('lbcnt').textContent = `${lbI + 1} / ${lbList.length}`;
  $('lbamb').style.backgroundImage = g.img ? `url('${g.img}')` : 'none';
  $('lbamb').style.backgroundColor = g.img ? 'transparent' : GR[hash(g.name) % GR.length][0];
  zoomed = false;
}

function lbSrcFor(g: Game) {
  if ($('det').classList.contains('on')) {
    return curId === g.id
      ? (document.querySelector('#dg .cv') as HTMLElement)
      : (document.querySelector(`#dx .rc[data-o="${g.id}"] .cv`) as HTMLElement);
  }
  return document.querySelector(`#grid .cv[data-o="${g.id}"]`) as HTMLElement;
}

function openLb(id: string, src?: HTMLElement) {
  lbList = [...games].sort((a, b) => (a.order || 0) - (b.order || 0));
  lbI = Math.max(0, lbList.findIndex(x => x.id === id));
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
  const g = lbList[lbI];
  const el = $('lbimg');
  const src = lbSrcFor(g);
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
    openLb(z.dataset.z, z.closest('.cv') as HTMLElement);
  }
}, true);

$('lbx').onclick = closeLb;
$('lbb').onclick = closeLb;
$('lbnx').onclick = () => lbGo(1);
$('lbp').onclick = () => lbGo(-1);
$('lbs').onclick = (e: MouseEvent) => {
  if ((e.target as HTMLElement).closest('#lbimg')) setZoom(!zoomed, e);
  else closeLb();
};

$('lb').addEventListener('mousemove', (e: MouseEvent) => {
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

$('lb').addEventListener('wheel', (e: WheelEvent) => {
  e.preventDefault();
  const on = e.deltaY < 0;
  if (on !== zoomed) setZoom(on);
}, { passive: false });

let tx0 = 0;
$('lb').addEventListener('touchstart', (e: TouchEvent) => {
  tx0 = e.touches[0].clientX;
}, { passive: true });
$('lb').addEventListener('touchend', (e: TouchEvent) => {
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

let rt: any;
addEventListener('resize', () => {
  clearTimeout(rt);
  rt = setTimeout(() => {
    if (layoutN(innerW()) !== (render as any).cols) render();
    else buildSizes();
    relArrows();
  }, 200);
});

$('sizes').onclick = (e: MouseEvent) => {
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
    (render as any).done = false;
    render();
    gs.classList.remove('swap');
    setTimeout(() => { (render as any).done = true; }, 1500);
  }, 280);
};

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

  games = newGames;
  lastT = newLastT || Date.now();
  render();
  syncDet();
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

function applyVotesUpdate(newSummary: any, newTotal: number) {
  votes = newSummary || {};
  vTotal = newTotal || 0;
  const myIds: string[] = [];
  for (const [gid, voteInfo] of Object.entries(votes)) {
    if (voteInfo.uids && voteInfo.uids.includes(uid)) myIds.push(gid);
  }
  myV = new Set(myIds);
  if (filter === 'votes') render();
  else updVoteUI();
  refreshDetVote();
  if ($('vp').classList.contains('on')) renderVP(false);
}

// Fetch initial data and setup SSE for real-time synchronization
async function fetchGames() {
  try {
    const res = await fetch('/api/games');
    if (res.ok) {
      const data = await res.json();
      applyGamesUpdate(data.games || [], data.lastUpdated);
    }
  } catch (e) {
    console.error('Failed to fetch games', e);
  }
}

async function fetchVotes() {
  try {
    const res = await fetch('/api/votes');
    if (res.ok) {
      const data = await res.json();
      applyVotesUpdate(data.summary, data.totalVoters);
    }
  } catch (e) {
    console.error('Failed to fetch votes', e);
  }
}

// Connect to Server-Sent Events (SSE)
function setupSSE() {
  try {
    const es = new EventSource('/api/events');
    es.addEventListener('games', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        applyGamesUpdate(data.games || [], data.lastUpdated);
      } catch (err) {}
    });

    es.addEventListener('votes', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        applyVotesUpdate(data.summary, data.totalVoters);
      } catch (err) {}
    });

    es.onerror = () => {};
  } catch (e) {
    console.error('SSE not available', e);
  }
}

let lastVotesT = 0;

// Initialize
(async () => {
  let admStored = false;
  try {
    admStored = sessionStorage.getItem('adm') === '1';
  } catch (e) {}
  setAdmin(admStored);

  await fetchGames();
  await fetchVotes();
  setupSSE();

  // Instant lightweight background sync (every 2s) to guarantee updates reach everyone without refreshing
  setInterval(async () => {
    try {
      const res = await fetch('/api/version');
      if (res.ok) {
        const v = await res.json();
        if (v.lastUpdated && v.lastUpdated !== lastT) {
          await fetchGames();
        }
        if (v.votesVersion && v.votesVersion !== lastVotesT) {
          lastVotesT = v.votesVersion;
          await fetchVotes();
        }
      }
    } catch (e) {}
  }, 2000);
})();
