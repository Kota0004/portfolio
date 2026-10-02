// CSV 集計ツールの計算部分（site/demos/csv/csv-core.js）の単体テスト。
// 実行: node --test tests/unit/*.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const C = require('../../site/demos/csv/csv-core.js');

const SAMPLE_PATH = path.join(__dirname, '../../site/demos/csv/sample.csv');

// Node の TextDecoder が Shift_JIS を読めるか（ICU 入りの Node なら読める）
let HAS_SJIS = true;
try { new TextDecoder('shift_jis'); } catch (e) { HAS_SJIS = false; }

function bytes(hex) { return new Uint8Array(Buffer.from(hex, 'hex')); }
function utf8(s) { return new Uint8Array(Buffer.from(s, 'utf8')); }
function table(text) { return C.parseCSV(text); }
// 小数は有効数字 15 桁で丸めているので、ほぼ等しいかで比べる
function near(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) <= Math.abs(expected) * 1e-12, `${message || ''} ${actual} ≒ ${expected}`);
}

// ====================================================================== parseCSV

test('parseCSV: 見出しと値を読む', () => {
  const t = table('日付,店舗,金額\n2026/9/1,東店,100\n2026/9/2,西店,200\n');
  assert.deepEqual(t.headers, ['日付', '店舗', '金額']);
  assert.deepEqual(t.rows, [['2026/9/1', '東店', '100'], ['2026/9/2', '西店', '200']]);
  assert.deepEqual(t.rowLines, [2, 3]);
});

test('parseCSV: 引用符で囲んだ値の中のカンマ・改行・"" のエスケープ', () => {
  const text = 'a,b,c\r\n"1,200","前の行\r\n次の行","彼は""はい""と言った"\r\nx,"",y\r\n';
  const t = table(text);
  assert.deepEqual(t.rows[0], ['1,200', '前の行\r\n次の行', '彼は"はい"と言った']);
  assert.deepEqual(t.rows[1], ['x', '', 'y']);
  // 2 件目のレコードは、値の中の改行のぶん 1 行ずれた 4 行目から始まる
  assert.deepEqual(t.rowLines, [2, 4]);
});

test('parseCSV: CRLF・LF・CR が混ざっていても同じ結果になる', () => {
  const lf = table('a,b\n1,2\n3,4\n');
  const crlf = table('a,b\r\n1,2\r\n3,4\r\n');
  const cr = table('a,b\r1,2\r3,4\r');
  const mixed = table('a,b\r\n1,2\n3,4\r');
  for (const t of [crlf, cr, mixed]) {
    assert.deepEqual(t.headers, lf.headers);
    assert.deepEqual(t.rows, lf.rows);
  }
});

test('parseCSV: 最後の改行はあってもなくても同じ', () => {
  const withNl = table('a,b\n1,2\n');
  const without = table('a,b\n1,2');
  assert.deepEqual(without.rows, withNl.rows);
  assert.deepEqual(without.rows, [['1', '2']]);
  // 最後の値が空でも 1 つの値として数える
  assert.deepEqual(table('a,b\n1,').rows, [['1', '']]);
  // 引用符で終わるファイル
  assert.deepEqual(table('a,b\n1,"x"').rows, [['1', 'x']]);
});

test('parseCSV: 空行とカンマだけの行は読み飛ばし、その数を数える', () => {
  const t = table('a,b\n\n1,2\n,\n\r\n3,4\n\n');
  assert.deepEqual(t.rows, [['1', '2'], ['3', '4']]);
  assert.equal(t.warnings.blankLines, 4);
  assert.deepEqual(t.rowLines, [3, 6]);
});

test('parseCSV: 列の数が足りない行は空欄で埋め、多い行は切り捨てて、件数と行番号を残す', () => {
  const t = table('a,b,c\n1,2,3\n4,5\n6,7,8,9\n10\n11,12,13\n');
  assert.deepEqual(t.rows, [['1', '2', '3'], ['4', '5', ''], ['6', '7', '8'], ['10', '', ''], ['11', '12', '13']]);
  assert.equal(t.warnings.shortRows, 2);
  assert.deepEqual(t.warnings.shortRowLines, [3, 5]);
  assert.equal(t.warnings.longRows, 1);
  assert.deepEqual(t.warnings.longRowLines, [4]);
});

