/* ===================== BOT ZALO — TỰ BÁO (không cần ai hỏi) =====================
   Bật / tắt từng loại trong app: Cấu hình › Hệ thống › Bot Zalo › Bot tự báo (cfg.zalo.auto — máy chủ CHỈ ĐỌC).
     · Báo cáo cuối ngày (23:50): MỘT ảnh — doanh thu từng chi nhánh, so với cùng thứ tuần trước, luỹ kế
       tháng / target, nguồn đơn, món bán chạy, đi trễ / vắng, sự cố đang mở, việc chờ duyệt.
     · Cảnh báo (mỗi 15 phút, 7h–23h45): nhân viên chưa vào ca sau giờ bắt đầu 15 phút; sự cố Khẩn quá 2 giờ /
       Cao quá 12 giờ chưa xử lý; 20h doanh thu tới giờ đó thấp hơn 60% cùng thứ tuần trước; 9h việc chờ
       duyệt quá 24 giờ. Mỗi chuyện báo đúng 1 lần, có trần tin / ngày.
     · Nhắc lịch (20h): nhắn riêng từng người đã kết nối Zalo có ca ngày mai.
   Nơi nhận báo cáo + cảnh báo: các NHÓM Zalo ban quản trị đã gắn (1 tin cho cả nhóm, đỡ tốn hạn mức).
   Chưa gắn nhóm thì nhắn riêng người đã kết nối có vai trò trong "Nhận báo cáo" mà xem được mọi chi nhánh.
   Chỉ ĐỌC dữ liệu app; ghi duy nhất ops_zguard/auto_{ngày} để nhớ đã báo gì. */
const IMG = require('./zaloimg');
const { isOptionItem } = require('./zalotools');   /* bỏ dòng tuỳ chọn đá / đường / % khỏi món bán chạy */

const OPEN_ISS = ['MOI', 'TIEP_NHAN', 'DANG_XU_LY', 'CHO_DUYET'];
const REV_CH = { dine: 'Tại chỗ', take: 'Mang về', grab: 'GrabFood', shopee: 'ShopeeFood', be: 'beFood', na: 'Chưa rõ nguồn' };
const WDL = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'];
const DEF_AUTO = { report: true, alerts: { late: true, iss: true, rev: true, pend: true }, remind: true, maxPerDay: 12 };

