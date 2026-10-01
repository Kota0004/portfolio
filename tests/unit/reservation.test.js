// 予約フォームのデモ（site/demos/reservation/reservation-core.js）の単体テスト。
// 実行: node --test tests/unit/*.test.js
//
// 「いま」はすべて固定した Date を渡すので、いつ・どの時間帯の端末で走らせても結果は同じ。
// 日付は端末のローカル時刻で作る（new Date(年, 月-1, 日, 時, 分)）。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const C = require(path.join(__dirname, '..', '..', 'site', 'demos', 'reservation', 'reservation-core.js'));

// 2026-10-01（木）13:30 を「いま」とする
const NOW = new Date(2026, 9, 1, 13, 30, 0);
const TODAY = '2026-10-01';

const VALID = {
  dateKey: '2026-10-02', // 金曜
  hour: 14,
  name: 'デモ 太郎',
  email: 'demo.user@example.com',
  people: '3',
  purpose: 'meeting',
  note: ''
};

function input(over) {
  return Object.assign({}, VALID, over || {});
}

// ------------------------------------------------------------------ 時間枠

test('時間枠は 10:00〜18:00 の1時間ごとに8枠', () => {
  const slots = C.generateSlots();
  assert.equal(slots.length, 8);
  assert.deepEqual(slots.map((s) => s.hour), [10, 11, 12, 13, 14, 15, 16, 17]);
  assert.equal(slots[0].label, '10:00〜11:00');
  assert.equal(slots[7].label, '17:00〜18:00');
  assert.equal(slots[7].end, '18:00');
});

test('18:00 ちょうどに始まる枠は無い（営業は 18:00 まで）', () => {
  assert.equal(C.generateSlots().some((s) => s.start === '18:00'), false);
  assert.equal(C.isValidHour(17), true);
  assert.equal(C.isValidHour(18), false);
  assert.equal(C.isValidHour(9), false);
  assert.equal(C.isValidHour(10.5), false);
  assert.equal(C.slotStatus('2026-10-02', 18, NOW, []), 'invalid');
});

// ------------------------------------------------------------------ 日付と定休日

test('今日から14日分の日付が並ぶ', () => {
  const dates = C.listDates(NOW);
  assert.equal(dates.length, 14);
  assert.equal(dates[0].key, TODAY);
  assert.equal(dates[0].offset, 0);
  assert.equal(dates[13].key, '2026-10-14');
  assert.equal(dates[0].weekdayLabel, '木');
});

test('月末・年末をまたいでも日付が正しく進む', () => {
  const dates = C.listDates(new Date(2026, 11, 25, 9, 0));
  assert.equal(dates[0].key, '2026-12-25');
  assert.equal(dates[7].key, '2027-01-01');
  assert.equal(dates[13].key, '2027-01-07');
  assert.equal(C.addDays('2028-02-28', 1), '2028-02-29'); // うるう年
  assert.equal(C.addDays('2027-02-28', 1), '2027-03-01');
});

test('定休日は毎週水曜（前後の火曜・木曜は営業）', () => {
  assert.equal(C.isClosedDay('2026-10-07'), true); // 水
  assert.equal(C.isClosedDay('2026-10-14'), true); // 水
  assert.equal(C.isClosedDay('2026-10-06'), false); // 火
  assert.equal(C.isClosedDay('2026-10-08'), false); // 木
  assert.match(C.closedReason('2026-10-07'), /水曜日は定休日/);
  assert.equal(C.closedReason('2026-10-08'), '');
  const wednesdays = C.listDates(NOW).filter((d) => d.closed).map((d) => d.key);
  assert.deepEqual(wednesdays, ['2026-10-07', '2026-10-14']);
});

test('定休日の枠はすべて選べない', () => {
  for (const s of C.generateSlots()) {
    assert.equal(C.slotStatus('2026-10-07', s.hour, NOW, []), 'closed');
  }
  const info = C.dayAvailability('2026-10-07', NOW, []);
  assert.equal(info.closed, true);
  assert.equal(info.available, 0);
  assert.equal(info.summary, 'closed');
  assert.deepEqual(C.validateSlot('2026-10-07', 14, NOW, []), { date: C.closedReason('2026-10-07') });
});

