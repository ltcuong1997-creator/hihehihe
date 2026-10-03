/* =====================================================================
   ROBOT KIOTVIET → SỐ BÁN THEO MÓN + SỔ QUỸ (Hí Hế Hậu Giang)
   ---------------------------------------------------------------------
   KiotViet F&B của quán không mở API công khai, nên robot đăng nhập web quản lý như người thật
   (trình duyệt ẩn Playwright), rồi dùng CHÍNH phiên đó đọc hai thứ, chỉ đọc, không ghi gì bên KiotViet:
     · danh sách món   /api/products  → đổi ProductId ra mã SP
     · hóa đơn kèm chi tiết /api/invoices?Includes=["InvoiceDetails"] của từng ngày
   Cộng lại thành số lượng + doanh thu từng mã từng ngày, rồi ghi vào Firestore `ops_sales/{cơ sở}_{tháng}`
   theo kiểu "THAY THEO NGÀY": ngày nào có trong lần chạy thì thay số của ngày đó, ngày khác giữ nguyên
   — chạy mỗi giờ bao nhiêu lần cũng không cộng trùng. Cùng định dạng với tab Xuất bán của app
   (salesMergeDays trong index.html), nên tab Xuất sử dụng NVL / Hàng hóa đọc được ngay.

   Cùng lượt đọc đó robot lấy luôn SỔ QUỸ: phần thanh toán (Payments) của từng hóa đơn — tiền mặt hay
   chuyển khoản, số tiền, mã QR KOV… trong nội dung chuyển khoản — rồi ghi `ops_revenue/{cơ sở}_{ngày}`
   đúng định dạng RevImport của tab Doanh thu & Target (lines: c=mã, t=phút, a=tiền, m='c'|'b'), nên
   tab Doanh thu & Target và tab Đối soát doanh thu dùng được ngay, chỉ còn nạp sao kê. Ngày nào kế
   toán đã nạp file tay (src 'file') thì robot không đè, trừ khi bật REV_OVERWRITE=1.

   Chạy:  node sync.mjs                       → hôm nay (trước 2h sáng thì kéo cả hôm qua để chốt ngày)
          DATES=2026-09-23 node sync.mjs      → một ngày
          DATES=2026-09-01..2026-09-22 node sync.mjs
          DRY_RUN=1 ...                       → chỉ in ra, không ghi Firestore
          REV_OVERWRITE=1 ...                 → ghi đè cả ngày doanh thu đã nạp file tay
   Biến môi trường (GitHub Secrets): KV_SHOP, KV_USER, KV_PASS, FIREBASE_SA (JSON khoá service account),
   KV_BRANCH_MAP (JSON: mã chi nhánh KiotViet -> id cơ sở trong app, mặc định {"10249361":"B1"} = Hí Hế Hậu Giang).
   REPO CÔNG KHAI: log GitHub Actions ai cũng xem được, nên robot KHÔNG in số tiền — chỉ in số hóa đơn / số món.
   Muốn xem tiền khi chạy ở máy mình thì đặt SHOW_MONEY=1.
   ===================================================================== */
import { chromium } from 'playwright';
import admin from 'firebase-admin';

const env = (k, d) => (process.env[k] == null || process.env[k] === '' ? d : process.env[k]);
const SHOP = env('KV_SHOP', 'hihecf');
const BASE = `https://fnb.kiotviet.vn/${SHOP}`;
const DRY = !!env('DRY_RUN', '') && env('DRY_RUN', '') !== '0' && env('DRY_RUN', '') !== 'false';
const BRANCH_MAP = JSON.parse(env('KV_BRANCH_MAP', '{"10249361":"B1"}'));
const REV_OVER = ['1', 'true'].includes(env('REV_OVERWRITE', ''));
const SHOW_MONEY = ['1', 'true'].includes(env('SHOW_MONEY', ''));
const vnd = (n) => SHOW_MONEY ? Math.round(n).toLocaleString('vi-VN') + 'đ' : '***';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ---- Ngày theo giờ Việt Nam ---- */
const vnNow = () => new Date(Date.now() + 7 * 3600e3);
const vnToday = () => vnNow().toISOString().slice(0, 10);
const addDay = (d, n) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); };
const datesToRun = () => {
  const s = env('DATES', '').trim();
  if (s) {
    const [a, b] = s.split('..').map(x => x.trim());
    const out = []; for (let d = a; d <= (b || a); d = addDay(d, 1)) out.push(d);
    return out;
  }
  const t = vnToday();
  /* Hóa đơn cuối ngày có thể chốt sau 0h — lần chạy đầu ngày kéo lại cả hôm qua */
  return vnNow().getUTCHours() < 2 ? [addDay(t, -1), t] : [t];
};

