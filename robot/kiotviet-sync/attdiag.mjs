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
const twinOf = (id) => { const o = oldShift[id]; if (!o) return null; const n = (t) => String(t || '').padStart(5, '0'); const l = shifts.filter(s => n(s.start) === n(o.start) && n(s.end) === n(o.end)); return l.length ? l[0] : null; };
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
/* DEDUP=yes: cùng người, cùng ngày, cùng ca mà có ≥2 bản ghi ĐỀU có giờ -> giữ bản tự chấm (không phải
   sửa tay; nếu đều sửa tay thì giữ key gốc), xoá bản thừa — sao lưu nguyên văn vào ops_attbak trước */
if (env('DEDUP') === 'yes') {
  const hm = (t) => t ? new Date(t).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' }) : '--';
  let n = 0;
  for (const k of Object.keys(byEmpDay)) {
    const by = {};
    byEmpDay[k].forEach(r => { if (r.v.inAt || r.v.outAt) (by[r.v.shift || ''] = by[r.v.shift || ''] || []).push(r); });
    for (const l of Object.values(by)) {
      if (l.length < 2) continue;
      l.sort((a, b) => (!!a.v.fixed - !!b.v.fixed) || a.key.localeCompare(b.key));
      const [keep, ...drop] = l;
      for (const r of drop) {
        await db.collection('ops_attbak').doc(r.id + '__dup').set({ ...r.v, _bakAt: new Date().toISOString(), _why: 'bản trùng ca, giữ ' + keep.key });
        await db.collection('ops_attendance').doc(r.id).delete();
        console.log('XOÁ TRÙNG', h6(k.split('|')[0]), k.split('|')[1], sLbl(r.v.shift), '· giữ', keep.key, hm(keep.v.inAt) + '→' + hm(keep.v.outAt), keep.v.fixed ? '(sửa tay)' : '(tự chấm)', '· xoá', r.key, hm(r.v.inAt) + '→' + hm(r.v.outAt), r.v.fixed ? '(sửa tay)' : '(tự chấm)');
        n++;
      }
    }
  }
  console.log('ĐÃ XOÁ', n, 'bản ghi trùng ca (đã sao lưu ở ops_attbak)');
}
/* ---- Mô phỏng ĐÚNG màn Chấm công: mỗi người mỗi ngày ra bao nhiêu dòng, dòng nào trống; và các bản ghi
   có giờ CHỒNG LÊN NHAU (bị tính giờ 2 lần) ---- */
{
  const hm = (t) => t ? new Date(t).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' }) : '--';
  const n5 = (t) => String(t || '').padStart(5, '0');
  const sig = (id) => { const x = sOf(id); return x ? n5(x.start) + '-' + n5(x.end) : 'id:' + id; };
  const live = await db.collection('ops_attendance').where('date', '>=', lo).where('date', '<=', hi).get();
  const liveSch = await db.collection('ops_schedule').where('date', '>=', lo).where('date', '<=', hi).get();
  const R = {}, S = {};
  live.docs.forEach(d => { const v = d.data(); const k = v.empId + '|' + v.date; (R[k] = R[k] || []).push({ key: d.id.slice(String(v.empId).length + 1), v }); });
  liveSch.docs.forEach(d => { const v = d.data(); if (!sOf(v.shiftId)) return; (v.empIds || []).forEach(e => { const k = e + '|' + v.date; (S[k] = S[k] || []).push(v.shiftId); }); });
  let dupRows = 0, ovl = 0;
  for (const k of [...new Set([...Object.keys(R), ...Object.keys(S)])].sort((a, b) => a.split('|')[1].localeCompare(b.split('|')[1]))) {
    const recs = (R[k] || []).sort((a, b) => a.key.localeCompare(b.key)), has = (v) => !!(v && (v.inAt || v.outAt));
    const asg = []; (S[k] || []).forEach(id => { if (!asg.some(x => sig(x) === sig(id))) asg.push(id); });
    const used = new Set();
    const rows = asg.map(id => {
      const r = recs.find(r => !used.has(r.key) && r.v.shift === id && has(r.v)) || recs.find(r => !used.has(r.key) && sig(r.v.shift) === sig(id) && has(r.v)) || recs.find(r => !used.has(r.key) && r.v.shift === id);
      if (r) used.add(r.key); return { id, r };
    });
    rows.forEach(row => { if (row.r && has(row.r.v)) return; const r = recs.find(x => !used.has(x.key) && has(x.v) && !sOf(x.v.shift)); if (r) { if (row.r) used.delete(row.r.key); used.add(r.key); row.r = r; } });
    recs.filter(r => !used.has(r.key) && has(r.v)).forEach(r => rows.push({ id: r.v.shift, r, free: 1 }));
    const [emp, date] = k.split('|');
    const desc = () => rows.map(x => sLbl(x.id) + '=' + (x.r ? x.r.key.replace(date, '') + '[' + hm(x.r.v.inAt) + '→' + hm(x.r.v.outAt) + (x.r.v.fixed ? ' sửa' : '') + ']' : '[trống]') + (x.free ? '*ngoài lịch' : '')).join(' | ');
    if (rows.length > 1 && rows.some(x => !x.r || !has(x.r.v)) && rows.some(x => x.r && has(x.r.v))) { dupRows++; console.log('DÒNG TRỐNG CẠNH DÒNG CÓ GIỜ', h6(emp), date, desc()); }
    const iv = recs.filter(r => r.v.inAt && r.v.outAt).map(r => ({ r, a: +new Date(r.v.inAt), b: +new Date(r.v.outAt) }));
    for (let i = 0; i < iv.length; i++) for (let j = i + 1; j < iv.length; j++) if (Math.min(iv[i].b, iv[j].b) - Math.max(iv[i].a, iv[j].a) > 15 * 60000) {
      ovl++; console.log('CHỒNG GIỜ', h6(emp), date, desc());
      /* DEDUP=yes: bản KHÔNG gắn ca hợp lệ chồng giờ lên bản có ca -> xoá bản không ca (sao lưu trước) */
      const A = iv[i].r, B = iv[j].r, okA = !!sOf(A.v.shift), okB = !!sOf(B.v.shift);
      if (env('DEDUP') === 'yes' && okA !== okB) {
        const drop = okA ? B : A, id = emp + '_' + drop.key;
        await db.collection('ops_attbak').doc(id + '__ovl').set({ ...drop.v, _bakAt: new Date().toISOString(), _why: 'chồng giờ với bản có ca' });
        await db.collection('ops_attendance').doc(id).delete();
        console.log('   → ĐÃ XOÁ bản không ca', drop.key, hm(drop.v.inAt) + '→' + hm(drop.v.outAt));
      }
    }
  }
  console.log('TỔNG: ', dupRows, 'ngày có dòng trống cạnh dòng có giờ ·', ovl, 'cặp bản ghi chồng giờ');
}
/* LATEFIX: tính lại số phút trễ của MỌI bản ghi trong tháng theo đúng công thức app (attLateOf):
   trễ = giờ vào − giờ bắt đầu ca (đủ phút), ân hạn chỉ quyết định có tính trễ hay không.
   LATEFIX=dry chỉ báo; LATEFIX=yes ghi lại (sao lưu giá trị cũ vào field lateOld). Ca đã xoá thì bỏ qua. */