test('parseCSV: 文字列の先頭の BOM を取り除く', () => {
  const t = table('\uFEFF日付,金額\n2026/9/1,100\n');
  assert.equal(t.headers[0], '日付');
});

test('parseCSV: 閉じていない引用符と、引用符のあとの余分な文字を知らせる', () => {
  const open = table('a,b\n1,"abc\n');
  assert.equal(open.warnings.unclosedQuote, true);
  assert.deepEqual(open.rows, [['1', 'abc\n']]);
  const stray = table('a,b\n"ab"cd,2\n');
  assert.equal(stray.warnings.strayQuotes, 1);
  assert.deepEqual(stray.rows, [['abcd', '2']]);
});

test('parseCSV: 空や重複した見出しに名前をつける', () => {
  const t = table(' 店舗 ,,店舗\n1,2,3\n');
  assert.deepEqual(t.headers, ['店舗', '列2', '店舗 (2)']);
  assert.equal(t.warnings.renamedHeaders, 2);
});

test('parseCSV: 空の文字列', () => {
  const t = table('');
  assert.deepEqual(t.headers, []);
  assert.deepEqual(t.rows, []);
});

test('parseCSV: header:false ならレコードをそのまま返す', () => {
  const r = C.parseCSV('a,b\n1,2\n', { header: false });
  assert.deepEqual(r.records, [['a', 'b'], ['1', '2']]);
});

// ====================================================================== decode

test('decode: UTF-8（BOM なし）', () => {
  const d = C.decode(utf8('日付,店舗\n2026/9/1,東店\n'));
  assert.equal(d.encoding, 'utf-8');
  assert.equal(d.label, 'UTF-8');
  assert.equal(d.text, '日付,店舗\n2026/9/1,東店\n');
});

test('decode: UTF-8（BOM あり）は BOM を取り除く', () => {
  const src = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('日付,店舗\n', 'utf8')]);
  const d = C.decode(new Uint8Array(src));
  assert.equal(d.encoding, 'utf-8-bom');
  assert.equal(d.label, 'UTF-8（BOM あり）');
  assert.equal(d.text, '日付,店舗\n');
  // ArrayBuffer を渡してもよい
  assert.equal(C.decode(src.buffer.slice(src.byteOffset, src.byteOffset + src.length)).encoding, 'utf-8-bom');
});

test('decode: UTF-16（BOM あり、LE と BE）を読む', () => {
  const le = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('日付\t店舗\n', 'utf16le')]);
  const d = C.decode(new Uint8Array(le));
  assert.equal(d.encoding, 'utf-16le');
  assert.equal(d.label, 'UTF-16');
  assert.equal(d.text, '日付\t店舗\n');
  // BE はバイトの順を入れかえて作る
  const body = Buffer.from('店舗,金額\n', 'utf16le');
  for (let i = 0; i + 1 < body.length; i += 2) { const t = body[i]; body[i] = body[i + 1]; body[i + 1] = t; }
  const be = C.decode(new Uint8Array(Buffer.concat([Buffer.from([0xFE, 0xFF]), body])));
  assert.equal(be.encoding, 'utf-16be');
  assert.equal(be.text, '店舗,金額\n');
});

test('decode: 英数字だけのファイルは UTF-8 として読む', () => {
  assert.equal(C.decode(utf8('a,b\n1,2\n')).encoding, 'utf-8');
});

test('decode: Shift_JIS（手で用意したバイト列）', { skip: !HAS_SJIS && 'この Node は Shift_JIS を読めない' }, () => {
  // "日付,店舗,売上金額\r\n2026/9/1,東店,"1,200"\r\n" を Shift_JIS にしたもの
  const d = C.decode(bytes('93fa95742c935895dc2c94848fe38be08a7a0d0a323032362f392f312c938c93582c22312c323030220d0a'));
  assert.equal(d.encoding, 'shift_jis');
  assert.equal(d.label, 'Shift_JIS');
  assert.equal(d.text, '日付,店舗,売上金額\r\n2026/9/1,東店,"1,200"\r\n');
  assert.equal(d.replaced, 0);
  const t = C.parseCSV(d.text);
  assert.deepEqual(t.rows, [['2026/9/1', '東店', '1,200']]);
});

