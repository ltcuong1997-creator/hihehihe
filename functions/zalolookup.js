/* ===================== BOT ZALO — CỬA TRA CỨU CHUNG (tra_cuu) =====================
   Port từ ZSpace (zspacemusicbox/functions/zalolookup.js), đổi danh sách loại dữ liệu cho Hí Hế.
   Mỗi loại khai báo: collection, trường ngày, trường chi nhánh, TRANG app phải có quyền mới xem được
   (y như app ẩn trang theo vai trò), và trường phải CHE.

   KHÔNG BAO GIỜ đọc: lương / phiếu lương / thưởng phạt (ops_payadj, ops_ftlogs), cấu hình, kho mã
   voucher (ops_vpool), dữ liệu bot. Những collection đó không có trong SRC nên không tra được.
   Ngoài ra mọi khoá trông như SĐT / tài khoản / lương / địa chỉ đều bị bỏ khỏi kết quả (DROP).

   Máy chủ lọc + đếm + cộng sẵn (dem_theo / tong_theo) để AI nhận con số gọn, không phải nghìn dòng.
   Chỉ ĐỌC. */
const MAX_DAYS = 62, MAX_FETCH = 3000, MAX_FETCH_NODATE = 1500, MAX_ROWS = 60, MAX_GROUPS = 40;

/* Khoá bị che ở mọi loại (so trên tên khoá) */
const DROP = /(phone|sdt|tel$|mobile|email|mail$|zalo|bank|acc(ount)?(no|num|name)|^stk$|^bin$|cccd|cmnd|idcard|passport|salary|luong|wage|^rate|hourly|^pay$|^pay[A-Z]|realMins|cutMins|^est$|^amount$|addr|address|dob|birth|token|^pin|pass(word)?|secret|photo|img|image|avatar|signature|geo|wifi|authUid|fcm)/i;
/* Tiền KINH DOANH (không phải lương / tài khoản) — giữ lại ở các loại có amountOk */
const MONEY_OK = ['amount', 'bank', 'cash', 'wallet'];
const hidden = (k, src) => DROP.test(k) && !(src.amountOk && MONEY_OK.includes(k));
/* Khoá mảng / đối tượng lớn: thay bằng số phần tử */
const BIG = ['lines', 'history', 'msgs', 'items', 'appr', 'log', 'logs', 'stmt', 'links', 'rows', 'snaps', 'live', 'comments', 'acks', 'reacts', 'files', 'ch', 'chN', 'chL'];

/* loai -> cấu hình. page = trang app; own = trường người (chỉ xem của mình nếu không có quyền xem hết);
   keep = chỉ giữ các khoá này; amountOk = giữ tiền kinh doanh. date: null = không lọc được ở máy chủ
   theo ngày, đọc tối đa MAX_FETCH_NODATE bản rồi lọc theo date/created/at. */
