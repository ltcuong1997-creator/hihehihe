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
  return { ALL_PAGES, BASE_PAGES, DEFAULT_ROLES, roleList, roleOf, inScope, scopeBranches, isBiz, bizList, canIssue, ISSUE_SEV, DEFAULT_ISSUE_CATS, itemGroups, itemsInGroup, canPreq, canPreqAll, canPreqAppr, pqSees, canConfirmAtt, attChain, attStepLabel, attStepIdx, attIsLast, attCanStep, pad, hoursTxt, dShort, uid, noAccent, pushCfg, pushTargets, pushBulk, canAttAll, canRecView, canStkMove, canStkMoveAppr, stockItems, nextReqId, typeListOn, tOf, apprCfg, pickersFor, reqPickDept, stepLabel, chainOf, chainNow, curStep, skipFrom, canStep, reqAmountRaw };
};