test('decode: Shift_JIS の「ソ」「表」（2 バイト目が 0x5C）と、円記号の 0x5C', { skip: !HAS_SJIS && 'この Node は Shift_JIS を読めない' }, () => {
  // '店舗,商品,金額\r\n東店,ソフトクリーム,"\1,200"\r\n西店,表示用の見本,800\r\n'
  const hex = '935895dc2c8fa495692c8be08a7a0d0a938c93582c835c83748367834e838a815b83802c225c312c323030220d0a' +
    '90bc93582c955c8ea6977082cc8ca9967b2c3830300d0a';
  const d = C.decode(bytes(hex));
  assert.equal(d.encoding, 'shift_jis');
  const t = C.parseCSV(d.text);
  assert.deepEqual(t.headers, ['店舗', '商品', '金額']);
  assert.equal(t.rows[0][1], 'ソフトクリーム');
  assert.equal(t.rows[1][1], '表示用の見本');
  // Excel で ¥ と表示される 0x5C は "\" として読まれる。数値としては円記号として扱う
  assert.equal(C.parseNumber(t.rows[0][2]), 1200);
  const agg = C.aggregate(t, { groupBy: 0, valueCol: 2, method: 'sum' });
  assert.equal(agg.total.value, 2000);
});

test('looksLikeZip: .xlsx（ZIP）の先頭バイトを見分ける', () => {
  assert.equal(C.looksLikeZip(new Uint8Array([0x50, 0x4B, 0x03, 0x04, 0x14])), true);
  assert.equal(C.looksLikeZip(utf8('a,b\n')), false);
});

// ====================================================================== parseNumber

test('parseNumber: いろいろな書き方の数値', () => {
  const cases = [
    ['1234', 1234], ['1,234', 1234], ['1,234,567', 1234567], ['1,234.5', 1234.5], ['0.25', 0.25], ['.5', 0.5],
    ['¥1,234', 1234], ['￥1,234', 1234], ['\\1,234', 1234], ['1234円', 1234], ['¥1,234円', 1234], ['1,234 円', 1234],
    ['  1234  ', 1234], ['\u30001234\u3000', 1234], ['１２３４', 1234], ['１，２３４', 1234], ['１２．５', 12.5],
    ['-500', -500], ['\u2212500', -500], ['－500', -500], ['▲500', -500], ['△500', -500], ['▲ 1,200', -1200],
    ['(500)', -500], ['-¥500', -500], ['¥-500', -500], ['+12', 12], ['0', 0], ['-0', 0]
  ];
  for (const [input, expected] of cases) {
    assert.equal(C.parseNumber(input), expected, `"${input}" → ${expected}`);
  }
  assert.ok(Object.is(C.parseNumber('-0'), 0), '-0 は 0 にする');
});

test('parseNumber: 読めない値は null（0 にしない）', () => {
  const bad = ['', '   ', 'abc', '未集計', '-', '▲', '¥', '円', '1,2', '12,34', '1,2345', '1.2.3', '1 234', '12-3', '1e3', '--5', '▲-5', '5%', 'NaN', 'Infinity', '1.'];
  for (const input of bad) {
    assert.equal(C.parseNumber(input), null, `"${input}" は読めない値`);
  }
  assert.equal(C.parseNumber(null), null);
  assert.equal(C.parseNumber(undefined), null);
  assert.equal(C.parseNumber(42), 42);
  assert.equal(C.parseNumber(NaN), null);
});

// ====================================================================== parseDate

test('parseDate: 日付の各形式', () => {
  const sep = { year: 2026, month: 9, day: 1 };
  for (const s of ['2026/09/01', '2026-09-01', '2026/9/1', '2026-9-1', '2026.9.1', '2026年9月1日', '2026 年 9 月 1 日',
    '２０２６／９／１', '2026/9/1 10:30', '2026-09-01T10:30:00', '2026/09/01 9:05:30', ' 2026/9/1 ']) {
    assert.deepEqual(C.parseDate(s), sep, s);
  }
  assert.deepEqual(C.parseDate('2028/2/29'), { year: 2028, month: 2, day: 29 }); // うるう年
});

test('parseDate: 読めない日付は null', () => {
  for (const s of ['', 'abc', '2026/13/01', '2026/0/10', '2026/02/30', '2026/2/29', '2026/9/31', '2026/09-01', '26/9/1', '2026/9', '9/1/2026', '20260901', '2026/9/1 25時']) {
    assert.equal(C.parseDate(s), null, s);
  }
});

// ====================================================================== inferTypes