const SRC = {
  cham_cong: { col: 'ops_attendance', date: 'date', br: 'branchId', page: 'attendance', own: 'empId',
    seeAll: (R, u) => R.canAttAll(u) || R.canConfirmAtt(u), hint: 'empId, date, shift, inAt, outAt, late (phút trễ), mins (phút làm), fixed (đã sửa tay)' },
  don_cong: { col: 'ops_attreqs', date: 'date', br: 'branchId', page: 'attendance', own: 'empId',
    seeAll: (R, u) => R.canAttAll(u) || R.canConfirmAtt(u), hint: 'empId, date, kind (extra = làm ngoài ca, adj = sửa giờ), status (pending/approved/rejected), step, inTime, outTime, mins, reason' },
  lich: { col: 'ops_schedule', date: 'date', br: 'branchId', page: 'shifts', hint: 'date, shiftId, empIds (danh sách nhân viên trong ca)' },
  su_co: { col: 'ops_issues', date: 'created', br: 'branchId', page: 'issues', amountOk: true, hint: 'created, title, cat, room, sev (KHAN/CAO/THUONG), status (MOI/TIEP_NHAN/DANG_XU_LY/CHO_DUYET/DONG/HUY), cost, vendor, assignee, by' },
  de_xuat_mua: { col: 'ops_preq', date: 'date', br: 'branchId', page: 'poreq', filter: (R, u, x) => R.pqSees(u, x), hint: 'date, code, group (nhóm hàng), status (draft/wait/approved/reject/taken/done), byName, apprName, items (số món), note' },
  phieu_mua_hang: { col: 'ops_po', date: 'date', br: 'branchId', page: 'purchase', amountOk: true, hint: 'date, code, kind, supplier, status, payStatus (unpaid/paid), dueDate, invNo, items (số dòng), by' },
  de_nghi: { col: 'ops_requests', date: null, br: 'branchId', page: 'requests', amountOk: true, hint: 'title, type/layout, status, amount, reason, needBy, by, created/at' },
  thong_bao: { col: 'ops_notices', date: null, br: 'branches', page: 'notices', hint: 'at, title, body, level, pinned, expire, by' },
  doanh_thu_ngay: { col: 'ops_revenue', date: 'date', br: 'branchId', page: 'revenue', amountOk: true, hint: 'date, amount (doanh thu), invoices (số hoá đơn), cash, bank, wallet' },
  nop_tien: { col: 'ops_deposits', date: 'created', br: 'branchId', page: 'cash', amountOk: true, hint: 'created, amount, status, month, year, content, note, by' },
  thu_chi: { col: 'ops_txns', date: 'date', br: 'branchId', page: 'pnl', amountOk: true, hint: 'date, amount, type/kind, cat, note, content' },
  thu_khac: { col: 'ops_incomes', date: 'date', br: 'branchId', page: 'pnl', amountOk: true, hint: 'date, amount, cat, note' },
  kiem_kho: { col: 'ops_stock', date: 'date', br: 'branchId', page: 'stock', hint: 'date (ngày đếm kho), shift, status, by' },
  xuat_nhap_kho: { col: 'ops_stkmove', date: 'date', br: 'branchId', page: 'stock', hint: 'date, code, kind (dispose = huỷ, transfer = điều chuyển, adjin = nhập bổ sung), status, reason, items (số món), byName' },
  voucher_nhan_vien: { col: 'ops_vreq', date: null, br: 'branchId', page: 'vouchers', own: 'empId', seeAll: (R, u) => (R.roleOf(u.role).level || 0) >= 60,
    hint: 'at, ym, type (free1 = free 1 ly, pct20 = giảm 20%), status (wait/ok/no/cancel), empName, cashierName' },
  nhan_su: { col: 'ops_employees', date: null, br: 'branches', page: 'staff', keep: ['name', 'code', 'role', 'branches', 'status', 'posId', 'type', 'joined'],
    hint: 'name, code, role, branches, status (off = đã nghỉ), posId, type (Fulltime/Parttime), joined (ngày vào làm)' },
};

const clip = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(Date.parse(s + 'T00:00:00Z'));
const dayVNof = (iso) => { const t = Date.parse(iso); return isNaN(t) ? String(iso || '').slice(0, 10) : new Date(t + 7 * 3600e3).toISOString().slice(0, 10); };

/* Một bản ghi -> bản gọn, đã che */
function compact(x, src) {
  const out = {};
  for (const [k, v] of Object.entries(x || {})) {
    if (src.keep && !src.keep.includes(k) && k !== 'id') continue;
    if (hidden(k, src)) continue;
    if (v == null || v === '') continue;
    if (BIG.includes(k) || Array.isArray(v)) {
      if (Array.isArray(v) && v.length <= 8 && v.every(y => typeof y !== 'object')) out[k] = v.map(y => clip(y, 40));
      else out[k] = Array.isArray(v) ? v.length : (typeof v === 'object' ? Object.keys(v).length : v);
      continue;
    }
    if (typeof v === 'object') {
      if (v && typeof v.toDate === 'function') { out[k] = v.toDate().toISOString(); continue; }
      const ks = Object.keys(v);
      if (ks.length <= 6) {
        const o = {};
        ks.forEach(kk => { if (!DROP.test(kk) && (typeof v[kk] !== 'object' || v[kk] == null)) o[kk] = typeof v[kk] === 'string' ? clip(v[kk], 60) : v[kk]; });
        out[k] = o;
      } else out[k] = ks.length;
      continue;
    }
    out[k] = typeof v === 'string' ? clip(v, 150) : v;
  }
  return out;
}

