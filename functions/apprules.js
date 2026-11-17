/* ===================== LUẬT QUYỀN CỦA APP — FILE SINH TỰ ĐỘNG, KHÔNG SỬA TAY =====================
   Trích nguyên văn từ index.html bằng tools/zalo-sync-rules.js. Sửa luật quyền trong app rồi chạy:
   node tools/zalo-sync-rules.js — rồi deploy lại functions.
   Dùng: const R = require('./apprules')(cfg)  — cfg là ops_config/main (chỉ đọc). */
/* eslint-disable */
module.exports = function appRules(CFG) {
  CFG = CFG || {};
const pad = (n) => String(n).padStart(2, '0');
const hoursTxt = (mins) => `${Math.floor(mins / 60)}h${mins % 60 ? pad(mins % 60) : ''}`;
const dShort = (k) => k ? k.slice(8, 10) + '/' + k.slice(5, 7) : '';
let _uidSeq = 0;
const uid = (p) => p + (Date.now().toString(36).slice(-4) + (_uidSeq++).toString(36) + Math.random().toString(36).slice(2, 4)).toUpperCase();
const ALL_PAGES = ['home', 'notices', 'guide', 'sop', 'shifts', 'schedule', 'attendance', 'payroll', 'payslip', 'vouchers', 'checklist', 'issues', 'requests', 'revenue', 'pnl', 'cash', 'recon', 'lookup', 'opsmap', 'staff', 'settings', 'profile', 'stock', 'purchase', 'poreceipt', 'poreq', 'sales', 'nvlout', 'nxt', 'recipes', 'norms', 'mats', 'prep', 'layout'];
const BASE_PAGES = ['home', 'notices', 'guide', 'sop', 'requests', 'shifts', 'attendance', 'payslip', 'vouchers', 'checklist', 'issues', 'lookup', 'recipes', 'prep', 'layout', 'mats', 'profile'];
const DEFAULT_ROLES = [
  { id: 'ADMIN', label: 'Quản trị hệ thống', short: 'Admin',     level: 99, tag: 't-gray',   scope: 'all',    ticket: 'any',     issue: 'any',    manage: true,  inOrg: false, pages: ALL_PAGES.slice() },
  { id: 'OM',    label: 'Giám đốc vận hành', short: 'OM',        level: 80, tag: 't-violet', scope: 'all',    ticket: 'close',   issue: 'close',  manage: true,  pages: ALL_PAGES.filter(p => p !== 'settings') },
  { id: 'AM',    label: 'Quản lý khu vực',   short: 'AM',        level: 60, tag: 't-blue',   scope: 'multi',  ticket: 'approve', issue: 'close',  manage: true,  pages: ALL_PAGES.filter(p => !['settings', 'recon'].includes(p)) },
  { id: 'GS',    label: 'Giám sát chi nhánh',short: 'Giám sát',  level: 40, tag: 't-brand',  scope: 'single', ticket: 'explain', issue: 'handle', manage: false, pages: BASE_PAGES.concat(['schedule', 'cash', 'revenue', 'opsmap', 'staff']) },
  { id: 'NV',    label: 'Nhân viên',         short: 'Nhân viên', level: 20, tag: 't-amber',  scope: 'single', ticket: 'none',    issue: 'report', manage: false, pages: BASE_PAGES.slice() },
];
const ROLE_FALLBACK = { id: '?', label: 'Chưa gán vai trò', short: '—', level: 0, tag: 't-gray', scope: 'single', ticket: 'none', issue: 'report', manage: false, inOrg: true, pages: ['home', 'profile'] };
let _rlSrc = null, _rlSeen = null, _rlOut = null;
const roleList = () => {
  const saved = (CFG && CFG.roles && CFG.roles.length) ? CFG.roles : null;
  if (!saved) return DEFAULT_ROLES;
  const seen = (CFG && CFG.seenPages) || null;
  /* Nhớ theo tham chiếu: roleOf() bị gọi hàng nghìn lần mỗi lần vẽ lại.
     Phải khoá theo CẢ hai nguồn — chỉ khoá theo roles thì lúc seenPages đổi mà roles giữ nguyên
     vật cũ, kết quả cũ bị dùng lại và trang admin vừa tắt lại hiện ra. */
  if (_rlSrc === saved && _rlSeen === seen) return _rlOut;
  const known = new Set([...(seen || []), ...saved.flatMap(r => r.pages || [])]);
  const fresh = ALL_PAGES.filter(p => !known.has(p));
  const out = !fresh.length ? saved : saved.map(r => {
    const d = DEFAULT_ROLES.find(x => x.id === r.id);
    const add = fresh.filter(p => d ? (d.pages || []).includes(p) : BASE_PAGES.includes(p));
    return add.length ? { ...r, pages: (r.pages || []).concat(add) } : r;
  });
  _rlSrc = saved; _rlSeen = seen; _rlOut = out;
  return out;
};
const roleOf = (k) => roleList().find(r => r.id === k) || { ...ROLE_FALLBACK, id: k };
const inScope = (user, bid) => user.branches.includes(bid);
const scopeBranches = (user, cfg) => {
  const r = roleOf(user.role);
  return r.scope === 'all' ? (cfg.branches || []).map(b => b.id) : (user.branches || []);
};
const isBiz = (b) => b && b.kind !== 'hq';
const bizList = (cfg) => (cfg.branches || []).filter(isBiz);
const canIssue = (user, what) => {
  const v = roleOf(user.role).issue || 'report';
  if (v === 'any') return true;
  if (what === 'report') return v !== 'none';
  if (what === 'handle') return v === 'handle' || v === 'close';
  if (what === 'close') return v === 'close';
  return false;
};
const ISSUE_SEV = {
  KHAN: { id: 'KHAN', label: 'Khẩn — dừng kinh doanh', color: '#E0453F', tag: 't-red', sla: 2 },
  CAO:  { id: 'CAO',  label: 'Cao — ảnh hưởng khách',  color: '#E8930C', tag: 't-amber', sla: 12 },
  THUONG: { id: 'THUONG', label: 'Thường — bảo trì',   color: '#2D7FF9', tag: 't-blue', sla: 72 },
};
const DEFAULT_ISSUE_CATS = ['Điện', 'Nước', 'Điều hòa', 'Máy pha chế', 'Tủ mát – tủ đông', 'Nội thất – bàn ghế', 'Bếp – quầy bar', 'PCCC – an toàn', 'Vệ sinh', 'Khác'];
const itemGroups = (cfg) => [...new Set(((cfg || {}).items || []).map(i => (i.group || '').trim()).filter(Boolean))].sort();
const itemsInGroup = (cfg, g) => ((cfg || {}).items || []).filter(i => (i.group || '').trim() === g);
const canPreq = (u) => { const r = roleOf(u.role); return r.preq != null ? !!r.preq : true; };
const canPreqAll = (u) => { const r = roleOf(u.role); return r.preqAll != null ? !!r.preqAll : ((r.level || 0) >= 60 || !!r.manage); };
const canPreqAppr = (u) => { const r = roleOf(u.role); return r.preqAppr != null ? !!r.preqAppr : ((r.level || 0) >= 60 || !!r.manage); };
const pqSees = (user, x) => !!x && (canPreqAll(user) || inScope(user, x.branchId) || x.by === user.id);
const canConfirmAtt = (u) => { const r = roleOf(u.role); return r.attConfirm != null ? !!r.attConfirm : (r.level || 0) >= 40; };
const attApprCfg = (cfg) => ({ steps: [], ...((cfg || {}).attAppr || {}) });
const attChain = (cfg) => {
  const s = attApprCfg(cfg).steps || [];
  return s.length ? s : [{ mode: 'legacy' }];
};
const attStepOK = (user, st) => {
  if (!st || !user) return false;
  if (st.mode === 'legacy') return canConfirmAtt(user);
  if (st.mode === 'pos') return user.posId === st.posId;      /* theo CHỨC VỤ */
  if (st.mode === 'level') return (roleOf(user.role).level || 0) >= (st.level || 0);
  if (st.mode === 'user') return user.id === st.userId;
  return user.role === st.role;
};
const posOf = (id) => CFG.positions.find(p => p.id === id) || { name: '—', deptId: '' };
const attStepLabel = (st, employees) => {
  if (!st) return '—';
  if (st.mode === 'legacy') return 'Người có quyền xác nhận công';
  if (st.mode === 'pos') return posOf(st.posId).name;
  if (st.mode === 'level') return 'Cấp ≥ ' + (st.level || 0);
  if (st.mode === 'user') return ((employees || []).find(e => e.id === st.userId) || {}).name || 'Người chỉ định';
  return roleOf(st.role).label;
};
const attStepIdx = (r) => Math.max(0, (r && r.step) || 0);
const attIsLast = (cfg, r) => attStepIdx(r) >= attChain(cfg).length - 1;
const attCanStep = (cfg, user, r) => {
  if (!r || !user || r.status !== 'pending') return false;
  if (!inScope(user, r.branchId)) return false;
  /* Không ai tự duyệt công cho chính mình, kể cả admin — đây là chỗ ra tiền */
  if (r.empId === user.id) return false;
  const st = attChain(cfg)[attStepIdx(r)];
  if (!st) return false;
  if ((roleOf(user.role).level || 0) >= 99) return true;
  return attStepOK(user, st);
};
const noAccent = (str) => String(str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
const pushCfg = (cfg) => ({ gasUrl: '', vapidKey: '', enabled: false, events: {}, who: {}, bdayMsg: '', ...((cfg || {}).push || {}) });
const pushWho = (cfg, evKey) => ((pushCfg(cfg).who || {})[evKey]) || null;
const pushTargets = (cfg, employees, evKey, branchId, fallbackLevel) => {
  const roles = pushWho(cfg, evKey);
  const scope = (e) => !branchId || e.branches.includes(branchId) || (roleOf(e.role).scope === 'all');
  return employees.filter(e => e.status !== 'off' && pushTokensOf(e).length && scope(e) &&
    (roles && roles.length ? roles.includes(e.role) : (roleOf(e.role).level || 0) >= (fallbackLevel == null ? 40 : fallbackLevel)));
};
const pushTokensOf = (e) => (e && e.fcmTokens) || [];
const pushSend = async (cfg, tokens, title, body, link) => {
  const p = pushCfg(cfg);
  const list = (tokens || []).filter(Boolean);
  if (!p.enabled || !p.gasUrl || !list.length) return false;
  try {
    const res = await fetch(p.gasUrl, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'push', tokens: list, title, body, link: link || '' }),
    });
    const j = JSON.parse(await res.text());
    return !!j.ok;
  } catch (e) { console.warn('push:', e.message); return false; }
};
const pushBulk = async (cfg, list, title, body, link) => {
  const p = pushCfg(cfg);
  if (!p.enabled) return 0;
  const tokens = [];
  (list || []).forEach(e => pushTokensOf(e).forEach(t => { if (tokens.indexOf(t) < 0) tokens.push(t); }));
  if (!tokens.length) return 0;
  const ok = await pushSend(cfg, tokens, title, body, link);
  return ok ? (list || []).filter(e => pushTokensOf(e).length).length : 0;
};
const canAttAll = (u) => { const r = roleOf(u.role); return r.attAll != null ? !!r.attAll : r.scope === 'all'; };
const canRecView = (u) => { const r = roleOf(u.role); return r.recView != null ? !!r.recView : (r.pages || []).includes('recon'); };
const canStkMove = (u) => { const r = roleOf(u.role); return r.stkMove != null ? !!r.stkMove : (r.level || 0) >= 40; };
const canStkMoveAppr = (u) => { const r = roleOf(u.role); return r.stkMoveAppr != null ? !!r.stkMoveAppr : ((r.level || 0) >= 60 || !!r.manage); };
const stockItems = (cfg, bid) => {
  const codes = ((cfg || {}).stockItems || {})[bid] || [];
  const cat = (cfg || {}).items || [];
  return codes.map(c => cat.find(x => x.code === c) || { code: c, name: c, unit: '', price: 0 });
};
const DEFAULT_REQ_TYPES = [
  { k: 'PR', l: 'Đề nghị mua sắm', short: 'Mua sắm', tag: 't-blue', form: 'PR', prefix: 'MS', folder: 'De xuat mua sam', pricing: true, hasItems: true, money: true,
    creators: ['NV', 'GS', 'AM', 'OM', 'ADMIN'],
    tiers: [
      { max: 2000000, steps: [{ mode: 'role', role: 'GS' }, { mode: 'price' }, { mode: 'role', role: 'AM' }] },
      { max: 10000000, steps: [{ mode: 'role', role: 'GS' }, { mode: 'role', role: 'AM' }, { mode: 'price' }, { mode: 'role', role: 'OM' }] },
      { max: null, steps: [{ mode: 'role', role: 'GS' }, { mode: 'role', role: 'AM' }, { mode: 'role', role: 'OM' }, { mode: 'price' }, { mode: 'level', level: 99 }] },
    ] },
  { k: 'PAY', l: 'Đề nghị thanh toán', short: 'Thanh toán', tag: 't-amber', form: 'PAY', prefix: 'TT', folder: 'De nghi thanh toan', pricing: false, hasItems: false, money: true,
    creators: ['GS', 'AM', 'OM', 'ADMIN'],
    tiers: [
      { max: 5000000, steps: [{ mode: 'role', role: 'AM' }] },
      { max: null, steps: [{ mode: 'role', role: 'AM' }, { mode: 'role', role: 'OM' }] },
    ] },
  { k: 'GEN', l: 'Đề xuất trình duyệt', short: 'Trình duyệt', tag: 't-violet', form: 'GEN', prefix: 'TD', folder: 'De xuat trinh duyet', pricing: false, hasItems: false, money: false,
    creators: ['NV', 'GS', 'AM', 'OM', 'ADMIN'],
    tiers: [{ max: null, steps: [{ mode: 'role', role: 'AM' }, { mode: 'role', role: 'OM' }] }] },
];
const nextReqId = (cfg, reqs, type) => {
  const T = tOf(cfg, type);
  const pre = (T.prefix || String(type).slice(0, 2)).toUpperCase();
  const n = (reqs || []).filter(r => String(r.id || '').startsWith(pre + '-'))
    .reduce((m, r) => Math.max(m, +String(r.id).split('-')[1] || 0), 0);
  return pre + '-' + String(n + 1).padStart(4, '0');
};
const typeList = (cfg) => ((cfg || {}).reqTypes && cfg.reqTypes.length ? cfg.reqTypes : DEFAULT_REQ_TYPES);
const typeListOn = (cfg) => typeList(cfg).filter(t => !t.off);
const tOf = (cfg, k) => typeList(cfg).find(t => t.k === k) || { k, l: k, short: k, tag: 't-gray', tiers: [] };
const DEFAULT_APPROVAL = {
  PR: [
    { max: 2000000, steps: [{ mode: 'role', role: 'GS' }, { mode: 'price' }, { mode: 'role', role: 'AM' }] },
    { max: 10000000, steps: [{ mode: 'role', role: 'GS' }, { mode: 'role', role: 'AM' }, { mode: 'price' }, { mode: 'role', role: 'OM' }] },
    { max: null, steps: [{ mode: 'role', role: 'GS' }, { mode: 'role', role: 'AM' }, { mode: 'role', role: 'OM' }, { mode: 'price' }, { mode: 'level', level: 99 }] },
  ],
  PAY: [
    { max: 5000000, steps: [{ mode: 'role', role: 'AM' }] },
    { max: null, steps: [{ mode: 'role', role: 'AM' }, { mode: 'role', role: 'OM' }] },
  ],
  GEN: [{ max: null, steps: [{ mode: 'role', role: 'AM' }, { mode: 'role', role: 'OM' }] }],
  supplyRoles: ['AM', 'OM', 'ADMIN'],
  creators: ['NV', 'GS', 'AM', 'OM', 'ADMIN'],
  skipSelf: true,
  /* Danh sách cấp duyệt mà NGƯỜI GỬI tự chọn ở bước mode:'pick' — xem pickersFor() */
  pickers: [],
};
const pickerList = (cfg) => (apprCfg(cfg).pickers || []).filter(x => x && x.empId);
const reqPickDept = (r, owner) => (r && r.costType === 'dept' && r.deptId) ? r.deptId : ((owner || {}).deptId || '');
const pickersFor = (cfg, employees, deptId) => {
  const all = pickerList(cfg);
  /* deptIds trống = cấp duyệt dùng chung cho mọi phòng ban */
  const hit = all.filter(x => ((x.deptIds || []).length ? x.deptIds.includes(deptId) : true));
  /* Phòng ban chưa được gán cấp duyệt nào thì thà hiện cả danh sách còn hơn chặn không gửi được */
  return (hit.length ? hit : all)
    .map(x => (employees || []).find(e => e.id === x.empId))
    .filter(e => e && e.status !== 'off');
};
const stepOK = (user, st, r) => {
  if (!st) return false;
  if (st.mode === 'price') return true;
  if (st.mode === 'level') return roleOf(user.role).level >= (st.level || 0);
  if (st.mode === 'user') return user.id === st.userId;
  if (st.mode === 'pick') return (r && r.pickBy)
    ? user.id === r.pickBy
    : !!(r && (r.pickOpts || []).includes(user.id));
  return user.role === st.role;
};
const stepLabel = (st, employees, r) => {
  if (!st) return '—';
  if (st.mode === 'price') return 'Chốt giá';
  if (st.mode === 'level') return 'Cấp ≥ ' + (st.level || 0);
  if (st.mode === 'user') return ((employees || []).find(e => e.id === st.userId) || {}).name || 'Người chỉ định';
  if (st.mode === 'pick') {
    const who = r && r.pickBy ? (employees || []).find(e => e.id === r.pickBy) : null;
    return who ? who.name : 'Cấp duyệt người gửi chọn';
  }
  return roleOf(st.role).short;
};
const apprCfg = (cfg) => ({ ...DEFAULT_APPROVAL, ...(cfg.approval || {}) });
const tierOf = (cfg, type, amount) => {
  /* Sắp theo hạn mức TĂNG DẦN trước khi dò: cấu hình khai lộn thứ tự (bậc không giới hạn nằm
     trên bậc 5 triệu chẳng hạn) thì phiếu nào cũng rơi vào bậc đầu tiên — sai chuỗi duyệt mà
     không ai biết vì sao. `max: null` nghĩa là không giới hạn nên luôn xuống cuối. */
  const tiers = (tOf(cfg, type).tiers || []).slice()
    .sort((a, b) => (a.max == null ? Infinity : a.max) - (b.max == null ? Infinity : b.max));
  return tiers.find(t => t.max == null || amount <= t.max) || tiers[tiers.length - 1] || { steps: [] };
};
const reqAmountRaw = (r) => (r.suppliers && r.suppliers.length)
  ? r.suppliers.reduce((a, s) => a + (s.amount || 0), 0)
  : (r.items && r.items.length ? r.items.reduce((a, i) => a + (i.qty || 0) * (i.price || 0), 0) : (r.amount || 0));