test('数値が一部だけの列（読めない値が2割を超える）も、読める値だけで集計できる', () => {
  const lines = ['店舗,金額'];
  for (let i = 0; i < 40; i++) lines.push(`${i % 2 ? '東店' : '西店'},${i % 4 === 0 ? '未集計' : '100'}`);
  const t = table(lines.join('\n') + '\n');
  const info = C.inferTypes(t.headers, t.rows)[1];
  assert.equal(info.type, 'text', '読めない値が2割5分あるので「数値の列」とは判定しない');
  assert.equal(info.numbers, 30, 'それでも数値の数は数えている（画面はこれを見て「一部が数値」として選ばせる）');
  const a = C.aggregate(t, { groupBy: 0, valueCol: 1, method: 'sum' });
  assert.equal(a.total.value, 3000);
  assert.equal(a.skipped.invalidValues, 10);
});

test('inferTypes: 数値・日付・文字の列を見分ける（読めない値が少し混ざっていても）', () => {
  const t = table([
    '日付,店舗,数量,金額,メモ,空',
    '2026/9/1,東店,1,"1,200",あ,',
    '2026-09-02,西店,2,¥800,い,',
    '2026/9/3,東店,3,未集計,,',
    '2026/9/4,西店,4,500円,う,',
    '2026/9/5,東店,5,▲100,え,'
  ].join('\n'));
  const types = C.inferTypes(t.headers, t.rows).map((x) => x.type);
  assert.deepEqual(types, ['date', 'text', 'number', 'number', 'text', 'text']);
  // 半分しか数値でない列は文字の列
  const mixed = table('x\n1\na\n2\nb\n');
  assert.equal(C.inferTypes(mixed.headers, mixed.rows)[0].type, 'text');
});

// ====================================================================== aggregate

const SALES = [
  '日付,店舗,商品,数量,金額',
  '2026/7/1,東店,パン,2,"1,000"',
  '2026-07-15,西店,パン,1,¥500',
  '2026/7/20,東店,牛乳,3,300円',
  '2026/08/02,東店,パン,1,未集計',
  '2026/8/9,西店,牛乳,4,',
  '2026/8/31,西店,パン,2,▲200',
  '2026/9/1,東店,牛乳,5,"2,500"'
].join('\r\n') + '\r\n';

test('aggregate: 合計（読めない値と空欄は外し、件数を数える）', () => {
  const t = table(SALES);
  const a = C.aggregate(t, { groupBy: 1, valueCol: 4, method: 'sum' });
  assert.deepEqual(a.groups.map((g) => [g.label, g.value, g.n, g.rows]), [
    ['東店', 1000 + 300 + 2500, 3, 4],
    ['西店', 500 - 200, 2, 3]
  ]);
  assert.equal(a.total.value, 4100);
  assert.equal(a.total.n, 5);
  assert.equal(a.skipped.invalidValues, 1);
  assert.deepEqual(a.skipped.invalidExamples, [{ value: '未集計', line: 5 }]);
  assert.equal(a.skipped.blankValues, 1);
  assert.equal(a.usedRows, 7);
  assert.equal(a.totalRows, 7);
});

test('aggregate: 平均は読めた値だけで割る（全体の平均は平均の平均ではない）', () => {
  const t = table(SALES);
  const a = C.aggregate(t, { groupBy: 1, valueCol: 4, method: 'avg' });
  near(a.groups[0].value, 3800 / 3);
  assert.equal(a.groups[1].value, 150);
  assert.equal(a.total.value, 4100 / 5);
  assert.notEqual(a.total.value, (3800 / 3 + 150) / 2);
});

test('aggregate: 件数・最大・最小', () => {
  const t = table(SALES);
  const count = C.aggregate(t, { groupBy: 2, method: 'count' });
  assert.deepEqual(count.groups.map((g) => [g.label, g.value]), [['パン', 4], ['牛乳', 3]]);
  assert.equal(count.total.value, 7);
  assert.equal(count.skipped.invalidValues, 0, '件数のときは値を読まない');
  const max = C.aggregate(t, { groupBy: 1, valueCol: 4, method: 'max' });
  assert.deepEqual(max.groups.map((g) => g.value), [2500, 500]);
  assert.equal(max.total.value, 2500);
  const min = C.aggregate(t, { groupBy: 1, valueCol: 4, method: 'min' });
  assert.deepEqual(min.groups.map((g) => g.value), [300, -200]);
  assert.equal(min.total.value, -200);
});

