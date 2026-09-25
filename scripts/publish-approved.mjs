// Reads cards from the Trello "Approved" list, verifies who approved them, validates the JSON against
// commands/schema.json, and writes commands/<slug>.json + commands/index.json. The workflow commits.
// Needs only a READ-scoped Trello token. Needs ajv (npm install --no-save ajv@8 ajv-formats@3).
//
// Env:
//   TRELLO_KEY, TRELLO_TOKEN        required (token created with scope=read)
//   TRELLO_APPROVED_LIST_ID         required
//   TRELLO_APPROVER_ID              required  Trello member id allowed to approve (yours)
//   ALLOW_APP_MOVES=true            optional  accept approvals made through an API app/integration
//   DRY_RUN=true                    optional  validate and report only, write nothing
//   OUT_DIR                         optional  default "commands"
//   TRELLO_API                      optional  default https://api.trello.com/1 (tests point this at a mock)

import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeValidator } from './validate-commands.mjs';

const serialize = (doc) => JSON.stringify(doc, null, 2) + '\n';
const check = await makeValidator();

const env = (k, d) => process.env[k] ?? d;
const API = env('TRELLO_API', 'https://api.trello.com/1');
const KEY = env('TRELLO_KEY');
const TOKEN = env('TRELLO_TOKEN');
const LIST = env('TRELLO_APPROVED_LIST_ID');
const APPROVER = env('TRELLO_APPROVER_ID');
const ALLOW_APP_MOVES = env('ALLOW_APP_MOVES') === 'true';
const DRY_RUN = env('DRY_RUN') === 'true';
const OUT_DIR = env('OUT_DIR', 'commands');
const MAX_ATTEMPTS = Number(env('TRELLO_MAX_ATTEMPTS', '5'));
// Small pause between cards. The cost is a few seconds per run; the benefit is staying clear of the
// per-token rate limit instead of sitting just under it and relying on luck.
const CARD_DELAY_MS = Number(env('TRELLO_CARD_DELAY_MS', '60'));

for (const [k, v] of Object.entries({ TRELLO_KEY: KEY, TRELLO_TOKEN: TOKEN, TRELLO_APPROVED_LIST_ID: LIST, TRELLO_APPROVER_ID: APPROVER })) {
  if (!v) { console.error(`Missing required env ${k}`); process.exit(2); }
}

// A run reads ~3 requests per approved card, so a board with ~150 approved cards makes ~450 calls in
// about a minute. Real runs have hit both HTTP 429 ("Rate limit exceeded: requests per interval for
// API token") and HTTP 503 upstream connection resets. Without a retry a single unlucky request
// throws, the card is marked invalid, and the whole run fails claiming a card was REJECTED -- which
// sends you hunting a bad document that does not exist. Retry, and keep transient failures in their
// own bucket so they are never reported as rejections.
class TransientError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function trello(path, params = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries({ ...params, key: KEY, token: TOKEN })) url.searchParams.set(k, v);
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(url);
    } catch (e) {                                   // DNS, reset socket, timeout
      lastErr = new TransientError(`Trello ${path} -> ${e.message}`);
      await sleep(backoffMs(attempt, null));
      continue;
    }
    if (res.ok) return res.json();
    const body = (await res.text()).slice(0, 200);
    // 429 = rate limited, 5xx = Trello having a moment. Both are worth retrying; 4xx is not.
    if (res.status === 429 || res.status >= 500) {
      lastErr = new TransientError(`Trello ${path} -> HTTP ${res.status}: ${body}`);
      await sleep(backoffMs(attempt, res.headers.get('retry-after')));
      continue;
    }
    throw new Error(`Trello ${path} -> HTTP ${res.status}: ${body}`);
  }
  throw lastErr;
}

// Exponential backoff with jitter, honouring Retry-After when Trello sends it.
function backoffMs(attempt, retryAfter) {
  const header = Number(retryAfter);
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 20000);
  return Math.min(500 * 2 ** (attempt - 1), 8000) + Math.floor(Math.random() * 250);
}

// The most recent action that put this card into the Approved list (a move, or created directly in it).
function findApproval(actions) {
  const sorted = [...actions].sort((a, b) => new Date(b.date) - new Date(a.date));
  return sorted.find((a) =>
    (a.type === 'updateCard' && a.data?.listAfter?.id === LIST) ||
    (a.type === 'createCard' && a.data?.list?.id === LIST) ||
    (a.type === 'moveCardToBoard' && a.data?.list?.id === LIST));
}

// The card JSON lives in ```json fences. A document is usually one fence in a checklist item, because
// a checklist item holds 16 KB while a card description holds ~2 KB (and the Trello connector Claude
// posts through cannot write comments at all). Every fence found on the card is concatenated in a fixed
// order — description, then checklist items, then comments — and parsed as ONE document, so a document
// too big for one place can still be split across several. Text without a json fence is ignored, which
// is what lets the human-readable review summary sit in the description.
const FENCE = /```json\s*\n?([\s\S]*?)```/g;
// Strip only the newlines the fence itself adds. A raw newline cannot appear inside a JSON string
// literal, so this is always safe; spaces are kept because they can be significant.
const fences = (text = '') => [...String(text).matchAll(FENCE)].map((m) => m[1].replace(/^[\r\n]+|[\r\n]+$/g, ''));

