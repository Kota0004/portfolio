// 実績紹介ページ（site/index.html）のブラウザのテスト。
//
// 使い方（リポジトリの一番上で）:
//   python3 -m http.server 8000 -d site &
//   node tests/e2e/site.e2e.js
//
// BASE_URL で開く先を変えられる（既定 http://localhost:8000）。
// SCREENSHOT_DIR を指定すると、375px / 1280px のライト・ダークのスクリーンショットをそこに保存する。
//
// demos/ の中身はほかのテストで確かめる。ここではリンク先が存在するかまでを見る。
'use strict';

const { chromium } = require('playwright');
const path = require('path');

const BASE_URL = (process.env.BASE_URL || 'http://localhost:8000').replace(/\/+$/, '') + '/';
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || '';

const MIZUMICHI_APP = 'https://kota0004.github.io/mizumichi/';
const MIZUMICHI_SRC = 'https://github.com/Kota0004/mizumichi';
const ROOMRADAR_URL = 'https://nu-roomradar.github.io/nust-room-search/';
const UNOFFICIAL = '大学非公式・テスト運用中';
const AI_SENTENCE = '制作には AI（Claude Code）を活用しています。動作の確認と最終チェックは自分で行います。';
const DISCLAIMER = '参考情報であり、通行できるかどうかを保証するものではありません';
const CONSULT = 'ご依頼・ご相談はココナラで受け付ける予定です（準備中）';

// 書いてはいけない語（持ち主の実名・学籍番号など）。
// このリポジトリは公開なので、語そのものもハッシュもここには置かない。
// 環境変数 PORTFOLIO_FORBIDDEN_WORDS（カンマ区切り）から読む。CI ではリポジトリの Secrets に入れる。
// 見つかったときも、語そのものはログに出さず「n 番目の語」とだけ書く。
const FORBIDDEN_WORDS = (process.env.PORTFOLIO_FORBIDDEN_WORDS || '')
  .split(',').map((w) => w.trim()).filter(Boolean);