test('aggregate: 月ごと（書き方の違う日付も同じ月にまとめ、古い順に並べる）', () => {
  const t = table(SALES);
  const a = C.aggregate(t, { groupBy: 0, valueCol: 4, method: 'sum', dateUnit: 'month' });
  assert.deepEqual(a.groups.map((g) => [g.key, g.label, g.value, g.rows]), [
    ['2026-07', '2026年7月', 1800, 3],
    ['2026-08', '2026年8月', -200, 3],
    ['2026-09', '2026年9月', 2500, 1]
  ]);
});

test('aggregate: 日ごと（2026/9/1 と 2026-09-01 は同じ日）', () => {
  const t = table('日付,金額\n2026/9/2,1\n2026/9/1,2\n2026-09-01,3\n2026/09/02,4\n2026年9月1日,5\n');
  const a = C.aggregate(t, { groupBy: 0, valueCol: 1, method: 'sum', dateUnit: 'day' });
  assert.deepEqual(a.groups.map((g) => [g.label, g.value]), [['2026/09/01', 10], ['2026/09/02', 5]]);
});

test('aggregate: 日付として読めない行は外して、件数と例を残す', () => {
  const t = table('日付,金額\n2026/9/1,1\n不明,2\n,3\n2026/2/30,4\n');
  const a = C.aggregate(t, { groupBy: 0, valueCol: 1, method: 'sum', dateUnit: 'month' });
  assert.equal(a.total.value, 1);
  assert.equal(a.skipped.badGroups, 3);
  assert.deepEqual(a.skipped.badGroupExamples.map((e) => [e.value, e.line]), [['不明', 3], ['', 4], ['2026/2/30', 5]]);
  assert.equal(a.usedRows, 1);
});

test('aggregate: 空欄のグループは「（空欄）」にまとめ、前後の空白は無視する', () => {
  const t = table('店舗,金額\n東店,1\n,2\n 東店 ,3\n');
  const a = C.aggregate(t, { groupBy: 0, valueCol: 1, method: 'sum' });
  assert.deepEqual(a.groups.map((g) => [g.label, g.value]), [['東店', 4], ['（空欄）', 2]]);
});

test('aggregate: 値が 1 つも読めないグループは null（0 にしない）', () => {
  const t = table('店舗,金額\n東店,abc\n西店,1\n');
  const a = C.aggregate(t, { groupBy: 0, valueCol: 1, method: 'sum' });
  assert.equal(a.groups[0].value, null);
  assert.equal(a.groups[0].rows, 1);
  assert.equal(C.aggregate(t, { groupBy: 0, valueCol: 1, method: 'avg' }).groups[0].value, null);
});

test('aggregate: 小数の足し算の誤差を丸める', () => {
  const t = table('g,v\na,0.1\na,0.2\n');
  assert.equal(C.aggregate(t, { groupBy: 0, valueCol: 1, method: 'sum' }).groups[0].value, 0.3);
});

test('aggregate: 列の指定が正しくないときはエラー', () => {
  const t = table(SALES);
  assert.throws(() => C.aggregate(t, { valueCol: 4, method: 'sum' }), /グループにする列/);
  assert.throws(() => C.aggregate(t, { groupBy: 1, method: 'sum' }), /集計する列/);
  assert.throws(() => C.aggregate(t, { groupBy: 1, valueCol: 4, method: 'median' }), /集計のしかた/);
});

// ====================================================================== pivot

test('pivot: 店舗 × 商品の合計と、行・列・全体の合計', () => {
  const t = table(SALES);
  const p = C.pivot(t, { rowBy: 1, colBy: 2, valueCol: 4, method: 'sum' });
  assert.deepEqual(p.rowGroups.map((g) => g.label), ['東店', '西店']);
  assert.deepEqual(p.colGroups.map((g) => g.label), ['パン', '牛乳']);
  // 東店のパンは 1000 と「未集計」→ 1000。西店の牛乳は空欄だけ → 値なし（null）
  assert.deepEqual(p.cells.map((r) => r.map((c) => (c ? c.value : 'なし'))), [[1000, 2800], [300, null]]);
  assert.equal(p.cells[1][1].rows, 1);
  assert.deepEqual(p.rowTotals.map((x) => x.value), [3800, 300]);
  assert.deepEqual(p.colTotals.map((x) => x.value), [1300, 2800]);
  assert.equal(p.total.value, 4100);
});

