/* 飆風玫瑰 × 生於憂患 九宮格 —— 後端（Google Apps Script）
 * 部署步驟：
 *   1. 試算表 → 擴充功能 → Apps Script，把本檔全部貼上
 *   2. 改下面第 8 行的密碼（10 字以上、英數混合）
 *   3. 把老師另外收到的「答案區」貼進下方 ANSWERS 區塊
 *   4. 部署 → 新增部署作業 → 網頁應用程式（執行身分：我；存取：所有人）
 */
const PASSWORD = 'change-me';

const ACTIVITY = 'rose-bingo';
const MAX_HISTORY = 20;          // 每人保留最近幾次作答
const SEAT_MIN = 1, SEAT_MAX = 60;
const NAME_MAX = 12, TEXT_MAX = 80;
const SHEET_DATA = 'data';       // 給程式讀
const SHEET_LOG = '作答紀錄';     // 給老師看
const QIDS = ['q1', 'q2', 'q3', 'q4', 'q6', 'q7', 'q8', 'q9'];

// 三個層次（報告書用）
const LEVELS = [
  { name: '認識人物', desc: '讀懂 Rose 的經歷', qs: ['q1', 'q2', 'q3', 'q7'] },
  { name: '連結孟子', desc: '把故事和〈生於憂患〉對起來', qs: ['q4', 'q6', 'q8'] },
  { name: '轉化實踐', desc: '把精神用在自己身上', qs: ['q9', 'vow'] }
];

// ===== 答案區開始（GitHub 上只是佔位；請貼上老師另外收到的答案區）=====
const ANSWERS = {
  // q1: { ans: 'B', hint: '……', exp: '……' },
};
// ===== 答案區結束 =====

/* ---------------- 進入點 ---------------- */
function doGet() {
  return out({ ok: true, msg: '這是九宮格後端，正常運作中', answersReady: answersReady() });
}

function doPost(e) {
  let req = {};
  try { req = JSON.parse(e.postData.contents || '{}'); } catch (err) { return out({ ok: false, error: '資料格式錯誤' }); }
  try {
    switch (req.action) {
      case 'login': return out(actLogin(req));
      case 'list': return out(actList(req));
      case 'check': return out(actCheck(req));
      case 'save': return out(actSave(req, false));
      case 'myReport': return out(actMyReport(req));
      case 'setSettings': return out(actSetSettings(req));
      case 'deleteAttempt': return out(actDeleteAttempt(req));
      case 'clearClass': return out(actClearClass(req));
      case 'importCode': return out(actImportCode(req));
      default: return out({ ok: false, error: '未知的動作' });
    }
  } catch (err) {
    return out({ ok: false, error: String(err && err.message || err) });
  }
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------------- 密碼與防猜 ---------------- */
function passwordOk(pw) {
  if (!PASSWORD || PASSWORD === 'change-me') return false;
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('pwfail') || 0);
  if (fails >= 5) throw new Error('密碼錯誤太多次，請 10 分鐘後再試');
  if (pw === PASSWORD) { cache.remove('pwfail'); return true; }
  if (pw) cache.put('pwfail', String(fails + 1), 600);
  return false;
}
function requirePw(req) {
  if (!passwordOk(req.password)) throw new Error(PASSWORD === 'change-me' ? '老師尚未在 Apps Script 第 8 行設定密碼' : '密碼錯誤');
}
function actLogin(req) {
  requirePw(req);
  return { ok: true };
}

/* ---------------- 設定 ---------------- */
function getSettings() {
  const raw = PropertiesService.getScriptProperties().getProperty('settings');
  const def = { published: false, redoAll: false, redo: [], classes: [], suspectSec: 30 };
  try { return Object.assign(def, raw ? JSON.parse(raw) : {}); } catch (e) { return def; }
}
function putSettings(s) { PropertiesService.getScriptProperties().setProperty('settings', JSON.stringify(s)); }

function actSetSettings(req) {
  requirePw(req);
  const s = getSettings(), n = req.settings || {};
  if ('published' in n) s.published = !!n.published;
  if ('redoAll' in n) s.redoAll = !!n.redoAll;
  if ('suspectSec' in n) s.suspectSec = Math.max(0, Math.min(600, Number(n.suspectSec) || 0));
  if (Array.isArray(n.classes)) s.classes = n.classes.map(c => cleanText(c, 6)).filter(Boolean).slice(0, 40);
  if (n.redoAdd) { const k = String(n.redoAdd); if (s.redo.indexOf(k) < 0) s.redo.push(k); }
  if (n.redoRemove) s.redo = s.redo.filter(k => k !== String(n.redoRemove));
  putSettings(s);
  return { ok: true, settings: s };
}

