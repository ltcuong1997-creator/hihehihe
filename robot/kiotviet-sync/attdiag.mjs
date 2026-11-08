/* =====================================================================
   CHẨN ĐOÁN CHẤM CÔNG TRÙNG CA (chạy tay, CHỈ ĐỌC — không ghi gì vào Firestore)
   Repo CÔNG KHAI: log không có tên, không có tiền — nhân sự chỉ hiện bằng mã băm 6 ký tự.
   Soi một tháng (MONTH=YYYY-MM): mọi ngày mà một người có >1 dòng cho cùng một ca, phân loại nguyên nhân.
   ===================================================================== */
import admin from 'firebase-admin';
import crypto from 'crypto';
const env = (k, d) => (process.env[k] == null || process.env[k] === '' ? d : process.env[k]);
const MONTH = env('MONTH', new Date().toISOString().slice(0, 7));
const h6 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 6);
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(env('FIREBASE_SA'))) });
const db = admin.firestore();
const lo = MONTH + '-01', hi = MONTH + '-31';
const cfg = (await db.collection('ops_config').doc('main').get()).data() || {};
const shifts = cfg.shifts || [], branches = cfg.branches || [];
/* Ca đã bị xoá khỏi cấu hình: tra lại định nghĩa cũ trong các bản sao lưu ops_cfgbak */
const oldShift = {};
(await db.collection('ops_cfgbak').get()).docs.forEach(d => { try { (JSON.parse(d.data().data || '{}').shifts || []).forEach(s => { if (s && s.id && !oldShift[s.id]) oldShift[s.id] = s; }); } catch (e) {} });
const sOf = (id) => shifts.find(s => s.id === id);
/* Ca hiện hành trùng giờ bắt đầu–kết thúc với ca cũ (chỉ khi DUY NHẤT một ca khớp) */
const twinOf = (id) => { const o = oldShift[id]; if (!o) return null; const l = shifts.filter(s => s.start === o.start && s.end === o.end); return l.length ? l[0] : null; };
const sLbl = (id) => { const s = sOf(id); if (s) return `${s.code}(${s.start}-${s.end})#${String(id).slice(-4)}`; const o = oldShift[id]; return o ? `ĐÃ-XOÁ:${o.code}(${o.start}-${o.end})#${String(id).slice(-4)}` : (id ? 'LẠ#' + String(id).slice(-4) : 'KHÔNG-CA'); };
console.log('Tháng', MONTH, '· số ca cấu hình', shifts.length, '· chi nhánh', branches.length);
/* ca trùng mã/giờ trong cấu hình */
const sig = {}; shifts.forEach(s => { const k = s.code + '|' + s.start + '|' + s.end; (sig[k] = sig[k] || []).push(s); });
Object.entries(sig).filter(([, l]) => l.length > 1).forEach(([k, l]) => console.log('CẤU HÌNH: ca trùng mã+giờ', k, '→', l.length, 'id:', l.map(s => String(s.id).slice(-4)).join(','), 'chi nhánh gán:', l.map(s => JSON.stringify(s.branches || s.branchIds || s.branchId || 'all')).join(' | ')));
const att = await db.collection('ops_attendance').where('date', '>=', lo).where('date', '<=', hi).get();
const sch = await db.collection('ops_schedule').where('date', '>=', lo).where('date', '<=', hi).get();
console.log('Bản ghi chấm công', att.size, '· ô lịch', sch.size);
const gone = {};
att.docs.forEach(d => { const v = d.data(); if (v.shift && !sOf(v.shift)) gone[v.shift] = (gone[v.shift] || 0) + 1; });
sch.docs.forEach(d => { const v = d.data(); if (v.shiftId && !sOf(v.shiftId)) gone[v.shiftId] = (gone[v.shiftId] || 0) + 0.001; });
Object.keys(gone).forEach(id => { const t = twinOf(id); console.log('CA ĐÃ XOÁ', sLbl(id), '· chấm công', Math.floor(gone[id]), '· ca hiện hành cùng giờ:', t ? sLbl(t.id) : 'KHÔNG CÓ'); });
const byEmpDay = {};
att.docs.forEach(d => { const v = d.data(); const k = (v.empId || d.id.split('_')[0]) + '|' + v.date; (byEmpDay[k] = byEmpDay[k] || []).push({ id: d.id, key: d.id.slice(String(v.empId || '').length + 1), v }); });
const schedOf = {};
sch.docs.forEach(d => { const v = d.data(); (v.empIds || []).forEach(e => { const k = e + '|' + v.date; (schedOf[k] = schedOf[k] || []).push({ b: v.branchId, s: v.shiftId, docId: d.id }); }); });
const stat = {}; const bump = (t) => { stat[t] = (stat[t] || 0) + 1; };
const ex = {}; const keep = (t, line) => { (ex[t] = ex[t] || []); if (ex[t].length < 12) ex[t].push(line); };
const allKeys = new Set([...Object.keys(byEmpDay), ...Object.keys(schedOf)]);
for (const k of allKeys) {
  const [emp, date] = k.split('|');
  const recs = byEmpDay[k] || [], sc = schedOf[k] || [];
  const who = h6(emp) + ' ' + date;
  /* 1. lịch: cùng một ca xếp ở 2 chi nhánh / 2 ô */
  const scShift = {}; sc.forEach(x => { (scShift[x.s] = scShift[x.s] || []).push(x.b); });
  Object.entries(scShift).filter(([, b]) => b.length > 1).forEach(([s, b]) => { bump('LỊCH: cùng ca xếp ở ' + b.length + ' chi nhánh'); keep('LỊCH', who + ' ' + sLbl(s) + ' @ ' + b.map(x => String(x).slice(-4)).join(',')); });
  /* 2. lịch: hai ca khác id nhưng cùng mã+giờ */
  const scSig = {}; sc.forEach(x => { const s = sOf(x.s); if (s) { const g = s.code + s.start + s.end; (scSig[g] = scSig[g] || new Set()).add(x.s); } });
  Object.values(scSig).filter(st => st.size > 1).forEach(st => { bump('LỊCH: 2 ca khác id cùng mã+giờ'); keep('LỊCH-SIG', who + ' ' + [...st].map(sLbl).join(' & ')); });
  /* 3. chấm công: nhiều bản ghi cùng ca */
  const byS = {}; recs.forEach(r => { (byS[r.v.shift || ''] = byS[r.v.shift || ''] || []).push(r); });
  Object.entries(byS).filter(([, l]) => l.length > 1).forEach(([s, l]) => {
    const desc = l.map(r => `${r.key}[${r.v.inAt ? 'in' : '-'}${r.v.outAt ? 'out' : '-'}${r.v.fixed ? ' sửa' : ''}${r.v.seq ? ' seq' + r.v.seq : ''}${r.v.reqId || r.v.req ? ' phiếu' : ''} br${String(r.v.branchId || '').slice(-4)}]`).join(' ');
    const empty = l.filter(r => !r.v.inAt && !r.v.outAt).length;
    const t = empty ? 'CHẤM: cùng ca có bản ghi RỖNG + bản ghi có giờ' : 'CHẤM: cùng ca 2 bản ghi đều có giờ';
    bump(t); keep(t, who + ' ' + sLbl(s) + ' ' + desc + ' | lịch: ' + sc.map(x => sLbl(x.s)).join(','));
  });
  /* 4. bản ghi có giờ mà ca không khớp lịch, trong khi lịch có ca cùng giờ khác id → app hiện 2 dòng */
  recs.filter(r => r.v.inAt).forEach(r => {
    if (!sc.length || sc.some(x => x.s === r.v.shift)) return;
    const rs = sOf(r.v.shift);
    const twin = sc.find(x => { const s = sOf(x.s); return s && rs && s.start === rs.start && s.end === rs.end; });
    const t = twin ? 'HIỂN THỊ: chấm ca khác id nhưng cùng giờ với ca đã xếp' : 'HIỂN THỊ: chấm ca không có trong lịch';
    bump(t); keep(t, who + ' chấm ' + sLbl(r.v.shift) + ' key ' + r.key + ' | lịch: ' + sc.map(x => sLbl(x.s) + '@' + String(x.b).slice(-4)).join(','));
  });
  /* 5. bản ghi rỗng (không in, không out) */
  recs.filter(r => !r.v.inAt && !r.v.outAt).forEach(r => { bump('CHẤM: bản ghi rỗng (không vào/ra)'); keep('RỖNG', who + ' vỏ ' + sLbl(r.v.shift) + ' key ' + r.key + ' | cả ngày chấm: ' + recs.map(x => x.key + '=' + sLbl(x.v.shift) + (x.v.inAt ? '[in]' : '[-]')).join(' ') + ' | lịch: ' + sc.map(x => sLbl(x.s)).join(',')); });
  /* 6. key không khớp date */
  recs.forEach(r => { if (r.key.split('~')[0] !== r.v.date) { bump('CHẤM: key lệch field date'); keep('KEY', who + ' key ' + r.key); } });
}
/* FIX=yes: dọn VỎ RỖNG (không giờ vào, không giờ ra) — sao lưu nguyên văn vào ops_attbak trước khi xoá */
if (env('FIX') === 'yes') {
  const shells = att.docs.filter(d => { const v = d.data(); return !v.inAt && !v.outAt; });
  for (const d of shells) {
    await db.collection('ops_attbak').doc(d.id).set({ ...d.data(), _bakAt: new Date().toISOString(), _why: 'vỏ rỗng gây dòng trùng' });
    await d.ref.delete();
  }
  console.log('ĐÃ DỌN', shells.length, 'vỏ rỗng (đã sao lưu ở ops_attbak)');
  /* Chấm công gắn ca ĐÃ XOÁ -> chuyển sang ca hiện hành cùng giờ (sao lưu trước) */
  let re = 0;
  for (const d of att.docs) {
    const v = d.data(); if (!v.shift || sOf(v.shift) || (!v.inAt && !v.outAt)) continue;
    const t = twinOf(v.shift); if (!t) continue;
    await db.collection('ops_attbak').doc(d.id + '__shift').set({ ...v, _bakAt: new Date().toISOString(), _why: 'đổi ca đã xoá sang ca cùng giờ' });
    await d.ref.update({ shift: t.id, shiftOld: v.shift }); re++;
  }
  /* Ô lịch của ca ĐÃ XOÁ -> gộp người vào ô ca cùng giờ, rồi xoá ô cũ (sao lưu trước) */
  let rs = 0;
  for (const d of sch.docs) {
    const v = d.data(); if (!v.shiftId || sOf(v.shiftId)) continue;
    const t = twinOf(v.shiftId); if (!t) continue;
    const ref = db.collection('ops_schedule').doc(`${v.branchId}_${v.date}_${t.id}`);
    const cur = (await ref.get()).data();
    const ids = [...new Set([...((cur && cur.empIds) || []), ...(v.empIds || [])])];
    await db.collection('ops_schbak').doc(d.id).set({ ...v, _bakAt: new Date().toISOString() });
    await ref.set({ branchId: v.branchId, date: v.date, shiftId: t.id, empIds: ids }, { merge: true });
    await d.ref.delete(); rs++;
  }
  console.log('ĐÃ CHUYỂN', re, 'bản ghi chấm công và', rs, 'ô lịch từ ca đã xoá sang ca cùng giờ');
}
console.log('\n===== TỔNG HỢP =====');
Object.entries(stat).sort((a, b) => b[1] - a[1]).forEach(([t, n]) => console.log(String(n).padStart(5), t));
console.log('\n===== VÍ DỤ (mã NV đã băm) =====');
Object.entries(ex).forEach(([t, l]) => { console.log('\n--', t); l.forEach(x => console.log('  ', x)); });
process.exit(0);