test('pivot: 組み合わせの無いセルは null、平均の合計欄は元の値から計算する', () => {
  const t = table('店舗,商品,金額\n東店,パン,100\n東店,パン,300\n西店,牛乳,50\n東店,牛乳,10\n');
  const p = C.pivot(t, { rowBy: 0, colBy: 1, valueCol: 2, method: 'avg' });
  assert.equal(p.cells[0][0].value, 200);
  assert.equal(p.cells[1][0], null, '西店のパンは行が無い');
  near(p.rowTotals[0].value, (100 + 300 + 10) / 3);
  assert.equal(p.colTotals[1].value, 30);
  assert.equal(p.total.value, 460 / 4);
  const count = C.pivot(t, { rowBy: 0, colBy: 1, method: 'count' });
  assert.deepEqual(count.cells.map((r) => r.map((c) => (c ? c.value : null))), [[2, 1], [null, 1]]);
  assert.equal(count.total.value, 4);
});

test('pivot: 列を月ごとにまとめる', () => {
  const t = table(SALES);
  const p = C.pivot(t, { rowBy: 1, colBy: 0, valueCol: 4, method: 'sum', colDateUnit: 'month' });
  assert.deepEqual(p.colGroups.map((g) => g.label), ['2026年7月', '2026年8月', '2026年9月']);
  assert.deepEqual(p.cells[0].map((c) => (c ? c.value : null)), [1300, null, 2500]);
  assert.deepEqual(p.cells[1].map((c) => (c ? c.value : null)), [500, -200, null]);
  assert.throws(() => C.pivot(t, { rowBy: 1, colBy: 1, valueCol: 4, method: 'sum' }), /別の列/);
});

// ====================================================================== toCSV

test('toCSV: 値のエスケープ・数値・空欄・改行コード', () => {
  const csv = C.toCSV([
    ['名前', '金額', 'メモ'],
    ['東店', 1200, 'a,b'],
    ['西"店"', -0.5, '1行目\n2行目'],
    [' 空白あり', null, '']
  ]);
  assert.equal(csv, '名前,金額,メモ\r\n東店,1200,"a,b"\r\n"西""店""",-0.5,"1行目\n2行目"\r\n" 空白あり",,\r\n');
  assert.equal(C.toCSV([['a']], { bom: true }), '\uFEFFa\r\n');
  assert.equal(C.toCSV([[0.1 + 0.2]]), '0.3\r\n');
});

test('toCSV: guardFormulas で数式になりそうな文字の値を守る（ただの数は守らない）', () => {
  const csv = C.toCSV([['=1+2', '+81', '@a', '-500', '-x', 'ok', -5]], { guardFormulas: true });
  assert.equal(csv, "'=1+2,+81,'@a,-500,'-x,ok,-5\r\n");
});

test('toCSV → parseCSV で元に戻る（往復）', () => {
  const headers = ['店舗', '備考', '金額', '記号'];
  const rows = [
    ['東店', 'カンマ, を含む', '1,200', '"引用符"'],
    ['西店', '改行を\r\n含む', '', 'a""b'],
    ['南店', '改行を\n含む（LF）', '-5', ','],
    ['北店', '', ' 前後に空白 ', '"'],
    ['', '先頭が空', '0', '\r']
  ];
  const text = C.toCSV([headers].concat(rows));
  const back = C.parseCSV(text);
  assert.deepEqual(back.headers, headers);
  assert.deepEqual(back.rows, rows);
  assert.equal(back.warnings.shortRows + back.warnings.longRows, 0);
  // BOM つきでも、decode してから読めば元に戻る
  const withBom = C.toCSV([headers].concat(rows), { bom: true });
  const decoded = C.decode(new Uint8Array(Buffer.from(withBom, 'utf8')));
  assert.equal(decoded.encoding, 'utf-8-bom');
  assert.deepEqual(C.parseCSV(decoded.text).rows, rows);
});

// ====================================================================== サンプルと速さ

