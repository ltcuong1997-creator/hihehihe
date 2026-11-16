/* ===================== BOT ZALO NỘI BỘ — HÍ HẾ =====================
   Port từ ZSpace (zspacemusicbox/functions/zalo.js, giai đoạn 1 — SPEC-zalo-bot-gd1.md), rút gọn cho
   Hí Hế: chỉ chat riêng 1-1 với bot, lệnh cố định, KHÔNG AI, KHÔNG nhóm, KHÔNG báo cáo tự động.
     · tin đến: zaloHook chỉ kiểm header + lưu tin rồi trả 200; zaloProcess (chạy khi có document mới
       trong ops_zmsg) xử lý và trả lời — Cloud Functions hạ CPU sau khi trả lời, nên "trả 200 rồi làm
       tiếp" trong cùng một hàm không chắc chạy xong;
     · Hí Hế KHÔNG có ops_consents như ZSpace -> đồng ý lưu tin nhắn ghi ngay trên liên kết
       (ops_zlink: consentV, consentAt, consentText);
     · người lạ: mỗi tài khoản Zalo nhận câu hướng dẫn tối đa 1 lần / ngày;
     · tên bot hiện trong app: cfg.zalo.botName, chưa đặt thì hỏi Zalo (getMe).

   ---- API ZALO (bot.zaloplatforms.com/docs — theo bản ZSpace đã đọc 14–15/11/2026) ----
     · Webhook: POST JSON, header "X-Bot-Api-Secret-Token" = secret_token khai ở setWebhook.
       Body { event_name, message: { message_id, date, message_type, from: { id, display_name, is_bot },
       chat: { id, chat_type: PRIVATE|GROUP }, text | photo_url, caption | sticker, url | voice_url } }.
       event_name: message.{text|image|sticker|voice|unsupported}.received. Trả lời bằng chat.id.
     · sendMessage: POST https://bot-api.zaloplatforms.com/bot<TOKEN>/sendMessage { chat_id, text }
       — text 1–2000 ký tự, văn bản thuần. Phản hồi { ok, result | error_code, description }.
     · getMe: POST .../getMe -> { ok, result: { id, account_name, ... } }.

   ---- RANH GIỚI GHI ----
   Chỉ ghi: ops_zmsg, ops_zlink, ops_zcode, ops_zquota, ops_zguard và đúng một trường `zaloLinked` của
   ops_employees. KHÔNG BAO GIỜ ghi ops_config — chỉ đọc. Không bao giờ log token.

   Phần thuần có test: cd functions && npm test */
const crypto = require('crypto');

const API_BASE_REAL = 'https://bot-api.zaloplatforms.com';
/* CHỈ trong Firebase emulator mới cho trỏ sang máy chủ Zalo giả. Bản deploy luôn dùng địa chỉ thật. */
const API_BASE = (process.env.FUNCTIONS_EMULATOR === 'true' && process.env.ZALO_API_BASE) || API_BASE_REAL;
const SECRET_HEADER = 'x-bot-api-secret-token'; // Node hạ chữ thường tên header
const SEND_TIMEOUT_MS = 8000;
const MAX_TEXT = 2000;
const APP = 'Hí Hế';

const COL = {
  link: 'ops_zlink', code: 'ops_zcode', msg: 'ops_zmsg', quota: 'ops_zquota', guard: 'ops_zguard',
  emp: 'ops_employees', cfg: 'ops_config', sch: 'ops_schedule',
};

/* Gói Zalo Bot miễn phí: tối đa 50 người dùng / bot, 3.000 tin gửi đi / tháng */
const DEF = { allowRoles: ['GS', 'AM', 'OM', 'ADMIN'], allowEmps: [], maxUsers: 50, monthlyCap: 3000, botName: '' };
const CONSENT_V = 1;
const LIM = {
  msgPerHour: 60,          /* tin đến / tài khoản Zalo / giờ — quá thì bỏ qua, không trả lời */
  codeTtl: 10 * 60e3,      /* mã kết nối sống 10 phút */
  codePerHour: 5,          /* lần xin mã / nhân viên / giờ */
  badMax: 5,               /* nhập sai mã 5 lần trong 15 phút -> khoá 15 phút */
  badWin: 15 * 60e3,
  lockMs: 15 * 60e3,
};

/* ===================== PHẦN THUẦN ===================== */

