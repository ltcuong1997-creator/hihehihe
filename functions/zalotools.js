/* ===================== BOT ZALO — CÔNG CỤ DỮ LIỆU CHO TRỢ LÝ AI (Hí Hế) =====================
   Port từ ZSpace (zspacemusicbox/functions/zalotools.js), bỏ phần phòng hát / đặt phòng / đối soát,
   thêm số bán theo món (ops_sales) và lập đề xuất mua hàng.
   Trợ lý AI (zaloai.js) KHÔNG đụng Firestore. Nó chỉ gọi các công cụ dưới đây; mỗi công cụ tự kiểm
   quyền theo ĐÚNG luật của app (apprules.js — trích nguyên văn từ index.html) rồi mới đọc.

   ---- RANH GIỚI GHI ----
   Công cụ "soạn" (soan_*) KHÔNG ghi dữ liệu thật: chỉ lưu bản nháp vào ops_zguard/{zaloId}.pend.
   Chỉ khi người dùng nhắn OK, zalo.js mới gọi execPending() — code thường, không qua AI — và
   execPending kiểm quyền + trạng thái LẦN NỮA ngay lúc ghi. Ghi đúng các trường app đang ghi
   (IssueForm, PqNewModal, PqChat, AttReq trong index.html).
   Bậc cuối của đơn sửa giờ / quên chấm: KHÔNG ghi (phần tính công phức tạp) — trả link mở app. */
const appRules = require('./apprules');

const PEND_TTL = 10 * 60e3;
const PHOTO_TTL = 10 * 60e3;
const MAX_REV_DAYS = 62;
const COL = {
  rev: 'ops_revenue', sales: 'ops_sales', att: 'ops_attendance', iss: 'ops_issues', sch: 'ops_schedule',
  preq: 'ops_preq', areq: 'ops_attreqs', adj: 'ops_payadj', emp: 'ops_employees', guard: 'ops_zguard',
};
const OPEN_ISS = ['MOI', 'TIEP_NHAN', 'DANG_XU_LY', 'CHO_DUYET'];
const ISS_LABEL = { MOI: 'Mới báo', TIEP_NHAN: 'Đã tiếp nhận', DANG_XU_LY: 'Đang xử lý', CHO_DUYET: 'Chờ duyệt đóng', DONG: 'Đã đóng', HUY: 'Đã hủy' };
const PQ_LABEL = { draft: 'Nháp', wait: 'Chờ duyệt', approved: 'Đã duyệt', reject: 'Từ chối', taken: 'Người mua đã nhận', done: 'Xong' };
const DEF_ISSUE_CATS = ['Điện', 'Nước', 'Điều hòa', 'Máy pha chế', 'Tủ lạnh – tủ mát', 'Nội thất', 'Bếp – quầy bar', 'PCCC – an toàn', 'Vệ sinh', 'Khác'];

const hmVN = (ms) => new Date(ms + 7 * 3600e3).toISOString().slice(11, 16);
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(Date.parse(s + 'T00:00:00Z'));
const strip = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const clip = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

/* Tên / mã / id chi nhánh người dùng gõ -> id. "q1", "quan 1", "B1" đều ra đúng id. */
function matchBranch(branches, q) {
  const s = strip(q);
  if (!s) return null;
  const list = (branches || []).filter(b => b && b.id);
  const exact = list.find(b => strip(b.id) === s || strip(b.code) === s || strip(b.name) === s);
  if (exact) return exact.id;
  const core = (b) => strip(b.name).replace(/^hi he\s*/, '');
  const tail = (b) => strip(b.code).split(' ').pop();
  const hit = list.filter(b => core(b) === s || tail(b) === s || core(b).includes(s) || (s.includes(core(b)) && core(b).length >= 3));
  return hit.length === 1 ? hit[0].id : null;
}
/* Danh sách chi nhánh được hỏi, giao với chi nhánh được phép. Không nêu = mọi chi nhánh được phép. */
function pickBranches(cfg, allowed, asked) {
  const want = Array.isArray(asked) ? asked.filter(Boolean) : asked ? [asked] : [];
  if (!want.length) return { ids: allowed.slice(), bad: [], denied: [] };
  const ids = [], bad = [], denied = [];
  want.forEach(q => {
    const id = matchBranch(cfg.branches, q);
    if (!id) bad.push(String(q));
    else if (!allowed.includes(id)) denied.push(id);
    else if (!ids.includes(id)) ids.push(id);
  });
  return { ids, bad, denied };
}
const bName = (cfg, id) => { const b = (cfg.branches || []).find(x => x.id === id); return b ? (b.name || b.code || id) : id; };
const monthsIn = (from, to) => { const out = []; let m = from.slice(0, 7); const end = to.slice(0, 7); while (m <= end && out.length < 4) { out.push(m); const [y, mo] = m.split('-').map(Number); m = mo === 12 ? (y + 1) + '-01' : y + '-' + String(mo + 1).padStart(2, '0'); } return out; };

