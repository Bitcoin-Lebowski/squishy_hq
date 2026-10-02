// Squish HQ end-to-end tests (Playwright library, no test runner needed).
// See tests/README.md for how to run them.
//
//   npm ci && npx playwright install chromium webkit
//   npm test                                  # all 3 browser setups
//   node tests/squish-hq.test.js              # chromium desktop + iPhone 13 (chromium)
//   node tests/squish-hq.test.js --webkit     # also the iPhone 13 profile on WebKit
//   node tests/squish-hq.test.js --grep=reset --project=chromium-desktop
//   node tests/squish-hq.test.js --smoke      # the smoke set only (see SMOKE_TESTS)
//   node tests/squish-hq.test.js --workers=2  # parallel workers (default: min(4, CPU cores))
//   SHOTS=dir node tests/squish-hq.test.js    # also save review screenshots into dir
//
// Every test gets a fresh browser context (so empty localStorage), and fails
// on any uncaught page error or on any request that isn't a local file.

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const {pathToFileURL} = require('url');
const {chromium, webkit, devices} = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'index.html');
const URL_ = pathToFileURL(HTML).href;
const SHOTS = process.env.SHOTS || '';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'squish-'));

const iphone = devices['iPhone 13'];
const PROJECTS = [
  {name: 'chromium-desktop', browser: chromium, ctx: {viewport: {width: 1280, height: 900}}},
  {name: 'chromium-iphone13', browser: chromium, ctx: {viewport: iphone.viewport, userAgent: iphone.userAgent,
    deviceScaleFactor: iphone.deviceScaleFactor, isMobile: iphone.isMobile, hasTouch: iphone.hasTouch}},
];
if (process.argv.includes('--webkit')) PROJECTS.push({name: 'webkit-iphone13', browser: webkit, ctx: {...iphone}});

// Copies the app (index.html, vendor/, assets/) into a temp folder,
// optionally leaving some files out, and returns that folder.
function copyApp(opts = {}) {
  const dir = fs.mkdtempSync(path.join(TMP, 'app-'));
  const omit = (opts.omit || []).map(f => path.normalize(f));
  const walk = rel => {
    const src = path.join(ROOT, rel);
    if (fs.statSync(src).isDirectory()) { fs.mkdirSync(path.join(dir, rel), {recursive: true}); fs.readdirSync(src).forEach(f => walk(path.join(rel, f))); }
    else if (!omit.includes(path.normalize(rel))) fs.copyFileSync(src, path.join(dir, rel));
  };
  ['index.html', 'vendor', 'assets'].forEach(walk);
  return dir;
}

// A tiny static server that serves a copy of the app under /squish-hq/,
// the way GitHub Pages serves a project site under /repo-name/.
const SERVER = {url: ''};
const MIME = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json'};
function startServer() {
  const siteRoot = fs.mkdtempSync(path.join(TMP, 'site-'));
  fs.renameSync(copyApp(), path.join(siteRoot, 'squish-hq'));
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(siteRoot, path.normalize(rel));
    if (!file.startsWith(siteRoot) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {'Content-Type': MIME[path.extname(file)] || 'application/octet-stream'});
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => { SERVER.url = `http://127.0.0.1:${server.address().port}`; r(server); }));
}
const isLocal = url => /^(file|data|blob|about):/.test(url) || (SERVER.url && url.startsWith(SERVER.url + '/'));

/* ---------------- tiny harness ---------------- */
// The smoke tier: a few core tests that together touch the main paths.
// Listed in tests/README.md too; the runner refuses a name that doesn't exist.
const SMOKE_TESTS = new Set([
  'regression: localStorage persistence mid-wizard and reload on finished plan',
  'reset: clears storage, state, charts, views; focus and scroll to top',
  'round trip: export -> reset -> import gives an identical plan page',
  'import: malicious strings are escaped on every render path; extras dropped; lengths clamped',
  'repo: no external requests from file:// (fonts and Chart.js are local and actually load)',
  'fix 2: the whole wizard can be completed with the keyboard only',
  'C: break-even arithmetic (unit tests, all currencies)',
  'axe: welcome, every control type, the dialog and the plan have no serious or critical issues',
]);
const tests = [];
function test(name, fn) { tests.push({name, fn}); }
function assert(cond, msg) { if (!cond) throw new Error('Assertion failed: ' + msg); }
function eq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${msg}\n    expected: ${B}\n    actual:   ${A}`);
}

/* ---------------- helpers ---------------- */
const STORAGE_KEY = 'squish-hq-plan-v1';
const stored = page => page.evaluate(k => localStorage.getItem(k), STORAGE_KEY);
// Clearing storage behind the app's back isn't enough: once the page has
// navigated, its pagehide saver writes the in-memory plan straight back on
// reload. Disarm it too (the same thing resetApp does).
async function freshStart(page) {
  await page.evaluate(k => { localStorage.removeItem(k); hasNavigatedOnce = false; }, STORAGE_KEY);
  await page.reload();
}
const kicker = page => page.locator('.step-kicker').textContent();
const next = page => page.click('#next-btn');
const isTouch = p => !!p.ctx.hasTouch;
async function press(p, locator) { if (isTouch(p)) await locator.tap(); else await locator.click(); }

// Walks the whole wizard. opts: idea, kind ('product'|'service'), name,
// solo, cost, price, goal, currency.
async function completeWizard(page, p, o) {
  await page.click('#start-btn');
  await page.fill('#f-idea', o.idea);
  if (o.currency) await page.selectOption('#f-currency', o.currency);
  await next(page);
  await press(p, page.locator('.choice-card', {hasText: o.kind === 'service' ? 'I offer a service' : 'I sell things'}));
  await next(page);
  await page.fill('#f-name', o.name);
  await next(page);
  const fnames = page.locator('.fname');
  await fnames.nth(0).fill('Ava');
  await press(p, page.locator('.founder-card').nth(0).locator('.chip').nth(0));
  await press(p, page.locator('.founder-card').nth(0).locator('.chip').nth(2));
  if (o.solo) {
    await press(p, page.locator('.founder-card').nth(1).locator('.remove-founder'));
  } else {
    await fnames.nth(1).fill('Ben');
    await press(p, page.locator('.founder-card').nth(1).locator('.chip').nth(1));
  }
  await next(page);
  await press(p, page.locator('.suggest-tiles').nth(0).locator('.suggest-tile-add').first());
  await press(p, page.locator('.suggest-tiles').nth(1).locator('.suggest-tile-add').first());
  await next(page);
  await page.fill('#f-cost', o.cost ?? '0.40');
  await page.fill('#f-price', o.price ?? '1.50');
  await next(page);
  await press(p, page.locator('#cost-tiles .suggest-tile-add').first());
  await press(p, page.locator('#cost-tiles .suggest-tile-add').first());
  await page.locator('.c-amount').nth(0).fill('6');
  await page.locator('.c-amount').nth(1).fill('2.5');
  await press(p, page.locator('#src-row .chip', {hasText: 'Parents lend it'}));
  await next(page);
  await page.fill('#f-goal', o.goal ?? '12');
  await next(page);
  await page.fill('#f-comp', 'The corner shop & big websites');
  await page.fill('#f-better', 'Ours are friendlier and made fresh');
  await next(page);
  await press(p, page.locator('.suggest-tile-add').first());
  await next(page);
  await press(p, page.locator('#risk-tiles .suggest-tile-add').first());
  await next(page);
  await page.click('#view-plan-btn');
  await page.waitForSelector('#plan-view', {state: 'visible'});
  await page.waitForFunction(() => window.Chart && Chart.getChart('profit-chart'));
}

async function planSnapshot(page) {
  return page.evaluate(() => {
    const d = id => { const c = Chart.getChart(id); return c ? {labels: c.data.labels, data: c.data.datasets.map(s => s.data)} : null; };
    // Year in the kicker is the only intentionally time-dependent text.
    return {text: document.getElementById('plan-shell').innerText, costs: d('costs-chart'), profit: d('profit-chart'), state: JSON.stringify(state)};
  });
}

async function openModal(page, p) {
  await press(p, page.locator('#start-again-btn'));
  await page.waitForSelector('#reset-overlay:not([hidden])');
}

// A fresh folder per call: tests running side by side never share a file.
function tmpFile(name) { return path.join(fs.mkdtempSync(path.join(TMP, 'f-')), name); }
function writeTmp(name, content) {
  const f = tmpFile(name);
  fs.writeFileSync(f, content);
  return f;
}
function goodBackup(overrides) {
  const base = {
    app: 'squish-hq', schemaVersion: 1, exportedAt: '2026-09-29T10:00:00.000Z', currentStep: 12, finished: true,
    state: {
      ideaText: 'Lemonade stand', businessKind: 'product', businessName: 'Sunny Sips', tagline: '', mascotEmoji: '🍋',
      currency: 'GBP', founders: [{name: 'Ava', roles: ['Talking to customers'], sharePct: 100}], equalShares: true,
      audience: ['Neighbours'], sellPlaces: ['A stand outside our house'], unitCost: '0.4', sellPrice: '1.5',
      startupCosts: [{label: 'Lemons and sugar', amount: '6'}], startupMoneySource: 'Savings', weeklySalesGoal: '10',
      competitors: 'Shop', betterThan: 'Fresh', marketingIdeas: ['A big colourful sign'], risks: [{name: 'Rain', fix: 'Backup date'}],
    },
  };
  const out = JSON.parse(JSON.stringify(base));
  if (overrides) overrides(out);
  return JSON.stringify(out);
}
async function importFile(page, file) {
  await page.setInputFiles('#load-plan-input', file);
}

/* ================= REGRESSION TESTS ================= */

test('regression: el() keeps multi-root markup (audience step has both labels)', async (page, p) => {
  await page.click('#start-btn');
  await page.fill('#f-idea', 'Lemonade stand'); await next(page);
  await press(p, page.locator('.choice-card').first()); await next(page);
  await page.fill('#f-name', 'X'); await next(page);
  await page.locator('.fname').nth(0).fill('A'); await press(p, page.locator('.founder-card').nth(0).locator('.chip').first());
  await page.locator('.fname').nth(1).fill('B'); await press(p, page.locator('.founder-card').nth(1).locator('.chip').first());
  await next(page);
  assert(await page.locator('.group-label', {hasText: 'Who are your customers?'}).isVisible(), 'first label');
  assert(await page.locator('.group-label', {hasText: 'Where will you sell?'}).isVisible(), 'second (sibling) label survives');
  eq(await page.locator('.freeform-row').count(), 2, 'two freeform rows');
});

test('regression: Enter advances on ordinary fields, adds in place on freeform/tile inputs', async (page, p) => {
  await page.click('#start-btn');
  await page.fill('#f-idea', 'Dog walking');
  await page.press('#f-idea', 'Enter');
  eq(await kicker(page), 'Step 2 of 11', 'Enter on idea advances');
  await press(p, page.locator('.choice-card', {hasText: 'I offer a service'})); await next(page);
  await page.fill('#f-name', 'Pawsome'); await page.press('#f-name', 'Enter');
  eq(await kicker(page), 'Step 4 of 11', 'Enter on name advances');
  await page.locator('.fname').nth(0).fill('Ava'); await press(p, page.locator('.founder-card').nth(0).locator('.chip').first());
  await press(p, page.locator('.founder-card').nth(1).locator('.remove-founder'));
  await next(page);
  const free = page.locator('.freeform-row input').first();
  await free.fill('Grandparents');
  await free.press('Enter');
  eq(await kicker(page), 'Step 5 of 11', 'freeform Enter does not advance');
  assert(await page.locator('.picked-chip', {hasText: 'Grandparents'}).isVisible(), 'freeform Enter adds chip');
  const tileInput = page.locator('.suggest-tile input').first();
  await tileInput.press('Enter');
  eq(await kicker(page), 'Step 5 of 11', 'tile input Enter does not advance');
});

test('regression: localStorage persistence mid-wizard and reload on finished plan', async (page, p) => {
  await page.click('#start-btn');
  await page.fill('#f-idea', 'Squishy toys'); await next(page);
  await press(p, page.locator('.choice-card').first()); await next(page);
  await page.fill('#f-name', 'SquishSquad');
  await page.reload();
  eq(await kicker(page), 'Step 3 of 11', 'reload returns to the same step');
  eq(await page.inputValue('#f-name'), 'SquishSquad', 'typed value survives reload (pagehide save)');
  await freshStart(page);
  await completeWizard(page, p, {idea: 'Lemonade stand', kind: 'product', name: 'Sunny Sips'});
  const before = await planSnapshot(page);
  await page.reload();
  await page.waitForFunction(() => window.Chart && Chart.getChart('profit-chart'));
  assert(await page.locator('#plan-view').isVisible(), 'finished plan shows after reload');
  eq((await planSnapshot(page)).text, before.text, 'plan text identical after reload');
});

test('regression: legacy save without schemaVersion still loads', async (page) => {
  const legacy = JSON.parse(goodBackup());
  await page.evaluate(([k, v]) => localStorage.setItem(k, JSON.stringify({state: v.state, currentStep: 12, finished: true})), [STORAGE_KEY, legacy]);
  await page.reload();
  await page.waitForSelector('#plan-view', {state: 'visible'});
  assert((await page.locator('#plan-shell h1').textContent()).includes('Sunny Sips'), 'legacy plan renders');
});

test('regression: mobile tap targets on tiles and plan toolbar', async (page, p) => {
  await completeWizard(page, p, {idea: 'Lemonade stand', kind: 'product', name: 'Sunny Sips'});
  for (const id of ['#print-btn', '#start-again-btn']) {
    const b = await page.locator(id).boundingBox();
    assert(b.height >= 44, `${id} is at least 44px tall (was ${b.height})`);
  }
  await page.click('#edit-plan-btn');
  await next(page); await next(page); await next(page); await next(page);
  const add = await page.locator('.suggest-tile-add').first().boundingBox();
  assert(add.height >= 32 && add.width >= 60, `tile + Add is a decent target (${add.width}x${add.height})`);
  // Dismiss button is 22px but has a 40px ::before hit area; tapping just outside its box must still dismiss.
  const rm = page.locator('.suggest-tiles').nth(0).locator('.suggest-tile-remove').first();
  const before = await page.locator('.suggest-tiles').nth(0).locator('.suggest-tile input').first().inputValue();
  await rm.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => new Promise(r => { const y = scrollY; setTimeout(() => r(scrollY === y), 200); }));
  const rb = await rm.boundingBox();
  const x = rb.x - 5, y = rb.y + rb.height / 2;
  if (isTouch(p)) await page.touchscreen.tap(x, y); else await page.mouse.click(x, y);
  const after = await page.locator('.suggest-tiles').nth(0).locator('.suggest-tile input').first().inputValue().catch(() => null);
  assert(after !== before, 'extended dismiss hit area works');
});

test('regression: solo founder support and grammar', async (page, p) => {
  await completeWizard(page, p, {idea: 'Lemonade stand', kind: 'product', name: 'Solo Sips', solo: true});
  const txt = await page.locator('#plan-shell').innerText();
  assert(/who handles everything/.test(txt), 'singular grammar');
  assert(/Ava: 100% share/.test(txt), '100% share');
  assert(!/between them/.test(txt), 'no plural grammar');
});

test('regression: explicit product/service question drives vocabulary', async (page, p) => {
  await page.click('#start-btn');
  await page.fill('#f-idea', 'Dog walking'); await next(page);
  await next(page);
  assert((await page.locator('.error-msg').textContent()).includes('Pick whichever'), 'must choose kind');
  await press(p, page.locator('.choice-card', {hasText: 'I offer a service'})); await next(page);
  await page.fill('#f-name', 'Paws'); await next(page);
  await page.locator('.fname').nth(0).fill('A'); await press(p, page.locator('.founder-card').nth(0).locator('.chip').first());
  await press(p, page.locator('.founder-card').nth(1).locator('.remove-founder')); await next(page);
  await press(p, page.locator('.suggest-tiles').nth(0).locator('.suggest-tile-add').first());
  await press(p, page.locator('.suggest-tiles').nth(1).locator('.suggest-tile-add').first());
  await next(page);
  eq(await page.locator('.step-title').textContent(), 'What will you charge for each walk?', 'service title');
  assert((await page.locator('.card').innerText()).includes('Supplies you use for each walk'), 'service cost label');
});

test('regression: suggestion tiles disappear cleanly once exhausted', async (page, p) => {
  await page.click('#start-btn');
  await page.fill('#f-idea', 'Lemonade stand'); await next(page);
  await press(p, page.locator('.choice-card').first()); await next(page);
  await page.fill('#f-name', 'X'); await next(page);
  await page.locator('.fname').nth(0).fill('A'); await press(p, page.locator('.founder-card').nth(0).locator('.chip').first());
  await press(p, page.locator('.founder-card').nth(1).locator('.remove-founder')); await next(page);
  const box = page.locator('.suggest-tiles').nth(0);
  for (let i = 0; i < 10 && await box.locator('.suggest-tile-remove').count(); i++) {
    await press(p, box.locator('.suggest-tile-remove').first());
  }
  assert(!(await box.isVisible()), 'tile grid hidden when exhausted');
  eq(await box.locator('.suggest-tile').count(), 0, 'no blank tiles');
  assert(!(await page.locator('.regen-btn').nth(0).isVisible()), 'regen button hidden when exhausted');
});

/* ================= PART 1: START AGAIN MODAL ================= */

test('Start again sits beside Print; Edit plan is in the toolbar, apart from Start again', async (page, p) => {
  await completeWizard(page, p, {idea: 'Lemonade stand', kind: 'product', name: 'Sunny Sips'});
  const r = await page.evaluate(() => {
    const sa = document.getElementById('start-again-btn'), pr = document.getElementById('print-btn'), ed = document.getElementById('edit-plan-btn');
    return {sameParent: sa.parentElement === pr.parentElement, editSeparate: ed.parentElement !== sa.parentElement,
      positions: [sa, pr, ed].map(b => getComputedStyle(b).position)};
  });
  assert(r.sameParent, 'shares the toolbar group with Print');
  assert(r.editSeparate, 'Edit plan is in a different group from Start again');
  eq(r.positions, ['static', 'static', 'static'], 'nothing floating');
  const sa = await page.locator('#start-again-btn').boundingBox();
  const ed = await page.locator('#edit-plan-btn').boundingBox();
  const gap = Math.max(sa.x - (ed.x + ed.width), ed.x - (sa.x + sa.width), sa.y - (ed.y + ed.height), ed.y - (sa.y + sa.height));
  assert(gap >= 12, `Edit plan and Start again are not touching (gap ${Math.round(gap)}px)`);
  const dist = Math.hypot((sa.x + sa.width / 2) - (ed.x + ed.width / 2), (sa.y + sa.height / 2) - (ed.y + ed.height / 2));
  assert(dist >= 120, `centres far apart (${Math.round(dist)}px)`);
});

test('modal: accessible markup, Cancel focused, background inert', async (page, p) => {
  await completeWizard(page, p, {idea: 'Lemonade stand', kind: 'product', name: 'Sunny Sips'});
  await openModal(page, p);
  const m = page.locator('#reset-modal');
  eq(await m.getAttribute('role'), 'dialog', 'role');
  eq(await m.getAttribute('aria-modal'), 'true', 'aria-modal');
  eq(await page.locator('#reset-title').textContent(), 'Start again?', 'labelled');
  assert((await page.locator('#reset-desc').textContent()).includes('whole plan for Sunny Sips'), 'says plainly what is deleted');
  eq(await page.evaluate(() => document.activeElement.id), 'reset-cancel-btn', 'Cancel has default focus');
  eq(await page.evaluate(() => document.getElementById('plan-view').inert && document.getElementById('wizard-view').inert), true, 'background inert');
});

test('modal: focus is trapped for Tab and Shift+Tab', async (page, p) => {
  await completeWizard(page, p, {idea: 'Lemonade stand', kind: 'product', name: 'Sunny Sips'});
  await openModal(page, p);
  const seen = new Set();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    const r = await page.evaluate(() => ({inside: document.getElementById('reset-modal').contains(document.activeElement), id: document.activeElement.id}));
    assert(r.inside, `Tab #${i + 1} stays inside (on ${r.id})`);
    seen.add(r.id);
  }
  eq([...seen].sort(), ['backup-json-btn', 'backup-md-btn', 'backup-print-btn', 'reset-cancel-btn', 'reset-confirm-btn'], 'cycles all controls');
  await page.focus('#backup-json-btn');
  await page.keyboard.press('Shift+Tab');
  eq(await page.evaluate(() => document.activeElement.id), 'reset-confirm-btn', 'Shift+Tab from first wraps to last');
});

