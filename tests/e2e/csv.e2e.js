// CSV 集計ツールのデモ（site/demos/csv/）のブラウザのテスト。
//
// 使い方（リポジトリの一番上で）:
//   python3 -m http.server 8000 -d site &
//   node tests/e2e/csv.e2e.js
//
// BASE_URL で開く先を変えられる（既定 http://localhost:8000）。
// テスト用の CSV ファイルは CSV_E2E_DIR（無ければ OS の一時フォルダの中に作るフォルダ）に書き出す。
// SCREENSHOT_DIR を指定すると、375px / 1280px のライト・ダークのスクリーンショットをそこに保存する。
//
// 期待する集計の値は、ページと同じ site/demos/csv/csv-core.js を Node で動かして求め、画面の表と比べる。
'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Core = require('../../site/demos/csv/csv-core.js');

const BASE_URL = (process.env.BASE_URL || 'http://localhost:8000').replace(/\/+$/, '') + '/';
const PAGE_URL = BASE_URL + 'demos/csv/';
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || '';
const WORK_DIR = process.env.CSV_E2E_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'csv-e2e-'));
const SAMPLE_PATH = path.join(__dirname, '../../site/demos/csv/sample.csv');
const NOTICE = 'ファイルはこのブラウザの中だけで処理され、どこにも送信されません。';

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  OK ${name}`);
  } else {
    failed++;
    console.log(`  NG ${name}${detail !== undefined && detail !== '' ? ` … ${detail}` : ''}`);
  }
}

const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const nf = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 2 });
const fmt = (v) => (v === null || v === undefined ? '—' : nf.format(v));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const baseHost = new URL(BASE_URL).hostname;
function isLocal(url) {
  if (/^(data|blob|about):/.test(url)) return true;
  let u;
  try { u = new URL(url); } catch (e) { return false; }
  return ['localhost', '127.0.0.1', '[::1]', '::1', baseHost].includes(u.hostname);
}

async function openPage(browser, options) {
  const context = await browser.newContext(Object.assign({ locale: 'ja-JP', acceptDownloads: true }, options));
  const state = { external: [], consoleErrors: [], badResponses: [] };
  // 外へのリクエストは記録して止める（実際には通信しない）
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (isLocal(url)) return route.continue();
    state.external.push(url);
    return route.abort();
  });
  const page = await context.newPage();
  page.on('console', (msg) => { if (msg.type() === 'error') state.consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => state.consoleErrors.push(String(err)));
  page.on('response', (res) => { if (res.status() >= 400) state.badResponses.push(`${res.status()} ${res.url()}`); });
  return { context, page, state };
}

async function scrollInfo(page) {
  return page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
}

async function text(page, selector) {
  return squash(await page.locator(selector).first().textContent());
}

async function shot(page, name) {
  if (!SCREENSHOT_DIR) return;
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, name), fullPage: true });
}

// 結果の表を読む（見出し・本体・合計の行。数値の欄は data-value も）
async function readResult(page) {
  return page.evaluate(() => {
    const cellText = (c) => c.textContent.replace(/\s+/g, ' ').trim();
    const head = [...document.querySelectorAll('#result-head th')].map((th) => th.querySelector('.sort-label').textContent);
    const rows = [...document.querySelectorAll('#result-body tr')].map((tr) => [...tr.children].map(cellText));
    const values = [...document.querySelectorAll('#result-body tr')].map((tr) => [...tr.children].slice(1).map((c) => (c.dataset.value === undefined ? null : c.dataset.value)));
    const foot = [...document.querySelectorAll('#result-foot td, #result-foot th')].map(cellText);
    const footValues = [...document.querySelectorAll('#result-foot td')].map((c) => (c.dataset.value === undefined ? null : c.dataset.value));
    const sort = [...document.querySelectorAll('#result-head th')].map((th) => th.getAttribute('aria-sort'));
    return { head, rows, values, foot, footValues, sort };
  });
}

async function waitStatus(page, pattern, timeout = 10000) {
  await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('load-status').textContent), pattern.source, { timeout });
}

async function chooseFile(page, filePath) {
  await page.evaluate(() => { document.getElementById('load-status').textContent = ''; });
  await page.setInputFiles('#file-input', filePath);
  const name = path.basename(filePath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await page.waitForFunction((n) => {
    const s = document.getElementById('load-status').textContent;
    const e = document.getElementById('load-error').textContent;
    return new RegExp('「' + n + '」を読み込みました').test(s) || e.length > 0;
  }, name, { timeout: 15000 });
}

async function download(page) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#save-csv')]);
  const file = await dl.path();
  return { name: dl.suggestedFilename(), buf: fs.readFileSync(file) };
}

function coreTable(filePath) {
  const d = Core.decode(fs.readFileSync(filePath));
  return { decoded: d, table: Core.parseCSV(d.text) };
}

// ====================================================================== テスト用のファイル
function writeFixtures() {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const f = {};
  // 値にカンマ・引用符を含む店舗名、いろいろな金額、読めない値
  const utf8Text = [
    '店舗,区分,金額',
    '"東館, ""新""",A,"1,000"',
    '西館,B,"¥2,500"',
    '"東館, ""新""",B,500円',
    '西館,A,▲300',
    '南館,A,abc',
    '=SUM(1),B,10'
  ].join('\r\n') + '\r\n';
  f.utf8 = path.join(WORK_DIR, 'utf8-nobom.csv');
  fs.writeFileSync(f.utf8, utf8Text, 'utf8');
  f.bom = path.join(WORK_DIR, 'utf8-bom.csv');
  fs.writeFileSync(f.bom, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(utf8Text, 'utf8')]));
  // Shift_JIS（手で用意したバイト列）:
  // '店舗,商品,金額\r\n東店,ソフトクリーム,"\1,200"\r\n西店,表示用の見本,800\r\n'
  f.sjis = path.join(WORK_DIR, 'shift-jis.csv');
  fs.writeFileSync(f.sjis, Buffer.from('935895dc2c8fa495692c8be08a7a0d0a938c93582c835c83748367834e838a815b83802c225c312c323030220d0a' +
    '90bc93582c955c8ea6977082cc8ca9967b2c3830300d0a', 'hex'));
  // 列の数が合わない行と空行
  f.mismatch = path.join(WORK_DIR, 'mismatch.csv');
  fs.writeFileSync(f.mismatch, 'a,b,c\n1,2,3\n4,5\n\n6,7,8,9\n10\n,,\n11,12,13\n', 'utf8');
  // CSV ではないファイル（ZIP の先頭バイト）
  f.zip = path.join(WORK_DIR, 'book.xlsx');
  fs.writeFileSync(f.zip, Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]));
  // 数値の列だが、読めない値が2割5分ある（「数値の列」とは判定されないが、集計はできるべき）
  f.partial = path.join(WORK_DIR, 'partial-numbers.csv');
  fs.writeFileSync(f.partial, ['店舗,金額'].concat(Array.from({ length: 40 }, (_, i) =>
    `${i % 2 ? '東店' : '西店'},${i % 4 === 0 ? '未集計' : '100'}`)).join('\n') + '\n', 'utf8');
  // Excel の「Unicode テキスト」（UTF-16LE、BOM つき、タブ区切り）
  f.utf16tab = path.join(WORK_DIR, 'unicode-text.txt.csv');
  fs.writeFileSync(f.utf16tab, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('店舗\t金額\r\n東店\t100\r\n', 'utf16le')]));
  // 大きなファイル
  const big = (n) => {
    const stores = ['駅前店', '中央通り店', '丘の上店', '川沿い店', '公園前店'];
    const lines = ['日付,店舗,商品,数量,売上金額'];
    for (let i = 0; i < n; i++) {
      const amount = (i * 37) % 5000 + 100;
      lines.push(`2026/${1 + (i % 12)}/${1 + (i % 28)},${stores[i % 5]},商品${i % 7},${1 + (i % 9)},${i % 2 ? `"${amount.toLocaleString('en-US')}"` : amount}`);
    }
    return lines.join('\r\n') + '\r\n';
  };
  f.big10k = path.join(WORK_DIR, 'big-10000.csv');
  fs.writeFileSync(f.big10k, big(10000), 'utf8');
  f.big30k = path.join(WORK_DIR, 'big-30000.csv');
  fs.writeFileSync(f.big30k, big(30000), 'utf8');
  return f;
}

// ====================================================================== 1280px（PC）
async function desktopFlow(browser, files) {
  console.log(`開く: ${PAGE_URL}（幅 1280px）`);
  const { context, page, state } = await openPage(browser, { viewport: { width: 1280, height: 900 } });
  const res = await page.goto(PAGE_URL, { waitUntil: 'load' });
  check('ページが開ける（HTTP 200）', res && res.status() === 200, res ? `HTTP ${res.status()}` : '応答なし');

  // ---- 文書の基本
  const head = await page.evaluate(() => ({
    lang: document.documentElement.lang,
    charset: document.characterSet,
    viewport: document.querySelector('meta[name="viewport"]')?.content,
    title: document.title,
    description: document.querySelector('meta[name="description"]')?.content || '',
    brand: document.querySelector('.site-header .brand')?.getAttribute('href'),
    brandText: document.querySelector('.site-header .brand')?.textContent.trim(),
    nav: [...document.querySelectorAll('.site-header nav a')].map((a) => [a.getAttribute('href'), a.textContent.trim()]),
    navLabel: document.querySelector('.site-header nav')?.getAttribute('aria-label'),
    footer: document.querySelector('.site-footer')?.textContent.replace(/\s+/g, ' ').trim(),
    footerLink: document.querySelector('.site-footer a')?.getAttribute('href'),
    resources: [...document.querySelectorAll('script[src], link[href], img[src], iframe[src]')].map((e) => e.getAttribute('src') || e.getAttribute('href')),
    notice: document.getElementById('privacy-notice')?.textContent.trim()
  }));
  check('lang="ja"・UTF-8・viewport', head.lang === 'ja' && head.charset === 'UTF-8' && head.viewport === 'width=device-width, initial-scale=1');
  check('短い title と description がある', head.title.length > 0 && head.title.length <= 40 && head.description.length > 20, head.title);
  check('共通のヘッダー（ロゴは ../../、ナビは 3 つ）', head.brand === '../../' && head.brandText === 'Kota0004' && head.navLabel === 'サイト内' &&
    same(head.nav, [['../../#works', '制作実績'], ['../../#demos', 'デモ'], ['../../#services', 'できること']]), JSON.stringify(head.nav));
  check('共通のフッター', head.footer === '© 2026 Kota0004 ・ GitHub' && head.footerLink === 'https://github.com/Kota0004', head.footer);
  check('外部のファイルを読み込んでいない（script・link・img がすべて自前）',
    head.resources.every((u) => /^data:/.test(u) || !/^(https?:)?\/\//.test(u)), head.resources.join(' '));
  check('冒頭のお知らせ: ' + NOTICE, head.notice === NOTICE, head.notice);
  const noticeLive = await page.locator('#load-status').getAttribute('aria-live');
  check('読み込みの知らせは aria-live で読み上げられる', noticeLive === 'polite');

  // ---- サンプルを読み込む
  await page.click('#load-sample');
  await waitStatus(page, /sample\.csv」を読み込みました/);
  const status = await text(page, '#load-status');
  check('サンプル: 文字コード（UTF-8）と行数・列数を表示', /文字コード: UTF-8 ／ 100 行 × 6 列/.test(status), status);
  const preview = await page.evaluate(() => ({
    rows: document.querySelectorAll('#preview-body tr').length,
    types: [...document.querySelectorAll('#preview-head th')].map((th) => [th.querySelector('.col-name').textContent, th.querySelector('.type-badge').textContent])
  }));
  check('サンプル: 先頭 5 行を表示', preview.rows === 5, String(preview.rows));
  check('サンプル: 列の種類の推定（日付・文字・文字・数値・数値・文字）',
    same(preview.types, [['日付', '日付'], ['店舗', '文字'], ['商品', '文字'], ['数量', '数値'], ['売上金額', '数値'], ['備考', '文字']]), JSON.stringify(preview.types));

  // 期待する値（csv-core を Node で動かす）
  const sample = coreTable(SAMPLE_PATH);
  const T = sample.table;
  const col = (name) => T.headers.indexOf(name);

  const form = await page.evaluate(() => ({
    group: document.querySelector('#group-col option:checked').textContent,
    value: document.querySelector('#value-col option:checked').textContent,
    method: document.getElementById('method').value
  }));
  check('最初の設定: 店舗ごとの売上金額の合計', form.group === '店舗' && form.value === '売上金額' && form.method === 'sum', JSON.stringify(form));

  // ---- 合計（店舗ごと）
  const sumAgg = Core.aggregate(T, { groupBy: col('店舗'), valueCol: col('売上金額'), method: 'sum' });
  const expectedSum = sumAgg.groups.slice().sort((a, b) => b.value - a.value);
  let r = await readResult(page);
  check('合計: 表の見出し', same(r.head, ['店舗', '売上金額の合計', '使った値の数', '割合']), JSON.stringify(r.head));
  check('合計: 各店舗の値が csv-core と一致（大きい順）',
    same(r.rows.map((x) => [x[0], x[1]]), expectedSum.map((g) => [g.label, fmt(g.value)])), JSON.stringify(r.rows));
  check('合計: 合計の行が csv-core と一致', r.foot[0] === '合計' && r.foot[1] === fmt(sumAgg.total.value) && r.footValues[0] === String(sumAgg.total.value),
    `${r.foot.join(' | ')} / 期待 ${fmt(sumAgg.total.value)}`);
  check('合計: 合計の行の値 = 各行の値の和', r.values.reduce((s, v) => s + Number(v[0]), 0) === Number(r.footValues[0]));
  const notes = await text(page, '#result-notes');
  check('読めない値の件数と例を表示（0 にしない）',
    notes.includes(`数値として読めない値が ${sumAgg.skipped.invalidValues} 件`) && notes.includes('「未集計」') && notes.includes('0 とはみなさず'), notes);
  check('空欄の件数を表示', notes.includes(`空欄の行が ${sumAgg.skipped.blankValues} 件`), notes);
  check('並べ替えの状態（値の列が降順）', r.sort[1] === 'descending' && r.sort[0] === null, JSON.stringify(r.sort));
  check('表が枠に収まるときは横スクロールの案内を出さない', await page.locator('#table-scroll-hint').isHidden());

  // ---- グラフ
  const chart = await page.evaluate(() => {
    const svg = document.querySelector('#chart-plot svg');
    return {
      visible: !!svg && !document.getElementById('chart').hidden,
      bars: [...document.querySelectorAll('#chart-plot .bar')].map((b) => b.getBBox().width),
      cats: [...document.querySelectorAll('#chart-plot .cat')].map((t) => t.textContent),
      vals: [...document.querySelectorAll('#chart-plot .val')].map((t) => t.textContent),
      fill: getComputedStyle(document.querySelector('#chart-plot .bar')).fill,
      maxBar: Math.max(...[...document.querySelectorAll('#chart-plot .bar')].map((b) => b.getBBox().height))
    };
  });
  check('グラフ: 横棒が店舗の数だけある', chart.visible && chart.bars.length === expectedSum.length, String(chart.bars.length));
  check('グラフ: 表と同じ順に項目名と値が並ぶ', same(chart.cats, expectedSum.map((g) => g.label)) && same(chart.vals, expectedSum.map((g) => fmt(g.value))), chart.cats.join(','));
  check('グラフ: 棒の長さが値の大きさの順', chart.bars.every((w, i) => i === 0 || w <= chart.bars[i - 1]) && chart.bars[chart.bars.length - 1] > 0, chart.bars.join(','));
  check('グラフ: 棒の太さは 24px 以下', chart.maxBar <= 24, String(chart.maxBar));
  check('グラフ: 棒に色がついている', chart.fill && chart.fill !== 'none' && !/rgba\(0, 0, 0, 0\)/.test(chart.fill), chart.fill);
  await page.hover('#chart-plot .bar-row[data-index="1"] .hit');
  const tip = await page.evaluate(() => ({ hidden: document.getElementById('chart-tooltip').hidden, text: document.getElementById('chart-tooltip').textContent }));
  check('グラフ: 棒にマウスを乗せると値が出る', !tip.hidden && tip.text.includes(expectedSum[1].label) && tip.text.includes(fmt(expectedSum[1].value)), tip.text);
  await page.mouse.move(5, 5);

  // ---- 並べ替え
  await page.click('#result-head button[data-col="1"]');
  r = await readResult(page);
  const asc = expectedSum.slice().reverse();
  check('並べ替え: 値の見出しを押すと小さい順（aria-sort=ascending）',
    r.sort[1] === 'ascending' && same(r.rows.map((x) => x[0]), asc.map((g) => g.label)), JSON.stringify(r.rows.map((x) => x[0])));
  const catsAfter = await page.evaluate(() => [...document.querySelectorAll('#chart-plot .cat')].map((t) => t.textContent));
  check('並べ替え: グラフも同じ順に並び替わる', same(catsAfter, asc.map((g) => g.label)), catsAfter.join(','));
  check('並べ替え: 合計の行は動かない', r.foot[1] === fmt(sumAgg.total.value));
  await page.click('#result-head button[data-col="0"]');
  r = await readResult(page);
  const byName = expectedSum.map((g) => g.label).sort(new Intl.Collator('ja', { numeric: true }).compare);
  check('並べ替え: 店舗の見出しを押すと名前の順', r.sort[0] === 'ascending' && same(r.rows.map((x) => x[0]), byName), JSON.stringify(r.rows.map((x) => x[0])));

  // ---- 平均
  await page.selectOption('#method', 'avg');
  const avgAgg = Core.aggregate(T, { groupBy: col('店舗'), valueCol: col('売上金額'), method: 'avg' });
  r = await readResult(page);
  const avgMap = Object.fromEntries(avgAgg.groups.map((g) => [g.label, g]));
  check('平均: 各店舗の値が csv-core と一致', r.rows.length === avgAgg.groups.length &&
    r.rows.every((x, i) => avgMap[x[0]] && x[1] === fmt(avgMap[x[0]].value) && r.values[i][0] === String(avgMap[x[0]].value)), JSON.stringify(r.rows));
  check('平均: 全体の平均（読めた値の合計 ÷ 個数）が一致', r.foot[0] === '全体の平均' && r.footValues[0] === String(avgAgg.total.value) &&
    Math.abs(avgAgg.total.value - sumAgg.total.value / sumAgg.total.n) < 1e-9, r.foot.join(' | '));
  check('平均: 割合の列は出さない', !r.head.includes('割合'));

  // ---- 最大・最小・件数
  await page.selectOption('#method', 'max');
  const maxAgg = Core.aggregate(T, { groupBy: col('店舗'), valueCol: col('売上金額'), method: 'max' });
  r = await readResult(page);
  check('最大: 全体の最大が一致', r.foot[1] === fmt(maxAgg.total.value), r.foot.join(' | '));
  await page.selectOption('#method', 'min');
  const minAgg = Core.aggregate(T, { groupBy: col('店舗'), valueCol: col('売上金額'), method: 'min' });
  r = await readResult(page);
  check('最小: 全体の最小が一致（▲760 → -760）', r.foot[1] === fmt(minAgg.total.value) && minAgg.total.value === -760, r.foot.join(' | '));
  await page.selectOption('#method', 'count');
  r = await readResult(page);
  check('件数: 集計する列は使わない（選べなくなる）', await page.isDisabled('#value-col'));
  check('件数: 合計は全行数（100）', r.foot[1] === '100' && same(r.head, ['店舗', '件数', '割合']), r.foot.join(' | '));
  await page.selectOption('#method', 'sum');

  // ---- 日付でまとめる（月ごと・日ごと）
  await page.selectOption('#group-col', String(col('日付')));
  check('日付の列を選ぶと「日付のまとめ方」が出る', await page.isVisible('#date-unit'));
  const monthAgg = Core.aggregate(T, { groupBy: col('日付'), valueCol: col('売上金額'), method: 'sum', dateUnit: 'month' });
  r = await readResult(page);
  check('月ごと: 3 か月が古い順に並び、値が csv-core と一致',
    same(r.rows.map((x) => [x[0], x[1]]), monthAgg.groups.map((g) => [g.label, fmt(g.value)])) && same(r.rows.map((x) => x[0]), ['2026年7月', '2026年8月', '2026年9月']),
    JSON.stringify(r.rows));
  check('月ごと: 合計の行が一致', r.foot[1] === fmt(monthAgg.total.value));
  await page.check('input[name="date-unit"][value="day"]');
  const dayAgg = Core.aggregate(T, { groupBy: col('日付'), valueCol: col('売上金額'), method: 'sum', dateUnit: 'day' });
  r = await readResult(page);
  check('日ごと: 日の数と最初の日が csv-core と一致（書き方の違う同じ日はまとまる）',
    r.rows.length === dayAgg.groups.length && r.rows[0][0] === dayAgg.groups[0].label && r.rows[0][1] === fmt(dayAgg.groups[0].value), `${r.rows.length} 行 / 期待 ${dayAgg.groups.length}`);
  await page.check('input[name="date-unit"][value="month"]');

  // ---- 必須の項目
  await page.selectOption('#group-col', '');
  const err = await page.evaluate(() => ({
    text: document.getElementById('err-group').textContent,
    live: document.getElementById('err-group').getAttribute('aria-live'),
    invalid: document.getElementById('group-col').getAttribute('aria-invalid'),
    resultHidden: document.getElementById('result-card').hidden
  }));
  check('グループにする列を選ばないとエラー（aria-live で読み上げ、aria-invalid）',
    err.text === 'グループにする列を選んでください。' && err.live === 'polite' && err.invalid === 'true' && err.resultHidden, JSON.stringify(err));

  // ---- ピボット表（店舗 × 商品）
  await page.selectOption('#group-col', String(col('店舗')));
  await page.selectOption('#column-col', String(col('商品')));
  const pv = Core.pivot(T, { rowBy: col('店舗'), colBy: col('商品'), valueCol: col('売上金額'), method: 'sum' });
  r = await readResult(page);
  check('ピボット: 見出しに商品が並び、最後に合計の列', same(r.head.slice(1), pv.colGroups.map((g) => g.label).concat(['合計'])), JSON.stringify(r.head));
  check('ピボット: 各セルが csv-core と一致',
    same(r.rows, pv.rowGroups.map((g, i) => [g.label].concat(pv.cells[i].map((c) => fmt(c && c.value)), [fmt(pv.rowTotals[i].value)]))), JSON.stringify(r.rows));
  check('ピボット: 合計の行（列ごとの合計と全体の合計）が一致',
    same(r.foot, ['合計'].concat(pv.colTotals.map((t) => fmt(t.value)), [fmt(pv.total.value)])), r.foot.join(' | '));
  check('ピボット: グラフは出さない', await page.locator('#chart').isHidden());
  await shot(page, 'csv-1280-light-pivot.png');

  // ---- CSV の保存（ピボット）
  let dl = await download(page);
  let dlText = dl.buf.toString('utf8');
  check('保存: ファイル名に集計の内容が入り、拡張子は .csv', dl.name === 'ピボット_店舗×商品_売上金額_合計.csv', dl.name);
  check('保存: 先頭に BOM（EF BB BF）', dl.buf[0] === 0xEF && dl.buf[1] === 0xBB && dl.buf[2] === 0xBF);
  let back = Core.parseCSV(dlText.replace(/^\uFEFF/, ''), { header: false }).records;
  check('保存: ピボットの中身が表と同じ（見出し・各行・合計の行）',
    same(back[0].slice(1), pv.colGroups.map((g) => g.label).concat(['合計'])) &&
    same(back.slice(1, -1).map((x) => x[0]), pv.rowGroups.map((g) => g.label)) &&
    same(back[1].slice(1).map(Number), pv.cells[0].map((c) => (c ? c.value : NaN)).concat([pv.rowTotals[0].value]).map((v) => (Number.isNaN(v) ? 0 : v))) &&
    same(back[back.length - 1], ['合計'].concat(pv.colTotals.map((t) => String(t.value)), [String(pv.total.value)])),
    JSON.stringify(back.slice(0, 2)));
  check('保存: 行の区切りは CRLF', /\r\n/.test(dlText) && !/[^\r]\n/.test(dlText));

  // ---- CSV の保存（グループの集計）
  await page.selectOption('#column-col', '');
  dl = await download(page);
  dlText = dl.buf.toString('utf8');
  back = Core.parseCSV(dlText.replace(/^\uFEFF/, ''), { header: false }).records;
  r = await readResult(page);
  check('保存: 集計のときのファイル名', dl.name === '集計_店舗_売上金額_合計.csv', dl.name);
  check('保存: 集計の中身が表と同じ（表に出ている順）',
    same(back[0], ['店舗', '売上金額の合計', '使った値の数', '割合（%）']) &&
    same(back.slice(1, -1).map((x) => [x[0], x[1]]), r.rows.map((x, i) => [x[0], r.values[i][0]])) &&
    same(back[back.length - 1].slice(0, 2), ['合計', String(sumAgg.total.value)]), JSON.stringify(back));
  check('保存した知らせが aria-live で出る', /として保存しました/.test(await text(page, '#save-status')));
  await shot(page, 'csv-1280-light.png');

  // ---- ファイル選択: UTF-8（BOM なし）
  await chooseFile(page, files.utf8);
  const u = coreTable(files.utf8);
  const uAgg = Core.aggregate(u.table, { groupBy: 0, valueCol: 2, method: 'sum' });
  let st = await text(page, '#load-status');
  check('ファイル選択: UTF-8（BOM なし）と表示', /文字コード: UTF-8 ／/.test(st) && u.decoded.encoding === 'utf-8', st);
  r = await readResult(page);
  const uExpected = uAgg.groups.slice().sort((a, b) => (a.value === null) - (b.value === null) || b.value - a.value);
  check('ファイル選択: 引用符・カンマを含む店舗名と各種の金額を集計（csv-core と一致）',
    same(r.rows.map((x) => [x[0], x[1]]), uExpected.map((g) => [g.label, fmt(g.value)])) && r.rows.some((x) => x[0] === '東館, "新"'), JSON.stringify(r.rows));
  check('ファイル選択: 値が読めない店舗は「—」で、件数を表示', r.rows.some((x) => x[0] === '南館' && x[1] === '—') &&
    (await text(page, '#result-notes')).includes('読めない値が 1 件'), JSON.stringify(r.rows));
  dl = await download(page);
  dlText = dl.buf.toString('utf8');
  check('保存: カンマと引用符を含む値を正しくエスケープ', dlText.includes('"東館, ""新"""'), dlText.split('\r\n').slice(0, 3).join(' / '));
  check('保存: 数式になりそうな値の先頭に \' をつける', dlText.includes("'=SUM(1)"), dlText);
  back = Core.parseCSV(dlText.replace(/^\uFEFF/, ''), { header: false }).records;
  check('保存: 読み戻すと店舗名が元どおり', back.some((x) => x[0] === '東館, "新"'));

  // ---- ファイル選択: UTF-8（BOM あり）
  await chooseFile(page, files.bom);
  st = await text(page, '#load-status');
  r = await readResult(page);
  check('ファイル選択: UTF-8（BOM あり）と表示し、見出しに BOM が混ざらない',
    /文字コード: UTF-8（BOM あり）/.test(st) && (await page.evaluate(() => document.querySelector('#preview-head .col-name').textContent)) === '店舗', st);
  check('ファイル選択: BOM ありでも合計は同じ', r.foot[1] === fmt(uAgg.total.value), r.foot.join(' | '));

  // ---- ファイル選択: Shift_JIS
  await chooseFile(page, files.sjis);
  const sj = coreTable(files.sjis);
  st = await text(page, '#load-status');
  check('ファイル選択: Shift_JIS と判別して表示', /文字コード: Shift_JIS/.test(st) && sj.decoded.encoding === 'shift_jis', st);
  const sjPreview = await page.evaluate(() => [...document.querySelectorAll('#preview-body tr')].map((tr) => [...tr.children].map((c) => c.textContent)));
  check('Shift_JIS: 文字化けせずに読める（「ソ」「表」を含む）', same(sjPreview, sj.table.rows) && sjPreview[0][1] === 'ソフトクリーム' && sjPreview[1][1] === '表示用の見本', JSON.stringify(sjPreview));
  r = await readResult(page);
  const sjAgg = Core.aggregate(sj.table, { groupBy: 0, valueCol: 2, method: 'sum' });
  check('Shift_JIS: 合計が csv-core と一致（"\\1,200" は 1200 として読む）', r.foot[1] === fmt(sjAgg.total.value) && sjAgg.total.value === 2000, r.foot.join(' | '));

  // ---- 列の数が合わないファイル
  await chooseFile(page, files.mismatch);
  const warn = await text(page, '#load-warnings');
  check('列の数が足りない行・多い行・空行の件数を知らせる',
    warn.includes('少ない行が 2 件') && warn.includes('3 行目') && warn.includes('多い行が 1 件') && warn.includes('5 行目') && warn.includes('空の行（カンマだけの行を含む） 2 件'), warn);

  // ---- CSV ではないファイル
  await chooseFile(page, files.zip);
  const zipErr = await page.evaluate(() => ({ text: document.getElementById('load-error').textContent, role: document.getElementById('load-error').getAttribute('role') }));
  check('CSV ではないファイル（.xlsx）はエラーを出す（role=alert）', zipErr.text.includes('CSV ではないファイル') && zipErr.role === 'alert', zipErr.text);
  check('読み込めなかったときは、前のデータの集計が残っていることを伝える', zipErr.text.includes('「mismatch.csv」の集計は、そのまま下に残っています'), zipErr.text);

  // ---- 読めない値が多い数値の列も「集計する列」に選べる（一部が数値）
  await chooseFile(page, files.partial);
  const partial = await page.evaluate(() => ({
    options: [...document.querySelectorAll('#value-col option')].map((o) => o.textContent),
    method: document.getElementById('method').value,
  }));
  check('一部だけ数値の列も「集計する列」に出る（「一部が数値」と書く）', partial.options.includes('金額（一部が数値）'), JSON.stringify(partial.options));
  check('一部だけ数値の列でも、合計を選べる', partial.method === 'sum', partial.method);
  const partialResult = await readResult(page);
  check('読める値だけで合計する（30 件 × 100 = 3,000）', Number(partialResult.footValues[0]) === 3000, JSON.stringify(partialResult.footValues));

  // ---- UTF-16（Excel の「Unicode テキスト」）は読めて、保存し直し方を案内する
  await chooseFile(page, files.utf16tab);
  const u16 = await page.evaluate(() => ({
    status: document.getElementById('load-status').textContent,
    warnings: document.getElementById('load-warnings').textContent,
  }));
  check('UTF-16 のファイルを UTF-16 として読む', /文字コード: UTF-16/.test(u16.status), u16.status);
  check('タブ区切りの UTF-16 には「CSV UTF-8」で保存し直す案内を出す', u16.warnings.includes('CSV UTF-8（コンマ区切り）'), u16.warnings);

  // ---- ドラッグ＆ドロップ
  const dropText = '担当,件数\nA,1\nB,2\nA,3\n';
  const dt = await page.evaluateHandle((t) => {
    const d = new DataTransfer();
    d.items.add(new File([t], 'dropped.csv', { type: 'text/csv' }));
    return d;
  }, dropText);
  await page.dispatchEvent('#dropzone', 'dragenter', { dataTransfer: dt });
  check('ドラッグ中は枠の色が変わる', await page.evaluate(() => document.getElementById('dropzone').classList.contains('is-over')));
  await page.dispatchEvent('#dropzone', 'drop', { dataTransfer: dt });
  await waitStatus(page, /dropped\.csv」を読み込みました/);
  r = await readResult(page);
  check('ドラッグ＆ドロップで読み込める', same(r.rows.map((x) => [x[0], x[1]]), [['A', '4'], ['B', '2']]) && r.foot[1] === '6', JSON.stringify(r.rows));

  // ---- 大きなファイル
  await chooseFile(page, files.big10k);
  st = await text(page, '#load-status');
  const ms10k = Number(await page.getAttribute('#load-status', 'data-ms'));
  check(`1 万行: 読み込み〜集計〜表示が 1 秒以内（${ms10k}ms）`, /10,000 行/.test(st) && ms10k > 0 && ms10k < 1000, st);
  const big = coreTable(files.big10k);
  const bigAgg = Core.aggregate(big.table, { groupBy: 1, valueCol: 4, method: 'sum' });
  r = await readResult(page);
  check('1 万行: 合計が csv-core と一致', r.foot[1] === fmt(bigAgg.total.value), `${r.foot[1]} / ${fmt(bigAgg.total.value)}`);
  const t0 = Date.now();
  await chooseFile(page, files.big30k);
  const wall30k = Date.now() - t0;
  const ms30k = Number(await page.getAttribute('#load-status', 'data-ms'));
  check(`3 万行: 固まらずに読み込める（処理 ${ms30k}ms、待ち時間 ${wall30k}ms）`, /30,000 行/.test(await text(page, '#load-status')) && ms30k < 3000, String(ms30k));
  const responsive = await page.evaluate(() => new Promise((resolve) => { const s = performance.now(); setTimeout(() => resolve(performance.now() - s), 0); }));
  check('3 万行のあとも画面が応答する', responsive < 200, `${Math.round(responsive)}ms`);

  // ---- キーボードだけで操作する
  await page.reload({ waitUntil: 'load' });
  await page.focus('#file-input');
  const fileFocus = await page.evaluate(() => {
    const label = document.querySelector('label[for="file-input"]');
    const cs = getComputedStyle(label);
    return { active: document.activeElement.id, outline: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 };
  });
  check('キーボード: ファイル選択に Tab で止まり、枠線が見える', fileFocus.active === 'file-input' && fileFocus.outline, JSON.stringify(fileFocus));
  await page.keyboard.press('Tab');
  check('キーボード: 次の Tab で「サンプルを読み込む」', (await page.evaluate(() => document.activeElement.id)) === 'load-sample');
  await page.keyboard.press('Enter');
  await waitStatus(page, /sample\.csv」を読み込みました/);
  check('キーボード: Enter でサンプルを読み込める', !(await page.locator('#result-card').isHidden()));
  await page.focus('#method');
  await page.keyboard.press('ArrowDown'); // 合計 → 平均
  await page.waitForTimeout(100);
  const methodAfter = await page.evaluate(() => document.getElementById('method').value);
  check('キーボード: 矢印キーで集計のしかたを変えられる', methodAfter === 'avg', methodAfter);
  await page.locator('#settings-form button[type="submit"]').focus();
  await page.keyboard.press('Enter');
  check('キーボード: 「集計する」で結果の見出しにフォーカスが移る', (await page.evaluate(() => document.activeElement.id)) === 'result-title');
  await page.focus('#result-head button[data-col="0"]');
  await page.keyboard.press('Enter');
  r = await readResult(page);
  check('キーボード: 見出しのボタンで並べ替えられる', r.sort[0] === 'ascending');
  await page.focus('#chart-plot svg');
  await page.keyboard.press('ArrowDown');
  const live = await text(page, '#chart-live');
  check('キーボード: グラフにフォーカスして矢印キーで値を読み上げる', /^2 \/ 3 本目: /.test(live), live);

  check('1280px: コンソールエラーなし', state.consoleErrors.length === 0, state.consoleErrors.join(' / '));
  check('1280px: 外部への通信なし', state.external.length === 0, state.external.join(' '));
  check('1280px: 読み込みの失敗（4xx/5xx）なし', state.badResponses.length === 0, state.badResponses.join(' '));

  // ダークの見た目（1280px）
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload({ waitUntil: 'load' });
  await page.click('#load-sample');
  await waitStatus(page, /sample\.csv」を読み込みました/);
  await shot(page, 'csv-1280-dark.png');
  await context.close();
}

// ====================================================================== 375px（スマホ）
async function mobileFlow(browser, scheme) {
  console.log(`開く: ${PAGE_URL}（幅 375px、${scheme === 'dark' ? 'ダーク' : 'ライト'}）`);
  const { context, page, state } = await openPage(browser, { viewport: { width: 375, height: 800 }, hasTouch: true, isMobile: true });
  await page.emulateMedia({ colorScheme: scheme });
  await page.goto(PAGE_URL, { waitUntil: 'load' });
  const label = scheme === 'dark' ? 'ダーク' : 'ライト';

  const noScroll = async (when) => {
    const s = await scrollInfo(page);
    check(`375px・${label}: 横スクロールなし（${when}）`, s.scrollWidth <= s.clientWidth, `${s.scrollWidth} > ${s.clientWidth}`);
  };
  await noScroll('開いたとき');
  await page.click('#load-sample');
  await waitStatus(page, /sample\.csv」を読み込みました/);
  await noScroll('サンプルを読み込んで集計したあと');

  const small = await page.evaluate(() => {
    const els = [...document.querySelectorAll('main button, main select, main label.btn, main label.radio, main input:not(.file-input):not([type="radio"])')];
    return els.filter((el) => el.getClientRects().length > 0 && !el.closest('[hidden]'))
      .map((el) => { const r = el.getBoundingClientRect(); return { id: el.id || el.className || el.textContent.trim().slice(0, 10), w: Math.round(r.width), h: Math.round(r.height) }; })
      .filter((x) => x.w < 44 || x.h < 44);
  });
  check(`375px・${label}: ボタン・選択欄・ラジオボタンは 44px 以上`, small.length === 0, JSON.stringify(small.slice(0, 5)));
  // ヘッダーとフッターのリンクは、ほかのページと同じく高さを 44px 以上にしている
  const lowLinks = await page.evaluate(() => [...document.querySelectorAll('.site-header a, .site-footer a')]
    .map((a) => ({ t: a.textContent.trim(), h: Math.round(a.getBoundingClientRect().height) })).filter((x) => x.h < 44));
  check(`375px・${label}: ヘッダー・フッターのリンクの高さは 44px 以上`, lowLinks.length === 0, JSON.stringify(lowLinks));

  const colors = await page.evaluate(() => ({
    bg: getComputedStyle(document.body).backgroundColor,
    bar: getComputedStyle(document.querySelector('#chart-plot .bar')).fill,
    surface: getComputedStyle(document.querySelector('.card')).backgroundColor
  }));
  if (scheme === 'dark') {
    check('ダーク: 背景が暗くなる', colors.bg === 'rgb(15, 20, 25)', colors.bg);
  } else {
    check('ライト: 背景が明るい', colors.bg === 'rgb(246, 247, 249)', colors.bg);
  }
  check(`375px・${label}: グラフの棒に色がつき、背景と違う`, colors.bar && colors.bar !== colors.surface && colors.bar !== 'none', `${colors.bar} / ${colors.surface}`);
  await shot(page, `csv-375-${scheme}.png`);

  await page.selectOption('#column-col', { label: '商品' });
  await noScroll('ピボット表');
  check(`375px・${label}: 表がはみ出すときは「横にずらして見られます」と知らせる`, await page.isVisible('#table-scroll-hint'));
  await page.selectOption('#column-col', '');
  await page.selectOption('#group-col', { label: '日付（日付）' });
  await page.check('input[name="date-unit"][value="day"]');
  await noScroll('日ごと（項目が多い）');
  if (scheme === 'light') await shot(page, 'csv-375-light-day.png');

  check(`375px・${label}: コンソールエラーなし`, state.consoleErrors.length === 0, state.consoleErrors.join(' / '));
  check(`375px・${label}: 外部への通信なし`, state.external.length === 0, state.external.join(' '));
  await context.close();
}

async function main() {
  const files = writeFixtures();
  // 保存するファイルの名前に日本語を使う。文字コードが UTF-8 でない環境（LANG=C など）で起動すると
  // ブラウザが日本語のファイル名を使えず "download" という名前になるため、そのときは UTF-8 にして起動する。
  const localeVar = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || '';
  const env = /utf-?8/i.test(localeVar) ? undefined : Object.assign({}, process.env, { LC_ALL: 'C.UTF-8' });
  const browser = await chromium.launch(env ? { env } : {});
  try {
    await desktopFlow(browser, files);
    await mobileFlow(browser, 'light');
    await mobileFlow(browser, 'dark');
  } catch (err) {
    failed++;
    console.log(`  NG テストの途中で止まった … ${err && err.stack ? err.stack.split('\n').slice(0, 3).join(' ') : err}`);
  } finally {
    await browser.close();
    if (!process.env.CSV_E2E_DIR) fs.rmSync(WORK_DIR, { recursive: true, force: true });
  }
  console.log(`合計: ${passed} 件成功 / ${failed} 件失敗`);
  if (failed > 0) process.exit(1);
}

main();
