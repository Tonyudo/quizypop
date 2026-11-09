// Dead-simple event log: one JSON object per line in data/events.jsonl.
// Good enough to answer "does the $15 fake door convert?" in week one.
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const FILE = path.join(DIR, 'events.jsonl');
fs.mkdirSync(DIR, { recursive: true });

export function track(event, props = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), event, ...props });
  fs.appendFile(FILE, line + '\n', (err) => err && console.error('[analytics]', err.message));
}

export function summary() {
  let lines = [];
  try {
    lines = fs.readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    /* no events yet */
  }
  const counts = {};
  for (const e of lines) counts[e.event] = (counts[e.event] || 0) + 1;
  const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '—');
  const c = (k) => counts[k] || 0;
  return {
    counts,
    funnel: {
      'setup started → game created': pct(c('game_created'), c('setup_started')),
      'game created → game started': pct(c('game_started'), c('game_created')),
      'game started → game finished': pct(c('game_finished'), c('game_started')),
      'paywall shown → $15 clicked (fake door)': pct(c('paywall_click'), c('paywall_shown')),
      'end screen viewed → "make your own" clicked': pct(c('cta_click'), c('endscreen_view')),
    },
    recent: lines.slice(-50).reverse(),
  };
}
