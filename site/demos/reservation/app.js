/*
 * 予約フォームのデモ — 画面の動き。
 * 計算や判定はすべて reservation-core.js（ReservationCore）に任せ、ここでは表示と操作だけを扱う。
 * データはこのブラウザの localStorage にだけ保存する（通信はしない）。
 */
(function () {
  'use strict';

  var C = window.ReservationCore;
  var KEY = C.STORAGE_KEY;

  function $(id) {
    return document.getElementById(id);
  }

  // 要素を作る小さな関数。文字は必ず textContent で入れる（入力内容を HTML として扱わない）。
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === false || v === null || v === undefined) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, String(v));
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }

  // ---------------------------------------------------------------- 保存（localStorage）

  var memory = C.emptyState(); // 保存できないブラウザでも動くよう、手元にも持っておく
  var storageOk = true;

  function markStorageUnavailable() {
    if (!storageOk) return;
    storageOk = false;
    $('storage-warning').hidden = false;
  }

  function loadState() {
    if (!storageOk) return memory;
    try {
      memory = C.parseState(window.localStorage.getItem(KEY));
    } catch (e) {
      markStorageUnavailable();
    }
    return memory;
  }

  function saveState(state) {
    memory = state;
    if (!storageOk) return false;
    try {
      window.localStorage.setItem(KEY, C.serializeState(state));
      return true;
    } catch (e) {
      markStorageUnavailable();
      return false;
    }
  }

  function clearState() {
    memory = C.emptyState();
    if (!storageOk) return;
    try {
      window.localStorage.removeItem(KEY);
    } catch (e) {
      markStorageUnavailable();
    }
  }

  // ---------------------------------------------------------------- 画面の状態

  var ui = {
    dateKey: null, // 選んでいる日
    hour: null, // 選んでいる時間（開始の「時」）
    view: 'form', // 'form' | 'confirm' | 'done'
    draft: null, // 確認画面に出している入力内容
    submitted: false, // 一度でも「確認する」を押したか（押した後は入力のたびにエラーを更新する）
    cancelId: null
  };

  var form = $('reserve-form');
  var fields = {
    name: $('f-name'),
    email: $('f-email'),
    people: $('f-people'),
    purpose: $('f-purpose'),
    note: $('f-note')
  };

  function now() {
    return new Date();
  }

  // ---------------------------------------------------------------- 日付の一覧

  function daySummaryText(info) {
    if (info.summary === 'closed') return '定休日';
    if (info.summary === 'ended') return '受付終了';
    if (info.summary === 'full') return '満席';
    return '空き' + info.available + '枠';
  }

  function activeRadio(name) {
    var a = document.activeElement;
    return a && a.tagName === 'INPUT' && a.name === name ? a.value : null;
  }

  function renderDates() {
    var t = now();
    var list = $('date-list');
    var focused = activeRadio('date');
    if (ui.dateKey && !C.isInRange(ui.dateKey, t)) {
      // ページを開いたまま日付が変わり、選んでいた日が受付期間から外れた
      ui.dateKey = C.firstAvailableDate(t, memory.reservations);
      ui.hour = null;
    }
    list.textContent = '';
    C.listDates(t).forEach(function (d) {
      var info = C.dayAvailability(d.key, t, memory.reservations);
      var rel = d.offset === 0 ? '・今日' : d.offset === 1 ? '・明日' : '';
      var input = h('input', {
        type: 'radio',
        name: 'date',
        value: d.key,
        id: 'date-' + d.key,
        class: 'chip__input',
        disabled: d.closed,
        'aria-describedby': d.closed ? 'date-closed-reason' : null
      });
      input.checked = ui.dateKey === d.key;
      var label = h('label', {
        class: 'chip chip--date is-' + info.summary,
        for: 'date-' + d.key,
        'data-date': d.key
      }, [
        input,
        h('span', { class: 'chip__body' }, [
          h('span', { class: 'chip__main', 'aria-hidden': 'true', text: d.month + '/' + d.day }),
          h('span', { class: 'visually-hidden', text: d.month + '月' + d.day + '日' }),
          h('span', { class: 'chip__sub', text: d.weekdayLabel + rel }),
          h('span', { class: 'chip__status', text: daySummaryText(info) })
        ])
      ]);
      list.appendChild(label);
    });
    // 定休日の理由（読み上げ用。見た目では各ボタンに「定休日」と出ている）
    if (!$('date-closed-reason')) {
      list.parentNode.appendChild(h('span', { id: 'date-closed-reason', class: 'visually-hidden', text: '毎週水曜日は定休日のため選べません。' }));
    }
    if (focused) {
      var again = $('date-' + focused);
      if (again && !again.disabled) again.focus();
    }
  }

  // ---------------------------------------------------------------- 時間枠

  var SLOT_MARK = { available: '○', booked: '×', past: '−', closed: '−', 'out-of-range': '−', invalid: '−' };

  function renderSlots() {
    var t = now();
    var list = $('slot-list');
    var focused = activeRadio('slot');
    list.textContent = '';
    if (!ui.dateKey) {
      $('slot-date-label').textContent = '利用日を選ぶと、その日の空き状況が出ます。';
      return;
    }
    $('slot-date-label').textContent = C.formatDateJa(ui.dateKey) + 'の空き状況です。1時間ごとに選べます（10:00〜18:00）。';
    var stillOk = false;
    C.generateSlots().forEach(function (s) {
      var st = C.slotStatus(ui.dateKey, s.hour, t, memory.reservations);
      var id = 'slot-' + s.hour;
      var input = h('input', {
        type: 'radio',
        name: 'slot',
        value: String(s.hour),
        id: id,
        class: 'chip__input',
        disabled: st !== 'available',
        'aria-describedby': 'err-slot'
      });
      if (ui.hour === s.hour && st === 'available') {
        input.checked = true;
        stillOk = true;
      }
      list.appendChild(h('label', { class: 'chip chip--slot is-' + st, for: id, 'data-hour': s.hour, 'data-status': st }, [
        input,
        h('span', { class: 'chip__body' }, [
          h('span', { class: 'chip__time', text: s.label }),
          h('span', { class: 'chip__status' }, [
            h('span', { class: 'chip__mark', 'aria-hidden': 'true', text: SLOT_MARK[st] }),
            C.STATUS_LABELS[st] || ''
          ])
        ])
      ]));
    });
    if (ui.hour !== null && !stillOk) {
      // 選んでいた枠が、時刻が過ぎたり別のタブで埋まったりして選べなくなった
      ui.hour = null;
      if (ui.view === 'form') {
        setError('slot', '選んでいた時間は選べなくなりました（受付終了か、先に予約が入りました）。別の時間を選んでください。');
      }
    }
    if (focused) {
      var again = $('slot-' + focused);
      if (again && !again.disabled) again.focus();
    }
  }

  // 空き状況の「指紋」。変わったときだけ描き直すために使う（1分ごとの更新で、操作中の画面を無駄に作り直さない）
  function availabilitySignature() {
    var t = now();
    var parts = C.listDates(t).map(function (d) {
      var info = C.dayAvailability(d.key, t, memory.reservations);
      return d.key + ':' + info.summary + info.available;
    });
    if (ui.dateKey) {
      parts.push(C.generateSlots().map(function (s) {
        return C.slotStatus(ui.dateKey, s.hour, t, memory.reservations);
      }).join(','));
    }
    return parts.join('|');
  }

  var lastSignature = '';

  function renderPickers() {
    renderDates();
    renderSlots();
    lastSignature = availabilitySignature();
  }

  $('date-list').addEventListener('change', function (e) {
    if (e.target.name !== 'date') return;
    ui.dateKey = e.target.value;
    ui.hour = null;
    $('date-note').textContent = '';
    setError('date', '');
    setError('slot', '');
    renderSlots();
  });

  // 定休日のボタンを押したときは、選べない理由を出す
  $('date-list').addEventListener('click', function (e) {
    var label = e.target.closest ? e.target.closest('.chip--date') : null;
    if (!label) return;
    var key = label.getAttribute('data-date');
    if (C.isClosedDay(key)) {
      $('date-note').textContent = C.formatDateJa(key) + 'は選べません。' + C.closedReason(key);
    }
  });

  $('slot-list').addEventListener('change', function (e) {
    if (e.target.name !== 'slot') return;
    ui.hour = Number(e.target.value);
    setError('slot', '');
  });

  // ---------------------------------------------------------------- 入力欄

  function fillPurposes() {
    C.PURPOSES.forEach(function (p) {
      fields.purpose.appendChild(h('option', { value: p.value, text: p.label }));
    });
  }

  function updateCounter(name, max) {
    var n = C.charCount(fields[name].value.replace(/\r\n?/g, '\n').trim());
    var el = $('count-' + name);
    el.textContent = String(n);
    el.classList.toggle('is-over', n > max);
  }

  function readForm() {
    return {
      dateKey: ui.dateKey || '',
      hour: ui.hour,
      name: fields.name.value,
      email: fields.email.value,
      people: fields.people.value,
      purpose: fields.purpose.value,
      note: fields.note.value
    };
  }

  function setError(key, message) {
    var el = $('err-' + key);
    if (!el) return;
    if (el.textContent !== message) el.textContent = message;
    if (fields[key]) {
      if (message) fields[key].setAttribute('aria-invalid', 'true');
      else fields[key].removeAttribute('aria-invalid');
    } else {
      var group = $(key + '-group');
      if (group) group.classList.toggle('is-invalid', !!message);
    }
  }

  function showErrors(errors) {
    C.FIELD_ORDER.forEach(function (k) {
      setError(k, errors[k] || '');
    });
  }

  function clearErrors() {
    showErrors({});
    $('form-status').textContent = '';
    $('date-note').textContent = '';
  }

  // エラーのある最初の項目にフォーカスを移す
  function focusField(key) {
    var target = null;
    if (key === 'date') {
      target = document.querySelector('#date-list input:checked') || document.querySelector('#date-list input:not(:disabled)');
    } else if (key === 'slot') {
      target = document.querySelector('#slot-list input:checked') ||
        document.querySelector('#slot-list input:not(:disabled)') ||
        document.querySelector('#date-list input:checked');
    } else {
      target = fields[key];
    }
    if (target) target.focus();
  }

  // 一度「確認する」を押した後は、直したところからエラーを消していく
  Object.keys(fields).forEach(function (name) {
    var evt = fields[name].tagName === 'SELECT' ? 'change' : 'input';
    fields[name].addEventListener(evt, function () {
      if (name === 'name') updateCounter('name', C.NAME_MAX);
      if (name === 'note') updateCounter('note', C.NOTE_MAX);
      if (!ui.submitted) return;
      var res = C.validateFields(readForm());
      setError(name, res.errors[name] || '');
    });
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    ui.submitted = true;
    var input = readForm();
    loadState(); // 別のタブで変わっているかもしれないので読み直す
    var res = C.validateReservation(input, now(), memory.reservations);
    renderPickers();
    showErrors(res.errors);
    if (!res.valid) {
      var count = Object.keys(res.errors).length;
      $('form-status').textContent = '入力内容に' + count + '件の問題があります。各項目の下の説明を見て直してください。';
      focusField(res.firstError);
      return;
    }
    $('form-status').textContent = '';
    ui.draft = res.values;
    goTo('confirm');
    // ブラウザの「戻る」で入力画面に戻れるよう、確認画面を履歴に1つ積む
    history.pushState({ view: 'confirm' }, '');
  });

  // ---------------------------------------------------------------- 確認・完了

  function summaryRows(v) {
    return [
      ['利用日時', C.formatDateLongJa(v.dateKey) + ' ' + C.slotLabel(v.hour)],
      ['お名前', v.name],
      ['メールアドレス', v.email],
      ['人数', v.people + '人'],
      ['利用目的', C.purposeLabel(v.purpose)],
      ['備考', v.note || '（なし）']
    ];
  }

  function renderSummary(dl, v) {
    dl.textContent = '';
    summaryRows(v).forEach(function (row) {
      dl.appendChild(h('div', { class: 'summary__row' }, [
        h('dt', { text: row[0] }),
        h('dd', { text: row[1] })
      ]));
    });
  }

  function setStep(view) {
    var order = ['form', 'confirm', 'done'];
    document.querySelectorAll('.steps li').forEach(function (li) {
      var step = li.getAttribute('data-step');
      if (step === view) li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
      li.classList.toggle('is-done', order.indexOf(step) < order.indexOf(view));
    });
  }

  function focusHeading(id) {
    var el = $(id);
    el.focus({ preventScroll: true });
    var top = el.getBoundingClientRect().top;
    if (top < 0 || top > window.innerHeight * 0.6) el.scrollIntoView({ block: 'start' });
  }

  function setConfirmBlocked(message) {
    var box = $('confirm-error');
    box.textContent = '';
    if (message) box.appendChild(h('p', { text: message }));
    $('confirm-booking').hidden = !!message;
    $('choose-again').hidden = !message;
  }

  function goTo(view, opts) {
    var o = opts || {};
    ui.view = view;
    $('view-form').hidden = view !== 'form';
    $('view-confirm').hidden = view !== 'confirm';
    $('view-done').hidden = view !== 'done';
    setStep(view);
    if (view === 'confirm') {
      renderSummary($('confirm-summary'), ui.draft);
      setConfirmBlocked('');
      if (!o.noFocus) focusHeading('confirm-title');
    } else if (view === 'done') {
      if (!o.noFocus) focusHeading('done-title');
    } else if (!o.noFocus) {
      focusHeading('form-title');
    }
  }

  // 確認画面の履歴を取り除く（画面のボタンで入力画面に戻ったとき）。
  // history.back() のあとの popstate は、ui.view がもう 'form' なので何もしない。
  function dropConfirmEntry() {
    if (history.state && history.state.view === 'confirm') history.back();
  }

  $('back-to-form').addEventListener('click', function () {
    goTo('form');
    dropConfirmEntry();
  });

  // ブラウザの「戻る」「進む」
  window.addEventListener('popstate', function (e) {
    var v = e.state && e.state.view;
    if (ui.view === 'confirm' && v !== 'confirm') {
      goTo('form');                       // 確認画面から戻る → 入力が残った入力画面
    } else if (ui.view === 'done' && v !== 'done') {
      startNewBooking(true);              // 完了画面から戻る → 新しい予約（確定済みの予約を二重に確定しない）
    } else if (ui.view === 'form' && v === 'confirm') {
      history.replaceState(null, '');     // 「進む」で古い確認画面には戻さない（入力が変わっているかもしれない）
    }
  });

  function takenMessage(reason, v) {
    var when = C.formatDateJa(v.dateKey) + ' ' + C.slotLabel(v.hour);
    if (reason === 'taken') {
      return '申し訳ありません。' + when + ' は、ほかの画面で先に予約が入りました。二重予約を防ぐため、この予約は確定していません。別の時間を選び直してください。';
    }
    if (reason === 'past') {
      return when + ' は開始時刻を過ぎたため、受付を終了しました。この予約は確定していません。別の時間を選び直してください。';
    }
    return 'この時間は予約できなくなりました。この予約は確定していません。別の時間を選び直してください。';
  }

  $('confirm-booking').addEventListener('click', function () {
    if (!ui.draft) return;
    // 確定の直前に、保存されている最新の内容でもう一度空きを確かめる
    var fresh = loadState();
    var result = C.book(fresh, ui.draft, now());
    if (!result.ok) {
      renderPickers();
      renderAdmin();
      if (result.reason === 'invalid') {
        goTo('form');
        dropConfirmEntry();
        showErrors(result.errors);
        return;
      }
      setConfirmBlocked(takenMessage(result.reason, ui.draft));
      $('choose-again').focus();
      return;
    }
    saveState(result.state);
    $('done-number').textContent = result.reservation.id;
    renderSummary($('done-summary'), result.reservation);
    renderAdmin();
    goTo('done');
    // 確認画面の履歴を完了画面で置きかえる（「戻る」で確認画面に戻って二重に確定しないように）
    history.replaceState({ view: 'done' }, '');
  });

  $('choose-again').addEventListener('click', function () {
    ui.hour = null;
    loadState();
    renderPickers();
    goTo('form', { noFocus: true });
    dropConfirmEntry();
    setError('slot', '選んでいた時間は予約できなくなりました。別の時間を選んでください。');
    focusField('slot');
  });

  function startNewBooking(focus) {
    form.reset();
    updateCounter('name', C.NAME_MAX);
    updateCounter('note', C.NOTE_MAX);
    ui.submitted = false;
    ui.draft = null;
    ui.hour = null;
    clearErrors();
    loadState();
    ui.dateKey = C.firstAvailableDate(now(), memory.reservations);
    renderPickers();
    goTo('form', { noFocus: !focus });
    if (history.state && history.state.view) history.replaceState(null, '');
  }

  $('book-again').addEventListener('click', function () {
    startNewBooking(true);
  });

  $('go-admin').addEventListener('click', function () {
    selectTab('admin', true);
    focusHeading('admin-title');
  });

  // ---------------------------------------------------------------- タブ

  var tabs = [$('tab-book'), $('tab-admin')];

  function selectTab(name, moveFocus) {
    tabs.forEach(function (tab) {
      var on = tab.id === 'tab-' + name;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
      $(tab.getAttribute('aria-controls')).hidden = !on;
    });
    if (moveFocus) $('tab-' + name).focus();
    loadState();
    if (name === 'admin') renderAdmin();
    else renderPickers();
  }

  tabs.forEach(function (tab, i) {
    tab.addEventListener('click', function () {
      selectTab(tab.id.replace('tab-', ''), false);
    });
    tab.addEventListener('keydown', function (e) {
      var next = null;
      if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
      else if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
      else if (e.key === 'Home') next = tabs[0];
      else if (e.key === 'End') next = tabs[tabs.length - 1];
      if (!next) return;
      e.preventDefault();
      selectTab(next.id.replace('tab-', ''), true);
    });
  });

  // ---------------------------------------------------------------- 管理画面

  function renderAdmin() {
    var list = C.sortReservations(memory.reservations);
    var countText = list.length + '件';
    $('admin-count').textContent = countText;
    $('admin-count-badge').textContent = countText;
    $('admin-empty').hidden = list.length > 0;
    $('admin-table-wrap').hidden = list.length === 0;
    $('export-csv').disabled = list.length === 0;
    var tbody = $('admin-rows');
    tbody.textContent = '';
    list.forEach(function (r) {
      var cancelBtn = h('button', {
        type: 'button',
        class: 'btn btn--danger',
        'data-cancel': r.id,
        'aria-label': '取り消す（' + r.id + '）',
        text: '取り消す'
      });
      // 狭い画面ではセルを「見出し｜中身」の2列で見せるので、中身は1つの要素にまとめる
      var cell = function (label, cls, children) {
        return h('td', { role: 'cell', 'data-label': label, class: cls }, [h('div', { class: 'cell-body' }, children)]);
      };
      tbody.appendChild(h('tr', { role: 'row', 'data-id': r.id }, [
        cell('予約番号', 'cell-id', [r.id]),
        cell('利用日時', 'cell-when', [
          h('span', { class: 'cell-line', text: C.formatDateJa(r.dateKey) }),
          h('span', { class: 'cell-line', text: C.slotLabel(r.hour) })
        ]),
        cell('お名前', 'cell-name', [
          h('span', { class: 'cell-line', text: r.name }),
          h('span', { class: 'cell-line cell-sub', text: r.email })
        ]),
        cell('人数', 'num cell-people', [r.people + '人']),
        cell('利用目的', 'cell-purpose', [C.purposeLabel(r.purpose) || r.purpose]),
        cell('備考', 'cell-note', [r.note || '—']),
        h('td', { role: 'cell', class: 'cell-action' }, [cancelBtn])
      ]));
    });
  }

  function announce(id, message) {
    var el = $(id);
    el.textContent = '';
    // 同じ文言が続いても読み上げられるよう、いったん空にしてから入れる
    window.setTimeout(function () {
      el.textContent = message;
    }, 50);
  }

  $('admin-rows').addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-cancel]') : null;
    if (!btn) return;
    var id = btn.getAttribute('data-cancel');
    var r = null;
    memory.reservations.forEach(function (x) {
      if (x.id === id) r = x;
    });
    if (!r) return;
    ui.cancelId = id;
    $('cancel-desc').textContent = id + '（' + C.formatDateJa(r.dateKey) + ' ' + C.slotLabel(r.hour) + '・' + r.name + ' さま）の予約を取り消します。';
    var dlg = $('cancel-dialog');
    if (typeof dlg.showModal === 'function') {
      dlg.showModal();
      $('cancel-keep').focus();
    } else if (window.confirm($('cancel-desc').textContent + 'よろしいですか？')) {
      doCancel();
    }
  });

  function closeDialog(returnFocusTo) {
    var dlg = $('cancel-dialog');
    if (dlg.open) dlg.close();
    if (returnFocusTo) returnFocusTo.focus();
  }

  function doCancel() {
    var id = ui.cancelId;
    ui.cancelId = null;
    var result = C.cancelReservation(loadState(), id);
    if (result.ok) {
      saveState(result.state);
      announce('admin-status', '予約 ' + id + ' を取り消しました。');
    } else {
      announce('admin-status', '予約 ' + id + ' は、すでに取り消されています。');
    }
    renderAdmin();
    renderPickers();
  }

  $('cancel-keep').addEventListener('click', function () {
    var id = ui.cancelId;
    ui.cancelId = null;
    closeDialog(document.querySelector('[data-cancel="' + id + '"]'));
  });

  $('cancel-do').addEventListener('click', function () {
    doCancel();
    closeDialog(null);
    var nextBtn = document.querySelector('#admin-rows [data-cancel]');
    if (nextBtn) nextBtn.focus();
    else focusHeading('admin-title');
  });

  // Esc で閉じたとき
  $('cancel-dialog').addEventListener('cancel', function () {
    var id = ui.cancelId;
    ui.cancelId = null;
    window.setTimeout(function () {
      var btn = document.querySelector('[data-cancel="' + id + '"]');
      if (btn) btn.focus();
    }, 0);
  });

  $('export-csv').addEventListener('click', function () {
    loadState();
    renderAdmin();
    if (memory.reservations.length === 0) return;
    var csv = C.toCsv(memory.reservations);
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = h('a', { href: url, download: C.csvFileName(now()) });
    a.hidden = true;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 5000);
    announce('admin-status', memory.reservations.length + '件の予約を CSV に書き出しました。');
  });

  // ---------------------------------------------------------------- リセット

  $('reset-demo').addEventListener('click', function () {
    clearState();
    selectTab('book', false);
    startNewBooking(false);
    renderAdmin();
    $('admin-status').textContent = '';
    announce('reset-status', 'デモを最初の状態に戻しました。このブラウザに保存した予約を消しました。');
  });

  // ---------------------------------------------------------------- ほかのタブ・時間の経過

  // 別のタブで予約や取り消しがあったら、表示を最新にする
  window.addEventListener('storage', function (e) {
    if (e.key !== null && e.key !== KEY) return;
    loadState();
    renderPickers();
    renderAdmin();
    if (ui.view === 'confirm' && ui.draft) {
      var st = C.slotStatus(ui.draft.dateKey, ui.draft.hour, now(), memory.reservations);
      if (st !== 'available') setConfirmBlocked(takenMessage(st === 'booked' ? 'taken' : st, ui.draft));
    }
  });

  // 時刻が進むと「受付終了」の枠が増えるので、1分ごとに表示を更新する
  window.setInterval(function () {
    if (availabilitySignature() !== lastSignature) renderPickers();
  }, 60000);

  window.addEventListener('pageshow', function (e) {
    if (e.persisted) {
      loadState();
      renderPickers();
      renderAdmin();
    }
  });

  // ---------------------------------------------------------------- はじめ

  fillPurposes();
  loadState();
  ui.dateKey = C.firstAvailableDate(now(), memory.reservations);
  renderPickers();
  renderAdmin();
  updateCounter('name', C.NAME_MAX);
  updateCounter('note', C.NOTE_MAX);
})();
