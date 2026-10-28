'use strict';

// ===== 設定 =====
const STORAGE_KEY = 'ndc-reminder-v1';
const SETTINGS_KEY = 'ndc-reminder-settings-v1';
const CHECK_INTERVAL_MS = 10 * 1000;
// アプリを開いた時点で既に過ぎていたアラームは、この時間以内のものだけ鳴らす
const LATE_FIRE_WINDOW_MS = 10 * 60 * 1000;
const SNOOZE_MIN = 5;

const PROCEDURES = [
  '動脈血採血', '橈骨動脈ライン確保', '中心静脈カテーテル抜去', 'PICC挿入',
  '胸腔ドレーン抜去', '腹腔ドレーン抜去', '気管カニューレ交換', '人工呼吸器設定調整',
  '褥瘡デブリードマン', '創傷処置', '持続点滴の投与量調整', '血糖コントロール(インスリン調整)',
  '輸液・脱水補正', '抗菌薬投与', 'カンファレンス', '回診', 'レポート提出',
];
const REMIND_OPTIONS = [60, 30, 15, 10, 5, 3, 0];
const DEFAULT_REMINDERS = [15, 5, 0];
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

// ===== 状態 =====
let items = load(STORAGE_KEY, []);
let settings = Object.assign({ sound: true, keepAwake: false }, load(SETTINGS_KEY, {}));
let currentDate = todayStr();
let editingId = null;
let selectedReminders = new Set(DEFAULT_REMINDERS);
let ringing = null; // { item, offset }
let audioCtx = null;
let beepTimer = null;
let wakeLock = null;
let swReg = null;

const $ = (id) => document.getElementById(id);