test('modal: Escape cancels and returns focus; plan untouched', async (page, p) => {
  await completeWizard(page, p, {idea: 'Lemonade stand', kind: 'product', name: 'Sunny Sips'});
  const saved = await stored(page);
  await openModal(page, p);
  await page.keyboard.press('Escape');
  assert(await page.locator('#reset-overlay').isHidden(), 'closed');
  eq(await page.evaluate(() => document.activeElement.id), 'start-again-btn', 'focus returned');
  eq(await stored(page), saved, 'storage untouched');
  assert(await page.locator('#plan-view').isVisible(), 'plan still shown');
  eq(await page.evaluate(() => document.getElementById('plan-view').inert), false, 'inert removed');
});

test('modal: backdrop click/tap cancels; clicks inside and drags out do not', async (page, p) => {
  await completeWizard(page, p, {idea: 'Lemonade stand', kind: 'product', name: 'Sunny Sips'});
  await openModal(page, p);
  const tapAt = (x, y) => isTouch(p) ? page.touchscreen.tap(x, y) : page.mouse.click(x, y);
  const mb = await page.locator('#reset-modal').boundingBox();
  await tapAt(mb.x + 20, mb.y + 20);
  assert(await page.locator('#reset-overlay').isVisible(), 'inside press keeps it open');
  if (!isTouch(p)) {
    await page.mouse.move(mb.x + 20, mb.y + 20); await page.mouse.down();
    await page.mouse.move(4, 4); await page.mouse.up();
    assert(await page.locator('#reset-overlay').isVisible(), 'drag from inside to backdrop keeps it open');
  }
  await tapAt(5, 5);
  assert(await page.locator('#reset-overlay').isHidden(), 'backdrop closes');
  assert(await stored(page), 'plan still stored');
});

test('modal: Cancel button closes without resetting', async (page, p) => {
  await completeWizard(page, p, {idea: 'Lemonade stand', kind: 'product', name: 'Sunny Sips'});
  await openModal(page, p);
  await press(p, page.locator('#reset-cancel-btn'));
  assert(await page.locator('#reset-overlay').isHidden(), 'closed');
  assert(JSON.parse(await stored(page)).finished, 'plan intact');
});

test('export: .json backup contents, filename, status, and no auto-reset', async (page, p) => {
  await completeWizard(page, p, {idea: 'Lemonade stand', kind: 'product', name: 'Sunny Sips!'});
  await openModal(page, p);
  const [dl] = await Promise.all([page.waitForEvent('download'), press(p, page.locator('#backup-json-btn'))]);
  assert(/^sunny-sips-\d{4}-\d{2}-\d{2}\.json$/.test(dl.suggestedFilename()), 'filename: ' + dl.suggestedFilename());
  const data = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
  eq(data.app, 'squish-hq', 'app marker');
  eq(data.schemaVersion, 1, 'schema version');
  eq(data.finished, true, 'finished flag');
  eq(JSON.stringify(data.state), await page.evaluate(() => JSON.stringify(state)), 'state round-trips exactly');
  assert((await page.locator('#backup-status').textContent()).includes('Saved sunny-sips-'), 'status says saved');
  await page.waitForTimeout(800);
  assert(await page.locator('#reset-overlay').isVisible(), 'modal stays open after download');
  assert(await stored(page), 'no auto-reset after backup');
  assert(await page.locator('#plan-view').isVisible(), 'plan still there');
});

test('export: .md readable plan', async (page, p) => {
  await completeWizard(page, p, {idea: 'Lemonade stand', kind: 'product', name: 'Sunny Sips'});
  await openModal(page, p);
  const [dl] = await Promise.all([page.waitForEvent('download'), press(p, page.locator('#backup-md-btn'))]);
  assert(/^sunny-sips-\d{4}-\d{2}-\d{2}\.md$/.test(dl.suggestedFilename()), 'filename: ' + dl.suggestedFilename());
  const md = fs.readFileSync(await dl.path(), 'utf8');
  for (const s of ['# ', 'Sunny Sips', '## The money', '| Price per cup | £1.50 |', '| **Total to start** | **£8.50** |',
                   'Total profit in 4 weeks: £52.80', '## What could go wrong', 'Parents lend it', 'Ava', 'Ben']) {
    assert(md.includes(s), 'md contains ' + JSON.stringify(s));
  }
  assert(md.includes('The corner shop & big websites'), 'ampersand kept literally (no HTML escaping in text)');
});

test('export: print reuses window.print and does not reset', async (page, p) => {
  await completeWizard(page, p, {idea: 'Lemonade stand', kind: 'product', name: 'Sunny Sips'});
  await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
  await openModal(page, p);
  await press(p, page.locator('#backup-print-btn'));
  eq(await page.evaluate(() => window.__printed), 1, 'print called');
  assert(await page.locator('#reset-overlay').isVisible(), 'still open');
  const hiddenInPrint = await page.evaluate(() => [...document.styleSheets].map(s => { try { return [...s.cssRules]; } catch (e) { return []; } } ).some(rs => rs.some(r => r.media && r.media.mediaText === 'print' && r.cssText.includes('.modal-overlay'))));
  assert(hiddenInPrint, 'modal hidden by print CSS');
});

/* ================= PART 1: RESET ================= */

test('reset: clears storage, state, charts, views; focus and scroll to top', async (page, p) => {
  await completeWizard(page, p, {idea: 'Lemonade stand', kind: 'product', name: 'Sunny Sips'});
  await page.evaluate(() => window.scrollTo(0, 800));
  await openModal(page, p);
  await press(p, page.locator('#reset-confirm-btn'));
  eq(await stored(page), null, 'storage key cleared');
  const s = await page.evaluate(() => ({
    state: JSON.stringify(state), def: JSON.stringify(DEFAULT_STATE), sameRef: state === DEFAULT_STATE,
    step: currentStep, finished, nav: hasNavigatedOnce, unit: profile.unit,
    charts: Object.keys(Chart.instances).length, planShown: getComputedStyle(document.getElementById('plan-view')).display,
    fab: document.getElementById('edit-plan-btn') ? 'present' : 'none', scrollY: window.scrollY,
    focus: document.activeElement.id, overlayHidden: document.getElementById('reset-overlay').hidden,
  }));
  eq(s.state, s.def, 'state is a copy of the default');
  eq(s.sameRef, false, 'deep copy, not the default object itself');
  eq([s.step, s.finished, s.nav, s.unit], [0, false, false, 'item'], 'step/finished/navigated/profile reset');
  eq(s.charts, 0, 'Chart.js instances destroyed');
  eq([s.planShown, s.fab], ['none', 'none'], 'plan view and edit button hidden');
  assert(await page.locator('#start-btn').isVisible(), 'welcome screen visible');
  eq(s.scrollY, 0, 'scrolled to top');
  eq(s.focus, 'start-btn', 'focus on the start button');
  eq(s.overlayHidden, true, 'modal closed');
});

test('reset trap: pagehide/beforeunload/visibilitychange, reload, close+reopen cannot resurrect', async (page, p, ctx) => {
  await completeWizard(page, p, {idea: 'Lemonade stand', kind: 'product', name: 'Sunny Sips'});
  await openModal(page, p);
  await press(p, page.locator('#reset-confirm-btn'));
  await page.evaluate(() => {
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('beforeunload'));
    Object.defineProperty(document, 'visibilityState', {value: 'hidden', configurable: true});
    document.dispatchEvent(new Event('visibilitychange'));
  });
  eq(await stored(page), null, 'save handlers wrote nothing');
  await page.reload();
  assert(await page.locator('#start-btn').isVisible(), 'reload lands on welcome');
  eq(await stored(page), null, 'storage still empty after reload');
  eq(await page.evaluate(() => JSON.stringify(state) === JSON.stringify(DEFAULT_STATE)), true, 'empty state after reload');
  // Real background: open a second tab over it, then come back.
  const other = await ctx.newPage(); await other.goto('about:blank'); await other.close();
  await page.close({runBeforeUnload: true});
  const reopened = await ctx.newPage();
  await reopened.goto(URL_);
  assert(await reopened.locator('#start-btn').isVisible(), 'close + reopen lands on welcome');
  eq(await stored(reopened), null, 'storage empty after close + reopen');
  // Starting again then saves only a clean default.
  await reopened.click('#start-btn');
  eq(JSON.parse(await stored(reopened)).state.businessName, '', 'first save after reset is clean');
  return reopened;
});

test('reset trap: a second open tab cannot write the old plan back', async (page, p, ctx) => {
  await completeWizard(page, p, {idea: 'Lemonade stand', kind: 'product', name: 'Sunny Sips'});
  const b = await ctx.newPage();
  await b.goto(URL_);
  await b.waitForSelector('#plan-view', {state: 'visible'});
  await b.click('#edit-plan-btn'); // tab B now has hasNavigatedOnce = true, so its savers are armed
  await openModal(page, p);
  await press(p, page.locator('#reset-confirm-btn'));
  await b.waitForSelector('#start-btn');
  await b.close({runBeforeUnload: true});
  await page.reload();
  assert(await page.locator('#start-btn').isVisible(), 'still welcome');
  eq(await stored(page), null, 'other tab did not resurrect the plan');
});

/* ================= PART 1: IMPORT ================= */

test('round trip: export -> reset -> import gives an identical plan page', async (page, p) => {
  await completeWizard(page, p, {idea: 'Lemonade stand', kind: 'product', name: 'Sunny Sips', currency: 'THB'});
  const before = await planSnapshot(page);
  await openModal(page, p);
  const [dl] = await Promise.all([page.waitForEvent('download'), press(p, page.locator('#backup-json-btn'))]);
  const file = tmpFile(`rt-${p.name}.json`); await dl.saveAs(file);
  await press(p, page.locator('#reset-confirm-btn'));
  await importFile(page, file);
  await page.waitForSelector('#plan-view', {state: 'visible'});
  await page.waitForFunction(() => window.Chart && Chart.getChart('profit-chart'));
  const after = await planSnapshot(page);
  eq(after.text, before.text, 'plan page text identical');
  eq(after.costs, before.costs, 'costs chart identical');
  eq(after.profit, before.profit, 'profit chart identical');
  eq(after.state, before.state, 'state identical');
  await page.reload();
  await page.waitForFunction(() => window.Chart && Chart.getChart('profit-chart'));
  eq((await planSnapshot(page)).text, before.text, 'imported plan persists across reload');
});

test('round trip works for service, generic fallback, BTC and SATS', async (page, p) => {
  for (const o of [
    {idea: 'Dog walking', kind: 'service', name: 'Pawsome Walks', currency: 'BTC', cost: '0.00001', price: '0.0002'},
    {idea: 'Slime making', kind: 'product', name: 'Slime Time', currency: 'SATS', cost: '100', price: '750', solo: true},
  ]) {
    await freshStart(page);
    await completeWizard(page, p, o);
    const before = await planSnapshot(page);
    await openModal(page, p);
    const [dl] = await Promise.all([page.waitForEvent('download'), press(p, page.locator('#backup-json-btn'))]);
    const file = tmpFile(`rt2-${p.name}.json`); await dl.saveAs(file);
    await press(p, page.locator('#reset-confirm-btn'));
    await importFile(page, file);
    await page.waitForFunction(() => window.Chart && Chart.getChart('profit-chart'));
    eq((await planSnapshot(page)).text, before.text, `${o.idea} identical`);
  }
});

