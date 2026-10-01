/* CSV 集計ツールのデモの画面部分。計算は csv-core.js（window.CsvCore）に任せ、ここでは表示と操作だけを扱う。
   読み込んだファイルはこのページの中だけで処理し、どこにも送らない（fetch するのは同じ場所の sample.csv だけ）。 */
(function () {
  'use strict';

  var C = window.CsvCore;
  function $(id) { return document.getElementById(id); }

  var MAX_BYTES = 50 * 1024 * 1024; // 50MB を超えるファイルは読まない
  var PREVIEW_ROWS = 5;
  var MAX_TABLE_ROWS = 1000;        // 表に出す行数の上限（CSV にはすべて入れる）
  var MAX_PIVOT_COLS = 100;         // ピボット表の列の種類の上限
  var MAX_CHART_BARS = 40;          // グラフに出す棒の数の上限

  var TYPE_LABELS = { number: '数値', date: '日付', text: '文字' };
  var METHOD_LABELS = C.METHOD_LABELS;

  var nf = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 2 });
  var nfInt = new Intl.NumberFormat('ja-JP');
  var nfCompact = new Intl.NumberFormat('ja-JP', { notation: 'compact', maximumFractionDigits: 1 });

  var state = {
    loadId: 0,
    fileName: '',
    table: null,
    types: [],
    model: null,  // 表とグラフに出す内容（集計のたびに作り直す）
    sort: null,   // { col: 列番号, dir: 'asc' | 'desc' }。null はもとの順
    activeBar: -1
  };

  var els = {};

  // ====================================================================== 共通

  function fmt(v) { return v === null || v === undefined ? '—' : nf.format(v); }
  function fmtTick(v) { return Math.abs(v) >= 10000 ? nfCompact.format(v) : nf.format(v); }
  function q(name) { return '「' + name + '」'; }

  function lineList(lines, total) {
    var s = lines.map(function (n) { return n + ' 行目'; }).join('、');
    return total > lines.length ? s + ' ほか' : s;
  }

  function examplesText(list) {
    return list.map(function (e) {
      var v = e.value.trim() === '' ? '（空欄）' : '「' + (e.value.length > 20 ? e.value.slice(0, 20) + '…' : e.value) + '」';
      return e.line ? e.line + ' 行目' + v : v;
    }).join('、');
  }

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) for (var k in attrs) if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // 画面を一度描かせてから重い処理をする（「読み込み中…」を先に出すため）
  function afterPaint(fn) {
    if (document.hidden || typeof requestAnimationFrame !== 'function') { setTimeout(fn, 0); return; }
    requestAnimationFrame(function () { setTimeout(fn, 0); });
  }

  // ====================================================================== 読み込み

  function setLoadStatus(text) { els.loadStatus.textContent = text; }

  function showLoadError(message) {
    // 前に読み込んだデータがあるときは、それが残っていることも伝える
    els.loadError.textContent = message + (state.table ? '（前に読み込んだ' + q(state.fileName) + 'の集計は、そのまま下に残っています）' : '');
    setLoadStatus('');
  }

  function resetLoadMessages() {
    els.loadError.textContent = '';
    clear(els.loadWarnings);
    els.loadWarnings.hidden = true;
  }

  function loadFile(file) {
    resetLoadMessages();
    if (!file) return;
    if (file.size > MAX_BYTES) {
      showLoadError('ファイルが大きすぎます（' + nf.format(file.size / 1024 / 1024) + 'MB）。このデモでは 50MB までのファイルを読み込めます。');
      return;
    }
    var id = ++state.loadId;
    setLoadStatus(q(file.name) + 'を読み込んでいます…');
    var t0 = performance.now();
    file.arrayBuffer().then(function (buf) {
      if (id !== state.loadId) return;
      afterPaint(function () { processBytes(buf, file.name, t0, id); });
    }, function () {
      if (id !== state.loadId) return;
      showLoadError('ファイルを読み込めませんでした。もう一度選び直してください。');
    });
  }

  function loadSample() {
    resetLoadMessages();
    var id = ++state.loadId;
    setLoadStatus('サンプルを読み込んでいます…');
    var t0 = performance.now();
    fetch('sample.csv', { cache: 'no-cache' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.arrayBuffer();
    }).then(function (buf) {
      if (id !== state.loadId) return;
      afterPaint(function () { processBytes(buf, 'sample.csv', t0, id); });
    }).catch(function () {
      if (id !== state.loadId) return;
      showLoadError('サンプルを読み込めませんでした。ページを開き直してから、もう一度お試しください。');
    });
  }

  function processBytes(buf, fileName, t0, id) {
    if (id !== state.loadId) return;
    var bytes = new Uint8Array(buf);
    var decoded, table;
    try {
      if (bytes.length === 0) throw new Error('ファイルが空です。');
      if (C.looksLikeZip(bytes)) {
        throw new Error('Excel のファイル（.xlsx）など、CSV ではないファイルのようです。Excel で「名前を付けて保存」から「CSV」を選んで保存したファイルを読み込んでください。');
      }
      decoded = C.decode(bytes);
      if (decoded.text.indexOf('\u0000') !== -1) throw new Error('文字のファイルではないようです。CSV ファイルを選んでください。');
      table = C.parseCSV(decoded.text);
      if (table.headers.length === 0) throw new Error('ファイルに中身がありません。');
      if (table.rows.length === 0) throw new Error('見出しの行しかありません。2 行目からデータを入れてください。');
    } catch (e) {
      showLoadError(e.message || '読み込めませんでした。');
      return;
    }

    state.fileName = fileName;
    state.table = table;
    state.types = C.inferTypes(table.headers, table.rows);
    state.sort = null;

    renderWarnings(decoded, table);
    renderPreview();
    setupForm();
    els.settingsCard.hidden = false;
    runAggregate({ fromLoad: true });

    var ms = performance.now() - t0;
    els.loadStatus.dataset.ms = String(Math.round(ms));
    els.loadStatus.dataset.encoding = decoded.encoding;
    setLoadStatus(q(fileName) + 'を読み込みました。文字コード: ' + decoded.label + ' ／ ' +
      nfInt.format(table.rows.length) + ' 行 × ' + table.headers.length + ' 列（見出しの行を除く） ／ 処理時間 ' +
      (ms / 1000).toFixed(2) + ' 秒');
  }

  function renderWarnings(decoded, table) {
    var w = table.warnings;
    var items = [];
    if (w.shortRows) items.push('列の数が見出しより少ない行が ' + nfInt.format(w.shortRows) + ' 件ありました（' + lineList(w.shortRowLines, w.shortRows) + '）。足りない値は空欄として扱います。');
    if (w.longRows) items.push('列の数が見出しより多い行が ' + nfInt.format(w.longRows) + ' 件ありました（' + lineList(w.longRowLines, w.longRows) + '）。はみ出した値は使いません。');
    if (w.unclosedQuote) items.push('「"」で始まった値が、ファイルの終わりまで閉じられていませんでした。最後のほうの行の内容を確かめてください。');
    if (w.strayQuotes) items.push('「"」の位置が正しくない値が ' + nfInt.format(w.strayQuotes) + ' 件ありました。「"」のあとの文字も、そのまま値の一部として読みました。');
    if (w.renamedHeaders) items.push('見出しが空、または同じ名前の列が ' + w.renamedHeaders + ' 件あったので、「列3」「店舗 (2)」のような名前をつけました。');
    if (w.blankLines) items.push('空の行（カンマだけの行を含む） ' + nfInt.format(w.blankLines) + ' 件は読み飛ばしました。');
    if (decoded.replaced) items.push('読めない文字が ' + nfInt.format(decoded.replaced) + ' か所ありました（「\uFFFD」と表示されます）。文字コードが UTF-8 でも Shift_JIS でもない可能性があります。');
    if (table.headers.length === 1 && /[\t;]/.test(table.headers[0])) {
      if (/^utf-16/.test(decoded.encoding) && /\t/.test(table.headers[0])) {
        items.push('列が 1 つしかありません。Excel の「Unicode テキスト」で保存したファイルは、カンマではなくタブで区切られています。Excel で「名前を付けて保存」から「CSV UTF-8（コンマ区切り）」を選んで保存し直してください。');
      } else {
        items.push('列が 1 つしかありません。値の区切りがカンマではない（タブやセミコロンで区切られている）可能性があります。');
      }
    }
    clear(els.loadWarnings);
    items.forEach(function (t) { els.loadWarnings.appendChild(el('li', null, t)); });
    els.loadWarnings.hidden = items.length === 0;
  }

  function renderPreview() {
    var t = state.table;
    clear(els.previewHead);
    clear(els.previewBody);
    var tr = el('tr');
    state.types.forEach(function (info) {
      var th = el('th', { scope: 'col', class: info.type === 'number' ? 'num' : null });
      th.appendChild(el('span', { class: 'col-name' }, info.name));
      th.appendChild(el('span', { class: 'type-badge type-badge--' + info.type }, TYPE_LABELS[info.type]));
      tr.appendChild(th);
    });
    els.previewHead.appendChild(tr);
    var n = Math.min(PREVIEW_ROWS, t.rows.length);
    for (var r = 0; r < n; r++) {
      var row = el('tr');
      for (var c = 0; c < t.headers.length; c++) {
        var v = t.rows[r][c];
        // 改行を含む値は 1 行に詰めて見せる（全文はマウスを乗せると出る）
        row.appendChild(el('td', { class: state.types[c].type === 'number' ? 'num' : null, title: v.length > 14 || /[\r\n]/.test(v) ? v : null }, v.replace(/\r\n|\r|\n/g, ' ⏎ ')));
      }
      els.previewBody.appendChild(row);
    }
    els.previewCount.textContent = String(n);
    els.preview.hidden = false;
  }

  // ====================================================================== 集計の設定

  function optionText(info) {
    return info.type === 'text' ? info.name : info.name + '（' + TYPE_LABELS[info.type] + '）';
  }

  function fillSelect(select, options, value) {
    clear(select);
    options.forEach(function (o) {
      var opt = el('option', { value: o.value }, o.text);
      if (o.disabled) opt.disabled = true;
      select.appendChild(opt);
    });
    select.value = value;
  }

  // 最初に選んでおく列を決める（グループ: 種類が 2〜50 の文字の列、集計する列: いちばん右の数値の列）
  function guessDefaults() {
    var t = state.table;
    var group = -1;
    var limit = Math.min(t.rows.length, 2000);
    for (var i = 0; i < state.types.length && group === -1; i++) {
      if (state.types[i].type !== 'text') continue;
      var seen = new Set();
      for (var r = 0; r < limit && seen.size <= 50; r++) seen.add(String(t.rows[r][i]).trim());
      if (seen.size >= 2 && seen.size <= 50) group = i;
    }
    if (group === -1) {
      for (var j = 0; j < state.types.length; j++) if (state.types[j].type !== 'number') { group = j; break; }
    }
    if (group === -1) group = 0;
    var value = -1;
    for (var k = state.types.length - 1; k >= 0; k--) if (state.types[k].type === 'number' && k !== group) { value = k; break; }
    return { group: group, value: value };
  }

  // 集計に使える列: 数値の列と、一部だけ数値の列（読めない値は集計から外し、件数を画面に出す）。
  // 数値の列を先に、一部だけ数値の列を後に並べる。数値が1つも無い列は候補にしない。
  function valueColumns() {
    var full = state.types.filter(function (info) { return info.type === 'number'; });
    var partial = state.types.filter(function (info) { return info.type !== 'number' && info.numbers > 0; });
    return full.concat(partial);
  }

  function setupForm() {
    var d = guessDefaults();
    var all = state.types.map(function (info) { return { value: String(info.index), text: optionText(info) }; });
    fillSelect(els.groupCol, [{ value: '', text: '選んでください' }].concat(all), String(d.group));
    fillColumnOptions();
    var nums = valueColumns();
    if (nums.length) {
      fillSelect(els.valueCol, nums.map(function (info) {
        return { value: String(info.index), text: info.type === 'number' ? info.name : info.name + '（一部が数値）' };
      }), String(d.value === -1 ? nums[0].index : d.value));
    } else {
      fillSelect(els.valueCol, [{ value: '', text: '（数値の列がありません）' }], '');
    }
    els.method.value = nums.length ? 'sum' : 'count';
    var monthRadio = document.querySelector('input[name="date-unit"][value="month"]');
    if (monthRadio) monthRadio.checked = true;
    clearErrors();
    updateFormState();
  }

  // 「さらに分ける列」の選択肢（グループにする列は除く）
  function fillColumnOptions() {
    var group = els.groupCol.value;
    var current = els.columnCol.value;
    var opts = [{ value: '', text: '（分けない）' }];
    state.types.forEach(function (info) {
      if (String(info.index) !== group) opts.push({ value: String(info.index), text: optionText(info) });
    });
    var keep = opts.some(function (o) { return o.value === current; }) ? current : '';
    fillSelect(els.columnCol, opts, keep);
  }

  function typeOf(indexStr) {
    if (indexStr === '' || indexStr === null) return null;
    var info = state.types[Number(indexStr)];
    return info ? info.type : null;
  }

  function updateFormState() {
    var isCount = els.method.value === 'count';
    var hasNumbers = valueColumns().length > 0;
    els.valueCol.disabled = isCount || !hasNumbers;
    if (!hasNumbers) {
      els.valueHint.textContent = '数値の列が見つからないため、「件数」だけを選べます。';
    } else if (isCount) {
      els.valueHint.textContent = '件数は行の数を数えるので、この列は使いません。';
    } else {
      els.valueHint.textContent = '数値の入っている列を選べます。「1,234」「¥1,234」「1234円」「▲500」や全角の数字も、数値として読みます。読めない値は集計から外し、その件数を下に出します。';
    }
    // 数値の列が無いときは、件数以外を選べなくする
    Array.prototype.forEach.call(els.method.options, function (o) { o.disabled = !hasNumbers && o.value !== 'count'; });
    var showDate = typeOf(els.groupCol.value) === 'date' || typeOf(els.columnCol.value) === 'date';
    els.dateUnit.hidden = !showDate;
  }

  function clearErrors() {
    [['groupCol', 'errGroup'], ['columnCol', 'errColumn'], ['valueCol', 'errValue']].forEach(function (p) {
      els[p[0]].removeAttribute('aria-invalid');
      els[p[1]].textContent = '';
    });
  }

  function setError(selectKey, errKey, message) {
    els[selectKey].setAttribute('aria-invalid', 'true');
    els[errKey].textContent = message;
  }

  function readForm() {
    var unitInput = document.querySelector('input[name="date-unit"]:checked');
    var unit = unitInput ? unitInput.value : 'month';
    var group = els.groupCol.value === '' ? null : Number(els.groupCol.value);
    var column = els.columnCol.value === '' ? null : Number(els.columnCol.value);
    var method = els.method.value;
    var value = els.valueCol.value === '' ? null : Number(els.valueCol.value);
    return {
      group: group,
      column: column,
      method: method,
      value: method === 'count' ? null : value,
      groupUnit: group !== null && state.types[group].type === 'date' ? unit : null,
      columnUnit: column !== null && state.types[column].type === 'date' ? unit : null
    };
  }

  // ====================================================================== 集計

  function runAggregate(options) {
    if (!state.table) return;
    var opts = options || {};
    clearErrors();
    var f = readForm();
    var ok = true;
    if (f.group === null) { setError('groupCol', 'errGroup', 'グループにする列を選んでください。'); ok = false; }
    if (f.method !== 'count' && f.value === null) { setError('valueCol', 'errValue', '集計する列を選んでください。'); ok = false; }
    if (!ok) { hideResult(); return false; }

    var t = state.table;
    var names = t.headers;
    var model;
    if (f.column === null) {
      var agg = C.aggregate(t, { groupBy: f.group, valueCol: f.value, method: f.method, dateUnit: f.groupUnit });
      model = buildGroupModel(agg, f, names);
    } else {
      var pv = C.pivot(t, { rowBy: f.group, colBy: f.column, valueCol: f.value, method: f.method, rowDateUnit: f.groupUnit, colDateUnit: f.columnUnit });
      if (pv.colGroups.length > MAX_PIVOT_COLS) {
        setError('columnCol', 'errColumn', q(names[f.column]) + 'は値の種類が ' + nfInt.format(pv.colGroups.length) + ' 個あり、表の列にするには多すぎます（' + MAX_PIVOT_COLS + ' 個まで）。種類の少ない列を選んでください。');
        hideResult();
        return false;
      }
      model = buildPivotModel(pv, f, names);
    }
    state.model = model;
    state.sort = model.defaultSort;
    renderResult();
    if (opts.focus) els.resultTitle.focus();
    return true;
  }

  function hideResult() {
    state.model = null;
    els.resultCard.hidden = true;
  }

  function unitWord(unit) { return unit === 'month' ? '月' : unit === 'day' ? '日' : ''; }

  function groupWord(name, unit) {
    return unit ? q(name) + 'の' + unitWord(unit) + 'ごと' : q(name) + 'ごと';
  }

  function pivotWord(name, unit) {
    return unit ? q(name) + '（' + unitWord(unit) + 'ごと）' : q(name);
  }

  function valueWord(f, names) {
    return f.method === 'count' ? '件数' : q(names[f.value]) + 'の' + METHOD_LABELS[f.method];
  }

  function totalLabel(method) {
    return method === 'sum' || method === 'count' ? '合計' : '全体の' + METHOD_LABELS[method];
  }

  // 集計から外した値についての説明
  function skippedNotes(res, f, names) {
    var notes = [];
    var s = res.skipped;
    if (s.badGroups) {
      notes.push({ warn: true, text: '日付として読めない（または空欄の）行が ' + nfInt.format(s.badGroups) + ' 件ありました（' + examplesText(s.badGroupExamples) + (s.badGroups > s.badGroupExamples.length ? ' など' : '') + '）。集計から外しています。' });
    }
    if (f.method !== 'count') {
      var vname = q(names[f.value]);
      if (s.invalidValues) {
        notes.push({ warn: true, text: vname + 'に数値として読めない値が ' + nfInt.format(s.invalidValues) + ' 件ありました（' + examplesText(s.invalidExamples) + (s.invalidValues > s.invalidExamples.length ? ' など' : '') + '）。0 とはみなさず、集計から外しています。' });
      }
      if (s.blankValues) {
        notes.push({ warn: true, text: vname + 'が空欄の行が ' + nfInt.format(s.blankValues) + ' 件ありました。0 とはみなさず、集計から外しています。' });
      }
    }
    return notes;
  }

  function buildGroupModel(agg, f, names) {
    var isDate = !!f.groupUnit;
    var nonNeg = agg.groups.every(function (g) { return g.value === null || g.value >= 0; });
    var showShare = (f.method === 'count' && agg.total.rows > 0) || (f.method === 'sum' && nonNeg && agg.total.value > 0);
    var showN = f.method !== 'count';
    var groupHeader = names[f.group] + (isDate ? '（' + unitWord(f.groupUnit) + '）' : '');
    var valueHeader = f.method === 'count' ? '件数' : names[f.value] + 'の' + METHOD_LABELS[f.method];

    var columns = [{ label: groupHeader, kind: 'label' }, { label: valueHeader, kind: 'num' }];
    if (showN) columns.push({ label: '使った値の数', kind: 'num' });
    if (showShare) columns.push({ label: '割合', kind: 'num' });

    var denom = f.method === 'count' ? agg.total.rows : agg.total.value;
    var rows = agg.groups.map(function (g, i) {
      var share = showShare && g.value !== null ? g.value / denom : null;
      var cells = [
        { text: g.label, sort: isDate ? g.key : g.label, raw: g.label },
        { text: fmt(g.value), sort: g.value, raw: g.value }
      ];
      if (showN) cells.push({ text: nfInt.format(g.n), sort: g.n, raw: g.n });
      if (showShare) cells.push({ text: share === null ? '—' : (share * 100).toFixed(1) + '%', sort: share, raw: share === null ? null : Math.round(share * 1000) / 10 });
      return { order: i, label: g.label, value: g.value, n: g.n, share: share, cells: cells };
    });

    var footer = [{ text: totalLabel(f.method), raw: totalLabel(f.method) }, { text: fmt(agg.total.value), raw: agg.total.value }];
    if (showN) footer.push({ text: nfInt.format(agg.total.n), raw: agg.total.n });
    if (showShare) footer.push({ text: '100%', raw: 100 });

    var exportHeader = columns.map(function (c) { return c.label === '割合' ? '割合（%）' : c.label; });
    var title = groupWord(names[f.group], f.groupUnit) + 'の' + valueWord(f, names);

    return {
      kind: 'groups',
      title: title,
      method: f.method,
      columns: columns,
      rows: rows,
      footer: footer,
      exportHeader: exportHeader,
      notes: skippedNotes(agg, f, names),
      groupCount: agg.groups.length,
      usedRows: agg.usedRows,
      totalRows: agg.totalRows,
      // 日付は古い順、文字は値の大きい順から始める
      defaultSort: isDate ? { col: 0, dir: 'asc' } : { col: 1, dir: 'desc' },
      chartTitle: title,
      fileBase: '集計_' + names[f.group] + (isDate ? '_' + unitWord(f.groupUnit) + 'ごと' : '') + '_' + (f.method === 'count' ? '件数' : names[f.value] + '_' + METHOD_LABELS[f.method])
    };
  }

  function buildPivotModel(pv, f, names) {
    var rowIsDate = !!f.groupUnit;
    var rowHeader = names[f.group] + (rowIsDate ? '（' + unitWord(f.groupUnit) + '）' : '') + ' ＼ ' + names[f.column] + (f.columnUnit ? '（' + unitWord(f.columnUnit) + '）' : '');
    var rowTotalLabel = f.method === 'sum' || f.method === 'count' ? '合計' : METHOD_LABELS[f.method] + '（行全体）';
    var columns = [{ label: rowHeader, kind: 'label' }];
    pv.colGroups.forEach(function (cg) { columns.push({ label: cg.label, kind: 'num' }); });
    columns.push({ label: rowTotalLabel, kind: 'num', total: true });

    var rows = pv.rowGroups.map(function (rg, i) {
      var cells = [{ text: rg.label, sort: rowIsDate ? rg.key : rg.label, raw: rg.label }];
      pv.cells[i].forEach(function (cell) {
        var v = cell ? cell.value : null;
        cells.push({ text: fmt(v), sort: v, raw: v, empty: v === null });
      });
      var tv = pv.rowTotals[i].value;
      cells.push({ text: fmt(tv), sort: tv, raw: tv, total: true });
      return { order: i, label: rg.label, cells: cells };
    });

    var footLabel = f.method === 'sum' || f.method === 'count' ? '合計' : METHOD_LABELS[f.method] + '（列全体）';
    var footer = [{ text: footLabel, raw: footLabel }];
    pv.colTotals.forEach(function (t) { footer.push({ text: fmt(t.value), raw: t.value }); });
    footer.push({ text: fmt(pv.total.value), raw: pv.total.value, total: true });

    var title = pivotWord(names[f.group], f.groupUnit) + '×' + pivotWord(names[f.column], f.columnUnit) + 'の' + valueWord(f, names) + '（ピボット表）';
    return {
      kind: 'pivot',
      title: title,
      method: f.method,
      columns: columns,
      rows: rows,
      footer: footer,
      exportHeader: columns.map(function (c) { return c.label; }),
      notes: skippedNotes(pv, f, names),
      groupCount: pv.rowGroups.length,
      colCount: pv.colGroups.length,
      usedRows: pv.usedRows,
      totalRows: pv.totalRows,
      defaultSort: rowIsDate ? { col: 0, dir: 'asc' } : null,
      fileBase: 'ピボット_' + names[f.group] + '×' + names[f.column] + '_' + (f.method === 'count' ? '件数' : names[f.value] + '_' + METHOD_LABELS[f.method])
    };
  }

  // ====================================================================== 並べ替え

  var collator = new Intl.Collator('ja', { numeric: true });

  function sortedRows() {
    var m = state.model;
    var rows = m.rows.slice();
    var s = state.sort;
    if (!s) return rows;
    var col = s.col;
    var dir = s.dir === 'asc' ? 1 : -1;
    var isLabel = m.columns[col].kind === 'label';
    rows.sort(function (a, b) {
      var x = a.cells[col].sort, y = b.cells[col].sort;
      // 値の無いもの（—）は、どちらの向きでも最後
      if (x === null && y === null) return a.order - b.order;
      if (x === null) return 1;
      if (y === null) return -1;
      var c = isLabel ? collator.compare(String(x), String(y)) : x - y;
      return c !== 0 ? c * dir : a.order - b.order;
    });
    return rows;
  }

  function onSortClick(col) {
    var m = state.model;
    var s = state.sort;
    if (s && s.col === col) state.sort = { col: col, dir: s.dir === 'asc' ? 'desc' : 'asc' };
    else state.sort = { col: col, dir: m.columns[col].kind === 'label' ? 'asc' : 'desc' };
    renderTable();
    renderChart();
    var btn = els.resultHead.querySelector('button[data-col="' + col + '"]');
    if (btn) btn.focus();
    var label = m.columns[col].label;
    els.resultStatus.textContent = q(label) + 'の' + (state.sort.dir === 'asc' ? '小さい順（昇順）' : '大きい順（降順）') + 'に並べ替えました。';
  }

  // ====================================================================== 結果の表示

  function renderResult() {
    var m = state.model;
    els.resultCard.hidden = false;
    els.resultHeading.textContent = m.title;
    els.resultCaption.textContent = m.title;
    var summary = m.kind === 'pivot'
      ? nfInt.format(m.groupCount) + ' 行 × ' + nfInt.format(m.colCount) + ' 列のピボット表にしました。'
      : nfInt.format(m.groupCount) + ' グループに分けました。';
    summary += '集計に使った行は ' + nfInt.format(m.usedRows) + ' 行です（全 ' + nfInt.format(m.totalRows) + ' 行）。';
    els.resultStatus.textContent = summary;

    clear(els.resultNotes);
    m.notes.forEach(function (n) { els.resultNotes.appendChild(el('li', { class: n.warn ? 'is-warn' : null }, n.text)); });
    els.resultNotes.hidden = m.notes.length === 0;
    els.saveStatus.textContent = '';

    renderTable();
    renderChart();
  }

  function renderTable() {
    var m = state.model;
    var rows = sortedRows();
    clear(els.resultHead);
    clear(els.resultBody);
    clear(els.resultFoot);

    var tr = el('tr');
    m.columns.forEach(function (c, i) {
      var cls = ['sortable'];
      if (c.kind === 'num') cls.push('num');
      if (c.total) cls.push('total-col');
      var th = el('th', { scope: 'col', class: cls.join(' ') });
      var sorted = state.sort && state.sort.col === i;
      if (sorted) th.setAttribute('aria-sort', state.sort.dir === 'asc' ? 'ascending' : 'descending');
      var btn = el('button', { type: 'button', class: 'sort-btn', 'data-col': String(i) });
      btn.appendChild(el('span', { class: 'sort-label' }, c.label));
      btn.appendChild(el('span', { class: 'sort-mark', 'aria-hidden': 'true' }, sorted ? (state.sort.dir === 'asc' ? '▲' : '▼') : '⇅'));
      btn.addEventListener('click', function () { onSortClick(i); });
      th.appendChild(btn);
      tr.appendChild(th);
    });
    els.resultHead.appendChild(tr);

    var frag = document.createDocumentFragment();
    var shown = Math.min(rows.length, MAX_TABLE_ROWS);
    for (var r = 0; r < shown; r++) {
      var row = rows[r];
      var rtr = el('tr');
      row.cells.forEach(function (cell, i) {
        var node;
        if (i === 0) {
          node = el('th', { scope: 'row', class: 'label-cell' + (Array.from(cell.text).length > 16 ? ' is-long' : '') }, cell.text);
        } else {
          var cls = ['num'];
          if (cell.empty) cls.push('empty');
          if (cell.total) cls.push('total-col');
          node = el('td', { class: cls.join(' ') }, cell.text);
          if (cell.raw !== null && cell.raw !== undefined) node.dataset.value = String(cell.raw);
        }
        rtr.appendChild(node);
      });
      frag.appendChild(rtr);
    }
    els.resultBody.appendChild(frag);

    var ftr = el('tr');
    m.footer.forEach(function (cell, i) {
      var node = i === 0 ? el('th', { scope: 'row' }, cell.text) : el('td', { class: 'num' + (cell.total ? ' total-col' : '') }, cell.text);
      if (i > 0 && cell.raw !== null && cell.raw !== undefined) node.dataset.value = String(cell.raw);
      ftr.appendChild(node);
    });
    els.resultFoot.appendChild(ftr);

    updateScrollHint();

    if (rows.length > shown) {
      els.tableLimitNote.textContent = '表には並び順で先頭の ' + nfInt.format(shown) + ' 行だけを表示しています（全 ' + nfInt.format(rows.length) + ' 行）。保存する CSV にはすべての行が入ります。';
      els.tableLimitNote.hidden = false;
    } else {
      els.tableLimitNote.hidden = true;
    }
  }

  // 表が枠からはみ出すとき（スマホでのピボット表など）は、横にずらせることを知らせる
  function updateScrollHint() {
    var wrap = els.resultWrap;
    els.tableScrollHint.hidden = !(wrap && wrap.scrollWidth > wrap.clientWidth + 1);
  }

  // ====================================================================== グラフ（1 系列の横棒）

  var measureCtx = null;
  function textWidth(text, font) {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    measureCtx.font = font;
    return measureCtx.measureText(text).width;
  }

  function fitText(text, maxWidth, font) {
    if (textWidth(text, font) <= maxWidth) return text;
    var chars = Array.from(text);
    var lo = 0, hi = chars.length;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (textWidth(chars.slice(0, mid).join('') + '…', font) <= maxWidth) lo = mid; else hi = mid - 1;
    }
    return chars.slice(0, lo).join('') + '…';
  }

  function niceStep(range, count) {
    var raw = range / Math.max(1, count);
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
    return step * mag;
  }

  var SVG_NS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs, text) {
    var node = document.createElementNS(SVG_NS, tag);
    for (var k in attrs) node.setAttribute(k, attrs[k]);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // 棒の形: 値の側の端だけ角を 4px 丸め、0 の側は四角のまま
  function barPath(x0, x1, y, h) {
    var w = Math.abs(x1 - x0);
    var r = Math.min(4, w, h / 2);
    if (x1 >= x0) {
      return 'M' + x0 + ',' + y + 'H' + (x1 - r) + 'A' + r + ',' + r + ' 0 0 1 ' + x1 + ',' + (y + r) +
        'V' + (y + h - r) + 'A' + r + ',' + r + ' 0 0 1 ' + (x1 - r) + ',' + (y + h) + 'H' + x0 + 'Z';
    }
    return 'M' + x0 + ',' + y + 'H' + (x1 + r) + 'A' + r + ',' + r + ' 0 0 0 ' + x1 + ',' + (y + r) +
      'V' + (y + h - r) + 'A' + r + ',' + r + ' 0 0 0 ' + (x1 + r) + ',' + (y + h) + 'H' + x0 + 'Z';
  }

  var chartItems = [];
  var lastChartWidth = 0;

  function renderChart() {
    var m = state.model;
    hideTooltip();
    clear(els.chartPlot);
    els.chartNote.hidden = true;
    chartItems = [];
    if (!m || m.kind !== 'groups') {
      els.chart.hidden = true;
      if (m && m.kind === 'pivot') {
        els.chartNote.textContent = 'ピボット表のときは、グラフは出さずに表だけを表示します。';
        els.chartNote.hidden = false;
      }
      return;
    }
    var rows = sortedRows();
    var withValue = rows.filter(function (r) { return r.value !== null; });
    if (rows.length < 2 || withValue.length === 0) {
      els.chart.hidden = true;
      els.chartNote.textContent = rows.length < 2 ? 'グループが 1 つだけなので、グラフは出さずに表だけを表示します。' : '集計できる値が無いため、グラフは出していません。';
      els.chartNote.hidden = false;
      return;
    }
    chartItems = rows.slice(0, MAX_CHART_BARS);
    els.chart.hidden = false;
    els.chartCaption.textContent = 'グラフ: ' + m.chartTitle + '（表と同じ並び順）';
    if (rows.length > MAX_CHART_BARS) {
      els.chartNote.textContent = 'グラフには、表の並び順で先頭の ' + MAX_CHART_BARS + ' 件だけを表示しています（全 ' + nfInt.format(rows.length) + ' 件は表で見られます）。';
      els.chartNote.hidden = false;
    }
    drawChart();
  }

  function drawChart() {
    clear(els.chartPlot);
    if (!chartItems.length) return;
    var items = chartItems;
    var fontFamily = getComputedStyle(document.body).fontFamily;
    var catFont = '13px ' + fontFamily;
    var valFont = '12px ' + fontFamily;
    var W = Math.max(260, Math.floor(els.chartPlot.clientWidth || 600));
    lastChartWidth = W;

    var ROW = 32, BAR = 20, TOP = 4, AXIS = 26, GAP = 8;
    var maxLabel = 0, maxValue = 0;
    items.forEach(function (it) {
      maxLabel = Math.max(maxLabel, textWidth(it.label, catFont));
      maxValue = Math.max(maxValue, textWidth(fmt(it.value), valFont));
    });
    var labelW = Math.ceil(Math.min(maxLabel + 12, W * (W < 480 ? 0.34 : 0.26)));
    var valueW = Math.ceil(maxValue + 12);
    var plotL = labelW + GAP;
    var plotR = W - valueW;

    var vals = items.map(function (it) { return it.value; }).filter(function (v) { return v !== null; });
    var d0 = Math.min(0, Math.min.apply(null, vals));
    var d1 = Math.max(0, Math.max.apply(null, vals));
    if (d0 === d1) d1 = 1;
    function x(v) { return plotL + (v - d0) / (d1 - d0) * (plotR - plotL); }
    var x0 = x(0);

    var H = TOP + items.length * ROW + AXIS;
    var root = svg('svg', {
      viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, role: 'img', tabindex: '0',
      'aria-label': '横棒グラフ: ' + state.model.chartTitle + '。上下の矢印キーで 1 本ずつ値を読み上げます。'
    });

    // 目盛り（細い実線）
    var tickCount = Math.max(3, Math.min(8, Math.floor((plotR - plotL) / 56)));
    var step = niceStep(d1 - d0, tickCount);
    var gGrid = svg('g', { 'aria-hidden': 'true' });
    var plotBottom = TOP + items.length * ROW;
    var lastTickRight = -Infinity;
    for (var t = Math.ceil(d0 / step) * step; t <= d1 + step * 1e-9; t += step) {
      var tv = Math.abs(t) < step * 1e-9 ? 0 : parseFloat(t.toPrecision(12));
      var tx = Math.round(x(tv)) + 0.5;
      gGrid.appendChild(svg('line', { class: tv === 0 ? 'zero' : 'grid', x1: tx, x2: tx, y1: TOP, y2: plotBottom }));
      var label = fmtTick(tv);
      var lw = textWidth(label, valFont);
      var anchor = 'middle', lx = tx;
      if (tx + lw / 2 > W) { anchor = 'end'; lx = W; }
      if (lx - (anchor === 'middle' ? lw / 2 : lw) < lastTickRight + 6) continue; // 重なる目盛りの数字は省く
      gGrid.appendChild(svg('text', { class: 'tick', x: lx, y: plotBottom + 18, 'text-anchor': anchor }, label));
      lastTickRight = anchor === 'middle' ? lx + lw / 2 : lx;
    }
    root.appendChild(gGrid);

    // 棒・項目名・値
    var gBars = svg('g', {});
    items.forEach(function (it, i) {
      var rowTop = TOP + i * ROW;
      var y = rowTop + (ROW - BAR) / 2;
      var g = svg('g', { class: 'bar-row', 'data-index': String(i) });
      var name = fitText(it.label, labelW - 4, catFont);
      g.appendChild(svg('text', { class: 'cat', x: labelW, y: rowTop + ROW / 2 + 4.5, 'text-anchor': 'end' }, name));
      if (it.value !== null) {
        var x1 = x(it.value);
        if (Math.abs(x1 - x0) >= 0.5) g.appendChild(svg('path', { class: 'bar', d: barPath(x0, x1, y, BAR) }));
        var vx = it.value >= 0 ? Math.max(x1, x0) + 6 : x0 + 6;
        g.appendChild(svg('text', { class: 'val', x: vx, y: rowTop + ROW / 2 + 4 }, fmt(it.value)));
      } else {
        g.appendChild(svg('text', { class: 'val val--none', x: x0 + 6, y: rowTop + ROW / 2 + 4 }, '—'));
      }
      // 指で触れる範囲は、棒より広く行全体にする
      var hit = svg('rect', { class: 'hit', x: 0, y: rowTop, width: W, height: ROW });
      hit.addEventListener('pointerenter', function (e) { activateBar(i, e); });
      hit.addEventListener('pointermove', function (e) { activateBar(i, e); });
      g.appendChild(hit);
      gBars.appendChild(g);
    });
    root.appendChild(gBars);

    root.addEventListener('pointerleave', function () { if (document.activeElement !== root) hideTooltip(); });
    root.addEventListener('focus', function () { activateBar(state.activeBar >= 0 ? state.activeBar : 0, null, true); });
    root.addEventListener('blur', hideTooltip);
    root.addEventListener('keydown', onChartKey);
    els.chartPlot.appendChild(root);
  }

  function onChartKey(e) {
    var n = chartItems.length;
    if (!n) return;
    var i = state.activeBar < 0 ? 0 : state.activeBar;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') i = Math.min(n - 1, i + 1);
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') i = Math.max(0, i - 1);
    else if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = n - 1;
    else if (e.key === 'Escape') { hideTooltip(); return; }
    else return;
    e.preventDefault();
    activateBar(i, null, true);
  }

  function tooltipLines(it) {
    var m = state.model;
    var sub = [];
    if (it.share !== null && it.share !== undefined) sub.push('全体の ' + (it.share * 100).toFixed(1) + '%');
    if (m.method !== 'count') sub.push(nfInt.format(it.n) + ' 件の値から計算');
    return { value: it.value === null ? '値なし（読める値がありません）' : fmt(it.value), label: it.label, sub: sub.join(' ・ ') };
  }

  function activateBar(i, evt, fromKeyboard) {
    var it = chartItems[i];
    if (!it) return;
    state.activeBar = i;
    var rowsEls = els.chartPlot.querySelectorAll('.bar-row');
    Array.prototype.forEach.call(rowsEls, function (g, k) {
      var bar = g.querySelector('.bar');
      if (bar) bar.classList.toggle('is-active', k === i);
    });
    var lines = tooltipLines(it);
    var tt = els.chartTooltip;
    clear(tt);
    tt.appendChild(el('span', { class: 'tt-value' }, lines.value));
    var lab = el('span', { class: 'tt-label' });
    lab.appendChild(el('span', { class: 'tt-key', 'aria-hidden': 'true' }));
    lab.appendChild(document.createTextNode(lines.label));
    tt.appendChild(lab);
    if (lines.sub) tt.appendChild(el('span', { class: 'tt-sub' }, lines.sub));
    tt.hidden = false;

    // 位置: マウスならポインタの近く、キーボードならその行の右寄り
    var fig = els.chart.getBoundingClientRect();
    var plot = els.chartPlot.getBoundingClientRect();
    var svgEl = els.chartPlot.querySelector('svg');
    var scale = svgEl ? plot.width / lastChartWidth : 1;
    var px, py;
    if (evt && !fromKeyboard) {
      px = evt.clientX - fig.left + 14;
      py = evt.clientY - fig.top + 14;
    } else {
      px = plot.left - fig.left + plot.width * 0.45;
      py = plot.top - fig.top + (4 + i * 32 + 32) * scale + 4;
    }
    var maxX = fig.width - tt.offsetWidth - 4;
    tt.style.left = Math.max(0, Math.min(px, maxX)) + 'px';
    tt.style.top = py + 'px';
    if (fromKeyboard) {
      els.chartLive.textContent = (i + 1) + ' / ' + chartItems.length + ' 本目: ' + lines.label + '、' + lines.value + (lines.sub ? '（' + lines.sub + '）' : '');
    }
  }

  function hideTooltip() {
    state.activeBar = -1;
    if (els.chartTooltip) els.chartTooltip.hidden = true;
    if (els.chartPlot) {
      Array.prototype.forEach.call(els.chartPlot.querySelectorAll('.bar.is-active'), function (b) { b.classList.remove('is-active'); });
    }
  }

  // ====================================================================== 保存

  function safeFileName(base) {
    var s = base.replace(/[\\\/:*?"<>|\s]+/g, '_').replace(/_+/g, '_');
    if (s.length > 80) s = s.slice(0, 80);
    return s + '.csv';
  }

  function buildExportRecords() {
    var m = state.model;
    var records = [m.exportHeader.slice()];
    sortedRows().forEach(function (row) {
      records.push(row.cells.map(function (c) { return c.raw === undefined ? null : c.raw; }));
    });
    records.push(m.footer.map(function (c) { return c.raw === undefined ? null : c.raw; }));
    return records;
  }

  function saveCSV() {
    if (!state.model) return;
    var text = C.toCSV(buildExportRecords(), { bom: true, guardFormulas: true });
    var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: safeFileName(state.model.fileBase) });
    a.hidden = true;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    els.saveStatus.textContent = q(a.getAttribute('download')) + 'として保存しました（' + nfInt.format(state.model.rows.length) + ' 行と合計の行）。';
  }

  // ====================================================================== はじめに

  function init() {
    [
      'loadStatus:load-status', 'loadError:load-error', 'loadWarnings:load-warnings',
      'preview:preview', 'previewHead:preview-head', 'previewBody:preview-body', 'previewCount:preview-count',
      'settingsCard:settings-card', 'form:settings-form', 'groupCol:group-col', 'columnCol:column-col',
      'method:method', 'valueCol:value-col', 'valueHint:value-hint', 'dateUnit:date-unit',
      'errGroup:err-group', 'errColumn:err-column', 'errValue:err-value',
      'resultCard:result-card', 'resultTitle:result-title', 'resultHeading:result-heading', 'resultStatus:result-status',
      'resultNotes:result-notes', 'chart:chart', 'chartCaption:chart-caption', 'chartPlot:chart-plot',
      'chartTooltip:chart-tooltip', 'chartLive:chart-live', 'chartNote:chart-note',
      'resultCaption:result-caption', 'resultHead:result-head', 'resultBody:result-body', 'resultFoot:result-foot',
      'tableLimitNote:table-limit-note', 'resultWrap:result-wrap', 'tableScrollHint:table-scroll-hint', 'saveStatus:save-status', 'fileInput:file-input', 'dropzone:dropzone'
    ].forEach(function (pair) {
      var p = pair.split(':');
      els[p[0]] = $(p[1]);
    });

    els.fileInput.addEventListener('change', function () {
      var file = els.fileInput.files && els.fileInput.files[0];
      loadFile(file);
      els.fileInput.value = ''; // 同じファイルをもう一度選んでも読み込めるように
    });
    $('load-sample').addEventListener('click', loadSample);

    // ドラッグ＆ドロップ
    var dz = els.dropzone;
    var depth = 0;
    dz.addEventListener('dragenter', function (e) { e.preventDefault(); depth++; dz.classList.add('is-over'); });
    dz.addEventListener('dragover', function (e) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
    dz.addEventListener('dragleave', function () { depth = Math.max(0, depth - 1); if (!depth) dz.classList.remove('is-over'); });
    dz.addEventListener('drop', function (e) {
      e.preventDefault();
      depth = 0;
      dz.classList.remove('is-over');
      var files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      loadFile(files[0]);
      if (files.length > 1) {
        // 読み込みの知らせのあとに出す
        setTimeout(function () {
          els.loadWarnings.appendChild(el('li', null, 'ファイルが ' + files.length + ' 個ドロップされたので、1 つ目（' + files[0].name + '）だけを読み込みました。'));
          els.loadWarnings.hidden = false;
        }, 0);
      }
    });
    // 枠の外に落としたときに、ブラウザがファイルを開いてページを離れないようにする
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { e.preventDefault(); });

    // 集計の設定
    els.groupCol.addEventListener('change', function () { fillColumnOptions(); updateFormState(); runAggregate(); });
    els.columnCol.addEventListener('change', function () { updateFormState(); runAggregate(); });
    els.method.addEventListener('change', function () { updateFormState(); runAggregate(); });
    els.valueCol.addEventListener('change', function () { runAggregate(); });
    Array.prototype.forEach.call(document.querySelectorAll('input[name="date-unit"]'), function (r) {
      r.addEventListener('change', function () { runAggregate(); });
    });
    els.form.addEventListener('submit', function (e) {
      e.preventDefault();
      runAggregate({ focus: true });
    });

    $('save-csv').addEventListener('click', saveCSV);

    // 幅が変わったらグラフを描き直す
    if (typeof ResizeObserver === 'function') {
      var pending = false;
      var ro = new ResizeObserver(function () {
        if (pending) return;
        pending = true;
        requestAnimationFrame(function () {
          pending = false;
          var w = Math.floor(els.chartPlot.clientWidth);
          if (chartItems.length && w > 0 && Math.abs(w - lastChartWidth) >= 2) drawChart();
          if (state.model) updateScrollHint();
        });
      });
      ro.observe(els.chartPlot);
      ro.observe(els.resultWrap);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