const chainOf = (cfg, r) => {
  /* ---- PHIẾU CÒN CHẠY THÌ BÁM RULE HIỆN TẠI, PHIẾU ĐÃ XONG THÌ ĐÓNG BĂNG ----
     Bản trước đóng băng chuỗi ngay lúc gửi phiếu, nên sửa bậc duyệt xong thì cả đống phiếu đang
     treo vẫn chạy luật cũ — phải vào từng phiếu bấm "Đồng bộ luồng duyệt" bằng tay.
     Nay: phiếu OPEN đọc thẳng cấu hình hiện tại (đổi rule là cả hàng đợi đổi theo ngay);
     phiếu đã DONE / REJECTED giữ nguyên r.chain đã dùng để lịch sử duyệt không bị viết lại.
     Chỉ số bước không đi theo chuỗi mới một cách mù quáng — xem stepIdx() ngay dưới. */
  const frozen = (r && r.chain && r.chain.length) ? r.chain.slice() : null;
  if (r && r.status !== 'OPEN' && frozen) return frozen;
  const t = tierOf(cfg, r.type, reqAmountRaw(r));
  let steps = (t.steps || []).slice();
  if (!tOf(cfg, r.type).pricing) steps = steps.filter(x => x.mode !== 'price');
  /* Cấu hình bị xoá trắng bậc cho mức tiền này thì thà chạy tiếp chuỗi cũ còn hơn treo phiếu */
  return steps.length ? steps : (frozen || []);
};
const stepIdx = (cfg, r) => {
  const n = (chainOf(cfg, r) || []).length;
  if (!n) return 0;
  return Math.min(Math.max(r.step || 0, 0), n - 1);
};
const chainNow = (cfg, type, amount, items) => {
  const t = tierOf(cfg, type, amount);
  let steps = (t.steps || []).slice();
  if (!tOf(cfg, type).pricing) steps = steps.filter(x => x.mode !== 'price');
  return steps;
};
const curStep = (cfg, r) => (chainOf(cfg, r) || [])[stepIdx(cfg, r)] || null;
const skipFrom = (cfg, r, i, creator) => {
  const chain = chainOf(cfg, r);
  if (!apprCfg(cfg).skipSelf || !creator) return i;
  /* Quét tới HẾT bậc cao nhất mà người lập đã đứng được, không dừng ở bước đầu tiên họ không thỏa:
     một phiếu chỉ cần đi LÊN. Kế toán (bậc 2) tự lên phiếu thanh toán thì bậc 1 — trưởng phòng xác
     nhận chi phí — hết ý nghĩa, luồng phải hiện thẳng "kế toán → CEO". Bản cũ dừng ngay bước đầu
     tiên không thỏa, nên AM tự lập phiếu vẫn phải ngồi chờ GS duyệt phiếu của cấp trên mình. */
  let last = -1;
  for (let k = i; k < chain.length && chain[k].mode !== 'price'; k++) {
    if (stepOK(creator, chain[k], r)) last = k;
  }
  /* Không bao giờ nhảy qua bước CHỐT GIÁ — vòng for đã dừng ở đó: cung ứng phải nhập NCC và giá thật,
     không ai chốt thay được.
     Người lập thỏa TRỌN chuỗi thì trả về số vượt cuối mảng, đúng như bản cũ: lúc lập phiếu, ReqForm
     chặn lại và báo "cấu hình duyệt chưa có bước nào" thay vì để người ta tự duyệt phiếu của chính
     mình; còn trong luồng duyệt thì đó là dấu hiệu phiếu đã qua bậc cuối. */
  return Math.max(i, last + 1);
};
const canStep = (cfg, user, r) => {
  if (r.status !== 'OPEN' || !inScope(user, r.branchId)) return false;
  const st = curStep(cfg, r);
  if (!st) return false;
  if (roleOf(user.role).level >= 99) return true;
  if (st.mode === 'price') return (apprCfg(cfg).supplyRoles || []).includes(user.role);
  return stepOK(user, st, r);
};
const dKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dAdd = (k, n) => { const d = new Date(k + 'T00:00:00'); d.setDate(d.getDate() + n); return dKey(d); };
const stkLastClosed = (stocks, bid, upto, since) => {
  let best = null;
  Object.keys(stocks || {}).forEach(k => {
    const r = stocks[k];
    if (!r || r.branchId !== bid || !r.closed) return;
    if (upto && r.date > upto) return;
    if (since && r.date < since) return;
    if (!best || r.date > best.date) best = r;
  });
  return best;
};
const isBtp = (r) => r && r.kind === 'btp';
const rcpUsage = (recipes, sold, all) => {
  const out = {};
  const btpBy = {};
  (all || recipes || []).forEach(r => { if (isBtp(r) && r.code) btpBy[r.code] = r; });
  const add = (it, q, dish, n, depth) => {
    if (it.noStock || !q) return;
    const b = it.sku && btpBy[it.sku];
    const bq = b ? +((b.batch || {}).qty) || 0 : 0;
    if (b && bq && depth < 4) {
      (b.items || []).forEach(x => add(x, (+x.qty || 0) * q / bq, dish, n, depth + 1));
      return;
    }
    const key = it.sku || ('~' + (it.name || it.id));
    const o = out[key] = out[key] || { sku: it.sku || '', name: it.name, unit: it.unit, qty: 0, cost: 0, from: [] };
    o.qty += q;
    o.cost += q * (+it.cost || 0);
    /* Cùng một món có thể ăn một nguyên liệu qua hai đường (trực tiếp + trong BTP) — cộng dồn
       vào một dòng, không liệt kê tên món hai lần */
    const f = o.from.find(x => x.name === dish);
    if (f) f.each += q / n; else o.from.push({ name: dish, n, each: q / n });
  };
  (recipes || []).forEach(r => {
    const n = +sold[r.id] || 0;
    if (!n) return;
    (r.items || []).forEach(it => add(it, (+it.qty || 0) * n, r.name, n, 0));
  });
  return Object.values(out).sort((a, b) => b.cost - a.cost || (a.name || '').localeCompare(b.name || ''));
};
const stkBomOf = (recipes) => {
  const byKv = {};
  (recipes || []).forEach(r => { if (!isBtp(r) && r.kvCode) byKv[String(r.kvCode).trim().toUpperCase()] = r; });
  const per = {};
  return (code) => {
    const r = byKv[String(code || '').trim().toUpperCase()];
    if (!r) return null;
    if (!per[r.id]) per[r.id] = rcpUsage([r], { [r.id]: 1 }, recipes).filter(u => u.sku);
    return { r, per: per[r.id] };
  };
};
const stkGoodsMap = (cfg) => {
  const o = {};
  ((cfg || {}).items || []).forEach(m => {
    if (m && m.type === 'goods') (m.kvCodes || []).forEach(k => { const c = String(k || '').trim().toUpperCase(); if (c) o[c] = m.code; });
  });
  return o;
};
const stkKey = (bid, date) => bid + '_' + date;
const stkClosedOn = (stocks, bid, d) => {
  const r = (stocks || {})[stkKey(bid, d)];
  return (r && r.closed) ? r : null;
};
const poIsDept = (p) => (p || {}).costType === 'dept';
const poRcBatches = (p) => (Array.isArray((p || {}).rcs) ? p.rcs : []);
const poReceived = (p) => !!p && ['received', 'done'].includes(p.status);
const poInDate = (p) => ((p || {}).rc || {}).date || String((((p || {}).rc || {}).at) || '').slice(0, 10) || (p || {}).date || '';
const poRcLines = (p) => {
  if (!p) return [];
  const items = p.items || [];
  const out = [], got = {};
  poRcBatches(p).forEach(b => (b.lines || []).forEach(l => {
    const q = +l.qty || 0;
    got[l.idx] = (got[l.idx] || 0) + q;
    out.push({ idx: l.idx, code: l.code || (items[l.idx] || {}).code || '', qty: q,
      date: l.date || b.date || String(b.at || '').slice(0, 10), batch: b.id });
  }));
  /* Phiếu đã sang "Đã nhận" mà chưa ghi đủ từng mã (phiếu cũ, hoặc quản trị đẩy trạng thái bằng tay):
     phần còn thiếu coi như về đủ vào ngày nhập kho chung của phiếu — không thì tồn kho hụt oan. */
  if (poReceived(p)) items.forEach((it, idx) => {
    const left = (+it.qty || 0) - (got[idx] || 0);
    if (left > 0) out.push({ idx, code: it.code || '', qty: left, date: poInDate(p), batch: '' });
  });
  return out;
};
const mvAdjIn = (m) => !!m && m.kind === 'adjin' && m.status === 'approved';
const mvOutOK = (m) => !!m && (m.kind === 'transfer' ? ['sent', 'done'].includes(m.status)
  : m.kind === 'adjin' ? false : m.status === 'approved');
