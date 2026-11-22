#!/usr/bin/env node
// Fetch genuine Saudi Steam prices, official trailers and screenshots at build/update time.
// Retain previously verified data when Steam doesn't respond; never invent prices or media.
import fs from 'node:fs/promises';
import path from 'node:path';

const ids = [
  1966720, 2827200, 3949040, 4656000, 3712080, 4108000, 1326470, 5053820, 4948000, 4412320,
  3527290, 2644470, 2709570, 3241660, 728880, 2567870, 2881650,
  477160, 1599600, 1016920, 386940, 1641700, 1260320, 1621690, 1211020, 648800, 690640,
  905340, 1004490, 1011670
];
const pricesFile = path.join(process.cwd(), 'src', 'steamPrices.json');
const mediaFile = path.join(process.cwd(), 'src', 'steamMedia.json');
async function load(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return {}; } }
const prices = await load(pricesFile);
const media = await load(mediaFile);
let verifiedPrices = 0;
let verifiedMedia = 0;

function steamAsset(url) {
  if (typeof url !== 'string') return '';
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !(u.hostname === 'steamstatic.com' || u.hostname.endsWith('.steamstatic.com'))) return '';
    return u.toString();
  } catch { return ''; }
}
function steamVideo(url) {
  if (typeof url !== 'string') return '';
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !(u.hostname === 'steamstatic.com' || u.hostname.endsWith('.steamstatic.com'))) return '';
    if (!/\\.(m3u8|mp4)$/i.test(u.pathname)) return '';
    return u.toString();
  } catch { return ''; }
}
for (const id of ids) {
  try {
    const url = new URL('https://store.steampowered.com/api/appdetails');
    url.searchParams.set('appids', String(id));
    url.searchParams.set('cc', 'sa');
    url.searchParams.set('l', 'english');
    const response = await fetch(url, {
      headers: { 'User-Agent': 'CoOpCatalogPriceAndMediaSync/1.1' },
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const item = (await response.json())?.[String(id)];
    if (!item?.success || !item.data) throw new Error('No public Steam details');
    const game = item.data;
    if (id === 3527290) console.log('PEAK_DEBUG_MOVIES ' + JSON.stringify({ length: game.movies?.length, first: game.movies?.[0] }).slice(0, 2200));
    if (game.type !== 'game') throw new Error('Not a full game');
    const checkedAt = new Date().toISOString();

    if (game.is_free === true) {
      prices[id] = { price: 0, old: 0, checkedAt, currency: 'SAR', free: true };
      verifiedPrices++;
    } else if (game.price_overview?.currency === 'SAR') {
      const p = game.price_overview;
      if (!Number.isInteger(p.final) || p.final < 0) throw new Error('Invalid Steam price');
      prices[id] = {
        price: p.final / 100,
        old: Number.isInteger(p.initial) ? p.initial / 100 : p.final / 100,
        checkedAt, currency: 'SAR'
      };
      verifiedPrices++;
    } else {
      console.log(id + ': no confirmed Saudi price, keeping prior verified value');
    }

    const header = steamAsset(game.header_image);
    const screenshots = Array.isArray(game.screenshots)
      ? game.screenshots.map(s => ({
          full: steamAsset(s.path_full),
          thumb: steamAsset(s.path_thumbnail || s.path_full)
        })).filter(s => s.full).slice(0, 10)
      : [];
    const videos = Array.isArray(game.movies)
      ? game.movies.map(m => ({
          url: steamVideo(m.mp4?.max || m.mp4?.['480'] || m.hls_h264 || m.hls),
          poster: steamAsset(m.thumbnail),
          title: typeof m.name === 'string' ? m.name.slice(0, 100) : 'Official Steam Trailer',
          format: (m.mp4?.max || m.mp4?.['480']) ? 'mp4' : 'hls'
        })).filter(m => m.url)
      : [];
    if (header || screenshots.length || videos.length) {
      media[id] = {
        header: header || media[id]?.header || '',
        trailer: videos[0] || null,
        screenshots,
        updatedAt: checkedAt
      };
      verifiedMedia++;
    } else console.log(id + ': no Steam gallery media');
  } catch (err) {
    console.warn('Steam fetch failed for ' + id + ': ' + err.message);
  }
}
if (verifiedPrices) await fs.writeFile(pricesFile, JSON.stringify(prices, null, 2) + '\n');
if (verifiedMedia) await fs.writeFile(mediaFile, JSON.stringify(media, null, 2) + '\n');
console.log('Verified SAR prices: ' + verifiedPrices + '/' + ids.length + '; Steam media: ' + verifiedMedia + '/' + ids.length);
