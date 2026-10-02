/* CSV 集計ツールの計算部分。画面（DOM）には触れない純粋な関数だけを置く。
   ブラウザでは <script src> で読み込むと window.CsvCore に、Node では require で使える。

   主な関数:
     decode(bytes)            バイト列 → 文字列（UTF-8 / UTF-8 BOM / Shift_JIS を判別）
     parseCSV(text)           RFC 4180 に沿って読み、1 行目を見出しにした表を返す
     inferTypes(headers, rows) 各列が数値の列・日付の列・文字の列のどれかを推定する
     parseNumber(value)       "1,234" "¥1,234" "1234円" "▲500" などを数値にする（読めなければ null）
     parseDate(value)         "2026/09/01" "2026-09-01" "2026/9/1" などを日付にする（読めなければ null）
     aggregate(table, opts)   グループごとに 合計・平均・件数・最大・最小 を求める
     pivot(table, opts)       行 × 列 のクロス集計（ピボット表）を作る
     toCSV(records, opts)     2 次元の配列を CSV の文字列にする（値のエスケープつき）
*/
(function (root) {
  'use strict';

  var METHODS = ['sum', 'avg', 'count', 'max', 'min'];
  var METHOD_LABELS = { sum: '合計', avg: '平均', count: '件数', max: '最大', min: '最小' };
  var BLANK_KEY = '\u0000blank';
  var BLANK_LABEL = '（空欄）';

  // ------------------------------------------------------------------ 文字コード

  /**
   * バイト列を文字列にする。
   * 1. 先頭が EF BB BF（BOM）なら UTF-8（BOM あり）
   * 2. 先頭が FF FE / FE FF（BOM）なら UTF-16（Excel の「Unicode テキスト」など）
   * 3. UTF-8 として正しく読めれば UTF-8
   * 4. どれでもなければ Shift_JIS（Windows の Excel が保存する CSV の文字コード）
   * @param {ArrayBuffer|Uint8Array} input
   * @returns {{text: string, encoding: string, label: string, replaced: number}}
   */
  function decode(input) {
    var bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    var text;
    var encoding;
    var label;
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      text = new TextDecoder('utf-8').decode(bytes.subarray(3));
      encoding = 'utf-8-bom';
      label = 'UTF-8（BOM あり）';
    } else if (bytes.length >= 2 && ((bytes[0] === 0xFF && bytes[1] === 0xFE) || (bytes[0] === 0xFE && bytes[1] === 0xFF))) {
      encoding = bytes[0] === 0xFF ? 'utf-16le' : 'utf-16be';
      text = new TextDecoder(encoding).decode(bytes.subarray(2));
      label = 'UTF-16';
    } else {
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        encoding = 'utf-8';
        label = 'UTF-8';
      } catch (e) {
        var sjis;
        try {
          sjis = new TextDecoder('shift_jis');
        } catch (e2) {
          throw new Error('この環境では Shift_JIS の文字を読めません。');
        }
        text = sjis.decode(bytes);
        encoding = 'shift_jis';
        label = 'Shift_JIS';
      }
    }
    // 読めなかったバイトは U+FFFD（�）に置き換わる。その数を数えておく
    var replaced = 0;
    for (var i = text.indexOf('\uFFFD'); i !== -1; i = text.indexOf('\uFFFD', i + 1)) replaced++;
    return { text: text, encoding: encoding, label: label, replaced: replaced };
  }

  /** ZIP（.xlsx など）の先頭バイトかどうか。CSV ではないファイルを早めに見分けるのに使う */
  function looksLikeZip(input) {
    var b = input instanceof Uint8Array ? input : new Uint8Array(input);
    return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4B && b[2] === 0x03 && b[3] === 0x04;
  }

  // ------------------------------------------------------------------ CSV の読み取り

  /**
   * CSV の文字列を、1 件ずつの値の配列（レコード）に分ける。RFC 4180 に沿う。
   * - 区切りはカンマ。改行は CRLF・LF・CR のどれでもよい（混ざっていてもよい）
   * - ダブルクォートで囲んだ値の中では、カンマも改行もそのまま値の一部。"" は " 1 文字
   * - 最後の改行はあってもなくてもよい
   * - すべての値が空のレコード（空行・カンマだけの行）は読み飛ばし、その数を blankLines に数える
   * @returns {{records: string[][], lines: number[], blankLines: number, unclosedQuote: boolean, strayQuotes: number}}
   *   lines[i] は records[i] が始まる行の番号（1 から。ファイルの物理的な行）
   */
  function parseRecords(text) {
    var s = String(text == null ? '' : text);
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    var len = s.length;
    var records = [];
    var lines = [];
    var blankLines = 0;
    var unclosedQuote = false;
    var strayQuotes = 0;

    var i = 0;
    var line = 1;
    var record = [];
    var recordLine = 1;

    function endRecord() {
      var blank = true;
      for (var k = 0; k < record.length; k++) {
        if (record[k] !== '') { blank = false; break; }
      }
      if (blank) blankLines++;
      else { records.push(record); lines.push(recordLine); }
      record = [];
    }

    if (len === 0) return { records: records, lines: lines, blankLines: 0, unclosedQuote: false, strayQuotes: 0 };

    while (true) {
      // ---- 値を 1 つ読む
      var value;
      if (i < len && s.charCodeAt(i) === 34 /* " */) {
        // 囲まれた値
        i++;
        var parts = '';
        var start = i;
        var closed = false;
        while (i < len) {
          var q = s.indexOf('"', i);
          if (q === -1) {
            // 閉じる " が無いままファイルが終わった
            for (var n = i; n < len; n++) if (s.charCodeAt(n) === 10 || (s.charCodeAt(n) === 13 && s.charCodeAt(n + 1) !== 10)) line++;
            parts += s.slice(start, len);
            i = len;
            break;
          }
          for (var m = i; m < q; m++) {
            var cm = s.charCodeAt(m);
            if (cm === 10 || (cm === 13 && s.charCodeAt(m + 1) !== 10)) line++;
          }
          if (s.charCodeAt(q + 1) === 34) {
            parts += s.slice(start, q + 1); // "" → "
            i = q + 2;
            start = i;
            continue;
          }
          parts += s.slice(start, q);
          i = q + 1;
          closed = true;
          break;
        }
        if (!closed) unclosedQuote = true;
        // 閉じた " のあとに区切り以外の文字が続く（例: "abc"def）ときは、続きをそのまま値に足す
        if (closed && i < len) {
          var c0 = s.charCodeAt(i);
          if (c0 !== 44 && c0 !== 10 && c0 !== 13) {
            strayQuotes++;
            var stop = i;
            while (stop < len) {
              var cs = s.charCodeAt(stop);
              if (cs === 44 || cs === 10 || cs === 13) break;
              stop++;
            }
            parts += s.slice(i, stop);
            i = stop;
          }
        }
        value = parts;
      } else {
        // 囲まれていない値: 次のカンマか改行まで
        var j = i;
        while (j < len) {
          var cj = s.charCodeAt(j);
          if (cj === 44 || cj === 10 || cj === 13) break;
          j++;
        }
        value = s.slice(i, j);
        i = j;
      }
      record.push(value);

      // ---- 値のあと: カンマなら同じレコードの次の値、改行ならレコードの終わり
      if (i >= len) { endRecord(); break; }
      var c = s.charCodeAt(i);
      if (c === 44) { i++; if (i >= len) { record.push(''); endRecord(); break; } continue; }
      // 改行（CRLF / LF / CR）
      if (c === 13 && s.charCodeAt(i + 1) === 10) i += 2;
      else i += 1;
      line++;
      endRecord();
      recordLine = line;
      if (i >= len) break; // 最後の改行のあとには何もない
    }

    return { records: records, lines: lines, blankLines: blankLines, unclosedQuote: unclosedQuote, strayQuotes: strayQuotes };
  }

  /**
   * CSV を読み、1 行目を見出しにした表にする。
   * 列の数が見出しより少ない行は足りない分を空欄で埋め、多い行ははみ出した値を捨てる。
   * どちらも warnings に件数と行番号（最初の数件）を残す。
   * @param {string} text
   * @param {{header?: boolean}} [options] header: false なら見出しを作らず records だけ返す
   */
  function parseCSV(text, options) {
    var opts = options || {};
    var parsed = parseRecords(text);
    var warnings = {
      blankLines: parsed.blankLines,
      unclosedQuote: parsed.unclosedQuote,
      strayQuotes: parsed.strayQuotes,
      shortRows: 0,
      longRows: 0,
      shortRowLines: [],
      longRowLines: [],
      renamedHeaders: 0
    };
    if (opts.header === false) {
      return { records: parsed.records, lines: parsed.lines, warnings: warnings };
    }
    if (parsed.records.length === 0) {
      return { headers: [], rows: [], rowLines: [], warnings: warnings };
    }

    // 見出し: 前後の空白を取り、空なら「列3」、重複していたら「店舗 (2)」のように名前をつける
    var rawHeaders = parsed.records[0];
    var headers = [];
    var seen = Object.create(null);
    for (var h = 0; h < rawHeaders.length; h++) {
      var name = String(rawHeaders[h]).trim();
      var renamed = false;
      if (name === '') { name = '列' + (h + 1); renamed = true; }
      if (seen[name]) {
        var k = 2;
        while (seen[name + ' (' + k + ')']) k++;
        name = name + ' (' + k + ')';
        renamed = true;
      }
      if (renamed) warnings.renamedHeaders++;
      seen[name] = true;
      headers.push(name);
    }

    var width = headers.length;
    var rows = new Array(parsed.records.length - 1);
    var rowLines = new Array(parsed.records.length - 1);
    var LIMIT = 5;
    for (var r = 1; r < parsed.records.length; r++) {
      var rec = parsed.records[r];
      if (rec.length < width) {
        warnings.shortRows++;
        if (warnings.shortRowLines.length < LIMIT) warnings.shortRowLines.push(parsed.lines[r]);
        while (rec.length < width) rec.push('');
      } else if (rec.length > width) {
        warnings.longRows++;
        if (warnings.longRowLines.length < LIMIT) warnings.longRowLines.push(parsed.lines[r]);
        rec.length = width;
      }
      rows[r - 1] = rec;
      rowLines[r - 1] = parsed.lines[r];
    }
    return { headers: headers, rows: rows, rowLines: rowLines, warnings: warnings };
  }

  // ------------------------------------------------------------------ 数値と日付

  // 全角の数字・記号を半角にそろえる（数値・日付の読み取り用）
  var WIDE_MAP = {
    '\uFF0C': ',', '\uFF0E': '.', '\uFF0B': '+', '\uFF0D': '-', '\u2212': '-', '\u2010': '-', '\u2011': '-',
    '\u2013': '-', '\uFF0F': '/', '\uFF1A': ':', '\uFFE5': '\u00A5', '\\': '\u00A5', '\uFF08': '(', '\uFF09': ')',
    '\u3000': ' '
  };
  // 全角の数字（０〜９）と、上の表の文字を置き換える
  var WIDE_RE = /[\uFF10-\uFF19\uFF0C\uFF0E\uFF0B\uFF0D\u2212\u2010\u2011\u2013\uFF0F\uFF1A\uFFE5\\\uFF08\uFF09\u3000]/g;
  function normalizeWidth(str) {
    return str.replace(WIDE_RE, function (ch) {
      var code = ch.charCodeAt(0);
      if (code >= 0xFF10 && code <= 0xFF19) return String.fromCharCode(code - 0xFF10 + 48);
      return WIDE_MAP[ch];
    });
  }

  var NUMBER_BODY = /^(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?$/;

  /**
   * 文字列を数値にする。読めなければ null を返す（0 にはしない）。
   * 読める書き方: "1234" "1,234" "1,234.5" "¥1,234"（"\1,234" "￥1,234" も） "1234円"
   *   前後の空白、全角数字（"１２３４"）、マイナス（"-500" "−500" "▲500" "△500" "(500)"）、"+12"
   * 桁区切りのカンマは 3 桁ごとの位置にあるときだけ認める（"1,2" は読めない値）。
   */
  function parseNumber(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return isFinite(value) ? value : null;
    var s = normalizeWidth(String(value)).trim();
    if (s === '') return null;
    var negative = false;
    var signSeen = false;
    var paren = /^\((.+)\)$/.exec(s);
    if (paren) { negative = true; signSeen = true; s = paren[1].trim(); }
    var yenSeen = false;
    for (var guard = 0; guard < 2; guard++) {
      var c = s.charAt(0);
      if (!signSeen && (c === '-' || c === '+' || c === '▲' || c === '△')) {
        negative = c !== '+';
        signSeen = true;
        s = s.slice(1).trim();
      } else if (!yenSeen && c === '¥') {
        yenSeen = true;
        s = s.slice(1).trim();
      } else {
        break;
      }
    }
    if (s.charAt(s.length - 1) === '円') s = s.slice(0, -1).trim();
    if (s === '' || s === '.' || !NUMBER_BODY.test(s)) return null;
    var n = Number(s.replace(/,/g, ''));
    if (!isFinite(n)) return null;
    if (n === 0) return 0;
    return negative ? -n : n;
  }

  /** 空欄（空白だけを含む）かどうか */
  function isBlank(value) {
    return value === null || value === undefined || String(value).trim() === '';
  }

  var DATE_SEP = /^(\d{4})([\/\-.])(\d{1,2})\2(\d{1,2})(?:[ T]+\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/;
  var DATE_KANJI = /^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:\s*\d{1,2}:\d{2}(?::\d{2})?)?$/;

  function daysInMonth(y, m) {
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  }

  /**
   * 文字列を日付にする。読めなければ null を返す。
   * 読める書き方: "2026/09/01" "2026-09-01" "2026/9/1" "2026.9.1" "2026年9月1日"
   *   （全角数字も可。うしろに "10:30" のような時刻がついていてもよい。時刻は使わない）
   * 2026/2/30 のような存在しない日付は読めない値として扱う。
   * @returns {{year: number, month: number, day: number}|null}
   */
  function parseDate(value) {
    if (value === null || value === undefined) return null;
    var s = normalizeWidth(String(value)).trim();
    if (s === '') return null;
    var m = DATE_SEP.exec(s);
    var y, mo, d;
    if (m) { y = +m[1]; mo = +m[3]; d = +m[4]; }
    else {
      m = DATE_KANJI.exec(s);
      if (!m) return null;
      y = +m[1]; mo = +m[2]; d = +m[3];
    }
    if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
    return { year: y, month: mo, day: d };
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** 日付をまとめる単位（day / month）ごとの、並べ替え用のキーと表示名 */
  function dateGroup(date, unit) {
    if (unit === 'month') {
      return { key: date.year + '-' + pad2(date.month), label: date.year + '年' + date.month + '月' };
    }
    return {
      key: date.year + '-' + pad2(date.month) + '-' + pad2(date.day),
      label: date.year + '/' + pad2(date.month) + '/' + pad2(date.day)
    };
  }

  // ------------------------------------------------------------------ 列の種類の推定

  /**
   * 各列が「数値の列」「日付の列」「文字の列」のどれかを推定する。
   * 空欄を除いた値のうち 8 割以上が日付として読めれば日付の列、数値として読めれば数値の列。
   * 大きなファイルでも速く終わるよう、見るのは先頭から sampleSize 行まで。
   * @returns {{index: number, name: string, type: 'number'|'date'|'text', filled: number, numbers: number, dates: number}[]}
   */
  function inferTypes(headers, rows, options) {
    var sampleSize = (options && options.sampleSize) || 5000;
    var limit = Math.min(rows.length, sampleSize);
    var result = [];
    for (var c = 0; c < headers.length; c++) {
      var filled = 0, numbers = 0, dates = 0;
      for (var r = 0; r < limit; r++) {
        var v = rows[r][c];
        if (isBlank(v)) continue;
        filled++;
        if (parseDate(v)) dates++;
        else if (parseNumber(v) !== null) numbers++;
      }
      var type = 'text';
      if (filled > 0) {
        if (dates / filled >= 0.8) type = 'date';
        else if (numbers / filled >= 0.8) type = 'number';
      }
      result.push({ index: c, name: headers[c], type: type, filled: filled, numbers: numbers, dates: dates });
    }
    return result;
  }

  // ------------------------------------------------------------------ 集計

  function newAcc() { return { sum: 0, n: 0, min: Infinity, max: -Infinity, rows: 0 }; }

  function addTo(acc, v) {
    acc.rows++;
    if (v !== null) {
      acc.sum += v;
      acc.n++;
      if (v < acc.min) acc.min = v;
      if (v > acc.max) acc.max = v;
    }
  }

  // 0.1 + 0.2 = 0.30000000000000004 のような誤差を、有効数字 15 桁で丸めて消す
  function tidy(v) { return v === 0 ? 0 : parseFloat(v.toPrecision(15)); }

  /** 集めた値から、集計のしかたに合わせた結果を出す。値が 1 つも無ければ null（件数は 0 以上の数） */
  function finish(acc, method) {
    switch (method) {
      case 'count': return acc.rows;
      case 'sum': return acc.n ? tidy(acc.sum) : null;
      case 'avg': return acc.n ? tidy(acc.sum / acc.n) : null;
      case 'max': return acc.n ? acc.max : null;
      case 'min': return acc.n ? acc.min : null;
      default: throw new Error('集計のしかたが正しくありません: ' + method);
    }
  }

  function summarize(acc, method) {
    return { value: finish(acc, method), n: acc.n, rows: acc.rows };
  }

  function checkColumn(table, index, what) {
    if (typeof index !== 'number' || index < 0 || index >= table.headers.length || index !== Math.floor(index)) {
      throw new Error(what + 'を選んでください。');
    }
  }

  // グループの名前（キー）を値から作る関数。読めない日付は null を返す（集計から外す）
  function makeKeyFn(dateUnit) {
    if (dateUnit === 'day' || dateUnit === 'month') {
      return function (raw) {
        var d = parseDate(raw);
        return d ? dateGroup(d, dateUnit) : null;
      };
    }
    return function (raw) {
      var t = raw === null || raw === undefined ? '' : String(raw).trim();
      return t === '' ? { key: BLANK_KEY, label: BLANK_LABEL } : { key: t, label: t };
    };
  }

  function addExample(list, raw, line) {
    if (list.length >= 3) return;
    for (var i = 0; i < list.length; i++) if (list[i].value === raw) return;
    list.push({ value: raw, line: line });
  }

  // 集計のしかたと、集計する列の組み合わせを確かめる
  function readOptions(table, opts, groupField) {
    var method = opts.method || 'sum';
    if (METHODS.indexOf(method) === -1) throw new Error('集計のしかたが正しくありません: ' + method);
    checkColumn(table, opts[groupField], 'グループにする列');
    var valueCol = method === 'count' ? null : opts.valueCol;
    if (method !== 'count') checkColumn(table, valueCol, '集計する列');
    return { method: method, valueCol: valueCol };
  }

  function newSkipped() {
    return { blankValues: 0, invalidValues: 0, invalidExamples: [], badGroups: 0, badGroupExamples: [] };
  }

  // 1 行ぶんの値を読む（count のときは値を見ない）
  function readValue(row, valueCol, skipped, line) {
    if (valueCol === null) return null;
    var raw = row[valueCol];
    if (isBlank(raw)) { skipped.blankValues++; return null; }
    var v = parseNumber(raw);
    if (v === null) { skipped.invalidValues++; addExample(skipped.invalidExamples, String(raw), line); }
    return v;
  }

  function orderGroups(list, isDate) {
    // 日付は古い順。文字はファイルに出てきた順のまま
    if (isDate) list.sort(function (a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });
    return list;
  }

  /**
   * グループごとに集計する。
   * @param {{headers: string[], rows: string[][], rowLines?: number[]}} table parseCSV の結果
   * @param {{groupBy: number, valueCol?: number, method: 'sum'|'avg'|'count'|'max'|'min', dateUnit?: 'day'|'month'}} opts
   *   dateUnit を指定すると、グループにする列を日付として読み、日ごと・月ごとにまとめる。
   * @returns {{method: string, groups: {key: string, label: string, value: number|null, n: number, rows: number}[],
   *   total: {value: number|null, n: number, rows: number}, skipped: object, totalRows: number, usedRows: number}}
   *   value は値が 1 つも読めなかったグループでは null。n は集計に使えた値の数、rows はグループの行数。
   */
  function aggregate(table, opts) {
    opts = opts || {};
    var o = readOptions(table, opts, 'groupBy');
    var keyFn = makeKeyFn(opts.dateUnit);
    var isDate = opts.dateUnit === 'day' || opts.dateUnit === 'month';
    var map = new Map();
    var list = [];
    var totalAcc = newAcc();
    var skipped = newSkipped();
    var rows = table.rows;
    var lines = table.rowLines || [];

    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var g = keyFn(row[opts.groupBy]);
      if (!g) {
        skipped.badGroups++;
        addExample(skipped.badGroupExamples, String(row[opts.groupBy] == null ? '' : row[opts.groupBy]), lines[r]);
        continue;
      }
      var entry = map.get(g.key);
      if (!entry) {
        entry = { key: g.key, label: g.label, acc: newAcc() };
        map.set(g.key, entry);
        list.push(entry);
      }
      var v = readValue(row, o.valueCol, skipped, lines[r]);
      addTo(entry.acc, v);
      addTo(totalAcc, v);
    }

    orderGroups(list, isDate);
    var groups = list.map(function (e) {
      var s = summarize(e.acc, o.method);
      return { key: e.key, label: e.label, value: s.value, n: s.n, rows: s.rows };
    });
    return {
      method: o.method,
      groups: groups,
      total: summarize(totalAcc, o.method),
      skipped: skipped,
      totalRows: rows.length,
      usedRows: totalAcc.rows
    };
  }

  /**
   * クロス集計（ピボット表）。行を rowBy の値、列を colBy の値で分けて集計する。
   * @param {{rowBy: number, colBy: number, valueCol?: number, method: string, rowDateUnit?: string, colDateUnit?: string}} opts
   * @returns {{method: string, rowGroups: {key,label}[], colGroups: {key,label}[],
   *   cells: ({value,n,rows}|null)[][], rowTotals: {value,n,rows}[], colTotals: {value,n,rows}[],
   *   total: {value,n,rows}, skipped: object, totalRows: number, usedRows: number}}
   *   cells[行][列] は、その組み合わせの行が 1 つも無ければ null。
   *   行・列の合計（rowTotals, colTotals, total）は、元の値すべてから計算する（平均の平均にはしない）。
   */
  function pivot(table, opts) {
    opts = opts || {};
    var o = readOptions(table, opts, 'rowBy');
    checkColumn(table, opts.colBy, 'さらに分ける列');
    if (opts.colBy === opts.rowBy) throw new Error('「さらに分ける列」には、グループにする列と別の列を選んでください。');
    var rowKeyFn = makeKeyFn(opts.rowDateUnit);
    var colKeyFn = makeKeyFn(opts.colDateUnit);
    var rowIsDate = opts.rowDateUnit === 'day' || opts.rowDateUnit === 'month';
    var colIsDate = opts.colDateUnit === 'day' || opts.colDateUnit === 'month';

    var rowMap = new Map(), colMap = new Map();
    var rowList = [], colList = [];
    var cellMap = new Map();
    var totalAcc = newAcc();
    var skipped = newSkipped();
    var rows = table.rows;
    var lines = table.rowLines || [];

    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var rg = rowKeyFn(row[opts.rowBy]);
      var cg = colKeyFn(row[opts.colBy]);
      if (!rg || !cg) {
        skipped.badGroups++;
        var badRaw = !rg ? row[opts.rowBy] : row[opts.colBy];
        addExample(skipped.badGroupExamples, String(badRaw == null ? '' : badRaw), lines[r]);
        continue;
      }
      var re = rowMap.get(rg.key);
      if (!re) { re = { key: rg.key, label: rg.label, acc: newAcc() }; rowMap.set(rg.key, re); rowList.push(re); }
      var ce = colMap.get(cg.key);
      if (!ce) { ce = { key: cg.key, label: cg.label, acc: newAcc() }; colMap.set(cg.key, ce); colList.push(ce); }
      var cellKey = rg.key + '\u0001' + cg.key;
      var acc = cellMap.get(cellKey);
      if (!acc) { acc = newAcc(); cellMap.set(cellKey, acc); }
      var v = readValue(row, o.valueCol, skipped, lines[r]);
      addTo(acc, v);
      addTo(re.acc, v);
      addTo(ce.acc, v);
      addTo(totalAcc, v);
    }

    orderGroups(rowList, rowIsDate);
    orderGroups(colList, colIsDate);
    var cells = rowList.map(function (re) {
      return colList.map(function (ce) {
        var acc = cellMap.get(re.key + '\u0001' + ce.key);
        return acc ? summarize(acc, o.method) : null;
      });
    });
    return {
      method: o.method,
      rowGroups: rowList.map(function (e) { return { key: e.key, label: e.label }; }),
      colGroups: colList.map(function (e) { return { key: e.key, label: e.label }; }),
      cells: cells,
      rowTotals: rowList.map(function (e) { return summarize(e.acc, o.method); }),
      colTotals: colList.map(function (e) { return summarize(e.acc, o.method); }),
      total: summarize(totalAcc, o.method),
      skipped: skipped,
      totalRows: rows.length,
      usedRows: totalAcc.rows
    };
  }

  // ------------------------------------------------------------------ CSV の書き出し

  /** 数値を、桁区切りなしで CSV に書く形にする（誤差は有効数字 15 桁で丸める） */
  function plainNumber(v) {
    if (typeof v !== 'number' || !isFinite(v)) return '';
    return String(tidy(v));
  }

  /**
   * 2 次元の配列を CSV の文字列にする。
   * - カンマ・ダブルクォート・改行を含む値、前後に空白がある値は " で囲み、中の " は "" にする
   * - 数値（number 型）は桁区切りなしで書く。null / undefined は空欄
   * - 行の区切りは CRLF（Excel と同じ）。最後の行のあとにも改行を置く
   * @param {Array<Array<string|number|null>>} records
   * @param {{bom?: boolean, guardFormulas?: boolean}} [options]
   *   bom: 先頭に BOM をつける（Excel で UTF-8 として開かせるため）
   *   guardFormulas: = + - @ で始まる文字の値（"-500" のようなただの数は除く）の先頭に ' をつけ、
   *     Excel で数式として動かないようにする
   */
  function toCSV(records, options) {
    var opts = options || {};
    var out = new Array(records.length);
    for (var r = 0; r < records.length; r++) {
      var rec = records[r];
      var fields = new Array(rec.length);
      for (var c = 0; c < rec.length; c++) fields[c] = csvField(rec[c], opts);
      out[r] = fields.join(',');
    }
    var s = records.length ? out.join('\r\n') + '\r\n' : '';
    return (opts.bom ? '\uFEFF' : '') + s;
  }

  function csvField(v, opts) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return plainNumber(v);
    var s = String(v);
    if (opts.guardFormulas && /^[=+\-@\t\r]/.test(s) && !/^[+-]?\d[\d,]*(?:\.\d+)?$/.test(s)) s = "'" + s;
    if (/[",\r\n]/.test(s) || /^\s|\s$/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  var api = {
    METHODS: METHODS,
    METHOD_LABELS: METHOD_LABELS,
    BLANK_LABEL: BLANK_LABEL,
    decode: decode,
    looksLikeZip: looksLikeZip,
    parseRecords: parseRecords,
    parseCSV: parseCSV,
    inferTypes: inferTypes,
    parseNumber: parseNumber,
    parseDate: parseDate,
    dateGroup: dateGroup,
    isBlank: isBlank,
    aggregate: aggregate,
    pivot: pivot,
    toCSV: toCSV,
    plainNumber: plainNumber
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CsvCore = api;
})(this);