// ===== ユーティリティ =====
function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    alert('保存に失敗しました(プライベートモード等では保存できません)');
  }
}
function pad(n) { return String(n).padStart(2, '0'); }
function dateToStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function todayStr() { return dateToStr(new Date()); }
function startOf(item) {
  const [y, m, d] = item.date.split('-').map(Number);
  const [hh, mm] = item.time.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm);
}
function endOf(item) { return new Date(startOf(item).getTime() + (Number(item.duration) || 0) * 60000); }
function fmtTime(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function shiftDate(str, days) {
  const [y, m, d] = str.split('-').map(Number);
  return dateToStr(new Date(y, m - 1, d + days));
}
function remindLabel(min) { return min === 0 ? '開始時刻' : `${min}分前`; }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function itemsOn(date) {
  return items.filter((i) => i.date === date).sort((a, b) => a.time.localeCompare(b.time));
}

// 時間が重なっている予定の id を返す(所要0分は1分として扱う)
function conflictIds(list) {
  const ids = new Set();
  const active = list.filter((i) => !i.done);
  for (let a = 0; a < active.length; a++) {
    for (let b = a + 1; b < active.length; b++) {
      const A = active[a], B = active[b];
      const as = startOf(A).getTime(), bs = startOf(B).getTime();
      const ae = as + Math.max(1, Number(A.duration) || 0) * 60000;
      const be = bs + Math.max(1, Number(B.duration) || 0) * 60000;
      if (as < be && bs < ae) { ids.add(A.id); ids.add(B.id); }
    }
  }
  return ids;
}

// ===== 描画 =====
function render() {
  const list = itemsOn(currentDate);
  const conflicts = conflictIds(list);
  const now = new Date();
  const isToday = currentDate === todayStr();

  const [y, m, d] = currentDate.split('-').map(Number);
  const wd = WEEKDAYS[new Date(y, m - 1, d).getDay()];
  $('dateLabel').textContent = `${m}/${d}(${wd})${isToday ? ' 今日' : ''}`;
  $('datePicker').value = currentDate;

  const doneCount = list.filter((i) => i.done).length;
  $('summary').textContent = list.length
    ? `${list.length}件 / 完了${doneCount}${conflicts.size ? ` / ⚠重複${conflicts.size}件` : ''}`
    : '';

  const ol = $('timeline');
  ol.innerHTML = '';
  let nowInserted = !isToday;
  for (const item of list) {
    const start = startOf(item);
    if (!nowInserted && start > now) {
      ol.appendChild(nowLine(now));
      nowInserted = true;
    }
    ol.appendChild(itemEl(item, conflicts.has(item.id), endOf(item) < now));
  }
  if (!nowInserted && list.length) ol.appendChild(nowLine(now));
  $('empty').hidden = list.length > 0;

  renderNext();
}

function nowLine(now) {
  const li = document.createElement('li');
  li.className = 'now-line';
  li.textContent = `現在 ${fmtTime(now)}`;
  return li;
}

function itemEl(item, isConflict, isPast) {
  const li = document.createElement('li');
  li.className = 'item' + (item.done ? ' done' : '') + (isConflict ? ' conflict' : '') + (isPast ? ' past' : '');
  const dur = Number(item.duration) || 0;
  const meta = [item.place, item.who].filter(Boolean).map(escapeHtml).join(' ・ ');
  const tags = (item.reminders || []).slice().sort((a, b) => b - a)
    .map((r) => `<span class="tag">🔔${remindLabel(r)}</span>`).join('');
  li.innerHTML = `
    <div>
      <div class="i-time">${escapeHtml(item.time)}</div>
      ${dur ? `<div class="i-end">〜${fmtTime(endOf(item))}</div>` : ''}
    </div>
    <div class="i-body">
      <div class="i-title">${escapeHtml(item.title)}</div>
      ${meta ? `<div class="i-meta">${meta}</div>` : ''}
      ${item.memo ? `<div class="i-memo">${escapeHtml(item.memo)}</div>` : ''}
      <div class="i-tags">
        ${isConflict ? '<span class="tag warn">⚠ 時間が重複</span>' : ''}
        ${tags}
      </div>
    </div>
    <button class="check" aria-label="完了">${item.done ? '✓' : ''}</button>`;
  li.querySelector('.i-body').addEventListener('click', () => openEditor(item));
  li.querySelector('.check').addEventListener('click', () => {
    item.done = !item.done;
    save();
    render();
  });
  return li;
}

function renderNext() {
  const now = new Date();
  const upcoming = items
    .filter((i) => !i.done && endOf(i) > now)
    .sort((a, b) => startOf(a) - startOf(b))[0];
  const card = $('nextCard');
  if (!upcoming) { card.hidden = true; return; }
  card.hidden = false;
  const start = startOf(upcoming);
  const sameDay = upcoming.date === todayStr();
  $('nextTitle').textContent = upcoming.title;
  $('nextMeta').textContent = [
    sameDay ? fmtTime(start) : `${start.getMonth() + 1}/${start.getDate()} ${fmtTime(start)}`,
    upcoming.place, upcoming.who,
  ].filter(Boolean).join(' ・ ');
  const diff = start - now;
  if (diff <= 0) {
    $('nextCountdown').textContent = '実施中';
  } else {
    const totalMin = Math.ceil(diff / 60000);
    const h = Math.floor(totalMin / 60), mi = totalMin % 60;
    $('nextCountdown').textContent = h ? `あと ${h}時間${mi}分` : `あと ${mi}分`;
  }
}

// ===== 編集 =====
function buildChips() {
  $('procList').innerHTML = PROCEDURES.map((p) => `<option value="${escapeHtml(p)}">`).join('');
  const procChips = $('procChips');
  for (const p of PROCEDURES.slice(0, 8)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = p;
    b.addEventListener('click', () => { $('fTitle').value = p; });
    procChips.appendChild(b);
  }
  const remindChips = $('remindChips');
  for (const r of REMIND_OPTIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.dataset.min = r;
    b.textContent = remindLabel(r);
    b.addEventListener('click', () => {
      if (selectedReminders.has(r)) selectedReminders.delete(r); else selectedReminders.add(r);
      syncRemindChips();
    });
    remindChips.appendChild(b);
  }
}
function syncRemindChips() {
  for (const b of $('remindChips').children) {
    b.classList.toggle('on', selectedReminders.has(Number(b.dataset.min)));
  }
}

function openEditor(item) {
  unlockAudio();
  editingId = item ? item.id : null;
  $('editorTitle').textContent = item ? '予定を編集' : '予定を追加';
  $('fTitle').value = item?.title ?? '';
  $('fTime').value = item?.time ?? suggestTime();
  $('fDuration').value = item?.duration ?? 30;
  $('fPlace').value = item?.place ?? '';
  $('fWho').value = item?.who ?? '';
  $('fMemo').value = item?.memo ?? '';
  selectedReminders = new Set(item?.reminders ?? DEFAULT_REMINDERS);
  syncRemindChips();
  $('deleteBtn').hidden = !item;
  $('editor').showModal();
}

// 次の切りのいい時刻(15分単位)を初期値にする
function suggestTime() {
  const d = new Date();
  d.setMinutes(Math.ceil((d.getMinutes() + 1) / 15) * 15, 0, 0);
  return fmtTime(d);
}

function saveEditor(e) {
  e.preventDefault();
  const data = {
    title: $('fTitle').value.trim(),
    time: $('fTime').value,
    duration: Math.max(0, Number($('fDuration').value) || 0),
    place: $('fPlace').value.trim(),
    who: $('fWho').value.trim(),
    memo: $('fMemo').value.trim(),
    reminders: [...selectedReminders].sort((a, b) => b - a),
  };
  if (!data.title || !data.time) return;
  if (editingId) {
    const item = items.find((i) => i.id === editingId);
    // 時刻やリマインド設定を変えたら、鳴った記録をリセットして鳴り直すようにする
    if (item.time !== data.time || String(item.reminders) !== String(data.reminders)) item.fired = {};
    Object.assign(item, data);
  } else {
    items.push({ id: uid(), date: currentDate, done: false, fired: {}, ...data });
  }
  save();
  $('editor').close();
  render();
  maybeAskPermission();
}

function deleteEditing() {
  if (!editingId || !confirm('この予定を削除しますか?')) return;
  items = items.filter((i) => i.id !== editingId);
  save();
  $('editor').close();
  render();
}

// ===== アラーム =====
function checkAlarms() {
  const now = Date.now();
  for (const item of items) {
    if (item.done) continue;
    item.fired = item.fired || {};
    const start = startOf(item).getTime();
    for (const offset of item.reminders || []) {
      const at = start - offset * 60000;
      if (item.fired[offset] || now < at) continue;
      item.fired[offset] = true;
      save();
      if (now - at <= LATE_FIRE_WINDOW_MS) fire(item, offset);
    }
    if (item.snoozeUntil && now >= item.snoozeUntil) {
      delete item.snoozeUntil;
      save();
      fire(item, null);
    }
  }
  renderNext();
}

function fire(item, offset) {
  const start = startOf(item);
  const when = offset === null ? 'スヌーズ' : offset === 0 ? '開始時刻です' : `${offset}分前`;
  const body = [`${fmtTime(start)} 開始`, item.place, item.who, item.memo].filter(Boolean).join('\n');

  ringing = { item, offset };
  $('alarmWhen').textContent = when;
  $('alarmTitle').textContent = item.title;
  $('alarmMeta').textContent = body;
  $('alarmOverlay').hidden = false;
  startBeep();
  if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 400]);

  showNotification(`【${when}】${item.title}`, body, item.id);
}

