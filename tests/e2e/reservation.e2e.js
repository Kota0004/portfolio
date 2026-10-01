// 予約フォームのデモ（site/demos/reservation/）のブラウザのテスト。
//
// 使い方（リポジトリの一番上で）:
//   python3 -m http.server 8000 -d site &
//   node tests/e2e/reservation.e2e.js
//
// BASE_URL で開く先を変えられる（既定 http://localhost:8000）。
// SCREENSHOT_DIR を指定すると、375px / 1280px のライト・ダークのスクリーンショットをそこに保存する。
//
// 「いま」は 2026-10-01（木）13:30（日本時間）に固定して確かめる（page.clock）。
// この日は 10:00〜13:00 の枠が受付終了、16:00 が架空の既存予約で埋まっている。
'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE_URL = (process.env.BASE_URL || 'http://localhost:8000').replace(/\/+$/, '') + '/';
const PAGE_URL = BASE_URL + 'demos/reservation/';
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || '';
const STORAGE_KEY = 'kota0004-demo-reservation-v1';
const FIXED_NOW = new Date('2026-10-01T13:30:00+09:00');
const TIMEZONE = 'Asia/Tokyo';
const NOTICE = 'これはデモです。入力した内容はこのブラウザの中（localStorage）にだけ保存され、どこにも送信されません。';

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

const baseHost = new URL(BASE_URL).hostname;
function isLocal(url) {
  if (/^(data|blob|about):/.test(url)) return true;
  let u;
  try { u = new URL(url); } catch (e) { return false; }
  return ['localhost', '127.0.0.1', '[::1]', '::1', baseHost].includes(u.hostname);
}

async function openPage(browser, options) {
  const context = await browser.newContext(Object.assign({ timezoneId: TIMEZONE, locale: 'ja-JP', acceptDownloads: true }, options));
  const state = { external: [], consoleErrors: [], badResponses: [] };
  // 外へのリクエストは記録して止める（実際には通信しない）
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (isLocal(url)) return route.continue();
    state.external.push(url);
    return route.abort();
  });
  await context.clock.setFixedTime(FIXED_NOW);
  const page = await context.newPage();
  watchPage(page, state);
  return { context, page, state };
}

function watchPage(page, state) {
  page.on('console', (msg) => { if (msg.type() === 'error') state.consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => state.consoleErrors.push(String(err)));
  page.on('response', (res) => { if (res.status() >= 400) state.badResponses.push(`${res.status()} ${res.url()}`); });
}

async function readStore(page) {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  }, STORAGE_KEY);
}

async function scrollInfo(page) {
  return page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
}

async function activeId(page) {
  return page.evaluate(() => (document.activeElement ? document.activeElement.id : ''));
}

async function text(page, selector) {
  return squash(await page.locator(selector).first().textContent());
}

async function isHidden(page, selector) {
  // hidden 属性ではなく、実際に画面に出ているかで見る（CSS の display 指定で hidden が効かないことがあるため）
  return page.locator(selector).first().evaluate((el) => el.getClientRects().length === 0 || getComputedStyle(el).visibility === 'hidden');
}

async function shot(page, name, fullPage = true) {
  if (!SCREENSHOT_DIR) return;
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.waitForTimeout(300); // 色の切り替え（transition）が終わるのを待つ
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, name), fullPage });
}

// 入力欄を埋める
async function fillForm(page, v) {
  await page.fill('#f-name', v.name);
  await page.fill('#f-email', v.email);
  await page.fill('#f-people', v.people);
  if (v.purpose) await page.selectOption('#f-purpose', v.purpose);
  await page.fill('#f-note', v.note || '');
}

const NOTE_TRICKY = '会議用, プロジェクター希望\n"至急"の確認です';