test('存在しない日付や形のおかしい日付は受け付けない', () => {
  assert.equal(C.isDateKey('2026-02-30'), false);
  assert.equal(C.isDateKey('2026-2-3'), false);
  assert.equal(C.isDateKey(''), false);
  assert.equal(C.slotStatus('2026-02-30', 14, NOW, []), 'invalid');
});

// ------------------------------------------------------------------ 過去枠・受付期間

test('今日の枠は、いまの時刻より前に始まるものを選べない（13:30 なら 13:00 まで受付終了）', () => {
  assert.equal(C.isPastSlot(TODAY, 13, NOW), true);
  assert.equal(C.isPastSlot(TODAY, 14, NOW), false);
  assert.equal(C.slotStatus(TODAY, 10, NOW, []), 'past');
  assert.equal(C.slotStatus(TODAY, 13, NOW, []), 'past');
  assert.deepEqual(C.validateSlot(TODAY, 13, NOW, []), { slot: 'この時間は受付を終了しました。別の時間を選んでください。' });
});

test('開始時刻ちょうどの枠は受付終了、1秒前ならまだ選べる', () => {
  assert.equal(C.isPastSlot(TODAY, 14, new Date(2026, 9, 1, 14, 0, 0)), true);
  assert.equal(C.isPastSlot(TODAY, 14, new Date(2026, 9, 1, 13, 59, 59)), false);
});

test('18:00 ちょうどになると、今日の枠はすべて受付終了', () => {
  const at18 = new Date(2026, 9, 1, 18, 0, 0);
  for (const s of C.generateSlots()) {
    assert.equal(C.slotStatus(TODAY, s.hour, at18, []), 'past', `${s.label}`);
  }
  const info = C.dayAvailability(TODAY, at18, []);
  assert.equal(info.available, 0);
  assert.equal(info.summary, 'ended');
  assert.equal(C.firstAvailableDate(at18, []), '2026-10-02'); // 翌日が最初に空いている日
  assert.deepEqual(C.validateSlot(TODAY, null, at18, []), { slot: 'この日は空いている時間がありません。別の日を選んでください。' });
});

test('17:59 なら 17:00〜18:00 の枠は受付終了（開始を過ぎている）', () => {
  assert.equal(C.slotStatus(TODAY, 17, new Date(2026, 9, 1, 17, 59), []), 'past');
  assert.equal(C.slotStatus(TODAY, 17, new Date(2026, 9, 1, 16, 59), []), 'available');
});

test('昨日は受付終了、14日目より先は受付期間外', () => {
  assert.equal(C.slotStatus('2026-09-30', 15, NOW, []), 'past');
  assert.equal(C.isInRange('2026-10-14', NOW), true); // 13日後（14日目）
  assert.equal(C.isInRange('2026-10-15', NOW), false); // 14日後
  assert.equal(C.slotStatus('2026-10-15', 15, NOW, []), 'out-of-range');
  assert.ok(C.validateSlot('2026-10-15', 15, NOW, []).date);
});

// ------------------------------------------------------------------ 架空の既存予約

test('架空の既存予約は日付だけで決まる（同じ日なら同じ結果）', () => {
  const a = C.demoBookedHours('2026-10-02');
  const b = C.demoBookedHours('2026-10-02');
  assert.deepEqual(a, b);
  // 規則どおり: base = (2×5 + 10×3) % 8 = 0 → 0 番目と 3 番目（10:00 と 13:00）
  assert.deepEqual(a, [10, 13]);
  // 土曜は1枠多い: base = (3×5 + 30) % 8 = 5 → 5, 0, 2 番目
  assert.deepEqual(C.demoBookedHours('2026-10-03'), [10, 12, 15]);
  // 定休日には入っていない
  assert.deepEqual(C.demoBookedHours('2026-10-07'), []);
});

