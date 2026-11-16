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
  return { ALL_PAGES, BASE_PAGES, DEFAULT_ROLES, roleList, roleOf, inScope, scopeBranches, isBiz, bizList, canIssue, ISSUE_SEV, DEFAULT_ISSUE_CATS, itemGroups, itemsInGroup, canPreq, canPreqAll, canPreqAppr, pqSees, canConfirmAtt, attChain, attStepLabel, attStepIdx, attIsLast, attCanStep, pad, hoursTxt, dShort, uid, noAccent, pushCfg, pushTargets, pushBulk, canAttAll, canRecView };
};