function extractJson(desc, checkItems, comments) {
  const parts = [...fences(desc), ...checkItems.flatMap((t) => fences(t)), ...comments.flatMap((c) => fences(c))];
  if (parts.length === 0) throw new Error('no ```json fenced block on the card (description, checklist items or comments)');
  const raw = parts.join('');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${parts.length > 1 ? `card JSON (${parts.length} parts) ` : ''}is not valid JSON: ${e.message}`);
  }
}

const results = [];
const seen = new Map();
const cards = await trello(`/lists/${LIST}/cards`, { fields: 'id,name,desc,shortUrl,dateLastActivity' });
console.log(`Approved list has ${cards.length} card(s).${DRY_RUN ? ' (dry run)' : ''}`);
if (!DRY_RUN) mkdirSync(OUT_DIR, { recursive: true });

for (const card of cards) {
  const r = { card: card.name, url: card.shortUrl, status: 'invalid', detail: '' };
  results.push(r);
  try {
    const actions = await trello(`/cards/${card.id}/actions`, {
      filter: 'updateCard,createCard,moveCardToBoard', limit: '100',
    });
    const approval = findApproval(actions);
    if (!approval) { r.detail = 'could not find the action that moved it to Approved'; continue; }
    if (approval.idMemberCreator !== APPROVER) { r.detail = `moved to Approved by member ${approval.idMemberCreator}, not the approver`; continue; }
    const app = approval.appCreator?.id ?? approval.appCreator ?? null;
    if (app && !ALLOW_APP_MOVES) { r.detail = `moved to Approved through an app/integration (appCreator=${JSON.stringify(approval.appCreator)}), not by hand. Set ALLOW_APP_MOVES=true to accept.`; continue; }

    // Any edit to the card after approval must also be by the approver, by hand.
    const later = actions.filter((a) => new Date(a.date) > new Date(approval.date) &&
      (a.idMemberCreator !== APPROVER || (a.appCreator && !ALLOW_APP_MOVES)));
    if (later.length) { r.detail = `card changed after approval by another member or an integration (${later.map((a) => a.type).join(', ')}); move it out and back into Approved to re-approve`; continue; }

    const checklists = await trello(`/cards/${card.id}/checklists`, { checkItems: 'all', fields: 'name,pos' });
    const checkItems = checklists
      .sort((a, b) => a.pos - b.pos)
      .flatMap((cl) => (cl.checkItems ?? []).sort((a, b) => a.pos - b.pos).map((ci) => ci.name ?? ''));
    const comments = (await trello(`/cards/${card.id}/actions`, { filter: 'commentCard', limit: '50' }))
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .map((a) => a.data?.text ?? '');
    let doc;
    try { doc = extractJson(card.desc, checkItems, comments); } catch (e) { r.detail = e.message; continue; }
    const errs = check(doc, doc?.slug);
    if (errs.length) { r.detail = errs.join('; '); continue; }

    if (seen.has(doc.slug)) { r.detail = `duplicate slug "${doc.slug}" (also on card "${seen.get(doc.slug)}")`; continue; }
    seen.set(doc.slug, card.name);
    const file = join(OUT_DIR, `${doc.slug}.json`);
    const next = serialize(doc);
    const prev = existsSync(file) ? readFileSync(file, 'utf8') : null;
    r.id = doc.slug;
    if (prev === next) { r.status = 'unchanged'; continue; }
    r.status = prev === null ? 'added' : 'updated';
    r.detail = file + (app ? ` (appCreator=${JSON.stringify(approval.appCreator)}, allowed)` : '');
    if (!DRY_RUN) writeFileSync(file, next);
  } catch (e) {
    // A transient read failure is NOT a rejected card. Calling it one sends you hunting a document
    // bug that does not exist -- which is exactly what happened chasing runs #55-#61.
    r.status = e instanceof TransientError ? 'unreadable' : 'invalid';
    r.detail = `${r.status === 'unreadable' ? 'transient' : 'error'}: ${e.message}`;
  }
  if (CARD_DELAY_MS) await sleep(CARD_DELAY_MS);
}

// Rebuild index.json (generated, never hand-edited) in the shape commands/README.md documents.
if (!DRY_RUN && existsSync(OUT_DIR)) {
  const games = readdirSync(OUT_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'index.json' && f !== 'schema.json')
    .map((f) => JSON.parse(readFileSync(join(OUT_DIR, f), 'utf8')))
    .map((d) => ({
      slug: d.slug,
      displayName: d.game?.displayName,
      appId: d.game?.appId ?? null,
      ...(d.game?.aliases?.length ? { aliases: d.game.aliases } : {}),
      transport: d.transport,
      confidence: d.confidence,
      verified: Boolean(d.verifiedAt),
      updatedAt: d.verifiedAt || d.researchedAt,
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
  const indexFile = join(OUT_DIR, 'index.json');
  const prevIndex = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')) : null;
  // Keep the old generatedAt when nothing else changed, so the file does not churn every run.
  const sameRows = prevIndex && JSON.stringify(prevIndex.games) === JSON.stringify(games);
  if (!sameRows) {
    writeFileSync(indexFile, serialize({
      schemaVersion: 1,
      generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      games,
    }));
  }
}

const count = (s) => results.filter((r) => r.status === s).length;
const lines = [
  `## Approved commands${DRY_RUN ? ' (dry run)' : ''}`,
  `added ${count('added')} · updated ${count('updated')} · unchanged ${count('unchanged')} · **rejected ${count('invalid')}** · unreadable ${count('unreadable')}`,
  '', '| Card | Result | Detail |', '|---|---|---|',
  ...results.map((r) => `| [${r.card.replace(/\|/g, '/')}](${r.url}) | ${r.status} | ${String(r.detail).replace(/\|/g, '/')} |`),
];
console.log(lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `invalid=${count('invalid')}\nunreadable=${count('unreadable')}\nchanged=${count('added') + count('updated')}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `ids=${results.filter((r) => ['added', 'updated'].includes(r.status)).map((r) => r.id).join(', ')}\n`);
}