// ====================================================================== 1280px（PC）
async function desktopFlow(browser) {
  console.log(`開く: ${PAGE_URL}（幅 1280px、いま = 2026-10-01 13:30 日本時間）`);
  const { context, page, state } = await openPage(browser, { viewport: { width: 1280, height: 900 } });
  const res = await page.goto(PAGE_URL, { waitUntil: 'load' });
  check('ページが開ける（HTTP 200）', res && res.status() === 200, res ? `HTTP ${res.status()}` : '応答なし');

  // ---- 文書の基本
  const head = await page.evaluate(() => ({
    lang: document.documentElement.getAttribute('lang'),
    charset: document.characterSet,
    metaCharset: !!document.querySelector('meta[charset]'),
    viewport: (document.querySelector('meta[name="viewport"]') || {}).content || '',
    title: document.title,
    description: (document.querySelector('meta[name="description"]') || {}).content || '',
    scripts: [...document.scripts].map((s) => s.getAttribute('src')),
    styles: [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.getAttribute('href')),
  }));
  check('<html lang="ja"> と UTF-8', head.lang === 'ja' && head.metaCharset && head.charset === 'UTF-8', `${head.lang} ${head.charset}`);
  check('viewport の指定', /width=device-width/.test(head.viewport) && /initial-scale=1/.test(head.viewport), head.viewport);
  check('<title> が短く、description がある', head.title.length > 0 && head.title.length <= 40 && head.description.length > 0, head.title);
  check('読み込むのは自前のファイルだけ', head.scripts.every((s) => s && !/^https?:|^\/\//.test(s)) && head.styles.every((s) => !/^https?:|^\/\//.test(s)),
    [...head.scripts, ...head.styles].join(' '));
  check('base.css を使っている', head.styles.includes('../../assets/base.css'), head.styles.join(' '));

  // ---- 共通のヘッダーとフッター
  const chrome = await page.evaluate(() => {
    const brand = document.querySelector('header.site-header .brand');
    const nav = document.querySelector('header.site-header nav[aria-label="サイト内"]');
    const footer = document.querySelector('footer.site-footer');
    return {
      brand: brand ? `${brand.textContent.trim()} ${brand.getAttribute('href')}` : '',
      nav: nav ? [...nav.querySelectorAll('a')].map((a) => `${a.textContent.trim()}=${a.getAttribute('href')}`).join(' ') : '',
      footer: footer ? footer.textContent.replace(/\s+/g, ' ').trim() : '',
      footerLink: footer && footer.querySelector('a') ? footer.querySelector('a').getAttribute('href') : '',
    };
  });
  check('ヘッダー: Kota0004 → ../../', chrome.brand === 'Kota0004 ../../', chrome.brand);
  check('ヘッダーのナビ', chrome.nav === '制作実績=../../#works デモ=../../#demos できること=../../#services', chrome.nav);
  check('フッター', chrome.footer === '© 2026 Kota0004 ・ GitHub' && chrome.footerLink === 'https://github.com/Kota0004', chrome.footer);

  // ---- お知らせ
  check('冒頭にデモのお知らせ', (await text(page, '.demo-notice__text')) === NOTICE, await text(page, '.demo-notice__text'));
  check('「デモを最初の状態に戻す」ボタン', (await text(page, '#reset-demo')) === 'デモを最初の状態に戻す');
  check('最初は何も保存されていない', (await readStore(page)) === null);

  // ---- 日付
  const dates = await page.$$eval('#date-list input[name="date"]', (els) => els.map((e) => ({
    key: e.value, disabled: e.disabled, checked: e.checked,
    label: e.closest('label').textContent.replace(/\s+/g, ' ').trim(),
  })));
  check('日付は今日から14日分', dates.length === 14 && dates[0].key === '2026-10-01' && dates[13].key === '2026-10-14',
    `${dates.length} 件 ${dates[0] && dates[0].key}〜${dates[13] && dates[13].key}`);
  const closed = dates.filter((d) => d.disabled);
  check('水曜（10/7・10/14）だけが選べない', closed.map((d) => d.key).join(',') === '2026-10-07,2026-10-14', closed.map((d) => d.key).join(','));
  check('定休日には「定休日」と文字で出る', closed.every((d) => d.label.includes('定休日')), closed.map((d) => d.label).join(' / '));
  check('最初は空きのある今日が選ばれている', dates[0].checked, dates.filter((d) => d.checked).map((d) => d.key).join(','));
  check('今日には「今日」と出る', dates[0].label.includes('今日'), dates[0].label);
  await page.click('label[for="date-2026-10-07"]', { force: true }); // 選べない日のボタンを押してみる
  const closedNote = await text(page, '#date-note');
  check('定休日を押すと理由が出る', /10月7日（水）は選べません。毎週水曜日は定休日/.test(closedNote), closedNote);
  check('定休日を押しても選ばれない', await page.$eval('#date-2026-10-07', (e) => !e.checked));
  check('定休日の理由が読み上げ用にも結び付いている', await page.$eval('#date-2026-10-07', (e) => {
    const ids = (e.getAttribute('aria-describedby') || '').split(/\s+/);
    return ids.some((id) => /定休日/.test((document.getElementById(id) || {}).textContent || ''));
  }));

  // ---- 時間枠（今日 13:30）
  const slots = await page.$$eval('#slot-list label', (els) => els.map((l) => ({
    hour: Number(l.getAttribute('data-hour')),
    status: l.getAttribute('data-status'),
    disabled: l.querySelector('input').disabled,
    text: l.textContent.replace(/\s+/g, ' ').trim(),
  })));
  check('時間枠は 10:00〜18:00 の8枠', slots.length === 8 && slots[0].text.startsWith('10:00〜11:00') && slots[7].text.startsWith('17:00〜18:00'),
    slots.map((s) => s.text).join(' | '));
  const statusOf = (hr) => (slots.find((s) => s.hour === hr) || {});
  check('今日の過ぎた枠（10:00〜13:00 開始）は選べず「受付終了」と出る',
    [10, 11, 12, 13].every((hr) => statusOf(hr).status === 'past' && statusOf(hr).disabled && statusOf(hr).text.includes('受付終了')),
    [10, 11, 12, 13].map((hr) => statusOf(hr).text).join(' | '));
  check('埋まっている枠（16:00）は選べず「予約済み」と出る',
    statusOf(16).status === 'booked' && statusOf(16).disabled && statusOf(16).text.includes('予約済み'), statusOf(16).text);
  check('選べる枠（14・15・17時）には「空き」と出る',
    [14, 15, 17].every((hr) => statusOf(hr).status === 'available' && !statusOf(hr).disabled && statusOf(hr).text.includes('空き')),
    [14, 15, 17].map((hr) => statusOf(hr).text).join(' | '));
  const distinct = new Set(['空き', '予約済み', '受付終了'].map((w) => slots.filter((s) => s.text.includes(w)).length > 0));
  check('3つの状態が色だけでなく文字でも区別できる', distinct.size === 1 && distinct.has(true));

  // ---- 何も入れずに送る → エラーがまとめて出て、最初の項目にフォーカス
  await page.click('#reserve-form button[type="submit"]');
  const errs = await page.evaluate(() => {
    const out = {};
    ['date', 'slot', 'name', 'email', 'people', 'purpose', 'note'].forEach((k) => {
      out[k] = document.getElementById('err-' + k).textContent.trim();
    });
    return out;
  });
  check('空のまま送ると、時間・お名前・メール・人数のエラーが同時に出る',
    errs.slot === '時間を選んでください。' && errs.name === 'お名前を入力してください。' &&
    errs.email === 'メールアドレスを入力してください。' && errs.people === '人数を入力してください。' &&
    errs.date === '' && errs.purpose === '' && errs.note === '', JSON.stringify(errs));
  check('最初のエラー項目（時間の最初の空き枠）にフォーカスが移る', (await activeId(page)) === 'slot-14', await activeId(page));
  check('まとめのお知らせ（4件）が出る', /4件/.test(await text(page, '#form-status')), await text(page, '#form-status'));
  const a11y = await page.evaluate(() => {
    const live = [...document.querySelectorAll('.error')].every((e) => e.getAttribute('aria-live') === 'polite');
    const name = document.getElementById('f-name');
    const label = document.querySelector('label[for="f-name"]');
    return {
      live,
      invalid: name.getAttribute('aria-invalid'),
      described: (name.getAttribute('aria-describedby') || '').split(/\s+/).includes('err-name'),
      label: !!label,
      below: name.closest('.field').contains(document.getElementById('err-name')) &&
        !!(name.compareDocumentPosition(document.getElementById('err-name')) & Node.DOCUMENT_POSITION_FOLLOWING),
      allLabelled: ['f-name', 'f-email', 'f-people', 'f-purpose', 'f-note'].every((id) => document.querySelector(`label[for="${id}"]`)),
    };
  });
  check('エラーは aria-live で読み上げられる', a11y.live);
  check('エラーの項目は aria-invalid、エラー文は aria-describedby で結び付く', a11y.invalid === 'true' && a11y.described);
  check('エラーは項目のすぐ下に出る', a11y.below);
  check('すべての入力欄に label がある', a11y.allLabelled);

  // ---- 51文字の名前・不正なメール・人数0
  await page.click('label[for="slot-14"]');
  await fillForm(page, { name: 'あ'.repeat(51), email: 'demo@example', people: '0' });
  check('枠を選ぶと時間のエラーが消える', (await text(page, '#err-slot')) === '', await text(page, '#err-slot'));
  await page.click('#reserve-form button[type="submit"]');
  check('51文字の名前はエラー', (await text(page, '#err-name')) === 'お名前は50文字以内で入力してください（いま51文字）。', await text(page, '#err-name'));
  check('不正なメールはエラー', /形式が正しくありません/.test(await text(page, '#err-email')), await text(page, '#err-email'));
  check('人数0はエラー', (await text(page, '#err-people')) === '人数は1〜10人の範囲で入力してください。', await text(page, '#err-people'));
  check('最初のエラー項目（お名前）にフォーカスが移る', (await activeId(page)) === 'f-name', await activeId(page));
  check('入力欄はエラーのあいだ確認画面に進まない', await isHidden(page, '#view-confirm'));
  await page.fill('#f-people', '11');
  check('人数11は（直したそばから）エラー', (await text(page, '#err-people')) === '人数は1〜10人の範囲で入力してください。', await text(page, '#err-people'));
  await page.fill('#f-name', 'あ'.repeat(50));
  check('50文字に直すとお名前のエラーが消える', (await text(page, '#err-name')) === '', await text(page, '#err-name'));

  // ---- 正しく入れて確認画面へ
  await fillForm(page, { name: 'デモ 花子', email: 'demo.hanako@example.com', people: '4', purpose: 'seminar', note: NOTE_TRICKY });
  await page.click('#reserve-form button[type="submit"]');
  check('確認画面に進む', !(await isHidden(page, '#view-confirm')) && (await isHidden(page, '#view-form')));
  check('確認画面の見出しにフォーカス', (await activeId(page)) === 'confirm-title', await activeId(page));
  check('確認画面のボタンは「修正する」「予約する」の2つ（「時間を選び直す」は出ない）',
    !(await isHidden(page, '#back-to-form')) && !(await isHidden(page, '#confirm-booking')) && (await isHidden(page, '#choose-again')));
  const summary = await text(page, '#confirm-summary');
  check('確認画面に入力内容が出る',
    summary.includes('2026年10月1日（木） 14:00〜15:00') && summary.includes('デモ 花子') && summary.includes('demo.hanako@example.com') &&
    summary.includes('4人') && summary.includes('勉強会・セミナー') && summary.includes('"至急"の確認です'), summary);
  check('確認画面の段階では保存されていない', (await readStore(page)) === null);
  await page.click('#back-to-form');
  check('「修正する」で入力に戻り、内容が残っている', !(await isHidden(page, '#view-form')) && (await page.inputValue('#f-name')) === 'デモ 花子');
  // ブラウザの「戻る」: 確認画面から戻ると、ページを離れずに入力画面へ（内容は残る）
  await page.click('#reserve-form button[type="submit"]');
  await page.goBack();
  await page.waitForFunction(() => !document.getElementById('view-form').hidden);
  check('確認画面でブラウザの「戻る」→ 入力画面に戻り、内容が残っている',
    page.url().startsWith(PAGE_URL) && (await isHidden(page, '#view-confirm')) && (await page.inputValue('#f-name')) === 'デモ 花子', page.url());
  await page.click('#reserve-form button[type="submit"]');
  await page.click('#confirm-booking');

  // ---- 完了画面
  check('完了画面に進む', !(await isHidden(page, '#view-done')), '');
  const number1 = await text(page, '#done-number');
  check('予約番号が「R-利用日-連番」で出る', number1 === 'R-20261001-01', number1);
  check('完了画面の見出しにフォーカス', (await activeId(page)) === 'done-title', await activeId(page));
  const store1 = await readStore(page);
  check('localStorage に1件保存される', store1 && store1.reservations.length === 1 && store1.reservations[0].id === 'R-20261001-01',
    JSON.stringify(store1));
  check('管理画面タブの件数が1件になる', (await text(page, '#admin-count-badge')) === '1件', await text(page, '#admin-count-badge'));

  await page.click('#book-again');
  check('「続けて予約する」で入力に戻り、欄が空になる', !(await isHidden(page, '#view-form')) && (await page.inputValue('#f-name')) === '');
  check('予約した枠（今日 14:00）が「予約済み」になる',
    (await page.getAttribute('label[for="slot-14"]', 'data-status')) === 'booked' && (await page.isDisabled('#slot-14')));

  // ---- 二重予約の拒否（確認画面のあいだに、別のタブが先に埋めたことにする）
  await page.click('label[for="date-2026-10-02"]');
  await page.click('label[for="slot-15"]');
  await fillForm(page, { name: 'デモ 次郎', email: 'demo.jiro@example.com', people: '2' });
  await page.click('#reserve-form button[type="submit"]');
  check('2件目も確認画面まで進む', !(await isHidden(page, '#view-confirm')));
  await page.evaluate((key) => {
    const s = JSON.parse(localStorage.getItem(key));
    s.reservations.push({
      id: 'R-20261002-01', dateKey: '2026-10-02', hour: 15, name: '別タブの予約', email: 'other@example.com',
      people: 2, purpose: 'meeting', note: '', createdAt: new Date().toISOString(),
    });
    s.counters['2026-10-02'] = 1;
    localStorage.setItem(key, JSON.stringify(s));
  }, STORAGE_KEY);
  await page.click('#confirm-booking');
  const conflict = await text(page, '#confirm-error');
  check('先に埋まっていたら二重予約にせず、その旨を出す', /先に予約が入りました/.test(conflict) && /二重予約を防ぐため/.test(conflict), conflict);
  check('お知らせは role="alert"', (await page.getAttribute('#confirm-error', 'role')) === 'alert');
  check('完了画面には進まない', await isHidden(page, '#view-done'));
  check('「予約する」が隠れ、「時間を選び直す」が出る', (await isHidden(page, '#confirm-booking')) && !(await isHidden(page, '#choose-again')));
  const store2 = await readStore(page);
  check('二重に保存されない（10/2 15時は1件だけ）',
    store2.reservations.filter((r) => r.dateKey === '2026-10-02' && r.hour === 15).length === 1 && store2.reservations.length === 2,
    store2.reservations.map((r) => `${r.id}:${r.name}`).join(', '));
  await page.click('#choose-again');
  check('「時間を選び直す」で入力に戻り、その枠は「予約済み」',
    !(await isHidden(page, '#view-form')) && (await page.getAttribute('label[for="slot-15"]', 'data-status')) === 'booked');
  check('時間のエラーが出て、空き枠にフォーカス', /予約できなくなりました/.test(await text(page, '#err-slot')) && /^slot-\d+$/.test(await activeId(page)),
    `${await text(page, '#err-slot')} / ${await activeId(page)}`);
  check('入力した内容は残っている', (await page.inputValue('#f-name')) === 'デモ 次郎');
  await page.click('label[for="slot-17"]');
  await page.click('#reserve-form button[type="submit"]');
  await page.click('#confirm-booking');
  const number2 = await text(page, '#done-number');
  check('選び直した枠で予約でき、連番は02になる', number2 === 'R-20261002-02', number2);

  // ---- ブラウザの「戻る」: 完了画面から戻ると新しい予約の入力画面になり、確定した予約を二重に確定しない
  const before = (await readStore(page)).reservations.length;
  await page.goBack();
  await page.waitForFunction(() => !document.getElementById('view-form').hidden);
  check('完了画面でブラウザの「戻る」→ 新しい予約の入力画面（ページは離れない）',
    page.url().startsWith(PAGE_URL) && (await isHidden(page, '#view-confirm')) && (await page.inputValue('#f-name')) === '', page.url());
  check('「戻る」で予約が増えたり消えたりしない', (await readStore(page)).reservations.length === before);

  // ---- 別のタブで先に予約されると、確認画面にお知らせが出る（storage イベント）
  await page.click('label[for="date-2026-10-05"]');
  await page.click('label[for="slot-11"]');
  await fillForm(page, { name: 'デモ 三郎', email: 'demo.saburo@example.com', people: '1' });
  await page.click('#reserve-form button[type="submit"]');
  const page2 = await context.newPage();
  watchPage(page2, state);
  await page2.goto(PAGE_URL, { waitUntil: 'load' });
  await page2.click('label[for="date-2026-10-05"]');
  await page2.click('label[for="slot-11"]');
  await fillForm(page2, { name: '別タブ', email: 'tab2@example.com', people: '3' });
  await page2.click('#reserve-form button[type="submit"]');
  await page2.click('#confirm-booking');
  check('別のタブで同じ枠を予約できる', (await text(page2, '#done-number')) === 'R-20261005-01', await text(page2, '#done-number'));
  await page.waitForFunction(() => document.getElementById('confirm-error').textContent.length > 0, null, { timeout: 3000 }).catch(() => {});
  check('元のタブの確認画面に「先に予約が入りました」と出る', /先に予約が入りました/.test(await text(page, '#confirm-error')), await text(page, '#confirm-error'));
  await page2.close();
  await page.click('#choose-again');

  // ---- 管理画面（キーボードでタブを切り替える）
  await page.focus('#tab-book');
  await page.keyboard.press('ArrowRight');
  check('→キーで「管理画面」タブに切り替わる',
    (await page.getAttribute('#tab-admin', 'aria-selected')) === 'true' && (await activeId(page)) === 'tab-admin' && !(await isHidden(page, '#panel-admin')));
  const rows = await page.$$eval('#admin-rows tr', (trs) => trs.map((tr) => tr.getAttribute('data-id')));
  check('一覧は日付・時刻の順', rows.join(',') === 'R-20261001-01,R-20261002-01,R-20261002-02,R-20261005-01', rows.join(','));
  check('件数の表示', (await text(page, '#admin-count')) === '4件', await text(page, '#admin-count'));
  const rowText = await text(page, '#admin-rows tr[data-id="R-20261001-01"]');
  check('一覧に日時・お名前・人数・目的・備考が出る',
    rowText.includes('10月1日（木）') && rowText.includes('14:00〜15:00') && rowText.includes('デモ 花子') && rowText.includes('4人') &&
    rowText.includes('勉強会・セミナー') && rowText.includes('"至急"の確認です'), rowText);

  // ---- CSV 書き出し
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export-csv')]);
  const csvPath = await download.path();
  const buf = fs.readFileSync(csvPath);
  check('CSV のファイル名', download.suggestedFilename() === 'sample-room-reservations-20261001.csv', download.suggestedFilename());
  check('CSV は UTF-8 の BOM つき', buf.subarray(0, 3).toString('hex') === 'efbbbf', buf.subarray(0, 3).toString('hex'));
  const csv = buf.toString('utf8').replace(/^﻿/, '');
  const lines = csv.split('\r\n');
  check('CSV の見出し行', lines[0] === '予約番号,利用日,曜日,開始,終了,お名前,メールアドレス,人数,利用目的,備考,受付日時', lines[0]);
  check('CSV の行は日付・時刻の順', ['R-20261001-01', 'R-20261002-01', 'R-20261002-02', 'R-20261005-01']
    .every((id, i) => (lines[i + 1] || '').startsWith(id + ',')), lines.map((l) => l.slice(0, 14)).join(' | '));
  check('カンマ・改行・ダブルクォートを含む備考が正しく囲まれる',
    lines[1] === 'R-20261001-01,2026-10-01,木,14:00,15:00,デモ 花子,demo.hanako@example.com,4,勉強会・セミナー,"会議用, プロジェクター希望\n""至急""の確認です",2026-10-01 13:30',
    JSON.stringify(lines[1]));
  await page.waitForTimeout(150);
  check('書き出したことを知らせる', /4件の予約を CSV に書き出しました/.test(await text(page, '#admin-status')), await text(page, '#admin-status'));

  // ---- 取り消し（確認つき）
  await page.click('#admin-rows tr[data-id="R-20261002-01"] [data-cancel]');
  const dialogOpen = await page.$eval('#cancel-dialog', (d) => d.open);
  check('取り消しの前に確認が出る', dialogOpen && /R-20261002-01/.test(await text(page, '#cancel-desc')), await text(page, '#cancel-desc'));
  check('確認では「やめる」にフォーカス（うっかり取り消さない）', (await activeId(page)) === 'cancel-keep', await activeId(page));
  await page.click('#cancel-keep');
  check('「やめる」なら取り消さない', !(await page.$eval('#cancel-dialog', (d) => d.open)) &&
    (await page.$$('#admin-rows tr[data-id="R-20261002-01"]')).length === 1);
  await page.click('#admin-rows tr[data-id="R-20261002-01"] [data-cancel]');
  await page.keyboard.press('Escape');
  check('Esc でも閉じて、取り消さない', !(await page.$eval('#cancel-dialog', (d) => d.open)) &&
    (await page.$$('#admin-rows tr[data-id="R-20261002-01"]')).length === 1);
  await page.click('#admin-rows tr[data-id="R-20261002-01"] [data-cancel]');
  await page.click('#cancel-do');
  await page.waitForTimeout(120);
  const afterRows = await page.$$eval('#admin-rows tr', (trs) => trs.map((tr) => tr.getAttribute('data-id')));
  check('「取り消す」で一覧から消える', afterRows.join(',') === 'R-20261001-01,R-20261002-02,R-20261005-01', afterRows.join(','));
  check('取り消したことを知らせる', /R-20261002-01 を取り消しました/.test(await text(page, '#admin-status')), await text(page, '#admin-status'));
  const store3 = await readStore(page);
  check('localStorage からも消える', store3.reservations.length === 3 && !store3.reservations.some((r) => r.id === 'R-20261002-01'));
  await page.click('#tab-book');
  await page.click('label[for="date-2026-10-02"]');
  check('取り消した枠（10/2 15時）はまた選べる', (await page.getAttribute('label[for="slot-15"]', 'data-status')) === 'available');

  // ---- リセット
  await page.click('#reset-demo');
  await page.waitForTimeout(120);
  check('リセットすると保存内容が消える', (await readStore(page)) === null);
  check('リセットを知らせる', /最初の状態に戻しました/.test(await text(page, '#reset-status')), await text(page, '#reset-status'));
  check('リセット後は管理画面の件数が0件', (await text(page, '#admin-count-badge')) === '0件');
  check('リセット後は今日の 14:00 がまた空き', (await page.getAttribute('label[for="slot-14"]', 'data-status')) === 'available');
  await page.click('#tab-admin');
  check('リセット後の管理画面は「まだ予約はありません」', !(await isHidden(page, '#admin-empty')) && (await page.isDisabled('#export-csv')));
  await page.click('#tab-book');

  // ---- 1280px のスクリーンショット（ライト・ダーク）
  await page.click('label[for="date-2026-10-03"]');
  await page.click('label[for="slot-13"]');
  await shot(page, 'reservation-1280-light-form.png');
  await page.emulateMedia({ colorScheme: 'dark' });
  const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check('ダークモードで配色が切り替わる', darkBg === 'rgb(15, 20, 25)', darkBg);
  await shot(page, 'reservation-1280-dark-form.png');
  await page.emulateMedia({ colorScheme: 'light' });

  const scroll = await scrollInfo(page);
  check('1280px で横スクロールなし', scroll.scrollWidth <= scroll.clientWidth, `${scroll.scrollWidth} > ${scroll.clientWidth}`);

  check('コンソールエラーなし（1280px）', state.consoleErrors.length === 0, state.consoleErrors.join(' / '));
  check('外部への通信なし（1280px）', state.external.length === 0, state.external.join(' '));
  check('読み込みエラー（4xx/5xx）なし（1280px）', state.badResponses.length === 0, state.badResponses.join(' '));
  await context.close();
}

// ====================================================================== 375px（スマホ）
async function mobileFlow(browser) {
  console.log(`開く: ${PAGE_URL}（幅 375px）`);
  const { context, page, state } = await openPage(browser, { viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
  await page.goto(PAGE_URL, { waitUntil: 'load' });

  // 長い文字を含む予約を先に入れておく（折り返しで横にはみ出さないか）
  await page.evaluate((key) => {
    const long = 'あ'.repeat(120) + 'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(2);
    localStorage.setItem(key, JSON.stringify({
      version: 1,
      reservations: [
        { id: 'R-20261003-01', dateKey: '2026-10-03', hour: 11, name: 'とても長いお名前'.repeat(6), email: 'very.long.address.for.layout.check@sub.example.com',
          people: 10, purpose: 'other', note: long, createdAt: '2026-10-01T04:00:00.000Z' },
      ],
      counters: { '2026-10-03': 1 },
    }));
  }, STORAGE_KEY);
  await page.reload({ waitUntil: 'load' });

  const noScroll = async (label) => {
    const s = await scrollInfo(page);
    check(`375px で横スクロールなし（${label}）`, s.scrollWidth <= s.clientWidth, `${s.scrollWidth} > ${s.clientWidth}`);
  };
  await noScroll('入力');

  // タップしやすい大きさ（44px 以上）
  const small = await page.evaluate(() => {
    const els = [...document.querySelectorAll('main button, main .chip, main input:not(.chip__input), main select, main textarea, [role="tab"]')];
    return els.filter((el) => el.getClientRects().length > 0 && !el.closest('[hidden]'))
      .map((el) => { const r = el.getBoundingClientRect(); return { id: el.id || el.className || el.tagName, w: Math.round(r.width), h: Math.round(r.height) }; })
      .filter((x) => x.w < 44 || x.h < 44);
  });
  check('ボタン・選択肢・入力欄は 44px 以上', small.length === 0, JSON.stringify(small.slice(0, 5)));
  // ヘッダーとフッターのリンクも、ほかのページと同じく 44px 以上（base.css で指定）
  const lowLinks = await page.evaluate(() => [...document.querySelectorAll('.site-header a, .site-footer a')]
    .map((a) => { const r = a.getBoundingClientRect(); return { t: a.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height) }; })
    .filter((x) => x.h < 44 || (x.w < 44 && x.t !== 'Kota0004')));
  check('ヘッダー・フッターのリンクは 44px 以上', lowLinks.length === 0, JSON.stringify(lowLinks));

  // キーボードだけで予約する
  await page.focus('#form-title');
  await page.keyboard.press('Tab');
  const firstFocus = await page.evaluate(() => ({ name: document.activeElement.name, value: document.activeElement.value }));
  check('Tab で日付の選択肢に入れる', firstFocus.name === 'date' && firstFocus.value === '2026-10-01', JSON.stringify(firstFocus));
  await page.keyboard.press('ArrowRight');
  const afterArrow = await page.evaluate(() => ({ value: document.activeElement.value, checked: document.activeElement.checked, label: document.getElementById('slot-date-label').textContent }));
  check('→キーで次の日に移り、その日の空き状況に変わる', afterArrow.value === '2026-10-02' && afterArrow.checked && afterArrow.label.includes('10月2日'), JSON.stringify(afterArrow));
  await page.keyboard.press('Tab');
  const slotFocus = await page.evaluate(() => ({ name: document.activeElement.name, value: document.activeElement.value }));
  check('Tab で時間の選択肢に移る（最初の空き枠）', slotFocus.name === 'slot' && slotFocus.value === '11', JSON.stringify(slotFocus));
  await page.keyboard.press('Space');
  check('Space で枠を選べる', await page.$eval('#slot-11', (e) => e.checked));
  await page.keyboard.press('Tab');
  check('Tab でお名前の欄へ', (await activeId(page)) === 'f-name', await activeId(page));
  await page.keyboard.type('キーボード 太郎');
  await page.keyboard.press('Tab');
  await page.keyboard.type('keyboard@example.com');
  await page.keyboard.press('Tab');
  await page.keyboard.type('２'); // 全角でも受け付ける
  await page.keyboard.press('Enter');
  check('Enter で確認画面へ進む', !(await isHidden(page, '#view-confirm')) && (await activeId(page)) === 'confirm-title', await activeId(page));
  await noScroll('確認');
  await shot(page, 'reservation-375-light-confirm.png');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  check('Tab で「予約する」へ', (await activeId(page)) === 'confirm-booking', await activeId(page));
  await page.keyboard.press('Enter');
  check('Enter で予約が確定する', (await text(page, '#done-number')) === 'R-20261002-01', await text(page, '#done-number'));
  await noScroll('完了');
  await shot(page, 'reservation-375-light-done.png');

  // エラー表示の状態
  await page.click('#book-again');
  await page.click('#reserve-form button[type="submit"]');
  await noScroll('エラー表示');
  await shot(page, 'reservation-375-light-errors.png');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'reservation-375-dark-errors.png');
  await page.emulateMedia({ colorScheme: 'light' });

  // 入力の初期状態
  await page.reload({ waitUntil: 'load' });
  await page.click('label[for="slot-14"]');
  await shot(page, 'reservation-375-light-form.png');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'reservation-375-dark-form.png');
  await page.emulateMedia({ colorScheme: 'light' });

  // 管理画面（長い文字を含む行）
  await page.click('#tab-admin');
  const cards = await page.$$eval('#admin-rows tr', (trs) => trs.length);
  check('375px でも管理画面に一覧が出る', cards === 2, `${cards} 行`);
  await noScroll('管理画面');
  const misplaced = await page.evaluate(() => [...document.querySelectorAll('#admin-rows td[data-label]')]
    .filter((td) => {
      const body = td.querySelector('.cell-body');
      const r = td.getBoundingClientRect();
      const b = body ? body.getBoundingClientRect() : null;
      // 見出し（左の列）の右側に、中身がまとまって並んでいるか
      return !b || b.left < r.left + 60 || b.top > r.top + 20;
    }).map((td) => td.getAttribute('data-label')));
  check('375px の一覧は「見出し｜中身」の2列で並ぶ', misplaced.length === 0, misplaced.join(','));
  const smallAdmin = await page.evaluate(() => [...document.querySelectorAll('#panel-admin button')]
    .filter((el) => el.getClientRects().length > 0)
    .map((el) => el.getBoundingClientRect()).filter((r) => r.width < 44 || r.height < 44).length);
  check('管理画面のボタンも 44px 以上', smallAdmin === 0, `${smallAdmin} 個`);
  await shot(page, 'reservation-375-light-admin.png');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'reservation-375-dark-admin.png');
  await page.click('#admin-rows tr [data-cancel]');
  await shot(page, 'reservation-375-dark-dialog.png', false); // ダイアログは画面の中央に出るので、見えている範囲だけ撮る
  await page.click('#cancel-keep');
  await page.emulateMedia({ colorScheme: 'light' });

  // 1280px の管理画面と確認画面（スクリーンショット用）
  await page.setViewportSize({ width: 1280, height: 900 });
  const tableFit = await page.$eval('#admin-table-wrap', (el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  check('1280px の一覧の表は枠の中に収まる（表の中の横スクロールなし）', tableFit.sw <= tableFit.cw, `${tableFit.sw} > ${tableFit.cw}`);
  await shot(page, 'reservation-1280-light-admin.png');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'reservation-1280-dark-admin.png');
  await page.emulateMedia({ colorScheme: 'light' });

  check('コンソールエラーなし（375px）', state.consoleErrors.length === 0, state.consoleErrors.join(' / '));
  check('外部への通信なし（375px）', state.external.length === 0, state.external.join(' '));
  check('読み込みエラー（4xx/5xx）なし（375px）', state.badResponses.length === 0, state.badResponses.join(' '));
  await context.close();
}