/* ---------------- 驗證學生 ---------------- */
function cleanText(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}
function safeCell(s) { // 防試算表公式注入
  s = String(s == null ? '' : s);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}
function validStudent(req) {
  const cls = cleanText(req.cls, 6), name = cleanText(req.name, NAME_MAX);
  const seat = Number(req.seat);
  if (!cls || cls === '0' || /^0+$/.test(cls)) throw new Error('請填正確的班級');
  const s = getSettings();
  if (s.classes.length && s.classes.indexOf(cls) < 0) throw new Error('班級不在老師設定的名單內：' + s.classes.join('、'));
  if (!(seat >= SEAT_MIN && seat <= SEAT_MAX) || Math.floor(seat) !== seat) throw new Error('座號要是 1～60');
  if (!name) throw new Error('請填姓名');
  return { cls: cls, seat: seat, name: name, key: cls + '-' + seat };
}
function answersReady() { return QIDS.every(q => ANSWERS[q] && ANSWERS[q].ans); }

/* ---------------- 單題檢查（不回傳答案） ---------------- */
function actCheck(req) {
  if (!answersReady()) throw new Error('老師尚未貼上答案區，請通知老師');
  const st = validStudent(req);
  const qid = String(req.qid), choice = String(req.choice || '').toUpperCase();
  if (QIDS.indexOf(qid) < 0 || ['A', 'B', 'C'].indexOf(choice) < 0) throw new Error('題目或選項錯誤');
  const cache = CacheService.getScriptCache();
  // 頻率限制：每人每分鐘 40 次
  const rk = 'rate:' + st.key, cnt = Number(cache.get(rk) || 0);
  if (cnt > 40) throw new Error('操作太快了，休息一下再試');
  cache.put(rk, String(cnt + 1), 60);
  if (isLocked(st.key)) return { ok: false, locked: true, error: '你已經交過了，若要重玩請找老師開放' };
  // 伺服器端記錄作答過程（交卷時以此為準）
  const ak = 'att:' + st.key;
  let att = {}; try { att = JSON.parse(cache.get(ak) || '{}'); } catch (e) { att = {}; }
  att[qid] = (att[qid] || []).concat(choice).slice(0, 5);
  cache.put(ak, JSON.stringify(att), 21600);
  const a = ANSWERS[qid];
  const correct = choice === a.ans;
  return { ok: true, correct: correct, hint: correct ? '' : (a.hint || '再讀一次題目，想想 Rose 和孟子的話。') };
}

function isLocked(key) {
  const rows = readData();
  const r = rows[key];
  if (!r || !r.attempts.length) return false;
  const s = getSettings();
  return !(s.redoAll || s.redo.indexOf(key) >= 0);
}