test('import: unfinished backup lands on its step; "finished" with gaps lands on first gap', async (page) => {
  await importFile(page, writeTmp('midway.json', goodBackup(b => { b.finished = false; b.currentStep = 6; })));
  await page.waitForSelector('.step-kicker');
  eq(await kicker(page), 'Step 6 of 11', 'lands on saved step');
  eq(await page.inputValue('#f-price'), '1.5', 'values restored');
  await freshStart(page);
  await importFile(page, writeTmp('gappy.json', goodBackup(b => { b.state.risks = []; })));
  await page.waitForSelector('.step-kicker');
  eq(await kicker(page), 'Step 11 of 11', 'a "finished" file with no risks goes to the risks step, not the plan');
  assert(await page.locator('#plan-view').isHidden(), 'plan not shown');
});

const BAD_FILES = [
  ['not-json.json', 'this is not json {', /doesn't look like a Squish HQ plan/],
  ['empty.json', '', /doesn't look like a Squish HQ plan/],
  ['array.json', '[1,2,3]', /doesn't look like a Squish HQ plan/],
  ['null.json', 'null', /doesn't look like a Squish HQ plan/],
  ['no-marker.json', JSON.stringify({schemaVersion: 1, state: {}}), /doesn't look like a Squish HQ plan/],
  ['wrong-app.json', goodBackup(b => { b.app = 'other'; }), /doesn't look like a Squish HQ plan/],
  ['no-version.json', goodBackup(b => { delete b.schemaVersion; }), /doesn't look like a Squish HQ plan/],
  ['string-version.json', goodBackup(b => { b.schemaVersion = '1'; }), /doesn't look like a Squish HQ plan/],
  ['future.json', goodBackup(b => { b.schemaVersion = 99; }), /newer version/],
  ['state-string.json', goodBackup(b => { b.state = 'hello'; }), /broken or has been changed/],
  ['no-founders.json', goodBackup(b => { delete b.state.founders; }), /broken or has been changed/],
  ['founders-object.json', goodBackup(b => { b.state.founders = {name: 'x'}; }), /broken or has been changed/],
  ['founders-empty.json', goodBackup(b => { b.state.founders = []; }), /broken or has been changed/],
  ['founder-share.json', goodBackup(b => { b.state.founders[0].sharePct = 'lots'; }), /broken or has been changed/],
  ['founder-share-range.json', goodBackup(b => { b.state.founders[0].sharePct = 500; }), /broken or has been changed/],
  ['founder-roles.json', goodBackup(b => { b.state.founders[0].roles = 'boss'; }), /broken or has been changed/],
  ['founder-unknown-role.json', goodBackup(b => { b.state.founders[0].roles = ['<b>Boss</b>']; }), /broken or has been changed/],
  ['currency.json', goodBackup(b => { b.state.currency = 'XXX'; }), /broken or has been changed/],
  ['kind.json', goodBackup(b => { b.state.businessKind = 'evil'; }), /broken or has been changed/],
  ['price-text.json', goodBackup(b => { b.state.sellPrice = '1e9999'; }), /broken or has been changed/],
  ['price-negative.json', goodBackup(b => { b.state.unitCost = '-5'; }), /broken or has been changed/],
  ['price-object.json', goodBackup(b => { b.state.sellPrice = {valueOf: 1}; }), /broken or has been changed/],
  ['audience-objects.json', goodBackup(b => { b.state.audience = [{text: 'x'}]; }), /broken or has been changed/],
  ['cost-row.json', goodBackup(b => { b.state.startupCosts = [{label: 'x', amount: 'NaN'}]; }), /broken or has been changed/],
  ['risk-row.json', goodBackup(b => { b.state.risks = ['oops']; }), /broken or has been changed/],
  ['money-source.json', goodBackup(b => { b.state.startupMoneySource = 'A bank robbery'; }), /broken or has been changed/],
  ['name-number.json', goodBackup(b => { b.state.businessName = 42; }), /broken or has been changed/],
  ['huge.json', goodBackup(b => { b.state.competitors = 'x'.repeat(300 * 1024); }), /too big/],
];

test(`import: ${BAD_FILES.length} malformed files are rejected with a friendly message`, async (page) => {
  for (const [name, content, re] of BAD_FILES) {
    await importFile(page, writeTmp(name, content));
    await page.waitForFunction(() => document.getElementById('load-plan-msg').textContent.length > 0);
    const msg = await page.locator('#load-plan-msg').textContent();
    assert(re.test(msg), `${name}: message was "${msg}"`);
    eq(await page.locator('#load-plan-msg').getAttribute('class'), 'load-msg bad', `${name}: error styling`);
    assert(await page.locator('#start-btn').isVisible(), `${name}: still on welcome`);
    eq(await stored(page), null, `${name}: nothing saved`);
    eq(await page.evaluate(() => JSON.stringify(state) === JSON.stringify(DEFAULT_STATE)), true, `${name}: state untouched`);
    await page.evaluate(() => { document.getElementById('load-plan-msg').textContent = ''; });
  }
});

test('import: malicious strings are escaped on every render path; extras dropped; lengths clamped', async (page, p) => {
  const X = n => `<img src=x onerror="window.__pwned=(window.__pwned||0)+1" data-n="${n}">"'&amp;`;
  const file = writeTmp('evil.json', goodBackup(b => {
    const s = b.state;
    s.ideaText = X('idea'); s.businessName = X('name'); s.tagline = X('tag'); s.mascotEmoji = '<svg onload=alert(1)>';
    s.founders = [{name: X('f1'), roles: ['Counting the money'], sharePct: 60}, {name: X('f2'), roles: ['Talking to customers'], sharePct: 40}];
    s.equalShares = false;
    s.audience = [X('aud')]; s.sellPlaces = [X('place')]; s.marketingIdeas = [X('mkt')];
    s.startupCosts = [{label: X('cost'), amount: '3'}]; s.competitors = X('comp'); s.betterThan = X('better');
    s.risks = [{name: X('risk'), fix: X('fix')}];
    s.__proto__evil = 1; s.unknownKey = 'drop me';
    b.state = JSON.parse(JSON.stringify(s).replace('"__proto__evil":1', '"__proto__":{"polluted":"yes"}'));
    b.extraTopLevel = {x: 1};
  }));
  await importFile(page, file);
  await page.waitForSelector('#plan-view', {state: 'visible'});
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => ({
    pwned: window.__pwned, polluted: ({}).polluted, imgs: document.querySelectorAll('#plan-shell img, #plan-shell svg').length,
    keys: Object.keys(state).sort().join(), defKeys: Object.keys(DEFAULT_STATE).sort().join(),
    nameLen: state.businessName.length, mascot: state.mascotEmoji, h1: document.querySelector('#plan-shell h1').textContent,
  }));
  eq(r.pwned, undefined, 'no script ran on the plan page');
  eq(r.polluted, undefined, 'no prototype pollution');
  eq(r.imgs, 0, 'no injected elements on the plan page');
  eq(r.keys, r.defKeys, 'unknown keys dropped');
  eq(r.nameLen, 40, 'businessName clamped to 40');
  eq(r.mascot, '<svg onload=aler', 'emoji clamped to 16 and kept as text');
  assert(r.h1.includes('<svg onload=aler') && r.h1.includes('<img src=x'), 'hostile text is shown literally');
  // Walk every wizard step with the hostile data loaded.
  await page.click('#edit-plan-btn');
  for (let i = 0; i < 11; i++) {
    const hits = await page.evaluate(() => ({pwned: window.__pwned, imgs: document.querySelectorAll('#step-container img, #step-container svg').length}));
    eq(hits, {pwned: undefined, imgs: 0}, `wizard step ${i + 1} safe`);
    if (i === 0) eq(await page.inputValue('#f-idea'), `<img src=x onerror="window.__pwned=(window.__pwned||0)+1" data-n="idea">"'&amp;`.slice(0, 60), 'attribute value round-trips exactly (incl. &amp;)');
    await next(page);
  }
  await page.click('#view-plan-btn');
  eq(await page.evaluate(() => window.__pwned), undefined, 'still safe after re-render');
  await openModal(page, p);
  eq(await page.evaluate(() => document.querySelectorAll('#reset-modal img, #reset-modal svg').length), 0, 'modal name is text-only');
  const [dl] = await Promise.all([page.waitForEvent('download'), press(p, page.locator('#backup-md-btn'))]);
  const md = fs.readFileSync(await dl.path(), 'utf8');
  assert(!/(^|[^\\])<(img|svg)/.test(md) && md.includes('\\<img'),'.md has no raw HTML tags (they are backslash-escaped)');
});

/* ================= ROUND 2, STAGE 1: FIX LIST ================= */

// Puts a complete plan straight into the page (no wizard clicking) and shows it.
async function loadPlanState(page, mutate) {
  const b = JSON.parse(goodBackup(mutate));
  await page.evaluate(s => {
    state = sanitizeState(s, []); refreshProfile();
    finished = true; hasNavigatedOnce = true; saveState(); showPlan();
  }, b.state);
}
const planText = page => page.locator('#plan-shell').innerText();
async function kb(page, locator, key = 'Space') { await locator.focus(); await page.keyboard.press(key); }
const activeInfo = page => page.evaluate(() => ({tag: document.activeElement.tagName, cls: document.activeElement.className, id: document.activeElement.id}));
const visibleH1s = page => page.evaluate(() => [...document.querySelectorAll('h1')].filter(h => h.offsetParent !== null).map(h => h.textContent.trim()));

test('fix 1: "Keep track of the money" reads correctly in all 12 currencies, product and service', async (page) => {
  const codes = await page.evaluate(() => CURRENCIES.map(c => c.code));
  eq(codes.length, 12, '12 currencies');
  for (const code of codes) for (const kind of ['product', 'service']) {
    await loadPlanState(page, b => { b.state.currency = code; b.state.businessKind = kind; });
    const txt = await planText(page);
    const want = kind === 'service' ? 'Write down every job and everything you spend' : 'Write down every sale and everything you spend';
    assert(txt.includes(want), `${code}/${kind}: sentence present`);
    assert(!/\.00(sale|job)|[£$€¥₹฿₿]\.\d|sats?\.\d/.test(txt), `${code}/${kind}: no mangled currency`);
  }
});

test('fix 2: the whole wizard can be completed with the keyboard only', async (page) => {
  await kb(page, page.locator('#start-btn'), 'Enter');
  eq((await activeInfo(page)).cls, 'step-title', 'focus moves to the step heading');
  await page.locator('#f-idea').focus(); await page.keyboard.type('Dog walking');
  await kb(page, page.locator('#next-btn'), 'Enter');
  // Step 2: the one that used to be impossible by keyboard.
  const service = page.locator('.choice-card', {hasText: 'I offer a service'});
  eq(await service.evaluate(e => e.tagName), 'BUTTON', 'choice card is a real button');
  await kb(page, service, 'Space');
  eq(await service.getAttribute('aria-pressed'), 'true', 'Space selects, aria-pressed updates');
  eq(await page.locator('.choice-card', {hasText: 'I sell things'}).getAttribute('aria-pressed'), 'false', 'other option unpressed');
  await kb(page, page.locator('#next-btn'), 'Enter');
  eq(await kicker(page), 'Step 3 of 11', 'step 2 done by keyboard');
  await page.locator('#f-name').focus(); await page.keyboard.type('Paws');
  const mascot = page.locator('#mascot-row .chip').nth(1);
  await kb(page, mascot, 'Enter');
  eq(await mascot.getAttribute('aria-pressed'), 'true', 'mascot picked with Enter');
  await kb(page, page.locator('#next-btn'), 'Enter');
  await page.locator('#f-founder-0').focus(); await page.keyboard.type('Ava');
  const job = page.locator('.founder-card').nth(0).locator('.chip').first();
  await kb(page, job, 'Space');
  eq(await job.getAttribute('aria-pressed'), 'true', 'job chip toggled on');
  await kb(page, page.locator('.founder-card').nth(1).locator('.remove-founder'), 'Enter');
  eq((await activeInfo(page)).cls, 'add-row-btn', 'focus lands on "Add another founder" after removing');
  await kb(page, page.locator('#next-btn'), 'Enter');
  await kb(page, page.locator('.suggest-tiles').nth(0).locator('.suggest-tile-add').first(), 'Enter');
  assert((await activeInfo(page)).tag !== 'BODY', 'focus not dropped after adding a tile');
  await kb(page, page.locator('.suggest-tiles').nth(1).locator('.suggest-tile-add').first(), 'Enter');
  await kb(page, page.locator('#next-btn'), 'Enter');
  await page.locator('#f-price').focus(); await page.keyboard.type('4');
  await kb(page, page.locator('#next-btn'), 'Enter');
  await kb(page, page.locator('#cost-tiles .suggest-tile-add').first(), 'Enter');
  await page.locator('.c-amount').first().focus(); await page.keyboard.type('3');
  await kb(page, page.locator('#src-row .chip').first(), 'Space');
  await kb(page, page.locator('#next-btn'), 'Enter');
  await page.locator('#f-goal').focus(); await page.keyboard.type('5');
  await kb(page, page.locator('#next-btn'), 'Enter');
  await page.locator('#f-comp').focus(); await page.keyboard.type('The pet shop');
  await page.locator('#f-better').focus(); await page.keyboard.type('We are friendly');
  await kb(page, page.locator('#next-btn'), 'Enter');
  await kb(page, page.locator('.suggest-tile-add').first(), 'Enter');
  await kb(page, page.locator('#next-btn'), 'Enter');
  await kb(page, page.locator('#risk-tiles .suggest-tile-add').first(), 'Enter');
  await kb(page, page.locator('#next-btn'), 'Enter');
  await kb(page, page.locator('#view-plan-btn'), 'Enter');
  await page.waitForSelector('#plan-view', {state: 'visible'});
  eq((await activeInfo(page)).tag, 'H1', 'focus moves to the plan heading');
});

test('fix 2: every control is a real button or labelled field on every step', async (page, p) => {
  await completeWizard(page, p, {idea: 'Lemonade stand', kind: 'product', name: 'Sunny Sips'});
  await page.click('#edit-plan-btn');
  for (let i = 1; i <= 11; i++) {
    const r = await page.evaluate(() => {
      const vis = e => e.offsetParent !== null;
      const name = e => (e.labels && e.labels.length && e.labels[0].textContent.trim()) || e.getAttribute('aria-label') ||
        (e.getAttribute('aria-labelledby') || '').split(' ').map(id => (document.getElementById(id) || {}).textContent || '').join(' ').trim();
      const unnamedFields = [...document.querySelectorAll('#step-container input, #step-container select, #step-container textarea')].filter(vis).filter(e => !name(e)).map(e => e.outerHTML.slice(0, 80));
      const unnamedButtons = [...document.querySelectorAll('#step-container button')].filter(vis).filter(b => !b.textContent.trim() && !b.getAttribute('aria-label')).map(b => b.outerHTML.slice(0, 80));
      const fakeButtons = [...document.querySelectorAll('.choice-card, .chip, .idea-example-tile')].filter(e => e.tagName !== 'BUTTON').map(e => e.outerHTML.slice(0, 80));
      const orphanLabels = [...document.querySelectorAll('#step-container label')].filter(l => !l.control).map(l => l.textContent.trim());
      const toggles = [...document.querySelectorAll('#step-container .chip, #step-container #kind-choices .choice-card')].filter(b => !b.closest('#name-suggest-tiles')).filter(b => !b.hasAttribute('aria-pressed')).map(b => b.textContent.trim());
      return {unnamedFields, unnamedButtons, fakeButtons, orphanLabels, toggles};
    });
    eq(r, {unnamedFields: [], unnamedButtons: [], fakeButtons: [], orphanLabels: [], toggles: []}, `step ${i}`);
    await next(page);
  }
});

test('fix 2: focus to heading on step change, errors use role=alert, progress bar is exposed', async (page, p) => {
  await page.click('#start-btn');
  eq((await activeInfo(page)).cls, 'step-title', 'heading focused');
  const pb = page.locator('[role=progressbar]');
  eq([await pb.getAttribute('aria-valuenow'), await pb.getAttribute('aria-valuemax'), await pb.getAttribute('aria-valuetext')], ['1', '11', 'Step 1 of 11'], 'progressbar values');
  await next(page);
  const alert = page.locator('.error-msg[role=alert]');
  assert((await alert.textContent()).includes('Tell us your business idea'), 'error announced in role=alert');
  await page.fill('#f-idea', 'Lemonade stand'); await next(page);
  eq(await pb.getAttribute('aria-valuetext'), 'Step 2 of 11', 'progress updates');
  eq((await activeInfo(page)).cls, 'step-title', 'heading focused after Next');
});

test('fix 2: prefers-reduced-motion turns off confetti, pop-in and hover lift', async (page, p) => {
  await page.emulateMedia({reducedMotion: 'reduce'});
  await page.click('#start-btn');
  const r = await page.evaluate(() => getComputedStyle(document.querySelector('.card')).animationName);
  eq(r, 'none', 'no pop-in animation');
  await page.fill('#f-idea', 'Lemonade stand'); await next(page);
  const card = page.locator('.choice-card').first();
  if (!isTouch(p)) await card.hover();
  await press(p, card);
  eq(await card.evaluate(e => getComputedStyle(e).transform), 'none', 'no lift on selected/hovered card');
  await freshStart(page);
  await page.emulateMedia({reducedMotion: 'reduce'});
  await completeWizard(page, p, {idea: 'Lemonade stand', kind: 'product', name: 'Sunny Sips'});
  eq(await page.evaluate(() => document.getElementById('confetti-canvas').width), 300, 'confetti never started (canvas untouched)');
  await page.emulateMedia({reducedMotion: 'no-preference'});
  await page.click('#edit-plan-btn');
  for (let i = 0; i < 11; i++) await next(page);
  await page.click('#view-plan-btn');
  eq(await page.evaluate(() => document.getElementById('confetti-canvas').width === window.innerWidth), true, 'confetti does run normally');
});

test('fix 2: exactly one visible h1 on every screen', async (page, p) => {
  eq((await visibleH1s(page)).length, 1, 'welcome');
  await completeWizard(page, p, {idea: 'Lemonade stand', kind: 'product', name: 'Sunny Sips'});
  const planH1 = await visibleH1s(page);
  eq(planH1.length, 1, 'plan page');
  assert(planH1[0].endsWith('Sunny Sips'), 'plan h1 is the business name');
  await page.click('#edit-plan-btn');
  for (let i = 1; i <= 11; i++) {
    eq((await visibleH1s(page)).length, 1, `step ${i}`);
    await next(page);
  }
  eq(await visibleH1s(page), ['Your plan is ready!'], 'finish screen');
  await page.click('#view-plan-btn');
  await openModal(page, p);
  eq((await visibleH1s(page)).length, 1, 'with the dialog open');
});

test('fix 3: colour pairs meet WCAG AA (text 4.5:1, field borders and focus ring 3:1)', async (page) => {
  const lum = hex => { const c = hex.match(/\d+/g).slice(0, 3).map(v => v / 255).map(v => v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
  const v = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const rgb = name => { const d = document.createElement('div'); d.style.color = cs.getPropertyValue(name).trim(); document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; };
    return Object.fromEntries(['--mint-ink', '--lilac-ink', '--pink-ink', '--field-border', '--placeholder', '--plum', '--plum-soft', '--pink', '--mint-tint', '--lilac-tint', '--pink-tint', '--white', '--cream-dim', '--cream', '--yellow-tint'].map(n => [n, rgb(n)]));
  });
  const pairs = [
    ['--mint-ink', '--mint-tint', 4.5, 'step kicker, founder badges'], ['--mint-ink', '--white', 4.5, '+ Add buttons'], ['--mint-ink', '--cream-dim', 4.5, 'picked chips'],
    ['--lilac-ink', '--white', 4.5, 'regen buttons'], ['--lilac-ink', '--lilac-tint', 4.5, 'word card title'], ['--pink-ink', '--white', 4.5, 'remove buttons'], ['--pink-ink', '--pink-tint', 4.5, 'remove hover'],
    ['--plum', '--pink', 4.5, 'primary button text'], ['--plum-soft', '--cream-dim', 4.5, 'chips'], ['--plum-soft', '--white', 4.5, 'hints'],
    ['--placeholder', '--cream-dim', 4.5, 'placeholders'], ['--placeholder', '--white', 4.5, 'placeholders (focused)'],
    ['--field-border', '--white', 3, 'field border vs card'], ['--field-border', '--cream-dim', 3, 'field border vs field'], ['--plum', '--white', 3, 'focus ring'],
    ['--plum', '--yellow-tint', 4.5, 'nudges'],
  ];
  const fails = pairs.map(([f, b, min, what]) => [what, +ratio(v[f], v[b]).toFixed(2), min]).filter(([, r, min]) => r < min);
  eq(fails, [], 'no failing pairs');
});

test('fix 4: plan copy reads naturally for any input and keeps capitals', async (page) => {
  await loadPlanState(page, b => {
    Object.assign(b.state, {ideaText: 'Dog walking', businessKind: 'service', businessName: 'Pawsome Walks',
      audience: ['Neighbours with dogs'], sellPlaces: ['Around the neighbourhood']});
  });
  let txt = await planText(page);
  for (const bad of ['to Neighbours', 'through Around', 'offers dog walking', 'sells dog walking', ' - ', '—']) assert(!txt.includes(bad), 'no ' + JSON.stringify(bad));
  assert(txt.includes('Pawsome Walks is a small business that offers a service.'), 'neutral idea template');
  assert(txt.includes('The idea: Dog walking'), 'idea shown as typed');
  eq(await page.locator('#plan-shell .plan-section').nth(1).locator('li').allTextContents(), ['Neighbours with dogs', 'Around the neighbourhood'], 'customers and places are short lists');
  await loadPlanState(page, b => { Object.assign(b.state, {ideaText: 'Minecraft skins for NASA fans', businessName: 'Blocky'}); });
  txt = await planText(page);
  assert(txt.includes('The idea: Minecraft skins for NASA fans'), 'proper nouns untouched');
  assert(!/minecraft|nasa/.test(txt), 'nothing lowercased');
});

test('fix 5: with Chart.js missing the plan, saving, Start again, backups and import all still work', async (page, p, ctx) => {
  const dir = copyApp({omit: [path.join('vendor', 'chart.js-4.5.1', 'chart.umd.min.js')]});
  await page.goto(pathToFileURL(path.join(dir, 'index.html')).href);
  eq(await page.evaluate(() => typeof window.Chart), 'undefined', 'Chart.js really is missing');
  await page.click('#start-btn');
  await page.fill('#f-idea', 'Lemonade stand'); await next(page);
  await page.reload();
  eq(await kicker(page), 'Step 2 of 11', 'saving works without Chart.js');
  await loadPlanState(page);
  await page.reload();
  assert(await page.locator('#plan-view').isVisible(), 'plan shows after reload');
  eq(await page.locator('.chart-fallback').count(), 2, 'a note in place of each chart');
  assert((await page.locator('.chart-fallback').first().textContent()).includes('could not load'), 'friendly note');
  assert((await planText(page)).includes('Lemons and sugar'), 'tables still there');
  await openModal(page, p);
  const [dl] = await Promise.all([page.waitForEvent('download'), press(p, page.locator('#backup-json-btn'))]);
  const file = tmpFile(`nochart-${p.name}.json`); await dl.saveAs(file);
  await press(p, page.locator('#reset-confirm-btn'));
  eq(await stored(page), null, 'reset works');
  await importFile(page, file);
  await page.waitForSelector('#plan-view', {state: 'visible'});
  eq(await page.locator('.chart-fallback').count(), 2, 'import works too');
});

test('fix 6: business profiles match whole words only', async (page) => {
  const r = await page.evaluate(() => Object.fromEntries([
    'Minecraft skins', 'Friendship bracelets', 'Dog walking', 'Car washing', 'Cupcakes', 'Homework tutoring',
    'Squishy toys', 'Lemonade stand', 'Aircraft models', 'Scraft', 'Handicrafts', 'Bakes'].map(t => [t, matchBusinessProfile(t, null).unit])));
  eq(r, {'Minecraft skins': 'item', 'Friendship bracelets': 'bracelet', 'Dog walking': 'walk', 'Car washing': 'wash', 'Cupcakes': 'treat',
    'Homework tutoring': 'session', 'Squishy toys': 'squishy', 'Lemonade stand': 'cup', 'Aircraft models': 'item', 'Scraft': 'item', 'Handicrafts': 'item', 'Bakes': 'treat'}, 'matches');
});

test('fix 7: the profit chart title matches what it shows', async (page, p) => {
  await completeWizard(page, p, {idea: 'Lemonade stand', kind: 'product', name: 'Sunny Sips'});
  const r = await page.evaluate(() => ({title: document.getElementById('profit-chart-title').textContent, data: Chart.getChart('profit-chart').data.datasets[0].data}));
  eq(r.title, 'Your profit adding up over 4 weeks (if you hit your goal)', 'title');
  eq(r.data.map(v => +v.toFixed(2)), [13.2, 26.4, 39.6, 52.8], 'data adds up week by week');
  assert(!(await planText(page)).includes('monthly'), 'no "monthly" wording left');
});

test('fix 8: jobs are offered by kind, and picked jobs survive a kind change', async (page, p) => {
  await page.click('#start-btn');
  await page.fill('#f-idea', 'Lemonade stand'); await next(page);
  await press(p, page.locator('.choice-card', {hasText: 'I sell things'})); await next(page);
  await page.fill('#f-name', 'Sips'); await next(page);
  const chips = () => page.locator('.founder-card').nth(0).locator('.chip').allTextContents();
  assert((await chips()).includes('Keeping track of stock'), 'product jobs offered');
  await press(p, page.locator('.founder-card').nth(0).locator('.chip', {hasText: 'Keeping track of stock'}));
  await page.click('#back-btn'); await page.click('#back-btn');
  await press(p, page.locator('.choice-card', {hasText: 'I offer a service'})); await next(page); await next(page);
  const now = await chips();
  assert(now.includes('Doing the jobs really well'), 'service jobs offered');
  assert(!now.includes('Making the product look amazing'), 'unpicked product-only jobs hidden');
  const kept = page.locator('.founder-card').nth(0).locator('.chip', {hasText: 'Keeping track of stock'});
  eq(await kept.getAttribute('aria-pressed'), 'true', 'already-picked job still shown and selected');
});

test('fix 9: nothing floats over the plan text on phones or desktop', async (page, p) => {
  await completeWizard(page, p, {idea: 'Lemonade stand', kind: 'product', name: 'Sunny Sips'});
  const floating = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(e => {
    const cs = getComputedStyle(e);
    return (cs.position === 'fixed' || cs.position === 'sticky') && cs.pointerEvents !== 'none' && e.offsetParent !== null || (cs.position === 'fixed' && cs.display !== 'none' && cs.pointerEvents !== 'none' && !e.closest('[hidden]') && e.getBoundingClientRect().width > 0);
  }).map(e => e.id || e.className));
  eq(floating, [], 'no fixed/sticky interactive elements');
  const b = await page.locator('#edit-plan-btn').boundingBox();
  assert(b.height >= 44, 'Edit plan is a decent tap target');
});

test('fix 10: no em dashes anywhere a child can read (every screen, dialog and .md)', async (page, p) => {
  const seen = [];
  seen.push(await page.locator('body').innerText());
  await completeWizard(page, p, {idea: 'Lemonade stand', kind: 'product', name: 'Sunny Sips'});
  seen.push(await page.locator('body').innerText());
  await page.click('#edit-plan-btn');
  for (let i = 1; i <= 11; i++) { await next(page); seen.push(await page.locator('body').innerText()); }
  await page.click('#view-plan-btn');
  await openModal(page, p);
  seen.push(await page.locator('body').innerText());
  seen.push(await page.title());
  const [dl] = await Promise.all([page.waitForEvent('download'), press(p, page.locator('#backup-md-btn'))]);
  seen.push(fs.readFileSync(await dl.path(), 'utf8'));
  const hits = seen.filter(t => t.includes('—'));
  eq(hits.map(t => t.slice(Math.max(0, t.indexOf('—') - 40), t.indexOf('—') + 20)), [], 'no em dashes');
});

/* ---- axe-core ---- */
const AXE_PATH = require.resolve('axe-core/axe.min.js');
const axeNotes = [];
async function axeCheck(page, p, label) {
  // Let the pop-in animation finish so colours are final.
  await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running'));
  if (!(await page.evaluate(() => !!window.axe))) await page.addScriptTag({path: AXE_PATH});
  const res = await page.evaluate(async () => (await axe.run(document, {resultTypes: ['violations']})).violations
    .map(v => ({id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 4).map(n => n.target.join(' '))})));
  const bad = res.filter(v => v.impact === 'serious' || v.impact === 'critical');
  res.filter(v => !bad.includes(v)).forEach(v => axeNotes.push(`[${p.name}] ${label}: ${v.impact} ${v.id} (${v.help}) at ${v.nodes.join(', ')}`));
  assert(!bad.length, `${label}: ` + bad.map(v => `${v.impact} ${v.id}: ${v.help} @ ${v.nodes.join(', ')}`).join(' | '));
}

test('axe: welcome, every control type, the dialog and the plan have no serious or critical issues', async (page, p) => {
  await axeCheck(page, p, 'welcome');
  await page.click('#start-btn');
  await page.fill('#f-idea', 'Lemonade stand');
  await axeCheck(page, p, 'step 1 (text field, idea buttons, select)');
  await next(page);
  await axeCheck(page, p, 'step 2 (choice buttons)');
  await next(page);
  await axeCheck(page, p, 'step 2 with error showing');
  await press(p, page.locator('.choice-card').first()); await next(page);
  await page.fill('#f-name', 'Sips'); await next(page);
  await press(p, page.locator('#unequal-chip'));
  await axeCheck(page, p, 'step 4 (founders, job chips, sliders)');
  await page.locator('.fname').nth(0).fill('Ava'); await press(p, page.locator('.founder-card').nth(0).locator('.chip').first());
  await page.locator('.fname').nth(1).fill('Ben'); await press(p, page.locator('.founder-card').nth(1).locator('.chip').first());
  await press(p, page.locator('#equal-chip'));
  await next(page);
  await press(p, page.locator('.suggest-tiles').nth(0).locator('.suggest-tile-add').first());
  await axeCheck(page, p, 'step 5 (suggestion tiles, picked chips)');
  await press(p, page.locator('.suggest-tiles').nth(1).locator('.suggest-tile-add').first());
  await next(page);
  await page.fill('#f-cost', '0.4'); await page.fill('#f-price', '1.5');
  await axeCheck(page, p, 'step 6 (money fields)');
  await next(page);
  await press(p, page.locator('#cost-tiles .suggest-tile-add').first());
  await axeCheck(page, p, 'step 7 (cost rows)');
  await freshStart(page);
  await completeWizard(page, p, {idea: 'Lemonade stand', kind: 'product', name: 'Sunny Sips'});
  await axeCheck(page, p, 'plan page');
  await openModal(page, p);
  await axeCheck(page, p, 'Start again dialog');
});

/* ================= ROUND 2, STAGE 2: V1 FEATURES ================= */

test('A: every idea tile x both kinds gives sensible words on pricing, startup, goals and the plan', async (page) => {
  const tiles = await page.evaluate(() => IDEA_TILE_EXAMPLES);
  eq(tiles.length, 12, '12 idea tiles');
  const problems = [];
  for (const tile of tiles) for (const kind of ['product', 'service']) {
    const r = await page.evaluate(([tile, kind, base]) => {
      const s = sanitizeState(base, []);
      s.ideaText = tile; s.businessKind = kind;
      s.audience = []; s.sellPlaces = []; s.marketingIdeas = []; s.startupCosts = [{label: 'Something', amount: '5'}]; s.risks = [{name: 'Rain', fix: 'Another day'}];
      state = s; refreshProfile();
      const out = {unit: profile.unit, generic: profile.id === 'generic', screens: {}, tiles: {}};
      out.onlineish = [...profile.placeSuggestions, ...profile.audienceSuggestions, ...profile.marketingSuggestions]
        .filter(t => /online|social media|website|instagram|tiktok|youtube/i.test(t));
      const grab = id => {
        goToStep(steps.findIndex(x => x.id === id));
        out.screens[id] = document.getElementById('step-container').innerText;
        out.tiles[id] = [...document.querySelectorAll('#step-container .suggest-tile input')].map(i => i.value);
        out.placeholders = (out.placeholders || []).concat([...document.querySelectorAll('#step-container input[placeholder]')].map(i => i.placeholder));
      };
      ['name', 'audience', 'pricing', 'startup', 'goals', 'marketing', 'risks'].forEach(grab);
      state.audience = ['Neighbours']; state.sellPlaces = ['Home']; state.marketingIdeas = ['Posters'];
      finished = true; showPlan();
      out.screens.plan = document.getElementById('plan-shell').innerText;
      out.md = buildPlanMarkdown();
      return out;
    }, [tile, kind, JSON.parse(goodBackup()).state]);
    const tag = `${tile}/${kind}`;
    if (r.generic) problems.push(`${tag}: fell through to the generic profile`);
    r.onlineish.forEach(t => problems.push(`${tag}: suggests "${t}"`));
    for (const where of ['audience', 'marketing']) r.tiles[where].filter(t => /online|social media|website|instagram|tiktok|youtube/i.test(t)).forEach(t => problems.push(`${tag} ${where} tile: "${t}"`));
    for (const [where, text] of Object.entries({...r.screens, md: r.md})) {
      if (/undefined|null|NaN|\[object/.test(text)) problems.push(`${tag} ${where}: undefined/null/NaN`);
      const dbl = text.match(/.{0,20}\S {2,}\S.{0,20}/);
      if (dbl) problems.push(`${tag} ${where}: double space "${dbl[0]}"`);
      if (kind === 'service' && /wholesale/i.test(text)) problems.push(`${tag} ${where}: "wholesale" on a service`);
      if (text.includes('—')) problems.push(`${tag} ${where}: em dash`);
    }
    for (const [where, vals] of Object.entries(r.tiles)) {
      if (['audience', 'startup', 'marketing', 'risks'].includes(where) && vals.length === 0) problems.push(`${tag} ${where}: no suggestion tiles`);
      if (vals.some(v => !v.trim())) problems.push(`${tag} ${where}: blank tile`);
    }
    if (r.placeholders.some(p => !p.trim() || /undefined/.test(p))) problems.push(`${tag}: bad placeholder`);
    if (!r.screens.pricing.includes(r.unit)) problems.push(`${tag}: pricing does not use "${r.unit}"`);
    if (!r.screens.plan.includes(r.unit)) problems.push(`${tag}: plan does not use "${r.unit}"`);
  }
  eq(problems, [], 'no wording problems');
});

test('A: profile table is data-driven and complete (both kinds, units, suggestions)', async (page) => {
  const r = await page.evaluate(() => {
    const issues = [];
    [...BUSINESS_PROFILES, GENERIC_PROFILE].forEach(p => ['product', 'service'].forEach(k => {
      const x = resolveProfile(p, k);
      if (!p[k] || !p[k].unit || !p[k].unitPlural) issues.push(`${p.id}.${k}: missing unit`);
      ['nameSuggestions', 'audienceSuggestions', 'placeSuggestions', 'marketingSuggestions', 'costSuggestions', 'riskSuggestions'].forEach(f => {
        if (!Array.isArray(x[f]) || x[f].length < 2) issues.push(`${p.id}.${k}.${f}: fewer than 2`);
      });
      if (x.kind !== k) issues.push(`${p.id}.${k}: kind not applied`);
    }));
    const ids = BUSINESS_PROFILES.map(p => p.id);
    const tileMatches = IDEA_TILE_EXAMPLES.map(t => matchBusinessProfile(t, null).id);
    return {issues, unique: new Set(ids).size === ids.length, tileMatches, dogProduct: matchBusinessProfile('Dog walking', 'product').unit, dogService: matchBusinessProfile('Dog walking', 'service').unit};
  });
  eq(r.issues, [], 'every profile complete');
  assert(r.unique, 'profile ids unique');
  eq(new Set(r.tileMatches).size, 12, 'each tile has its own profile');
  assert(!r.tileMatches.includes('generic'), 'no tile falls through');
  eq([r.dogService, r.dogProduct], ['walk', 'bag of dog treats'], 'explicit kind picks the right block');
});

test('A: explicit kind overrides the profile in the wizard (no "per walk (wholesale)" mixes)', async (page, p) => {
  await page.click('#start-btn');
  await page.fill('#f-idea', 'Dog walking'); await next(page);
  await press(p, page.locator('.choice-card', {hasText: 'I sell things'})); await next(page);
  await page.fill('#f-name', 'X'); await next(page);
  await page.locator('.fname').nth(0).fill('A'); await press(p, page.locator('.founder-card').nth(0).locator('.chip').first());
  await press(p, page.locator('.founder-card').nth(1).locator('.remove-founder')); await next(page);
  await press(p, page.locator('.suggest-tiles').nth(0).locator('.suggest-tile-add').first());
  await press(p, page.locator('.suggest-tiles').nth(1).locator('.suggest-tile-add').first());
  await next(page);
  const txt = await page.locator('.card').innerText();
  assert(txt.includes('What each bag of dog treats costs you to buy or make'), 'product wording for a normally-service idea');
  assert(!/per walk/.test(txt), 'no walk wording');
});

test('B: word of the step shows the right words, and every definition is short', async (page) => {
  const r = await page.evaluate(() => {
    const out = {long: Object.entries(WORDS).filter(([, w]) => w.text.split(/\s+/).length > 20).map(([k]) => k), steps: {}};
    ['product', 'service'].forEach(kind => {
      state = sanitizeState(JSON.parse(JSON.stringify(DEFAULT_STATE)), []); state.ideaText = 'Lemonade stand'; state.businessKind = kind; refreshProfile();
      steps.forEach((st, i) => {
        if (st.isWelcome || st.isFinish) return;
        goToStep(i);
        out.steps[`${kind}:${st.id}`] = [...document.querySelectorAll('.word-card dt')].map(d => d.textContent);
      });
    });
    return out;
  });
  eq(r.long, [], 'all definitions are 20 words or fewer');
  eq(r.steps['product:pricing'], ['Profit:', 'Profit margin:', 'Wholesale:'], 'product pricing words');
  eq(r.steps['service:pricing'], ['Profit:', 'Profit margin:'], 'no wholesale for a service');
  eq(r.steps['product:startup'], ['Startup costs:'], 'startup word');
  eq(r.steps['service:goals'], ['Break-even:'], 'break-even word');
  eq(r.steps['product:idea'], [], 'no card where there is no word');
});

test('B: nudge rules (unit tests, currency-agnostic)', async (page) => {
  const r = await page.evaluate(() => {
    const P = {kind: 'product', unitPlural: 'cups'}, S = {kind: 'service', unitPlural: 'walks'};
    const ids = (step, s, prof) => nudgesFor(step, Object.assign({unitCost: '', sellPrice: '', weeklySalesGoal: ''}, s), prof).map(n => n.id);
    return {
      limits: NUDGE_LIMITS,
      freeProduct: ids('pricing', {unitCost: '0', sellPrice: '2'}, P),
      freeProductEmpty: ids('pricing', {unitCost: '', sellPrice: '2'}, P),
      noPriceYet: ids('pricing', {unitCost: '0', sellPrice: ''}, P),
      freeService: ids('pricing', {unitCost: '', sellPrice: '4'}, S),
      normal: ids('pricing', {unitCost: '0.4', sellPrice: '1.5'}, P),
      margin89: ids('pricing', {unitCost: '11', sellPrice: '100'}, P),
      margin90: ids('pricing', {unitCost: '10', sellPrice: '100'}, P),
      marginSats: ids('pricing', {unitCost: '50', sellPrice: '1000'}, P),
      marginBtc: ids('pricing', {unitCost: '0.00000001', sellPrice: '0.0000002'}, S),
      loss: ids('pricing', {unitCost: '5', sellPrice: '4'}, P),
      goal50: ids('goals', {weeklySalesGoal: '50'}, P),
      goal51: ids('goals', {weeklySalesGoal: '51'}, S),
      goalText: nudgesFor('goals', {weeklySalesGoal: '200'}, S)[0].text,
      wrongStep: ids('goals', {unitCost: '0', sellPrice: '2'}, P),
    };
  });
  eq(r.limits, {highMarginPct: 90, bigWeeklyGoal: 50}, 'thresholds in one table');
  eq(r.freeProduct, ['free-product'], 'product cost 0');
  eq(r.freeProductEmpty, ['free-product'], 'blank cost counts as 0');
  eq(r.noPriceYet, [], 'quiet until a price is entered');
  eq(r.freeService, ['free-service'], 'service cost 0');
  eq(r.normal, [], 'normal prices: no nudge');
  eq(r.margin89, [], '89% margin: no nudge');
  eq(r.margin90, ['high-margin'], '90% margin: nudge');
  eq(r.marginSats, ['high-margin'], 'works in sats');
  eq(r.marginBtc, ['high-margin'], 'works in tiny BTC amounts');
  eq(r.loss, [], 'a loss is handled by the error, not a nudge');
  eq(r.goal50, [], '50 a week is fine');
  eq(r.goal51, ['big-goal'], 'over 50 a week nudges');
  assert(r.goalText.includes('do that many walks'), 'service wording in goal nudge');
  eq(r.wrongStep, [], 'rules only fire on their own step');
});

test('B: nudges are polite, dismissible, never block Next, and stay hidden once dismissed', async (page, p) => {
  await page.click('#start-btn');
  await page.fill('#f-idea', 'Lemonade stand'); await next(page);
  await press(p, page.locator('.choice-card').first()); await next(page);
  await page.fill('#f-name', 'X'); await next(page);
  await page.locator('.fname').nth(0).fill('A'); await press(p, page.locator('.founder-card').nth(0).locator('.chip').first());
  await press(p, page.locator('.founder-card').nth(1).locator('.remove-founder')); await next(page);
  await press(p, page.locator('.suggest-tiles').nth(0).locator('.suggest-tile-add').first());
  await press(p, page.locator('.suggest-tiles').nth(1).locator('.suggest-tile-add').first());
  await next(page);
  const box = page.locator('.nudges');
  eq(await box.getAttribute('role'), 'status', 'polite live region');
  eq(await page.locator('.nudge').count(), 0, 'nothing before typing');
  await page.fill('#f-cost', '0'); await page.fill('#f-price', '2');
  assert((await page.locator('.nudge').innerText()).includes('Think about it:'), 'shows "Think about it"');
  eq(await page.locator('.nudge').evaluate(e => e.closest('.error-msg') === null && !e.matches('[role=alert]')), true, 'not styled or announced as an error');
  await page.fill('#f-cost', '0.1');
  assert((await page.locator('.nudge').getAttribute('data-nudge')) === 'high-margin', 'swaps to the margin tip');
  await press(p, page.locator('.nudge-dismiss'));
  eq(await page.locator('.nudge').count(), 0, 'dismissed');
  await page.fill('#f-cost', '0.05');
  eq(await page.locator('.nudge').count(), 0, 'stays dismissed while typing');
  await next(page);
  eq(await kicker(page), 'Step 7 of 11', 'Next still works');
});

test('C: break-even arithmetic (unit tests, all currencies)', async (page) => {
  const r = await page.evaluate(() => ({
    gbp: breakEvenUnits(8.5, 1.1),
    exact: breakEvenUnits(10, 2.5),
    btc: breakEvenUnits(0.0001, 0.00002),
    btc2: breakEvenUnits(0.00010001, 0.00002),
    sats: breakEvenUnits(1000, 250),
    sats2: breakEvenUnits(1001, 250),
    jpy: breakEvenUnits(500, 120),
    tiny: breakEvenUnits(0.3, 0.1),
    zeroProfit: breakEvenUnits(10, 0),
    negProfit: breakEvenUnits(10, -1),
    noCosts: breakEvenUnits(0, 2),
    sentences: [
      breakEvenSentence(8, {kind: 'product', unit: 'cup', unitPlural: 'cups'}),
      breakEvenSentence(1, {kind: 'service', unit: 'walk', unitPlural: 'walks'}),
      breakEvenSentence(0, {kind: 'product', unit: 'cup', unitPlural: 'cups'}),
      breakEvenSentence(null, {kind: 'service', unit: 'walk', unitPlural: 'walks'}),
    ],
  }));
  eq([r.gbp, r.exact, r.btc, r.btc2, r.sats, r.sats2, r.jpy, r.tiny], [8, 4, 5, 6, 4, 5, 5, 3], 'rounds up, no float noise');
  eq([r.zeroProfit, r.negProfit, r.noCosts], [null, null, 0], 'zero/negative profit and no costs');
  eq(r.sentences, [
    'Sell 8 cups to pay back your startup costs.',
    'Do 1 walk to pay back your startup costs.',
    'You have no startup costs to pay back, so you make a profit from the start.',
    'Once each walk makes a profit, you can start paying back your startup costs.',
  ], 'wording by kind and count');
});

test('fix R6-1: "a" or "an" before a number follows how it is read aloud (percentages, counts, all 12 currencies)', async (page) => {
  // "an" for eight, eleven, eighteen, eighty-something and eight hundred at the
  // front of the number as read aloud; "a" for everything else.
  const AN = ['8', '11', '18', '80', '85', '89', '800', '8,000', '11,000', '18,000', '80,000', '800,000', '8,000,000', '8.5', '11.25'];
  const A = ['0', '1', '7', '9', '10', '12', '17', '19', '20', '75', '79', '90', '100', '110', '180', '1,100', '1,800', '100,000', '-80', '−8'];
  const cases = [];
  for (const n of AN) cases.push([n + '%', 'an'], [n, 'an']);
  for (const n of A) cases.push([n + '%', 'a'], [n, 'a']);
  // Money in every currency, exactly as the app shows it.
  const AN_MONEY = [8, 11, 18, 80, 85, 800, 8000, 11000, 18000];
  const amounts = await page.evaluate(vals => CURRENCIES.map(c => [c.code, vals.map(v => [v, formatMoney(v, c.code)])]),
    [...AN_MONEY, 75, 100, 110, 1100, 1800]);
  eq(amounts.length, 12, '12 currencies');
  for (const [code, list] of amounts) for (const [v, shown] of list) cases.push([shown, AN_MONEY.includes(v) ? 'an' : 'a', code]);
  const got = await page.evaluate(list => list.map(([t]) => aOrAn(t)), cases);
  const wrong = cases.filter((c, i) => got[i] !== c[1]).map(c => `${c[0]} (${c[2] || 'number'}): wanted "${c[1]}"`);
  eq(wrong, [], 'every article matches how the figure is read');
  // On the plan: margins of 80% (cost 0.40, price 2.00), 75% and 100%.
  for (const [cost, price, want] of [['0.40', '2.00', 'an 80% profit margin'], ['0.50', '2.00', 'a 75% profit margin'], ['0', '2.00', 'a 100% profit margin']]) {
    await loadPlanState(page, b => Object.assign(b.state, {unitCost: cost, sellPrice: price}));
    const txt = await page.locator('#plan-shell').innerText();
    assert(txt.includes(want), `plan says "${want}"`);
  }
});

test('C: break-even shows on the goals step and on the plan (weeks and units side by side)', async (page, p) => {
  await completeWizard(page, p, {idea: 'Lemonade stand', kind: 'product', name: 'Sunny Sips'});
  const txt = await planText(page);
  assert(txt.includes('Sell 8 cups to pay back your startup costs.'), 'sentence on plan');
  const cards = (await page.locator('.stat-card').allTextContents()).map(c => c.toLowerCase());
  const iw = cards.findIndex(c => c.includes('weeks to pay back')), iu = cards.findIndex(c => c.includes('cups to pay back'));
  assert(iw > -1 && iu === iw + 1, 'units card right next to weeks card');
  assert(cards[iu].includes('8'), 'units value');
  await page.click('#edit-plan-btn');
  for (let i = 0; i < 7; i++) await next(page);
  assert((await page.locator('#goal-strip').innerText()).includes('Sell 8 cups'), 'goals step shows it');
  await page.fill('#f-goal', '0');
  assert((await page.locator('#goal-strip').innerText()).includes('Sell 8 cups'), 'still shown with a zero goal');
  for (const [code, cost, price, total, want] of [['BTC', '0.00001', '0.00003', '0.0001', 'Sell 5 cups'], ['SATS', '100', '350', '1001', 'Sell 5 cups'], ['JPY', '20', '120', '500', 'Sell 5 cups']]) {
    await loadPlanState(page, b => Object.assign(b.state, {currency: code, unitCost: cost, sellPrice: price, startupCosts: [{label: 'Kit', amount: total}]}));
    assert((await planText(page)).includes(want + ' to pay back your startup costs.'), code);
  }
  await loadPlanState(page, b => Object.assign(b.state, {unitCost: '1', sellPrice: '1'}));
  assert((await planText(page)).includes('Once each cup makes a profit'), 'zero profit handled');
});

test('B/D: plan lists words learned and a kind grown-up check that prints', async (page) => {
  const check = async (mutate) => { await loadPlanState(page, mutate); return page.evaluate(() => ({
    words: [...document.querySelectorAll('.plan-words dt')].map(d => d.textContent),
    items: [...document.querySelectorAll('.check-list li')].map(li => li.textContent.trim()),
    sign: document.querySelector('.sign-lines') ? document.querySelector('.sign-lines').innerText : '',
    boxes: document.querySelectorAll('.check-list .tick-box').length,
  })); };
  const has = (items, s) => items.some(i => i.includes(s));
  let r = await check(b => Object.assign(b.state, {ideaText: 'Lemonade stand', businessKind: 'product', startupMoneySource: 'Parents lend it'}));
  eq(r.words, ['Profit', 'Profit margin', 'Wholesale', 'Startup costs', 'Break-even'], 'product words learned');
  assert(has(r.items, 'allergens'), 'food note for lemonade');
  assert(has(r.items, 'If we ever want to sell online, a grown-up will set it up and look after it for us.') && has(r.items, 'local rules') && has(r.items, 'We will sell face to face, with a grown-up nearby, and only in places a grown-up has said yes to.'), 'always-on notes');
  assert(has(r.items, 'paid back'), 'repayment line when parents lend it');
  assert(!has(r.items, 'Safety: a grown-up will always know'), 'no service note on a product');
  assert(/name/i.test(r.sign) && /Date/.test(r.sign), 'blank name and date lines');
  eq(r.boxes, r.items.length, 'a tick box per line');
  r = await check(b => Object.assign(b.state, {ideaText: 'Dog walking', businessKind: 'service'}));
  eq(r.words, ['Profit', 'Profit margin', 'Startup costs', 'Break-even'], 'service words learned (no wholesale)');
  assert(has(r.items, 'Safety: a grown-up will always know') && has(r.items, 'We will sell face to face, with a grown-up nearby'), 'service safety note');
  assert(has(r.items, 'Pets:'), 'pet note');
  assert(!has(r.items, 'allergens'), 'no food note');
  assert(has(r.items, 'where the starting money comes from'), 'plain money line');
  r = await check(b => Object.assign(b.state, {ideaText: 'Chocolate brownies and fudge', businessKind: 'product'}));
  assert(has(r.items, 'allergens'), 'food spotted by word for a generic idea');
  r = await check(b => Object.assign(b.state, {ideaText: 'Friendship bracelets', businessKind: 'product'}));
  assert(!has(r.items, 'allergens') && has(r.items, 'Small beads'), 'bracelets: beads note, no food');
  r = await check(b => Object.assign(b.state, {ideaText: 'Slime making', businessKind: 'product'}));
  assert(has(r.items, 'borax'), 'slime note');
  const printed = await page.evaluate(() => [...document.styleSheets].map(s => { try { return [...s.cssRules]; } catch (e) { return []; } })
    .some(rs => rs.some(r => r.media && r.media.mediaText === 'print' && /plan-section/.test(r.cssText))));
  assert(printed, 'plan sections keep together in print');
  const scary = (await planText(page)).match(/danger|die|kill|never ever|warning/i);
  eq(scary, null, 'kind wording, nothing scary');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => exportPlanMarkdown())]);
  const md = fs.readFileSync(await dl.path(), 'utf8');
  assert(md.includes('## Grown-up check') && md.includes('- [ ] ') && md.includes('## Words you learned') && md.includes('to pay back your startup costs'), '.md includes the new sections');
});

test('compat: a Round 1 backup (old job name, schemaVersion 1) still imports and shows the job', async (page) => {
  await importFile(page, writeTmp('round1.json', goodBackup(b => { b.state.founders[0].roles = ['Social media and posters', 'Counting the money']; })));
  await page.waitForSelector('#plan-view', {state: 'visible'});
  assert((await planText(page)).includes('Social media and posters'), 'old job kept on the plan');
  await page.click('#edit-plan-btn'); await next(page); await next(page); await next(page);
  const chip = page.locator('.founder-card').nth(0).locator('.chip', {hasText: 'Social media and posters'});
  eq(await chip.getAttribute('aria-pressed'), 'true', 'old job still shown and selected in the wizard');
});

/* ================= ROUND 3: PLAN PAGE FIXES ================= */

test('A: profit per unit is labelled "per <unit>" everywhere (both kinds, 1, 2 and 3 founders, and the .md)', async (page) => {
  const three = [{name: 'Ava', roles: ['Counting the money'], sharePct: 34}, {name: 'Ben', roles: ['Talking to customers'], sharePct: 33}, {name: 'Cal', roles: ['Coming up with new ideas'], sharePct: 33}];
  const cases = [
    ['Lemonade stand', 'product', 'cup', [{name: 'Ava', roles: ['Counting the money'], sharePct: 100}]],
    ['Lemonade stand', 'product', 'cup', [{name: 'Ava', roles: ['Counting the money'], sharePct: 73}, {name: 'Ben', roles: ['Talking to customers'], sharePct: 27}]],
    ['Dog walking', 'service', 'walk', [{name: 'Ava', roles: ['Counting the money'], sharePct: 100}]],
    ['Dog walking', 'service', 'walk', three],
    ['Something new', 'service', 'job', [{name: 'Ava', roles: ['Counting the money'], sharePct: 73}, {name: 'Ben', roles: ['Talking to customers'], sharePct: 27}]],
  ];
  for (const [idea, kind, unit, founders] of cases) {
    const tag = `${idea}/${kind}/${founders.length} founder(s)`;
    await loadPlanState(page, b => Object.assign(b.state, {ideaText: idea, businessKind: kind, founders, equalShares: false, currency: 'THB'}));
    const r = await page.evaluate(() => ({
      labels: [...document.querySelectorAll('#plan-shell .stat-card .label')].map(l => l.textContent.trim()),
      text: document.getElementById('plan-shell').innerText,
      caption: (document.querySelector('.founder-split caption') || {}).textContent,
      heads: [...document.querySelectorAll('.founder-split th')].map(t => t.textContent),
      md: buildPlanMarkdown(),
    }));
    assert(!r.labels.some(l => /profit each/i.test(l)), `${tag}: no "Profit each" label`);
    assert(r.labels.includes(`Profit per ${unit}`), `${tag}: "Profit per ${unit}" label (${r.labels.join(' | ')})`);
    assert(r.labels.includes('Total profit a week') && r.labels.includes('Total profit in 4 weeks'), `${tag}: totals say total`);
    assert(!/profit each|on each one/i.test(r.text), `${tag}: no ambiguous wording on the page`);
    assert(new RegExp(`profit per ${unit}, an? \\d+% profit margin`).test(r.text), `${tag}: sentence says per ${unit}`);
    assert(r.md.includes(`| Profit per ${unit} |`) && !/profit each|on each one/i.test(r.md), `${tag}: .md matches`);
    if (founders.length === 1) {
      // One founder: a single sentence replaces the share table (see fix R5-3).
      eq(r.caption, undefined, `${tag}: no share table for one founder`);
      assert(/keeps all of the profit: .+ a week and .+ in 4 weeks\./.test(r.text) && r.md.includes('keeps all of the profit:'), `${tag}: solo sentence on page and in .md`);
    } else {
      eq(r.caption, "Each founder's share of the total profit", `${tag}: table caption`);
      eq(r.heads, ['Founder', 'Share', 'Their share a week', 'Their share in 4 weeks'], `${tag}: table headings`);
      assert(r.md.includes("### Each founder's share of the total profit") && r.md.includes('| Founder | Share | Their share a week | Their share in 4 weeks |'), `${tag}: .md table`);
    }
  }
  // The live calculators say the same thing.
  const calc = await page.evaluate(() => {
    const out = {};
    for (const kind of ['product', 'service']) {
      state.businessKind = kind; state.ideaText = 'Dog walking'; refreshProfile();
      goToStep(steps.findIndex(x => x.id === 'pricing')); out[kind + ':pricing'] = [...document.querySelectorAll('#calc-strip .k')].map(k => k.textContent);
      goToStep(steps.findIndex(x => x.id === 'goals')); out[kind + ':goals'] = [...document.querySelectorAll('#goal-strip .k')].map(k => k.textContent);
    }
    return out;
  });
  eq(calc['service:pricing'], ['Profit per walk', 'Profit margin', 'Do 20 walks: total profit'], 'service pricing calculator');
  eq(calc['product:pricing'], ['Profit per bag of dog treats', 'Profit margin', 'Sell 20 bags of dog treats: total profit'], 'product pricing calculator');
  eq(calc['service:goals'].slice(0, 2), ['Total profit a week', 'Total profit in 4 weeks'], 'goals step');
});

/* ---- Part B: print and layout ---- */

// Biggest realistic numbers for each currency: [price, cost, startup], goal 100 a week.
const BIG = {
  GBP: ['250.55', '0.45', '9999.99'], USD: ['250.55', '0.45', '9999.99'], EUR: ['250.55', '0.45', '9999.99'],
  AUD: ['250.55', '0.45', '9999.99'], CAD: ['250.55', '0.45', '9999.99'], CHF: ['250.55', '0.45', '9999.99'],
  CNY: ['1999.95', '0.45', '99999.99'], JPY: ['25000', '500', '999999'], INR: ['20000.5', '0.5', '999999.99'],
  THB: ['9999.99', '0.99', '999999.99'], BTC: ['0.01234567', '0.00000001', '0.99999999'], SATS: ['99999', '1', '9999999'],
};
// The two review plans (also rendered to PDF for people to look at).
const PRINT_CASES = {
  treasure: b => Object.assign(b.state, {
    ideaText: 'Treasure hunts', businessKind: 'service', businessName: 'Treasure hunters innit', currency: 'THB',
    unitCost: '150', sellPrice: '1500', weeklySalesGoal: '10',
    startupCosts: [{label: 'Equipment', amount: '500'}, {label: 'Flyers', amount: '1000'}], startupMoneySource: 'Parents lend it',
    founders: [{name: 'Bob', roles: ['Doing the jobs really well', 'Talking to customers'], sharePct: 73}, {name: 'Alice', roles: ['Counting the money', 'Posters and flyers'], sharePct: 27}], equalShares: false,
    audience: ['Families with young kids', 'Birthday parties', 'Neighbours'],
    sellPlaces: ['Around our street', 'The local park', 'A school fair', 'A market stall', 'Online'],
    marketingIdeas: ['Flyers through letterboxes', 'Tell friends at school', 'A sign at the school fair'],
    risks: [{name: 'Rain on the day', fix: 'Have an indoor hunt ready'}, {name: 'Someone gets lost', fix: 'Stay in pairs with a grown-up nearby'}, {name: 'Clues get moved', fix: 'Check the route just before we start'}],
  }),
  lemonade: b => Object.assign(b.state, {
    ideaText: 'Lemonade stand', businessKind: 'product', businessName: 'Sunny Sips', currency: 'GBP',
    unitCost: '0.5', sellPrice: '2', weeklySalesGoal: '15', startupCosts: [{label: 'Lemons, sugar and cups', amount: '20'}], startupMoneySource: 'Savings',
    founders: [{name: 'Ava', roles: ['Talking to customers', 'Counting the money'], sharePct: 100}], equalShares: true,
  }),
};
const pdfPages = buf => (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
const pdfBox = buf => { const m = buf.toString('latin1').match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)/); return m ? [+m[1], +m[2]] : null; };

// Every number in a stat card: on one line, inside its card, not tiny; money cells in tables one line.
const chartsSettled = page => page.waitForFunction(() => [...document.querySelectorAll('#plan-shell canvas')]
  .every(c => c.getBoundingClientRect().right <= c.closest('.chart-wrap').getBoundingClientRect().right + 1));
const numberLayout = async page => { await chartsSettled(page); return page.evaluate(() => {
  const bad = [];
  const lines = el => { const r = document.createRange(); r.selectNodeContents(el); return new Set([...r.getClientRects()].map(x => Math.round(x.top))).size; };
  document.querySelectorAll('#plan-shell .num-value').forEach(v => {
    const fs = parseFloat(getComputedStyle(v).fontSize);
    if (lines(v) > 1) bad.push(`${v.textContent}: wraps onto ${lines(v)} lines`);
    if (v.scrollWidth > v.clientWidth + 1) bad.push(`${v.textContent}: wider than its card (${v.scrollWidth} > ${v.clientWidth})`);
    if (fs < 12) bad.push(`${v.textContent}: font ${fs}px`);
  });
  document.querySelectorAll('#plan-shell td.num').forEach(td => { if (lines(td) > 1) bad.push(`table cell ${td.textContent} wraps`); });
  document.querySelectorAll('#plan-shell .plan-section').forEach(s => { if (s.scrollWidth > s.clientWidth + 1) bad.push(`section "${s.querySelector('h2').textContent}" overflows sideways`); });
  if (document.documentElement.scrollWidth > window.innerWidth + 1) bad.push('the page scrolls sideways');
  return bad;
}); };

test('B1: stat numbers and money cells never break across lines, 360px to desktop and in print, all 12 currencies at their biggest', async (page, p) => {
  const problems = [];
  for (const [code, [price, cost, start]] of Object.entries(BIG)) {
    await loadPlanState(page, b => Object.assign(b.state, {currency: code, sellPrice: price, unitCost: cost, weeklySalesGoal: '100',
      startupCosts: [{label: 'Everything', amount: start}], founders: [{name: 'Ava', roles: ['Counting the money'], sharePct: 73}, {name: 'Ben', roles: ['Talking to customers'], sharePct: 27}], equalShares: false}));
    for (const w of [360, 390, 768, 1280]) {
      await page.setViewportSize({width: w, height: 900});
      (await numberLayout(page)).forEach(x => problems.push(`${code} @${w}px: ${x}`));
    }
    // Print: a portrait A4 page with 12 mm margins is about 703 CSS px wide.
    await page.setViewportSize({width: 703, height: 1000});
    await page.emulateMedia({media: 'print'});
    (await numberLayout(page)).forEach(x => problems.push(`${code} print: ${x}`));
    await page.emulateMedia({media: 'screen'});
  }
  eq(problems, [], 'no broken or overflowing numbers');
  // Everyday amounts (the manual-test plan) fit a phone with no sideways scrolling at all.
  await loadPlanState(page, PRINT_CASES.treasure);
  await page.setViewportSize({width: 360, height: 900});
  await chartsSettled(page);
  eq(await page.evaluate(() => [...document.querySelectorAll('.table-scroll')].filter(t => t.scrollWidth > t.clientWidth + 1).length), 0, 'manual-test tables need no scrolling at 360px');
});

test('B2: in print, headings, captions and chart titles keep with what follows; small blocks never split', async (page) => {
  await loadPlanState(page, PRINT_CASES.treasure);
  await page.emulateMedia({media: 'print'});
  const r = await page.evaluate(() => {
    const cs = sel => getComputedStyle(document.querySelector(sel));
    return {
      keepWithNext: ['#plan-shell h2', '#plan-shell .section-desc', '.chart-title', '.founder-split caption'].map(sel => [sel, cs(sel).breakAfter]),
      inside: ['.stat-grid', '.chart-wrap', '.founder-split', '.table-simple', '.risk-row', '.check-list', '.sign-lines', '.startup-steps li', '.job-grid'].map(sel => [sel, cs(sel).breakInside]),
      captionInTable: !!document.querySelector('.founder-split > caption'),
      chartTitleInWrap: [...document.querySelectorAll('.chart-title')].every(t => t.parentElement.classList.contains('chart-wrap')),
    };
  });
  eq(r.keepWithNext.filter(([, v]) => v !== 'avoid'), [], 'headings, captions and chart titles keep with next');
  eq(r.inside.filter(([, v]) => v !== 'avoid'), [], 'small blocks never split');
  assert(r.captionInTable, 'the founder table heading is its caption, so it always moves with the table');
  assert(r.chartTitleInWrap, 'each chart title sits inside its unsplittable chart box');
});

test('B3: the printed plan reads without background graphics (cover dark on white, chips and circles outlined)', async (page) => {
  await loadPlanState(page, PRINT_CASES.treasure);
  await page.emulateMedia({media: 'print'});
  const lum = c => { const v = c.match(/[\d.]+/g).slice(0, 3).map(x => x / 255).map(x => x <= .03928 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4); return .2126 * v[0] + .7152 * v[1] + .0722 * v[2]; };
  const r = await page.evaluate(() => {
    const cs = sel => getComputedStyle(document.querySelector(sel));
    const circle = getComputedStyle(document.querySelector('.startup-steps li'), '::before');
    return {coverBg: cs('.plan-cover').backgroundColor, coverBorder: cs('.plan-cover').borderTopWidth,
      text: ['.plan-cover h1', '.plan-cover .tagline', '.plan-cover-kicker', '.founder-chip'].map(sel => [sel, cs(sel).color]),
      chipBorder: cs('.founder-chip').borderTopWidth, circleBorder: circle.borderTopWidth, circleColor: circle.color,
      blobs: getComputedStyle(document.querySelector('.plan-cover'), '::before').display};
  });
  eq(r.coverBg, 'rgb(255, 255, 255)', 'cover prints on white, so it does not depend on backgrounds');
  eq(r.blobs, 'none', 'decorative circles hidden');
  assert(parseFloat(r.coverBorder) >= 2 && parseFloat(r.chipBorder) >= 1 && parseFloat(r.circleBorder) >= 1, 'outlines carry the shapes');
  for (const [sel, color] of [...r.text, ['step circle number', r.circleColor]]) {
    const ratio = 1.05 / (lum(color) + .05);
    assert(ratio >= 4.5, `${sel} is readable on white (${ratio.toFixed(2)}:1)`);
  }
});

test('B4: chart axis shows whole amounts without decimals, sats whole, BTC trimmed, at most 6 ticks', async (page, p) => {
  const unit = await page.evaluate(() => ({
    thb: [axisMoney(60000, 'THB'), axisMoney(2.5, 'THB'), axisMoney(0, 'THB')],
    gbp: [axisMoney(52, 'GBP'), axisMoney(0.5, 'GBP')],
    jpy: axisMoney(1200000, 'JPY'),
    sats: [axisMoney(400000, 'SATS'), axisMoney(2.5, 'SATS')],
    btc: [axisMoney(0.0005, 'BTC'), axisMoney(0.00012345, 'BTC')],
  }));
  eq(unit.thb, ['฿60,000', '฿2.50', '฿0'], 'THB');
  eq(unit.gbp, ['£52', '£0.50'], 'GBP');
  eq(unit.jpy, '¥1,200,000', 'JPY');
  eq(unit.sats, ['400,000 sats', '3 sats'], 'sats never have decimals');
  eq(unit.btc, ['₿0.0005', '₿0.00012345'], 'BTC keeps its precision, no trailing zeros');
  for (const w of [1280, 360]) {
    await page.setViewportSize({width: w, height: 900});
    for (const code of ['THB', 'SATS', 'BTC', 'GBP', 'JPY']) {
      await loadPlanState(page, b => Object.assign(b.state, {currency: code, sellPrice: BIG[code][0], unitCost: BIG[code][1], weeklySalesGoal: '30'}));
      const labels = await page.evaluate(() => Chart.getChart('profit-chart').scales.y.ticks.map(t => t.label));
      assert(labels.length >= 2 && labels.length <= 6, `${code} @${w}px: 2 to 6 ticks (${labels.length})`);
      if (code !== 'BTC') assert(!labels.some(l => /\.00\b/.test(l)), `${code} @${w}px: no ".00" on the axis (${labels.join(', ')})`);
      if (code === 'SATS') assert(labels.every(l => /^[\d,]+ sats$/.test(l)), `sats are whole (${labels.join(', ')})`);
      if (code === 'BTC') assert(labels.every(l => /^₿\d+\.(0|\d{0,7}[1-9])$/.test(l)), `BTC trimmed (${labels.join(', ')})`);
    }
  }
  await loadPlanState(page, PRINT_CASES.treasure);
  const manual = await page.evaluate(() => Chart.getChart('profit-chart').scales.y.ticks.map(t => t.label));
  assert(manual.length <= 6 && manual.every(l => /^฿[\d,]+$/.test(l)), `manual-test plan: whole baht ticks, no .00 (${manual.join(', ')})`);
});

test('B5: the grown-up check never contradicts the child (fair, market or a typed "Online")', async (page) => {
  for (const kind of ['product', 'service']) {
    await loadPlanState(page, b => Object.assign(b.state, {businessKind: kind, sellPlaces: ['Online', 'A school fair', 'A market stall'], audience: ['People at the market']}));
    const all = (await page.locator('.check-list li').allTextContents()).join(' ');
    assert(!/No selling online|people we know|strangers/i.test(all), `${kind}: nothing that contradicts a fair, a market or online`);
    assert(all.includes('We will sell face to face, with a grown-up nearby, and only in places a grown-up has said yes to.'), `${kind}: approved in-person line`);
    assert(all.includes('If we ever want to sell online, a grown-up will set it up and look after it for us.'), `${kind}: approved online line`);
    assert(!all.includes('—'), 'no em dashes');
    const md = await page.evaluate(() => buildPlanMarkdown());
    assert(md.includes('- [ ] If we ever want to sell online, a grown-up will set it up and look after it for us.'), `${kind}: .md matches`);
  }
});

test('B6: a one-line print tip sits by the Print button and does not print', async (page) => {
  await loadPlanState(page);
  const tip = page.locator('#print-tip');
  assert(await tip.isVisible(), 'tip visible');
  eq(await tip.textContent(), 'In the print window, turn off Headers and footers for a cleaner page.', 'tip text');
  eq(await page.evaluate(() => document.getElementById('print-tip').closest('.plan-toolbar') === document.getElementById('print-btn').closest('.plan-toolbar')), true, 'in the same toolbar as Print');
  eq(await page.locator('#print-btn').getAttribute('aria-describedby'), 'print-tip', 'screen readers hear it with the Print button');
  const lines = await tip.evaluate(el => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight || 18)));
  assert(lines <= 1 || (await page.viewportSize()).width < 500, 'one line on a desktop');
  await page.emulateMedia({media: 'print'});
  assert(await tip.isHidden(), 'not on the printed page');
});