test('sample.csv: 架空の 3 店舗 × 3 か月、100 行で、わざと混ぜた書き方を含む', () => {
  const d = C.decode(fs.readFileSync(SAMPLE_PATH));
  assert.equal(d.encoding, 'utf-8');
  const t = C.parseCSV(d.text);
  assert.deepEqual(t.headers, ['日付', '店舗', '商品', '数量', '売上金額', '備考']);
  assert.equal(t.rows.length, 100);
  assert.equal(t.warnings.shortRows + t.warnings.longRows + t.warnings.blankLines, 0);
  const types = C.inferTypes(t.headers, t.rows).map((x) => x.type);
  assert.deepEqual(types, ['date', 'text', 'text', 'number', 'number', 'text']);
  const stores = C.aggregate(t, { groupBy: 1, method: 'count' });
  assert.equal(stores.groups.length, 3);
  const months = C.aggregate(t, { groupBy: 0, valueCol: 4, method: 'sum', dateUnit: 'month' });
  assert.deepEqual(months.groups.map((g) => g.label), ['2026年7月', '2026年8月', '2026年9月']);
  assert.equal(months.skipped.invalidValues, 1);
  assert.equal(months.skipped.blankValues, 1);
  assert.ok(/"\d{1,3},\d{3}"/.test(d.text), '桁区切りつき・引用符つきの金額がある');
  assert.ok(t.rows.some((r) => r[4].startsWith('▲')), '▲ の金額がある');
  assert.ok(t.rows.some((r) => /\n/.test(r[5])), '改行を含む備考がある');
  // Python の csv モジュールで別に計算した店舗ごとの合計と一致する
  const sums = C.aggregate(t, { groupBy: 1, valueCol: 4, method: 'sum' });
  assert.deepEqual(Object.fromEntries(sums.groups.map((g) => [g.label, g.value])), { '駅前店': 213280, '丘の上店': 147220, '中央通り店': 169140 });
  assert.equal(sums.total.value, 529640);
});

function makeBigCSV(n) {
  const stores = ['駅前店', '中央通り店', '丘の上店', '川沿い店', '公園前店'];
  const items = ['食パン', 'クロワッサン', 'メロンパン', 'カレーパン', 'あんぱん', 'ベーグル'];
  const lines = ['日付,店舗,商品,数量,売上金額,備考'];
  for (let i = 0; i < n; i++) {
    const m = 1 + (i % 12), d = 1 + (i % 28);
    const amount = (i * 37) % 5000 + 100;
    const amountText = i % 3 === 0 ? `"${amount.toLocaleString('en-US')}"` : i % 3 === 1 ? `¥${amount}` : String(amount);
    lines.push(`2026/${m}/${d},${stores[i % 5]},${items[i % 6]},${1 + (i % 9)},${amountText},${i % 50 === 0 ? '"メモ, あり"' : ''}`);
  }
  return lines.join('\r\n') + '\r\n';
}

test('速さ: 1 万行を 1 秒以内に読み取り・推定・集計・ピボットできる', () => {
  const text = makeBigCSV(10000);
  const bytesBig = utf8(text);
  const t0 = performance.now();
  const d = C.decode(bytesBig);
  const t = C.parseCSV(d.text);
  const types = C.inferTypes(t.headers, t.rows);
  const a = C.aggregate(t, { groupBy: 1, valueCol: 4, method: 'sum' });
  const m = C.aggregate(t, { groupBy: 0, valueCol: 4, method: 'avg', dateUnit: 'month' });
  const p = C.pivot(t, { rowBy: 1, colBy: 2, valueCol: 4, method: 'sum' });
  const out = C.toCSV([t.headers].concat(t.rows));
  const ms = performance.now() - t0;
  assert.equal(t.rows.length, 10000);
  assert.equal(types[4].type, 'number');
  assert.equal(a.groups.length, 5);
  assert.equal(m.groups.length, 12);
  assert.equal(p.cells.length, 5);
  assert.equal(a.skipped.invalidValues, 0);
  assert.ok(out.length > 0);
  assert.ok(ms < 1000, `1 万行で ${ms.toFixed(0)}ms かかった（1000ms 未満が目安）`);
});

test('速さ: 5 万行でも数秒で終わる（固まらない）', () => {
  const text = makeBigCSV(50000);
  const t0 = performance.now();
  const t = C.parseCSV(C.decode(utf8(text)).text);
  C.inferTypes(t.headers, t.rows);
  C.aggregate(t, { groupBy: 2, valueCol: 4, method: 'sum' });
  const ms = performance.now() - t0;
  assert.equal(t.rows.length, 50000);
  assert.ok(ms < 3000, `5 万行で ${ms.toFixed(0)}ms かかった`);
});