async function showNotification(title, body, tag) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const opts = { body, tag: `${tag}-${Date.now()}`, requireInteraction: true, vibrate: [400, 200, 400], icon: 'icon.svg', badge: 'icon.svg' };
  try {
    if (swReg) await swReg.showNotification(title, opts);
    else new Notification(title, opts);
  } catch {
    try { new Notification(title, opts); } catch { /* 通知非対応 */ }
  }
}

function stopAlarm() {
  $('alarmOverlay').hidden = true;
  stopBeep();
  if (navigator.vibrate) navigator.vibrate(0);
  ringing = null;
}

function snooze() {
  if (ringing) {
    ringing.item.snoozeUntil = Date.now() + SNOOZE_MIN * 60000;
    save();
  }
  stopAlarm();
}

// iOS/Android ではユーザー操作後でないと音が出ないため、最初のタップで解錠しておく
function unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* 音声非対応 */ }
}

function beepOnce() {
  if (!audioCtx || !settings.sound) return;
  const t = audioCtx.currentTime;
  for (let i = 0; i < 3; i++) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, t + i * 0.25);
    gain.gain.exponentialRampToValueAtTime(0.3, t + i * 0.25 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.25 + 0.18);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t + i * 0.25);
    osc.stop(t + i * 0.25 + 0.2);
  }
}
function startBeep() {
  stopBeep();
  beepOnce();
  beepTimer = setInterval(beepOnce, 1500);
  // 鳴りっぱなしを防ぐため1分で止める(画面のアラームは残す)
  setTimeout(stopBeep, 60000);
}
function stopBeep() {
  if (beepTimer) clearInterval(beepTimer);
  beepTimer = null;
}

