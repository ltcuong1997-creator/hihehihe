/* ===================== BOT ZALO NỘI BỘ — HÍ HẾ =====================
   Port từ ZSpace (zspacemusicbox/functions/zalo.js). Gồm:
     · chat riêng 1-1: kết nối mã 6 số + DONG Y, lệnh nhanh LICH / GIUP / HUY KET NOI;
     · trợ lý AI (zaloai.js + zalotools.js): hiểu câu tự do, tra số liệu theo quyền app, soạn nháp
       việc ghi (báo sự cố, lập đề xuất mua, duyệt) — ghi thật chỉ sau khi người dùng nhắn OK;
     · NHÓM Zalo ban quản trị: ADMIN gõ "bot ket noi nhom" để gắn; trong nhóm ai cũng hỏi được
       ("bot ..."), việc ghi chỉ người đã kết nối, theo quyền của chính người đó.
   Không có báo cáo tự động (ZSpace có).
     · tin đến: zaloHook chỉ kiểm header + lưu tin rồi trả 200; zaloProcess (chạy khi có document mới
       trong ops_zmsg) xử lý và trả lời — Cloud Functions hạ CPU sau khi trả lời, nên "trả 200 rồi làm
       tiếp" trong cùng một hàm không chắc chạy xong;
     · Hí Hế KHÔNG có ops_consents như ZSpace -> đồng ý lưu tin nhắn ghi ngay trên liên kết
       (ops_zlink: consentV, consentAt, consentText);
     · người lạ: mỗi tài khoản Zalo nhận câu hướng dẫn tối đa 1 lần / ngày;
     · tên bot hiện trong app: cfg.zalo.botName, chưa đặt thì hỏi Zalo (getMe);
     · đồng ý bản có AI (consentV 2): người kết nối từ trước bản AI được hỏi đồng ý lại một lần.

   ---- API ZALO (bot.zaloplatforms.com/docs — theo bản ZSpace đã đọc 14–15/11/2026) ----
     · Webhook: POST JSON, header "X-Bot-Api-Secret-Token" = secret_token khai ở setWebhook.
       Body { event_name, message: { message_id, date, message_type, from: { id, display_name, is_bot },
       chat: { id, chat_type: PRIVATE|GROUP }, text | photo_url, caption | sticker, url | voice_url } }.
       event_name: message.{text|image|sticker|voice|unsupported}.received. Trả lời bằng chat.id
       (tin nhóm: chat.id là mã nhóm).
     · sendMessage: POST https://bot-api.zaloplatforms.com/bot<TOKEN>/sendMessage { chat_id, text }
       — text 1–2000 ký tự, văn bản thuần. Phản hồi { ok, result | error_code, description }.
     · getMe: POST .../getMe -> { ok, result: { id, account_name, ... } }.
     · sendPhoto: POST .../sendPhoto { chat_id, photo (link ảnh), caption } — dùng gửi ảnh lịch.

   ---- RANH GIỚI GHI ----
   Bot tự ghi: ops_zmsg, ops_zlink, ops_zcode, ops_zquota, ops_zguard, ops_zgroup và đúng một trường
   `zaloLinked` của ops_employees. Ghi dữ liệu app (sự cố, đề xuất mua, duyệt) chỉ qua execPending của
   zalotools.js sau khi người dùng nhắn OK. KHÔNG BAO GIỜ ghi ops_config — chỉ đọc. Không log token.

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
  emp: 'ops_employees', cfg: 'ops_config', sch: 'ops_schedule', group: 'ops_zgroup',
};

/* Gói Zalo Bot miễn phí: tối đa 50 người dùng / bot, 3.000 tin gửi đi / tháng */
const DEF = {
  allowRoles: ['GS', 'AM', 'OM', 'ADMIN'], allowEmps: [], maxUsers: 50, monthlyCap: 3000, botName: '',
  ai: true, aiCapUsd: 20, aiModel: 'claude-opus-5-5', maxGroups: 3, reportRoles: ['OM', 'ADMIN'],
};
const AI_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
/* Phiên bản câu đồng ý: 2 = có thêm ý tin nhắn được trợ lý AI xử lý */
const CONSENT_V = 2;
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
    ai: z.ai !== false,
    aiModel: AI_MODELS.includes(z.aiModel) ? z.aiModel : DEF.aiModel,
    maxGroups: posInt(z.maxGroups, DEF.maxGroups),
    reportRoles: strList(z.reportRoles, DEF.reportRoles),
    aiCapUsd: (() => { const n = Number(z.aiCapUsd); return Number.isFinite(n) && n >= 0 ? Math.min(n, 1000) : DEF.aiCapUsd; })(),
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

/* Tin trong NHÓM chỉ xử lý khi GỌI bot: bắt đầu bằng "bot" / "@Bot ..." (tên bot Zalo luôn bắt đầu bằng
   "Bot") hoặc "/". Trả phần còn lại sau lời gọi (bỏ cả "ơi", dấu câu), hoặc null nếu không gọi bot —
   khi đó tin không được lưu, không qua AI (chat bình thường của nhóm là chuyện riêng của nhóm). */