/* ---------------- 資料讀寫 ---------------- */
function ss() { return SpreadsheetApp.getActiveSpreadsheet(); }
function sheet(name, header) {
  let sh = ss().getSheetByName(name);
  if (!sh) { sh = ss().insertSheet(name); sh.appendRow(header); sh.setFrozenRows(1); }
  return sh;
}
function dataSheet() { return sheet(SHEET_DATA, ['key', '班級', '座號', '姓名', '活動', '最高分', '最多連線', '作答紀錄JSON', '更新時間']); }
function logSheet() {
  return sheet(SHEET_LOG, ['完成時間', '班級', '座號', '姓名', '得分', '首答正確(8)', '連線數', '用時(秒)', '疑似亂答',
    '第1格', '第2格', '第3格', '第4格', '第6格', '第7格', '第8格', '第9格', '誓言鷹架', '誓言內容']);
}
function readData() {
  const sh = dataSheet(), vals = sh.getDataRange().getValues(), map = {};
  for (let i = 1; i < vals.length; i++) {
    const v = vals[i]; if (!v[0]) continue;
    let attempts = []; try { attempts = JSON.parse(v[7] || '[]'); } catch (e) { attempts = []; }
    map[v[0]] = { row: i + 1, key: v[0], cls: String(v[1]), seat: Number(v[2]), name: String(v[3]).replace(/^'/, ''), best: Number(v[5]) || 0, lines: Number(v[6]) || 0, attempts: attempts, updated: v[8] };
  }
  return map;
}
function writeRow(rec) {
  const sh = dataSheet();
  const row = [rec.key, safeCell(rec.cls), rec.seat, safeCell(rec.name), ACTIVITY, rec.best, rec.lines, JSON.stringify(rec.attempts), new Date()];
  if (rec.row) sh.getRange(rec.row, 1, 1, row.length).setValues([row]);
  else sh.appendRow(row);
}

/* ---------------- 計分 ---------------- */
const LINES_THROUGH_CENTER = [['q4', 'q6'], ['q2', 'q8'], ['q1', 'q9'], ['q3', 'q7']];

function grade(choices, vow) {
  const per = {};
  let first = 0, done = 0;
  QIDS.forEach(q => {
    const arr = (choices[q] || []).map(c => String(c).toUpperCase()).filter(c => ['A', 'B', 'C'].indexOf(c) >= 0).slice(0, 5);
    const ans = ANSWERS[q].ans;
    const f = arr[0] || '', fin = arr.indexOf(ans) >= 0;
    if (f === ans) first++;
    if (fin) done++;
    per[q] = { first: f, tries: arr.length, correctFirst: f === ans, completed: fin };
  });
  const vowOk = !!(vow && vow.text && vow.blanks && vow.blanks.length === 2 && vow.blanks.every(b => String(b).trim().length >= 2));
  const lit = q => q === 'c' ? vowOk : per[q].completed;
  let lines = 0;
  if (vowOk) LINES_THROUGH_CENTER.forEach(l => { if (lit(l[0]) && lit(l[1])) lines++; });
  const score = first * 10 + (vowOk ? 20 : 0);
  return { per: per, first: first, done: done, vowOk: vowOk, lines: lines, score: score };
}

function levelReport(per, vowOk) {
  return LEVELS.map(L => {
    let got = 0;
    L.qs.forEach(q => { if (q === 'vow' ? vowOk : per[q].correctFirst) got++; });
    return { name: L.name, desc: L.desc, got: got, total: L.qs.length, pass: got / L.qs.length >= 0.66 };
  });
}

function buildReport(st, a, settings) {
  const rep = {
    cls: st.cls, seat: st.seat, name: st.name, at: a.at, seconds: a.seconds, score: a.score,
    first: a.first, done: a.done, lines: a.lines, vowOk: a.vowOk, vow: a.vow,
    levels: levelReport(a.per, a.vowOk), published: !!settings.published
  };
  if (settings.published) {
    rep.detail = QIDS.map(q => ({ q: q, mine: a.per[q].first, ans: ANSWERS[q].ans, ok: a.per[q].correctFirst, exp: ANSWERS[q].exp || '' }));
  }
  return rep;
}

function suspectOf(a, sec) {
  const firsts = QIDS.map(q => a.per[q].first).filter(Boolean);
  const same = firsts.length === QIDS.length && firsts.every(c => c === firsts[0]) && a.first < QIDS.length;
  return (a.seconds < sec) || same;
}

/* ---------------- 交卷 ---------------- */
function actSave(req, fromImport) {
  if (!answersReady()) throw new Error('老師尚未貼上答案區，請通知老師');
  const st = validStudent(req);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const settings = getSettings();
    const rows = readData();
    const rec = rows[st.key] || { key: st.key, cls: st.cls, seat: st.seat, name: st.name, best: 0, lines: 0, attempts: [] };
    const redoOk = settings.redoAll || settings.redo.indexOf(st.key) >= 0;
    if (rec.attempts.length && !redoOk && !fromImport) {
      return { ok: false, locked: true, error: '這個座號已經交過了。若要重玩，請老師在教師區開放。', report: rec.attempts.length ? buildReport(st, rec.attempts[rec.attempts.length - 1], settings) : null };
    }
    // 以伺服器記錄的作答過程為主，前端紀錄只補缺
    let att = {};
    try { att = JSON.parse(CacheService.getScriptCache().get('att:' + st.key) || '{}'); } catch (e) { att = {}; }
    const client = req.choices || {};
    const choices = {};
    QIDS.forEach(q => { choices[q] = (att[q] && att[q].length) ? att[q] : (client[q] || []); });
    const vow = req.vow ? {
      scaffold: cleanText(req.vow.scaffold, 2),
      blanks: (req.vow.blanks || []).slice(0, 2).map(b => cleanText(b, TEXT_MAX)),
      text: cleanText(req.vow.text, 400)
    } : null;
    const g = grade(choices, vow);
    if (g.lines < 1 && !fromImport) return { ok: false, error: '還沒有完成通過中央的連線，請先完成再交出' };
    const seconds = Math.max(0, Math.min(86400, Math.round(Number(req.seconds) || 0)));
    const at = fromImport && req.at ? String(req.at) : new Date().toISOString();
    const a = { at: at, seconds: seconds, score: g.score, first: g.first, done: g.done, lines: g.lines, vowOk: g.vowOk, per: g.per, vow: vow };
    if (rec.attempts.some(x => x.at === at)) return { ok: true, dup: true, report: buildReport(st, a, settings) };
    rec.name = st.name;
    rec.attempts = rec.attempts.concat(a).sort((x, y) => x.at < y.at ? -1 : 1).slice(-MAX_HISTORY);
    rec.best = Math.max.apply(null, rec.attempts.map(x => x.score));
    rec.lines = Math.max.apply(null, rec.attempts.map(x => x.lines));
    writeRow(rec);
    const sus = suspectOf(a, settings.suspectSec);
    logSheet().appendRow([new Date(at), safeCell(st.cls), st.seat, safeCell(st.name), g.score, g.first, g.lines, seconds, sus ? '是' : '',
      ...QIDS.map(q => safeCell((choices[q] || []).join('→'))), vow ? vow.scaffold : '', safeCell(vow ? vow.text : '')]);
    if (settings.redo.indexOf(st.key) >= 0) { settings.redo = settings.redo.filter(k => k !== st.key); putSettings(settings); }
    CacheService.getScriptCache().remove('att:' + st.key);
    return { ok: true, report: buildReport(st, a, settings) };
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- 學生看自己的報告書 ---------------- */
function actMyReport(req) {
  const st = validStudent(req);
  const rec = readData()[st.key];
  const settings = getSettings();
  if (!rec || !rec.attempts.length) return { ok: true, report: null, canRedo: false };
  if (rec.name !== st.name) throw new Error('姓名和紀錄不符');
  const a = rec.attempts[rec.attempts.length - 1];
  return { ok: true, report: buildReport(st, a, settings), canRedo: !!(settings.redoAll || settings.redo.indexOf(st.key) >= 0) };
}

/* ---------------- 名單／成績 ---------------- */
function actList(req) {
  const isT = req.password ? passwordOk(req.password) : false;
  if (req.password && !isT) return { ok: false, error: '密碼錯誤' };
  const rows = readData(), settings = getSettings();
  const list = Object.keys(rows).map(k => {
    const r = rows[k];
    const base = { key: r.key, cls: r.cls, seat: r.seat, name: r.name, best: r.best, lines: r.lines, n: r.attempts.length };
    if (isT) {
      base.attempts = r.attempts;
      base.last = r.attempts.length ? r.attempts[r.attempts.length - 1].at : '';
    }
    return base;
  });
  const res = { ok: true, teacher: isT, rows: list, classes: settings.classes, published: settings.published };
  if (isT) {
    res.settings = settings;
    res.answers = {};
    QIDS.forEach(q => { res.answers[q] = ANSWERS[q] ? { ans: ANSWERS[q].ans, exp: ANSWERS[q].exp || '' } : null; });
    res.answersReady = answersReady();
  }
  return res;
}

/* ---------------- 教師：刪除、清除、匯入 ---------------- */
function actDeleteAttempt(req) {
  requirePw(req);
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const rows = readData(), rec = rows[String(req.key)];
    if (!rec) return { ok: false, error: '找不到這位學生' };
    rec.attempts = rec.attempts.filter(a => a.at !== String(req.at));
    if (!rec.attempts.length) { dataSheet().deleteRow(rec.row); return { ok: true }; }
    rec.best = Math.max.apply(null, rec.attempts.map(x => x.score));
    rec.lines = Math.max.apply(null, rec.attempts.map(x => x.lines));
    writeRow(rec);
    return { ok: true };
  } finally { lock.releaseLock(); }
}

function actClearClass(req) {
  requirePw(req);
  const cls = cleanText(req.cls, 6);
  if (!cls) return { ok: false, error: '請指定班級' };
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const sh = dataSheet(), vals = sh.getDataRange().getValues();
    let n = 0;
    for (let i = vals.length - 1; i >= 1; i--) {
      if (String(vals[i][1]).replace(/^'/, '') === cls) { sh.deleteRow(i + 1); n++; }
    }
    return { ok: true, removed: n };
  } finally { lock.releaseLock(); }
}

function actImportCode(req) {
  requirePw(req);
  let p;
  try { p = JSON.parse(Utilities.newBlob(Utilities.base64Decode(String(req.code).trim())).getDataAsString()); }
  catch (e) { return { ok: false, error: '成績碼無法讀取' }; }
  return actSave(p, true);
}
