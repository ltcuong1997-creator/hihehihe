/* =====================================================================
   MÔ PHỎNG CHÍNH XÁC màn "Lịch sử chấm công" bằng CHÍNH CODE của app (bóc từ index.html) trên dữ liệu thật.
   CHỈ ĐỌC. Log không tên/tiền — nhân sự hiện bằng mã băm. Liệt kê mọi người-ngày ra từ 2 dòng trở lên.
   ===================================================================== */
import admin from 'firebase-admin';
import crypto from 'crypto';
import fs from 'fs';
const env = (k, d) => (process.env[k] == null || process.env[k] === '' ? d : process.env[k]);
const MONTH = env('MONTH', new Date().toISOString().slice(0, 7));
const h6 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 6);
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(env('FIREBASE_SA'))) });
const db = admin.firestore();
/* REF=<commit>: chạy code của một bản app cũ (để biết máy chưa cập nhật đang thấy gì) */
const REF = env('REF', '');
const html = REF ? await (await fetch(`https://raw.githubusercontent.com/ltcuong1997-creator/hihehihe/${REF}/index.html`)).text() : fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const cut = (a, b) => { const i = html.indexOf(a), j = html.indexOf(b, i); if (i < 0 || j < 0) throw new Error('không bóc được ' + a); return html.slice(i, j); };
const first = html.includes('const attHas = (a)') ? 'const attHas = (a)' : 'const nextAttKey = ';
const code = cut(first, 'const attStOf = (r)') + '\n' + cut('const myShiftsOn = ', 'const myShiftOn = ') + (html.includes('const attHas = (a)') ? '' : '\nconst attHas = (a) => !!(a && (a.inAt || a.outAt));');
console.log('Code app:', REF || 'bản hiện tại');
const cfg = (await db.collection('ops_config').doc('main').get()).data() || {};
const CFG = cfg;
const shiftOf = (id) => (CFG.shifts || []).find(s => s.id === id) || null;
const schedKey = (b, d, s) => `${b}_${d}_${s}`;
const api = new Function('CFG', 'shiftOf', 'schedKey', code + '\nreturn { attRowsForEmpDay, attHas };')(CFG, shiftOf, schedKey);
/* nạp TOÀN BỘ chấm công, khoá lấy theo document id như app (attKeyOf) — không lọc theo field date */
const att = {}; let nAtt = 0;
/* CHỈ đọc đúng tháng (field date) — đọc cả collection mỗi lần chạy là đốt quota đọc Firestore */
(await db.collection('ops_attendance').where('date', '>=', MONTH + '-01').where('date', '<=', MONTH + '-31').get()).docs.forEach(d => {
  const v = d.data(), pre = (v.empId || '') + '_';
  const key = v.empId && d.id.startsWith(pre) ? d.id.slice(pre.length) : (v.date + (v.seq > 1 ? '~' + v.seq : ''));
  if (key.slice(0, 7) !== MONTH && String(v.date || '').slice(0, 7) !== MONTH) return;
  nAtt++; (att[v.empId] = att[v.empId] || {})[key] = { ...v, empId: v.empId };
});
const sched = {};
(await db.collection('ops_schedule').where('date', '>=', MONTH + '-01').where('date', '<=', MONTH + '-31').get()).docs.forEach(d => { const v = d.data(); sched[schedKey(v.branchId, v.date, v.shiftId)] = v.empIds || []; });
const emps = (await db.collection('ops_employees').get()).docs.map(d => ({ id: d.id, ...d.data() })).map(e => ({ ...e, branches: e.branches || [] }));
console.log('Tháng', MONTH, '· bản ghi', nAtt, '· ô lịch', Object.keys(sched).length, '· nhân sự', emps.length, '· ca cấu hình', (cfg.shifts || []).length);
const hm = (t) => t ? new Date(t).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' }) : '--';
const dim = new Date(+MONTH.slice(0, 4), +MONTH.slice(5), 0).getDate();
let multi = 0, emptyNext = 0; const perEmp = {};
for (const e of emps) for (let i = 1; i <= dim; i++) {
  const k = MONTH + '-' + String(i).padStart(2, '0');
  const rows = api.attRowsForEmpDay(cfg, sched, att, e, k);
  if (rows.length < 2) continue;
  multi++;
  const bad = rows.some(r => !api.attHas(r.a)) && rows.some(r => api.attHas(r.a));
  if (bad) emptyNext++;
  perEmp[h6(e.id)] = (perEmp[h6(e.id)] || 0) + 1;
  console.log((bad ? '❌ ' : '   ') + h6(e.id) + ' ' + k + ' · ' + rows.map(r => {
    const s = r.s ? r.s.code + '(' + r.s.start + '-' + r.s.end + ')#' + String(r.shiftId).slice(-4) : 'KHÔNG-CA#' + String(r.shiftId || '').slice(-4);
    return s + ' ' + (r.rk || 'không-bản-ghi').replace(k, '') + ' [' + (r.a ? hm(r.a.inAt) + '→' + hm(r.a.outAt) + (r.a.fixed ? ' sửa' : '') : 'trống') + ']' + (r.outOfSchedule ? ' ngoài-lịch' : '');
  }).join(' | '));
}
console.log('\nTỔNG: ' + multi + ' người-ngày có ≥2 dòng · trong đó ' + emptyNext + ' ngày có dòng trống cạnh dòng có giờ');
console.log('Theo người:', JSON.stringify(perEmp));
process.exit(0);