/* cfg.zalo.auto — thiếu thì mặc định bật hết. Cùng quy tắc với zaloAuto() trong index.html. */
function acfg(cfg) {
  const a = ((cfg || {}).zalo || {}).auto || {};
  const al = a.alerts || {};
  const n = Number(a.maxPerDay);
  return {
    report: a.report !== false, remind: a.remind !== false,
    alerts: { late: al.late !== false, iss: al.iss !== false, rev: al.rev !== false, pend: al.pend !== false },
    maxPerDay: Number.isFinite(n) && n >= 1 ? Math.min(50, Math.floor(n)) : DEF_AUTO.maxPerDay,
  };
}
const hm2min = (s) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(s || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const minVN = (ms) => { const d = new Date(ms + 7 * 3600e3); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const hhmm = (m) => String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const ddmm = (d) => d.slice(8, 10) + '/' + d.slice(5, 7);
const wdOf = (d) => new Date(d + 'T00:00:00Z').getUTCDay();
const sumLines = (doc, upto) => ((doc || {}).lines || []).reduce((a, l) => a + (upto == null || Number(l.t) <= upto ? Number(l.a) || 0 : 0), 0);

function createAuto(deps) {
  const { db, FV, log, getCfg, zcfg, send, appRules, dayVN, dAdd, monthVN } = deps;
  const now = deps.now || (() => Date.now());
  const col = (n) => db.collection(n);
  const bizOpen = (cfg) => (cfg.branches || []).filter(b => b && b.id && b.kind !== 'hq' && b.status !== 'closed');
  const bName = (cfg, id) => { const b = (cfg.branches || []).find(x => x.id === id); return b ? (b.name || b.code || id) : id; };
  const bCode = (cfg, id) => { const b = (cfg.branches || []).find(x => x.id === id); return b ? (b.code || b.name || id) : id; };

  /* ---------- Nơi nhận ---------- */
  async function targets(cfg, { personalOnly } = {}) {
    if (!personalOnly) {
      const gs = await col('ops_zgroup').where('active', '==', true).get();
      if (!gs.empty) return gs.docs.map(d => ({ zaloId: d.id, chatId: d.id, empId: '', group: true }));
    }
    const zc = zcfg(cfg), R = appRules(cfg);
    const ls = await col('ops_zlink').where('active', '==', true).get();
    const out = [];
    for (const l of ls.docs) {
      const v = l.data() || {};
      const es = await col('ops_employees').doc(String(v.empId || '_')).get();
      const e = es.exists ? es.data() || {} : null;
      if (!e || e.status === 'off') continue;
      if (!(zc.reportRoles || []).includes(e.role) && e.role !== 'ADMIN') continue;
      if ((R.roleOf(e.role) || {}).scope !== 'all') continue;     /* báo cáo có mọi chi nhánh */
      out.push({ zaloId: l.id, chatId: v.chatId || l.id, empId: v.empId });
    }
    return out;
  }

  /* ---------- Nhớ đã báo gì trong ngày (giành bằng giao dịch: mỗi chuyện đúng 1 lần) ---------- */
  async function claim(day, key, cap) {
    const ref = col('ops_zguard').doc('auto_' + day);
    return db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      const v = s.exists ? s.data() || {} : {};
      const sent = v.sent || {};
      if (sent[key]) return false;
      if (cap && (Number(v.n) || 0) >= cap) return false;
      tx.set(ref, { sent: { [key]: now() }, ...(cap ? { n: FV.increment(1) } : {}) }, { merge: true });
      return true;
    });
  }
  async function blast(cfg, list, kind, text, cmd, photo) {
    let n = 0;
    for (const t of list) {
      const r = await send({ zaloId: t.zaloId, chatId: t.chatId, empId: t.empId || '', kind, text, cmd, ...(photo ? { photo } : {}) });
      if (r === 'sent') n++;
      await new Promise(res => setTimeout(res, deps.gapMs == null ? 600 : deps.gapMs));   /* giãn nhịp gửi */
    }
    return n;
  }

  /* ---------- Gom số liệu một ngày cho báo cáo ---------- */
  async function gather(cfg, day) {
    const brs = bizOpen(cfg);
    const ym = day.slice(0, 7), lw = dAdd(day, -7);
    const refs = (d) => brs.map(b => col('ops_revenue').doc(b.id + '_' + d));
    const [revD, revL, tgts, sales] = await Promise.all([
      brs.length ? db.getAll(...refs(day)) : [], brs.length ? db.getAll(...refs(lw)) : [],
      brs.length ? db.getAll(...brs.map(b => col('ops_targets').doc(b.id + '_' + ym))) : [],
      brs.length ? db.getAll(...brs.map(b => col('ops_sales').doc(b.id + '_' + ym))) : [],
    ]);
    const mtdQ = await col('ops_revenue').where('date', '>=', ym + '-01').where('date', '<=', day).select('branchId', 'amount').get();
    const mtd = {};
    mtdQ.docs.forEach(d => { const v = d.data() || {}; mtd[v.branchId] = (mtd[v.branchId] || 0) + (Number(v.amount) || 0); });
    const src = {}, top = {};
    const branches = brs.map((b, i) => {
      const v = revD[i].exists ? revD[i].data() || {} : {};
      const w = revL[i].exists ? revL[i].data() || {} : {};
      const ch = v.ch && Object.keys(v.ch).length ? v.ch : (Number(v.amount) ? { na: Number(v.amount) } : {});
      Object.entries(ch).forEach(([k, a]) => { const l = REV_CH[k] || ((v.chL || {})[k]) || k.replace(/^o_/, ''); src[l] = (src[l] || 0) + (Number(a) || 0); });
      const items = sales[i].exists ? ((sales[i].data() || {}).items || {}) : {};
      Object.entries(items).forEach(([code, it]) => { const q = Number((it.d || {})[day]) || 0; if (q && !isOptionItem(it.name)) { const o = top[code] || (top[code] = { name: it.name || code, unit: it.unit || '', qty: 0 }); o.qty += q; } });
      const tg = tgts[i].exists ? Number((tgts[i].data() || {}).amount) || 0 : 0;
      return { id: b.id, name: b.name || b.id, rev: Number(v.amount) || 0, inv: Number(v.invoices) || 0, lw: Number(w.amount) || 0, mtd: mtd[b.id] || 0, tgt: tg };
    });
    const sum = (k) => branches.reduce((a, b) => a + b[k], 0);
    /* Nhân sự: ai được xếp, ai vào ca, ai trễ, ai vắng */
    const [schQ, attQ] = await Promise.all([
      col('ops_schedule').where('date', '==', day).get(),
      col('ops_attendance').where('date', '==', day).get(),
    ]);
    const bidOk = new Set(brs.map(b => b.id));
    const sched = new Map();
    schQ.docs.forEach(d => { const v = d.data() || {}; if (bidOk.has(v.branchId)) (v.empIds || []).forEach(id => sched.set(id, v.branchId)); });
    const came = new Set(), late = [];
    attQ.docs.forEach(d => { const v = d.data() || {}; if (!v.inAt) return; came.add(v.empId); if (Number(v.late) > 0) late.push({ empId: v.empId, mins: Number(v.late), br: bCode(cfg, v.branchId) }); });
    const ids = [...new Set([...sched.keys(), ...late.map(l => l.empId)])];
    const names = {};
    for (let i = 0; i < ids.length; i += 100) {
      const got = await db.getAll(...ids.slice(i, i + 100).map(id => col('ops_employees').doc(id)));
      got.forEach(s => { if (s.exists) names[s.id] = (s.data() || {}).name || s.id; });
    }
    const absent = [...sched.entries()].filter(([id]) => !came.has(id)).map(([id, b]) => ({ name: names[id] || id, br: bCode(cfg, b) }));
    /* Vận hành */
    const issQ = await col('ops_issues').where('status', 'in', OPEN_ISS).get();
    const R = appRules(cfg), t = now();
    let issOpen = 0, issKhan = 0, issOver = 0;
    issQ.docs.forEach(d => {
      const v = d.data() || {};
      if (!bidOk.has(v.branchId)) return;
      issOpen++; if (v.sev === 'KHAN') issKhan++;
      const sla = ((R.ISSUE_SEV[v.sev] || R.ISSUE_SEV.THUONG || {}).sla) || 72;
      if ((t - Date.parse(v.created)) / 3600e3 > sla) issOver++;
    });
    const [pq, mv, ar, rq] = await Promise.all([
      col('ops_preq').where('status', '==', 'wait').get(), col('ops_stkmove').where('status', '==', 'wait').get(),
      col('ops_attreqs').where('status', '==', 'pending').get(), col('ops_requests').where('status', '==', 'OPEN').get(),
    ]);
    return {
      day, wd: WDL[wdOf(day)], lwLabel: WDL[wdOf(day)].toLowerCase() + ' tuần trước',
      monthPace: Number(day.slice(8, 10)) / new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0)).getUTCDate(),
      stamp: hhmm(minVN(t)) + ' ' + ddmm(dayVN(t)),
      total: { rev: sum('rev'), inv: sum('inv'), lw: sum('lw'), mtd: sum('mtd'), tgt: sum('tgt') },
      branches, sources: Object.entries(src).map(([l, a]) => ({ l, a })).sort((a, b) => b.a - a.a),
      top: Object.values(top).sort((a, b) => b.qty - a.qty).slice(0, 6),
      staff: { came: [...sched.keys()].filter(id => came.has(id)).length, sched: sched.size, late: late.sort((a, b) => b.mins - a.mins).map(l => ({ ...l, name: names[l.empId] || l.empId })), absent },
      ops: { issOpen, issKhan, issOver, pend: [{ l: 'đề xuất mua', n: pq.size }, { l: 'phiếu kho', n: mv.size }, { l: 'đơn công', n: ar.size }, { l: 'đề nghị', n: rq.size }] },
    };
  }
  const caption = (rep) => {
    const t = rep.total;
    const d = t.lw > 0 ? ' (' + (t.rev >= t.lw ? '+' : '') + Math.round((t.rev - t.lw) / t.lw * 100) + '% so với ' + rep.lwLabel + ')' : '';
    return 'Báo cáo ' + rep.wd.toLowerCase() + ' ' + ddmm(rep.day) + ': doanh thu ' + IMG.money(t.rev) + d + ', ' + t.inv + ' hoá đơn'
      + (t.tgt ? '. Luỹ kế tháng đạt ' + Math.round(t.mtd / t.tgt * 100) + '% target' : '') + '.';
  };
  const textReport = (rep) => [
    caption(rep),
    ...rep.branches.map(b => '- ' + b.name + ': ' + IMG.money(b.rev) + ' · ' + b.inv + ' HĐ' + (b.lw ? ' · ' + IMG.pctTxt(b.rev, b.lw) : '')),
    rep.sources.length ? 'Nguồn đơn: ' + rep.sources.map(s => s.l + ' ' + IMG.mil(s.a)).join(', ') : '',
    rep.top.length ? 'Bán chạy: ' + rep.top.slice(0, 5).map(x => x.name + ' ' + Math.round(x.qty)).join(', ') : '',
    'Vào ca ' + rep.staff.came + '/' + rep.staff.sched + (rep.staff.late.length ? ', trễ: ' + rep.staff.late.map(l => l.name + ' ' + l.mins + 'p').join(', ') : '') + (rep.staff.absent.length ? ', vắng: ' + rep.staff.absent.map(a => a.name).join(', ') : ''),
    'Sự cố mở: ' + rep.ops.issOpen + (rep.ops.issKhan ? ' (' + rep.ops.issKhan + ' khẩn)' : '') + '. Chờ duyệt: ' + (rep.ops.pend.filter(p => p.n).map(p => p.n + ' ' + p.l).join(', ') || 'không có') + '.',
  ].filter(Boolean).join('\n');

  /* ---------- Báo cáo ngày ---------- */
  async function report({ day, only, force } = {}) {
    const cfg = await getCfg();
    const A = acfg(cfg);
    const d = day || dayVN(now());
    if (!only && !A.report) return { skipped: 'off' };
    if (!only && !force && !(await claim(d, 'report'))) return { skipped: 'done' };
    const list = only ? [only] : await targets(cfg);
    if (!list.length) return { skipped: 'no_target' };
    const rep = await gather(cfg, d);
    let photo = '', imgErr = '';
    try {
      if (typeof deps.uploadImage !== 'function') throw new Error('chưa bật gửi ảnh');
      photo = await deps.uploadImage(IMG.renderPng(IMG.reportSvg(rep)), 'baocao/' + d + '_' + now() + '.png');
    } catch (e) { imgErr = String((e && e.message) || e).slice(0, 200); log.warn('zalo: ảnh báo cáo lỗi, gửi chữ', { err: imgErr }); }
    const n = await blast(cfg, list, only ? 'reply' : 'report', photo ? caption(rep) : textReport(rep), 'report', photo);
    return { day: d, sent: n, of: list.length, photo: !!photo, imgErr };
  }

  /* ---------- Cảnh báo + nhắc lịch (chạy mỗi 15 phút) ---------- */
  async function tick() {
    const cfg = await getCfg();
    const A = acfg(cfg);
    const t = now(), day = dayVN(t), m = minVN(t);
    const brs = bizOpen(cfg), bidOk = new Set(brs.map(b => b.id));
    const shifts = cfg.shifts || [];
    const out = { kinds: [], sent: 0 };
    let list = null;
    const to = async () => (list = list || await targets(cfg));
    const alert = async (key, text) => {
      if (!(await claim(day, key, A.maxPerDay))) return;
      const ts = await to();
      if (!ts.length) return;
      out.sent += await blast(cfg, ts, 'alert', text, 'auto_' + key.split('_')[0]);
      out.kinds.push(key.split('_')[0]);
    };
    const empName = async (id) => { const s = await col('ops_employees').doc(String(id)).get(); return s.exists ? (s.data() || {}).name || id : id; };

    /* 1) Chưa vào ca sau giờ bắt đầu 15 phút (trong vòng 2 giờ đầu ca) */
    if (A.alerts.late) {
      const sch = await col('ops_schedule').where('date', '==', day).get();
      const due = [];
      sch.docs.forEach(d => {
        const v = d.data() || {};
        const s = shifts.find(x => x.id === v.shiftId);
        const st = s ? hm2min(s.start) : null;
        if (!bidOk.has(v.branchId) || st == null || m - st < 15 || m - st > 120) return;
        (v.empIds || []).forEach(id => due.push({ id, s, bid: v.branchId }));
      });
      if (due.length) {
        const att = await col('ops_attendance').where('date', '==', day).get();
        const inBy = new Set();
        att.docs.forEach(d => { const v = d.data() || {}; if (v.inAt) { inBy.add(v.empId + '|' + (v.shift || '')); inBy.add(v.empId + '|*'); } });
        for (const x of due) {
          if (inBy.has(x.id + '|' + x.s.id) || inBy.has(x.id + '|*')) continue;
          await alert('late_' + x.id + '_' + x.s.id, 'Chưa vào ca: ' + (await empName(x.id)) + ' có lịch ' + (x.s.code || x.s.name) + ' ' + x.s.start + ' tại ' + bName(cfg, x.bid) + ', tới ' + hhmm(m) + ' vẫn chưa chấm công vào.');
        }
      }
    }
    /* 2) Sự cố Khẩn quá 2 giờ / Cao quá 12 giờ còn ở trạng thái mới báo / tiếp nhận */
    if (A.alerts.iss) {
      const iss = await col('ops_issues').where('status', 'in', ['MOI', 'TIEP_NHAN']).get();
      for (const d of iss.docs) {
        const v = d.data() || {};
        const lim = v.sev === 'KHAN' ? 2 : v.sev === 'CAO' ? 12 : null;
        if (!lim || !bidOk.has(v.branchId) || (t - Date.parse(v.created)) / 3600e3 < lim) continue;
        await alert('iss_' + (v.id || d.id), 'Sự cố ' + (v.sev === 'KHAN' ? 'KHẨN' : 'mức cao') + ' quá ' + lim + ' giờ chưa xử lý: ' + (v.title || '') + (v.room ? ' (' + v.room + ')' : '') + ' tại ' + bName(cfg, v.branchId) + ', báo lúc ' + hhmm(minVN(Date.parse(v.created))) + '.');
      }
    }
    /* 3) 20h: doanh thu tới giờ này so với cùng thứ tuần trước (tới cùng giờ) */
    if (A.alerts.rev && m >= 20 * 60 && m < 20 * 60 + 15 && brs.length) {
      const lw = dAdd(day, -7);
      const [a, b] = await Promise.all([db.getAll(...brs.map(x => col('ops_revenue').doc(x.id + '_' + day))), db.getAll(...brs.map(x => col('ops_revenue').doc(x.id + '_' + lw)))]);
      const low = [];
      brs.forEach((x, i) => {
        const now1 = sumLines(a[i].exists ? a[i].data() : null, m), was = sumLines(b[i].exists ? b[i].data() : null, m);
        if (was >= 500000 && now1 < 0.6 * was) low.push('- ' + (x.name || x.id) + ': ' + IMG.money(now1) + ' (tuần trước cùng giờ ' + IMG.money(was) + ', ' + IMG.pctTxt(now1, was) + ')');
      });
      if (low.length) await alert('rev_' + day, 'Doanh thu tới ' + hhmm(m) + ' thấp hơn hẳn ' + WDL[wdOf(day)].toLowerCase() + ' tuần trước:\n' + low.join('\n'));
    }
    /* 4) 9h: việc chờ duyệt quá 24 giờ */
    if (A.alerts.pend && m >= 9 * 60 && m < 9 * 60 + 15) {
      const old = (x) => (t - Date.parse(x.at || x.created || x.upAt || 0)) / 3600e3 > 24;
      const [pq, mv, ar, rq] = await Promise.all([
        col('ops_preq').where('status', '==', 'wait').get(), col('ops_stkmove').where('status', '==', 'wait').get(),
        col('ops_attreqs').where('status', '==', 'pending').get(), col('ops_requests').where('status', '==', 'OPEN').get(),
      ]);
      const cnt = (q) => q.docs.map(d => d.data() || {}).filter(x => (!x.branchId || bidOk.has(x.branchId)) && old(x)).length;
      const parts = [['đề xuất mua', cnt(pq)], ['phiếu kho', cnt(mv)], ['đơn công', cnt(ar)], ['đề xuất / đề nghị thanh toán', cnt(rq)]].filter(p => p[1]);
      if (parts.length) await alert('pend_' + day, 'Việc chờ duyệt quá 24 giờ: ' + parts.map(p => p[1] + ' ' + p[0]).join(', ') + '. Người duyệt nhắn bot "có gì chờ tôi duyệt" để xử lý nhanh.');
    }
    /* 5) 20h: nhắc riêng từng người có ca ngày mai */
    if (A.remind && m >= 20 * 60 && m < 20 * 60 + 15 && (await claim(day, 'remind'))) {
      const tm = dAdd(day, 1);
      const sch = await col('ops_schedule').where('date', '==', tm).get();
      const by = {};
      sch.docs.forEach(d => {
        const v = d.data() || {};
        const s = shifts.find(x => x.id === v.shiftId);
        if (!s || !bidOk.has(v.branchId)) return;
        (v.empIds || []).forEach(id => (by[id] = by[id] || []).push((s.code || s.name) + ' ' + s.start + '-' + s.end + ' tại ' + bName(cfg, v.branchId)));
      });
      if (Object.keys(by).length) {
        const ls = await col('ops_zlink').where('active', '==', true).get();
        let n = 0;
        for (const l of ls.docs) {
          const v = l.data() || {};
          const mine = by[v.empId];
          if (!mine) continue;
          const r = await send({ zaloId: l.id, chatId: v.chatId || l.id, empId: v.empId, kind: 'remind', text: 'Nhắc lịch: mai (' + WDL[wdOf(tm)].toLowerCase() + ' ' + ddmm(tm) + ') anh/chị làm ' + mine.join('; ') + '. Nhắn LICH để xem cả tuần.', cmd: 'auto_remind' });
          if (r === 'sent') n++;
          await new Promise(res => setTimeout(res, deps.gapMs == null ? 600 : deps.gapMs));
        }
        out.sent += n; if (n) out.kinds.push('remind');
      }
    }
    return out;
  }

  return { report, tick, gather, acfg };
}

module.exports = { createAuto, acfg, DEF_AUTO, hm2min, sumLines };
