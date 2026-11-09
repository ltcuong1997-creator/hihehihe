/* =====================================================================
   TỔNG HỢP CÔNG THÁNG bằng CHÍNH hàm payCalc của app (bóc từ index.html) — CHỈ ĐỌC.
   Repo CÔNG KHAI: log CHỈ có giờ / số người / số ngày, TUYỆT ĐỐI không in tiền. Nhân sự hiện bằng mã băm.
   Kèm rà: double ca (chồng giờ), 2 ca/ngày, ca dài, thiếu vào/ra, ca không gắn ca, chấm hộ (cùng máy).
   ===================================================================== */
import admin from 'firebase-admin';
import crypto from 'crypto';
import fs from 'fs';
const env = (k, d) => (process.env[k] == null || process.env[k] === '' ? d : process.env[k]);
const MO = env('MONTH', new Date().toISOString().slice(0, 7));
const h6 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 6);
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(env('FIREBASE_SA'))) });
const db = admin.firestore();
const html = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const from = html.indexOf('const pad = (n) =>'), pc = html.indexOf('const payCalc = (e, ctx) =>');
const to = html.indexOf('\n};\n', pc) + 4;
/* Chỉ lấy các khai báo thuần JS (bỏ component JSX nằm xen giữa) */
const code = html.slice(from, to).split(/\n(?=const |function |let |var |\/\*)/).filter(c => !/className=|<\/|\/>|useState|useApp|React\./.test(c)).join('\n');
const cfg = (await db.collection('ops_config').doc('main').get()).data() || {};
const CFG = cfg;
/* Hàm nào payCalc cần mà chưa có thì bóc thêm đúng khai báo đó (dò theo ReferenceError) */
const stmtOf = (name) => {
  const m = html.match(new RegExp('\\n(const|function) ' + name + '\\b'));
  if (!m) throw new Error('không tìm thấy ' + name);
  const i = m.index + 1, rest = html.slice(i + 1), j = rest.search(/\n(?=const |function |let |\/\*)/);
  return html.slice(i, i + 1 + (j < 0 ? rest.length : j));
};
let extra = '', lib = null;
const mk = () => new Function('CFG', `const shiftOf = (id) => (CFG.shifts || []).find(s => s.id === id) || null;
const ftKey = (id, period) => id + '_' + period; const EMPTY_OBJ = {}; const EMPTY_ARR = [];
${code}
${extra}
return { payCalc, attMinsOf, stdDaysOf, shiftOf };`)(CFG);
const probe = (L) => L.payCalc({ id: '_', type: 'Parttime', hourRate: 1, base: 1, branches: [] }, { att: { _: { [MO + '-01']: { shift: '', inAt: MO + '-01T01:00:00Z', outAt: MO + '-01T09:00:00Z' } } }, cfg, ftlogs: {}, mo: MO, days: [MO + '-01'], stdDays: 26, my: [] });
const build = (test) => {
  for (let i = 0; i < 60; i++) {
    try { lib = mk(); test(lib); return; }
    catch (e) { const n = /^(\w+) is not defined/.exec(e.message); if (!n) throw e; extra += '\n' + stmtOf(n[1]); lib = null; }
  }
  throw new Error('không dựng được payCalc');
};
build(probe);
const att = {};
/* CHỈ đọc đúng tháng (field date) — đọc cả collection mỗi lần chạy là đốt quota đọc Firestore */
(await db.collection('ops_attendance').where('date', '>=', MO + '-01').where('date', '<=', MO + '-31').get()).docs.forEach(d => {
  const v = d.data(), pre = (v.empId || '') + '_';
  const key = v.empId && d.id.startsWith(pre) ? d.id.slice(pre.length) : (v.date + (v.seq > 1 ? '~' + v.seq : ''));
  if (key.slice(0, 7) !== MO) return;
  (att[v.empId] = att[v.empId] || {})[key] = v;
});
const ftlogs = {}; (await db.collection('ops_ftlogs').where('period', '==', MO).get()).docs.forEach(d => { ftlogs[d.id] = d.data(); });
{ const r0 = await db.collection('ops_ftlogs').doc('RUN_' + MO).get(); if (r0.exists) ftlogs[r0.id] = r0.data(); }
const adjs = (await db.collection('ops_payadj').where('period', '==', MO).get()).docs.map(d => d.data());
const emps = (await db.collection('ops_employees').get()).docs.map(d => ({ id: d.id, ...d.data() })).map(e => ({ ...e, branches: e.branches || [] }));
const dim = new Date(+MO.slice(0, 4), +MO.slice(5), 0).getDate();
const days = Array.from({ length: dim }, (_, i) => MO + '-' + String(i + 1).padStart(2, '0'));
const stdDays = lib.stdDaysOf(ftlogs, cfg, MO);
const run = ftlogs['RUN_' + MO] || {};
const trace = (e) => Object.keys(att[e.id] || {}).length || adjs.some(a => a.empId === e.id);
const pool = emps.filter(e => e.status !== 'off' || (e.leftAt || '') >= MO + '-01' || trace(e));
const chosen = run.emps || pool.map(e => e.id);
const list = pool.filter(e => chosen.includes(e.id));
const H = (m) => (Math.round((m || 0) / 6) / 10).toLocaleString('vi-VN');
console.log(`Tháng ${MO} · công chuẩn ${stdDays} · đã chốt danh sách: ${run.emps ? 'có' : 'chưa (lấy mọi người có dấu vết)'} · ${list.length} người tính lương`);
const G = { FT: { n: 0, mins: 0, reg: 0, ot: 0, real: 0, wd: 0, leave: 0, zero: 0 }, PT: { n: 0, mins: 0, reg: 0, ot: 0, real: 0, wd: 0, leave: 0, zero: 0 } };
/* chạy thử trên dữ liệu thật để bóc nốt hằng/hàm còn thiếu ở các nhánh probe chưa đi qua */
build((L) => list.forEach(e => L.payCalc(e, { att, cfg, ftlogs, mo: MO, days, stdDays, my: adjs.filter(a => a.empId === e.id) })));
const rows = list.map(e => {
  const my = adjs.filter(a => a.empId === e.id);
  const r = lib.payCalc(e, { att, cfg, ftlogs, mo: MO, days, stdDays, my });
  const g = G[e.type === 'Parttime' ? 'PT' : 'FT'];
  g.n++; g.mins += r.mins || 0; g.reg += r.regMins || 0; g.ot += r.otMins || 0; g.real += r.realMins || 0; g.wd += +r.workDays || 0; g.leave += +r.leaveDays || 0;
  if (!r.mins) g.zero++;
  return { e, r, adjN: my.length };
});
for (const k of ['FT', 'PT']) { const g = G[k]; console.log(`${k === 'FT' ? 'FULLTIME' : 'PARTTIME'}: ${g.n} người · ${g.wd} ngày công · ${H(g.mins)} giờ (thường ${H(g.reg)} + tăng ca ${H(g.ot)}) · giờ thực tế quy đổi ${H(g.real)} · phép năm ${g.leave} ngày · ${g.zero} người 0 giờ`); }
console.log('\nTừng người (mã băm · loại · ngày công · tổng giờ · tăng ca · số phiếu bổ sung/khấu trừ):');
rows.sort((a, b) => (b.r.mins || 0) - (a.r.mins || 0)).forEach(({ e, r, adjN }) => console.log(`  ${h6(e.id)} ${e.type === 'Parttime' ? 'PT' : 'FT'} · ${r.workDays} công · ${H(r.mins)}h · TC ${H(r.otMins)}h · ${adjN} phiếu${r.noOut ? ' · ' + r.noOut + ' ca thiếu giờ ra' : ''}`));
/* ---- RÀ LỖI ---- */
const hm = (t) => t ? new Date(t).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' }) : '--';
const sl = (id) => { const s = lib.shiftOf(id); return s ? s.code : (id ? 'ca-đã-xoá' : 'không-ca'); };
const iss = {}; const add = (t, x) => { (iss[t] = iss[t] || []).push(x); };
const inList = new Set(list.map(e => e.id));
Object.keys(att).forEach(id => {
  const who = h6(id) + (inList.has(id) ? '' : '(NGOÀI bảng lương)');
  const byDay = {};
  Object.entries(att[id]).forEach(([k, a]) => { (byDay[k.split('~')[0]] = byDay[k.split('~')[0]] || []).push({ k, a }); });
  Object.entries(byDay).forEach(([d, l]) => {
    const w = l.filter(x => x.a.inAt && x.a.outAt).map(x => ({ ...x, t0: +new Date(x.a.inAt), t1: +new Date(x.a.outAt), m: lib.attMinsOf(x.a, cfg) }));
    for (let i = 0; i < w.length; i++) for (let j = i + 1; j < w.length; j++) {
      const ov = Math.min(w[i].t1, w[j].t1) - Math.max(w[i].t0, w[j].t0);
      if (ov > 15 * 60000) add('DOUBLE CA (2 bản ghi chồng giờ → tính giờ 2 lần)', `${who} ${d} ${sl(w[i].a.shift)} ${hm(w[i].a.inAt)}→${hm(w[i].a.outAt)} & ${sl(w[j].a.shift)} ${hm(w[j].a.inAt)}→${hm(w[j].a.outAt)}`);
    }
    if (w.length >= 2) add('Làm 2 ca trở lên trong ngày (không chồng giờ)', `${who} ${d} ` + w.map(x => `${sl(x.a.shift)} ${hm(x.a.inAt)}→${hm(x.a.outAt)}`).join(' + ') + ` = ${H(w.reduce((s, x) => s + x.m, 0))}h`);
    const tot = w.reduce((s, x) => s + x.m, 0);
    if (tot > 12 * 60) add('Ngày tính trên 12 giờ', `${who} ${d} ${H(tot)}h`);
    l.forEach(({ k, a }) => {
      if (a.inAt && !a.outAt) add('Thiếu giờ ra (ca không được tính giờ)', `${who} ${k} ${sl(a.shift)} vào ${hm(a.inAt)}`);
      if (!a.inAt && a.outAt) add('Thiếu giờ vào', `${who} ${k} ${sl(a.shift)} ra ${hm(a.outAt)}`);
      if (a.inAt && a.outAt) {
        const raw = (new Date(a.outAt) - new Date(a.inAt)) / 60000, m = lib.attMinsOf(a, cfg);
        if (raw > 14 * 60) add('Ca kéo dài trên 14 giờ', `${who} ${k} ${sl(a.shift)} ${hm(a.inAt)}→${hm(a.outAt)}`);
        if (m > 0 && m < 60) add('Ca dưới 1 giờ', `${who} ${k} ${sl(a.shift)} ${hm(a.inAt)}→${hm(a.outAt)} (${Math.round(m)}p)`);
        if (raw > 0 && m === 0) add('Có giờ vào/ra nhưng tính 0 giờ', `${who} ${k} ${sl(a.shift)} ${hm(a.inAt)}→${hm(a.outAt)}`);
        if (!lib.shiftOf(a.shift)) add('Bản ghi không gắn ca hiện hành (không cắt theo khung ca)', `${who} ${k} ${sl(a.shift)} ${hm(a.inAt)}→${hm(a.outAt)} tính ${H(m)}h`);
      }
    });
    const lg = ((ftlogs[id + '_' + MO] || {}).days || {})[d];
    if (lg === 'P' && w.length) add('Ghi phép P mà vẫn có chấm công (trả 2 lần)', `${who} ${d}`);
  });
  if (!inList.has(id) && Object.values(att[id]).some(a => a.inAt)) add('Có chấm công nhưng KHÔNG nằm trong bảng lương', who);
});
/* Chấm hộ: một máy chấm vào ca cho ≥2 người trong cùng ngày (trừ máy chung đã khai) */
const shared = new Set(((cfg.rules || {}).sharedDevs) || []);
const dev = {};
Object.keys(att).forEach(id => Object.entries(att[id]).forEach(([k, a]) => { const dv = a.dev && a.dev.id; if (!dv || shared.has(dv) || !a.inAt || a.fixed) return; const key = dv + '|' + k.split('~')[0]; (dev[key] = dev[key] || new Set()).add(id); }));
Object.entries(dev).filter(([, s]) => s.size > 1).forEach(([k, s]) => add('Một máy chấm cho nhiều người cùng ngày (nghi chấm hộ)', `${k.split('|')[1]} máy …${k.split('|')[0].slice(-4)} → ${[...s].map(h6).join(', ')}`));
console.log('\n===== RÀ LỖI =====');
if (!Object.keys(iss).length) console.log('Không thấy lỗi nào');
Object.entries(iss).forEach(([t, l]) => { console.log(`\n-- ${t}: ${l.length}`); l.sort().forEach(x => console.log('   ' + x)); });
process.exit(0);