/* ---- Đăng nhập KiotViet ---- */
async function login(page) {
  const user = env('KV_USER'), pass = env('KV_PASS');
  if (!user || !pass) throw new Error('Thiếu KV_USER / KV_PASS (GitHub Secrets)');
  await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.fill('#UserName', user);
  await page.fill('#Password', pass);
  await Promise.all([
    page.waitForURL(u => /\/man\//.test(String(u)) || /\/sale/.test(String(u)), { timeout: 60000 }).catch(() => null),
    page.click('#btn-login'),
  ]);
  await page.waitForTimeout(2500);
  const url = page.url();
  if (!/\/man\//.test(url)) {
    /* Còn đứng ở trang login: captcha, sai mật khẩu, hoặc KiotViet hỏi xác minh thiết bị */
    const cap = await page.$('#ShowCaptcha[value="True"], .captcha, [id*="aptcha"] img');
    const msg = ((await page.textContent('body').catch(() => '')) || '').replace(/\s+/g, ' ').slice(0, 300);
    throw new Error((cap ? 'KiotViet bắt nhập CAPTCHA — robot dừng, cần đăng nhập tay một lần. ' : 'Đăng nhập không thành công. ') + 'URL: ' + url.split('?')[0] + (SHOW_MONEY ? ' · ' + msg : ''));
  }
  log('Đã đăng nhập KiotViet', url);
}

/* ---- Đọc dữ liệu bằng phiên vừa đăng nhập (chạy trong trang, cùng cookie) ---- */
async function readKiot(page, dates, branchIds) {
  await page.goto(BASE + '/man/#/DashBoard', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);
  return page.evaluate(async ({ dates, branchIds }) => {
    const get = async (u) => {
      const r = await fetch(u, { credentials: 'include' });
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + u.slice(0, 80));
      return r.json();
    };
    const nd = (d) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd + 1)).toISOString().slice(0, 10); };
    const cats = await get('/api/categories?format=json');
    const cm = {}; (cats.Data || cats || []).forEach(c => { cm[c.Id] = c.Name; });
    const pr = await get('/api/products?format=json&$top=1000&$inlinecount=allpages');
    const prod = {}; (pr.Data || []).forEach(p => { prod[p.Id] = { code: p.Code, name: p.Name, unit: p.Unit || '', group: cm[p.CategoryId] || '' }; });
    const out = [];
    /* Một dòng sổ quỹ cho mỗi lần thanh toán: khách trả nửa tiền mặt nửa chuyển khoản thành 2 dòng.
       Mã dòng ưu tiên mã QR KOV… trong nội dung thanh toán — sao kê ngân hàng ghi đúng mã này nên
       tab Đối soát ráp được; không có thì lấy mã hóa đơn, trùng mã trong hóa đơn thì thêm hậu tố. */
    const payLines = (v) => {
      const t = String(v.PurchaseDate || '').slice(11, 16).split(':').map(Number);
      const mins = (t[0] || 0) * 60 + (t[1] || 0);
      const pays = (v.Payments || []).filter(p => +p.Amount);
      if (!pays.length) return [{ c: v.Code || '', t: mins, a: +v.Total || 0, m: '' }];
      const seen = {};
      return pays.map(p => {
        /* Mã QR đầu kỳ có dấu cách ("KOVQR Q3ALSM"), về sau viết liền ("KOVQR071TL9K2M V") */
        const kov = (String(p.Description || '').match(/KOVQR\s+[A-Z0-9]+|KOV[A-Z0-9]+/i) || [])[0];
        let c = kov || v.Code || '';
        seen[c] = (seen[c] || 0) + 1; if (seen[c] > 1) c += '-' + seen[c];
        return { c, t: mins, a: +p.Amount || 0, m: p.Method === 'Cash' ? 'c' : 'b', pm: p.Method };
      });
    };
    for (const bid of branchIds) {
      for (const d of dates) {
        const agg = {}; const book = []; let skip = 0, total = 0, inv = 0, sum = 0;
        do {
          const flt = `((BranchId eq ${bid}) and PurchaseDate ge datetime'${d}T00:00:00+07:00' and PurchaseDate lt datetime'${nd(d)}T00:00:00+07:00' and (Status eq 1 or Status eq 3))`;
          const u = '/api/invoices?format=json&Includes=' + encodeURIComponent('["InvoiceDetails","Payments"]') + '&$top=100&$skip=' + skip
            + '&$orderby=PurchaseDate%20desc&$inlinecount=allpages&$filter=' + encodeURIComponent(flt) + '&BranchIds=' + encodeURIComponent('[' + bid + ']');
          const j = await get(u);
          total = j.Total || 0;
          (j.Data || []).forEach(v => {
            inv++; sum += +v.Total || 0;
            book.push(...payLines(v));
            (v.InvoiceDetails || []).forEach(x => {
              const p = prod[x.ProductId] || { code: 'ID' + x.ProductId, name: x.ProductName || ('Món #' + x.ProductId), unit: '', group: '' };
              const o = agg[p.code] || (agg[p.code] = { ...p, qty: 0, amount: 0 });
              o.qty += +x.Quantity || 0; o.amount += +x.SubTotal || 0;
            });
          });
          skip += 100;
          await new Promise(r => setTimeout(r, 400));
        } while (skip < total);
        out.push({ kvBranch: String(bid), date: d, invoices: inv, total, sum, book, items: Object.values(agg) });
      }
    }
    return out;
  }, { dates, branchIds });
}