const mvInOK = (m) => !!m && ((m.kind === 'transfer' && m.status === 'done') || (m.kind === 'adjin' && m.status === 'approved'));
const stkRecon = ({ cfg, stocks, pos, sales, moves, bid, baseDate, from, to, only, actDate, actStrict, recipes }) => {
  const cat = (cfg || {}).items || [];
  const bomOf = stkBomOf(recipes);
  const goodsOf = stkGoodsMap(cfg);
  const soldBom = {};      /* món đã quy theo BOM: { mã KiotViet: { name, qty, noBom } } */
  const pick = (only && only.length) ? new Set(only) : null;
  const codes = {};
  const row = (code) => {
    if (pick && !pick.has(code)) return null;
    if (!codes[code]) {
      const it = cat.find(x => x.code === code) || {};
      codes[code] = { code, name: it.name || code, unit: it.unit || '', group: it.group || '',
        price: +it.price || 0,
        open: 0, inQty: 0, adjIn: 0, sold: 0, disp: 0, tOut: 0, tIn: 0, actual: null, hasOpen: false };
    }
    return codes[code];
  };
  const add = (code, f, v) => { const r = row(code); if (r) r[f] += v; };
  /* Tồn đầu kỳ — CHỈ lấy bản chốt của đúng ngày admin chọn */
  const base = stkClosedOn(stocks, bid, baseDate);
  if (base) Object.keys(base.items || {}).forEach(c => {
    const r = row(c); if (!r) return; r.open = +base.items[c] || 0; r.hasOpen = true;
  });
  /* Nhập trong kỳ — lấy theo NGÀY NHẬP KHO ghi lúc nghiệm thu, không phải ngày lập phiếu:
     hàng chỉ vào kho lúc có người ký nhận, phiếu lập từ tháng trước mà tháng này mới về thì
     thuộc tháng này. Ngày đó do người nhận chọn và quản trị sửa lại được. */
  (pos || []).forEach(p => {
    if (!p || poIsDept(p) || p.branchId !== bid) return;
    /* Từng mã có NGÀY NHẬP KHO riêng, và mã đã về thì tính ngay dù cả phiếu chưa nhận đủ */
    poRcLines(p).forEach(l => {
      if (!l.code || !l.date || l.date < from || l.date > to) return;
      add(l.code, 'inQty', l.qty);
    });
  });
  /* ---- Xuất bán, cắt tới đúng NGÀY ĐẾM ----
     Bản tóm tắt doanh số lưu theo THÁNG. Tháng nằm trọn trong kỳ thì lấy nguyên số tháng đó.
     Tháng bị cắt giữa chừng (kỳ tháng 9 mà đếm ngày 11/9) thì phải cộng theo từng ngày của từng mã
     — đó là `items[mã].d` ghi lúc nạp file. File nạp trước khi có phần theo ngày, hoặc file không
     có cột ngày, thì KHÔNG cắt được: lúc đó lấy cả tháng và đánh dấu `partial` để báo cáo nói thẳng
     là số xuất bán đang gồm cả những ngày sau ngày đếm — thà nói ra còn hơn lặng lẽ trừ dư rồi báo
     hụt hàng oan cho cửa hàng. */
  let soldPartial = 0, soldCut = 0;
  Object.keys(sales || {}).forEach(k => {
    const s = sales[k];
    if (!s || s.branchId !== bid) return;
    const ym = String(s.ym || '');
    if (ym < from.slice(0, 7) || ym > to.slice(0, 7)) return;
    /* Tháng này có bị cắt đầu hoặc cắt đuôi không */
    /* Ngày cuối thật của tháng đó — lấy '-31' thì tháng nào cũng bị coi là "cắt dở", và những mã
       thiếu lịch theo ngày sẽ bị gắn cờ cảnh báo oan dù kỳ đang lấy trọn tháng */
    const mFrom = ym + '-01';
    const mTo = ym + '-' + pad(new Date(+ym.slice(0, 4), +ym.slice(5), 0).getDate());
    const cut = mFrom < from || mTo > to;
    /* Ghi số bán: mã là MÓN có định mức thì trừ vào từng NVL, còn lại trừ đúng mã đó */
    const sold = (c, q, it) => {
      if (!q) return;
      /* Hàng hóa: bán bao nhiêu trừ bấy nhiêu vào mã kho đã gắn */
      const gc = goodsOf[String(c).trim().toUpperCase()];
      if (gc) return add(gc, 'sold', q);
      const b = bomOf(c);
      if (!b) return add(c, 'sold', q);
      const o = soldBom[c] || (soldBom[c] = { code: c, name: b.r.name, kvName: it.name || b.r.kvName || '', qty: 0, noBom: !b.per.length });
      o.qty += q;
      b.per.forEach(u => add(u.sku, 'sold', u.qty * q));
    };
    Object.keys(s.items || {}).forEach(c => {
      const it = s.items[c] || {};
      if (!cut) return sold(c, +it.qty || 0, it);
      if (it.d) {
        soldCut = 1;
        let q = 0;
        Object.keys(it.d).forEach(dd => { if (dd >= from && dd <= to) q += +it.d[dd] || 0; });
        return sold(c, q, it);
      }
      soldPartial = 1;
      sold(c, +it.qty || 0, it);
    });
  });
  /* Xuất hủy + điều chuyển + nhập bổ sung */
  (moves || []).forEach(m => {
    if (!m || !m.date || m.date < from || m.date > to) return;
    if (m.branchId === bid && mvAdjIn(m)) {
      (m.items || []).forEach(i => { if (i.code) add(i.code, 'adjIn', +i.qty || 0); });
    }
    if (m.branchId === bid && mvOutOK(m)) {
      (m.items || []).forEach(i => { if (i.code) add(i.code, m.kind === 'transfer' ? 'tOut' : 'disp', +i.qty || 0); });
    }
    if (m.toBranchId === bid && m.kind === 'transfer' && mvInOK(m)) {
      (m.items || []).forEach(i => { if (i.code) add(i.code, 'tIn', +i.qty || 0); });
    }
  });
  /* Tồn thực tế: ưu tiên bản chốt của ĐÚNG ngày đếm đã chọn; cơ sở đó không chốt đúng ngày thì lùi
     về bản chốt gần nhất TRƯỚC ngày đếm và vẫn nằm trong kỳ — bản của kỳ trước không phải số kỳ này.
     Ngày thật sự dùng luôn hiện ra ở cột "Đếm ngày" để không ai tưởng mọi cơ sở đều đếm cùng ngày. */
  /* `actDate` + `actStrict`: xem toàn hệ thống tại MỘT ngày cụ thể. Bật chặt thì chỉ nhận bản
     chốt của đúng ngày đó — cơ sở nào không đếm ngày đó hiện là "chưa đếm", chứ không lặng lẽ lôi
     số của ngày khác ra so rồi để cột tổng toàn hệ thống trộn lẫn nhiều mốc thời gian.
     Không truyền gì thì giữ nguyên hành vi cũ, các màn hình khác không đổi. */
  const aDate = actDate || to;
  const act = actStrict
    ? stkClosedOn(stocks, bid, aDate)
    : (stkClosedOn(stocks, bid, aDate) || stkLastClosed(stocks, bid, aDate, from));
  if (act) Object.keys(act.items || {}).forEach(c => { const r = row(c); if (r) r.actual = +act.items[c] || 0; });
  const rows = Object.values(codes).map(r => {
    const book = r.open + r.inQty + r.adjIn - r.sold - r.disp - r.tOut + r.tIn;
    const diff = r.actual == null ? null : r.actual - book;
    /* Giá trị hao hụt: lệch nhân đơn giá trong danh mục. Âm là mất tiền thật. Mã chưa khai giá
       thì để 0 và đếm riêng — thà thiếu còn hơn bịa một con số rồi đem đi họp. */
    return { ...r, book, diff, value: diff == null ? null : diff * r.price };
  });
  const cnt = rows.filter(r => r.diff != null && r.diff !== 0);
  return {
    rows: rows.sort((a, b) => Math.abs(b.value || 0) - Math.abs(a.value || 0) || Math.abs(b.diff || 0) - Math.abs(a.diff || 0)),
    base, act, baseOK: !!base, actOK: !!act,
    /* actOn: bản đếm có đúng ngày mình chọn không. soldPartial: có tháng nào không cắt được theo ngày. */
    actOn: !!(act && act.date === aDate), actDate: aDate, soldPartial: !!soldPartial, soldCut: !!soldCut,
    /* Món bán ra đã quy về NVL theo BOM, và món có mã nhưng CHƯA có định mức (không trừ được gì) */
    soldBom: Object.values(soldBom), soldNoBom: Object.values(soldBom).filter(x => x.noBom),
    nDiff: cnt.length,
    absQty: rows.reduce((a, r) => a + Math.abs(r.diff || 0), 0),
    /* Tách hụt và dư: gộp lại thành một số thì hụt 10 triệu và dư 10 triệu trông như hoàn hảo */
    lossVal: rows.reduce((a, r) => a + ((r.value || 0) < 0 ? r.value : 0), 0),
    gainVal: rows.reduce((a, r) => a + ((r.value || 0) > 0 ? r.value : 0), 0),
    netVal: rows.reduce((a, r) => a + (r.value || 0), 0),
    noPrice: cnt.filter(r => !r.price).length,
    noCount: rows.filter(r => r.actual == null).length,
  };
};
const nxtBuild = ({ cfg, stocks, pos, sales, moves, recipes, bid, from, to }) => {
  const cat = (cfg || {}).items || [];
  const prev = dAdd(from, -1);
  const anchor = stkLastClosed(stocks, bid, prev);
  const openBy = {};
  if (anchor) {
    const R0 = stkRecon({ cfg, stocks, pos, sales, moves, bid, recipes, baseDate: anchor.date, from: dAdd(anchor.date, 1), to: prev, only: [] });
    (R0.rows || []).forEach(r => { openBy[r.code] = r.book; });
  }
  /* baseDate rỗng: kỳ này chỉ lấy PHÁT SINH, tồn đầu đã tính riêng ở trên */
  const R = stkRecon({ cfg, stocks, pos, sales, moves, bid, recipes, baseDate: '', from, to, only: [] });
  const by = {};
  (R.rows || []).forEach(r => { by[r.code] = r; });
  const catSet = new Set(cat.map(x => x.code));
  const days = Math.max(1, Math.round((new Date(to + 'T00:00:00') - new Date(from + 'T00:00:00')) / 864e5) + 1);
  const rows = cat.map(it => {
    const r = by[it.code] || {};
    const open = +openBy[it.code] || 0;
    const v = (k) => +r[k] || 0;
    const outOther = v('disp') + v('tOut') - v('tIn');
    const close = open + v('inQty') + v('adjIn') - v('sold') - outOther;
    const perDay = v('sold') / days;
    return {
      code: it.code, name: it.name || it.code, group: it.group || '', unit: it.unit || '',
      buyUnit: it.buyUnit || '', conv: +it.convRatio || 0, price: +it.price || 0,
      open, inQty: v('inQty'), adjIn: v('adjIn'), sold: v('sold'), disp: v('disp'), tOut: v('tOut'), tIn: v('tIn'),
      outOther, close, value: close * (+it.price || 0),
      daysLeft: perDay > 0 ? close / perDay : null,
      moved: !!(open || v('inQty') || v('adjIn') || v('sold') || v('disp') || v('tOut') || v('tIn')),
    };
  });
  /* Mã bán ra không phải NVL trong danh mục và không khớp công thức nào — không trừ được kho */
  const kvName = {};
  Object.values(sales || {}).forEach(s => { if (s && s.branchId === bid) Object.keys(s.items || {}).forEach(c => { if ((s.items[c] || {}).name) kvName[c] = s.items[c].name; }); });
  const stray = (R.rows || []).filter(r => !catSet.has(r.code) && r.sold > 0)
    .map(r => ({ code: r.code, name: kvName[r.code] || r.name, qty: r.sold })).sort((a, b) => b.qty - a.qty);
  return { rows, anchor, days, soldNoBom: R.soldNoBom || [], soldBom: R.soldBom || [], soldPartial: R.soldPartial, stray };
};
const nvlSoldIn = (sales, bids, from, to) => {
  const out = {};            /* mã KiotViet -> { code, name, group, qty, amount, days: { ngày: sl } } */
  let partial = 0;
  Object.values(sales || {}).forEach(s => {
    if (!s || !bids.includes(s.branchId)) return;
    const ym = String(s.ym || '');
    if (ym < from.slice(0, 7) || ym > to.slice(0, 7)) return;
    const mTo = ym + '-' + pad(new Date(+ym.slice(0, 4), +ym.slice(5), 0).getDate());
    const whole = ym + '-01' >= from && mTo <= to;
    Object.keys(s.items || {}).forEach(c => {
      const it = s.items[c] || {};
      const o = out[c] || (out[c] = { code: c, name: it.name || c, group: it.group || '', qty: 0, amount: 0, days: {} });
      if (it.d) {
        Object.keys(it.d).forEach(dk => {
          if (dk < from || dk > to) return;
          const q = +it.d[dk] || 0;
          o.qty += q; o.days[dk] = (o.days[dk] || 0) + q;
          o.amount += it.da ? (+it.da[dk] || 0) : (it.qty ? (+it.amount || 0) * q / it.qty : 0);
        });
      } else if (whole) { o.qty += +it.qty || 0; o.amount += +it.amount || 0; }
      else partial = 1;
    });
  });
  return { list: Object.values(out).filter(x => x.qty), partial };
};
const txnIsPlan = (t) => !!(t && t.planned);
const pnlLive = (t) => !!t && t.status === 'done' && !!t.catId && !t.split
  && (!txnIsPlan(t) || !t.matchTxnId);