/* ---------------------------------------------------------------------------------------------- */
function createTools(deps) {
  const { db, now, log, fetchFn } = deps;
  const H = deps.helpers;      // { dayVN, dAdd, buildWeek, fmtWeek }
  const L = require('./zalolookup');

  /* ===== Định nghĩa công cụ gửi cho Claude (cố định, không phụ thuộc người hỏi -> cache được) ===== */
  const brArr = { type: 'array', items: { type: 'string' }, description: 'Mã chi nhánh (id) trong danh sách chi nhánh. Bỏ trống = mọi chi nhánh người hỏi được xem.' };
  const DEFS = [
    {
      name: 'doanh_thu',
      description: 'Doanh thu (sổ quỹ, robot KiotViet cập nhật mỗi giờ) theo ngày hoặc khoảng ngày, từng chi nhánh và tổng, kèm số hoá đơn và tiền mặt / chuyển khoản / ví. Ngày hôm nay là số tạm tính tới lần robot chạy gần nhất. Chỉ người có quyền xem trang Doanh thu trong app.',
      input_schema: { type: 'object', properties: {
        tu_ngay: { type: 'string', description: 'YYYY-MM-DD' }, den_ngay: { type: 'string', description: 'YYYY-MM-DD, tối đa 62 ngày sau tu_ngay' }, chi_nhanh: brArr,
      }, required: ['tu_ngay', 'den_ngay'], additionalProperties: false },
    },
    {
      name: 'ban_theo_mon',
      description: 'Số lượng bán và doanh thu theo MÓN (từ KiotViet) trong khoảng ngày: món bán chạy nhất, một món cụ thể bán bao nhiêu, theo nhóm món. Chỉ người xem được trang Xuất bán trong app.',
      input_schema: { type: 'object', properties: {
        tu_ngay: { type: 'string', description: 'YYYY-MM-DD' }, den_ngay: { type: 'string', description: 'YYYY-MM-DD, tối đa 62 ngày' }, chi_nhanh: brArr,
        tim_mon: { type: 'string', description: 'Lọc theo tên / mã món (gõ tắt được)' },
        xep_theo: { type: 'string', enum: ['so_luong', 'doanh_thu'] },
        gioi_han: { type: 'integer', minimum: 1, maximum: 40, description: 'Số món trả về (mặc định 15)' },
      }, required: ['tu_ngay', 'den_ngay'], additionalProperties: false },
    },
    {
      name: 'nguoi_trong_ca',
      description: 'Ai đang trong ca (đã vào ca, chưa ra ca) ở từng chi nhánh, kèm giờ vào và số phút đi trễ.',
      input_schema: { type: 'object', properties: { chi_nhanh: brArr }, additionalProperties: false },
    },
    {
      name: 'su_co',
      description: 'Sự cố bảo trì: mặc định các sự cố CHƯA đóng; hoặc mọi sự cố báo trong 7 ngày gần nhất.',
      input_schema: { type: 'object', properties: {
        pham_vi: { type: 'string', enum: ['dang_mo', '7_ngay'] }, chi_nhanh: brArr, chi_cua_toi: { type: 'boolean', description: 'Chỉ sự cố do chính người hỏi báo' },
      }, additionalProperties: false },
    },
    {
      name: 'lich_lam_viec',
      description: 'Lịch làm việc đã xếp của CHÍNH người hỏi. Muốn xem lịch cả chi nhánh / người khác thì dùng tra_cuu loai lich.',
      input_schema: { type: 'object', properties: { so_ngay: { type: 'integer', minimum: 1, maximum: 14 } }, additionalProperties: false },
    },
    {
      name: 'viec_cho_duyet',
      description: 'Các việc đang chờ CHÍNH người hỏi duyệt: đề xuất mua hàng, đơn công bổ sung (sửa giờ, quên chấm, làm ngoài ca). Trả về mã (id) để dùng với soan_duyet.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'tra_cuu',
      description: 'Tra cứu CHUNG dữ liệu vận hành của app khi không có công cụ chuyên biệt: lọc theo loại, khoảng ngày (mặc định 7 ngày tới hôm nay, tối đa 62), chi nhánh, nhân viên, trạng thái, từ khoá. Muốn đếm / xếp hạng / cộng tiền thì dùng dem_theo (+ tong_theo) — máy chủ gom sẵn. Chưa biết tên trường thì gọi trước với gioi_han nhỏ để xem. Theo đúng quyền app của người hỏi; lương, phiếu lương, thông tin riêng nhân viên KHÔNG tra được. Các loại và trường chính: ' +
        Object.entries(L.SRC).map(([k, v]) => k + ' (' + v.hint + ')').join('; '),
      input_schema: { type: 'object', properties: {
        loai: { type: 'string', enum: Object.keys(L.SRC) },
        tu_ngay: { type: 'string', description: 'YYYY-MM-DD' }, den_ngay: { type: 'string', description: 'YYYY-MM-DD' }, chi_nhanh: brArr,
        nhan_vien: { type: 'string', description: 'Tên (gõ tắt được) hoặc mã nhân viên' }, trang_thai: { type: 'string', description: 'Giá trị trường status' },
        tu_khoa: { type: 'string', description: 'Tìm trong nội dung bản ghi' },
        dem_theo: { type: 'string', description: 'Tên trường để gom nhóm, vd branchId, empId, status, date, cat' },
        tong_theo: { type: 'string', description: 'Trường số để cộng trong mỗi nhóm, vd amount, cost, mins, late' },
        gioi_han: { type: 'integer', minimum: 1, maximum: 60, description: 'Số dòng trả về khi không gom nhóm (mặc định 25)' },
      }, required: ['loai'], additionalProperties: false },
    },
    {
      name: 'soan_bao_su_co',
      description: 'SOẠN NHÁP một báo cáo sự cố bảo trì (chưa gửi). Ảnh người dùng vừa gửi (nếu có) tự đính kèm. Sau khi soạn, người dùng phải nhắn OK thì mới gửi thật — đừng tự nói là đã gửi.',
      input_schema: { type: 'object', properties: {
        chi_nhanh: { type: 'string', description: 'Mã chi nhánh (id)' },
        khu_vuc: { type: 'string', description: 'Vị trí / khu vực, vd quầy bar, tầng 2, toilet. Để trống nếu không rõ.' },
        loai: { type: 'string', description: 'Nhóm sự cố, vd Điện, Nước, Điều hòa, Máy pha chế, Khác (máy chủ tự khớp nhóm gần nhất trong cấu hình)' },
        muc_do: { type: 'string', enum: ['KHAN', 'CAO', 'THUONG'], description: 'KHAN = dừng bán / nguy hiểm, CAO = ảnh hưởng khách, THUONG = bảo trì' },
        tieu_de: { type: 'string', description: 'Mô tả ngắn, vd "Máy pha cà phê không lên nhiệt"' },
        mo_ta: { type: 'string', description: 'Chi tiết thêm nếu có' },
      }, required: ['chi_nhanh', 'loai', 'muc_do', 'tieu_de'], additionalProperties: false },
    },
    {
      name: 'soan_de_xuat_mua',
      description: 'SOẠN NHÁP một đề xuất mua hàng (chưa gửi): một chi nhánh, MỘT nhóm hàng, các mã hàng trong danh mục + số lượng. Máy chủ tự khớp tên món người dùng gõ với danh mục mã hàng; món không có trong danh mục thì báo lại. Người dùng nhắn OK mới tạo thật và gửi cấp trên duyệt.',
      input_schema: { type: 'object', properties: {
        chi_nhanh: { type: 'string', description: 'Mã chi nhánh (id)' },
        nhom: { type: 'string', description: 'Nhóm hàng (bỏ trống thì máy chủ tự suy từ các mã hàng)' },
        hang: { type: 'array', minItems: 1, maxItems: 30, items: { type: 'object', properties: {
          ten: { type: 'string', description: 'Tên hoặc mã hàng' }, so_luong: { type: 'number' }, ghi_chu: { type: 'string' },
        }, required: ['ten', 'so_luong'], additionalProperties: false } },
        ghi_chu: { type: 'string' },
      }, required: ['chi_nhanh', 'hang'], additionalProperties: false },
    },
    {
      name: 'soan_duyet',
      description: 'SOẠN NHÁP duyệt hoặc từ chối MỘT việc lấy từ viec_cho_duyet (chưa ghi). Người dùng phải nhắn OK thì mới ghi thật. Từ chối bắt buộc có lý do.',
      input_schema: { type: 'object', properties: {
        loai: { type: 'string', enum: ['de_xuat_mua', 'cong_bo_sung'] }, id: { type: 'string' },
        hanh_dong: { type: 'string', enum: ['duyet', 'tu_choi'] }, ly_do: { type: 'string' },
      }, required: ['loai', 'id', 'hanh_dong'], additionalProperties: false },
    },
  ];

  /* ===== Bối cảnh một lượt hỏi ===== */
  async function empsByIds(ids) {
    const out = {};
    const list = [...new Set(ids.filter(Boolean).map(String))];
    for (let i = 0; i < list.length; i += 100) {
      const got = await db.getAll(...list.slice(i, i + 100).map(x => db.collection(COL.emp).doc(x)));
      got.forEach(s => { if (s.exists) out[s.id] = { ...(s.data() || {}), id: s.id }; });
    }
    return out;
  }
  const ctxOf = (cfg, emp, extra) => {
    const R = appRules(cfg);
    const me = { ...emp, branches: Array.isArray(emp.branches) ? emp.branches : [] };
    return { cfg, R, me, ...extra };
  };
  const pagesOf = (c) => (c.R.roleOf(c.me.role).pages || []);
  /* Chi nhánh kinh doanh người hỏi được xem (vai trò phạm vi 'all' thấy mọi chi nhánh) */
  const bizMine = (c) => { const sc = c.R.scopeBranches(c.me, c.cfg); return c.R.bizList(c.cfg).map(b => b.id).filter(id => sc.includes(id)); };
  const err = (msg) => ({ loi: msg });
  const brNote = (c, p) => {
    const n = {};
    if (p.bad.length) n.khong_ro_chi_nhanh = p.bad;
    if (p.denied.length) n.khong_co_quyen_chi_nhanh = p.denied.map(id => bName(c.cfg, id));
    return n;
  };
  const rangeErr = (from, to) => {
    if (!isDay(from) || !isDay(to) || to < from) return 'Ngày không hợp lệ (cần YYYY-MM-DD, đến ngày >= từ ngày).';
    if ((Date.parse(to) - Date.parse(from)) / 864e5 + 1 > MAX_REV_DAYS) return 'Tối đa ' + MAX_REV_DAYS + ' ngày mỗi lần hỏi.';
    return '';
  };

  /* ===== Tra cứu chung (zalolookup.js) ===== */
  async function tra_cuu(c, a) {
    const p = a.chi_nhanh ? pickBranches(c.cfg, c.R.scopeBranches(c.me, c.cfg), a.chi_nhanh) : null;
    if (p && !p.ids.length) return { ...err('Không có chi nhánh nào được xem.'), ...brNote(c, p) };
    const es = await db.collection(COL.emp).select('name').get();
    const emps = {};
    es.docs.forEach(d => { emps[d.id] = { name: (d.data() || {}).name || d.id }; });
    const r = await L.lookup({ db, R: c.R, cfg: c.cfg, me: c.me, emps, brName: (id) => bName(c.cfg, id) }, { ...a, chi_nhanh: p ? p.ids : null });
    return p ? { ...r, ...brNote(c, p) } : r;
  }

  /* ===== Công cụ đọc ===== */
  async function doanh_thu(c, a) {
    if (!pagesOf(c).includes('revenue')) return err('Vai trò của người hỏi không được xem Doanh thu trong app.');
    const from = String(a.tu_ngay || ''), to = String(a.den_ngay || '');
    const re = rangeErr(from, to);
    if (re) return err(re);
    const p = pickBranches(c.cfg, bizMine(c), a.chi_nhanh);
    if (!p.ids.length) return { ...err('Không có chi nhánh nào được xem.'), ...brNote(c, p) };
    const snap = await db.collection(COL.rev).where('date', '>=', from).where('date', '<=', to).select('branchId', 'date', 'amount', 'invoices', 'cash', 'bank', 'wallet', 'at').get();
    const by = {};
    p.ids.forEach(id => { by[id] = { chi_nhanh: bName(c.cfg, id), doanh_thu: 0, so_hoa_don: 0, tien_mat: 0, chuyen_khoan: 0, vi_dien_tu: 0, so_ngay_co_so: 0 }; });
    let lastAt = '';
    snap.docs.forEach(d => {
      const v = d.data() || {};
      const r = by[v.branchId];
      if (!r) return;
      r.doanh_thu += Number(v.amount) || 0;
      r.so_hoa_don += Number(v.invoices) || 0;
      r.tien_mat += Number(v.cash) || 0;
      r.chuyen_khoan += Number(v.bank) || 0;
      r.vi_dien_tu += Number(v.wallet) || 0;
      r.so_ngay_co_so += 1;
      if (v.date === to && String(v.at || '') > lastAt) lastAt = String(v.at || '');
    });
    const rows = p.ids.map(id => by[id]);
    const today = H.dayVN(now());
    return {
      tu_ngay: from, den_ngay: to, don_vi: 'đồng', chi_nhanh: rows,
      tong: rows.reduce((x, r) => x + r.doanh_thu, 0),
      ghi_chu: to >= today ? 'Hôm nay là số tạm tính' + (lastAt ? ' (robot cập nhật lúc ' + hmVN(Date.parse(lastAt)) + ')' : '') + '.' : undefined,
      ...brNote(c, p),
    };
  }

  async function ban_theo_mon(c, a) {
    if (!pagesOf(c).includes('sales')) return err('Vai trò của người hỏi không được xem trang Xuất bán trong app.');
    const from = String(a.tu_ngay || ''), to = String(a.den_ngay || '');
    const re = rangeErr(from, to);
    if (re) return err(re);
    const p = pickBranches(c.cfg, bizMine(c), a.chi_nhanh);
    if (!p.ids.length) return { ...err('Không có chi nhánh nào được xem.'), ...brNote(c, p) };
    const refs = [];
    p.ids.forEach(b => monthsIn(from, to).forEach(m => refs.push(db.collection(COL.sales).doc(b + '_' + m))));
    const docs = refs.length ? await db.getAll(...refs) : [];
    const agg = {};
    docs.forEach(s => {
      if (!s.exists) return;
      const items = (s.data() || {}).items || {};
      Object.entries(items).forEach(([code, it]) => {
        let q = 0, m = 0;
        Object.entries(it.d || {}).forEach(([d, n]) => { if (d >= from && d <= to) q += Number(n) || 0; });
        Object.entries(it.da || {}).forEach(([d, n]) => { if (d >= from && d <= to) m += Number(n) || 0; });
        if (!q && !m) return;
        const o = agg[code] || (agg[code] = { ma: code, mon: it.name || code, nhom: it.group || '', don_vi: it.unit || '', so_luong: 0, doanh_thu: 0 });
        o.so_luong += q; o.doanh_thu += m;
      });
    });
    let list = Object.values(agg);
    if (a.tim_mon) { const k = strip(a.tim_mon); list = list.filter(x => strip(x.mon + ' ' + x.ma + ' ' + x.nhom).includes(k)); }
    const key = a.xep_theo === 'doanh_thu' ? 'doanh_thu' : 'so_luong';
    list.sort((x, y) => y[key] - x[key]);
    const lim = Math.min(40, Math.max(1, Number(a.gioi_han) || 15));
    return {
      tu_ngay: from, den_ngay: to, chi_nhanh: p.ids.map(id => bName(c.cfg, id)), so_mon: list.length,
      tong_so_luong: Math.round(list.reduce((s, x) => s + x.so_luong, 0)), tong_doanh_thu: list.reduce((s, x) => s + x.doanh_thu, 0),
      mon: list.slice(0, lim).map(x => ({ ...x, so_luong: Math.round(x.so_luong * 100) / 100 })),
      ...(list.length > lim ? { bi_cat: list.length - lim } : {}), ...brNote(c, p),
    };
  }

  async function nguoi_trong_ca(c, a) {
    const p = pickBranches(c.cfg, c.R.scopeBranches(c.me, c.cfg), a.chi_nhanh);
    if (!p.ids.length) return { ...err('Không có chi nhánh nào được xem.'), ...brNote(c, p) };
    const t = now(), today = H.dayVN(t), yest = H.dAdd(today, -1);
    const snap = await db.collection(COL.att).where('date', '>=', yest).where('date', '<=', today).get();
    const live = snap.docs.map(d => d.data() || {})
      .filter(v => v.inAt && !v.outAt && p.ids.includes(v.branchId) && t - Date.parse(v.inAt) < 16 * 3600e3);
    const emps = await empsByIds(live.map(v => v.empId));
    const shifts = c.cfg.shifts || [];
    const rows = p.ids.map(id => {
      const ppl = live.filter(v => v.branchId === id).sort((x, y) => String(x.inAt).localeCompare(String(y.inAt))).map(v => ({
        ten: (emps[v.empId] || {}).name || v.empId, ca: ((shifts.find(s => s.id === v.shift) || {}).name) || '',
        vao_luc: hmVN(Date.parse(v.inAt)), tre_phut: Number(v.late) > 0 ? Number(v.late) : undefined,
      }));
      return { chi_nhanh: bName(c.cfg, id), so_nguoi: ppl.length, nguoi: ppl };
    });
    return { luc: hmVN(t), chi_nhanh: rows, ...brNote(c, p) };
  }

  async function su_co(c, a) {
    if (!pagesOf(c).includes('issues')) return err('Vai trò của người hỏi không xem được trang Bảo trì.');
    const p = pickBranches(c.cfg, c.R.scopeBranches(c.me, c.cfg), a.chi_nhanh);
    if (!p.ids.length) return { ...err('Không có chi nhánh nào được xem.'), ...brNote(c, p) };
    const t = now();
    let docs;
    if (a.pham_vi === '7_ngay') {
      const since = new Date(t - 7 * 864e5).toISOString();
      docs = (await db.collection(COL.iss).where('created', '>=', since).get()).docs;
    } else {
      docs = (await db.collection(COL.iss).where('status', 'in', OPEN_ISS).get()).docs;
    }
    const rows = docs.map(d => d.data() || {})
      .filter(x => p.ids.includes(x.branchId) && (!a.chi_cua_toi || x.by === c.me.id))
      .sort((x, y) => String(y.created).localeCompare(String(x.created)));
    const sev = c.R.ISSUE_SEV;
    const list = rows.slice(0, 30).map(x => {
      const ageH = (t - Date.parse(x.created)) / 3600e3;
      const sla = ((sev[x.sev] || sev.THUONG || {}).sla) || 72;
      return {
        ma: x.id, chi_nhanh: bName(c.cfg, x.branchId), khu_vuc: x.room || '', nhom: x.cat || '', muc_do: x.sev || '',
        tieu_de: clip(x.title, 120), trang_thai: ISS_LABEL[x.status] || x.status, bao_luc: x.created ? H.dayVN(Date.parse(x.created)) + ' ' + hmVN(Date.parse(x.created)) : '',
        tre_han: OPEN_ISS.includes(x.status) && ageH > sla ? true : undefined,
      };
    });
    return { so_su_co: rows.length, su_co: list, bi_cat: rows.length > list.length ? rows.length - list.length : undefined, ...brNote(c, p) };
  }

  async function lich_lam_viec(c, a) {
    const n = Math.min(14, Math.max(1, Math.floor(Number(a.so_ngay) || 7)));
    const from = H.dayVN(now()), to = H.dAdd(from, n - 1);
    const qs = await db.collection(COL.sch).where('date', '>=', from).where('date', '<=', to).get();
    const week = H.buildWeek(qs.docs.map(d => d.data()), c.me.id, c.cfg, from, n);
    return { van_ban: H.fmtWeek(week, c.me.name || 'anh/chị').replace('7 ngày', n + ' ngày') };
  }

  async function pendingFor(c) {
    const out = [];
    if (c.R.canPreqAppr(c.me)) {
      const q = await db.collection(COL.preq).where('status', '==', 'wait').get();
      q.docs.map(d => ({ ...(d.data() || {}), id: d.id })).filter(x => c.R.pqSees(c.me, x)).forEach(x => out.push({
        loai: 'de_xuat_mua', id: x.id, ma: x.code || x.id, chi_nhanh: bName(c.cfg, x.branchId), nguoi_lap: x.byName || '',
        nhom: x.group || '', so_mat_hang: (x.items || []).length,
        hang: (x.items || []).slice(0, 5).map(it => (it.name || it.code || '') + ' x' + (Number(it.qty) || 0) + (it.unit ? ' ' + it.unit : '')).join('; '),
      }));
    }
    const qa = await db.collection(COL.areq).where('status', '==', 'pending').get();
    const reqs = qa.docs.map(d => ({ ...(d.data() || {}), id: d.id })).filter(r => c.R.attCanStep(c.cfg, c.me, r));
    const emps = await empsByIds(reqs.map(r => r.empId));
    reqs.forEach(r => {
      const last = c.R.attIsLast(c.cfg, r);
      out.push({
        loai: 'cong_bo_sung', id: r.id, nhan_vien: (emps[r.empId] || {}).name || r.empId, chi_nhanh: bName(c.cfg, r.branchId),
        ngay: r.date, kieu: r.kind === 'extra' ? 'làm ngoài ca' : r.kind === 'adj' ? 'sửa giờ vào/ra' : 'quên chấm công',
        gio: (r.inTime || '—') + ' → ' + (r.outTime || '—'), ly_do: clip(r.reason || '', 100),
        bac: (c.R.attStepIdx(r) + 1) + '/' + c.R.attChain(c.cfg).length,
        duyet_qua_bot_duoc: !(last && r.kind !== 'extra') || undefined,
        ghi_chu: last && r.kind !== 'extra' ? 'Bậc cuối của đơn sửa giờ/quên chấm phải duyệt trong app (app tự tính lại công).' : undefined,
      });
    });
    return out;
  }
  async function viec_cho_duyet(c) {
    const list = await pendingFor(c);
    return { so_viec: list.length, viec: list.slice(0, 20), bi_cat: list.length > 20 ? list.length - 20 : undefined };
  }

  /* ===== Công cụ soạn nháp ===== */
  async function setPend(c, pend) {
    await db.collection(COL.guard).doc(String(c.zaloId)).set({ pend: { ...pend, at: now(), exp: now() + PEND_TTL } }, { merge: true });
    c.pendSet = pend;
  }

  async function soan_bao_su_co(c, a) {
    if (!c.R.canIssue(c.me, 'report')) return err('Vai trò của người hỏi không được báo sự cố.');
    const p = pickBranches(c.cfg, bizMine(c), [a.chi_nhanh]);
    if (p.ids.length !== 1) return { ...err('Cần đúng một chi nhánh người hỏi phụ trách.'), ...brNote(c, p) };
    const cats = Array.isArray(c.cfg.issueCats) && c.cfg.issueCats.length ? c.cfg.issueCats : (c.R.DEFAULT_ISSUE_CATS || DEF_ISSUE_CATS);
    const cat = cats.find(x => strip(x) === strip(a.loai)) || cats.find(x => strip(x).includes(strip(a.loai)) || strip(a.loai).includes(strip(x))) || cats[cats.length - 1];
    const sev = ['KHAN', 'CAO', 'THUONG'].includes(a.muc_do) ? a.muc_do : 'CAO';
    const title = clip(String(a.tieu_de || '').trim(), 140);
    if (!title) return err('Thiếu mô tả ngắn sự cố.');
    /* Ảnh: tin hiện tại, hoặc ảnh gửi trong 10 phút trước */
    const ph = c.photo || null;
    let photo = '', photoNote;
    if (ph && ph.url) {
      const up = await uploadDrive(c.cfg, ph, 'SUCO-' + p.ids[0]).catch(e => { log.warn('zalo: tải ảnh lên Drive lỗi', { err: String(e && e.message) }); return null; });
      if (up) photo = up;
      else photoNote = (c.cfg.drive || {}).gasUrl ? 'Không tải được ảnh lên Drive — sự cố vẫn gửi được, không kèm ảnh.' : 'Chưa khai Google Drive trong app nên ảnh không được lưu kèm.';
    }
    const data = {
      branchId: p.ids[0], room: clip(String(a.khu_vuc || '').trim(), 40), cat, sev, title,
      desc: clip(String(a.mo_ta || '').trim(), 1000), photo,
    };
    await setPend(c, { kind: 'issue', data });
    return {
      da_soan_nhap: true, chua_gui: true,
      ban_nhap: { chi_nhanh: bName(c.cfg, data.branchId), khu_vuc: data.room, nhom: cat, muc_do: (c.R.ISSUE_SEV[sev] || {}).label || sev, tieu_de: title, mo_ta: data.desc, kem_anh: !!photo },
      ghi_chu_anh: photoNote,
    };
  }

  async function soan_de_xuat_mua(c, a) {
    if (!c.R.canPreq(c.me)) return err('Vai trò của người hỏi không được lập đề xuất mua hàng.');
    const p = pickBranches(c.cfg, bizMine(c), [a.chi_nhanh]);
    if (p.ids.length !== 1) return { ...err('Cần đúng một chi nhánh người hỏi phụ trách.'), ...brNote(c, p) };
    const cat = (c.cfg.items || []).filter(i => i && i.code);
    if (!cat.length) return err('Danh mục mã hàng trong app đang trống — vào Cấu hình nạp danh mục trước.');
    const groups = c.R.itemGroups(c.cfg);
    let group = a.nhom ? (groups.find(g => strip(g) === strip(a.nhom)) || groups.find(g => strip(g).includes(strip(a.nhom)) || strip(a.nhom).includes(strip(g)))) : '';
    if (a.nhom && !group) return err('Không có nhóm hàng "' + a.nhom + '". Các nhóm: ' + groups.join(', '));
    /* Khớp từng món: mã đúng, tên đúng, rồi tên chứa — trong nhóm đã chọn (nếu có) */
    const pool = group ? c.R.itemsInGroup(c.cfg, group) : cat;
    const items = [], miss = [], many = [];
    (a.hang || []).slice(0, 30).forEach(h => {
      const k = strip(h.ten);
      const qty = Number(h.so_luong);
      if (!k || !(qty > 0)) { miss.push(String(h.ten || '') + ' (số lượng phải > 0)'); return; }
      let hit = pool.filter(i => strip(i.code) === k || strip(i.name) === k);
      if (!hit.length) hit = pool.filter(i => strip(i.name).includes(k) || k.includes(strip(i.name)));
      if (hit.length === 1) {
        const it = hit[0];
        const old = items.find(x => x.code === it.code);
        if (old) old.qty += qty;
        else items.push({ code: it.code, name: it.name, unit: it.unit || '', qty, note: clip(String(h.ghi_chu || '').trim(), 200), group: (it.group || '').trim() });
      } else if (hit.length > 1) many.push({ ten: h.ten, khop: hit.slice(0, 6).map(i => i.name + ' (' + i.code + ')') });
      else miss.push(String(h.ten));
    });
    if (many.length || miss.length) {
      return { loi: 'Chưa soạn được — có món chưa khớp danh mục.', ...(many.length ? { khop_nhieu_ma: many } : {}), ...(miss.length ? { khong_co_trong_danh_muc: miss } : {}),
        goi_y: 'Hỏi lại người dùng chọn đúng mã, hoặc bỏ món không có trong danh mục.' };
    }
    if (!items.length) return err('Chưa có món nào.');
    const gs = [...new Set(items.map(i => i.group).filter(Boolean))];
    if (!group) {
      if (gs.length > 1) return err('Một đề xuất chỉ được một nhóm hàng, các món đang thuộc nhiều nhóm: ' + gs.join(', ') + '. Tách thành nhiều đề xuất.');
      group = gs[0] || '';
    }
    if (!group) return err('Các món chưa có nhóm hàng trong danh mục — lập trong app.');
    const data = { branchId: p.ids[0], group, items: items.map(({ group: _g, ...x }) => x), note: clip(String(a.ghi_chu || '').trim(), 500) };
    await setPend(c, { kind: 'preqNew', data });
    return {
      da_soan_nhap: true, chua_gui: true,
      ban_nhap: { chi_nhanh: bName(c.cfg, data.branchId), nhom: group, hang: data.items.map(i => i.name + ' x' + i.qty + (i.unit ? ' ' + i.unit : '') + (i.note ? ' (' + i.note + ')' : '')), ghi_chu: data.note || undefined, sau_khi_ok: 'tạo đề xuất và gửi cấp trên phê duyệt' },
    };
  }

  async function soan_duyet(c, a) {
    const act = a.hanh_dong === 'tu_choi' ? 'reject' : 'approve';
    const why = String(a.ly_do || '').trim();
    if (act === 'reject' && !why) return err('Từ chối phải có lý do — hỏi người dùng lý do.');
    if (a.loai === 'de_xuat_mua') {
      const s = await db.collection(COL.preq).doc(String(a.id)).get();
      const x = s.exists ? { ...(s.data() || {}), id: s.id } : null;
      if (!x || x.status !== 'wait' || !c.R.canPreqAppr(c.me) || !c.R.pqSees(c.me, x)) return err('Đề xuất này không còn chờ duyệt hoặc người hỏi không có quyền duyệt.');
      await setPend(c, { kind: 'preq', data: { id: x.id, act, why: clip(why, 500) } });
      return { da_soan_nhap: true, chua_ghi: true, ban_nhap: { viec: (act === 'approve' ? 'Phê duyệt' : 'Từ chối') + ' đề xuất mua ' + (x.code || x.id), chi_nhanh: bName(c.cfg, x.branchId), nguoi_lap: x.byName || '', ly_do: why || undefined } };
    }
    if (a.loai === 'cong_bo_sung') {
      const s = await db.collection(COL.areq).doc(String(a.id)).get();
      const r = s.exists ? { ...(s.data() || {}), id: s.id } : null;
      if (!r || r.status !== 'pending' || !c.R.attCanStep(c.cfg, c.me, r)) return err('Đơn này không còn chờ người hỏi duyệt.');
      const last = c.R.attIsLast(c.cfg, r);
      if (act === 'approve' && last && r.kind !== 'extra') {
        return { can_mo_app: true, link: appUrl(c.cfg) + '#attendance', ghi_chu: 'Bậc cuối của đơn sửa giờ / quên chấm phải duyệt trong app (app tự tính lại giờ công). Gửi link này cho người dùng.' };
      }
      const emps = await empsByIds([r.empId]);
      await setPend(c, { kind: 'areq', data: { id: r.id, act, why: clip(why, 500), step: c.R.attStepIdx(r) } });
      return {
        da_soan_nhap: true, chua_ghi: true,
        ban_nhap: {
          viec: act === 'reject' ? 'Từ chối đơn công' : last ? 'Duyệt bậc cuối' + (r.kind === 'extra' ? ' và cộng ' + (Number(r.est) || 0).toLocaleString('vi-VN') + 'đ vào bổ sung lương' : '') : 'Duyệt bậc ' + (c.R.attStepIdx(r) + 1) + '/' + c.R.attChain(c.cfg).length,
          nhan_vien: (emps[r.empId] || {}).name || r.empId, ngay: r.date, ly_do: why || undefined,
        },
      };
    }
    return err('Loại việc không hợp lệ.');
  }

  const appUrl = (cfg) => String(((cfg || {}).offer || {}).appUrl || 'https://hihehihe.web.app').replace(/\/+$/, '');

  /* Tải ảnh Zalo lên Google Drive qua Apps Script — đúng giao thức uploadDrive() của app.
     Chưa khai Drive -> null (không có Drive thì không lưu ảnh). */
  async function uploadDrive(cfg, ph, label) {
    const d = { gasUrl: '', folderId: '', ...((cfg || {}).drive || {}) };
    if (!d.gasUrl) return null;
    const img = ph.b64 ? ph : await fetchImage(ph.url);
    if (!img) throw new Error('không tải được ảnh từ Zalo');
    const stamp = new Date(now() + 7 * 3600e3).toISOString().replace(/[-:]/g, '').slice(0, 15).replace('T', '-');
    const body = JSON.stringify({ data: img.b64, mime: img.mime, name: label.replace(/[^A-Za-z0-9-]/g, '') + '_' + stamp + '.jpg', sub: 'Su co bao tri', folderId: d.folderId });
    for (let i = 0; i < 2; i++) {
      try {
        const r = await fetchFn(d.gasUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body });
        const j = JSON.parse(await r.text());
        if (j && j.ok && j.url) return j.url;
        throw new Error((j && j.error) || 'Drive trả về lỗi');
      } catch (e) { if (i) throw e; await new Promise(r => setTimeout(r, 1200)); }
    }
    return null;
  }
  /* Ảnh Zalo -> base64 (để AI nhìn + để đưa lên Drive). Giới hạn 5MB như API Claude. */
  async function fetchImage(url) {
    const u = String(url || '');
    if (!(/^https:\/\//.test(u) || (process.env.FUNCTIONS_EMULATOR === 'true' && /^http:\/\/127\.0\.0\.1[:/]/.test(u)))) return null;
    const ctl = new AbortController();
    const tm = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetchFn(url, { signal: ctl.signal });
      if (!r.ok) return null;
      const mime = String(r.headers && r.headers.get ? r.headers.get('content-type') || '' : '').split(';')[0].trim().toLowerCase();
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length || buf.length > 5 * 1024 * 1024) return null;
      const m = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mime) ? mime : sniff(buf);
      return m ? { b64: buf.toString('base64'), mime: m, url } : null;
    } catch (e) { return null; } finally { clearTimeout(tm); }
  }
  const sniff = (b) => b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : b[0] === 0x89 && b[1] === 0x50 ? 'image/png'
    : b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP' ? 'image/webp' : b.slice(0, 3).toString() === 'GIF' ? 'image/gif' : null;

  const RUN = { doanh_thu, ban_theo_mon, nguoi_trong_ca, su_co, lich_lam_viec, viec_cho_duyet, tra_cuu, soan_bao_su_co, soan_de_xuat_mua, soan_duyet };
  /* Trong nhóm Zalo quản lý: hỏi số liệu theo quyền NHÓM (c.me); việc gắn với một người (lịch, việc chờ
     duyệt, soạn nháp) chạy bằng quyền của CHÍNH người hỏi đã kết nối (c.actor), chưa kết nối thì từ chối. */
  const PERSONAL = ['lich_lam_viec', 'viec_cho_duyet', 'soan_bao_su_co', 'soan_de_xuat_mua', 'soan_duyet'];
  async function run(c, name, input) {
    const fn = RUN[name];
    if (!fn) return err('Không có công cụ ' + name);
    if (c && c.group && PERSONAL.includes(name)) {
      if (!c.actor) return err('Việc này cần người hỏi đã kết nối Zalo với app Hí Hế (nhắn riêng cho bot để kết nối). Trong nhóm, người chưa kết nối chỉ hỏi số liệu được.');
      const outer = c;
      const inner = ctxOf(c.cfg, c.actor, { zaloId: c.zaloId, photo: c.photo || null });
      try { return await fn(inner, input && typeof input === 'object' ? input : {}); }
      catch (e) { log.error('zalo: công cụ lỗi', { name, err: String(e && e.message) }); return err('Lỗi máy chủ khi lấy dữ liệu, thử lại sau.'); }
      /* bản nháp soạn bằng quyền người gửi -> báo ngược cho lượt AI (để thêm câu "gõ bot ok") */
      finally { if (inner.pendSet) outer.pendSet = inner.pendSet; }
    }
    try { return await fn(c, input && typeof input === 'object' ? input : {}); }
    catch (e) { log.error('zalo: công cụ lỗi', { name, err: String(e && e.message) }); return err('Lỗi máy chủ khi lấy dữ liệu, thử lại sau.'); }
  }

  /* ===== Thực thi bản nháp sau khi người dùng nhắn OK — code thường, KHÔNG qua AI ===== */
  async function execPending(cfg, emp, pend) {
    const c = ctxOf(cfg, emp, {});
    const R = c.R, me = c.me, iso = new Date(now()).toISOString();
    if (!pend || !pend.kind || !(Number(pend.exp) > now())) return { ok: false, msg: 'Bản nháp đã hết hạn (10 phút). Nhắn lại yêu cầu nhé.' };
    if (pend.kind === 'issue') {
      const d = pend.data || {};
      if (!R.canIssue(me, 'report') || !bizMine(c).includes(d.branchId)) return { ok: false, msg: 'Anh/chị không còn quyền báo sự cố cho chi nhánh này.' };
      const id = R.uid('SC');
      const rec = {
        branchId: d.branchId, room: d.room || '', cat: d.cat || '', sev: d.sev || 'CAO', title: d.title || '', desc: d.desc || '', photo: d.photo || '',
        id, by: me.id, created: iso, status: 'MOI', assignee: '', cost: 0, vendor: '', src: 'zalo',
        history: [{ at: iso, by: me.id, act: 'Báo sự cố', note: (d.desc || '—') + ' (qua Zalo)' }],
      };
      await db.collection(COL.iss).doc(id).create(rec);
      /* Thông báo đẩy y như app (IssueForm): lưu trước, đẩy sau; đẩy lỗi không làm mất sự cố */
      try {
        const pz = R.pushCfg(cfg);
        if (pz.enabled && pz.events && pz.events.issue) {
          const all = (await db.collection(COL.emp).get()).docs.map(s => ({ ...(s.data() || {}), id: s.id, branches: (s.data() || {}).branches || [] }));
          const tg = R.pushTargets(cfg, all, 'issue', d.branchId, 40);
          const br = (cfg.branches || []).find(b => b.id === d.branchId) || {};
          if (tg.length) await R.pushBulk(cfg, tg, 'Sự cố mới · ' + (br.code || d.branchId), (d.cat || 'Sự cố') + (d.room ? ' · ' + d.room : '') + ' — ' + String(d.title || '').slice(0, 90), (cfg.offer || {}).appUrl || '/');
        }
      } catch (e) { log.warn('zalo: đẩy thông báo sự cố lỗi (sự cố vẫn đã lưu)', { err: String(e && e.message) }); }
      return { ok: true, msg: 'Đã gửi báo sự cố ' + id + '.', ref: id };
    }
    if (pend.kind === 'preqNew') {
      const d = pend.data || {};
      if (!R.canPreq(me) || !bizMine(c).includes(d.branchId)) return { ok: false, msg: 'Anh/chị không còn quyền lập đề xuất cho chi nhánh này.' };
      const id = R.uid('DX');
      const dk = new Date(now() + 7 * 3600e3).toISOString().slice(0, 10);
      const code = 'DX-' + dk.replace(/-/g, '').slice(2) + '-' + String(Math.random()).slice(2, 5);
      /* Đúng các trường PqNewModal của app ghi (gửi duyệt luôn: status 'wait') */
      await db.collection(COL.preq).doc(id).create({
        id, code, branchId: d.branchId, date: dk, group: d.group || '',
        items: (d.items || []).map(i => ({ code: i.code, name: i.name, unit: i.unit || '', qty: Number(i.qty) || 0, note: i.note || '' })),
        links: [], photos: [], note: d.note || '', status: 'wait',
        by: me.id, byName: me.name || me.id, at: iso, viaZalo: true,
        msgs: [{ at: iso, by: me.id, byName: me.name || me.id, sys: true, text: 'Lập đề xuất qua Zalo và gửi cấp trên phê duyệt' }],
      });
      return { ok: true, msg: 'Đã tạo đề xuất mua ' + code + ' (' + (d.items || []).length + ' món) và gửi cấp trên phê duyệt.', ref: id };
    }
    if (pend.kind === 'preq') {
      const d = pend.data || {};
      const ref = db.collection(COL.preq).doc(String(d.id));
      return db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        const x = s.exists ? { ...(s.data() || {}), id: s.id } : null;
        if (!x || x.status !== 'wait' || !R.canPreqAppr(me) || !R.pqSees(me, x)) return { ok: false, msg: 'Đề xuất không còn chờ duyệt (có thể người khác vừa xử lý).' };
        const msgs = [...(x.msgs || [])];
        if (d.act === 'reject' && d.why) msgs.push({ at: iso, by: me.id, byName: me.name || me.id, text: d.why });
        msgs.push({ at: iso, by: me.id, byName: me.name || me.id, sys: true, text: d.act === 'approve' ? 'Cấp trên đã phê duyệt — người mua tiếp nhận được' : 'Từ chối đề xuất — xem lý do trong khung trao đổi' });
        const patch = d.act === 'approve'
          ? { status: 'approved', apprBy: me.id, apprName: me.name || me.id, apprAt: iso }
          : { status: 'reject' };
        tx.update(ref, { ...patch, msgs, upAt: iso, upBy: me.id, viaZalo: true });
        return { ok: true, msg: (d.act === 'approve' ? 'Đã phê duyệt' : 'Đã từ chối') + ' đề xuất ' + (x.code || x.id) + '.' };
      });
    }
    if (pend.kind === 'areq') {
      const d = pend.data || {};
      const ref = db.collection(COL.areq).doc(String(d.id));
      const pre = await ref.get();
      const r0 = pre.exists ? { ...(pre.data() || {}), id: pre.id } : null;
      const chain = R.attChain(cfg);
      const st0 = r0 ? chain[R.attStepIdx(r0)] : null;
      const stN = r0 ? chain[R.attStepIdx(r0) + 1] : null;
      const lblEmps = [st0, stN].some(x => x && x.mode === 'user') ? Object.values(await empsByIds([st0, stN].filter(x => x && x.mode === 'user').map(x => x.userId))) : [];
      let label = '—', nextLabel = '';
      try { label = R.attStepLabel(st0, lblEmps); } catch (e) { label = '—'; }
      try { nextLabel = stN ? R.attStepLabel(stN, lblEmps) : ''; } catch (e) { nextLabel = ''; }
      return db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        const r = s.exists ? { ...(s.data() || {}), id: s.id } : null;
        if (!r || r.status !== 'pending' || !R.attCanStep(cfg, me, r) || R.attStepIdx(r) !== d.step) return { ok: false, msg: 'Đơn không còn chờ anh/chị duyệt (có thể người khác vừa xử lý).' };
        const idx = R.attStepIdx(r), last = R.attIsLast(cfg, r);
        const tr = { by: me.id, at: iso, step: idx, label, note: d.why || '' };
        if (d.act === 'reject') {
          tx.update(ref, { status: 'rejected', approver: me.id, decidedAt: iso, decideNote: d.why, appr: [...(r.appr || []), { ...tr, reject: true }] });
          return { ok: true, msg: 'Đã từ chối đơn công.' };
        }
        const trace = [...(r.appr || []), tr];
        if (!last) {
          tx.update(ref, { step: idx + 1, appr: trace });
          return { ok: true, msg: 'Đã duyệt bậc ' + (idx + 1) + '/' + chain.length + ' (phần của anh/chị). Đơn CHƯA xong: còn chờ ' + (nextLabel && nextLabel !== '—' ? nextLabel : 'người duyệt bậc ' + (idx + 2)) + ' duyệt bậc ' + (idx + 2) + ', nên trên app đơn vẫn hiện "Chờ duyệt".' };
        }
        if (r.kind !== 'extra') return { ok: false, msg: 'Bậc cuối đơn này phải duyệt trong app: ' + appUrl(cfg) + '#attendance' };
        const amt = Number(r.est) || 0;
        /* Mã phiếu CỐ ĐỊNH 'PA' + id đơn — bấm bao nhiêu lần cũng chỉ một phiếu */
        if (amt > 0) {
          tx.set(db.collection(COL.adj).doc('PA' + r.id), {
            id: 'PA' + r.id, empId: r.empId, period: String(r.date || '').slice(0, 7), type: 'add', amount: amt, reqId: r.id, src: 'extra',
            note: 'Chấm bổ sung ' + R.dShort(r.date) + ' · ' + R.hoursTxt(Number(r.mins) || 0) + (r.reason ? ' · ' + r.reason : ''),
            by: me.id, at: iso,
          }, { merge: true });
        }
        tx.update(ref, { status: 'approved', approver: me.id, amount: amt, appr: trace, decidedAt: iso, decideNote: d.why || '' });
        return { ok: true, msg: 'Đã duyệt XONG đơn công (bậc cuối)' + (amt > 0 ? ' và cộng ' + amt.toLocaleString('vi-VN') + 'đ vào bổ sung lương' : '') + '.' };
      });
    }
    return { ok: false, msg: 'Không rõ bản nháp.' };
  }

  return { DEFS, run, ctxOf, execPending, fetchImage, pendingFor, PHOTO_TTL };
}

module.exports = { createTools, matchBranch, pickBranches, hmVN, isDay, strip, DEF_ISSUE_CATS, PEND_TTL };