/* ---- Gộp "thay theo ngày" — cùng thuật toán với salesMergeDays trong app ---- */
function mergeDays(old, g) {
  const dates = Object.keys(g.days);
  const items = JSON.parse(JSON.stringify((old || {}).items || {}));
  Object.keys(items).forEach(k => {
    const o = items[k];
    dates.forEach(dk => {
      if (o.d && o.d[dk] != null) { o.qty = (+o.qty || 0) - (+o.d[dk] || 0); delete o.d[dk]; }
      if (o.da && o.da[dk] != null) { o.amount = (+o.amount || 0) - (+o.da[dk] || 0); delete o.da[dk]; }
    });
    if (Math.abs(o.qty) < 1e-9 && !Object.keys(o.d || {}).length) delete items[k];
  });
  Object.keys(g.items).forEach(k => {
    const s = g.items[k];
    const o = items[k] || (items[k] = { name: s.name, unit: s.unit, group: s.group, qty: 0, amount: 0 });
    o.qty += s.qty; o.amount += s.amount;
    o.d = o.d || {}; Object.keys(s.d).forEach(dk => { o.d[dk] = (o.d[dk] || 0) + s.d[dk]; });
    o.da = o.da || {}; Object.keys(s.da).forEach(dk => { o.da[dk] = (o.da[dk] || 0) + s.da[dk]; });
  });
  const days = JSON.parse(JSON.stringify((old || {}).days || {}));
  dates.forEach(dk => { days[dk] = { ...g.days[dk] }; });
  return { items, days };
}

/* ---- Sổ quỹ → ops_revenue/{cơ sở}_{ngày}, cùng định dạng RevImport của app ---- */
function revenueDoc(r, now) {
  const bid = BRANCH_MAP[r.kvBranch];
  const cash = r.book.filter(l => l.m === 'c').reduce((a, l) => a + l.a, 0);
  const bank = r.book.filter(l => l.m === 'b').reduce((a, l) => a + l.a, 0);
  return {
    branchId: bid, date: r.date, amount: r.sum, invoices: r.invoices, cash, bank,
    /* chặn 900 dòng/ngày như RevImport để doc không chạm giới hạn 1MB */
    lines: r.book.slice(0, 900).map(({ c, t, a, m }) => ({ c, t, a, m })),
    src: 'kv', at: now, by: 'robot-kiotviet',
  };
}
async function writeRevenue(db, raw, now) {
  let wrote = 0, kept = 0;
  for (const r of raw) {
    const bid = BRANCH_MAP[r.kvBranch];
    if (!bid) continue;
    const ref = db.collection('ops_revenue').doc(bid + '_' + r.date);
    const old = await ref.get();
    if (!REV_OVER && old.exists && old.data().src === 'file') { kept++; continue; }
    /* ngày chưa bán gì mà cũng chưa có bản ghi thì khỏi tạo doc rỗng */
    if (!r.invoices && !old.exists) continue;
    await ref.set(revenueDoc(r, now));
    wrote++;
  }
  log(`Sổ quỹ → ops_revenue: ghi ${wrote} ngày` + (kept ? `, giữ nguyên ${kept} ngày đã nạp file tay` : ''));
  return { wrote, kept };
}

