/*
 * 予約フォームのデモ — ロジック部分（画面＝DOM には触れない）。
 *
 * ブラウザでは <script src> で読み込むと window.ReservationCore に入る。
 * Node では require('./reservation-core.js') で同じ関数を使える（単体テスト用）。
 *
 * 日付はすべて「端末のローカル時刻」で扱う。日付は 'YYYY-MM-DD' の文字列（dateKey）、
 * 時間枠は開始時刻の「時」（10〜17 の整数）で表す。
 * 「いま」は引数で受け取る関数ばかりなので、テストでは時刻を固定して結果を決められる。
 */
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ 設定

  var OPEN_HOUR = 10; // 最初の枠の開始（10:00）
  var CLOSE_HOUR = 18; // 営業終了（最後の枠は 17:00〜18:00）
  var DAYS_AHEAD = 14; // 今日を含めて 14 日分を受け付ける
  var CLOSED_WEEKDAY = 3; // 定休日: 水曜（Date#getDay の 3）
  var NAME_MAX = 50;
  var NOTE_MAX = 200;
  var PEOPLE_MIN = 1;
  var PEOPLE_MAX = 10;
  var EMAIL_MAX = 254;
  var STORAGE_KEY = 'kota0004-demo-reservation-v1';
  var STATE_VERSION = 1;

  var WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

  var PURPOSES = [
    { value: 'meeting', label: '会議・打ち合わせ' },
    { value: 'interview', label: '面接・面談' },
    { value: 'seminar', label: '勉強会・セミナー' },
    { value: 'work', label: '作業・自習' },
    { value: 'other', label: 'その他' }
  ];

  var STATUS_LABELS = {
    available: '空き',
    booked: '予約済み',
    past: '受付終了',
    closed: '定休日',
    'out-of-range': '受付期間外',
    invalid: '選べません'
  };

  // 入力項目の並び（エラーを上から順に見せ、最初の項目にフォーカスするため）
  var FIELD_ORDER = ['date', 'slot', 'name', 'email', 'people', 'purpose', 'note'];

  // ------------------------------------------------------------------ 日付

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function toDateKey(date) {
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
  }

  // 'YYYY-MM-DD' → その日のローカル 0:00 の Date。存在しない日付（2026-02-30 など）は null。
  function parseDateKey(key) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key));
    if (!m) return null;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return toDateKey(d) === key ? d : null;
  }

  function isDateKey(key) {
    return parseDateKey(key) !== null;
  }

  function addDays(key, n) {
    var d = parseDateKey(key);
    return toDateKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
  }

  // 2つの dateKey の日数差（to − from）。夏時間のある地域でもずれないよう、暦の上で数える。
  function daysBetween(fromKey, toKey) {
    var a = parseDateKey(fromKey);
    var b = parseDateKey(toKey);
    var ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
    var ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.round((ub - ua) / 86400000);
  }

  function weekdayOf(key) {
    return parseDateKey(key).getDay();
  }

  // '10月2日（金）'
  function formatDateJa(key) {
    var d = parseDateKey(key);
    if (!d) return '';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日（' + WEEKDAYS[d.getDay()] + '）';
  }

  // '2026年10月2日（金）'
  function formatDateLongJa(key) {
    var d = parseDateKey(key);
    if (!d) return '';
    return d.getFullYear() + '年' + formatDateJa(key);
  }

  // '2026-10-01 13:30'（ローカル時刻）
  function formatDateTime(date) {
    return toDateKey(date) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
  }

  // ------------------------------------------------------------------ 時間枠

  function isValidHour(hour) {
    return typeof hour === 'number' && Math.floor(hour) === hour && hour >= OPEN_HOUR && hour < CLOSE_HOUR;
  }

  function slotLabel(hour) {
    return pad2(hour) + ':00〜' + pad2(hour + 1) + ':00';
  }

  // 10:00〜18:00 を1時間ごとに区切った 8 枠
  function generateSlots() {
    var slots = [];
    for (var h = OPEN_HOUR; h < CLOSE_HOUR; h++) {
      slots.push({ hour: h, start: pad2(h) + ':00', end: pad2(h + 1) + ':00', label: slotLabel(h) });
    }
    return slots;
  }

  // ------------------------------------------------------------------ 定休日・受付期間・過去枠

  function isClosedDay(key) {
    return isDateKey(key) && weekdayOf(key) === CLOSED_WEEKDAY;
  }

  function closedReason(key) {
    return isClosedDay(key) ? '毎週水曜日は定休日のため、予約できません。' : '';
  }

  // 今日から DAYS_AHEAD 日分の中に入っているか
  function isInRange(key, now) {
    if (!isDateKey(key)) return false;
    var diff = daysBetween(toDateKey(now), key);
    return diff >= 0 && diff < DAYS_AHEAD;
  }

  // 枠の開始時刻（ローカル時刻）
  function slotStartDate(key, hour) {
    var d = parseDateKey(key);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0, 0, 0);
  }

  // 開始時刻を過ぎた枠は選べない（開始時刻ちょうども「過ぎた」に含める）
  function isPastSlot(key, hour, now) {
    return slotStartDate(key, hour).getTime() <= now.getTime();
  }

  // 今日から DAYS_AHEAD 日分の日付の一覧
  function listDates(now, days) {
    var count = typeof days === 'number' ? days : DAYS_AHEAD;
    var today = toDateKey(now);
    var out = [];
    for (var i = 0; i < count; i++) {
      var key = addDays(today, i);
      var d = parseDateKey(key);
      out.push({
        key: key,
        year: d.getFullYear(),
        month: d.getMonth() + 1,
        day: d.getDate(),
        weekday: d.getDay(),
        weekdayLabel: WEEKDAYS[d.getDay()],
        offset: i,
        closed: isClosedDay(key),
        closedReason: closedReason(key)
      });
    }
    return out;
  }

  // ------------------------------------------------------------------ 架空の既存予約

  /*
   * デモらしく見せるための「架空の既存予約」。乱数は使わず、日付だけから決める。
   *   base = (日 × 5 + 月 × 3) を 8 で割った余り
   *   base 番目と (base + 3) 番目の枠（0 番目が 10:00）が埋まっている。
   *   土日はさらに (base + 5) 番目も埋まっている。定休日（水曜）は無し。
   * 同じ日付なら、いつ・どの端末で開いても同じ結果になる。
   */
  function demoBookedHours(key) {
    var d = parseDateKey(key);
    if (!d || isClosedDay(key)) return [];
    var slotCount = CLOSE_HOUR - OPEN_HOUR;
    var base = (d.getDate() * 5 + (d.getMonth() + 1) * 3) % slotCount;
    var idx = [base, (base + 3) % slotCount];
    var wd = d.getDay();
    if (wd === 0 || wd === 6) idx.push((base + 5) % slotCount);
    return idx
      .map(function (i) { return OPEN_HOUR + i; })
      .sort(function (a, b) { return a - b; });
  }

  // ------------------------------------------------------------------ 空き判定

  function isBooked(key, hour, reservations) {
    if (demoBookedHours(key).indexOf(hour) !== -1) return true;
    var list = reservations || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].dateKey === key && list[i].hour === hour) return true;
    }
    return false;
  }

  /*
   * 枠の状態:
   *   'available'    選べる
   *   'booked'       予約済み（架空の既存予約、またはこのブラウザで受け付けた予約）
   *   'past'         開始時刻を過ぎた（昨日以前の日付も含む）
   *   'closed'       定休日
   *   'out-of-range' 受付期間（今日から 14 日分）より先
   *   'invalid'      日付や時刻の形がおかしい
   */
  function slotStatus(key, hour, now, reservations) {
    if (!isDateKey(key) || !isValidHour(hour)) return 'invalid';
    var diff = daysBetween(toDateKey(now), key);
    if (diff < 0) return 'past';
    if (diff >= DAYS_AHEAD) return 'out-of-range';
    if (isClosedDay(key)) return 'closed';
    if (isPastSlot(key, hour, now)) return 'past';
    if (isBooked(key, hour, reservations)) return 'booked';
    return 'available';
  }

  function isSlotAvailable(key, hour, now, reservations) {
    return slotStatus(key, hour, now, reservations) === 'available';
  }

  // その日の空き状況のまとめ
  function dayAvailability(key, now, reservations) {
    var counts = { available: 0, booked: 0, past: 0, closed: 0, total: 0 };
    generateSlots().forEach(function (s) {
      var st = slotStatus(key, s.hour, now, reservations);
      counts.total++;
      if (counts[st] !== undefined) counts[st]++;
    });
    var summary;
    if (isClosedDay(key)) summary = 'closed';
    else if (counts.available > 0) summary = 'available';
    else if (counts.past === counts.total) summary = 'ended';
    else summary = 'full';
    return {
      closed: summary === 'closed',
      available: counts.available,
      booked: counts.booked,
      past: counts.past,
      total: counts.total,
      summary: summary // 'available' | 'full'（満席） | 'ended'（受付終了） | 'closed'（定休日）
    };
  }

  // 空きのある最初の日（無ければ null）
  function firstAvailableDate(now, reservations) {
    var dates = listDates(now);
    for (var i = 0; i < dates.length; i++) {
      if (dayAvailability(dates[i].key, now, reservations).available > 0) return dates[i].key;
    }
    return null;
  }

  // ------------------------------------------------------------------ 入力チェック

  // 文字数は「見た目の1文字」に近い数え方（サロゲートペアを1文字）にする
  function charCount(s) {
    return Array.from(String(s)).length;
  }

  function toHalfWidthDigits(s) {
    return String(s).replace(/[０-９]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xfee0);
    });
  }

  var EMAIL_RE = /^[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

  function isValidEmail(email) {
    var s = String(email);
    if (s.length > EMAIL_MAX) return false;
    if (!EMAIL_RE.test(s)) return false;
    return s.split('@')[0].length <= 64;
  }

  function purposeLabel(value) {
    for (var i = 0; i < PURPOSES.length; i++) {
      if (PURPOSES[i].value === value) return PURPOSES[i].label;
    }
    return '';
  }

  function toStr(v) {
    return v === undefined || v === null ? '' : String(v);
  }

  // 入力値をそろえる（前後の空白を除く、改行を \n にそろえる、人数を数値にする）
  function normalizeInput(input) {
    var src = input || {};
    var peopleRaw = toHalfWidthDigits(toStr(src.people)).trim();
    var hour = src.hour;
    if (typeof hour === 'string' && /^\d+$/.test(hour)) hour = Number(hour);
    if (typeof hour !== 'number' || !isFinite(hour)) hour = null;
    return {
      dateKey: toStr(src.dateKey),
      hour: hour,
      name: toStr(src.name).replace(/[\r\n]+/g, ' ').trim(),
      email: toStr(src.email).trim(),
      peopleRaw: peopleRaw,
      people: /^\d+$/.test(peopleRaw) ? Number(peopleRaw) : null,
      purpose: toStr(src.purpose),
      note: toStr(src.note).replace(/\r\n?/g, '\n').trim()
    };
  }

  // 日時以外の項目のチェック。errors は項目名 → 日本語のメッセージ。
  function validateFields(input) {
    var v = normalizeInput(input);
    var errors = {};

    if (v.name === '') {
      errors.name = 'お名前を入力してください。';
    } else if (charCount(v.name) > NAME_MAX) {
      errors.name = 'お名前は' + NAME_MAX + '文字以内で入力してください（いま' + charCount(v.name) + '文字）。';
    }

    if (v.email === '') {
      errors.email = 'メールアドレスを入力してください。';
    } else if (!isValidEmail(v.email)) {
      errors.email = 'メールアドレスの形式が正しくありません。半角で「name@example.com」のように入力してください。';
    }

    if (v.peopleRaw === '') {
      errors.people = '人数を入力してください。';
    } else if (v.people === null) {
      errors.people = '人数は数字で入力してください（' + PEOPLE_MIN + '〜' + PEOPLE_MAX + '人）。';
    } else if (v.people < PEOPLE_MIN || v.people > PEOPLE_MAX) {
      errors.people = '人数は' + PEOPLE_MIN + '〜' + PEOPLE_MAX + '人の範囲で入力してください。';
    }

    if (!purposeLabel(v.purpose)) {
      errors.purpose = '利用目的を一覧から選んでください。';
    }

    if (charCount(v.note) > NOTE_MAX) {
      errors.note = '備考は' + NOTE_MAX + '文字以内で入力してください（いま' + charCount(v.note) + '文字）。';
    }

    return { valid: Object.keys(errors).length === 0, errors: errors, values: v };
  }

  // 日時のチェック。問題が無ければ {} を返す。
  function validateSlot(dateKey, hour, now, reservations) {
    if (!dateKey) return { date: '利用日を選んでください。' };
    if (!isDateKey(dateKey)) return { date: '利用日の形式が正しくありません。' };
    if (!isInRange(dateKey, now)) {
      return { date: '利用日は今日から' + DAYS_AHEAD + '日先までの中から選んでください。' };
    }
    if (isClosedDay(dateKey)) return { date: closedReason(dateKey) };
    if (hour === null || hour === undefined || hour === '') {
      if (dayAvailability(dateKey, now, reservations).available === 0) {
        return { slot: 'この日は空いている時間がありません。別の日を選んでください。' };
      }
      return { slot: '時間を選んでください。' };
    }
    var st = slotStatus(dateKey, hour, now, reservations);
    if (st === 'available') return {};
    if (st === 'booked') return { slot: 'この時間はすでに予約が入っています。別の時間を選んでください。' };
    if (st === 'past') return { slot: 'この時間は受付を終了しました。別の時間を選んでください。' };
    return { slot: '時間を選び直してください。' };
  }

  // 予約全体のチェック（日時＋各項目）。firstError は画面の上から見て最初のエラー項目。
  function validateReservation(input, now, reservations) {
    var fields = validateFields(input);
    var v = fields.values;
    var slotErrors = validateSlot(v.dateKey, v.hour, now, reservations);
    var errors = {};
    FIELD_ORDER.forEach(function (k) {
      if (slotErrors[k]) errors[k] = slotErrors[k];
      else if (fields.errors[k]) errors[k] = fields.errors[k];
    });
    var keys = Object.keys(errors);
    return { valid: keys.length === 0, errors: errors, firstError: keys.length ? keys[0] : null, values: v };
  }

  // ------------------------------------------------------------------ 予約番号

  // 'R-20261002-01'（R ＋ 利用日 ＋ その日の受付順）。100 件目からは 3 桁になる。
  function formatReservationNumber(dateKey, seq) {
    return 'R-' + String(dateKey).replace(/-/g, '') + '-' + pad2(seq);
  }

  function parseReservationNumber(id) {
    var m = /^R-(\d{4})(\d{2})(\d{2})-(\d{2,})$/.exec(String(id));
    if (!m) return null;
    return { dateKey: m[1] + '-' + m[2] + '-' + m[3], seq: Number(m[4]) };
  }

  // 次の連番。取り消した番号を使い回さないよう、日付ごとの「最後に振った番号」を覚えておく。
  function nextSequence(state, dateKey) {
    var last = (state && state.counters && state.counters[dateKey]) || 0;
    ((state && state.reservations) || []).forEach(function (r) {
      var p = parseReservationNumber(r.id);
      if (p && p.dateKey === dateKey && p.seq > last) last = p.seq;
    });
    return last + 1;
  }

  // ------------------------------------------------------------------ 保存する形（state）

  function emptyState() {
    return { version: STATE_VERSION, reservations: [], counters: {} };
  }

  function sanitizeReservation(r) {
    if (!r || typeof r !== 'object') return null;
    var id = toStr(r.id);
    var parsed = parseReservationNumber(id);
    if (!parsed) return null;
    if (!isDateKey(r.dateKey) || !isValidHour(r.hour)) return null;
    var people = typeof r.people === 'number' ? r.people : Number(r.people);
    return {
      id: id,
      dateKey: r.dateKey,
      hour: r.hour,
      name: toStr(r.name),
      email: toStr(r.email),
      people: isFinite(people) ? people : 0,
      purpose: toStr(r.purpose),
      note: toStr(r.note),
      createdAt: toStr(r.createdAt)
    };
  }

  // localStorage から読んだ文字列を state にする。壊れていても落ちずに、読める分だけ使う。
  function parseState(json) {
    var state = emptyState();
    if (json === null || json === undefined || json === '') return state;
    var data;
    try {
      data = JSON.parse(json);
    } catch (e) {
      return state;
    }
    if (!data || typeof data !== 'object') return state;
    var seen = {};
    if (Array.isArray(data.reservations)) {
      data.reservations.forEach(function (raw) {
        var r = sanitizeReservation(raw);
        if (r && !seen[r.id]) {
          seen[r.id] = true;
          state.reservations.push(r);
        }
      });
    }
    if (data.counters && typeof data.counters === 'object') {
      Object.keys(data.counters).forEach(function (k) {
        var n = Number(data.counters[k]);
        if (isDateKey(k) && Math.floor(n) === n && n > 0) state.counters[k] = n;
      });
    }
    return state;
  }

  function serializeState(state) {
    return JSON.stringify({
      version: STATE_VERSION,
      reservations: state.reservations,
      counters: state.counters
    });
  }

  // ------------------------------------------------------------------ 予約の確定と取り消し

  /*
   * 予約を確定する。state は書き換えず、新しい state を返す。
   * 確定の直前に、渡された state（＝最新の保存内容）でもう一度空きを確かめる。
   *   成功: { ok: true, state, reservation }
   *   失敗: { ok: false, reason: 'invalid' | 'taken' | 'past' | 'closed' | 'out-of-range', errors? }
   */
  function book(state, input, now) {
    var current = state || emptyState();
    var check = validateFields(input);
    if (!check.valid) return { ok: false, reason: 'invalid', errors: check.errors };
    var v = check.values;
    var st = slotStatus(v.dateKey, v.hour, now, current.reservations);
    if (st !== 'available') {
      return { ok: false, reason: st === 'booked' ? 'taken' : st };
    }
    var seq = nextSequence(current, v.dateKey);
    var reservation = {
      id: formatReservationNumber(v.dateKey, seq),
      dateKey: v.dateKey,
      hour: v.hour,
      name: v.name,
      email: v.email,
      people: v.people,
      purpose: v.purpose,
      note: v.note,
      createdAt: now.toISOString()
    };
    var counters = {};
    Object.keys(current.counters || {}).forEach(function (k) { counters[k] = current.counters[k]; });
    counters[v.dateKey] = seq;
    return {
      ok: true,
      reservation: reservation,
      state: {
        version: STATE_VERSION,
        reservations: current.reservations.concat([reservation]),
        counters: counters
      }
    };
  }

  function cancelReservation(state, id) {
    var current = state || emptyState();
    var removed = null;
    var rest = current.reservations.filter(function (r) {
      if (r.id === id && !removed) {
        removed = r;
        return false;
      }
      return true;
    });
    if (!removed) return { ok: false, state: current, removed: null };
    return {
      ok: true,
      removed: removed,
      state: { version: STATE_VERSION, reservations: rest, counters: current.counters }
    };
  }

  // 日付・時刻の順（同じ枠なら予約番号の順）
  function sortReservations(list) {
    return (list || []).slice().sort(function (a, b) {
      if (a.dateKey !== b.dateKey) return a.dateKey < b.dateKey ? -1 : 1;
      if (a.hour !== b.hour) return a.hour - b.hour;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  // ------------------------------------------------------------------ CSV

  var CSV_HEADER = ['予約番号', '利用日', '曜日', '開始', '終了', 'お名前', 'メールアドレス', '人数', '利用目的', '備考', '受付日時'];

  /*
   * CSV の1マス分。
   * - カンマ・改行・ダブルクォートを含むときは全体を "…" で囲み、中の " は "" にする（RFC 4180）。
   * - = + - @ で始まる値は、表計算ソフトで数式として動かないよう、先頭に ' を付ける。
   */
  function csvCell(value) {
    var s = toStr(value);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function csvRow(cells) {
    return cells.map(csvCell).join(',');
  }

  // Excel で文字化けしないよう UTF-8 の BOM を先頭に付け、行の区切りは CRLF にする。
  function toCsv(reservations) {
    var lines = [csvRow(CSV_HEADER)];
    sortReservations(reservations).forEach(function (r) {
      var created = r.createdAt ? new Date(r.createdAt) : null;
      lines.push(csvRow([
        r.id,
        r.dateKey,
        WEEKDAYS[weekdayOf(r.dateKey)],
        pad2(r.hour) + ':00',
        pad2(r.hour + 1) + ':00',
        r.name,
        r.email,
        String(r.people),
        purposeLabel(r.purpose) || r.purpose,
        r.note,
        created && !isNaN(created.getTime()) ? formatDateTime(created) : ''
      ]));
    });
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  function csvFileName(now) {
    return 'sample-room-reservations-' + toDateKey(now).replace(/-/g, '') + '.csv';
  }

  // ------------------------------------------------------------------ 公開

  var api = {
    OPEN_HOUR: OPEN_HOUR,
    CLOSE_HOUR: CLOSE_HOUR,
    DAYS_AHEAD: DAYS_AHEAD,
    CLOSED_WEEKDAY: CLOSED_WEEKDAY,
    NAME_MAX: NAME_MAX,
    NOTE_MAX: NOTE_MAX,
    PEOPLE_MIN: PEOPLE_MIN,
    PEOPLE_MAX: PEOPLE_MAX,
    STORAGE_KEY: STORAGE_KEY,
    WEEKDAYS: WEEKDAYS,
    PURPOSES: PURPOSES,
    STATUS_LABELS: STATUS_LABELS,
    FIELD_ORDER: FIELD_ORDER,
    CSV_HEADER: CSV_HEADER,

    pad2: pad2,
    toDateKey: toDateKey,
    parseDateKey: parseDateKey,
    isDateKey: isDateKey,
    addDays: addDays,
    daysBetween: daysBetween,
    formatDateJa: formatDateJa,
    formatDateLongJa: formatDateLongJa,
    formatDateTime: formatDateTime,

    generateSlots: generateSlots,
    isValidHour: isValidHour,
    slotLabel: slotLabel,
    isClosedDay: isClosedDay,
    closedReason: closedReason,
    isInRange: isInRange,
    isPastSlot: isPastSlot,
    listDates: listDates,

    demoBookedHours: demoBookedHours,
    isBooked: isBooked,
    slotStatus: slotStatus,
    isSlotAvailable: isSlotAvailable,
    dayAvailability: dayAvailability,
    firstAvailableDate: firstAvailableDate,

    charCount: charCount,
    isValidEmail: isValidEmail,
    purposeLabel: purposeLabel,
    normalizeInput: normalizeInput,
    validateFields: validateFields,
    validateSlot: validateSlot,
    validateReservation: validateReservation,

    formatReservationNumber: formatReservationNumber,
    parseReservationNumber: parseReservationNumber,
    nextSequence: nextSequence,

    emptyState: emptyState,
    parseState: parseState,
    serializeState: serializeState,
    book: book,
    cancelReservation: cancelReservation,
    sortReservations: sortReservations,

    csvCell: csvCell,
    toCsv: toCsv,
    csvFileName: csvFileName
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ReservationCore = api;
})(this);