/* Ngày (giờ VN) của bản ghi để lọc khoảng ngày */
const dayOf = (x, src) => {
  const v = src.date ? x[src.date] : (x.date || x.created || x.at || '');
  const s = String(v || '');
  return /T\d\d:/.test(s) ? dayVNof(s) : s.slice(0, 10);
};

/* ctx: { db, R, cfg, me, emps: {id:{name}}, brName(id) } */
async function lookup(ctx, a) {
  const { db, R, cfg, me } = ctx;
  const src = SRC[a.loai];
  if (!src) return { loi: 'Không có loại dữ liệu "' + a.loai + '". Các loại: ' + Object.keys(SRC).join(', ') };
  const pages = (R.roleOf(me.role) || {}).pages || [];
  if (!pages.includes(src.page)) return { loi: 'Vai trò của người hỏi không xem được trang tương ứng trong app (' + src.page + ').' };
  /* Khoảng ngày */
  const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  const to = a.den_ngay ? String(a.den_ngay) : today;
  const from = a.tu_ngay ? String(a.tu_ngay) : new Date(Date.parse(to + 'T00:00:00Z') - 6 * 864e5).toISOString().slice(0, 10);
  if (!isDay(from) || !isDay(to) || to < from) return { loi: 'Ngày không hợp lệ (cần YYYY-MM-DD, đến ngày >= từ ngày).' };
  if ((Date.parse(to) - Date.parse(from)) / 864e5 + 1 > MAX_DAYS) return { loi: 'Tối đa ' + MAX_DAYS + ' ngày mỗi lần tra.' };
  /* Chi nhánh được xem: như app (phạm vi vai trò), giao danh sách hỏi */
  const allowed = R.scopeBranches(me, cfg);
  const asked = Array.isArray(a.chi_nhanh) && a.chi_nhanh.length ? a.chi_nhanh.map(String) : null;
  const bids = asked ? asked.filter(b => allowed.includes(b)) : allowed;
  const denied = asked ? asked.filter(b => !allowed.includes(b)) : [];
  if (!bids.length) return { loi: 'Không có chi nhánh nào được xem.', khong_co_quyen_chi_nhanh: denied };

  /* Đọc. Trường ngày kiểu ISO (created) so chuỗi: lấy rộng 1 ngày hai đầu rồi lọc lại theo giờ VN */
  let q = db.collection(src.col);
  const iso = src.date === 'created';
  if (src.date) {
    const lo = iso ? new Date(Date.parse(from + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10) : from;
    const hi = iso ? new Date(Date.parse(to + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10) + 'T99' : to;
    q = q.where(src.date, '>=', lo).where(src.date, '<=', hi);
  }
  const cap = src.date ? MAX_FETCH : MAX_FETCH_NODATE;
  const snap = await q.limit(cap).get();
  let rows = snap.docs.map(d => ({ ...(d.data() || {}), id: (d.data() || {}).id || d.id }));
  if (src.col !== 'ops_employees') rows = rows.filter(x => { const dd = dayOf(x, src); return !dd || (dd >= from && dd <= to); });
  /* Chi nhánh */
  rows = rows.filter(x => {
    const b = x[src.br];
    if (Array.isArray(b)) return !b.length || b.some(y => bids.includes(y));
    return !b || bids.includes(b);
  });
  /* Chỉ của mình khi không có quyền xem hết */
  const ownOnly = src.own && !(src.seeAll && src.seeAll(R, me));
  if (ownOnly) rows = rows.filter(x => x[src.own] === me.id);
  if (src.filter) rows = rows.filter(x => src.filter(R, me, x));
  /* Lọc thêm */
  if (a.trang_thai) rows = rows.filter(x => String(x.status || '').toLowerCase() === String(a.trang_thai).toLowerCase());
  const empName = (id) => (ctx.emps[id] && ctx.emps[id].name) || id;
  if (a.nhan_vien) {
    const want = String(a.nhan_vien).toLowerCase();
    const strip = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
    const hit = (id) => id && (String(id).toLowerCase() === want || strip(empName(id)).includes(strip(want)));
    rows = rows.filter(x => hit(x.empId) || hit(x.by) || hit(x.assignee) || (Array.isArray(x.empIds) && x.empIds.some(hit)) || (src.col === 'ops_employees' && (hit(x.id) || strip(x.name).includes(strip(want)))));
  }
  if (a.tu_khoa) {
    const k = String(a.tu_khoa).toLowerCase();
    rows = rows.filter(x => JSON.stringify(compact(x, src)).toLowerCase().includes(k));
  }
  const total = rows.length;
  const pretty = (k, v) => {
    if (v == null || v === '') return '(trống)';
    if (k === 'branchId') return ctx.brName(v);
    if (['empId', 'by', 'assignee', 'apprBy', 'approver'].includes(k)) return empName(v);
    if (['date', 'created', 'at', 'decidedAt'].includes(k)) return /T\d\d:/.test(String(v)) ? dayVNof(v) : String(v).slice(0, 10);
    return String(v);
  };
  const out = { loai: a.loai, tu_ngay: from, den_ngay: to, so_ban_ghi: total, ...(ownOnly ? { chi_cua_nguoi_hoi: true } : {}), ...(denied.length ? { khong_co_quyen_chi_nhanh: denied } : {}), ...(snap.size >= cap ? { canh_bao: 'Dữ liệu quá nhiều, chỉ đọc ' + cap + ' bản ghi — thu hẹp khoảng ngày / chi nhánh.' } : {}) };
  /* Đếm / cộng theo một trường */
  if (a.dem_theo) {
    const k = String(a.dem_theo);
    if (hidden(k, src)) return { ...out, loi: 'Không gom theo trường bị che (' + k + ').' };
    const sumK = a.tong_theo ? String(a.tong_theo) : '';
    if (sumK && hidden(sumK, src)) return { ...out, loi: 'Không cộng trường bị che (' + sumK + ').' };
    const g = {};
    rows.forEach(x => {
      const vals = Array.isArray(x[k]) ? x[k] : [x[k]];
      vals.forEach(v => {
        const key = pretty(k, v);
        g[key] = g[key] || { gia_tri: key, so_luong: 0, ...(sumK ? { tong: 0 } : {}) };
        g[key].so_luong++;
        if (sumK) g[key].tong += Number(x[sumK]) || 0;
      });
    });
    const list = Object.values(g).sort((p, q2) => (sumK ? q2.tong - p.tong : 0) || q2.so_luong - p.so_luong);
    return { ...out, dem_theo: k, ...(sumK ? { tong_theo: sumK, tong_cong: list.reduce((s, x) => s + x.tong, 0) } : {}), nhom: list.slice(0, MAX_GROUPS), ...(list.length > MAX_GROUPS ? { bi_cat_nhom: list.length - MAX_GROUPS } : {}) };
  }
  /* Danh sách dòng gọn (mới nhất trước) */
  const lim = Math.max(1, Math.min(MAX_ROWS, Number(a.gioi_han) || 25));
  rows.sort((p, q2) => String(q2[src.date || 'at'] || q2.created || q2.date || '').localeCompare(String(p[src.date || 'at'] || p.created || p.date || '')));
  const list = rows.slice(0, lim).map(x => {
    const c = compact(x, src);
    if (c.branchId) c.branchId = ctx.brName(c.branchId);
    if (Array.isArray(c.branches)) c.branches = c.branches.map(ctx.brName);
    ['empId', 'by', 'assignee', 'apprBy', 'approver'].forEach(k => { if (c[k]) c[k] = empName(c[k]); });
    if (Array.isArray(c.empIds)) c.empIds = c.empIds.map(empName);
    return c;
  });
  return { ...out, ban_ghi: list, ...(total > lim ? { bi_cat: total - lim } : {}) };
}

module.exports = { SRC, DROP, hidden, compact, lookup, MAX_DAYS };