/* So khớp bí mật theo thời gian hằng (băm trước để hai bên luôn cùng độ dài). */
function secretOk(got, want) {
  if (typeof got !== 'string' || typeof want !== 'string' || !want) return false;
  const a = crypto.createHash('sha256').update(got).digest();
  const b = crypto.createHash('sha256').update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

const dayVN = (ms) => new Date(ms + 7 * 3600e3).toISOString().slice(0, 10);
const monthVN = (ms) => dayVN(ms).slice(0, 7);
const dAdd = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const clip = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

/* Cấu hình bot trong ops_config/main (khoá `zalo`) — thiếu / sai kiểu thì dùng mặc định.
   Cùng quy tắc với zaloCfg() trong index.html — sửa một bên thì sửa cả bên kia. */
const posInt = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 1 ? Math.floor(n) : d; };
const strList = (v, d) => Array.isArray(v) ? v.map(x => String(x || '').trim()).filter(Boolean) : d;
function zcfg(cfg) {
  const z = (cfg && typeof cfg.zalo === 'object' && cfg.zalo) || {};
  return {
    allowRoles: strList(z.allowRoles, DEF.allowRoles),
    allowEmps: strList(z.allowEmps, DEF.allowEmps),
    maxUsers: posInt(z.maxUsers, DEF.maxUsers),
    monthlyCap: posInt(z.monthlyCap, DEF.monthlyCap),
    botName: String(z.botName || '').trim().slice(0, 80),
  };
}
/* Người được dùng bot: đang làm, và (vai trò nằm trong allowRoles hoặc có tên trong allowEmps). */
function eligible(emp, zc) {
  if (!emp || !emp.id || emp.status === 'off') return false;
  return zc.allowRoles.includes(String(emp.role || '')) || zc.allowEmps.includes(String(emp.id));
}