test('架空の既存予約は平日2枠・土日3枠で、どの日にも空きが残る', () => {
  const start = '2026-01-01';
  for (let i = 0; i < 400; i++) {
    const key = C.addDays(start, i);
    const hours = C.demoBookedHours(key);
    const wd = C.parseDateKey(key).getDay();
    if (wd === 3) {
      assert.equal(hours.length, 0, key);
      continue;
    }
    assert.equal(hours.length, wd === 0 || wd === 6 ? 3 : 2, key);
    assert.equal(new Set(hours).size, hours.length, `${key} で重複`);
    for (const hr of hours) assert.ok(C.isValidHour(hr), `${key} ${hr}`);
  }
});

test('架空の既存予約の枠は「予約済み」になる', () => {
  assert.equal(C.slotStatus('2026-10-02', 10, NOW, []), 'booked');
  assert.equal(C.slotStatus('2026-10-02', 13, NOW, []), 'booked');
  assert.equal(C.slotStatus('2026-10-02', 14, NOW, []), 'available');
  // 今日（10/1）は 13:00 と 16:00 が埋まっている。13:00 は時刻を過ぎているので「受付終了」が優先
  assert.equal(C.slotStatus(TODAY, 13, NOW, []), 'past');
  assert.equal(C.slotStatus(TODAY, 16, NOW, []), 'booked');
  const info = C.dayAvailability(TODAY, NOW, []);
  assert.deepEqual([info.available, info.booked, info.past], [3, 1, 4]);
});

// ------------------------------------------------------------------ 入力チェック

test('正しい入力はエラーなし', () => {
  const res = C.validateReservation(input(), NOW, []);
  assert.equal(res.valid, true);
  assert.deepEqual(res.errors, {});
  assert.equal(res.firstError, null);
  assert.equal(res.values.people, 3);
});

test('お名前: 必須、空白だけは空とみなす、50文字までOK・51文字はエラー', () => {
  assert.match(C.validateFields(input({ name: '' })).errors.name, /お名前を入力/);
  assert.match(C.validateFields(input({ name: '　 \t' })).errors.name, /お名前を入力/);
  assert.equal(C.validateFields(input({ name: 'あ'.repeat(50) })).errors.name, undefined);
  assert.equal(
    C.validateFields(input({ name: 'あ'.repeat(51) })).errors.name,
    'お名前は50文字以内で入力してください（いま51文字）。'
  );
  // 前後の空白は数えない
  assert.equal(C.validateFields(input({ name: '  ' + 'a'.repeat(50) + '  ' })).errors.name, undefined);
  // 絵文字など（サロゲートペア）も1文字と数える
  assert.equal(C.validateFields(input({ name: '😀'.repeat(50) })).errors.name, undefined);
  assert.ok(C.validateFields(input({ name: '😀'.repeat(51) })).errors.name);
});

test('メールアドレス: 必須、形式チェック', () => {
  assert.match(C.validateFields(input({ email: '' })).errors.email, /メールアドレスを入力/);
  const bad = [
    'abc', 'abc@', '@example.com', 'a@b', 'a@@example.com', 'a b@example.com',
    'a@example', 'a@example.c', '.a@example.com', 'a.@example.com', 'a..b@example.com',
    'a@-example.com', 'a@example..com', 'ａ@example.com', 'a@例え.jp', 'a@example.com.',
    'x'.repeat(65) + '@example.com'
  ];
  for (const email of bad) {
    assert.match(C.validateFields(input({ email })).errors.email || '', /形式が正しくありません/, email);
  }
  const good = ['demo@example.com', 'demo.user+tag@example.co.jp', 'a_b-c@sub.example.org', ' demo@example.com '];
  for (const email of good) {
    assert.equal(C.validateFields(input({ email })).errors.email, undefined, email);
  }
});