// ===== 通知の許可 =====
function updatePermBanner() {
  const supported = 'Notification' in window;
  $('permBanner').hidden = !supported || Notification.permission === 'granted';
}
async function maybeAskPermission() {
  if (!('Notification' in window) || Notification.permission !== 'default') return;
  try { await Notification.requestPermission(); } catch { /* 古いブラウザ */ }
  updatePermBanner();
}

// ===== 画面スリープ防止 =====
async function applyWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    if (settings.keepAwake && document.visibilityState === 'visible' && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!settings.keepAwake && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* 低電力モード等で拒否される */ }
}

// ===== カレンダー書き出し(.ics) =====
function icsEscape(s) { return String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => '\\' + c); }
function icsDate(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
}
function exportIcs() {
  const list = itemsOn(currentDate).filter((i) => !i.done);
  if (!list.length) { alert('書き出す予定がありません'); return; }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//NDC Reminder//JA', 'CALSCALE:GREGORIAN'];
  for (const item of list) {
    const start = startOf(item);
    const end = new Date(start.getTime() + Math.max(5, Number(item.duration) || 0) * 60000);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${item.id}@ndc-reminder`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsDate(start)}`,
      `DTEND:${icsDate(end)}`,
      `SUMMARY:${icsEscape(item.title)}`,
    );
    if (item.place) lines.push(`LOCATION:${icsEscape(item.place)}`);
    const desc = [item.who, item.memo].filter(Boolean).join('\n');
    if (desc) lines.push(`DESCRIPTION:${icsEscape(desc)}`);
    for (const r of item.reminders || []) {
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(item.title)}`, `TRIGGER:-PT${r}M`, 'END:VALARM');
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ndc-${currentDate}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ===== 起動 =====
function init() {
  buildChips();

  $('prevDay').addEventListener('click', () => { currentDate = shiftDate(currentDate, -1); render(); });
  $('nextDay').addEventListener('click', () => { currentDate = shiftDate(currentDate, 1); render(); });
  $('datePicker').addEventListener('change', (e) => { if (e.target.value) { currentDate = e.target.value; render(); } });
  $('addBtn').addEventListener('click', () => openEditor(null));
  $('editForm').addEventListener('submit', saveEditor);
  $('cancelBtn').addEventListener('click', () => $('editor').close());
  $('deleteBtn').addEventListener('click', deleteEditing);
  $('dismissBtn').addEventListener('click', stopAlarm);
  $('snoozeBtn').addEventListener('click', snooze);
  $('enableNotif').addEventListener('click', maybeAskPermission);
  $('exportIcs').addEventListener('click', exportIcs);
  $('testAlarm').addEventListener('click', () => {
    unlockAudio();
    maybeAskPermission();
    fire({ id: 'test', title: 'テストアラーム', date: todayStr(), time: fmtTime(new Date()), duration: 0, place: 'これが鳴れば準備OK' }, 0);
  });

  $('soundOn').checked = settings.sound;
  $('soundOn').addEventListener('change', (e) => { settings.sound = e.target.checked; save(); });
  $('keepAwake').checked = settings.keepAwake;
  $('keepAwake').addEventListener('change', (e) => { settings.keepAwake = e.target.checked; save(); applyWakeLock(); });

  document.addEventListener('pointerdown', unlockAudio, { once: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { checkAlarms(); render(); applyWakeLock(); }
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then((r) => { swReg = r; }).catch(() => {});
  }

  updatePermBanner();
  render();
  checkAlarms();
  applyWakeLock();
  setInterval(checkAlarms, CHECK_INTERVAL_MS);
  // 現在時刻ラインと期限切れ表示を更新
  setInterval(render, 60 * 1000);
}

init();