const txnPerDate = (t) => {
  const d = String((t || {}).perDate || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : String((t || {}).date || '');
};
const txnBaseMo = (t) => String((t || {}).date || '').slice(0, 7);
const txnPer = (t) => {
  const pd = txnPerDate(t);
  if (pd) return pd.slice(0, 7);
  const b = txnBaseMo(t), p = (t || {}).perMo;
  return /^\d{4}-\d{2}$/.test(String(p || '')) ? p : b;
};
const txnInPer = (t, mo) => txnPer(t) === mo;
const allocTo = (t, bid) => (((t || {}).alloc || []).find(a => a.branchId === bid) || {}).amount || 0;
const DEFAULT_COST_CATS = [
  { id: 'CTNH', name: 'Tiền nhà (chi phí thuê mặt bằng)', parent: '' },
  { id: 'CLNC', name: 'Lương nhân công', parent: '' },
  { id: 'CDNW', name: 'Tiền điện – nước – dịch vụ', parent: '' },
  { id: 'CNHH', name: 'Nhập hàng hóa', parent: '' },
  { id: 'CMKT', name: 'Chi phí MKT Tiktok', parent: 'CMK' },
  { id: 'CMKF', name: 'Chi phí MKT Facebook', parent: 'CMK' },
  { id: 'CMKO', name: 'Chi phí MKT khác', parent: 'CMK' },
  { id: 'CMSV', name: 'Mua sắm vật tư', parent: 'CMS' },
  { id: 'CMSC', name: 'Mua sắm công cụ dụng cụ', parent: 'CMS' },
  { id: 'CSCC', name: 'Chi phí sửa chữa – thay thế', parent: '' },
  { id: 'CBVE', name: 'Dịch vụ bảo vệ / vé xe', parent: '' },
  { id: 'CNGO', name: 'Chi phí ngoại giao – tiếp khách', parent: '' },
  { id: 'CBOD', name: 'Chi phí hoạt động BOD', parent: '' },
  { id: 'CTXN', name: 'Thuế phải nộp', parent: '' },
  { id: 'QLTX', name: 'Chi phí đóng BHXH', parent: '' },
  { id: 'QLTB', name: 'Thưởng nội bộ', parent: '' },
  { id: 'CMSN', name: 'Thuê dịch vụ ngoài', parent: '' },
  { id: 'CBOC', name: 'Công tác phí', parent: '' },
  { id: 'CDTU', name: 'Chi đầu tư', parent: '' },
  { id: 'CKHK', name: 'Chi phí khác', parent: '' },
];
const costCats = (cfg) => (cfg.costCats && cfg.costCats.length ? cfg.costCats : DEFAULT_COST_CATS);
const DEFAULT_COST_GROUPS = [
  { id: 'CMK', name: 'Chi phí Marketing' },
  { id: 'CMS', name: 'Chi phí mua sắm' },
];
const costGroups = (cfg) => (cfg.costGroups && cfg.costGroups.length ? cfg.costGroups : DEFAULT_COST_GROUPS);
const catOf = (cfg, id) => costCats(cfg).find(c => c.id === id) || { id, name: id || '—', parent: '' };
const moLbl = (ym) => 'T' + String(ym || '').slice(5) + '/' + String(ym || '').slice(0, 4);
const PNL_BUY_CAT = 'CNHH';
const PNL_COMPACT = ['CLNC', 'CTNH', 'CDNW', 'CNHH', 'CMKO', 'CSCC', 'CTXN', 'CKHK'];
const pnlCfg = (cfg) => {
  const p = (cfg || {}).pnl || {};
  return { cogsMode: p.cogsMode === 'tt' ? 'tt' : 'dm', buyCat: p.buyCat || PNL_BUY_CAT, useStmt: !!p.useStmt,
    menu: Array.isArray(p.menu) && p.menu.length ? p.menu : PNL_COMPACT };
};
const pnlMenu = (cfg) => pnlCfg(cfg).menu.map(id => costCats(cfg).find(c => c.id === id)).filter(Boolean);
const pnlCogs = ({ cfg, sales, recipes, stocks, pos, moves, txns, bids, mo, to }) => {
  const P = pnlCfg(cfg);
  const from = mo + '-01';
  const mEnd = mo + '-' + pad(new Date(+mo.slice(0, 4), +mo.slice(5), 0).getDate());
  const end = to && to < mEnd ? to : mEnd;
  const cat = (cfg || {}).items || [];
  const priceOf = (c) => +((cat.find(x => x.code === c) || {}).price) || 0;
  const catSet = new Set(cat.map(x => x.code));
  const bomOf = stkBomOf(recipes);
  const goodsOf = stkGoodsMap(cfg);
  /* ---- Định mức ---- */
  const th = { by: {}, total: 0, noCost: {} };
  bids.forEach(b => {
    let c = 0;
    nvlSoldIn(sales, [b], from, end).list.forEach(s => {
      const g = goodsOf[String(s.code).trim().toUpperCase()];
      if (g) { c += priceOf(g) * s.qty; return; }
      const x = bomOf(s.code);
      if (x && x.per.length) { c += x.per.reduce((a, u) => a + u.cost, 0) * s.qty; return; }
      const o = th.noCost[s.code] || (th.noCost[s.code] = { code: s.code, name: (x && x.r && x.r.name) || s.name, qty: 0, amount: 0 });
      o.qty += s.qty; o.amount += s.amount;
    });
    th.by[b] = c; th.total += c;
  });
  th.noCost = Object.values(th.noCost).sort((a, b) => b.amount - a.amount);
  /* ---- Thực tế + đối chiếu ---- */
  const tt = { by: {}, total: 0, ok: true };
  const cmp = {};
  bids.forEach(b => {
    const base = stkLastClosed(stocks, b, dAdd(from, -1));
    const R = stkRecon({ cfg, stocks, pos, sales, moves, bid: b, recipes, baseDate: base ? base.date : '', from: base ? dAdd(base.date, 1) : from, to: end, only: [] });
    const v = (f) => R.rows.reduce((a, r) => a + (+r[f] || 0) * r.price, 0);
    const buy = (txns || []).filter(t => pnlLive(t) && t.catId === P.buyCat && txnInPer(t, mo)).reduce((a, t) => a + allocTo(t, b), 0);
    const open = v('open'), close = R.rows.reduce((a, r) => a + (r.actual == null ? 0 : r.actual * r.price), 0);
    const xfer = v('tIn') - v('tOut');
    /* Cơ sở không bán gì, không có kho trong kỳ (đã đóng, chưa mở) thì giá vốn = 0 và không đòi bản chốt tồn —
       không thì một chi nhánh đóng cửa làm cả hệ thống báo "thiếu chốt tồn" mãi */
    const idle = !R.rows.some(r => r.sold || r.inQty || r.adjIn || r.disp || r.tIn || r.tOut || r.actual != null || r.hasOpen) && !buy;
    const ok = idle || (!!base && !!R.act);
    /* inVal: hàng vào kho theo phiếu (nghiệm thu phiếu mua + nhập bổ sung) quy tiền — chỉ để THAM KHẢO đối chiếu
       với tiền nhập hàng chủ đã ghi; lệch nhiều là quên ghi chi phí nhập hàng (hoặc ghi trùng) */
    tt.by[b] = { open, buy, close, xfer, disp: v('disp'), adjIn: v('adjIn'), inVal: v('inQty') + v('adjIn'), cost: idle ? 0 : ok ? open + buy + xfer - close : null, ok, idle,
      baseDate: base ? base.date : '', actDate: R.act ? R.act.date : '' };
    if (ok) tt.total += tt.by[b].cost; else tt.ok = false;
    /* Dùng thực tế (không gồm huỷ) = tồn đầu + nhập + nhập bổ sung ± chuyển − huỷ − tồn cuối = book + bán − tồn cuối */
    R.rows.forEach(r => {
      /* Chỉ mã có trong danh mục nguyên liệu — mã bán KiotViet chưa gắn công thức không phải NVL */
      if (!catSet.has(r.code) || (r.actual == null && !r.sold)) return;
      const o = cmp[r.code] || (cmp[r.code] = { code: r.code, name: r.name, unit: r.unit, price: r.price, dm: 0, tt: 0, disp: 0, counted: true });
      o.dm += r.sold; o.disp += r.disp;
      if (r.actual == null || !ok) o.counted = false; else o.tt += r.book + r.sold - r.actual;
    });
  });
  const rows = Object.values(cmp).map(o => ({ ...o, diff: o.counted ? o.tt - o.dm : null, value: o.counted ? (o.tt - o.dm) * o.price : null, dispVal: o.disp * o.price }))
    .sort((a, b) => Math.abs(b.value || 0) - Math.abs(a.value || 0) || b.dm - a.dm);
  /* `cost`: giá vốn ĐANG CHỌN, mỗi cơ sở một con số (cách thực tế mà thiếu bản chốt tồn thì null) */
  const ttBy = {};
  bids.forEach(b => { ttBy[b] = tt.by[b].cost; });
  return { from, to: end, mode: P.cogsMode, buyCat: P.buyCat, dm: th, tt, cmp: rows,
    cost: P.cogsMode === 'tt' ? { by: ttBy, total: tt.total, ok: tt.ok } : { by: th.by, total: th.total, ok: true } };
};
  return { ALL_PAGES, BASE_PAGES, DEFAULT_ROLES, roleList, roleOf, inScope, scopeBranches, isBiz, bizList, canIssue, ISSUE_SEV, DEFAULT_ISSUE_CATS, itemGroups, itemsInGroup, canPreq, canPreqAll, canPreqAppr, pqSees, canConfirmAtt, attChain, attStepLabel, attStepIdx, attIsLast, attCanStep, pad, hoursTxt, dShort, uid, noAccent, pushCfg, pushTargets, pushBulk, canAttAll, canRecView, canStkMove, canStkMoveAppr, stockItems, nextReqId, typeListOn, tOf, apprCfg, pickersFor, reqPickDept, stepLabel, chainOf, chainNow, curStep, skipFrom, canStep, reqAmountRaw, nxtBuild, rcpUsage, isBtp, dAdd, pnlCogs, pnlCfg, pnlMenu, costCats, costGroups, catOf, txnInPer, pnlLive, allocTo, moLbl };
};