test('人数: 必須、1〜10（0 と 11 はエラー）、数字以外はエラー', () => {
  assert.match(C.validateFields(input({ people: '' })).errors.people, /人数を入力/);
  assert.match(C.validateFields(input({ people: '0' })).errors.people, /1〜10人の範囲/);
  assert.match(C.validateFields(input({ people: '11' })).errors.people, /1〜10人の範囲/);
  assert.equal(C.validateFields(input({ people: '1' })).errors.people, undefined);
  assert.equal(C.validateFields(input({ people: '10' })).errors.people, undefined);
  for (const p of ['1.5', '-1', 'abc', '3人', '1e1']) {
    assert.match(C.validateFields(input({ people: p })).errors.people, /数字で入力/, p);
  }
  // 全角数字は半角として受け付ける
  const full = C.validateFields(input({ people: '１０' }));
  assert.equal(full.errors.people, undefined);
  assert.equal(full.values.people, 10);
});

test('利用目的: 一覧にある値だけ', () => {
  assert.equal(C.validateFields(input({ purpose: 'seminar' })).errors.purpose, undefined);
  assert.match(C.validateFields(input({ purpose: '' })).errors.purpose, /一覧から選んで/);
  assert.match(C.validateFields(input({ purpose: 'party' })).errors.purpose, /一覧から選んで/);
});

test('備考: 任意、200文字までOK・201文字はエラー、改行は1文字', () => {
  assert.equal(C.validateFields(input({ note: '' })).errors.note, undefined);
  assert.equal(C.validateFields(input({ note: 'あ'.repeat(200) })).errors.note, undefined);
  assert.equal(
    C.validateFields(input({ note: 'あ'.repeat(201) })).errors.note,
    '備考は200文字以内で入力してください（いま201文字）。'
  );
  // CRLF は LF にそろえてから数える（199文字＋改行1つ＝200文字）
  const crlf = 'あ'.repeat(100) + '\r\n' + 'い'.repeat(99);
  const res = C.validateFields(input({ note: crlf }));
  assert.equal(res.errors.note, undefined);
  assert.equal(res.values.note, 'あ'.repeat(100) + '\n' + 'い'.repeat(99));
});

test('日時: 未選択はエラー、エラーは画面の上から順に並び、最初の項目がわかる', () => {
  const res = C.validateReservation({ dateKey: '', hour: null, name: '', email: 'x', people: '0', purpose: 'meeting', note: '' }, NOW, []);
  assert.equal(res.valid, false);
  assert.deepEqual(Object.keys(res.errors), ['date', 'name', 'email', 'people']);
  assert.equal(res.firstError, 'date');

  const noSlot = C.validateReservation(input({ hour: null, name: 'あ'.repeat(51) }), NOW, []);
  assert.deepEqual(Object.keys(noSlot.errors), ['slot', 'name']);
  assert.equal(noSlot.errors.slot, '時間を選んでください。');
  assert.equal(noSlot.firstError, 'slot');

  const onlyEmail = C.validateReservation(input({ email: 'demo@' }), NOW, []);
  assert.equal(onlyEmail.firstError, 'email');
});

// ------------------------------------------------------------------ 予約の確定・二重予約

test('予約を確定すると予約番号が振られ、元の state は書き換えない', () => {
  const s0 = C.emptyState();
  const r = C.book(s0, input(), NOW);
  assert.equal(r.ok, true);
  assert.equal(r.reservation.id, 'R-20261002-01');
  assert.equal(r.reservation.people, 3);
  assert.equal(r.reservation.createdAt, NOW.toISOString());
  assert.equal(r.state.reservations.length, 1);
  assert.equal(s0.reservations.length, 0);
  assert.deepEqual(s0.counters, {});
  assert.equal(r.state.counters['2026-10-02'], 1);
});

test('二重予約: 同じ枠は2回目を受け付けない', () => {
  const first = C.book(C.emptyState(), input(), NOW);
  assert.equal(first.ok, true);
  assert.equal(C.slotStatus('2026-10-02', 14, NOW, first.state.reservations), 'booked');
  const second = C.book(first.state, input({ name: '別の人', email: 'other@example.com' }), NOW);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'taken');
  assert.equal(second.state, undefined);
  assert.deepEqual(C.validateSlot('2026-10-02', 14, NOW, first.state.reservations), {
    slot: 'この時間はすでに予約が入っています。別の時間を選んでください。'
  });
});