test('B7: portrait @page, only the two long sections may split, and both review plans print on 6 pages or fewer', async (page, p) => {
  await loadPlanState(page, PRINT_CASES.treasure);
  await page.emulateMedia({media: 'print'});
  const r = await page.evaluate(() => ({
    pageRule: [...document.styleSheets].flatMap(s => { try { return [...s.cssRules]; } catch (e) { return []; } }).filter(x => x.type === CSSRule.PAGE_RULE).map(x => x.style.size),
    canSplit: [...document.querySelectorAll('#plan-shell .plan-section.can-split h2')].map(h => [...h.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()),
    others: [...document.querySelectorAll('#plan-shell .plan-section:not(.can-split)')].map(s => getComputedStyle(s).breakInside),
    splitInside: [...document.querySelectorAll('#plan-shell .plan-section.can-split')].map(s => getComputedStyle(s).breakInside),
  }));
  eq(r.pageRule, ['portrait'], 'one @page rule: portrait, any paper size');
  eq(r.canSplit, ['The money', 'Your step-by-step startup plan'], 'only the two long sections may split');
  assert(r.others.every(v => v === 'avoid') && r.splitInside.every(v => v === 'auto'), 'short sections stay whole');
  if (p.browser !== chromium) return; // page.pdf() only exists in Chromium
  // Print media stays on: page.pdf() after emulating 'screen' would lay the PDF out with the screen CSS.
  for (const [name, mutate] of Object.entries(PRINT_CASES)) {
    await loadPlanState(page, mutate);
    for (const format of ['A4', 'Letter']) for (const bg of [true, false]) {
      const tag = `${name}, ${format}, backgrounds ${bg ? 'on' : 'off'}`;
      const pdf = await page.pdf({format, preferCSSPageSize: true, printBackground: bg});
      const pages = pdfPages(pdf), [w, h] = pdfBox(pdf);
      assert(h > w, `${tag}: portrait (${w} x ${h})`);
      assert(Math.round(w) === (format === 'A4' ? 596 : 612), `${tag}: paper width ${w}`);
      assert(pages >= 2 && pages <= 6, `${tag}: ${pages} pages`);
    }
  }
});

test('fix R6-2: the signature labels sit fully inside the Grown-up check, on screen and in print on A4 and Letter', async (page) => {
  // A label nudged down with position:relative used to poke through the card's
  // bottom edge in print. Widths are the printable width of each paper at 12mm margins.
  const slime = b => Object.assign(b.state, {ideaText: 'Slime making', businessName: 'Slime Time', currency: 'SATS', unitCost: '100', sellPrice: '750'});
  const look = () => page.evaluate(() => {
    const card = document.querySelector('.grown-up-check'), cs = getComputedStyle(card);
    const box = card.getBoundingClientRect(), inner = box.bottom - parseFloat(cs.borderBottomWidth);
    const list = card.querySelector('.check-list').getBoundingClientRect();
    return [...card.querySelectorAll('.sign-line')].map(line => {
      const r = document.createRange(); r.selectNodeContents(line); const t = r.getBoundingClientRect(), l = line.getBoundingClientRect();
      return {label: line.textContent.trim(), clearance: inner - t.bottom, inside: t.left >= box.left && t.right <= box.right && t.top >= l.top,
        roomToSign: l.top - list.bottom, belowLine: t.top >= l.top + parseFloat(getComputedStyle(line).borderTopWidth)};
    });
  });
  for (const [name, mutate] of [['slime', slime], ['treasure', PRINT_CASES.treasure]]) {
    await loadPlanState(page, mutate);
    for (const [where, width, media] of [['screen', 1280, 'screen'], ['phone', 360, 'screen'], ['A4 print', 703, 'print'], ['Letter print', 726, 'print']]) {
      await page.setViewportSize({width, height: 900});
      await page.emulateMedia({media});
      const r = await look();
      eq(r.map(x => x.label), ["Grown-up's name and signature", 'Date'], `${name}, ${where}: both labels`);
      for (const x of r) {
        const tag = `${name}, ${where}, "${x.label}"`;
        assert(x.clearance >= 8, `${tag}: ${x.clearance.toFixed(1)}px clear of the card's bottom edge (needs 8)`);
        assert(x.inside && x.belowLine, `${tag}: inside the card, under its line`);
        assert(x.roomToSign >= 40, `${tag}: ${x.roomToSign.toFixed(0)}px above the line to sign in`);
      }
    }
  }
});

/* ================= ROUND 5: SMALL FIXES ================= */

test('fix R5-1: a run that selects no tests fails (mistyped --grep or --project)', async () => {
  const {spawnSync} = require('child_process');
  const run = args => spawnSync(process.execPath, [__filename, ...args], {encoding: 'utf8', env: process.env, timeout: 60000});
  const g = run(['--project=chromium-desktop', '--grep=zz-no-such-test-name']);
  eq(g.status, 1, 'mistyped --grep exits 1');
  assert(g.stdout.includes('No tests matched --grep=zz-no-such-test-name'), 'clear message for --grep: ' + g.stdout.trim());
  const p = run(['--project=chromium-dektop']);
  eq(p.status, 1, 'mistyped --project exits 1');
  assert(p.stdout.includes('No browser setup matched --project=chromium-dektop'), 'clear message for --project: ' + p.stdout.trim());
});

test('fix R5-2: the sideways table scroller is a named, focusable region only when it scrolls, and off in print', async (page) => {
  // The biggest sats amounts plus the longest possible one-word name (24
  // letters) are the one case that still makes the founder table scroll on a phone.
  await loadPlanState(page, b => Object.assign(b.state, {currency: 'SATS', sellPrice: '99999', unitCost: '1', weeklySalesGoal: '100', startupCosts: [{label: 'Everything', amount: '9999999'}],
    founders: [{name: 'Maximilianbartholomewxyz', roles: ['Counting the money'], sharePct: 73}, {name: 'Ben', roles: ['Talking to customers'], sharePct: 27}], equalShares: false}));
  await page.setViewportSize({width: 360, height: 900});
  await page.waitForFunction(() => [...document.querySelectorAll('.table-scroll')].some(t => t.getAttribute('tabindex') === '0'));
  const scrolling = await page.evaluate(() => [...document.querySelectorAll('.table-scroll')].filter(t => t.scrollWidth > t.clientWidth + 1)
    .map(t => ({role: t.getAttribute('role'), label: t.getAttribute('aria-label'), tab: t.getAttribute('tabindex')})));
  assert(scrolling.length >= 1, 'at least one table scrolls at 360px with huge numbers');
  scrolling.forEach(s => eq(s, {role: 'region', label: 'Money table, scrolls sideways', tab: '0'}, 'scrolling wrapper is a focusable, named region'));
  const t = page.locator('.table-scroll[tabindex="0"]').first();
  await t.focus();
  await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
  const ring = await t.evaluate(el => { const cs = getComputedStyle(el); return {style: cs.outlineStyle, width: parseFloat(cs.outlineWidth), focused: document.activeElement === el}; });
  assert(ring.focused && ring.style !== 'none' && ring.width >= 2, `visible focus outline (${JSON.stringify(ring)})`);
  await page.keyboard.press('ArrowRight');
  await t.evaluate(el => new Promise(r => { const start = Date.now(); (function check() { if (el.scrollLeft > 0 || Date.now() - start > 3000) r(); else requestAnimationFrame(check); })(); }));
  assert(await t.evaluate(el => el.scrollLeft > 0), 'arrow keys scroll it');
  // Wide screen: nothing overflows, so no needless tab stop and no region.
  await page.setViewportSize({width: 1280, height: 900});
  await page.waitForFunction(() => [...document.querySelectorAll('.table-scroll')].every(t => !t.hasAttribute('tabindex')));
  eq(await page.evaluate(() => [...document.querySelectorAll('.table-scroll')].filter(t => t.hasAttribute('tabindex') || t.hasAttribute('role')).length), 0, 'no tab stop when nothing overflows');
  await page.setViewportSize({width: 360, height: 900});
  await page.emulateMedia({media: 'print'});
  eq(await page.evaluate(() => [...document.querySelectorAll('.table-scroll')].map(t => getComputedStyle(t).overflowX)), ['visible', 'visible'], 'switched off in print');
  await page.emulateMedia({media: 'screen'});
  await axeCheck(page, {name: 'plan-scroller'}, 'plan page with a scrolling table');
});

const SOLO_BAD = /\bteam\b|founders\b|between them|everyone in|each founder|founder's share|young founders|their share/i;
test('fix R5-3: a solo plan reads as one person (product and service, page, .md and grown-up check)', async (page) => {
  for (const [idea, kind] of [['Lemonade stand', 'product'], ['Dog walking', 'service']]) {
    await loadPlanState(page, b => Object.assign(b.state, {ideaText: idea, businessKind: kind, tagline: '', founders: [{name: 'Ava', roles: ['Counting the money'], sharePct: 100}], equalShares: true}));
    const r = await page.evaluate(() => ({text: document.getElementById('plan-shell').innerText, md: buildPlanMarkdown(), table: !!document.querySelector('.founder-split'),
      solo: (document.querySelector('.solo-share') || {}).textContent || ''}));
    for (const [where, txt] of [['page', r.text], ['.md', r.md]]) {
      const hit = txt.match(new RegExp(`.{0,30}(${SOLO_BAD.source}).{0,30}`, 'i'));
      assert(!hit, `${idea}/${kind} ${where}: plural or team wording "${hit && hit[0]}"`);
    }
    assert(!r.table, `${idea}/${kind}: no founder-share table for one founder`);
    assert(/^Ava keeps all of the profit: .+ a week and .+ in 4 weeks\.$/.test(r.solo.trim()), `${idea}/${kind}: one clear sentence (${r.solo})`);
    assert(r.md.includes('Ava keeps all of the profit:'), `${idea}/${kind}: .md matches`);
    assert(r.text.includes('Run by a young founder who knows exactly what people want.'), `${idea}/${kind}: singular cover line`);
    assert(r.text.includes('Read the plan with a grown-up') && r.text.includes('Look back at your first week'), `${idea}/${kind}: solo startup steps`);
  }
});

test('fix R5-3: a two-founder plan still shows the table and the team wording', async (page) => {
  await loadPlanState(page, b => Object.assign(b.state, {tagline: '', founders: [{name: 'Bob', roles: ['Counting the money'], sharePct: 73}, {name: 'Alice', roles: ['Talking to customers'], sharePct: 27}], equalShares: false}));
  const r = await page.evaluate(() => ({text: document.getElementById('plan-shell').innerText, md: buildPlanMarkdown(),
    caption: (document.querySelector('.founder-split caption') || {}).textContent, solo: !!document.querySelector('.solo-share')}));
  eq(r.caption, "Each founder's share of the total profit", 'table caption');
  assert(!r.solo, 'no solo sentence');
  for (const s of ['Run by young founders who know exactly what people want.', 'The team', 'Agree the plan as a team', 'Check in as a team', 'who between them handle']) assert(r.text.includes(s), 'page has ' + s);
  assert(r.md.includes("### Each founder's share of the total profit") && r.md.includes('## The team'), '.md keeps the table and team heading');
});

test('fix R5-4: no stat card sits alone on a row (desktop, tablet and print)', async (page) => {
  const lonely = () => page.evaluate(() => [...document.querySelectorAll('#plan-shell .stat-grid')].flatMap(g => {
    const rows = {}; [...g.children].forEach(c => { const top = Math.round(c.getBoundingClientRect().top); (rows[top] = rows[top] || []).push(c); });
    const counts = Object.values(rows).map(r => r.length);
    return counts.length > 1 && counts.includes(1) ? [`${g.children.length} cards as ${counts.join('+')}`] : [];
  }));
  for (const [name, mutate] of Object.entries(PRINT_CASES)) {
    await loadPlanState(page, mutate);
    for (const w of [768, 1024, 1280]) { await page.setViewportSize({width: w, height: 900}); eq(await lonely(), [], `${name} @${w}px`); }
    await page.setViewportSize({width: 703, height: 1000}); await page.emulateMedia({media: 'print'});
    eq(await lonely(), [], `${name} in print`);
    await page.emulateMedia({media: 'screen'});
  }
});

/* ================= ROUND 2, STAGE 3: REPO READINESS ================= */

test('repo: no external requests from file:// (fonts and Chart.js are local and actually load)', async (page, p) => {
  await completeWizard(page, p, {idea: 'Lemonade stand', kind: 'product', name: 'Sunny Sips'});
  const r = await page.evaluate(async () => {
    await document.fonts.ready;
    return {fonts: [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family.replace(/"/g, '')),
      chart: typeof Chart === 'function' && Chart.version,
      remote: [...document.querySelectorAll('script[src], link[href]')].map(e => e.getAttribute('src') || e.getAttribute('href')).filter(u => /^(https?:)?\/\//.test(u))};
  });
  assert(r.fonts.includes('Baloo 2') && r.fonts.includes('Nunito'), 'both self-hosted fonts loaded: ' + r.fonts.join(', '));
  eq(r.chart, '4.5.1', 'vendored Chart.js 4.5.1 loaded');
  eq(r.remote, [], 'no remote script or stylesheet tags');
  // The runner also fails any test that makes a non-local request.
});

test('repo: bold text really renders bold in every engine (static font weights, not a variable font)', async (page) => {
  // Measures ink (share of dark pixels), not width: WebKit can lay out a
  // variable font at the right width but still paint every weight thin.
  await page.evaluate(async () => {
    await document.fonts.ready;
    for (const [fam, lo, hi] of [['Nunito', 400, 800], ['Baloo 2', 500, 800]]) for (const w of [lo, hi]) {
      await document.fonts.load(`${w} 40px "${fam}"`);
      const p = document.createElement('p');
      p.id = `ink-${fam.replace(' ', '')}-${w}`;
      p.style.cssText = `font:${w} 40px "${fam}"; color:#000; background:#fff; margin:0; padding:8px; white-space:nowrap; position:relative; z-index:99`;
      p.textContent = 'Squish HQ business plan';
      document.body.prepend(p);
    }
  });
  const ink = async id => {
    const buf = await page.locator('#' + id).screenshot();
    return page.evaluate(async b64 => {
      const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height).data; let dark = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 384) dark++;
      return dark / (c.width * c.height);
    }, buf.toString('base64'));
  };
  for (const [fam, lo, hi] of [['Nunito', 400, 800], ['Baloo2', 500, 800]]) {
    const a = await ink(`ink-${fam}-${lo}`), b = await ink(`ink-${fam}-${hi}`);
    assert(b > a * 1.25, `${fam}: ${hi} has clearly more ink than ${lo} (${a.toFixed(4)} vs ${b.toFixed(4)})`);
  }
});

test('repo: works from an http sub-path (like username.github.io/repo-name/) with no external or failed requests', async (page, p) => {
  const base = `${SERVER.url}/squish-hq/`;
  const failed = [];
  page.on('response', r => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
  await page.goto(base);
  await page.waitForFunction(() => window.Chart);
  await completeWizard(page, p, {idea: 'Dog walking', kind: 'service', name: 'Pawsome Walks'});
  const fonts = await page.evaluate(async () => { await document.fonts.ready; return [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family.replace(/"/g, '')); });
  assert(fonts.includes('Baloo 2') && fonts.includes('Nunito'), 'fonts load over http');
  await page.reload();
  await page.waitForFunction(() => window.Chart && Chart.getChart('profit-chart'));
  assert(await page.locator('#plan-view').isVisible(), 'saved plan survives reload over http');
  eq(failed, [], 'no 404s or failed files');
});

test('repo: with the vendored Chart.js file missing the plan still works', async (page, p) => {
  const dir = copyApp({omit: [path.join('vendor', 'chart.js-4.5.1', 'chart.umd.min.js')]});
  await page.goto(pathToFileURL(path.join(dir, 'index.html')).href);
  eq(await page.evaluate(() => typeof window.Chart), 'undefined', 'Chart.js really is missing');
  await loadPlanState(page);
  await page.reload();
  assert(await page.locator('#plan-view').isVisible(), 'plan shows');
  eq(await page.locator('.chart-fallback').count(), 2, 'friendly note in place of each chart');
  assert((await planText(page)).includes('Sell 6 cups to pay back your startup costs.'), 'numbers still there');
  await openModal(page, p);
  const [dl] = await Promise.all([page.waitForEvent('download'), press(p, page.locator('#backup-json-btn'))]);
  assert(dl.suggestedFilename().endsWith('.json'), 'backup still downloads');
  await press(p, page.locator('#reset-confirm-btn'));
  eq(await stored(page), null, 'Start again still works');
});

test('repo: head metadata, favicon, and no claude.ai leftovers', async (page) => {
  const html = fs.readFileSync(HTML, 'utf8');
  const r = await page.evaluate(() => {
    const m = n => (document.querySelector(`meta[name="${n}"], meta[property="${n}"]`) || {}).content;
    return {title: document.title, desc: m('description'), theme: m('theme-color'), viewport: m('viewport'),
      ogTitle: m('og:title'), ogDesc: m('og:description'), ogImage: m('og:image'), ogUrl: m('og:url'), icon: (document.querySelector('link[rel=icon]') || {}).href || ''};
  });
  eq(r.title, 'Squish HQ: build your business', 'title');
  assert(r.desc && r.desc.length > 40 && r.ogTitle && r.ogDesc, 'description and Open Graph text');
  assert(r.theme && r.viewport.includes('width=device-width'), 'theme-color and viewport');
  assert(r.icon.startsWith('data:image/svg+xml'), 'inline SVG favicon');
  // Open Graph addresses are absolute https links to the GitHub Pages site.
  const PAGES_HOST = 'bitcoin-lebowski.github.io';
  const ogUrl = new URL(r.ogUrl), ogImage = new URL(r.ogImage);
  assert(ogUrl.protocol === 'https:' && ogUrl.host === PAGES_HOST && ogUrl.pathname.endsWith('/'), `og:url is the https site address (${r.ogUrl})`);
  assert(ogImage.protocol === 'https:' && ogImage.host === PAGES_HOST, `og:image is https on the site host (${r.ogImage})`);
  assert(ogImage.pathname.startsWith(ogUrl.pathname) && ogImage.pathname.endsWith('/assets/og-image.png'), `og:image sits under og:url at assets/og-image.png (${r.ogImage})`);
  assert(!/REPLACE-WITH|PLACEHOLDER|USERNAME\.github|REPO-NAME/.test(html), 'no placeholders left in the page');
  assert(fs.existsSync(path.join(ROOT, 'assets', 'og-image.png')), 'og image exists');
  const png = fs.readFileSync(path.join(ROOT, 'assets', 'og-image.png'));
  eq([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, 630], 'og image is 1200x630');
  assert(!/window\.claude|claude\.ai|__CLAUDE|embedded-state/i.test(html), 'no claude.ai artifact remnants');
  assert(!/fonts\.googleapis|fonts\.gstatic|cdnjs|jsdelivr|unpkg/.test(html), 'no CDN or Google Fonts references');
  for (const f of ['README.md', 'LICENSE', '.gitignore', '.nojekyll', 'package.json', path.join('tests', 'README.md'), path.join('.github', 'workflows', 'test.yml'),
    path.join('vendor', 'chart.js-4.5.1', 'LICENSE.md'), path.join('vendor', 'fonts', 'Baloo2-OFL.txt'), path.join('vendor', 'fonts', 'Nunito-OFL.txt')]) {
    assert(fs.existsSync(path.join(ROOT, f)), 'has ' + f);
  }
});

/* ================= REVIEW WALKTHROUGHS (screenshots) ================= */

test('walkthrough: product, service and generic fallback plans all complete', async (page, p) => {
  for (const o of [
    {idea: 'Lemonade stand', kind: 'product', name: 'Sunny Sips', tag: 'product'},
    {idea: 'Dog walking', kind: 'service', name: 'Pawsome Walks', tag: 'service', cost: '0', price: '4'},
    {idea: 'Slime making', kind: 'product', name: 'Slime Time', tag: 'generic', solo: true},
  ]) {
    await freshStart(page);
    await completeWizard(page, p, o);
    if (SHOTS) await page.screenshot({path: path.join(SHOTS, `${p.name}-${o.tag}-plan.png`), fullPage: true});
    const txt = await page.locator('#plan-shell').innerText();
    assert(txt.includes(o.name), `${o.tag} plan rendered`);
  }
  if (SHOTS) {
    await openModal(page, p);
    await page.screenshot({path: path.join(SHOTS, `${p.name}-modal.png`)});
  }
});

/* ---------------- runner ---------------- */
async function fastAnimations(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Animation.enable');
  await cdp.send('Animation.setPlaybackRate', {playbackRate: 10});
}

// Runs one test in a fresh browser context (its own storage, downloads
// and pages), so tests never see each other's data even when they run
// side by side.
async function runOne(browser, proj, t) {
  const ctx = await browser.newContext({...proj.ctx, acceptDownloads: true});
  const errors = [], external = [];
  ctx.on('request', r => { if (!isLocal(r.url())) external.push(r.url()); });
  const started = Date.now();
  // Chromium only: play CSS animations 10x faster. Every step card pops in
  // for 0.38 s, and Playwright waits for it to stop moving before each
  // click, which was most of the suite's run time. The animations still
  // run (and the reduced-motion test still switches them off).
  const page = await ctx.newPage();
  if (proj.browser === chromium) {
    await fastAnimations(page);
    ctx.on('page', pg => fastAnimations(pg).catch(() => {})); // pages a test opens later
  }
  ctx.on('page', pg => pg.on('pageerror', e => errors.push(e.message)));
  page.on('pageerror', e => errors.push(e.message));
  let error = null;
  try {
    await page.goto(URL_);
    await page.waitForFunction(() => window.Chart);
    await t.fn(page, proj, ctx);
    if (errors.length) throw new Error('Page errors: ' + errors.join(' | '));
    if (external.length) throw new Error('Non-local requests: ' + [...new Set(external)].join(' | '));
  } catch (e) { error = e; }
  await ctx.close().catch(() => {});
  return {name: t.name, project: proj.name, ok: !error, ms: Date.now() - started, message: error ? error.message : ''};
}

(async () => {
  const arg = n => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').slice(n.length + 3);
  const GREP = arg('grep'), ONLY = arg('project'), SMOKE = process.argv.includes('--smoke');
  const WORKERS = Math.max(1, parseInt(arg('workers'), 10) || Math.min(4, os.cpus().length));
  const missing = [...SMOKE_TESTS].filter(n => !tests.some(t => t.name === n));
  if (missing.length) { console.log('Smoke list names tests that do not exist:\n  ' + missing.join('\n  ')); process.exitCode = 1; return; }
  const selected = tests.filter(t => (!GREP || t.name.includes(GREP)) && (!SMOKE || SMOKE_TESTS.has(t.name)));
  const projects = PROJECTS.filter(pr => !ONLY || pr.name === ONLY);
  // Running nothing is never a pass: a typo in --grep or --project would
  // otherwise report "0 passed" and exit 0, which CI reads as green.
  if (!selected.length || !projects.length) {
    const why = !projects.length
      ? `No browser setup matched --project=${ONLY}. Known setups: ${PROJECTS.map(pr => pr.name).join(', ')}${process.argv.includes('--webkit') ? '' : ' (add --webkit for webkit-iphone13)'}.`
      : `No tests matched${GREP ? ` --grep=${GREP}` : ''}${SMOKE ? ' in the smoke set' : ''}.`;
    console.log(why);
    process.exitCode = 1;
    return;
  }
  const server = await startServer();
  const runStart = Date.now();
  const all = [];
  for (const proj of projects) {
    const workers = Math.min(WORKERS, selected.length);
    console.log(`\n=== ${proj.name}: ${selected.length} tests, ${workers} worker${workers === 1 ? '' : 's'} ===`);
    const results = new Array(selected.length);
    let next = 0;
    // Each worker owns one browser and pulls the next test off a shared queue.
    const worker = async () => {
      const browser = await proj.browser.launch();
      try {
        for (let i = next++; i < selected.length; i = next++) {
          const r = results[i] = await runOne(browser, proj, selected[i]);
          console.log(r.ok ? `  ✓ ${r.name} (${r.ms} ms)` : `  ✗ ${r.name} (${r.ms} ms)\n    ${r.message.split('\n').join('\n    ')}`);
        }
      } finally { await browser.close(); }
    };
    await Promise.all(Array.from({length: workers}, worker));
    all.push(...results); // original order, whatever order they finished in
  }
  server.close();
  const pass = all.filter(r => r.ok).length, fail = all.length - pass;
  if (axeNotes.length) console.log('\naxe minor/moderate notes:\n  ' + [...new Set(axeNotes)].join('\n  '));
  const slow = [...all].sort((a, b) => b.ms - a.ms).slice(0, 10);
  console.log('\nSlowest tests:\n' + slow.map(t => `  ${(t.ms / 1000).toFixed(1).padStart(6)} s  [${t.project}] ${t.name}`).join('\n'));
  if (process.env.RESULTS) fs.writeFileSync(process.env.RESULTS, JSON.stringify(all.map(({message, ...r}) => r), null, 1));
  console.log(`\n${pass} passed, ${fail} failed in ${((Date.now() - runStart) / 1000).toFixed(1)} s`);
  if (fail) { console.log('\nFailures:\n' + all.filter(r => !r.ok).map(r => `[${r.project}] ${r.name}: ${r.message}`).join('\n')); process.exitCode = 1; }
})();
