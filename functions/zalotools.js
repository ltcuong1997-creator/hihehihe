/* ===================== BOT ZALO — CÔNG CỤ DỮ LIỆU CHO TRỢ LÝ AI (Hí Hế) =====================
   Port từ ZSpace (zspacemusicbox/functions/zalotools.js), bỏ phần phòng hát / đặt phòng / đối soát,
   thêm: số bán theo món (ops_sales), doanh thu theo nguồn đơn, ảnh lịch làm việc, lập đề xuất mua hàng,
   phiếu huỷ hàng / nhập bổ sung (ops_stkmove, chờ quản lý duyệt), đề nghị thanh toán chi phí
   (ops_requests loại PAY, chạy đúng chuỗi duyệt của app).
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
  mv: 'ops_stkmove', req: 'ops_requests',
};
/* Nguồn đơn — cùng bảng REV_CH của app (tab Doanh thu); khoá o_* là kênh riêng, nhãn ở chL */
const REV_CH = { dine: 'Tại chỗ', take: 'Mang về', grab: 'GrabFood', shopee: 'ShopeeFood', be: 'beFood', na: 'Chưa rõ nguồn' };
const MV_LABEL = { dispose: 'phiếu huỷ hàng', adjin: 'phiếu nhập bổ sung', transfer: 'phiếu điều chuyển' };
const OPEN_ISS = ['MOI', 'TIEP_NHAN', 'DANG_XU_LY', 'CHO_DUYET'];
const ISS_LABEL = { MOI: 'Mới báo', TIEP_NHAN: 'Đã tiếp nhận', DANG_XU_LY: 'Đang xử lý', CHO_DUYET: 'Chờ duyệt đóng', DONG: 'Đã đóng', HUY: 'Đã hủy' };
const PQ_LABEL = { draft: 'Nháp', wait: 'Chờ duyệt', approved: 'Đã duyệt', reject: 'Từ chối', taken: 'Người mua đã nhận', done: 'Xong' };
const DEF_ISSUE_CATS = ['Điện', 'Nước', 'Điều hòa', 'Máy pha chế', 'Tủ lạnh – tủ mát', 'Nội thất', 'Bếp – quầy bar', 'PCCC – an toàn', 'Vệ sinh', 'Khác'];

const hmVN = (ms) => new Date(ms + 7 * 3600e3).toISOString().slice(11, 16);
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(Date.parse(s + 'T00:00:00Z'));
const strip = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const clip = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

/* Dòng TUỲ CHỌN của KiotViet (mức đá / đường / ngọt, %, nóng - lạnh, size) bán kèm theo món — không phải
   món, không tính vào món bán chạy / bán chậm / tổng số ly. Vd: "Đá bình thường", "Đường 75%", "50%",
   "Ít đá", "Không đường", "Đá riêng", "Nóng", "Size L". Topping có tên riêng (trân châu, thạch...) vẫn là món. */
const OPT_WORD = '(da|duong|ngot|sua|beo|chua)';
const OPT_RE = [
  /%/,
  new RegExp('^(it|nhieu|khong|ko|k|bot|them|vua|nhe|binh thuong|bt|bth)\\s+' + OPT_WORD + '(\\s|$)'),
  new RegExp('^' + OPT_WORD + '(\\s+(binh thuong|bt|bth|thuong|vua|it|nhieu|rieng|nhe|khong|ko|tieu chuan|chuan|\\d+))?$'),
  /^(nong|lanh|da rieng|binh thuong|bt|bth|tieu chuan)$/,
  /^size\s*[a-z0-9]*$/,
];
const isOptionItem = (name) => { const n = String(name == null ? '' : name).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase().replace(/\s+/g, ' ').trim(); return !!n && OPT_RE.some(r => r.test(n)); };

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

/* ===== P&L một tháng — cùng công thức trang P&L của app (pnlCogs + chi phí ghi tay theo kỳ ghi nhận) =====
   Doanh thu = Sổ quỹ (ops_revenue). Giá vốn = định mức hoặc thực tế theo cfg.pnl.cogsMode. Chi phí = khoản đã ghi
   (ops_txns còn hiệu lực, đúng kỳ) TRỪ mã Nhập hàng hoá (đã nằm trong giá vốn / là tồn kho). Gom theo nhóm GỌN. */