async function main() {
  /* Chưa nhập GitHub Secrets thì bỏ qua êm, không báo đỏ mỗi giờ trong lúc chờ cấu hình */
  if (!env('KV_USER') && !env('KV_PASS') && !env('FIREBASE_SA')) {
    log('Chưa cấu hình KV_USER / KV_PASS / FIREBASE_SA trong GitHub Secrets — bỏ qua lần chạy này.');
    return;
  }
  const dates = datesToRun();
  const kvBranches = Object.keys(BRANCH_MAP);
  log('Ngày cần kéo:', dates.join(', '), '· chi nhánh KiotViet:', kvBranches.join(', '), DRY ? '· DRY RUN' : '');

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh' });
  const page = await ctx.newPage();
  let raw;
  try {
    await login(page);
    raw = await readKiot(page, dates, kvBranches);
  } catch (e) {
    await page.screenshot({ path: 'loi-kiotviet.png', fullPage: true }).catch(() => {});
    throw e;
  } finally {
    await browser.close();
  }

  /* Gom theo cơ sở app + tháng */
  const G = {};
  raw.forEach(r => {
    const bid = BRANCH_MAP[r.kvBranch];
    const ym = r.date.slice(0, 7);
    const g = G[bid + '|' + ym] || (G[bid + '|' + ym] = { bid, ym, items: {}, days: {}, rows: 0 });
    const day = g.days[r.date] = { qty: 0, amount: 0 };   /* ngày không bán gì vẫn phải ghi 0 để xoá số cũ */
    r.items.forEach(x => {
      const o = g.items[x.code] || (g.items[x.code] = { name: x.name, unit: x.unit, group: x.group, qty: 0, amount: 0, d: {}, da: {} });
      o.qty += x.qty; o.amount += x.amount;
      o.d[r.date] = (o.d[r.date] || 0) + x.qty; o.da[r.date] = (o.da[r.date] || 0) + x.amount;
      day.qty += x.qty; day.amount += x.amount; g.rows++;
    });
    const pm = {}; r.book.forEach(l => { const k = l.pm || '(chưa trả)'; pm[k] = (pm[k] || 0) + l.a; });
    /* Không in số tiền (repo công khai) — chỉ số hóa đơn, số món, và CÓ những hình thức thanh toán nào */
    log(`  ${r.date} · KV ${r.kvBranch} → ${bid}: ${r.invoices}/${r.total} hóa đơn, ${Math.round(day.qty)} món, ${vnd(day.amount)}`
      + ` · sổ quỹ ${vnd(r.sum)} · ` + (SHOW_MONEY ? JSON.stringify(pm) : Object.keys(pm).join(', ')));
    if (r.invoices !== r.total) throw new Error('Đọc thiếu hóa đơn ngày ' + r.date);
  });
  const unknown = raw.flatMap(r => r.items.filter(x => x.code.startsWith('ID')).map(x => x.code));
  if (unknown.length) log('⚠ Món không tìm thấy mã:', [...new Set(unknown)].join(', '));

  if (DRY) { log('DRY RUN — không ghi Firestore'); return; }

  const sa = env('FIREBASE_SA');
  if (!sa) throw new Error('Thiếu FIREBASE_SA (GitHub Secret: JSON khoá service account Firebase)');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(sa)) });
  const db = admin.firestore();
  const now = new Date().toISOString();
  const rev = await writeRevenue(db, raw, now);
  for (const g of Object.values(G)) {
    const id = g.bid + '_' + g.ym;
    const ref = db.collection('ops_sales').doc(id);
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const old = snap.exists ? snap.data() : null;
      const { items, days } = mergeDays(old, g);
      tx.set(ref, {
        id, branchId: g.bid, ym: g.ym, items, days,
        rows: Object.keys(items).length,
        upAt: now, upBy: 'robot-kiotviet', upName: 'Robot KiotViet',
      });
    });
    log('Đã ghi ops_sales/' + id);
  }
  /* Nhịp tim: app đọc để biết robot chạy lần cuối lúc nào, có lỗi gì không */
  await db.collection('ops_robot').doc('kiotviet').set({
    ok: true, at: now, dates, err: '',
    qty: raw.reduce((a, r) => a + r.items.reduce((s, x) => s + x.qty, 0), 0),
    invoices: raw.reduce((a, r) => a + r.invoices, 0),
    rev,
  });
}

main().catch(async (e) => {
  console.error('LỖI:', e && e.message ? e.message : e);
  try {
    const sa = env('FIREBASE_SA');
    if (sa && !DRY) {
      if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(sa)) });
      await admin.firestore().collection('ops_robot').doc('kiotviet').set(
        { ok: false, at: new Date().toISOString(), err: String((e && e.message) || e).slice(0, 500) }, { merge: true });
    }
  } catch (_) { /* ghi nhịp tim lỗi không được thì thôi, GitHub vẫn báo đỏ */ }
  process.exit(1);
});