// ====================================================================== localStorage が使えないとき
async function noStorageFlow(browser) {
  console.log('開く: localStorage が使えないブラウザを想定');
  const { context, page, state } = await openPage(browser, { viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    const broken = {
      getItem() { throw new Error('blocked'); },
      setItem() { throw new Error('blocked'); },
      removeItem() { throw new Error('blocked'); },
    };
    Object.defineProperty(window, 'localStorage', { get() { return broken; } });
  });
  await page.goto(PAGE_URL, { waitUntil: 'load' });
  check('保存できないことを知らせる', !(await isHidden(page, '#storage-warning')));
  await page.click('label[for="slot-14"]');
  await fillForm(page, { name: 'デモ 花子', email: 'demo@example.com', people: '2' });
  await page.click('#reserve-form button[type="submit"]');
  await page.click('#confirm-booking');
  check('保存できなくても予約の流れは最後まで動く', (await text(page, '#done-number')) === 'R-20261001-01', await text(page, '#done-number'));
  check('コンソールエラーなし（保存できないとき）', state.consoleErrors.length === 0, state.consoleErrors.join(' / '));
  check('外部への通信なし（保存できないとき）', state.external.length === 0, state.external.join(' '));
  await context.close();
}

// ====================================================================== 時刻が進んだとき
async function clockFlow(browser) {
  console.log('開く: 13:59:30 から1分進める');
  const context = await browser.newContext({ timezoneId: TIMEZONE, locale: 'ja-JP', viewport: { width: 1280, height: 900 } });
  const state = { external: [], consoleErrors: [], badResponses: [] };
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (isLocal(url)) return route.continue();
    state.external.push(url);
    return route.abort();
  });
  await context.clock.install({ time: new Date('2026-10-01T13:59:30+09:00') });
  const page = await context.newPage();
  watchPage(page, state);
  await page.goto(PAGE_URL, { waitUntil: 'load' });
  check('13:59 には 14:00 の枠を選べる', (await page.getAttribute('label[for="slot-14"]', 'data-status')) === 'available');
  await page.click('label[for="slot-14"]');
  await page.clock.fastForward('01:00');
  await page.waitForTimeout(100);
  check('14:00 を過ぎると、ページを開いたままでも「受付終了」に変わる',
    (await page.getAttribute('label[for="slot-14"]', 'data-status')) === 'past' && (await page.isDisabled('#slot-14')));
  check('選んでいた枠が過ぎたら、選び直すよう知らせる', /選べなくなりました/.test(await text(page, '#err-slot')), await text(page, '#err-slot'));
  check('コンソールエラーなし（時刻が進んだとき）', state.consoleErrors.length === 0, state.consoleErrors.join(' / '));
  check('外部への通信なし（時刻が進んだとき）', state.external.length === 0, state.external.join(' '));
  await context.close();
}

async function main() {
  const browser = await chromium.launch();
  try {
    await desktopFlow(browser);
    await mobileFlow(browser);
    await noStorageFlow(browser);
    await clockFlow(browser);
  } catch (err) {
    failed++;
    console.log(`  NG テストの途中で止まった … ${err && err.stack ? err.stack.split('\n').slice(0, 3).join(' ') : err}`);
  } finally {
    await browser.close();
  }
  console.log(`合計: ${passed} 件成功 / ${failed} 件失敗`);
  if (failed > 0) process.exit(1);
}

main();