async function loadPnl(db, R, cfg, mo, bids, today) {
  const prevMo = (() => { const [y, m] = mo.split('-').map(Number); return m === 1 ? (y - 1) + '-12' : y + '-' + String(m - 1).padStart(2, '0'); })();
  const mEnd = mo + '-' + String(new Date(Date.UTC(Number(mo.slice(0, 4)), Number(mo.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0');
  const to = today && today.slice(0, 7) === mo ? today : mEnd;
  const winFrom = new Date(Date.parse(mo + '-01T00:00:00Z') - 70 * 864e5).toISOString().slice(0, 10);
  const [rv, tx, rc, po, mv, ...st] = await Promise.all([
    db.collection('ops_revenue').where('date', '>=', mo + '-01').where('date', '<=', to).select('branchId', 'amount').get(),
    db.collection('ops_txns').where('date', '>=', winFrom).where('date', '<=', mEnd).get(),
    db.collection('ops_recipes').get(), db.collection('ops_po').get(),
    db.collection('ops_stkmove').where('date', '>=', prevMo + '-01').get(),
    ...bids.map(b => db.collection('ops_stock').where('branchId', '==', b).get()),
  ]);
  const sales = {};
  const sd = bids.length ? await db.getAll(...bids.flatMap(b => [mo, prevMo].map(m => db.collection('ops_sales').doc(b + '_' + m)))) : [];
  sd.forEach(x => { if (x.exists) sales[x.id] = x.data() || {}; });
  const stocks = {};
  st.forEach(q => q.docs.forEach(d => { stocks[d.id] = { ...(d.data() || {}), id: d.id }; }));
  const txns = tx.docs.map(d => ({ ...(d.data() || {}), id: d.id }));
  const G = R.pnlCogs({ cfg, sales, recipes: rc.docs.map(d => ({ ...(d.data() || {}), id: d.id })), stocks, pos: po.docs.map(d => ({ ...(d.data() || {}), id: d.id })),
    moves: mv.docs.map(d => ({ ...(d.data() || {}), id: d.id })), txns, bids, mo, to });
  const P = R.pnlCfg(cfg);
  const rev = {}; bids.forEach(b => { rev[b] = 0; });
  rv.docs.forEach(d => { const v = d.data() || {}; if (rev[v.branchId] != null) rev[v.branchId] += Number(v.amount) || 0; });
  const menu = R.pnlMenu(cfg).filter(c => c.id !== P.buyCat);
  const groups = menu.map(c => ({ id: c.id, name: c.name, by: {}, total: 0 }));
  const other = { id: '_', name: 'Mã chi phí khác', by: {}, total: 0 };
  txns.filter(t => R.pnlLive(t) && R.txnInPer(t, mo) && t.catId !== P.buyCat).forEach(t => {
    const g = groups.find(x => x.id === t.catId) || other;
    bids.forEach(b => { const v = R.allocTo(t, b); g.by[b] = (g.by[b] || 0) + v; g.total += v; });
  });
  const costs = [...groups, ...(other.total ? [other] : [])];
  const sum = (o) => bids.reduce((a, b) => a + (o[b] || 0), 0);
  const costBy = {}; bids.forEach(b => { costBy[b] = costs.reduce((a, g) => a + (g.by[b] || 0), 0); });
  const revT = sum(rev), cogsT = G.cost.total, costT = sum(costBy);
  return {
    mo, to, mode: P.cogsMode, rev: { by: rev, total: revT }, cogs: { by: G.cost.by, total: cogsT, ok: G.cost.ok, noCost: G.dm.noCost.length },
    gross: revT - cogsT, costs, cost: { by: costBy, total: costT }, profit: revT - cogsT - costT,
    tt: G.tt, dmTotal: G.dm.total, cmpTop: G.cmp.filter(r => r.value != null && r.value > 0).slice(0, 5),
  };
}

/* ---------------------------------------------------------------------------------------------- */
function createTools(deps) {
  const { db, now, log, fetchFn } = deps;
  const H = deps.helpers;      // { dayVN, dAdd, buildWeek, fmtWeek }
  const L = require('./zalolookup');
  const IMG = require('./zaloimg');

  /* ===== Định nghĩa công cụ gửi cho Claude (cố định, không phụ thuộc người hỏi -> cache được) ===== */
  const brArr = { type: 'array', items: { type: 'string' }, description: 'Mã chi nhánh (id) trong danh sách chi nhánh. Bỏ trống = mọi chi nhánh người hỏi được xem.' };
  const DEFS = [
    {
      name: 'doanh_thu',
      description: 'Doanh thu (sổ quỹ, robot KiotViet cập nhật mỗi giờ) theo ngày hoặc khoảng ngày, từng chi nhánh và tổng: số hoá đơn, tiền mặt / chuyển khoản / ví, và CHI TIẾT THEO NGUỒN ĐƠN (tại chỗ, mang về, GrabFood, ShopeeFood, beFood, kênh khác — tiền + số đơn + tỉ trọng). Muốn từng ngày thì them theo_ngay. Ngày hôm nay là số tạm tính. Chỉ người có quyền xem trang Doanh thu trong app.',
      input_schema: { type: 'object', properties: {
        tu_ngay: { type: 'string', description: 'YYYY-MM-DD' }, den_ngay: { type: 'string', description: 'YYYY-MM-DD, tối đa 62 ngày sau tu_ngay' }, chi_nhanh: brArr,
        theo_ngay: { type: 'boolean', description: 'Trả thêm doanh thu + nguồn đơn của TỪNG ngày (tối đa 31 ngày)' },
      }, required: ['tu_ngay', 'den_ngay'], additionalProperties: false },
    },
    {
      name: 'anh_lich',
      description: 'GỬI NGAY ẢNH lịch làm việc 7 ngày (đúng mẫu ảnh lịch của app: bảng nhân viên × ngày, ô màu từng ca, OFF). Mặc định tuần hiện tại (từ thứ Hai). cua_toi = lịch của CHÍNH người hỏi (mọi chi nhánh); không thì lịch cả chi nhánh. Ảnh tự gửi thành tin riêng — em chỉ trả lời một câu ngắn, không chép lại lịch. Muốn xem lịch dạng chữ / tra ai làm ca nào thì dùng tra_cuu loai lich.',
      input_schema: { type: 'object', properties: {
        chi_nhanh: { type: 'string', description: 'Mã chi nhánh (id) khi xem lịch cả chi nhánh' },
        cua_toi: { type: 'boolean' },
        tu_ngay: { type: 'string', description: 'YYYY-MM-DD ngày bắt đầu (bỏ trống = thứ Hai tuần này; "tuần sau" = thứ Hai tuần sau)' },
      }, additionalProperties: false },
    },
    {
      name: 'ban_theo_mon',
      description: 'Số lượng bán và doanh thu theo MÓN (từ KiotViet) trong khoảng ngày: món bán chạy nhất, một món cụ thể bán bao nhiêu, theo nhóm món. Chỉ người xem được trang Xuất bán trong app.',
      input_schema: { type: 'object', properties: {
        tu_ngay: { type: 'string', description: 'YYYY-MM-DD' }, den_ngay: { type: 'string', description: 'YYYY-MM-DD, tối đa 62 ngày' }, chi_nhanh: brArr,
        tim_mon: { type: 'string', description: 'Lọc theo tên / mã món (gõ tắt được)' },
        xep_theo: { type: 'string', enum: ['so_luong', 'doanh_thu', 'ban_cham'], description: 'ban_cham = món bán ÍT nhất trước (có bán trong kỳ)' },
        gioi_han: { type: 'integer', minimum: 1, maximum: 40, description: 'Số món trả về (mặc định 15)' },
      }, required: ['tu_ngay', 'den_ngay'], additionalProperties: false },
    },
    {
      name: 'ghi_chi_phi',
      description: 'GHI MỘT KHOẢN CHI PHÍ vào P&L của app (chỉ ADMIN). Gọi NGAY khi chủ nhắn kiểu "chi 60tr tiền lương", "tiền điện 3tr2", "trả tiền nhà 25 triệu chi nhánh 1". KHÔNG tự chọn nhóm: máy chủ tự gửi danh sách nhóm chi phí đánh số 1, 2, 3... để chủ chọn, chủ nhắn số là ghi luôn. Chỉ truyền nhom_goi_y nếu đoán được (vd lương -> Lương nhân công). Nhiều chi nhánh mà chủ không nói chi nhánh nào thì hỏi lại: một chi nhánh hay chia đều.',
      input_schema: { type: 'object', properties: {
        noi_dung: { type: 'string', description: 'Nội dung khoản chi, vd "Tiền lương tháng 11"' },
        so_tien: { type: 'number', description: 'Số tiền (đồng). "60tr" = 60000000, "3tr2" = 3200000, "500k" = 500000' },
        chi_nhanh: { type: 'string', description: 'Mã chi nhánh (id) gánh khoản này' },
        chia_deu: { type: 'boolean', description: 'Chia đều cho mọi chi nhánh đang mở' },
        ngay: { type: 'string', description: 'YYYY-MM-DD ngày ghi nhận (quyết định tháng P&L). Bỏ trống = hôm nay. "lương tháng 10" thì để ngày cuối tháng 10.' },
        nhom_goi_y: { type: 'string', description: 'Tên nhóm chi phí đoán được (để đánh dấu gợi ý)' },
      }, required: ['noi_dung', 'so_tien'], additionalProperties: false },
    },
    {
      name: 'pnl_thang',
      description: 'P&L (lãi lỗ) một tháng đúng như trang P&L của app: doanh thu (sổ quỹ), giá vốn (định mức hoặc thực tế theo cài đặt), lợi nhuận gộp, chi phí theo nhóm, lợi nhuận, biên lãi — tổng và từng chi nhánh; kèm chênh lệch giá vốn định mức vs thực tế nếu có bản chốt tồn. Chỉ người xem được trang P&L.',
      input_schema: { type: 'object', properties: { thang: { type: 'string', description: 'YYYY-MM; bỏ trống = tháng này' }, chi_nhanh: brArr }, additionalProperties: false },
    },
    {
      name: 'phan_tich_doanh_thu',
      description: 'PHÂN TÍCH doanh thu một khoảng ngày SO VỚI kỳ so sánh (mặc định kỳ liền trước cùng độ dài; tuan_truoc = cùng ngày tuần trước): tổng, số hoá đơn, giá trị TB/hoá đơn, theo nguồn đơn, theo KHUNG GIỜ (giờ cao điểm), theo thứ trong tuần, và các MÓN tăng / giảm mạnh nhất. Dùng cho câu hỏi "vì sao doanh thu tụt / tăng", "giờ nào đông nhất", "so với tuần trước thế nào".',
      input_schema: { type: 'object', properties: {
        tu_ngay: { type: 'string', description: 'YYYY-MM-DD' }, den_ngay: { type: 'string', description: 'YYYY-MM-DD, tối đa 31 ngày' }, chi_nhanh: brArr,
        so_voi: { type: 'string', enum: ['ky_truoc', 'tuan_truoc'] },
      }, required: ['tu_ngay', 'den_ngay'], additionalProperties: false },
    },
    {
      name: 'tien_do_target',
      description: 'Tiến độ TARGET doanh thu tháng từng chi nhánh: target, đã đạt, %, % tháng đã qua, dự phóng cuối tháng theo nhịp hiện tại, mỗi ngày còn lại cần bao nhiêu.',
      input_schema: { type: 'object', properties: { thang: { type: 'string', description: 'YYYY-MM; bỏ trống = tháng này' }, chi_nhanh: brArr }, additionalProperties: false },
    },
    {
      name: 'du_bao_kho',
      description: 'DỰ BÁO HẾT NGUYÊN LIỆU một chi nhánh — tính đúng như trang Nhập-Xuất-Tồn của app: tồn hiện tại (chốt tồn gần nhất + nhập mua + nhập bổ sung - bán quy định mức - huỷ ± điều chuyển), lượng dùng trung bình / ngày, còn đủ dùng bao nhiêu ngày, gợi ý lượng cần mua cho N ngày. Có hàng sắp hết thì gợi ý người dùng lập đề xuất mua (soan_de_xuat_mua).',
      input_schema: { type: 'object', properties: {
        chi_nhanh: { type: 'string', description: 'Mã chi nhánh (id)' },
        nguong_ngay: { type: 'number', description: 'Chỉ liệt kê hàng đủ dùng dưới số ngày này (mặc định 5)' },
        mua_du_ngay: { type: 'number', description: 'Gợi ý lượng mua đủ dùng bao nhiêu ngày (mặc định 7)' },
        tim: { type: 'string', description: 'Lọc theo tên / mã nguyên liệu (bỏ ngưỡng ngày)' },
      }, required: ['chi_nhanh'], additionalProperties: false },
    },
    {
      name: 'tim_nguoi_trong',
      description: 'TÌM NGƯỜI THAY CA / người rảnh: một ngày, (một ca), một chi nhánh — liệt kê nhân viên còn làm của chi nhánh CHƯA có lịch ngày đó (hoặc chưa trùng ca đó), ưu tiên người đã ĐĂNG KÝ rảnh ca đó, kèm số ca đã xếp trong tuần.',
      input_schema: { type: 'object', properties: {
        ngay: { type: 'string', description: 'YYYY-MM-DD' }, ca: { type: 'string', description: 'Mã / tên ca (bỏ trống = cả ngày)' }, chi_nhanh: { type: 'string', description: 'Mã chi nhánh (id)' },
      }, required: ['ngay', 'chi_nhanh'], additionalProperties: false },
    },
    {
      name: 'cong_cua_toi',
      description: 'Tổng kết CÔNG của CHÍNH người hỏi trong một tháng: số ca, tổng giờ, số lần / số phút đi trễ, ca quên chấm ra. Không có tiền lương.',
      input_schema: { type: 'object', properties: { thang: { type: 'string', description: 'YYYY-MM; bỏ trống = tháng này' } }, additionalProperties: false },
    },
    {
      name: 'cong_thuc',
      description: 'Tra CÔNG THỨC pha chế / món trong app: nguyên liệu + định lượng, các bước làm, size, giá. Dùng khi nhân viên hỏi "pha X thế nào", "X gồm những gì".',
      input_schema: { type: 'object', properties: { ten: { type: 'string', description: 'Tên món (gõ tắt được)' } }, required: ['ten'], additionalProperties: false },
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
      name: 'soan_phieu_kho',
      description: 'SOẠN NHÁP một phiếu kho (chưa ghi): huy = xuất HUỶ hàng hỏng / hết hạn / đổ vỡ (BẮT BUỘC có ảnh — ảnh người dùng gửi trong 10 phút gần nhất tự đính kèm; chưa có ảnh thì bảo người dùng gửi ảnh rồi nhắn lại); nhap = NHẬP BỔ SUNG hàng đã về kho mà không có phiếu mua (hàng biếu, NCC giao bù...). Mã hàng khớp theo danh sách hàng kho của chi nhánh. Nhắn OK -> tạo phiếu chờ quản lý duyệt (người lập có quyền duyệt thì phiếu nhập ghi luôn như trong app). Duyệt xong mới trừ / cộng tồn.',
      input_schema: { type: 'object', properties: {
        loai: { type: 'string', enum: ['huy', 'nhap'] },
        chi_nhanh: { type: 'string', description: 'Mã chi nhánh (id)' },
        hang: { type: 'array', minItems: 1, maxItems: 30, items: { type: 'object', properties: {
          ten: { type: 'string', description: 'Tên hoặc mã hàng' }, so_luong: { type: 'number' }, ghi_chu: { type: 'string' },
        }, required: ['ten', 'so_luong'], additionalProperties: false } },
        ly_do: { type: 'string', description: 'Lý do huỷ / nguồn hàng nhập — bắt buộc' },
      }, required: ['loai', 'chi_nhanh', 'hang', 'ly_do'], additionalProperties: false },
    },
    {
      name: 'soan_de_nghi_chi',
      description: 'SOẠN NHÁP một ĐỀ NGHỊ THANH TOÁN chi phí (chưa gửi) — cách app ghi một khoản chi cần duyệt: nội dung, số tiền, chi nhánh gánh chi phí, lý do. Nhắn OK -> tạo phiếu và chạy đúng chuỗi duyệt của app (theo mức tiền); duyệt / chi tiền làm trong app. Chuỗi duyệt có bước người gửi tự chọn cấp duyệt mà có nhiều người thì hỏi người dùng chọn rồi truyền nguoi_duyet.',
      input_schema: { type: 'object', properties: {
        chi_nhanh: { type: 'string', description: 'Mã chi nhánh (id) gánh chi phí' },
        noi_dung: { type: 'string', description: 'Nội dung chi, vd "Tiền điện tháng 11", "Sửa máy pha"' },
        so_tien: { type: 'number', description: 'Số tiền (đồng)' },
        ly_do: { type: 'string' },
        can_truoc: { type: 'string', description: 'YYYY-MM-DD cần chi trước ngày (bỏ trống = 3 ngày nữa)' },
        nguoi_duyet: { type: 'string', description: 'Tên cấp duyệt người dùng chọn (chỉ khi được hỏi)' },
      }, required: ['chi_nhanh', 'noi_dung', 'so_tien'], additionalProperties: false },
    },
    {
      name: 'soan_duyet',
      description: 'SOẠN NHÁP duyệt hoặc từ chối MỘT việc lấy từ viec_cho_duyet (chưa ghi): đề xuất mua, đơn công, phiếu kho (huỷ / nhập bổ sung). Người dùng phải nhắn OK thì mới ghi thật. Từ chối bắt buộc có lý do. Đề nghị thanh toán thì duyệt trong app.',
      input_schema: { type: 'object', properties: {
        loai: { type: 'string', enum: ['de_xuat_mua', 'cong_bo_sung', 'phieu_kho'] }, id: { type: 'string' },
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
    const snap = await db.collection(COL.rev).where('date', '>=', from).where('date', '<=', to).select('branchId', 'date', 'amount', 'invoices', 'cash', 'bank', 'wallet', 'at', 'ch', 'chN', 'chL').get();
    const by = {};
    p.ids.forEach(id => { by[id] = { chi_nhanh: bName(c.cfg, id), doanh_thu: 0, so_hoa_don: 0, tien_mat: 0, chuyen_khoan: 0, vi_dien_tu: 0, so_ngay_co_so: 0 }; });
    let lastAt = '';
    /* Nguồn đơn: cộng ch (tiền) / chN (số đơn) theo khoá; ngày chưa có nguồn thì dồn vào "Chưa rõ nguồn" */
    const src = {}, daily = {};
    const addSrc = (m, k, lbl, amt, n) => { const o = m[k] || (m[k] = { nguon: lbl, tien: 0, so_don: 0 }); o.tien += amt; o.so_don += n; };
    snap.docs.forEach(d => {
      const v = d.data() || {};
      const r = by[v.branchId];
      if (!r) return;
      const dd = daily[v.date] || (daily[v.date] = { ngay: v.date, doanh_thu: 0, so_hoa_don: 0, nguon: {} });
      dd.doanh_thu += Number(v.amount) || 0; dd.so_hoa_don += Number(v.invoices) || 0;
      const ch = v.ch && typeof v.ch === 'object' ? v.ch : null;
      if (ch && Object.keys(ch).length) {
        Object.entries(ch).forEach(([k, amt]) => {
          const lbl = REV_CH[k] || ((v.chL || {})[k]) || (k.startsWith('o_') ? k.slice(2) : k);
          const n = Number((v.chN || {})[k]) || 0;
          addSrc(src, lbl, lbl, Number(amt) || 0, n); addSrc(dd.nguon, lbl, lbl, Number(amt) || 0, n);
        });
      } else if (Number(v.amount)) { addSrc(src, REV_CH.na, REV_CH.na, Number(v.amount) || 0, Number(v.invoices) || 0); addSrc(dd.nguon, REV_CH.na, REV_CH.na, Number(v.amount) || 0, Number(v.invoices) || 0); }
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
    const tong = rows.reduce((x, r) => x + r.doanh_thu, 0);
    const srcList = (m, base) => Object.values(m).sort((x, y) => y.tien - x.tien).map(x => ({ ...x, ti_trong: base > 0 ? Math.round(x.tien / base * 1000) / 10 + '%' : '' }));
    return {
      tu_ngay: from, den_ngay: to, don_vi: 'đồng', chi_nhanh: rows,
      tong, theo_nguon: srcList(src, tong),
      ...(a.theo_ngay ? { tung_ngay: Object.values(daily).sort((x, y) => x.ngay.localeCompare(y.ngay)).slice(-31).map(x => ({ ...x, nguon: srcList(x.nguon, x.doanh_thu) })) } : {}),
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
        if (isOptionItem(it.name)) return;      /* đá / đường / % ... không phải món */
        const o = agg[code] || (agg[code] = { ma: code, mon: it.name || code, nhom: it.group || '', don_vi: it.unit || '', so_luong: 0, doanh_thu: 0 });
        o.so_luong += q; o.doanh_thu += m;
      });
    });
    let list = Object.values(agg);
    if (a.tim_mon) { const k = strip(a.tim_mon); list = list.filter(x => strip(x.mon + ' ' + x.ma + ' ' + x.nhom).includes(k)); }
    const key = a.xep_theo === 'doanh_thu' ? 'doanh_thu' : 'so_luong';
    if (a.xep_theo === 'ban_cham') list.sort((x, y) => x.so_luong - y.so_luong); else list.sort((x, y) => y[key] - x[key]);
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
    if (c.R.canStkMoveAppr(c.me)) {
      const qm = await db.collection(COL.mv).where('status', '==', 'wait').get();
      qm.docs.map(d => ({ ...(d.data() || {}), id: d.id })).filter(m => ['dispose', 'adjin'].includes(m.kind) && c.R.inScope(c.me, m.branchId)).forEach(m => out.push({
        loai: 'phieu_kho', id: m.id, ma: m.code || m.id, kieu: MV_LABEL[m.kind], chi_nhanh: bName(c.cfg, m.branchId), nguoi_lap: m.byName || '',
        ly_do: clip(m.reason || '', 100), hang: (m.items || []).slice(0, 5).map(it => (it.name || it.code || '') + ' x' + (Number(it.qty) || 0) + (it.unit ? ' ' + it.unit : '')).join('; '),
        so_anh: (m.photos || []).length,
      }));
    }
    /* Đề xuất / đề nghị thanh toán đang chờ CHÍNH người hỏi duyệt — duyệt trong app (bước chốt giá, chi tiền) */
    const qr = await db.collection(COL.req).where('status', '==', 'OPEN').get();
    qr.docs.map(d => ({ ...(d.data() || {}), id: d.id })).filter(r => { try { return c.R.canStep(c.cfg, c.me, r); } catch (e) { return false; } }).forEach(r => out.push({
      loai: 'de_nghi', id: r.id, kieu: (c.R.tOf(c.cfg, r.type) || {}).l || r.type, noi_dung: clip(r.title || '', 100), so_tien: c.R.reqAmountRaw(r) || undefined,
      chi_nhanh: bName(c.cfg, r.branchId), duyet_qua_bot_duoc: false, link: appUrl(c.cfg) + '#requests',
    }));
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


  /* ===== Ghi chi phí (chủ) -> hỏi nhóm 1..N -> chủ nhắn số là ghi (zalo.js xử lý số) ===== */
  async function ghi_chi_phi(c, a) {
    if (c.me.role !== 'ADMIN') return err('Chỉ ADMIN được ghi chi phí thẳng vào P&L qua bot. Người khác lập Đề nghị thanh toán (soan_de_nghi_chi) để chờ duyệt.');
    const amount = Math.round(Number(a.so_tien) || 0);
    if (!(amount > 0)) return err('Số tiền phải lớn hơn 0.');
    const desc = clip(String(a.noi_dung || '').trim(), 140);
    if (!desc) return err('Thiếu nội dung khoản chi.');
    const open = c.R.bizList(c.cfg).filter(b => b.status !== 'closed').map(b => b.id);
    let alloc;
    if (a.chi_nhanh) {
      const p = pickBranches(c.cfg, open, [a.chi_nhanh]);
      if (p.ids.length !== 1) return { ...err('Không rõ chi nhánh.'), ...brNote(c, p), cac_chi_nhanh: open.map(id => bName(c.cfg, id)) };
      alloc = [{ branchId: p.ids[0], amount }];
    } else if (open.length === 1) alloc = [{ branchId: open[0], amount }];
    else if (a.chia_deu) {
      const per = Math.round(amount / open.length);
      alloc = open.map((b, i) => ({ branchId: b, amount: i === open.length - 1 ? amount - per * (open.length - 1) : per }));
    } else return { loi: 'Có nhiều chi nhánh — hỏi chủ: khoản này của chi nhánh nào, hay chia đều?', cac_chi_nhanh: open.map(id => bName(c.cfg, id)) };
    const day = a.ngay && isDay(a.ngay) ? a.ngay : H.dayVN(now());
    const menu = c.R.pnlMenu(c.cfg);
    if (!menu.length) return err('Chưa khai mã chi phí — vào Cấu hình › Danh mục chi phí.');
    const hint = a.nhom_goi_y ? menu.findIndex(m => strip(m.name).includes(strip(a.nhom_goi_y)) || strip(a.nhom_goi_y).includes(strip(m.name).split(' ')[0])) : -1;
    await setPend(c, { kind: 'costPick', data: { desc, amount, date: day, alloc }, opts: menu.map(m => m.id), hint });
    return { da_soan: true, cho_chon_nhom: true, khoan_chi: { noi_dung: desc, so_tien: amount, chi_nhanh: alloc.map(x => bName(c.cfg, x.branchId)).join(', '), ky: c.R.moLbl(day.slice(0, 7)) },
      ghi_chu: 'Máy chủ tự gửi danh sách nhóm đánh số ngay sau câu của em. Em chỉ viết MỘT câu ngắn xác nhận khoản chi (số tiền, nội dung, chi nhánh, kỳ), KHÔNG liệt kê nhóm, KHÔNG hỏi gì thêm.' };
  }
  const costMenuText = (cfg, pend) => {
    const R = appRules(cfg);
    const ids = pend.opts || [];
    const d = pend.data || {};
    /* Kỳ ghi in CỐ ĐỊNH ở đầu danh sách (không nhờ AI nói) — chủ thấy sai tháng thì nhắn T10 để đổi */
    return 'Khoản chi ' + Number(d.amount || 0).toLocaleString('vi-VN') + 'đ "' + (d.desc || '') + '" — ghi vào P&L ' + R.moLbl(String(d.date || '').slice(0, 7))
      + ' (sai tháng thì nhắn T + số tháng, vd T10).\nChi vào nhóm nào?\n' + ids.map((id, i) => (i + 1) + '. ' + R.catOf(cfg, id).name + (i === pend.hint ? ' (gợi ý)' : '')).join('\n');
  };

  async function pnl_thang(c, a) {
    if (!pagesOf(c).includes('pnl')) return err('Vai trò của người hỏi không xem được trang P&L trong app.');
    const today = H.dayVN(now());
    const mo = a.thang && /^\d{4}-\d{2}$/.test(a.thang) ? a.thang : today.slice(0, 7);
    const p = pickBranches(c.cfg, bizMine(c), a.chi_nhanh);
    if (!p.ids.length) return { ...err('Không có chi nhánh nào được xem.'), ...brNote(c, p) };
    const r = await loadPnl(db, c.R, c.cfg, mo, p.ids, today);
    const pct = (x) => (r.rev.total ? Math.round(x / r.rev.total * 1000) / 10 + '%' : '');
    return {
      thang: mo, den_ngay: r.to, gia_von_theo: r.mode === 'tt' ? 'thực tế (tồn đầu + nhập hàng − tồn cuối)' : 'định mức (bán × giá vốn công thức)',
      doanh_thu: r.rev.total, gia_von: r.cogs.total, gia_von_pct: pct(r.cogs.total), loi_nhuan_gop: r.gross, bien_gop: pct(r.gross),
      chi_phi_theo_nhom: r.costs.filter(g => g.total).map(g => ({ nhom: g.name, tien: g.total, pct: pct(g.total) })),
      tong_chi_phi: r.cost.total, loi_nhuan: r.profit, bien_lai: pct(r.profit),
      tung_chi_nhanh: p.ids.length > 1 ? p.ids.map(b => ({ chi_nhanh: bName(c.cfg, b), doanh_thu: r.rev.by[b], gia_von: r.cogs.by[b], chi_phi: r.cost.by[b], loi_nhuan: (r.rev.by[b] || 0) - (r.cogs.by[b] || 0) - (r.cost.by[b] || 0) })) : undefined,
      ...(r.mode === 'tt' && !r.cogs.ok ? { canh_bao: 'Có chi nhánh thiếu bản chốt tồn đầu / cuối kỳ nên giá vốn thực tế chưa đủ — vào Kho chốt tồn.' } : {}),
      ...(r.mode === 'dm' && r.cogs.noCost ? { canh_bao: r.cogs.noCost + ' món bán ra chưa có giá vốn định mức (chưa khai công thức).' } : {}),
      so_sanh_gia_von: r.tt.ok ? { dinh_muc: Math.round(r.dmTotal), thuc_te: Math.round(r.tt.total), chenh: Math.round(r.tt.total - r.dmTotal), hao_hut_nhieu_nhat: r.cmpTop.map(x => x.name + ' ' + Math.round(x.value).toLocaleString('vi-VN') + 'đ') } : undefined,
    };
  }

  /* ===== Phân tích doanh thu: kỳ này so với kỳ so sánh ===== */
  async function phan_tich_doanh_thu(c, a) {
    if (!pagesOf(c).includes('revenue')) return err('Vai trò của người hỏi không được xem Doanh thu trong app.');
    const from = String(a.tu_ngay || ''), to = String(a.den_ngay || '');
    if (!isDay(from) || !isDay(to) || to < from) return err('Ngày không hợp lệ.');
    const n = Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1;
    if (n > 31) return err('Tối đa 31 ngày mỗi lần phân tích.');
    const shift = a.so_voi === 'tuan_truoc' ? -7 : -n;
    const f2 = H.dAdd(from, shift), t2 = H.dAdd(to, shift);
    const p = pickBranches(c.cfg, bizMine(c), a.chi_nhanh);
    if (!p.ids.length) return { ...err('Không có chi nhánh nào được xem.'), ...brNote(c, p) };
    const load = async (x, y) => (await db.collection(COL.rev).where('date', '>=', x).where('date', '<=', y).get()).docs.map(d => d.data() || {}).filter(v => p.ids.includes(v.branchId));
    const [cur, cmp] = await Promise.all([load(from, to), load(f2, t2)]);
    const WDN = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
    const agg = (docs) => {
      const o = { tong: 0, hoa_don: 0, nguon: {}, gio: {}, thu: {} };
      docs.forEach(v => {
        o.tong += Number(v.amount) || 0; o.hoa_don += Number(v.invoices) || 0;
        const ch = v.ch && Object.keys(v.ch).length ? v.ch : { na: Number(v.amount) || 0 };
        Object.entries(ch).forEach(([k, x]) => { const l = REV_CH[k] || ((v.chL || {})[k]) || k.replace(/^o_/, ''); o.nguon[l] = (o.nguon[l] || 0) + (Number(x) || 0); });
        (v.lines || []).forEach(l => { const h = Math.floor((Number(l.t) || 0) / 60); o.gio[h] = (o.gio[h] || 0) + (Number(l.a) || 0); });
        const w = WDN[new Date(v.date + 'T00:00:00Z').getUTCDay()]; o.thu[w] = (o.thu[w] || 0) + (Number(v.amount) || 0);
      });
      return o;
    };
    const A = agg(cur), B = agg(cmp);
    const pct = (x, y) => (y > 0 ? Math.round((x - y) / y * 1000) / 10 : null);
    const keys = (o1, o2) => [...new Set([...Object.keys(o1), ...Object.keys(o2)])];
    /* Món tăng / giảm: ops_sales theo tháng, cộng theo ngày trong từng kỳ */
    const months = [...new Set([...monthsIn(from, to), ...monthsIn(f2, t2)])];
    const sd = (await db.getAll(...p.ids.flatMap(b => months.map(m => db.collection(COL.sales).doc(b + '_' + m))))).filter(x => x.exists).map(x => x.data() || {});
    const qty = (x, y) => { const o = {}; sd.forEach(d => Object.entries(d.items || {}).forEach(([code, it]) => { if (isOptionItem(it.name)) return; let q = 0; Object.entries(it.d || {}).forEach(([dd, v]) => { if (dd >= x && dd <= y) q += Number(v) || 0; }); if (q) { const r = o[code] || (o[code] = { mon: it.name || code, q: 0 }); r.q += q; } })); return o; };
    const qa = qty(from, to), qb = qty(f2, t2);
    const diff = keys(qa, qb).map(k => ({ mon: (qa[k] || qb[k]).mon, ky_nay: Math.round((qa[k] || {}).q || 0), ky_truoc: Math.round((qb[k] || {}).q || 0) })).map(x => ({ ...x, chenh: x.ky_nay - x.ky_truoc }));
    return {
      ky_nay: { tu: from, den: to, doanh_thu: A.tong, hoa_don: A.hoa_don, tb_hoa_don: A.hoa_don ? Math.round(A.tong / A.hoa_don) : 0 },
      ky_so_sanh: { tu: f2, den: t2, doanh_thu: B.tong, hoa_don: B.hoa_don, tb_hoa_don: B.hoa_don ? Math.round(B.tong / B.hoa_don) : 0 },
      chenh_lech_pct: pct(A.tong, B.tong), chenh_hoa_don_pct: pct(A.hoa_don, B.hoa_don),
      theo_nguon: keys(A.nguon, B.nguon).map(k => ({ nguon: k, ky_nay: A.nguon[k] || 0, ky_truoc: B.nguon[k] || 0, pct: pct(A.nguon[k] || 0, B.nguon[k] || 0) })).sort((x, y) => y.ky_nay - x.ky_nay),
      theo_gio: Object.keys(A.gio).length ? keys(A.gio, B.gio).map(Number).sort((x, y) => x - y).map(h => ({ gio: String(h).padStart(2, '0') + 'h', ky_nay: A.gio[h] || 0, ky_truoc: B.gio[h] || 0 })) : undefined,
      theo_thu: n >= 7 ? WDN.filter(w => A.thu[w] || B.thu[w]).map(w => ({ thu: w, ky_nay: A.thu[w] || 0, ky_truoc: B.thu[w] || 0 })) : undefined,
      mon_tang_manh: diff.filter(x => x.chenh > 0).sort((x, y) => y.chenh - x.chenh).slice(0, 6),
      mon_giam_manh: diff.filter(x => x.chenh < 0).sort((x, y) => x.chenh - y.chenh).slice(0, 6),
      ...brNote(c, p),
    };
  }

  async function tien_do_target(c, a) {
    if (!pagesOf(c).includes('revenue')) return err('Vai trò của người hỏi không được xem Doanh thu trong app.');
    const today = H.dayVN(now());
    const ym = a.thang && /^\d{4}-\d{2}$/.test(a.thang) ? a.thang : today.slice(0, 7);
    const p = pickBranches(c.cfg, bizMine(c), a.chi_nhanh);
    if (!p.ids.length) return { ...err('Không có chi nhánh nào được xem.'), ...brNote(c, p) };
    const dim = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
    const end = ym === today.slice(0, 7) ? today : ym + '-' + String(dim).padStart(2, '0');
    const passed = Number(end.slice(8, 10)), left = dim - passed + (ym === today.slice(0, 7) ? 1 : 0);
    const [tg, rv] = await Promise.all([
      db.getAll(...p.ids.map(b => db.collection('ops_targets').doc(b + '_' + ym))),
      db.collection(COL.rev).where('date', '>=', ym + '-01').where('date', '<=', end).select('branchId', 'amount', 'date').get(),
    ]);
    const got = {}; let todayAmt = {};
    rv.docs.forEach(d => { const v = d.data() || {}; got[v.branchId] = (got[v.branchId] || 0) + (Number(v.amount) || 0); if (v.date === today) todayAmt[v.branchId] = Number(v.amount) || 0; });
    const rows = p.ids.map((b, i) => {
      const target = tg[i].exists ? Number((tg[i].data() || {}).amount) || 0 : 0;
      const done = got[b] || 0;
      const doneBefore = done - (todayAmt[b] || 0);
      const pace = passed > 1 ? doneBefore / (passed - 1) : done;
      return {
        chi_nhanh: bName(c.cfg, b), target, da_dat: done, pct: target ? Math.round(done / target * 1000) / 10 : null,
        du_phong_cuoi_thang: Math.round(doneBefore + pace * (dim - passed + 1)),
        moi_ngay_con_lai_can: target && left > 0 ? Math.max(0, Math.round((target - done) / left)) : undefined,
        chua_dat_target: !target || undefined,
      };
    });
    return { thang: ym, so_ngay_thang: dim, da_qua_pct: Math.round(passed / dim * 1000) / 10, so_ngay_con_lai: left, chi_nhanh: rows, ...brNote(c, p) };
  }

  async function du_bao_kho(c, a) {
    const pages = pagesOf(c);
    if (!pages.includes('nxt') && !pages.includes('stock')) return err('Vai trò của người hỏi không xem được kho trong app.');
    const p = pickBranches(c.cfg, bizMine(c), [a.chi_nhanh]);
    if (p.ids.length !== 1) return { ...err('Chọn MỘT chi nhánh.'), ...brNote(c, p) };
    const bid = p.ids[0], today = H.dayVN(now());
    /* Kỳ: đầu tháng -> hôm nay (giống mặc định trang Nhập-Xuất-Tồn); đầu tháng ít ngày quá thì lấy 14 ngày gần nhất */
    let from = today.slice(0, 7) + '-01';
    if (Number(today.slice(8, 10)) < 7) from = H.dAdd(today, -13);
    const [stQ, poQ, mvA, mvB, rcQ] = await Promise.all([
      db.collection('ops_stock').where('branchId', '==', bid).get(), db.collection('ops_po').get(),
      db.collection(COL.mv).where('branchId', '==', bid).get(), db.collection(COL.mv).where('toBranchId', '==', bid).get(), db.collection('ops_recipes').get(),
    ]);
    const stocks = {}; stQ.docs.forEach(d => { stocks[d.id] = { ...(d.data() || {}), id: d.id }; });
    const months = [...new Set([...monthsIn(from, today), ...Object.values(stocks).map(x => String(x.date || '').slice(0, 7)).filter(Boolean).sort().slice(-1)])];
    const sales = {};
    (await db.getAll(...months.map(m => db.collection(COL.sales).doc(bid + '_' + m)))).forEach(x => { if (x.exists) sales[x.id] = x.data() || {}; });
    const moves = [...mvA.docs, ...mvB.docs].map(d => ({ ...(d.data() || {}), id: d.id }));
    const R = c.R;
    const out = R.nxtBuild({ cfg: c.cfg, stocks, pos: poQ.docs.map(d => ({ ...(d.data() || {}), id: d.id })), sales, moves, recipes: rcQ.docs.map(d => ({ ...(d.data() || {}), id: d.id })), bid, from, to: today });
    const lim = Number(a.nguong_ngay) > 0 ? Number(a.nguong_ngay) : 5, buy = Number(a.mua_du_ngay) > 0 ? Number(a.mua_du_ngay) : 7;
    const r2 = (x) => Math.round(x * 100) / 100;
    let rows = out.rows.filter(r => r.moved || r.close);
    if (a.tim) { const k = strip(a.tim); rows = rows.filter(r => strip(r.name + ' ' + r.code).includes(k)); }
    else rows = rows.filter(r => r.daysLeft != null && r.daysLeft < lim);
    rows.sort((x, y) => (x.daysLeft == null ? 1e9 : x.daysLeft) - (y.daysLeft == null ? 1e9 : y.daysLeft));
    return {
      chi_nhanh: bName(c.cfg, bid), ky_tinh: from + ' → ' + today, so_ngay_ky: out.days,
      ton_dau_tu_chot: out.anchor ? out.anchor.date : 'chưa từng chốt tồn — tồn chỉ là biến động trong kỳ, có thể âm',
      hang: rows.slice(0, 25).map(r => {
        const per = r.sold / out.days;
        return { ma: r.code, ten: r.name, don_vi: r.unit, ton: r2(r.close), dung_tb_ngay: r2(per), du_dung_ngay: r.daysLeft == null ? null : Math.round(r.daysLeft * 10) / 10,
          goi_y_mua: per > 0 ? Math.max(0, Math.ceil(per * buy - Math.max(0, r.close))) : 0, nhom: r.group || undefined };
      }),
      ...(rows.length > 25 ? { bi_cat: rows.length - 25 } : {}),
      mon_chua_co_dinh_muc: (out.soldNoBom || []).slice(0, 8).map(x => x.name || x.code),
    };
  }

  async function tim_nguoi_trong(c, a) {
    const pages = pagesOf(c);
    if (!pages.includes('schedule') && !pages.includes('shifts')) return err('Vai trò của người hỏi không xem được lịch làm việc.');
    const day = String(a.ngay || '');
    if (!isDay(day)) return err('Ngày không hợp lệ.');
    const p = pickBranches(c.cfg, bizMine(c), [a.chi_nhanh]);
    if (p.ids.length !== 1) return { ...err('Chọn MỘT chi nhánh.'), ...brNote(c, p) };
    const bid = p.ids[0];
    const shifts = c.cfg.shifts || [];
    const sh = a.ca ? shifts.find(s => strip(s.id) === strip(a.ca) || strip(s.code) === strip(a.ca) || strip(s.name).includes(strip(a.ca))) : null;
    if (a.ca && !sh) return { loi: 'Không có ca "' + a.ca + '".', cac_ca: shifts.map(s => (s.code || s.id) + ' ' + s.name + ' ' + s.start + '-' + s.end) };
    const wd = new Date(day + 'T00:00:00Z').getUTCDay(), mon = H.dAdd(day, -((wd + 6) % 7)), sun = H.dAdd(mon, 6);
    const [eq, sq, rq] = await Promise.all([
      db.collection(COL.emp).get(), db.collection(COL.sch).where('date', '>=', mon).where('date', '<=', sun).get(), db.collection('ops_shiftreg').where('date', '==', day).get(),
    ]);
    const busy = new Set(), week = {};
    /* busy: "id" = đã có lịch trùng (cùng ca, hoặc bất kỳ ca nào khi hỏi cả ngày); "id|other" = có ca khác cùng ngày */
    sq.docs.forEach(d => { const v = d.data() || {}; (v.empIds || []).forEach(id => {
      week[id] = (week[id] || 0) + 1;
      if (v.date !== day) return;
      if (!sh || v.shiftId === sh.id) busy.add(id); else busy.add(id + '|other');
    }); });
    const reg = {}; rq.docs.forEach(d => { const v = d.data() || {}; reg[v.empId] = v.shifts || (v.shiftId ? [v.shiftId] : []); });
    const list = eq.docs.map(d => ({ ...(d.data() || {}), id: d.id })).filter(e => e.status !== 'off' && (e.branches || []).includes(bid))
      .map(e => {
        const sameShift = busy.has(e.id), otherShift = busy.has(e.id + '|other');
        if (sameShift) return null;
        const r = reg[e.id] || [];
        return { ten: e.name, vai_tro: (c.R.roleOf(e.role) || {}).short || e.role, da_dang_ky_ca_nay: sh ? r.includes(sh.id) : r.length > 0, da_co_ca_khac_cung_ngay: otherShift || undefined, so_ca_tuan_nay: week[e.id] || 0 };
      }).filter(Boolean)
      .sort((x, y) => (y.da_dang_ky_ca_nay - x.da_dang_ky_ca_nay) || ((x.da_co_ca_khac_cung_ngay ? 1 : 0) - (y.da_co_ca_khac_cung_ngay ? 1 : 0)) || (x.so_ca_tuan_nay - y.so_ca_tuan_nay));
    return { ngay: day, ca: sh ? (sh.code || sh.id) + ' ' + sh.start + '-' + sh.end : 'cả ngày', chi_nhanh: bName(c.cfg, bid), ung_vien: list.slice(0, 15), ghi_chu: 'Xếp lịch trong app (Xếp lịch). Bot chưa sửa lịch được.' };
  }

  async function cong_cua_toi(c, a) {
    const ym = a.thang && /^\d{4}-\d{2}$/.test(a.thang) ? a.thang : H.dayVN(now()).slice(0, 7);
    const q = await db.collection('ops_attendance').where('empId', '==', c.me.id).get();
    const today = H.dayVN(now());
    const rows = q.docs.map(d => d.data() || {}).filter(v => String(v.date || '').slice(0, 7) === ym && v.inAt);
    const mins = rows.reduce((x, v) => x + (Number(v.mins) || 0), 0);
    const late = rows.filter(v => Number(v.late) > 0);
    return {
      thang: ym, so_ca: rows.length, tong_gio: Math.round(mins / 6) / 10,
      di_tre: { so_lan: late.length, tong_phut: late.reduce((x, v) => x + Number(v.late), 0), ngay: late.slice(0, 10).map(v => v.date.slice(8, 10) + '/' + v.date.slice(5, 7) + ' (' + v.late + 'p)') },
      quen_cham_ra: rows.filter(v => !v.outAt && v.date < today).map(v => v.date.slice(8, 10) + '/' + v.date.slice(5, 7)),
      ghi_chu: 'Không gồm tiền lương — xem phiếu lương trong app.',
    };
  }

  async function cong_thuc(c, a) {
    const k = strip(a.ten);
    if (!k) return err('Thiếu tên món.');
    const q = await db.collection('ops_recipes').get();
    const all = q.docs.map(d => ({ ...(d.data() || {}), id: d.id })).filter(r => r.name && !r.draft);
    let hit = all.filter(r => strip(r.name) === k);
    if (!hit.length) hit = all.filter(r => strip(r.name).includes(k) || k.includes(strip(r.name)));
    if (!hit.length) return { loi: 'Không tìm thấy công thức "' + a.ten + '".', goi_y: all.slice(0, 15).map(r => r.name) };
    if (hit.length > 3) return { nhieu_mon_khop: hit.slice(0, 12).map(r => r.name + (r.size ? ' (' + r.size + ')' : '')) };
    const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
    return { cong_thuc: hit.map(r => ({
      mon: r.name, size: r.size || undefined, gia: Number(r.price) || undefined, loai: r.kind === 'btp' ? 'bán thành phẩm' : (r.cat || undefined), mo_ta: r.desc ? clip(r.desc, 300) : undefined,
      nguyen_lieu: (r.items || []).map(i => (i.name || i.sku || '') + ': ' + r2(i.qty) + ' ' + (i.unit || '')),
      cac_buoc: (r.steps || []).map((s, i) => (i + 1) + '. ' + [s.label, s.note].filter(Boolean).join(' — ')).filter(x => x.length > 3),
      ...(r.kind === 'btp' && r.batch ? { me_nau: r2(r.batch.qty) + ' ' + (r.batch.unit || '') } : {}),
    })) };
  }

  /* ===== Ảnh lịch làm việc ===== */
  const mondayOf = (day) => { const wd = new Date(day + 'T00:00:00Z').getUTCDay(); return H.dAdd(day, -((wd + 6) % 7)); };
  async function sendSchedImage({ cfg, me, zaloId, chatId, personal, bid, from }) {
    if (typeof deps.uploadImage !== 'function' || typeof deps.sendPhoto !== 'function') return { loi: 'Máy chủ chưa bật gửi ảnh.' };
    const start = from && isDay(from) ? from : mondayOf(H.dayVN(now()));
    const days = Array.from({ length: 7 }, (_, i) => H.dAdd(start, i));
    const qs = await db.collection(COL.sch).where('date', '>=', days[0]).where('date', '<=', days[6]).get();
    const docs = qs.docs.map(d => d.data() || {});
    let opts;
    if (personal) opts = IMG.personWeek({ cfg, docs, emp: me, days });
    else {
      const es = await db.collection(COL.emp).get();
      const emps = {};
      es.docs.forEach(d => { const v = d.data() || {}; emps[d.id] = { id: d.id, name: v.name || d.id, branches: v.branches || [], status: v.status, posId: v.posId }; });
      opts = IMG.branchWeek({ cfg, docs, emps, bid, days });
    }
    const png = IMG.renderPng(IMG.weekSvg(opts));
    const url = await deps.uploadImage(png, 'lich/' + (personal ? 'nv_' + me.id : 'cn_' + bid) + '_' + start + '_' + now() + '.png');
    const caption = (personal ? 'Lịch làm việc của ' + (me.name || '') : 'Lịch làm việc ' + bName(cfg, bid)) + ', tuần ' + days[0].slice(8, 10) + '/' + days[0].slice(5, 7) + ' - ' + days[6].slice(8, 10) + '/' + days[6].slice(5, 7);
    const r = await deps.sendPhoto({ zaloId, chatId: chatId || zaloId, empId: me.id && !String(me.id).startsWith('grp_') ? me.id : '', url, caption });
    return r === 'sent' ? { da_gui: true, tuan_tu: days[0], ghi_chu: 'Ảnh đã gửi thành tin riêng ngay trên. Chỉ trả lời một câu ngắn, không chép lại lịch.' } : { loi: 'Gửi ảnh chưa được (' + r + ').' };
  }
  async function anh_lich(c, a) {
    const target = c.group || c.zaloId;
    if (a.cua_toi || !a.chi_nhanh && !c.group) {
      if (String(c.me.id).startsWith('grp_')) return err('Lịch của tôi cần người hỏi đã kết nối Zalo với app.');
      return sendSchedImage({ cfg: c.cfg, me: c.me, zaloId: c.zaloId, chatId: target, personal: true, from: a.tu_ngay });
    }
    const pages = pagesOf(c);
    if (!pages.includes('shifts') && !pages.includes('schedule')) return err('Vai trò của người hỏi không xem được lịch làm việc chi nhánh trong app.');
    /* Không nêu chi nhánh: chỉ một chi nhánh còn mở thì dùng luôn (chi nhánh đã đóng không tính) */
    const open = bizMine(c).filter(id => ((c.cfg.branches || []).find(b => b.id === id) || {}).status !== 'closed');
    const p = pickBranches(c.cfg, open, a.chi_nhanh ? [a.chi_nhanh] : []);
    if (p.ids.length !== 1) return { ...err(p.ids.length ? 'Chọn MỘT chi nhánh để xuất ảnh lịch.' : 'Không có chi nhánh nào được xem.'), chi_nhanh_duoc_xem: open.map(id => bName(c.cfg, id)), ...brNote(c, p) };
    try { return await sendSchedImage({ cfg: c.cfg, me: c.me, zaloId: c.zaloId, chatId: target, personal: false, bid: p.ids[0], from: a.tu_ngay }); }
    catch (e) { log.error('zalo: ảnh lịch lỗi', { err: String(e && e.message).slice(0, 200) }); return err('Chưa dựng / gửi được ảnh lịch (kiểm tra Firebase Storage đã bật chưa). Dùng tra_cuu loai lich để trả lời bằng chữ.'); }
  }

  /* ===== Khớp tên hàng người dùng gõ với danh sách mã (dùng chung đề xuất mua / phiếu kho) ===== */
  function matchItems(pool, hang) {
    const items = [], miss = [], many = [];
    (hang || []).slice(0, 30).forEach(h => {
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
    return { items, miss, many };
  }
  /* Ảnh gần nhất người dùng gửi -> link (Drive) hoặc ảnh nhúng nhỏ như app (data:, ~300KB) */
  async function photoLink(c, label, sub) {
    const ph = c.photo || null;
    if (!ph || !ph.url) return { url: '', note: '' };
    const up = await uploadDrive(c.cfg, ph, label, sub).catch(e => { log.warn('zalo: tải ảnh lên Drive lỗi', { err: String(e && e.message) }); return null; });
    if (up) return { url: up, note: '' };
    const img = ph.b64 ? ph : await fetchImage(ph.url);
    if (img && img.b64 && img.b64.length <= 300 * 1024) return { url: 'data:' + img.mime + ';base64,' + img.b64, note: '' };
    return { url: '', note: (c.cfg.drive || {}).gasUrl ? 'Không tải được ảnh lên Drive.' : 'Ảnh quá lớn để lưu trong app và chưa khai Google Drive (Cấu hình › Tệp & ảnh).' };
  }

  async function soan_phieu_kho(c, a) {
    const K = a.loai === 'nhap' ? 'adjin' : 'dispose';
    if (!c.R.canStkMove(c.me)) return err('Vai trò của người hỏi không được lập phiếu kho.');
    const p = pickBranches(c.cfg, bizMine(c), [a.chi_nhanh]);
    if (p.ids.length !== 1) return { ...err('Cần đúng một chi nhánh người hỏi phụ trách.'), ...brNote(c, p) };
    const bid = p.ids[0];
    const why = clip(String(a.ly_do || '').trim(), 500);
    if (!why) return err(K === 'dispose' ? 'Phiếu huỷ phải có lý do — hỏi người dùng.' : 'Ghi rõ nguồn hàng nhập (hàng biếu, NCC giao bù...) — hỏi người dùng.');
    const pool = c.R.stockItems(c.cfg, bid);
    if (!pool.length) return err('Chi nhánh này chưa khai danh sách hàng kho trong app (Kho › Thiết lập kho).');
    const m = matchItems(pool, a.hang);
    if (m.many.length || m.miss.length) {
      return { loi: 'Chưa soạn được — có món chưa khớp danh sách hàng kho của chi nhánh.', ...(m.many.length ? { khop_nhieu_ma: m.many } : {}), ...(m.miss.length ? { khong_co_trong_kho: m.miss } : {}), goi_y: 'Hỏi lại người dùng chọn đúng mã.' };
    }
    if (!m.items.length) return err('Chưa có món nào.');
    const code = (K === 'dispose' ? 'HUY-' : 'NBS-') + H.dayVN(now()).replace(/-/g, '').slice(2) + '-' + String(Math.random()).slice(2, 5);
    const ph = await photoLink(c, code, 'Xuat huy - Dieu chuyen');
    if (K === 'dispose' && !ph.url) return err('Phiếu huỷ bắt buộc có ảnh hàng hỏng (như trong app). ' + (ph.note || 'Bảo người dùng gửi ảnh vào đây rồi nhắn lại yêu cầu.'));
    const instant = K === 'adjin' && c.R.canStkMoveAppr(c.me);
    const data = { kind: K, code, branchId: bid, items: m.items.map(({ group: _g, ...x }) => x), reason: why, photos: ph.url ? [ph.url] : [], instant };
    await setPend(c, { kind: 'move', data });
    return {
      da_soan_nhap: true, chua_ghi: true,
      ban_nhap: { loai: MV_LABEL[K], ma: code, chi_nhanh: bName(c.cfg, bid), hang: data.items.map(i => i.name + ' x' + i.qty + (i.unit ? ' ' + i.unit : '')), ly_do: why, kem_anh: !!ph.url,
        sau_khi_ok: instant ? 'ghi nhập bổ sung ngay (người lập có quyền duyệt)' : 'tạo phiếu chờ quản lý duyệt — duyệt xong mới ' + (K === 'dispose' ? 'trừ' : 'cộng') + ' tồn' },
      ghi_chu_anh: ph.note || undefined,
    };
  }

  async function soan_de_nghi_chi(c, a) {
    const R = c.R, cfg = c.cfg;
    const T = R.tOf(cfg, 'PAY');
    if (T.off || (T.creators && T.creators.length && !T.creators.includes(c.me.role))) return err('Vai trò của người hỏi không được lập Đề nghị thanh toán trong app.');
    const p = pickBranches(cfg, R.scopeBranches(c.me, cfg), [a.chi_nhanh]);
    if (p.ids.length !== 1) return { ...err('Cần đúng một chi nhánh gánh chi phí.'), ...brNote(c, p) };
    const amount = Math.round(Number(a.so_tien) || 0);
    if (!(amount > 0)) return err('Số tiền phải lớn hơn 0.');
    const title = clip(String(a.noi_dung || '').trim(), 140);
    if (!title) return err('Thiếu nội dung chi.');
    const needBy = a.can_truoc && isDay(a.can_truoc) ? a.can_truoc : H.dAdd(H.dayVN(now()), 3);
    const frozen = R.chainNow(cfg, 'PAY', amount, []);
    const draft = { type: 'PAY', amount, items: [], chain: frozen, costType: 'branch', branchId: p.ids[0], status: 'OPEN' };
    /* Bước cấp duyệt người gửi tự chọn (mode 'pick') — như ReqForm */
    let pickBy = '', pickOpts = [];
    if (frozen.some(x => x.mode === 'pick')) {
      const emps = (await db.collection(COL.emp).get()).docs.map(d => ({ ...(d.data() || {}), id: d.id }));
      const opts = R.pickersFor(cfg, emps, R.reqPickDept(draft, c.me));
      if (!opts.some(e => e.id === c.me.id)) {
        if (!opts.length) return err('Chưa khai cấp duyệt cho khoản chi này — báo admin vào Cài đặt › Duyệt & mã hàng.');
        pickOpts = opts.map(e => e.id);
        if (opts.length === 1) pickBy = opts[0].id;
        else if (a.nguoi_duyet) {
          const hit = opts.filter(e => strip(e.name).includes(strip(a.nguoi_duyet)));
          if (hit.length !== 1) return { loi: 'Không xác định được cấp duyệt "' + a.nguoi_duyet + '".', chon_mot_trong: opts.map(e => e.name) };
          pickBy = hit[0].id;
        } else return { loi: 'Cần chọn cấp duyệt xác nhận chi phí.', hoi_nguoi_dung_chon_mot_trong: opts.map(e => e.name) };
      }
    }
    const start = R.skipFrom(cfg, { ...draft, pickBy, pickOpts }, 0, c.me);
    if (start >= frozen.length) return err('Cấu hình duyệt cho mức tiền này chưa có bước nào (hoặc người lập tự thoả hết các bước) — lập trong app.');
    const data = { branchId: p.ids[0], title, amount, reason: clip(String(a.ly_do || '').trim(), 500), needBy, chain: frozen, step: start, pickBy, pickOpts };
    await setPend(c, { kind: 'payReq', data });
    const emps2 = pickBy ? await empsByIds([pickBy]) : {};
    return {
      da_soan_nhap: true, chua_gui: true,
      ban_nhap: { loai: T.l || 'Đề nghị thanh toán', chi_nhanh: bName(cfg, data.branchId), noi_dung: title, so_tien: amount, ly_do: data.reason || undefined, can_truoc: needBy,
        luong_duyet: frozen.slice(start).map(s => R.stepLabel(s, Object.values(emps2), { pickBy })).join(' → '), sau_khi_ok: 'tạo phiếu và gửi người duyệt đầu tiên; duyệt / chi tiền làm trong app' },
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
    if (a.loai === 'phieu_kho') {
      const s = await db.collection(COL.mv).doc(String(a.id)).get();
      const m = s.exists ? { ...(s.data() || {}), id: s.id } : null;
      if (!m || m.status !== 'wait' || !['dispose', 'adjin'].includes(m.kind) || !c.R.canStkMoveAppr(c.me) || !c.R.inScope(c.me, m.branchId)) return err('Phiếu này không còn chờ duyệt hoặc người hỏi không có quyền duyệt.');
      await setPend(c, { kind: 'moveAppr', data: { id: m.id, act, why: clip(why, 500) } });
      return { da_soan_nhap: true, chua_ghi: true, ban_nhap: { viec: (act === 'approve' ? 'Duyệt ' : 'Từ chối ') + MV_LABEL[m.kind] + ' ' + (m.code || m.id), chi_nhanh: bName(c.cfg, m.branchId), nguoi_lap: m.byName || '', so_mon: (m.items || []).length, ly_do: why || undefined,
        sau_khi_ok: act === 'approve' ? (m.kind === 'dispose' ? 'trừ hàng khỏi tồn' : 'cộng hàng vào tồn') : 'phiếu bị từ chối, tồn không đổi' } };
    }
    return err('Loại việc không hợp lệ.');
  }

  const appUrl = (cfg) => String(((cfg || {}).offer || {}).appUrl || 'https://hihehihe.web.app').replace(/\/+$/, '');

  /* Tải ảnh Zalo lên Google Drive qua Apps Script — đúng giao thức uploadDrive() của app.
     Chưa khai Drive -> null (không có Drive thì không lưu ảnh). */
  async function uploadDrive(cfg, ph, label, sub) {
    const d = { gasUrl: '', folderId: '', ...((cfg || {}).drive || {}) };
    if (!d.gasUrl) return null;
    const img = ph.b64 ? ph : await fetchImage(ph.url);
    if (!img) throw new Error('không tải được ảnh từ Zalo');
    const stamp = new Date(now() + 7 * 3600e3).toISOString().replace(/[-:]/g, '').slice(0, 15).replace('T', '-');
    const body = JSON.stringify({ data: img.b64, mime: img.mime, name: label.replace(/[^A-Za-z0-9-]/g, '') + '_' + stamp + '.jpg', sub: sub || 'Su co bao tri', folderId: d.folderId });
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

  const RUN = { doanh_thu, ghi_chi_phi, pnl_thang, phan_tich_doanh_thu, tien_do_target, du_bao_kho, tim_nguoi_trong, cong_cua_toi, cong_thuc, anh_lich, ban_theo_mon, nguoi_trong_ca, su_co, lich_lam_viec, viec_cho_duyet, tra_cuu, soan_bao_su_co, soan_de_xuat_mua, soan_phieu_kho, soan_de_nghi_chi, soan_duyet };
  /* Trong nhóm Zalo quản lý: hỏi số liệu theo quyền NHÓM (c.me); việc gắn với một người (lịch, việc chờ
     duyệt, soạn nháp) chạy bằng quyền của CHÍNH người hỏi đã kết nối (c.actor), chưa kết nối thì từ chối. */
  const PERSONAL = ['ghi_chi_phi', 'lich_lam_viec', 'cong_cua_toi', 'viec_cho_duyet', 'soan_bao_su_co', 'soan_de_xuat_mua', 'soan_phieu_kho', 'soan_de_nghi_chi', 'soan_duyet'];
  async function run(c, name, input) {
    const fn = RUN[name];
    if (!fn) return err('Không có công cụ ' + name);
    if (c && c.group && PERSONAL.includes(name)) {
      if (!c.actor) return err('Việc này cần người hỏi đã kết nối Zalo với app Hí Hế (nhắn riêng cho bot để kết nối). Trong nhóm, người chưa kết nối chỉ hỏi số liệu được.');
      const outer = c;
      const inner = ctxOf(c.cfg, c.actor, { zaloId: c.zaloId, photo: c.photo || null, chatGroup: c.group });
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
    if (pend.kind === 'costPick') {
      /* pend.pick: số chủ nhắn (1..N) — zalo.js gắn vào trước khi gọi */
      const d = pend.data || {};
      if (me.role !== 'ADMIN') return { ok: false, msg: 'Chỉ ADMIN được ghi chi phí.' };
      const catId = (pend.opts || [])[Number(pend.pick) - 1];
      if (!catId) return { ok: false, msg: 'Số nhóm không hợp lệ, nhắn số từ 1 đến ' + (pend.opts || []).length + '.' };
      const id = R.uid('DC');
      /* Đúng bản ghi nút "+ Thêm" (PnlAddModal) ghi cho khoản CHI TRƯỚC: chi phí thật, không chờ ghép sao kê */
      await db.collection('ops_txns').doc(id).create({
        id, planned: true, prepaid: true, status: 'done', catId, alloc: d.alloc || [], note: 'Ghi qua bot Zalo',
        desc: d.desc, amount: d.amount, date: d.date, by: me.id, at: iso, viaZalo: true,
      });
      const mo = String(d.date).slice(0, 7);
      let tail = '';
      try {
        const bids = R.bizList(cfg).filter(b => b.status !== 'closed').map(b => b.id);
        const r = await loadPnl(db, R, cfg, mo, bids, new Date(now() + 7 * 3600e3).toISOString().slice(0, 10));
        tail = '\nP&L ' + R.moLbl(mo) + ' tới nay: doanh thu ' + r.rev.total.toLocaleString('vi-VN') + 'đ, chi phí ' + r.cost.total.toLocaleString('vi-VN') + 'đ, lợi nhuận ' + Math.round(r.profit).toLocaleString('vi-VN') + 'đ.';
      } catch (e) { log.warn('zalo: tính P&L sau khi ghi chi lỗi', { err: String(e && e.message).slice(0, 160) }); }
      return { ok: true, msg: 'Đã ghi ' + Number(d.amount).toLocaleString('vi-VN') + 'đ "' + d.desc + '" vào ' + R.catOf(cfg, catId).name + ' · kỳ ' + R.moLbl(mo)
        + ' · ' + (d.alloc || []).map(x => bName(cfg, x.branchId)).join(', ') + '.' + tail, ref: id };
    }
    if (pend.kind === 'move') {
      const d = pend.data || {};
      if (!R.canStkMove(me) || !bizMine(c).includes(d.branchId)) return { ok: false, msg: 'Anh/chị không còn quyền lập phiếu kho cho chi nhánh này.' };
      const instant = d.kind === 'adjin' && R.canStkMoveAppr(me);
      const id = R.uid('MV');
      const dk = new Date(now() + 7 * 3600e3).toISOString().slice(0, 10);
      const act = d.kind === 'adjin' ? (instant ? 'Quản trị ghi nhận nhập bổ sung' : 'Lập phiếu nhập bổ sung và gửi duyệt') : 'Lập phiếu và gửi duyệt';
      /* Đúng các trường StkMoveModal của app ghi */
      await db.collection(COL.mv).doc(id).create({
        id, code: d.code, kind: d.kind, date: dk, branchId: d.branchId, toBranchId: '',
        items: (d.items || []).map(i => ({ code: i.code, name: i.name, unit: i.unit || '', qty: Number(i.qty) || 0, note: i.note || '' })),
        reason: d.reason || '', photos: d.photos || [], status: instant ? 'approved' : 'wait',
        ...(instant ? { apprBy: me.id, apprName: me.name || me.id, apprAt: iso } : {}),
        by: me.id, byName: me.name || me.id, at: iso, viaZalo: true,
        log: [{ at: iso, by: me.id, byName: me.name || me.id, act: act + ' (qua Zalo)', note: d.reason || '' }],
      });
      return { ok: true, msg: instant ? 'Đã ghi nhập bổ sung ' + d.code + ' vào kho.' : 'Đã tạo ' + MV_LABEL[d.kind] + ' ' + d.code + ', đang chờ quản lý duyệt. Duyệt xong mới ' + (d.kind === 'dispose' ? 'trừ' : 'cộng') + ' tồn.', ref: id };
    }
    if (pend.kind === 'moveAppr') {
      const d = pend.data || {};
      const ref = db.collection(COL.mv).doc(String(d.id));
      return db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        const m = s.exists ? { ...(s.data() || {}), id: s.id } : null;
        if (!m || m.status !== 'wait' || !['dispose', 'adjin'].includes(m.kind) || !R.canStkMoveAppr(me) || !R.inScope(me, m.branchId)) return { ok: false, msg: 'Phiếu không còn chờ duyệt (có thể người khác vừa xử lý).' };
        const ok = d.act === 'approve';
        const act = ok ? (m.kind === 'dispose' ? 'Quản lý duyệt phiếu hủy' : 'Quản trị duyệt nhập bổ sung') : (m.kind === 'dispose' ? 'Từ chối phiếu hủy' : 'Từ chối nhập bổ sung');
        tx.update(ref, {
          ...(ok ? { status: 'approved', apprBy: me.id, apprName: me.name || me.id, apprAt: iso } : { status: 'reject' }),
          log: [...(m.log || []), { at: iso, by: me.id, byName: me.name || me.id, act: act + ' (qua Zalo)', note: d.why || '' }], upAt: iso, upBy: me.id,
        });
        return { ok: true, msg: (ok ? 'Đã duyệt ' : 'Đã từ chối ') + MV_LABEL[m.kind] + ' ' + (m.code || m.id) + (ok ? (m.kind === 'dispose' ? ' — đã trừ khỏi tồn.' : ' — đã cộng vào tồn.') : '.') };
      });
    }
    if (pend.kind === 'payReq') {
      const d = pend.data || {};
      const T = R.tOf(cfg, 'PAY');
      if (T.off || (T.creators && T.creators.length && !T.creators.includes(me.role)) || !R.scopeBranches(me, cfg).includes(d.branchId)) return { ok: false, msg: 'Anh/chị không còn quyền lập đề nghị thanh toán cho chi nhánh này.' };
      const all = (await db.collection(COL.req).select('id').get()).docs.map(x => ({ id: x.id }));
      let id = R.nextReqId(cfg, all, 'PAY');
      const emps = await empsByIds([d.pickBy].filter(Boolean));
      const rec = {
        type: 'PAY', title: d.title, branchId: d.branchId, costType: 'branch', deptId: ((cfg.depts || [])[0] || {}).id || '',
        reason: d.reason || '', note: '', needBy: d.needBy, buyType: '', genKind: '', genKindName: '',
        payee: { name: '', bin: '970436', accNo: '' }, items: [], amount: d.amount, files: [], comments: [], linkedGen: [],
        by: me.id, at: iso, status: 'OPEN', step: d.step, chain: d.chain, suppliers: [], payStatus: 'unpaid', receiptStatus: 'none',
        pickBy: d.pickBy || '', pickOpts: d.pickOpts || [], viaZalo: true,
        history: [{ at: iso, by: me.id, act: 'Tạo ' + (T.l || 'Đề nghị thanh toán') + ' (qua Zalo)',
          note: (d.reason || d.title) + ' · luồng duyệt ' + (d.chain || []).length + ' bước: ' + (d.chain || []).map(s => { try { return R.stepLabel(s, Object.values(emps), d); } catch (e) { return '—'; } }).join(' → ') }],
      };
      /* Mã phiếu tăng dần như app; trùng (hai người lập cùng lúc) thì lấy số kế tiếp */
      for (let i = 0; i < 5; i++) {
        try { await db.collection(COL.req).doc(id).create({ ...rec, id }); return { ok: true, msg: 'Đã gửi ' + (T.l || 'đề nghị thanh toán') + ' ' + id + ' (' + Number(d.amount).toLocaleString('vi-VN') + 'đ). Người duyệt xử lý trong app, mục Đề xuất.', ref: id }; }
        catch (e) { if (!(e && (e.code === 6 || /already exists/i.test(String(e.message))))) throw e; const n = Number(id.split('-')[1]) + 1; id = id.split('-')[0] + '-' + String(n).padStart(4, '0'); }
      }
      return { ok: false, msg: 'Chưa tạo được mã phiếu, thử lại.' };
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

  return { DEFS, run, ctxOf, execPending, fetchImage, pendingFor, sendSchedImage, costMenuText, PHOTO_TTL };
}

module.exports = { createTools, loadPnl, matchBranch, pickBranches, hmVN, isDay, strip, isOptionItem, DEF_ISSUE_CATS, PEND_TTL };