test('二重予約: 架空の既存予約の枠・過ぎた枠・定休日も確定できない', () => {
  assert.equal(C.book(C.emptyState(), input({ hour: 10 }), NOW).reason, 'taken');
  assert.equal(C.book(C.emptyState(), input({ dateKey: TODAY, hour: 12 }), NOW).reason, 'past');
  assert.equal(C.book(C.emptyState(), input({ dateKey: '2026-10-07' }), NOW).reason, 'closed');
  assert.equal(C.book(C.emptyState(), input({ dateKey: '2026-10-20' }), NOW).reason, 'out-of-range');
  const bad = C.book(C.emptyState(), input({ email: 'bad' }), NOW);
  assert.equal(bad.reason, 'invalid');
  assert.ok(bad.errors.email);
});

test('予約番号は「R-利用日-その日の受付順」。取り消した番号は使い回さない', () => {
  assert.equal(C.formatReservationNumber('2026-10-02', 1), 'R-20261002-01');
  assert.equal(C.formatReservationNumber('2026-10-02', 12), 'R-20261002-12');
  assert.equal(C.formatReservationNumber('2026-10-02', 100), 'R-20261002-100');
  assert.deepEqual(C.parseReservationNumber('R-20261002-03'), { dateKey: '2026-10-02', seq: 3 });
  assert.equal(C.parseReservationNumber('X-1'), null);

  let s = C.emptyState();
  s = C.book(s, input({ hour: 14 }), NOW).state;
  s = C.book(s, input({ hour: 15 }), NOW).state;
  const other = C.book(s, input({ dateKey: '2026-10-05', hour: 11 }), NOW);
  assert.equal(other.reservation.id, 'R-20261005-01'); // 日付が変われば 01 から
  s = other.state;
  assert.deepEqual(s.reservations.map((r) => r.id), ['R-20261002-01', 'R-20261002-02', 'R-20261005-01']);

  const cancelled = C.cancelReservation(s, 'R-20261002-02');
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.removed.hour, 15);
  assert.equal(cancelled.state.reservations.length, 2);
  assert.equal(s.reservations.length, 3); // 元は書き換えない
  // 取り消した枠はまた予約できるが、番号は 03 になる
  const again = C.book(cancelled.state, input({ hour: 15 }), NOW);
  assert.equal(again.ok, true);
  assert.equal(again.reservation.id, 'R-20261002-03');

  assert.equal(C.cancelReservation(again.state, 'R-20261002-02').ok, false); // 2回目の取り消し
});

test('並べ替えは日付→時刻の順', () => {
  const list = [
    { id: 'R-20261005-01', dateKey: '2026-10-05', hour: 11 },
    { id: 'R-20261002-02', dateKey: '2026-10-02', hour: 15 },
    { id: 'R-20261002-01', dateKey: '2026-10-02', hour: 14 },
    { id: 'R-20261003-01', dateKey: '2026-10-03', hour: 17 }
  ];
  assert.deepEqual(C.sortReservations(list).map((r) => r.id), [
    'R-20261002-01', 'R-20261002-02', 'R-20261003-01', 'R-20261005-01'
  ]);
  assert.equal(list[0].id, 'R-20261005-01'); // 元の配列は並べ替えない
});

// ------------------------------------------------------------------ 保存形式

test('保存した内容を読み直せる。壊れたデータでも落ちない', () => {
  const s = C.book(C.emptyState(), input({ note: '1行目\n2行目' }), NOW).state;
  const back = C.parseState(C.serializeState(s));
  assert.deepEqual(back, s);

  assert.deepEqual(C.parseState(null), C.emptyState());
  assert.deepEqual(C.parseState('{壊れた'), C.emptyState());
  assert.deepEqual(C.parseState('"文字列"'), C.emptyState());
  const mixed = C.parseState(JSON.stringify({
    reservations: [
      s.reservations[0],
      s.reservations[0], // 同じ番号は1件にまとめる
      { id: 'R-20261002-09', dateKey: '2026-10-02', hour: 18 }, // 時刻がおかしい
      { id: 'bad', dateKey: '2026-10-02', hour: 12 },
      null
    ],
    counters: { '2026-10-02': 4, 'x': 2, '2026-10-03': -1 }
  }));
  assert.equal(mixed.reservations.length, 1);
  assert.deepEqual(mixed.counters, { '2026-10-02': 4 });
  assert.equal(C.nextSequence(mixed, '2026-10-02'), 5);
});