function groupCall(text, botName) {
  let s = String(text == null ? '' : text).normalize('NFC').trim();
  const bn = String(botName || '').normalize('NFC').trim();
  const s0 = s.replace(/^@\s*/, '');
  if (bn && s0.toLowerCase().startsWith(bn.toLowerCase())) s = s0.slice(bn.length);
  else if (/^@?\s*bot(?![a-z0-9\u00c0-\u1ef9])/i.test(s)) s = s.replace(/^@?\s*bot/i, '');
  else if (s.startsWith('/')) s = s.slice(1);
  else return null;
  return s.replace(/^[\s,.:;!\-–]*(?:ơi|oi)?(?![a-z0-9\u00c0-\u1ef9])[\s,.:;!\-–]*/i, '').trim();
}
/* Khớp lệnh nhóm, chịu được phần đuôi tên bot còn sót khi "@Bot Hí Hế ..." mà chưa điền tên bot
   (vd "hi he ket noi nhom" vẫn là "ket noi nhom"; lệch tối đa 3 chữ đứng trước). */
const cmdIs = (n, list) => list.some(c => n === c || (n.endsWith(' ' + c) && n.split(' ').length - c.split(' ').length <= 3));
const GCMD = {
  on: ['ket noi nhom', 'ket noi nhom quan ly', 'gan nhom', 'gan nhom quan ly'],
  off: ['huy nhom', 'go nhom', 'ngat nhom', 'huy ket noi nhom', 'ngat ket noi nhom'],
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
    photoUrl: event === 'message.image.received' && okImgUrl(m.photo_url) ? String(m.photo_url).slice(0, 1000) : '',
  };
}
/* Link ảnh Zalo: chỉ https. Riêng Firebase emulator cho phép http://127.0.0.1 (máy chủ ảnh giả khi test). */
const okImgUrl = (u) => /^https:\/\//.test(String(u || '')) || (process.env.FUNCTIONS_EMULATOR === 'true' && /^http:\/\/127\.0\.0\.1[:/]/.test(String(u || '')));
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
  consent: 'Tin nhắn của anh/chị với bot được lưu lại để xử lý công việc, quản trị viên có thể xem lại. Tin nhắn và ảnh gửi bot được trợ lý AI (Claude của Anthropic) xử lý để hiểu yêu cầu. Bot không đọc được các cuộc trò chuyện khác của anh/chị. Đồng ý thì nhắn: DONG Y',
  consentAi: 'Bot ' + APP + ' vừa có trợ lý AI: anh/chị nhắn bình thường là em hiểu (hỏi doanh thu, món bán chạy, ai đang trong ca, báo sự cố kèm ảnh, lập đề xuất mua hàng, duyệt việc...). Để dùng, anh/chị cần đồng ý: tin nhắn và ảnh gửi bot được trợ lý AI (Claude của Anthropic) xử lý để hiểu yêu cầu; tin vẫn được lưu và quản trị viên có thể xem lại. Đồng ý thì nhắn: DONG Y',
  aiOk: 'Cảm ơn anh/chị. Từ giờ cứ nhắn bình thường, ví dụ: "doanh thu hôm nay", "tuần này bán bao nhiêu ly bạc xỉu", "máy pha chi nhánh 1 không lên nhiệt" (gửi kèm ảnh càng tốt), "có gì chờ tôi duyệt".',
  helpAi: 'Em là trợ lý ' + APP + ', anh/chị cứ nhắn bình thường, ví dụ:\n- doanh thu hôm nay theo nguồn đơn\n- vì sao doanh thu tuần này tụt\n- tháng này đạt bao nhiêu % target\n- nguyên liệu nào sắp hết\n- ai rảnh thay ca tối thứ 7\n- gửi ảnh lịch tuần này chi nhánh 1\n- pha bạc xỉu thế nào\n- huỷ 2 hộp sữa tươi hết hạn (gửi kèm ảnh)\n- (gửi ảnh hoá đơn NCC) nhập kho giúp em\n- ghi chi phí sửa máy pha 1.200.000đ\n- có gì chờ tôi duyệt\nLệnh nhanh: LICH (ảnh lịch của tôi), HUY KET NOI.',
  confirm: '\n\nNhắn OK để xác nhận, HUY để bỏ (bản nháp giữ 10 phút).',
  confirmG: '\n\nNhắn OK để xác nhận, HUY để bỏ (bản nháp giữ 10 phút).',
  /* Đầu mọi tin có bản nháp: tóm tắt của AI đọc lướt dễ tưởng đã ghi xong */
  draftHead: 'BẢN NHÁP — CHƯA GHI VÀO APP\n',
  pendDrop: 'Đã bỏ bản nháp.',
  pickNum: (pend) => '\nNhắn số (1-' + (pend.opts || []).length + ') để ghi luôn, HUY để bỏ.',
  aiDown: 'Trợ lý AI đang tắt, em chỉ hiểu lệnh: LICH (lịch của tôi), GIUP, HUY KET NOI.',
  aiCap: 'Trợ lý AI đã dùng hết ngân sách tháng này, em tạm chỉ hiểu lệnh: LICH, GIUP, HUY KET NOI. Báo quản trị nếu cần tăng.',
  aiFail: 'Em chưa xử lý được câu này, anh/chị nói lại ngắn gọn hơn giúp em nhé.',
  voice: 'Em chưa nghe được tin thoại hay sticker, anh/chị nhắn chữ giúp em nhé.',
  groupNotLinked: 'Nhóm này chưa được gắn với app ' + APP + '. ADMIN (đã kết nối Zalo với app) gõ trong nhóm: bot ket noi nhom',
  groupAdminOnly: 'Chỉ ADMIN đã kết nối Zalo với app mới gắn / gỡ được nhóm.',
  groupAlready: 'Nhóm này đã được gắn rồi. Gõ "bot giup" để xem cách dùng.',
  groupFull: (n) => 'Bot đã ở đủ ' + n + ' nhóm (giới hạn gói Zalo miễn phí). Gỡ bớt một nhóm trong app (Cấu hình › Hệ thống › Bot Zalo) rồi thử lại.',
  groupOn: 'Đã gắn nhóm này làm NHÓM BAN QUẢN TRỊ của ' + APP + '.\n- Ai trong nhóm cũng hỏi được: gõ "bot" + câu hỏi, vd "bot doanh thu hôm nay", "bot món nào bán chạy tuần này".\n- Ghi vào app (báo sự cố, đề xuất mua, duyệt): chỉ người đã kết nối Zalo với app.\n- Chat bình thường bot không đọc, không lưu. Tin bắt đầu bằng "bot" được trợ lý AI (Claude của Anthropic) xử lý.\nGỡ nhóm: ADMIN gõ "bot huy nhom".',
  groupOffDone: 'Đã gỡ nhóm khỏi app ' + APP + '. Bot không trả lời trong nhóm này nữa.',
  groupNotOn: 'Nhóm này chưa được gắn với app.',
  groupHelp: 'Trong nhóm, gõ "bot" + câu hỏi, ví dụ:\n- bot doanh thu hôm nay theo nguồn\n- bot món nào bán chạy tuần này\n- bot ai đang trong ca\n- bot gửi ảnh lịch tuần này\n- bot sự cố nào chưa xử lý\nNgười đã kết nối Zalo với app: thêm báo sự cố, huỷ / nhập hàng, ghi chi phí, đề xuất mua, duyệt việc — nhắn OK để xác nhận (chi phí: nhắn số nhóm).',
  groupPrivate: 'Kết nối / ngắt kết nối Zalo làm trong tin nhắn riêng với bot nhé.',
  codeBad: 'Mã không đúng hoặc đã hết hạn. Lấy mã mới trong app (Hồ sơ của tôi > Kết nối Zalo) rồi nhắn lại.',
  codeGone: 'Mã kết nối đã hết hạn hoặc không còn dùng được. Lấy mã mới trong app rồi nhắn lại.',
  locked: 'Nhập sai mã quá nhiều lần. Anh/chị thử lại sau 15 phút.',
  remind: 'Nhắn DONG Y để hoàn tất kết nối. Không muốn kết nối thì bỏ qua tin này.',
  notAllowed: 'Tài khoản của anh/chị hiện chưa được dùng bot Zalo. Liên hệ quản trị.',
  full: (n) => 'Bot đã đủ ' + n + ' người, liên hệ quản trị.',
  welcome: (name, ai) => 'Chào ' + name + ', đã kết nối Zalo với tài khoản ' + APP + '.\n\n' + (ai
    ? 'Anh/chị cứ nhắn bình thường, ví dụ "doanh thu hôm nay", "có gì chờ tôi duyệt". Nhắn GIUP để xem thêm.'
    : 'Các lệnh: LICH (lịch 7 ngày tới), HUY KET NOI (ngắt kết nối), GIUP (xem lại các lệnh).'),
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
  /* Trợ lý AI: khoá Anthropic chỉ có ở zaloProcess. Thiếu khoá / tắt trong cấu hình -> chạy lệnh mẫu. */
  const getAiKey = deps.getAiKey || (() => '');
  const makeAiClient = deps.makeAiClient || ((apiKey) => {
    const A = require('@anthropic-ai/sdk');
    const Anthropic = A.default || A;
    return new Anthropic({ apiKey, maxRetries: 1, timeout: 60000 });
  });
  /* Ảnh (lịch làm việc): dựng PNG -> deps.uploadImage (Firebase Storage) -> link -> sendPhoto */
  const uploadImage = deps.uploadImage || null;
  const tools = require('./zalotools').createTools({
    db, now, log, fetchFn, helpers: { dayVN, dAdd, buildWeek, fmtWeek }, uploadImage,
    sendPhoto: ({ zaloId, chatId, empId, url, caption }) => send({ zaloId, chatId, empId, kind: 'reply', text: caption || 'Ảnh', cmd: 'photo', photo: url }),
  });
  const ai = require('./zaloai').createAI({ tools, log, now });
  /* Bot tự báo: báo cáo 23h50, cảnh báo, nhắc lịch (zaloauto.js) — gửi qua send() nên vẫn đếm hạn mức + ghi nhật ký */
  const auto = require('./zaloauto').createAuto({
    db, FV, log, now, getCfg: () => getCfg(), zcfg, appRules: require('./apprules'), dayVN, dAdd, monthVN, uploadImage, gapMs: deps.gapMs,
    send: (o) => send(o),
  });
  let aiClient = null, aiClientKey = '';
  const aiClientFor = (key) => { if (!aiClient || aiClientKey !== key) { aiClient = makeAiClient(key); aiClientKey = key; } return aiClient; };

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
  /* photo: link ảnh -> gửi bằng sendPhoto, text làm chú thích (1–2000 ký tự) */
  async function send({ zaloId, chatId, empId = '', kind, text, cmd = '', photo = '' }) {
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
        if (photo) await callApi({ token: getToken(), method: 'sendPhoto', payload: { chat_id: chatId, photo, caption: body }, fetchFn });
        else await sendMessage({ token: getToken(), chatId, text: body, fetchFn });
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
      kind, cmd, text: body, result, err, at: FV.serverTimestamp(), atMs: t, st: 'done', ...(photo ? { photo } : {}),
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

  /* ---------- Trợ lý AI dùng chung cho chat riêng + nhóm ---------- */
  const YES = ['ok', 'oke', 'okie', 'okay', 'co', 'yes', 'xac nhan', 'dong y', 'gui', 'gui di', 'duyet', 'chot', 'dung', 'dung roi', 'chuan'];
  const NO = ['huy', 'khong', 'ko', 'k', 'thoi', 'bo', 'cancel', 'no', 'huy bo', 'khong gui', 'bo qua'];
  const HIST_TTL = 60 * 60e3, HIST_MAX = 12;

  /* Nhớ vài lượt gần nhất (trong 30 phút) để hỏi tiếp được — lưu ở ops_zguard, không cần index */
  async function pushHist(gref, g, items) {
    const t = now();
    const old = (Array.isArray(g.hist) ? g.hist : []).filter(h => h && t - Number(h.at) < HIST_TTL);
    const hist = old.concat(items.map(x => ({ r: x.r, t: clip(x.t, 1000), at: t }))).slice(-HIST_MAX);
    await gref.set({ hist }, { merge: true }).catch(() => {});
  }
  /* Kiểm hạn mức tin + trần chi phí AI, gọi AI, cộng chi phí. Trả { res } hoặc { stop: kết quả trả về } */
  async function runAi({ zc, cfg, emp, v, text, image, photo, history, group, reply }) {
    const t = now(), mk = monthVN(t);
    const qref = col('quota').doc(mk);
    const q = await qref.get().then(s => (s.exists ? s.data() : {}) || {});
    if (!quotaGate('reply', Number(q.sent) || 0, zc.monthlyCap)) return { stop: { cmd: 'ai', result: 'skipped_quota' } };
    if ((Number((q.ai || {}).usd) || 0) >= zc.aiCapUsd) { await reply(T.aiCap, 'ai'); return { stop: { cmd: 'ai', result: 'ai_cap' } }; }
    const res = await ai.answer({ client: aiClientFor(String(getAiKey() || '').trim()), model: zc.aiModel, cfg, emp, zaloId: v.zaloId, text, image, photo, history, group });
    if (res.usage) {
      await qref.set({ month: mk, ai: {
        usd: FV.increment(res.usd || 0), in: FV.increment(res.usage.in), out: FV.increment(res.usage.out),
        cacheR: FV.increment(res.usage.cacheR), cacheW: FV.increment(res.usage.cacheW), calls: FV.increment(res.rounds || 0),
        turns: FV.increment(1), fails: FV.increment(res.ok ? 0 : 1),
      }, updatedAt: FV.serverTimestamp() }, { merge: true });
    }
    return { res };
  }

  /* Đang chờ chủ chọn nhóm chi phí: số 1..N -> ghi; HUY -> bỏ; OK -> nhắc lại danh sách. Câu khác -> null
     (để AI xử lý như thường, bản nháp vẫn giữ tới khi hết hạn). */
  async function costPickStep(cfg, emp, pend, n, ref, reply, group) {
    const N = (pend.opts || []).length;
    /* Đổi kỳ trước khi chọn nhóm: "t10", "thang 10", "t10 2026", "10/2026" -> ngày cuối tháng đó
       (tháng lớn hơn tháng hiện tại mà không ghi năm thì hiểu là năm trước, vd tháng 1 ghi "T12") */
    const mm = /^(?:t|thang)\s*(\d{1,2})(?:\s*(?:\/|nam)?\s*(\d{4}))?$/.exec(n) || /^(\d{1,2})\s+(\d{4})$/.exec(n);   /* n đã bỏ dấu câu: "10/2026" -> "10 2026" */
    if (mm && Number(mm[1]) >= 1 && Number(mm[1]) <= 12) {
      const today = dayVN(now());
      const m = Number(mm[1]);
      let y = mm[2] ? Number(mm[2]) : Number(today.slice(0, 4));
      if (!mm[2] && m > Number(today.slice(5, 7))) y -= 1;
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const date = y + '-' + String(m).padStart(2, '0') + '-' + String(last).padStart(2, '0');
      const np = { ...pend, data: { ...(pend.data || {}), date } };
      await ref.set({ pend: np }, { merge: true });
      await reply(tools.costMenuText(cfg, np) + T.pickNum(np, group), 'cost_pick');
      return { result: 'month_set', msg: 'đổi kỳ ' + date.slice(0, 7) };
    }
    if (/^\d{1,2}$/.test(n)) {
      const k = Number(n);
      if (k < 1 || k > N) { await reply('Nhắn số từ 1 đến ' + N + ' nhé.', 'cost_pick'); return { result: 'bad_num' }; }
      await ref.set({ pend: FV.delete() }, { merge: true });
      let r;
      try { r = await tools.execPending(cfg, emp, { ...pend, pick: k }); }
      catch (e) { log.error('zalo: ghi chi phí lỗi', { err: String(e && e.message) }); r = { ok: false, msg: 'Lỗi máy chủ khi ghi, chưa ghi gì. Anh/chị thử lại sau.' }; }
      await reply(r.msg, 'cost_pick');
      return { result: r.ok ? 'cost_saved' : 'cost_fail', msg: r.msg };
    }
    if (NO.includes(n)) { await ref.set({ pend: FV.delete() }, { merge: true }); await reply(T.pendDrop, 'pend_drop'); return { result: 'drop', msg: T.pendDrop }; }
    if (YES.includes(n)) { await reply(tools.costMenuText(cfg, pend) + T.pickNum(pend, group), 'cost_pick'); return { result: 'menu_again' }; }
    return null;
  }

  /* ---------- Người đã kết nối (chat riêng) ---------- */
  async function handleLinked(v, link, pc, gref, g) {
    g = g || {};
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
    const t = now();
    const cfg = await getCfg();
    const zc = zcfg(cfg);
    const aiOn = zc.ai && !!String(getAiKey() || '').trim();
    const isText = v.event === 'message.text.received';
    const n = isText ? normalize(v.text) : '';

    /* 1) Xác nhận / bỏ bản nháp — code thường, không qua AI */
    const pend = g.pend && Number(g.pend.exp) > t ? g.pend : null;
    /* 1a) Đang chờ chọn nhóm chi phí: nhắn số là ghi luôn */
    if (pend && pend.kind === 'costPick' && isText) {
      const r0 = await costPickStep(cfg, emp, pend, n, gref, reply);
      if (r0) { await pushHist(gref, g, [{ r: 'u', t: v.text }, { r: 'a', t: r0.msg || '' }]); return { cmd: 'cost_pick', result: r0.result, empId }; }
    }
    if (pend && pend.kind !== 'costPick' && isText && (YES.includes(n) || NO.includes(n))) {
      await gref.set({ pend: FV.delete() }, { merge: true });
      if (NO.includes(n)) { await reply(T.pendDrop, 'pend_drop'); return { cmd: 'pend_drop', result: 'ok', empId }; }
      let r;
      try { r = await tools.execPending(cfg, emp, pend); }
      catch (e) { log.error('zalo: ghi bản nháp lỗi', { kind: pend.kind, err: String(e && e.message) }); r = { ok: false, msg: 'Lỗi máy chủ khi ghi, chưa ghi gì. Anh/chị thử lại sau.' }; }
      await reply(r.msg, 'pend_' + pend.kind);
      await pushHist(gref, g, [{ r: 'u', t: v.text }, { r: 'a', t: r.msg }]);
      return { cmd: 'pend_' + pend.kind, result: r.ok ? 'pend_done' : 'pend_fail', empId };
    }

    /* 2) Người kết nối từ trước bản AI: hỏi đồng ý lại một lần, trong lúc chờ thì chạy lệnh mẫu */
    let ask = '';
    const needAi = aiOn && link.consentV !== CONSENT_V;
    if (needAi) {
      /* Nhắn DONG Y lúc nào cũng được — không bắt phải đúng sau tin hỏi */
      if (pc.cmd === 'agree') {
        await col('link').doc(zid).update({ consentV: CONSENT_V, consentAiAt: t, consentAiText: T.consentAi });
        await gref.set({ aiAsk: FV.delete() }, { merge: true });
        await reply(T.aiOk, 'ai_consent');
        return { cmd: 'ai_consent', result: 'ok', empId };
      }
      if (await claim(gref, 'aiAsk', true)) ask = '\n\n' + T.consentAi;
    }
    const aiReady = aiOn && link.consentV === CONSENT_V;

    /* 3) Lệnh nhanh cố định — không tốn AI */
    if (pc.cmd === 'help') { await reply((aiReady ? T.helpAi : T.help) + ask); return { cmd: 'help', result: 'ok', empId }; }
    if (pc.cmd === 'lich') {
      /* Ảnh lịch tuần này (đúng mẫu ảnh lịch của app); không dựng / gửi được ảnh thì gửi chữ như cũ */
      const im = await tools.sendSchedImage({ cfg, me: emp, zaloId: zid, chatId: chat, personal: true }).catch(e => ({ loi: String(e && e.message) }));
      if (!im || !im.da_gui) await reply((await lichText(emp)) + ask);
      else if (ask) await reply(ask.trim());
      return { cmd: 'lich', result: im && im.da_gui ? 'photo' : 'ok', empId };
    }
    if (pc.cmd === 'unlink') {
      await unlinkEmp(empId, 'self_bot', empId);
      await reply(T.unlinked(emp.name || ''));
      return { cmd: 'unlink', result: 'ok', empId };
    }
    if (pc.cmd === 'code') { await reply(T.already(emp.name || '') + ask); return { cmd: 'code', result: 'already_linked', empId }; }
    if (v.event === 'message.voice.received' || v.event === 'message.sticker.received') { await reply(T.voice + ask); return { cmd: pc.cmd, result: 'voice', empId }; }

    if (!aiReady) {
      /* Chưa đồng ý AI: nhắc lại câu đồng ý (đừng trả "chưa hiểu" — người dùng không biết phải làm gì) */
      if (needAi) { await reply(T.consentAi, 'ai_consent_ask'); return { cmd: pc.cmd, result: 'ai_consent_ask', empId }; }
      await reply((aiOn ? T.unknown : T.aiDown) + ask);
      return { cmd: pc.cmd, result: 'unknown', empId };
    }

    /* 4) Trợ lý AI */
    let image = null;
    if (v.photoUrl) {
      image = await tools.fetchImage(v.photoUrl);
      await gref.set({ lastPhoto: { url: v.photoUrl, at: t } }, { merge: true });
    }
    const lp = g.lastPhoto && t - Number(g.lastPhoto.at) < tools.PHOTO_TTL ? g.lastPhoto : null;
    const photo = image ? image : lp ? { url: lp.url } : null;
    const history = (Array.isArray(g.hist) ? g.hist : []).filter(h => h && t - Number(h.at) < HIST_TTL);
    const userText = isText ? v.text : (v.text || '').replace(/^\[ảnh\]\s*/, '');
    const r = await runAi({ zc, cfg, emp, v, text: userText, image, photo, history, reply });
    if (r.stop) return { ...r.stop, empId };
    const res = r.res;
    const text = res.pend && res.pend.kind === 'costPick' ? (res.ok ? res.text : 'Khoản chi đã soạn.') + '\n\n' + tools.costMenuText(cfg, res.pend) + T.pickNum(res.pend, false)
      : res.ok ? (res.pend ? T.draftHead : '') + res.text + (res.pend ? T.confirm : '') : (res.pend ? T.draftHead + 'Em đã soạn nháp.' + T.confirm : T.aiFail);
    await reply(text, 'ai');
    await pushHist(gref, g, [{ r: 'u', t: userText || '[ảnh]' }, { r: 'a', t: text }]);
    return { cmd: 'ai', result: res.ok ? 'ok' : 'ai_' + res.why, empId, aiUsd: res.usd || 0, aiTools: (res.tools || []).join(',') };
  }

  /* ---------- Tin trong NHÓM Zalo (đã gọi bot) ----------
     Nhóm ban quản trị do ADMIN gắn ("bot ket noi nhom"), tối đa cfg.zalo.maxGroups (3 — giới hạn gói
     Zalo miễn phí). Ai trong nhóm cũng HỎI được số liệu theo quyền của nhóm (mọi chi nhánh, không cần
     kết nối từng người); việc GHI + lịch / việc chờ duyệt chỉ người đã kết nối, theo quyền của chính họ. */
  const groupEmp = (cfg, v) => ({
    id: 'grp_' + String(v.chatId), name: (v.zname || 'Thành viên') + ' (nhóm quản trị Zalo)', role: 'ADMIN', status: 'active',
    branches: (cfg.branches || []).filter(b => b && b.id).map(b => b.id),
  });
  async function handleGroup(v, sref, sg) {
    sg = sg || {};
    const gid = String(v.chatId), t = now();
    const cfg = await getCfg();
    const zc = zcfg(cfg);
    const isText = v.event === 'message.text.received';
    const gtext = String(v.gtext || '');
    const n = normalize(gtext);
    const gdoc = col('group').doc(gid);
    const gs = await gdoc.get();
    const grp = gs.exists ? (gs.data() || {}) : null;
    const active = !!(grp && grp.active === true);
    /* Người gửi đã kết nối? */
    const ls = await col('link').doc(String(v.zaloId)).get();
    const link = ls.exists ? (ls.data() || {}) : null;
    let actor = null;
    if (link && link.active === true && link.empId) {
      const es = await col('emp').doc(String(link.empId)).get();
      const e = es.exists ? (es.data() || {}) : null;
      if (e && e.status !== 'off') actor = { ...e, id: es.id };
    }
    const empId = actor ? actor.id : '';
    const reply = (text, cmd) => send({ zaloId: v.zaloId, chatId: gid, empId, kind: 'reply', text, cmd });
    const isAdmin = !!(actor && actor.role === 'ADMIN');

    /* Gắn / gỡ nhóm — chỉ ADMIN đã kết nối */
    if (isText && (cmdIs(n, GCMD.on) || cmdIs(n, GCMD.off))) {
      const on = cmdIs(n, GCMD.on), cmd = on ? 'group_on' : 'group_off';
      if (!isAdmin) { await reply(T.groupAdminOnly, cmd); return { cmd, result: 'denied', empId }; }
      if (on) {
        if (active) { await reply(T.groupAlready, cmd); return { cmd, result: 'already', empId }; }
        const cnt = (await col('group').where('active', '==', true).get()).size;
        if (cnt >= zc.maxGroups) { await reply(T.groupFull(zc.maxGroups), cmd); return { cmd, result: 'full', empId }; }
        await gdoc.set({ id: gid, active: true, type: 'mgr', by: actor.id, byName: actor.name || '', atMs: t, at: FV.serverTimestamp(), lastAtMs: t }, { merge: true });
        await reply(T.groupOn, cmd);
        return { cmd, result: 'ok', empId };
      }
      if (!active) { await reply(T.groupNotOn, cmd); return { cmd, result: 'not_on', empId }; }
      await gdoc.set({ active: false, offBy: actor.id, offAtMs: t, offAt: FV.serverTimestamp() }, { merge: true });
      await reply(T.groupOffDone, cmd);
      return { cmd, result: 'ok', empId };
    }
    if (!active) {
      /* Nhóm chưa gắn: nhắc cách gắn tối đa 1 lần / ngày / nhóm (đỡ tốn tin) */
      /* Ai đang cố gắn nhóm (có chữ "ket noi" / "nhom") thì luôn trả lời — im lặng trông như bot treo */
      const trying = /\bket noi\b|\bnhom\b|\bgan\b/.test(n);
      if (trying || await claim(col('guard').doc('grp_' + gid), 'guideDay', dayVN(t))) await reply(T.groupNotLinked, 'group_guide');
      return { cmd: 'group', result: 'group_off', empId };
    }
    await gdoc.set({ lastAtMs: t }, { merge: true }).catch(() => {});

    const pc = parseCmd(isText ? gtext : '');
    if ((!n && !v.photoUrl) || pc.cmd === 'help' || cmdIs(n, ['giup', 'help', 'huong dan'])) { await reply(T.groupHelp, 'help'); return { cmd: 'help', result: 'ok', empId }; }
    if (['unlink', 'code', 'agree'].includes(pc.cmd)) { await reply(T.groupPrivate, pc.cmd); return { cmd: pc.cmd, result: 'private_only', empId }; }

    /* Xác nhận / bỏ bản nháp của CHÍNH người gửi — code thường, không qua AI */
    const pend = actor && sg.pend && Number(sg.pend.exp) > t ? sg.pend : null;
    if (pend && pend.kind === 'costPick' && isText) {
      const r0 = await costPickStep(cfg, actor, pend, n, sref, reply, true);
      if (r0) return { cmd: 'cost_pick', result: r0.result, empId };
    }
    if (pend && pend.kind !== 'costPick' && isText && (YES.includes(n) || NO.includes(n))) {
      await sref.set({ pend: FV.delete() }, { merge: true });
      if (NO.includes(n)) { await reply(T.pendDrop, 'pend_drop'); return { cmd: 'pend_drop', result: 'ok', empId }; }
      let r;
      try { r = await tools.execPending(cfg, actor, pend); }
      catch (e) { log.error('zalo: ghi bản nháp lỗi', { kind: pend.kind, err: String(e && e.message) }); r = { ok: false, msg: 'Lỗi máy chủ khi ghi, chưa ghi gì. Anh/chị thử lại sau.' }; }
      await reply(r.msg, 'pend_' + pend.kind);
      return { cmd: 'pend_' + pend.kind, result: r.ok ? 'pend_done' : 'pend_fail', empId };
    }
    if (pc.cmd === 'lich') {
      if (!actor) { await reply(T.groupPrivate, 'lich'); return { cmd: 'lich', result: 'need_link', empId }; }
      const im = await tools.sendSchedImage({ cfg, me: actor, zaloId: v.zaloId, chatId: gid, personal: true }).catch(() => null);
      if (!im || !im.da_gui) await reply(await lichText(actor), 'lich');
      return { cmd: 'lich', result: 'ok', empId };
    }

    /* Trợ lý AI — quyền nhóm cho câu hỏi, quyền người gửi cho việc ghi */
    if (!zc.ai || !String(getAiKey() || '').trim()) { await reply(T.aiDown, 'ai'); return { cmd: 'ai', result: 'ai_off', empId }; }
    const image = v.photoUrl ? await tools.fetchImage(v.photoUrl) : null;
    const hgref = col('guard').doc('grp_' + gid);
    const hg = (await hgref.get().then(s => (s.exists ? s.data() : {}))) || {};
    const history = (Array.isArray(hg.hist) ? hg.hist : []).filter(h => h && t - Number(h.at) < HIST_TTL);
    const r = await runAi({ zc, cfg, emp: groupEmp(cfg, v), v, text: gtext, image, photo: image || null, history, group: { id: gid, actor }, reply });
    if (r.stop) return { ...r.stop, empId };
    const res = r.res;
    const text = res.pend && res.pend.kind === 'costPick' ? (res.ok ? res.text : 'Khoản chi đã soạn.') + '\n\n' + tools.costMenuText(cfg, res.pend) + T.pickNum(res.pend, true)
      : res.ok ? (res.pend ? T.draftHead : '') + res.text + (res.pend ? T.confirmG : '') : (res.pend ? T.draftHead + 'Em đã soạn nháp.' + T.confirmG : T.aiFail);
    await reply(text, 'ai');
    await pushHist(hgref, hg, [{ r: 'u', t: (v.zname ? v.zname + ': ' : '') + (gtext || '[ảnh]') }, { r: 'a', t: text }]);
    return { cmd: 'ai', result: res.ok ? 'ok' : 'ai_' + res.why, empId, aiUsd: res.usd || 0, aiTools: (res.tools || []).join(',') };
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
    await reply(T.welcome(emp.name || '', zc.ai && !!String(getAiKey() || '').trim()), empId);
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
    if (v.chatType === 'GROUP') return handleGroup(v, gref, gt.g);
    const pc = parseCmd(v.event === 'message.text.received' ? v.text : '');
    const ls = await col('link').doc(String(v.zaloId)).get();
    const link = ls.exists ? (ls.data() || {}) : null;
    if (link && link.active === true) return handleLinked(v, link, pc, gref, gt.g);
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

  /* Tin nhóm không gọi bot nhưng là câu trả lời ngắn cho bản nháp đang chờ của chính người gửi, tạo trong
     đúng nhóm này: số / đổi tháng chỉ cho chọn nhóm chi phí; ok / huỷ cho mọi bản nháp. Chỉ đọc Firestore khi
     câu khớp mẫu ngắn — chat thường của nhóm không tốn thêm lượt đọc. */
  async function pendReply(ev, body) {
    if (ev.event !== 'message.text.received') return false;
    const n = normalize(body);
    const pick = /^\d{1,2}$/.test(n) || /^(?:t|thang)\s*\d{1,2}(?:\s*(?:nam)?\s*\d{4})?$/.test(n) || /^\d{1,2}\s+\d{4}$/.test(n);
    const yn = YES.includes(n) || NO.includes(n);
    if (!pick && !yn) return false;
    try {
      const s = await col('guard').doc(String(ev.zaloId)).get();
      const p = s.exists ? (s.data() || {}).pend : null;
      if (!p || !(Number(p.exp) > now()) || String(p.where || '') !== String(ev.chatId)) return false;
      return yn || p.kind === 'costPick';
    } catch (e) { return false; }
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
    /* Request kiểm tra của Zalo / tin do bot gửi / loại hội thoại lạ: nhận nhưng không lưu */
    if (!ev.ok || ev.isBot || (ev.chatType !== 'PRIVATE' && ev.chatType !== 'GROUP')) { res.status(200).json({ message: 'Success' }); return; }
    /* Tin nhóm: chỉ lưu khi GỌI bot ("bot ...", "@Bot ...", "/..."); chat bình thường bỏ qua, không lưu */
    let gtext = null;
    if (ev.chatType === 'GROUP') {
      const body = ev.event === 'message.text.received' ? ev.text : ev.text.replace(/^\[[^\]]*\]\s*/, '');
      let bn = '';
      /* Tên bot: ô "Tên bot" trong app, chưa điền thì hỏi Zalo (getMe, nhớ 6 giờ). Zalo chèn tên này vào
         đầu tin khi người dùng @tag bot — tên không bắt đầu bằng "Bot" mà không biết tên là bỏ sót tin. */
      try { bn = await botName(zcfg(await getCfg())); } catch (e) { bn = ''; }
      gtext = groupCall(body, bn);
      /* Trả lời NGẮN cho bản nháp của CHÍNH người gửi trong nhóm này (số nhóm chi phí "1", "T10", "ok", "huy")
         — người ta trả lời tự nhiên, không ai gõ "bot 1". Không nhận thì khoản chi treo mãi, không vào P&L. */
      if (gtext === null && await pendReply(ev, body)) gtext = String(body).trim();
      if (gtext === null) { res.status(200).json({ message: 'Success' }); return; }
    }
    try {
      await col('msg').doc(inDocId(ev.msgId)).create({
        dir: 'in', zaloId: ev.zaloId, chatId: ev.chatId, chatType: ev.chatType, zname: ev.zname,
        event: ev.event, text: ev.text, zdate: ev.zdate, photoUrl: ev.photoUrl || '', empId: '', cmd: '', result: '', st: 'new',
        at: FV.serverTimestamp(), atMs: now(), ...(gtext !== null ? { gtext } : {}),
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

  /* ADMIN gỡ một nhóm Zalo khỏi app (tab Bot Zalo) — bot thôi trả lời trong nhóm đó */
  async function groupOff(req) {
    if (!(req.auth && req.auth.uid)) throw new HttpsError('unauthenticated', 'Chưa đăng nhập');
    const me = await findEmp(req);
    if (!me || me.status === 'off' || me.role !== 'ADMIN') throw new HttpsError('permission-denied', 'Chỉ ADMIN được gỡ nhóm');
    const gid = String(((req.data || {}).groupId) || '').slice(0, 100);
    if (!gid) throw new HttpsError('invalid-argument', 'Thiếu mã nhóm');
    const ref = col('group').doc(gid);
    const s = await ref.get();
    if (!s.exists || (s.data() || {}).active !== true) return { ok: true, n: 0 };
    await ref.set({ active: false, offBy: me.id, offAtMs: now(), offAt: FV.serverTimestamp() }, { merge: true });
    return { ok: true, n: 1 };
  }

  /* ADMIN bấm "Gửi thử báo cáo cho tôi": báo cáo HÔM NAY (tới giờ này) vào Zalo riêng của chính người bấm */
  async function reportTest(req) {
    if (!(req.auth && req.auth.uid)) throw new HttpsError('unauthenticated', 'Chưa đăng nhập');
    const me = await findEmp(req);
    if (!me || me.status === 'off' || me.role !== 'ADMIN') throw new HttpsError('permission-denied', 'Chỉ ADMIN được gửi thử báo cáo');
    const l = (await col('link').where('empId', '==', me.id).get()).docs.find(d => (d.data() || {}).active === true);
    if (!l) throw new HttpsError('failed-precondition', 'Tài khoản của bạn chưa kết nối Zalo — vào Hồ sơ của tôi › Kết nối Zalo trước');
    const r = await auto.report({ only: { zaloId: l.id, chatId: (l.data() || {}).chatId || l.id, empId: me.id } });
    return { day: r.day, sent: r.sent, photo: r.photo, imgErr: r.imgErr || '' };
  }

  return { hook, processIn, linkCode, unlink, groupOff, reportTest, send, unlinkEmp, getCfg, reportDaily: (o) => auto.report(o || {}), autoTick: () => auto.tick() };
}

module.exports = {
  API_BASE, SECRET_HEADER, COL, DEF, LIM, T, CONSENT_V, AI_MODELS, okImgUrl,
  secretOk, dayVN, monthVN, dAdd, zcfg, eligible, normalize, parseCmd, parseEvent, inDocId, groupCall, GCMD, cmdIs,
  checkCode, hourTick, codeTick, isLocked, badCode, quotaGate, needWarn95,
  buildWeek, fmtWeek, callApi, sendMessage, createZalo,
};
