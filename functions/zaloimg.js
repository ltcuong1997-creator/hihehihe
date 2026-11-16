/* ===================== BOT ZALO — ẢNH LỊCH LÀM VIỆC =====================
   Vẽ lại đúng mẫu "Ảnh lịch tuần để dán Zalo" của app (drawWeekSchedImg trong index.html) bằng SVG
   rồi đổi ra PNG bằng resvg (font Space Grotesk đóng gói ở functions/fonts — có dấu tiếng Việt):
   đầu ảnh màu thương hiệu + khoảng ngày + tên chi nhánh, bảng nhân viên × 7 ngày, mỗi ca một ô màu
   (mã ca + giờ), ô không có ca ghi OFF, cuối ảnh chú thích giờ từng ca.
   Hai kiểu: cả chi nhánh (mỗi dòng một nhân viên) và lịch của MỘT người (một dòng, ô ghi kèm chi nhánh).
   Phần thuần (dựng SVG) có test; PNG + tải lên Storage chạy ở máy chủ. */
const C = { brand: '#18484A', brandDk: '#123A3B', wash: '#E8F1F0', ink: '#2E2019', ink3: '#8A7B70', line: '#EADFD3', zebra: '#FBF7F3', off: '#F1ECE6', offTx: '#A89A8E', sun: '#FFF4EE', away: '#7C3AED' };
const WD = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/* Cắt chữ theo bề ngang ước lượng (Space Grotesk ~0,56 cỡ chữ mỗi ký tự) */
const fit = (t, maxW, px) => { t = String(t || ''); const n = Math.max(1, Math.floor(maxW / (px * 0.56))); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const dmy = (k) => k.slice(8, 10) + '/' + k.slice(5, 7) + '/' + k.slice(0, 4);
const dm = (k) => k.slice(8, 10) + '/' + k.slice(5, 7);
const wdOf = (k) => new Date(k + 'T00:00:00Z').getUTCDay();
const initials = (name) => String(name || '?').trim().split(/\s+/).slice(-2).map(w => w[0] || '').join('').toUpperCase();
const hueOf = (s) => { let h = 0; for (const ch of String(s || 'x')) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
const okColor = (c) => /^#[0-9a-f]{6}$/i.test(String(c || '')) ? c : C.brand;

/* opts: { title, sub, badge, days: [YYYY-MM-DD x7], rows: [{ id, name, sub, away, cells: { day: [{ code, start, end, color, tag }] } }],
   legend: [{ code, name, start, end, color }] } */
function weekSvg(opts) {
  const PAD = 22, NAME_W = 236, DAY_W = 112, HEAD_H = 104, TH_H = 50, CHIP_H = 34, CHIP_GAP = 4;
  const days = opts.days, rows = opts.rows || [], legend = opts.legend || [];
  const W = PAD * 2 + NAME_W + DAY_W * 7;
  const rowH = rows.map(r => Math.max(52, Math.max(1, ...days.map(d => ((r.cells || {})[d] || []).length)) * (CHIP_H + CHIP_GAP) + 12));
  const bodyH = rowH.reduce((a, b) => a + b, 0) || 50;
  const LEG_H = legend.length ? 30 + Math.ceil(legend.length / 4) * 22 + 4 : 0;
  const H = HEAD_H + 14 + TH_H + bodyH + LEG_H + PAD;
  const o = [];
  const T = (x, y, txt, px, w, fill, anchor) => o.push(`<text x="${x}" y="${y}" font-size="${px}" font-weight="${w}" fill="${fill}"${anchor ? ` text-anchor="${anchor}"` : ''}>${esc(txt)}</text>`);
  const R = (x, y, w, h, r, fill, stroke) => o.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="1.2"` : ''}/>`);
  o.push(`<rect width="${W}" height="${H}" fill="#fff"/>`);
  /* đầu ảnh */
  o.push(`<rect width="${W}" height="${HEAD_H}" fill="${C.brand}"/><rect y="${HEAD_H - 6}" width="${W}" height="6" fill="${C.brandDk}"/>`);
  T(PAD, 46, opts.title || 'LỊCH LÀM VIỆC TUẦN', 28, 600, '#fff');
  T(PAD, 76, opts.sub || ('Từ ' + dmy(days[0]) + ' đến ' + dmy(days[6])), 17, 400, '#CFE3E1');
  if (opts.badge) {
    const bn = fit(opts.badge, W / 2 - PAD, 20);
    const bw = Math.round(bn.length * 20 * 0.58) + 32;
    R(W - PAD - bw, 30, bw, 42, 21, '#fff');
    T(W - PAD - 16, 58, bn, 20, 600, C.brand, 'end');
  }
  /* hàng tiêu đề ngày */
  let y = HEAD_H + 14;
  const x0 = PAD, xd = PAD + NAME_W;
  R(x0, y, W - PAD * 2, TH_H, 10, C.wash);
  T(x0 + 12, y + 30, opts.nameHead || ('Nhân viên (' + rows.length + ')'), 14, 600, C.brand);
  days.forEach((d, i) => {
    const cx = xd + i * DAY_W + DAY_W / 2;
    T(cx, y + 22, WD[wdOf(d)], 15, 600, wdOf(d) === 0 ? '#C0392B' : C.brand, 'middle');
    T(cx, y + 40, dm(d), 12.5, 400, C.ink3, 'middle');
  });
  y += TH_H;
  /* thân bảng */
  rows.forEach((r, ri) => {
    const h = rowH[ri];
    if (ri % 2) o.push(`<rect x="${x0}" y="${y}" width="${W - PAD * 2}" height="${h}" fill="${C.zebra}"/>`);
    days.forEach((d, i) => { if (wdOf(d) === 0 && !(ri % 2)) o.push(`<rect x="${xd + i * DAY_W}" y="${y}" width="${DAY_W}" height="${h}" fill="${C.sun}"/>`); });
    /* vòng chữ viết tắt như app (máy chủ không tải ảnh đại diện) */
    const AV = 38, ax = x0 + 10, ay = y + h / 2 - AV / 2, hu = hueOf(r.name), gid = 'g' + ri;
    o.push(`<defs><linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hu},58%,52%)"/><stop offset="1" stop-color="hsl(${(hu + 38) % 360},62%,40%)"/></linearGradient></defs>`);
    o.push(`<circle cx="${ax + AV / 2}" cy="${ay + AV / 2}" r="${AV / 2}" fill="url(#${gid})" stroke="#fff" stroke-width="2"/>`);
    T(ax + AV / 2, ay + AV / 2 + 5, initials(r.name), 14, 600, '#fff', 'middle');
    const tx = ax + AV + 10, tw = NAME_W - (tx - x0) - 8;
    T(tx, y + h / 2 - 2, fit(r.name, tw, 14.5), 14.5, 600, C.ink);
    if (r.sub) T(tx, y + h / 2 + 14, fit(r.sub, tw, 11.5), 11.5, 400, r.away ? C.away : C.ink3);
    days.forEach((d, i) => {
      const got = (r.cells || {})[d] || [], cx = xd + i * DAY_W;
      if (!got.length) {
        R(cx + 8, y + h / 2 - 15, DAY_W - 16, 30, 8, C.off);
        T(cx + DAY_W / 2, y + h / 2 + 5, 'OFF', 13, 600, C.offTx, 'middle');
        return;
      }
      const top = y + (h - got.length * (CHIP_H + CHIP_GAP) + CHIP_GAP) / 2;
      got.forEach((s, j) => {
        const cy = top + j * (CHIP_H + CHIP_GAP), col = okColor(s.color);
        o.push(`<rect x="${cx + 6}" y="${cy}" width="${DAY_W - 12}" height="${CHIP_H}" rx="8" fill="${col}" fill-opacity="0.13" stroke="${col}" stroke-width="1.2"/>`);
        T(cx + DAY_W / 2, cy + 15, fit(s.code + (s.tag ? ' · ' + s.tag : ''), DAY_W - 20, 13), 13, 600, col, 'middle');
        T(cx + DAY_W / 2, cy + 28, (s.start || '') + '–' + (s.end || ''), 10.5, 400, C.ink, 'middle');
      });
    });
    y += h;
    o.push(`<line x1="${x0}" y1="${y}" x2="${W - PAD}" y2="${y}" stroke="${C.line}" stroke-width="1"/>`);
  });
  if (!rows.length) { T(W / 2, y + 30, 'Chưa có ai được xếp ca', 14, 400, C.ink3, 'middle'); y += 50; }
  /* vạch cột ngày */
  for (let i = 0; i <= 7; i++) o.push(`<line x1="${xd + i * DAY_W}" y1="${HEAD_H + 14 + TH_H}" x2="${xd + i * DAY_W}" y2="${y}" stroke="${C.line}" stroke-width="1"/>`);
  /* chú thích ca */
  if (legend.length) {
    y += 22;
    T(x0, y, 'Giờ các ca:', 12.5, 600, C.ink3);
    legend.forEach((s, i) => {
      const col = okColor(s.color), lx = x0 + (i % 4) * ((W - PAD * 2) / 4), ly = y + 20 + Math.floor(i / 4) * 22;
      o.push(`<rect x="${lx}" y="${ly - 11}" width="12" height="12" rx="3" fill="${col}"/>`);
      T(lx + 18, ly, fit((s.code || '') + ' ' + (s.name || '') + ' ' + (s.start || '') + '–' + (s.end || ''), (W - PAD * 2) / 4 - 24, 12), 12, 400, C.ink);
    });
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Space Grotesk">${o.join('')}</svg>`;
}

/* Dữ liệu lịch -> opts cho weekSvg.
   docs: ops_schedule { branchId, date, shiftId, empIds } của 7 ngày; cfg: ops_config/main; emps: { id: emp } */
function branchWeek({ cfg, docs, emps, bid, days }) {
  const shifts = (cfg.shifts || []).filter(s => s && s.id);
  const br = (cfg.branches || []).find(b => b.id === bid) || { id: bid, name: bid };
  const cells = {};
  (docs || []).forEach(d => {
    if (!d || d.branchId !== bid || !days.includes(d.date) || !Array.isArray(d.empIds)) return;
    const s = shifts.find(x => x.id === d.shiftId);
    if (!s) return;
    d.empIds.forEach(id => { ((cells[id] = cells[id] || {})[d.date] = cells[id][d.date] || []).push(s); });
  });
  /* Dòng: người của chi nhánh còn làm + người chi nhánh khác được xếp hỗ trợ */
  const ids = new Set(Object.keys(cells));
  Object.values(emps).forEach(e => { if (e.status !== 'off' && (e.branches || []).includes(bid)) ids.add(e.id); });
  const pos = (cfg.positions || []);
  const rows = [...ids].map(id => {
    const e = emps[id] || { id, name: id, branches: [] };
    const away = !(e.branches || []).includes(bid);
    const home = away ? ((cfg.branches || []).find(b => b.id === (e.branches || [])[0]) || {}) : null;
    const p = pos.find(x => x.id === e.posId);
    const c = {};
    Object.entries(cells[id] || {}).forEach(([d, list]) => { c[d] = list.slice().sort((a, b) => String(a.start).localeCompare(String(b.start))).map(s => ({ code: s.code || s.name || s.id, start: s.start, end: s.end, color: s.color })); });
    return { id, name: e.name || id, away, sub: away ? 'Hỗ trợ · ' + (home && (home.code || home.name) || '') : (p ? p.name : ''), cells: c, n: Object.values(c).reduce((a, l) => a + l.length, 0) };
  }).sort((a, b) => (a.away - b.away) || (b.n - a.n) || String(a.name).localeCompare(String(b.name), 'vi'));
  const used = new Set(rows.flatMap(r => Object.values(r.cells).flat().map(s => s.code)));
  return {
    title: 'LỊCH LÀM VIỆC TUẦN', badge: br.name || bid, days, rows,
    legend: shifts.filter(s => used.has(s.code || s.name || s.id)).map(s => ({ code: s.code || s.id, name: s.name, start: s.start, end: s.end, color: s.color })),
  };
}
function personWeek({ cfg, docs, emp, days }) {
  const shifts = (cfg.shifts || []).filter(s => s && s.id);
  const brs = (cfg.branches || []);
  const c = {};
  (docs || []).forEach(d => {
    if (!d || !days.includes(d.date) || !Array.isArray(d.empIds) || !d.empIds.includes(emp.id)) return;
    const s = shifts.find(x => x.id === d.shiftId), b = brs.find(x => x.id === d.branchId);
    if (!s || !b || b.status === 'closed') return;
    (c[d.date] = c[d.date] || []).push({ code: s.code || s.name || s.id, tag: b.code || '', start: s.start, end: s.end, color: s.color });
  });
  Object.values(c).forEach(l => l.sort((a, b) => String(a.start).localeCompare(String(b.start))));
  const used = new Set(Object.values(c).flat().map(s => s.code));
  const total = Object.values(c).reduce((a, l) => a + l.length, 0);
  return {
    title: 'LỊCH LÀM VIỆC CỦA TÔI', badge: emp.name || '', days, nameHead: 'Nhân viên',
    rows: [{ id: emp.id, name: emp.name || emp.id, sub: total + ' ca trong tuần', cells: c }],
    legend: shifts.filter(s => used.has(s.code || s.name || s.id)).map(s => ({ code: s.code || s.id, name: s.name, start: s.start, end: s.end, color: s.color })),
  };
}

function renderPng(svg) {
  const { Resvg } = require('@resvg/resvg-js');
  const path = require('path');
  const dir = path.join(__dirname, 'fonts');
  const r = new Resvg(svg, {
    font: { fontFiles: ['SpaceGrotesk_400Regular.ttf', 'SpaceGrotesk_600SemiBold.ttf'].map(f => path.join(dir, f)), loadSystemFonts: false, defaultFontFamily: 'Space Grotesk' },
    fitTo: { mode: 'zoom', value: 2 },
  });
  return r.render().asPng();
}

module.exports = { weekSvg, branchWeek, personWeek, renderPng, esc };