if (env('LATEFIX') === 'dry' || env('LATEFIX') === 'yes') {
  const hm = (t) => t ? new Date(t).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' }) : '--';
  const mOf = (x) => { const [h, m] = String(x || '00:00').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  const lateOf = (sh, inAt) => {
    const t = new Date(inAt); if (isNaN(t)) return 0;
    const vn = new Date(t.toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
    let d = vn.getHours() * 60 + vn.getMinutes() - mOf(sh.start);
    if (d < -720) d += 1440; if (d > 720) d -= 1440;
    const g = sh.grace != null && sh.grace !== '' ? +sh.grace : 5;
    return d > g ? d : 0;
  };
  const live = await db.collection('ops_attendance').where('date', '>=', lo).where('date', '<=', hi).get();
  let ch = 0, up = 0, down = 0, same = 0, skip = 0;
  for (const d of live.docs) {
    const v = d.data(); if (!v.inAt) continue;
    const sh = sOf(v.shift); if (!sh) { skip++; continue; }
    const nl = lateOf(sh, v.inAt), ol = +v.late || 0;
    if (nl === ol) { same++; continue; }
    ch++; nl > ol ? up++ : down++;
    console.log(`TRỄ ${h6(v.empId)} ${v.date} ${sLbl(v.shift)} vào ${hm(v.inAt)} (ân hạn ${sh.grace ?? 5}′): đang ghi ${ol}′ → đúng ${nl}′${v.fixed ? ' · sửa tay' : ' · tự chấm'}`);
    if (env('LATEFIX') === 'yes') await d.ref.update({ late: nl, lateOld: ol });
  }
  console.log(`TỔNG TRỄ: ${ch} bản ghi lệch (${up} báo thiếu phút, ${down} báo dư) · ${same} đúng · ${skip} bỏ qua (ca đã xoá)` + (env('LATEFIX') === 'yes' ? ' · ĐÃ GHI LẠI' : ' · chỉ xem, chưa ghi'));
}
console.log('\n===== TỔNG HỢP =====');
Object.entries(stat).sort((a, b) => b[1] - a[1]).forEach(([t, n]) => console.log(String(n).padStart(5), t));
console.log('\n===== VÍ DỤ (mã NV đã băm) =====');
Object.entries(ex).forEach(([t, l]) => { console.log('\n--', t); l.forEach(x => console.log('  ', x)); });
process.exit(0);