// ------------------------------------------------------------------ CSV

test('CSV: BOM つき・CRLF 区切り・見出し行・日付と時刻の順', () => {
  let s = C.emptyState();
  s = C.book(s, input({ dateKey: '2026-10-05', hour: 11 }), NOW).state;
  s = C.book(s, input({ hour: 15, purpose: 'seminar', people: '10' }), NOW).state;
  const csv = C.toCsv(s.reservations);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.equal(Buffer.from(csv, 'utf8').subarray(0, 3).toString('hex'), 'efbbbf');
  assert.ok(csv.endsWith('\r\n'));
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines[0], '予約番号,利用日,曜日,開始,終了,お名前,メールアドレス,人数,利用目的,備考,受付日時');
  assert.equal(lines[1], `R-20261002-01,2026-10-02,金,15:00,16:00,デモ 太郎,demo.user@example.com,10,勉強会・セミナー,,${C.formatDateTime(NOW)}`);
  assert.ok(lines[2].startsWith('R-20261005-01,2026-10-05,月,11:00,12:00,'));
  assert.equal(lines[3], '');
  assert.equal(lines.length, 4);
});

test('CSV: カンマ・改行・ダブルクォートを含む値を正しく囲む', () => {
  assert.equal(C.csvCell('ふつう'), 'ふつう');
  assert.equal(C.csvCell('a,b'), '"a,b"');
  assert.equal(C.csvCell('彼は"OK"と言った'), '"彼は""OK""と言った"');
  assert.equal(C.csvCell('1行目\n2行目'), '"1行目\n2行目"');
  assert.equal(C.csvCell('a\r\nb'), '"a\r\nb"');
  assert.equal(C.csvCell(''), '');
  assert.equal(C.csvCell(null), '');

  const note = 'プロジェクター希望, ホワイトボードも\n"至急" です';
  const s = C.book(C.emptyState(), input({ name: 'デモ "テスト", 様', note }), NOW).state;
  const row = C.toCsv(s.reservations).slice(1).split('\r\n')[1];
  assert.ok(row.includes(',"デモ ""テスト"", 様",'), row);
  assert.ok(row.includes(',"プロジェクター希望, ホワイトボードも\n""至急"" です",'), row);
});

test('CSV: = + - @ で始まる値は数式として動かないよう先頭に \' を付ける', () => {
  assert.equal(C.csvCell('=1+1'), "'=1+1");
  assert.equal(C.csvCell('+81'), "'+81");
  assert.equal(C.csvCell('-5'), "'-5");
  assert.equal(C.csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(C.csvCell('=HYPERLINK("x","y")'), '"\'=HYPERLINK(""x"",""y"")"');
  assert.equal(C.csvCell('a=b'), 'a=b');
});

test('CSV: 予約が0件なら見出し行だけ', () => {
  assert.equal(C.toCsv([]), '﻿' + C.CSV_HEADER.join(',') + '\r\n');
  assert.equal(C.csvFileName(NOW), 'sample-room-reservations-20261001.csv');
});

// ------------------------------------------------------------------ 表示用

test('日付の表示', () => {
  assert.equal(C.formatDateJa('2026-10-02'), '10月2日（金）');
  assert.equal(C.formatDateLongJa('2026-10-02'), '2026年10月2日（金）');
  assert.equal(C.slotLabel(17), '17:00〜18:00');
  assert.equal(C.purposeLabel('meeting'), '会議・打ち合わせ');
  assert.equal(C.purposeLabel('nope'), '');
});
