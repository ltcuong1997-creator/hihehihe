/* Nạp bù chấm công từ nhật ký vào/ra ca của app cũ (Ngày · Giờ · Vào ca/Ra ca · Tên nhân viên) thẳng vào
   Firestore — cùng cách ghép và cùng định dạng bản ghi với nút "Nhập Excel bổ sung" trong app.

   Chạy:  npm i --prefix tools/firestore
          FIREBASE_SA='<JSON tài khoản dịch vụ>' node tools/firestore/import-att.mjs <file.xlsx|csv> [--to=YYYY-MM-DD] [--apply]
   Không có --apply thì chỉ in ra sẽ ghi gì (chạy thử). --to: bỏ mọi lượt VÀO ca sau ngày này
   (lượt RA ca sáng hôm sau của ca tối ngày cuối vẫn giữ để ca đó có giờ ra).
   Giờ trong file hiểu là giờ Việt Nam (+07:00). */
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const APPLY = args.includes('--apply');
const TO = (args.find(a => a.startsWith('--to=')) || '').slice(5);
if (!file) { console.error('Thiếu đường dẫn file'); process.exit(1); }

const noAccent = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
const norm = (s) => noAccent(s).toLowerCase().replace(/\s+/g, ' ').trim();
const pad = (n) => String(n).padStart(2, '0');
const toDate = (v) => {
  const s = String(v || '').trim();
  let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (m) return `${m[3]}-${pad(+m[2])}-${pad(+m[1])}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[0] : '';
};
const kindOf = (v) => {
  const t = norm(v);
  if (/vao|check ?in|bat dau/.test(t)) return 'in';
  if (/\bra\b|ket thuc|check ?out|tan ca/.test(t)) return 'out';
  return '';
};
const vn = (date, time) => new Date(date + 'T' + time + ':00+07:00');

/* ---- đọc file ---- */
const wb = XLSX.read(fs.readFileSync(file), { cellDates: false });
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false })
  .filter(r => r.some(c => String(c ?? '').trim()));
const punches = [];
for (const r of rows) {
  const date = toDate(r[0]), time = String(r[1] || '').trim().slice(0, 5).replace(/^(\d):/, '0$1:'), kind = kindOf(r[2]), name = String(r[3] || '').trim();
  if (!date || !/^\d{2}:\d{2}$/.test(time) || !kind || !name) continue;   // dòng tiêu đề / dòng hỏng
  if (TO && date > TO && kind === 'in') continue;
  punches.push({ date, time, kind, name, t: vn(date, time).getTime() });
}

/* ---- ghép Vào → Ra theo từng người ---- */
const byName = {};
punches.forEach(p => (byName[norm(p.name)] = byName[norm(p.name)] || []).push(p));
const recs = [], odd = [];
for (const list of Object.values(byName)) {
  list.sort((a, b) => a.t - b.t);
  let open = null;
  for (const p of list) {
    if (p.kind === 'in') { if (open) odd.push({ ...open, why: 'vào ca nhưng không có lượt ra ca' }); open = p; }
    else if (open && p.t > open.t && p.t - open.t <= 20 * 3600e3) { recs.push({ name: open.name, date: open.date, inAt: new Date(open.t), outAt: new Date(p.t) }); open = null; }
    else odd.push({ ...p, why: 'có giờ ra nhưng không có giờ vào' });
  }
  if (open) {
    if (TO && open.date === TO) odd.push({ ...open, why: 'vào ca ngày cuối nhưng không có lượt ra ca' });
    else recs.push({ name: open.name, date: open.date, inAt: new Date(open.t), outAt: null });
  }
}
recs.sort((a, b) => a.inAt - b.inAt);
console.log(`Đọc ${punches.length} lượt bấm → ${recs.length} ca, ${odd.length} lượt lẻ (không nhập)`);
odd.forEach(o => console.log(`  LẺ  ${o.date} ${o.time} ${o.name}: ${o.why}`));

if (!process.env.FIREBASE_SA) {
  console.log('\nChưa có biến môi trường FIREBASE_SA — chỉ chạy thử phần ghép, không đọc/ghi Firestore.');
  recs.slice(0, 5).forEach(r => console.log('  ', r.date, r.name, r.inAt.toISOString(), r.outAt ? r.outAt.toISOString() : '(thiếu giờ ra)'));
  process.exit(0);
}

/* ---- Firestore ---- */
const admin = require('firebase-admin');
const sa = JSON.parse(process.env.FIREBASE_SA);
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const emps = (await db.collection('ops_employees').get()).docs.map(d => ({ id: d.id, ...d.data() }));
const empOf = {};
const miss = new Set(), amb = new Set();
for (const n of Object.keys(byName)) {
  const hits = emps.filter(e => norm(e.name) === n);
  const act = hits.filter(e => e.status !== 'off');
  const e = act.length === 1 ? act[0] : (hits.length === 1 ? hits[0] : null);
  if (e) empOf[n] = e; else (act.length > 1 ? amb : miss).add(byName[n][0].name);
}
miss.forEach(n => console.log(`  KHÔNG THẤY nhân viên tên "${n}" — bỏ qua`));
amb.forEach(n => console.log(`  TRÙNG TÊN nhiều nhân viên "${n}" — bỏ qua`));

let add = 0, upd = 0;
const batch = db.batch();
const existCache = {};
for (const r of recs) {
  const e = empOf[norm(r.name)];
  if (!e) continue;
  if (!existCache[e.id]) existCache[e.id] = (await db.collection('ops_attendance').where('empId', '==', e.id).get()).docs.map(d => ({ id: d.id, ...d.data() }));
  const mine = existCache[e.id];
  const inIso = r.inAt.toISOString();
  /* Cùng ngày + cùng giờ vào thì ghi đè (chạy lại không đẻ bản ghi trùng); không thì lấy key trống kế tiếp */
  const same = mine.find(x => (x.date || '').slice(0, 10) === r.date && x.inAt === inIso);
  let key = same ? same.id.slice(e.id.length + 1) : r.date;
  if (!same) { let n = 1; while (mine.some(x => x.id === e.id + '_' + key)) { n++; key = r.date + '~' + n; } }
  const mins = r.outAt ? Math.round((r.outAt - r.inAt) / 60000) : 0;
  const rec = {
    inAt: inIso, outAt: r.outAt ? r.outAt.toISOString() : null, shift: '', branchId: (e.branches || [])[0] || '',
    late: 0, fixed: true, fixBy: 'import-app-cu', fixAt: new Date().toISOString(), date: r.date, empId: e.id,
    ...(mins > 0 ? { mins } : {}),
  };
  if (!same) mine.push({ id: e.id + '_' + key, ...rec });
  same ? upd++ : add++;
  console.log(`  ${same ? 'GHI ĐÈ' : 'THÊM  '} ${e.name.padEnd(24)} ${r.date} ${key.padEnd(12)} ${inIso.slice(11, 16)}Z → ${rec.outAt ? rec.outAt.slice(11, 16) + 'Z' : '(thiếu ra)'}  ${(mins / 60).toFixed(2)}h`);
  batch.set(db.collection('ops_attendance').doc(e.id + '_' + key), rec, { merge: true });
}
console.log(`\nTổng: thêm ${add}, ghi đè ${upd}.`);
if (!APPLY) { console.log('Chạy thử — chưa ghi gì. Thêm --apply để ghi thật.'); process.exit(0); }
await batch.commit();
console.log('ĐÃ GHI vào Firestore.');
process.exit(0);