/* Bỏ dấu, đ -> d, chữ thường, bỏ dấu câu, gộp khoảng trắng. */
function normalize(text) {
  return String(text == null ? '' : text)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
const CMDS = {
  help: ['giup', 'help', 'giup do', 'huong dan', 'menu', 'lenh'],
  lich: ['lich', 'xem lich', 'lich lam', 'lich lam viec', 'lich cua toi'],
  unlink: ['huy ket noi', 'ngat ket noi'],
  agree: ['dong y', 'dongy', 'toi dong y'],
};

/* -> { cmd: 'help' | 'lich' | 'unlink' | 'agree' | 'code' | 'unknown', code? } */
function parseCmd(text) {
  const raw = String(text == null ? '' : text).trim();
  const digits = raw.replace(/[\s.\-]/g, '');
  if (/^\d{6}$/.test(digits)) return { cmd: 'code', code: digits };
  const n = normalize(raw);
  if (!n) return { cmd: /\?/.test(raw) ? 'help' : 'unknown' };
  for (const k of Object.keys(CMDS)) if (CMDS[k].includes(n)) return { cmd: k };
  return { cmd: 'unknown' };
}

/* Dữ liệu webhook -> tin gọn để lưu. Không đủ trường thì { ok:false } (vd request kiểm tra của Zalo). */
const EV_LABEL = {
  'message.image.received': '[ảnh]', 'message.sticker.received': '[sticker]',
  'message.voice.received': '[tin thoại]', 'message.unsupported.received': '[tin không hỗ trợ]',
};
function parseEvent(body) {
  if (!body || typeof body !== 'object') return { ok: false, why: 'no_body' };
  const m = body.message;
  if (!m || typeof m !== 'object') return { ok: false, why: 'no_message' };
  const id = (v) => (typeof v === 'string' || typeof v === 'number') && String(v).trim() ? String(v).trim() : '';
  const msgId = id(m.message_id), zaloId = id(m.from && m.from.id), chatId = id(m.chat && m.chat.id);
  if (!msgId || !zaloId || !chatId) return { ok: false, why: 'missing_ids' };
  const event = String(body.event_name || '');
  const text = event === 'message.text.received' ? String(m.text || '')
    : (EV_LABEL[event] || '[tin]') + (m.caption ? ' ' + String(m.caption) : '');
  return {
    ok: true, msgId, zaloId, chatId, event,
    chatType: String((m.chat && m.chat.chat_type) || ''),
    isBot: !!(m.from && m.from.is_bot === true),
    zname: clip((m.from && m.from.display_name) || '', 80),
    text: clip(text, MAX_TEXT),
    zdate: Number(m.date) || 0,
  };
}
const inDocId = (msgId) => 'in_' + String(msgId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 200);

/* Mã kết nối: 'ok' | 'missing' | 'used' | 'expired' | 'taken' (đang chờ DONG Y ở tài khoản Zalo khác). */
function checkCode(c, zaloId, now) {
  if (!c || !c.empId) return 'missing';
  if (c.used) return 'used';
  if (!(Number(c.exp) > now)) return 'expired';
  if (c.pendingZaloId && c.pendingZaloId !== zaloId) return 'taken';
  return 'ok';
}

/* Bộ đếm theo cửa sổ cố định. Trả bản ghi mới (chỉ các trường đổi) + đã vượt chưa. */
function tick(g, now, kStart, kN, win, max) {
  const s = Number((g || {})[kStart]) || 0, n = Number((g || {})[kN]) || 0;
  const fresh = !s || now - s >= win;
  const n2 = fresh ? 1 : n + 1;
  return { upd: { [kStart]: fresh ? now : s, [kN]: n2 }, over: n2 > max };
}
const hourTick = (g, now) => tick(g, now, 'hStart', 'hN', 3600e3, LIM.msgPerHour);
const codeTick = (g, now) => tick(g, now, 'cStart', 'cN', 3600e3, LIM.codePerHour);
const isLocked = (g, now) => Number((g || {}).lockUntil) > now;
/* Một lần nhập sai mã. Đủ 5 lần trong 15 phút -> khoá 15 phút, xoá bộ đếm. */
function badCode(g, now) {
  const t = tick(g, now, 'bStart', 'bN', LIM.badWin, Infinity);
  if (t.upd.bN >= LIM.badMax) return { upd: { bStart: 0, bN: 0, lockUntil: now + LIM.lockMs }, locked: true };
  return { upd: t.upd, locked: false };
}

/* Hạn mức tin gửi đi trong tháng:
     < 80%  : gửi mọi loại
     >= 80% : chỉ 'reply' (trả lời lệnh + luồng kết nối) và 'alert' (cảnh báo hạn mức cho ADMIN, 1 lần ở 95%)
     >= 100%: không gửi gì */
function quotaGate(kind, sent, cap) {
  if (!(cap > 0) || sent >= cap) return false;
  if (sent / cap >= 0.8) return kind === 'reply' || kind === 'alert';
  return true;
}
const needWarn95 = (sentAfter, cap, warned) => !warned && cap > 0 && sentAfter >= 0.95 * cap;

/* ---- Lịch 7 ngày: cùng cách màn "Lịch làm việc của tôi" (myShiftsOn) ----
   ops_schedule/{chi nhánh}_{ngày}_{ca} = { branchId, date, shiftId, empIds }; chỉ tính chi nhánh và
   ca còn trong cấu hình. */
const WD = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const ddmm = (d) => d.slice(8, 10) + '/' + d.slice(5, 7);
function buildWeek(docs, empId, cfg, from, n = 7) {
  const shifts = (cfg && cfg.shifts) || [], branches = ((cfg && cfg.branches) || []).filter(b => b && b.status !== 'closed');
  const days = Array.from({ length: n }, (_, i) => dAdd(from, i));
  const by = {};
  (docs || []).forEach(d => {
    if (!d || !Array.isArray(d.empIds) || !d.empIds.includes(empId) || !days.includes(d.date)) return;
    const s = shifts.find(x => x && x.id === d.shiftId), b = branches.find(x => x && x.id === d.branchId);
    if (!s || !b) return;
    (by[d.date] = by[d.date] || []).push({ shift: s.name || s.code || s.id, start: s.start || '', end: s.end || '', branch: b.name || b.code || b.id });
  });
  return days.map(d => ({ date: d, items: (by[d] || []).sort((a, b) => a.start.localeCompare(b.start)) }));
}
function fmtWeek(week, name) {
  const total = week.reduce((a, d) => a + d.items.length, 0);
  const span = ddmm(week[0].date) + ' - ' + ddmm(week[week.length - 1].date);
  if (!total) return 'Lịch 7 ngày tới (' + span + ') của ' + name + ': chưa được xếp ca nào.';
  const lines = week.map(d => {
    const wd = WD[new Date(d.date + 'T00:00:00Z').getUTCDay()];
    const v = d.items.length ? d.items.map(x => x.shift + ' ' + x.start + '-' + x.end + ', ' + x.branch).join('; ') : 'nghỉ';
    return wd + ' ' + ddmm(d.date) + ': ' + v;
  });
  return clip('Lịch 7 ngày tới của ' + name + ' (' + total + ' ca):\n' + lines.join('\n'), MAX_TEXT);
}

/* ---- Câu trả lời (văn bản thuần, không markdown) ---- */
const T = {
  help: 'Các lệnh của bot ' + APP + ':\n- LICH: lịch làm việc 7 ngày tới\n- HUY KET NOI: ngắt kết nối Zalo với app\n- GIUP: xem lại các lệnh\nGõ có dấu hay không dấu đều được.',
  guide: 'Chào anh/chị, đây là bot nội bộ ' + APP + '. Để dùng bot: mở app ' + APP + ' > Hồ sơ của tôi > Kết nối Zalo > Lấy mã kết nối, rồi nhắn mã 6 số vào đây.',
  consent: 'Tin nhắn của anh/chị với bot được lưu lại để xử lý công việc, quản trị viên có thể xem lại. Bot không đọc được các cuộc trò chuyện khác của anh/chị. Đồng ý thì nhắn: DONG Y',
  voice: 'Em chưa đọc được ảnh, tin thoại hay sticker, anh/chị nhắn chữ giúp em nhé. Nhắn GIUP để xem các lệnh.',
  group: 'Bot ' + APP + ' hiện chỉ làm việc trong tin nhắn riêng. Anh/chị nhắn riêng cho bot nhé.',
  codeBad: 'Mã không đúng hoặc đã hết hạn. Lấy mã mới trong app (Hồ sơ của tôi > Kết nối Zalo) rồi nhắn lại.',
  codeGone: 'Mã kết nối đã hết hạn hoặc không còn dùng được. Lấy mã mới trong app rồi nhắn lại.',
  locked: 'Nhập sai mã quá nhiều lần. Anh/chị thử lại sau 15 phút.',
  remind: 'Nhắn DONG Y để hoàn tất kết nối. Không muốn kết nối thì bỏ qua tin này.',
  notAllowed: 'Tài khoản của anh/chị hiện chưa được dùng bot Zalo. Liên hệ quản trị.',
  full: (n) => 'Bot đã đủ ' + n + ' người, liên hệ quản trị.',
  welcome: (name) => 'Chào ' + name + ', đã kết nối Zalo với tài khoản ' + APP + '.\n\nCác lệnh: LICH (lịch 7 ngày tới), HUY KET NOI (ngắt kết nối), GIUP (xem lại các lệnh).',
  stopped: 'Tài khoản đã ngừng kết nối.',
  unlinked: (name) => 'Đã ngắt kết nối Zalo với tài khoản của ' + name + '. Muốn kết nối lại, lấy mã mới trong app.',
  already: (name) => 'Tài khoản Zalo này đang kết nối với ' + name + '. Muốn đổi, nhắn HUY KET NOI trước.',
  unknown: 'Em chưa hiểu, nhắn GIÚP để xem các lệnh',
  warn95: (sent, cap, mk) => 'Cảnh báo: bot Zalo đã gửi ' + sent + '/' + cap + ' tin trong tháng ' + mk.slice(5, 7) + '/' + mk.slice(0, 4)
    + '. Từ giờ bot chỉ trả lời lệnh; gửi đủ ' + cap + ' tin thì bot ngừng gửi đến hết tháng.',
};

/* ===================== GỌI API ZALO ===================== */
async function callApi({ token, method, payload, fetchFn = fetch, timeoutMs = SEND_TIMEOUT_MS, base = API_BASE }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchFn(`${base}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload || {}),
      signal: ctl.signal,
    });
    let j = null;
    try { j = await r.json(); } catch (_) { /* body không phải JSON */ }
    if (!j || j.ok !== true) {
      /* Không bao giờ đưa URL (có token) vào thông báo lỗi */
      const err = new Error(`${method} lỗi: http ${r.status}` + (j ? ` · ${j.error_code || ''} ${j.description || ''}`.trimEnd() : ''));
      err.status = r.status;
      err.code = j && j.error_code;
      throw err;
    }
    return j.result;
  } finally {
    clearTimeout(timer);
  }
}
const sendMessage = ({ token, chatId, text, fetchFn, timeoutMs }) =>
  callApi({ token, method: 'sendMessage', payload: { chat_id: chatId, text }, fetchFn, timeoutMs });

/* ===================== PHẦN CHẠY VỚI FIRESTORE ===================== */
function createZalo(deps) {
  const { db, FV, HttpsError, findEmp, getToken, getSecret } = deps;
  const log = deps.log || console;
  const fetchFn = deps.fetchFn || fetch;
  const now = deps.now || (() => Date.now());
  const col = (k) => db.collection(COL[k]);

  /* ops_config/main — CHỈ ĐỌC, nhớ 60 giây */
  let cfgC = null, cfgAt = 0;
  async function getCfg() {
    if (cfgC && now() - cfgAt < 60e3) return cfgC;
    const s = await col('cfg').doc('main').get();
    cfgC = (s.exists ? s.data() : {}) || {};
    cfgAt = now();
    return cfgC;
  }

  /* ---------- Gửi 1 tin: kiểm hạn mức -> gửi -> đếm -> ghi nhật ký ---------- */
  async function send({ zaloId, chatId, empId = '', kind, text, cmd = '' }) {
    const t = now(), mk = monthVN(t);
    const qref = col('quota').doc(mk);
    const zc = zcfg(await getCfg());
    const qs = await qref.get();
    const q = qs.exists ? (qs.data() || {}) : {};
    const sent = Number(q.sent) || 0;
    const body = clip(text, MAX_TEXT);
    let result, err = '';
    if (!quotaGate(kind, sent, zc.monthlyCap)) {
      result = 'skipped_quota';
    } else {
      try {
        await sendMessage({ token: getToken(), chatId, text: body, fetchFn });
        result = 'sent';
      } catch (e) {
        result = 'failed';
        err = clip(e && e.message, 300);
        log.error('zalo: gửi tin lỗi', { kind, err });
      }
    }
    if (result === 'sent') {
      await qref.set({ month: mk, sent: FV.increment(1), byKind: { [kind]: FV.increment(1) }, updatedAt: FV.serverTimestamp() }, { merge: true });
    }
    const outId = 'out_' + t + '_' + crypto.randomBytes(4).toString('hex');
    await col('msg').doc(outId).set({
      dir: 'out', zaloId: String(zaloId || ''), chatId: String(chatId || ''), empId: String(empId || ''),
      kind, cmd, text: body, result, err, at: FV.serverTimestamp(), atMs: t, st: 'done',
    });
    if (result === 'sent' && needWarn95(sent + 1, zc.monthlyCap, q.warned95)) await warnAdmins(qref, zc.monthlyCap, mk).catch(e => log.error('zalo: cảnh báo hạn mức lỗi', { err: String(e && e.message) }));
    return result;
  }

  /* 95% hạn mức: báo 1 lần cho mọi ADMIN đã kết nối (cờ warned95 giành bằng giao dịch) */
  async function warnAdmins(qref, cap, mk) {
    const mine = await db.runTransaction(async (tx) => {
      const s = await tx.get(qref);
      const v = s.exists ? (s.data() || {}) : {};
      if (v.warned95) return null;
      tx.set(qref, { warned95: true, warned95At: FV.serverTimestamp() }, { merge: true });
      return Number(v.sent) || 0;
    });
    if (mine == null) return;
    const links = await col('link').where('active', '==', true).get();
    for (const l of links.docs) {
      const lv = l.data() || {};
      const es = await col('emp').doc(String(lv.empId || '_')).get();
      if (!es.exists || (es.data() || {}).role !== 'ADMIN') continue;
      await send({ zaloId: l.id, chatId: lv.chatId || l.id, empId: lv.empId, kind: 'alert', text: T.warn95(mine, cap, mk) });
    }
  }

  /* ---------- Ngắt liên kết ---------- */
  /* Mọi liên kết đang bật của một nhân sự; tắt cờ zaloLinked trên hồ sơ. Trả số liên kết đã ngắt. */
  async function unlinkEmp(empId, reason, by) {
    return db.runTransaction(async (tx) => {
      const q = await tx.get(col('link').where('empId', '==', empId));
      const eref = col('emp').doc(empId);
      const es = await tx.get(eref);
      let n = 0;
      q.docs.forEach(d => {
        if ((d.data() || {}).active !== true) return;
        tx.update(d.ref, { active: false, unlinkedAt: FV.serverTimestamp(), unlinkReason: reason, unlinkBy: String(by || '') });
        n++;
      });
      if (es.exists && (es.data() || {}).zaloLinked === true) tx.update(eref, { zaloLinked: false });
      return n;
    });
  }

  /* ---------- Bộ đếm / cờ theo tài khoản Zalo (ops_zguard) ---------- */
  async function guardTick(gref, t) {
    return db.runTransaction(async (tx) => {
      const s = await tx.get(gref);
      const g = s.exists ? (s.data() || {}) : {};
      const h = hourTick(g, t);
      tx.set(gref, h.upd, { merge: true });
      return { g: { ...g, ...h.upd }, over: h.over };
    });
  }
  /* Giành một cờ (vd đã gửi hướng dẫn hôm nay) — chỉ một lượt xử lý thắng khi tin đến dồn dập */
  async function claim(gref, field, value) {
    return db.runTransaction(async (tx) => {
      const s = await tx.get(gref);
      if (s.exists && (s.data() || {})[field] === value) return false;
      tx.set(gref, { [field]: value }, { merge: true });
      return true;
    });
  }

  /* ---------- Lịch 7 ngày ---------- */
  async function lichText(emp) {
    const cfg = await getCfg();
    const from = dayVN(now()), to = dAdd(from, 6);
    const qs = await col('sch').where('date', '>=', from).where('date', '<=', to).get();
    return fmtWeek(buildWeek(qs.docs.map(d => d.data()), emp.id, cfg, from, 7), emp.name || 'anh/chị');
  }

  /* ---------- Người đã kết nối ---------- */
  async function handleLinked(v, link, pc) {
    const zid = v.zaloId, chat = v.chatId, empId = String(link.empId || '');
    const reply = (text, cmd) => send({ zaloId: zid, chatId: chat, empId, kind: 'reply', text, cmd: cmd || pc.cmd });
    const es = empId ? await col('emp').doc(empId).get() : null;
    const emp = es && es.exists ? { ...(es.data() || {}), id: empId } : null;
    if (!emp || emp.status === 'off') {
      await col('link').doc(zid).update({ active: false, unlinkedAt: FV.serverTimestamp(), unlinkReason: 'emp_off', unlinkBy: 'system' });
      if (empId) await unlinkEmp(empId, 'emp_off', 'system');
      await reply(T.stopped);
      return { cmd: pc.cmd, result: 'emp_off', empId };
    }
    await col('link').doc(zid).update({ lastAt: FV.serverTimestamp(), lastAtMs: now() }).catch(() => {});
    if (pc.cmd === 'help') { await reply(T.help); return { cmd: 'help', result: 'ok', empId }; }
    if (pc.cmd === 'lich') { await reply(await lichText(emp)); return { cmd: 'lich', result: 'ok', empId }; }
    if (pc.cmd === 'unlink') {
      await unlinkEmp(empId, 'self_bot', empId);
      await reply(T.unlinked(emp.name || ''));
      return { cmd: 'unlink', result: 'ok', empId };
    }
    if (pc.cmd === 'code') { await reply(T.already(emp.name || '')); return { cmd: 'code', result: 'already_linked', empId }; }
    if (v.event !== 'message.text.received') { await reply(T.voice); return { cmd: pc.cmd, result: 'not_text', empId }; }
    await reply(T.unknown);
    return { cmd: pc.cmd, result: 'unknown', empId };
  }

  /* ---------- Người chưa kết nối ---------- */
  async function guideOnce(v, gref, cmd) {
    if (!(await claim(gref, 'guideDay', dayVN(now())))) return { cmd, result: 'guide_skipped' };
    await send({ zaloId: v.zaloId, chatId: v.chatId, kind: 'guide', text: T.guide, cmd });
    return { cmd, result: 'guide' };
  }

  /* Bước 1: nhắn mã 6 số */
  async function codeStep(v, gref, code) {
    const t = now();
    const cref = col('code').doc(code);
    const r = await db.runTransaction(async (tx) => {
      const cs = await tx.get(cref);
      const gs = await tx.get(gref);
      const g = gs.exists ? (gs.data() || {}) : {};
      if (isLocked(g, t)) return { st: 'locked_quiet' };
      const c = cs.exists ? (cs.data() || {}) : null;
      const chk = checkCode(c, v.zaloId, t);
      if (chk !== 'ok') {
        const b = badCode(g, t);
        tx.set(gref, b.locked ? { ...b.upd, lockNote: true } : b.upd, { merge: true });
        return { st: b.locked ? 'locked' : 'bad', chk };
      }
      tx.update(cref, { pendingZaloId: v.zaloId, pendingAt: t });
      tx.set(gref, { pendingCode: code, pendingExp: Number(c.exp) || 0, bN: 0, bStart: 0 }, { merge: true });
      return { st: 'ok', empId: c.empId };
    });
    const reply = (text) => send({ zaloId: v.zaloId, chatId: v.chatId, empId: r.empId || '', kind: 'reply', text, cmd: 'code' });
    if (r.st === 'ok') { await reply(T.consent); return { cmd: 'code', result: 'code_ok', empId: r.empId }; }
    if (r.st === 'locked') { await reply(T.locked); return { cmd: 'code', result: 'locked' }; }
    if (r.st === 'locked_quiet') return lockedNote(v, gref, 'code');
    await reply(T.codeBad);
    return { cmd: 'code', result: 'code_' + r.chk };
  }

  async function lockedNote(v, gref, cmd) {
    if (await claim(gref, 'lockNote', true)) await send({ zaloId: v.zaloId, chatId: v.chatId, kind: 'reply', text: T.locked, cmd });
    return { cmd, result: 'locked' };
  }

  /* Bước 2: nhắn DONG Y -> tạo liên kết */
  async function agreeStep(v, gref, g) {
    const t = now(), zid = v.zaloId;
    const code = String(g.pendingCode || '');
    const reply = (text, empId) => send({ zaloId: zid, chatId: v.chatId, empId: empId || '', kind: 'reply', text, cmd: 'agree' });
    const clearPending = () => gref.set({ pendingCode: FV.delete(), pendingExp: FV.delete() }, { merge: true });
    const cref = col('code').doc(code);
    const cs = await cref.get();
    const c = cs.exists ? (cs.data() || {}) : null;
    if (checkCode(c, zid, t) !== 'ok' || c.pendingZaloId !== zid) {
      await clearPending();
      await reply(T.codeGone);
      return { cmd: 'agree', result: 'code_gone' };
    }
    const empId = String(c.empId);
    const eref = col('emp').doc(empId);
    const es = await eref.get();
    const emp = es.exists ? { ...(es.data() || {}), id: empId } : null;
    const zc = zcfg(await getCfg());
    if (!eligible(emp, zc)) {
      await clearPending();
      await reply(T.notAllowed, empId);
      return { cmd: 'agree', result: 'not_allowed', empId };
    }
    /* Đếm chỗ: người đang có liên kết (đổi sang Zalo khác) không tốn thêm chỗ */
    const mineQ = await col('link').where('empId', '==', empId).get();
    const hasActive = mineQ.docs.some(d => (d.data() || {}).active === true);
    if (!hasActive) {
      const n = (await col('link').where('active', '==', true).count().get()).data().count;
      if (n >= zc.maxUsers) {
        await clearPending();
        await reply(T.full(zc.maxUsers), empId);
        return { cmd: 'agree', result: 'full', empId };
      }
    }
    const lref = col('link').doc(zid);
    let ok = true;
    try {
      await db.runTransaction(async (tx) => {
        const cs2 = await tx.get(cref);
        const old = await tx.get(col('link').where('empId', '==', empId));
        const es2 = await tx.get(eref);
        const c2 = cs2.exists ? (cs2.data() || {}) : null;
        if (checkCode(c2, zid, t) !== 'ok' || c2.pendingZaloId !== zid || !es2.exists) throw new Error('ABORT_CODE');
        old.docs.forEach(d => {
          if (d.id !== zid && (d.data() || {}).active === true) {
            tx.update(d.ref, { active: false, unlinkedAt: FV.serverTimestamp(), unlinkReason: 'relinked', unlinkBy: empId });
          }
        });
        tx.set(lref, {
          empId, name: String(emp.name || ''), zaloName: v.zname || '', chatId: v.chatId,
          linkedAt: FV.serverTimestamp(), linkedAtMs: t, lastAtMs: t, active: true,
          consentV: CONSENT_V, consentAt: t, consentText: T.consent,
        });
        tx.update(cref, { used: true, usedAt: t, usedBy: zid });
        tx.update(eref, { zaloLinked: true });
        tx.set(gref, { pendingCode: FV.delete(), pendingExp: FV.delete(), bN: 0, bStart: 0 }, { merge: true });
      });
    } catch (e) {
      ok = false;
      if (String(e && e.message) !== 'ABORT_CODE') log.error('zalo: kết nối lỗi', { err: String(e && e.message) });
    }
    if (!ok) {
      await clearPending().catch(() => {});
      await reply(T.codeGone, empId);
      return { cmd: 'agree', result: 'link_failed', empId };
    }
    await reply(T.welcome(emp.name || ''), empId);
    return { cmd: 'agree', result: 'linked', empId };
  }

  async function handleStranger(v, gref, g, pc) {
    const t = now();
    if (isLocked(g, t)) return lockedNote(v, gref, pc.cmd);
    if (pc.cmd === 'code') return codeStep(v, gref, pc.code);
    const pending = g.pendingCode && Number(g.pendingExp) > t;
    if (pc.cmd === 'agree' && g.pendingCode) return agreeStep(v, gref, g);
    if (pending) {
      await send({ zaloId: v.zaloId, chatId: v.chatId, kind: 'reply', text: T.remind, cmd: pc.cmd });
      return { cmd: pc.cmd, result: 'remind' };
    }
    return guideOnce(v, gref, pc.cmd);
  }

  /* ---------- Một tin đến ---------- */
  async function handleIn(v) {
    if (v.event === 'message.unsupported.received') return { result: 'ignored_unsupported' };
    const gref = col('guard').doc(String(v.zaloId));
    const gt = await guardTick(gref, now());
    if (gt.over) return { result: 'rate_limited' };
    const pc = parseCmd(v.event === 'message.text.received' ? v.text : '');
    const ls = await col('link').doc(String(v.zaloId)).get();
    const link = ls.exists ? (ls.data() || {}) : null;
    if (link && link.active === true) return handleLinked(v, link, pc);
    return handleStranger(v, gref, gt.g, pc);
  }

  /* zaloProcess: giành tin (st new -> proc) rồi xử lý. Trigger Firestore có thể bắn lại -> giành
     bằng giao dịch để mỗi tin chỉ xử lý một lần. */
  async function processIn(id) {
    const ref = col('msg').doc(id);
    const v = await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists) return null;
      const d = s.data() || {};
      if (d.dir !== 'in' || d.st !== 'new') return null;
      tx.update(ref, { st: 'proc' });
      return d;
    });
    if (!v) return null;
    let out;
    try { out = await handleIn(v); } catch (e) {
      log.error('zalo: xử lý tin lỗi', { id, err: String(e && e.message) });
      out = { result: 'error' };
    }
    await ref.update({ st: 'done', cmd: out.cmd || '', result: out.result || '', empId: out.empId || '', doneAt: FV.serverTimestamp() });
    return out;
  }

  /* ---------- zaloHook: kiểm header, lưu tin, trả 200 ---------- */
  async function hook(req, res) {
    if (req.method !== 'POST') { res.status(405).json({ message: 'Method Not Allowed' }); return; }
    const got = req.get ? req.get(SECRET_HEADER) : (req.headers || {})[SECRET_HEADER];
    if (!secretOk(got, getSecret())) {
      log.warn('zaloHook: sai hoặc thiếu header bí mật');
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = null; } }
    const ev = parseEvent(body);
    /* Request kiểm tra của Zalo / tin do bot gửi / tin trong nhóm (Hí Hế chưa làm nhóm): nhận nhưng không lưu */
    if (!ev.ok || ev.isBot || ev.chatType !== 'PRIVATE') { res.status(200).json({ message: 'Success' }); return; }
    try {
      await col('msg').doc(inDocId(ev.msgId)).create({
        dir: 'in', zaloId: ev.zaloId, chatId: ev.chatId, chatType: ev.chatType, zname: ev.zname,
        event: ev.event, text: ev.text, zdate: ev.zdate, empId: '', cmd: '', result: '', st: 'new',
        at: FV.serverTimestamp(), atMs: now(),
      });
    } catch (e) {
      const dup = e && (e.code === 6 || /already exists/i.test(String(e.message)));
      if (!dup) {
        log.error('zaloHook: lưu tin lỗi', { err: String(e && e.message) });
        res.status(500).json({ message: 'Error' });
        return;
      }
    }
    res.status(200).json({ message: 'Success' });
  }

  /* ---------- zaloLinkCode: nhân viên xin mã 6 số ---------- */
  let meName = '', meAt = 0;
  async function botName(zc) {
    if (zc.botName) return zc.botName;
    if (meName && now() - meAt < 6 * 3600e3) return meName;
    try {
      const r = await callApi({ token: getToken(), method: 'getMe', fetchFn });
      meName = String((r && r.account_name) || '');
      meAt = now();
    } catch (e) { log.warn('zalo: getMe lỗi', { err: String(e && e.message) }); }
    return meName;
  }

  async function linkCode(req) {
    if (!(req.auth && req.auth.uid)) throw new HttpsError('unauthenticated', 'Chưa đăng nhập');
    const emp = await findEmp(req);
    if (!emp || !emp.id) throw new HttpsError('permission-denied', 'Không tìm thấy hồ sơ nhân sự — thử đăng xuất rồi đăng nhập lại');
    if (emp.status === 'off') throw new HttpsError('permission-denied', 'Hồ sơ đã nghỉ việc, không kết nối được Zalo');
    const zc = zcfg(await getCfg());
    if (!eligible(emp, zc)) throw new HttpsError('permission-denied', 'Tài khoản của bạn chưa được dùng bot Zalo. Liên hệ quản trị.');
    const t = now();
    const gref = col('guard').doc('emp_' + emp.id);
    const over = await db.runTransaction(async (tx) => {
      const s = await tx.get(gref);
      const c = codeTick(s.exists ? s.data() : {}, t);
      if (!c.over) tx.set(gref, c.upd, { merge: true });
      return c.over;
    });
    if (over) throw new HttpsError('resource-exhausted', 'Đã xin mã ' + LIM.codePerHour + ' lần trong 1 giờ, thử lại sau.');
    const mine = await col('link').where('empId', '==', emp.id).get();
    if (!mine.docs.some(d => (d.data() || {}).active === true)) {
      const n = (await col('link').where('active', '==', true).count().get()).data().count;
      if (n >= zc.maxUsers) throw new HttpsError('resource-exhausted', 'Bot đã đủ ' + zc.maxUsers + ' người, liên hệ quản trị');
    }
    /* Huỷ mã cũ chưa dùng của người này */
    const old = await col('code').where('empId', '==', emp.id).get();
    const del = old.docs.filter(d => !(d.data() || {}).used);
    if (del.length) { const b = db.batch(); del.forEach(d => b.delete(d.ref)); await b.commit(); }
    /* Mã mới: ngẫu nhiên, không trùng bất kỳ mã nào đang có (kể cả mã đã dùng — giữ làm vết) */
    const exp = t + LIM.codeTtl;
    for (let i = 0; i < 20; i++) {
      const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
      const cref = col('code').doc(code);
      const got = await db.runTransaction(async (tx) => {
        const s = await tx.get(cref);
        if (s.exists) return false;
        tx.set(cref, { empId: emp.id, name: String(emp.name || ''), createdAt: t, exp, used: false });
        return true;
      });
      if (got) return { code, exp, ttl: LIM.codeTtl, botName: await botName(zc) };
    }
    throw new HttpsError('unavailable', 'Chưa tạo được mã, thử lại');
  }

  /* ---------- zaloUnlink: tự ngắt, hoặc ADMIN ngắt hộ ---------- */
  async function unlink(req) {
    if (!(req.auth && req.auth.uid)) throw new HttpsError('unauthenticated', 'Chưa đăng nhập');
    const me = await findEmp(req);
    if (!me || !me.id) throw new HttpsError('permission-denied', 'Không tìm thấy hồ sơ nhân sự — thử đăng xuất rồi đăng nhập lại');
    const target = String(((req.data || {}).empId) || me.id).slice(0, 100);
    if (target !== me.id && !(me.role === 'ADMIN' && me.status !== 'off')) {
      throw new HttpsError('permission-denied', 'Chỉ ADMIN được ngắt kết nối hộ người khác');
    }
    const n = await unlinkEmp(target, target === me.id ? 'self_app' : 'admin', me.id);
    return { n };
  }

  return { hook, processIn, linkCode, unlink, send, unlinkEmp, getCfg };
}

module.exports = {
  API_BASE, SECRET_HEADER, COL, DEF, LIM, T, CONSENT_V,
  secretOk, dayVN, monthVN, dAdd, zcfg, eligible, normalize, parseCmd, parseEvent, inDocId,
  checkCode, hourTick, codeTick, isLocked, badCode, quotaGate, needWarn95,
  buildWeek, fmtWeek, callApi, sendMessage, createZalo,
};