function findForbidden(text) {
  const lower = text.toLowerCase();
  const hits = [];
  FORBIDDEN_WORDS.forEach((w, i) => { if (lower.includes(w.toLowerCase())) hits.push(`${i + 1} 番目の語`); });
  return hits;
}

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  OK ${name}`);
  } else {
    failed++;
    console.log(`  NG ${name}${detail ? ` … ${detail}` : ''}`);
  }
}

// 空白のちがい（改行・インデント）を無視して比べる
const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// このサイト自身（BASE_URL）と localhost だけを「内側」とみなす
const baseHost = new URL(BASE_URL).hostname;
function isLocal(url) {
  if (/^(data|blob|about):/.test(url)) return true;
  let u;
  try { u = new URL(url); } catch (e) { return false; }
  return ['localhost', '127.0.0.1', '[::1]', '::1', baseHost].includes(u.hostname);
}

async function openPage(browser, options) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const state = { external: [], consoleErrors: [], badResponses: [] };
  // 外へのリクエストは記録して止める（実際には通信しない）
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (isLocal(url)) return route.continue();
    state.external.push(url);
    return route.abort();
  });
  page.on('console', (msg) => { if (msg.type() === 'error') state.consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => state.consoleErrors.push(String(err)));
  page.on('response', (res) => { if (res.status() >= 400) state.badResponses.push(`${res.status()} ${res.url()}`); });
  return { context, page, state };
}

async function noHorizontalScroll(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth };
  });
}

async function main() {
  const browser = await chromium.launch();
  try {
    // ---------------------------------------------------------------- 375px（スマホ）
    console.log(`開く: ${BASE_URL}（幅 375px）`);
    const { context, page, state } = await openPage(browser, { viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
    const res = await page.goto(BASE_URL, { waitUntil: 'load' });
    check('ページが開ける（HTTP 200）', res && res.status() === 200, res ? `HTTP ${res.status()}` : '応答なし');

    // 元の HTML（スクリプトで書き換わる前）も確かめるために取っておく
    const rawHtml = res ? await res.text() : '';

    // ---- 文書の基本
    const head = await page.evaluate(() => ({
      lang: document.documentElement.getAttribute('lang'),
      charset: document.characterSet,
      metaCharset: !!document.querySelector('meta[charset]'),
      viewport: (document.querySelector('meta[name="viewport"]') || {}).content || '',
      title: document.title,
      description: (document.querySelector('meta[name="description"]') || {}).content || '',
    }));
    check('<html lang="ja">', head.lang === 'ja', `lang=${head.lang}`);
    check('文字コードが UTF-8（meta charset あり）', head.metaCharset && head.charset === 'UTF-8', head.charset);
    check('viewport の指定', /width=device-width/.test(head.viewport) && /initial-scale=1/.test(head.viewport), head.viewport);
    check('<title> が短く書かれている', head.title.length > 0 && head.title.length <= 40, head.title);
    check('<meta name="description"> がある', head.description.length > 0);

    // ---- 共通のヘッダーとフッター
    const chrome = await page.evaluate(() => {
      const brand = document.querySelector('header.site-header .brand');
      const nav = document.querySelector('header.site-header nav[aria-label="サイト内"]');
      const footer = document.querySelector('footer.site-footer');
      return {
        brandText: brand ? brand.textContent.trim() : null,
        brandHref: brand ? brand.getAttribute('href') : null,
        navHrefs: nav ? [...nav.querySelectorAll('a')].map((a) => a.getAttribute('href')) : [],
        navTexts: nav ? [...nav.querySelectorAll('a')].map((a) => a.textContent.trim()) : [],
        footerText: footer ? footer.textContent.replace(/\s+/g, ' ').trim() : '',
        footerLinks: footer ? [...footer.querySelectorAll('a')].map((a) => a.getAttribute('href')) : [],
      };
    });
    check('ヘッダーのロゴが「Kota0004」で ./ を指す', chrome.brandText === 'Kota0004' && chrome.brandHref === './', `${chrome.brandText} → ${chrome.brandHref}`);
    check('ヘッダーのナビが ./#works ./#demos ./#services',
      JSON.stringify(chrome.navHrefs) === JSON.stringify(['./#works', './#demos', './#services']), chrome.navHrefs.join(' '));
    check('ナビの文言が 制作実績 / デモ / できること',
      JSON.stringify(chrome.navTexts) === JSON.stringify(['制作実績', 'デモ', 'できること']), chrome.navTexts.join(' / '));
    check('フッターに「© 2026 Kota0004」と GitHub へのリンク',
      chrome.footerText.includes('© 2026 Kota0004') && chrome.footerLinks.includes('https://github.com/Kota0004'), chrome.footerText);

    // ---- ページ内リンク（#works #demos #services）
    for (const id of ['works', 'demos', 'services']) {
      const info = await page.evaluate((id) => ({
        target: !!document.getElementById(id),
        links: [...document.querySelectorAll('a[href]')].filter((a) => {
          const h = a.getAttribute('href');
          return h === `#${id}` || h === `./#${id}`;
        }).length,
      }), id);
      check(`#${id} のセクションがあり、そこへのリンクがある`, info.target && info.links > 0, `section=${info.target} links=${info.links}`);
    }
    // ナビのリンクを押すと、そのセクションに移動する
    await page.click('header.site-header nav a[href="./#services"]');
    await page.waitForFunction(() => location.hash === '#services');
    const servicesTop = await page.evaluate(() => document.getElementById('services').getBoundingClientRect().top);
    check('ナビの「できること」でセクションに移動する', Math.abs(servicesTop) < 120, `top=${Math.round(servicesTop)}`);
    await page.goto(BASE_URL, { waitUntil: 'load' });

    // ---- 自己紹介と AI 利用の一文
    const bodyText = squash(await page.evaluate(() => document.body.innerText));
    check('AI 利用の一文がある', bodyText.includes(AI_SENTENCE));
    check('自己紹介（企画から開発・運営まで）', bodyText.includes('企画から開発・運営まで手がけています'));

    // ---- 制作実績: みずみち
    const mizu = await page.evaluate(() => {
      const card = [...document.querySelectorAll('#works article')].find((a) => /みずみち/.test(a.querySelector('h3')?.textContent || ''));
      if (!card) return null;
      return { text: card.innerText, hrefs: [...card.querySelectorAll('a')].map((a) => a.getAttribute('href')) };
    });
    check('制作実績に「みずみち」のカードがある', !!mizu);
    if (mizu) {
      const t = squash(mizu.text);
      check('みずみち: アプリの URL が新しいもの', mizu.hrefs.includes(MIZUMICHI_APP), mizu.hrefs.join(' '));
      check('みずみち: ソースコードの URL', mizu.hrefs.includes(MIZUMICHI_SRC), mizu.hrefs.join(' '));
      check('みずみち: 免責の一文がある', t.includes(DISCLAIMER));
      check('みずみち: 827 か所・581 か所・2,700 通り・1都6県が書かれている',
        t.includes('827 か所') && t.includes('581 か所') && t.includes('2,700 通り') && t.includes('1都6県'));
    }

    // ---- 制作実績: RoomRadar
    const rr = await page.evaluate((UNOFFICIAL) => {
      const card = [...document.querySelectorAll('#works article')].find((a) => /RoomRadar/.test(a.querySelector('h3')?.textContent || ''));
      if (!card) return null;
      const badge = [...card.querySelectorAll('.badge')].find((b) => b.textContent.includes(UNOFFICIAL));
      const clone = card.cloneNode(true);
      clone.querySelectorAll('.badge').forEach((b) => b.remove());
      const r = badge ? badge.getBoundingClientRect() : null;
      const h = card.querySelector('h3').getBoundingClientRect();
      return {
        text: card.innerText,
        hrefs: [...card.querySelectorAll('a')].map((a) => a.getAttribute('href')),
        badgeVisible: !!(r && r.width > 0 && r.height > 0 && getComputedStyle(badge).visibility !== 'hidden'),
        badgeNearTitle: !!(r && r.top - h.bottom < 60),
        bodyHasUnofficial: clone.textContent.includes(UNOFFICIAL),
      };
    }, UNOFFICIAL);
    check('制作実績に「RoomRadar」のカードがある', !!rr);
    if (rr) {
      check('RoomRadar: 見出しのそばに「大学非公式・テスト運用中」のバッジが見えている', rr.badgeVisible && rr.badgeNearTitle);
      check('RoomRadar: 本文にも「大学非公式・テスト運用中」がある', rr.bodyHasUnofficial);
      check('RoomRadar: 大学公式ではないと書いている', squash(rr.text).includes('大学公式のサービスではありません'));
      check('RoomRadar: サービスの URL', rr.hrefs.includes(ROOMRADAR_URL), rr.hrefs.join(' '));
    }

    // ---- デモ作品
    const demos = await page.evaluate(() => {
      const sec = document.getElementById('demos');
      return sec ? { text: sec.innerText, hrefs: [...sec.querySelectorAll('a')].map((a) => a.getAttribute('href')) } : null;
    });
    check('デモ: 予約フォームへのリンク（demos/reservation/）', !!demos && demos.hrefs.includes('demos/reservation/'));
    check('デモ: CSV 集計ツールへのリンク（demos/csv/）', !!demos && demos.hrefs.includes('demos/csv/'));
    check('デモ: 架空のデータで動き、外部に送られないと書いている',
      !!demos && squash(demos.text).includes('架空のデータ') && squash(demos.text).includes('外部に送られません'));
    // フォルダだけあって index.html が無いと、手元のサーバは一覧を返すが GitHub Pages では 404 になる。
    // そのため index.html を直接取りに行く。
    for (const p of ['demos/reservation/', 'demos/csv/']) {
      const r = await page.request.get(new URL(p + 'index.html', BASE_URL).href);
      const ok = r.status() === 200 && /<title>/i.test(await r.text());
      check(`リンク先 ${p} のページ（index.html）が存在する`, ok, `HTTP ${r.status()}`);
    }

    // ---- できること
    const services = squash(await page.evaluate(() => document.getElementById('services')?.innerText || ''));
    check('できること: A・B・C の3つが書かれている',
      services.includes('予約・申込フォームなど小さな Web ツール') &&
      services.includes('Excel・スプレッドシートの作業の自動化') &&
      services.includes('サークル・学生団体の出欠・予約ページ'));
    check('できること: ココナラ（準備中）の案内', services.includes(CONSULT));
    check('価格を書いていない（〜円 が無い）', !/[0-9０-９][0-9０-９,，]*\s*円/.test(bodyText));

    // ---- 書いてはいけないもの（元の HTML とページの文字の両方で見る）
    const haystack = rawHtml + '\n' + bodyText;
    if (FORBIDDEN_WORDS.length) {
      const hits = findForbidden(haystack);
      check(`個人情報の語（${FORBIDDEN_WORDS.length} 語）が無い`, hits.length === 0, hits.join('、'));
    } else {
      check('個人情報の語の照合（PORTFOLIO_FORBIDDEN_WORDS が未設定のため省略）', true);
    }
    check('メールアドレスらしき文字列が無い', !/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/.test(haystack) && !/mailto:/i.test(haystack));
    check('学生であること・学年が書かれていない', !/学生です|大学生|学年|年生|学籍/.test(bodyText));
    const uniOutside = await page.evaluate(() => {
      const clone = document.body.cloneNode(true);
      const rrCard = [...clone.querySelectorAll('#works article')].find((a) => /RoomRadar/.test(a.querySelector('h3')?.textContent || ''));
      if (rrCard) rrCard.remove();
      return /大学(?!非公式|公式|が公開)|学部|学科/.test(clone.textContent.replace(/大学非公式|大学公式/g, ''));
    });
    check('大学名・学部・学科は RoomRadar の説明の中だけ', !uniOutside);
    check('元の HTML に外部のスクリプト・スタイルの読み込みが無い',
      !/<script[^>]+src=["']?(https?:)?\/\//i.test(rawHtml) && !/<link[^>]+href=["']?(https?:)?\/\//i.test(rawHtml) && !/@import/i.test(rawHtml));

    // ---- 375px での見え方と押しやすさ
    const sw = await noHorizontalScroll(page);
    check('幅 375px で横スクロールが出ない', sw.scrollWidth <= sw.clientWidth, `scrollWidth=${sw.scrollWidth} clientWidth=${sw.clientWidth}`);
    const small = await page.evaluate(() => [...document.querySelectorAll('header a, footer a, a.btn, button')]
      .map((el) => ({ label: (el.textContent || '').trim().slice(0, 20), h: el.getBoundingClientRect().height }))
      .filter((x) => x.h < 44));
    check('ヘッダー・フッターのリンクとボタンが高さ 44px 以上', small.length === 0, small.map((x) => `${x.label}(${Math.round(x.h)}px)`).join(', '));

    // ---- キーボードだけで操作できる
    await page.goto(BASE_URL, { waitUntil: 'load' });
    const order = [];
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      const f = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        return { href: el.getAttribute('href'), outline: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 };
      });
      if (f) order.push(f);
    }
    const hrefs = order.map((f) => f.href);
    check('Tab で最初にロゴ、次にナビへ進む', hrefs[0] === './' && hrefs[1] === './#works', hrefs.slice(0, 3).join(' '));
    const mustReach = [MIZUMICHI_APP, MIZUMICHI_SRC, ROOMRADAR_URL, 'demos/reservation/', 'demos/csv/', 'https://github.com/Kota0004'];
    const missing = mustReach.filter((h) => !hrefs.includes(h));
    check('Tab だけで主なリンクすべてにたどり着ける', missing.length === 0, missing.join(' '));
    check('フォーカスが枠線で見える', order.length > 0 && order.every((f) => f.outline), `${order.filter((f) => !f.outline).length} 件で枠線なし`);

    if (SCREENSHOT_DIR) {
      await page.goto(BASE_URL, { waitUntil: 'load' });
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'site-375-light.png'), fullPage: true });
    }

    // ---- ダーク表示（375px）
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(BASE_URL, { waitUntil: 'load' });
    const dark = await page.evaluate(() => ({
      bg: getComputedStyle(document.body).backgroundColor,
      fg: getComputedStyle(document.body).color,
    }));
    check('ダーク表示で背景が暗くなる', dark.bg !== 'rgb(246, 247, 249)' && dark.bg !== 'rgb(255, 255, 255)', dark.bg);
    const swDark = await noHorizontalScroll(page);
    check('ダーク表示・幅 375px でも横スクロールが出ない', swDark.scrollWidth <= swDark.clientWidth);
    if (SCREENSHOT_DIR) await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'site-375-dark.png'), fullPage: true });

    check('375px: コンソールエラーが無い', state.consoleErrors.length === 0, state.consoleErrors.join(' | '));
    check('375px: localhost 以外への通信が無い', state.external.length === 0, state.external.join(' '));
    check('375px: 読み込みに失敗したファイルが無い', state.badResponses.length === 0, state.badResponses.join(' '));
    await context.close();

    // ---------------------------------------------------------------- 1280px（パソコン）・320px
    for (const width of [1280, 320]) {
      console.log(`開く: ${BASE_URL}（幅 ${width}px）`);
      const w = await openPage(browser, { viewport: { width, height: 900 } });
      for (const scheme of ['light', 'dark']) {
        await w.page.emulateMedia({ colorScheme: scheme });
        await w.page.goto(BASE_URL, { waitUntil: 'load' });
        const s = await noHorizontalScroll(w.page);
        check(`${width}px・${scheme === 'light' ? 'ライト' : 'ダーク'}: 横スクロールが出ない`, s.scrollWidth <= s.clientWidth, `scrollWidth=${s.scrollWidth}`);
        if (SCREENSHOT_DIR && width === 1280) {
          await w.page.screenshot({ path: path.join(SCREENSHOT_DIR, `site-1280-${scheme}.png`), fullPage: true });
        }
      }
      check(`${width}px: コンソールエラーが無い`, w.state.consoleErrors.length === 0, w.state.consoleErrors.join(' | '));
      check(`${width}px: localhost 以外への通信が無い`, w.state.external.length === 0, w.state.external.join(' '));
      await w.context.close();
    }

    // ---------------------------------------------------------------- Enter でリンクをたどる
    // 移動先（demos/）の中身はほかのテストの担当なので、ここでは移動できたかだけを見る。
    const k = await openPage(browser, { viewport: { width: 375, height: 812 } });
    await k.page.goto(BASE_URL, { waitUntil: 'load' });
    await k.page.focus('a[href="demos/csv/"]');
    await Promise.all([k.page.waitForURL(/demos\/csv\/$/), k.page.keyboard.press('Enter')]);
    check('Enter キーでデモのページに移動できる', /demos\/csv\/$/.test(k.page.url()), k.page.url());
    await k.context.close();
  } finally {
    await browser.close();
  }
}

main()
  .catch((err) => {
    failed++;
    console.log(`  NG テストの途中で止まった … ${err && err.stack ? err.stack : err}`);
  })
  .finally(() => {
    console.log(`合計: ${passed} 件成功 / ${failed} 件失敗`);
    if (failed > 0) process.exitCode = 1;
  });
