/* =====================================================================
   ROBOT KIOTVIET → TẢI SỔ QUỸ (chạy tay, theo yêu cầu)
   ---------------------------------------------------------------------
   Đăng nhập web quản lý KiotViet F&B như người thật, đọc trang Sổ quỹ (mọi phiếu thu / chi, không chỉ
   hoá đơn bán hàng) trong khoảng ngày yêu cầu.
   MODE=discover : chỉ dò trang Sổ quỹ gọi API nào — log ĐƯỜNG DẪN + TÊN CỘT + SỐ DÒNG, không in tiền.
   MODE=export   : kéo toàn bộ phiếu trong FROM..TO, ghi CSV rồi MÃ HOÁ bằng khoá công khai PUBKEY
                   (RSA-OAEP bọc khoá AES-256-GCM). Repo CÔNG KHAI: file trên GitHub chỉ là bản mã,
                   chỉ ai giữ khoá riêng mới mở được. Không in số tiền ra log.
   ===================================================================== */
import { chromium } from 'playwright';
import crypto from 'crypto';
import fs from 'fs';

const env = (k, d) => (process.env[k] == null || process.env[k] === '' ? d : process.env[k]);
const SHOP = env('KV_SHOP', 'hihecf');
const BASE = `https://fnb.kiotviet.vn/${SHOP}`;
const MODE = env('MODE', 'discover');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function login(page) {
  const user = env('KV_USER'), pass = env('KV_PASS');
  if (!user || !pass) throw new Error('Thiếu KV_USER / KV_PASS');
  await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.fill('#UserName', user);
  await page.fill('#Password', pass);
  await Promise.all([
    page.waitForURL(u => /\/man\//.test(String(u)) || /\/sale/.test(String(u)), { timeout: 60000 }).catch(() => null),
    page.click('#btn-login'),
  ]);
  await page.waitForTimeout(2500);
  if (!/\/man\//.test(page.url())) throw new Error('Đăng nhập KiotViet không thành công: ' + page.url().split('?')[0]);
  log('Đã đăng nhập KiotViet');
}

/* Dò: mở các đường dẫn có thể là trang Sổ quỹ, ghi lại mọi lệnh gọi /api/ trả JSON */
async function discover(page) {
  const seen = [];
  page.on('response', async (r) => {
    const u = r.url();
    if (!/\/api\//i.test(u) || !/json/.test(r.headers()['content-type'] || '')) return;
    try {
      const j = await r.json();
      const data = Array.isArray(j) ? j : (j.Data || j.data || null);
      const first = Array.isArray(data) && data.length ? data[0] : null;
      seen.push({ url: u.replace(BASE, ''), total: j.Total != null ? j.Total : (Array.isArray(data) ? data.length : '-'),
        top: Array.isArray(j) ? '(array)' : Object.keys(j).slice(0, 25).join(','), keys: first ? Object.keys(first).join(',') : '' });
    } catch (e) {}
  });
  for (const route of ['CashFlow', 'CashBook', 'Cashbook', 'CashFlows', 'Fund']) {
    const n0 = seen.length;
    await page.goto(BASE + '/man/#/' + route, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(7000);
    const title = ((await page.title().catch(() => '')) || '') + ' | ' + (((await page.textContent('h1, .page-title, .title-page').catch(() => '')) || '').trim().slice(0, 40));
    log('== route #/' + route, '→', page.url().replace(BASE, ''), '·', title, '·', seen.length - n0, 'lệnh API');
    seen.slice(n0).forEach(s => {
      if (/cash|fund|quy|payment|receipt|voucher/i.test(s.url)) log('   *', s.url.slice(0, 400), '| total', s.total, '| top', s.top, '| cột', s.keys.slice(0, 900));
      else log('    ', s.url.slice(0, 160));
    });
  }
}

async function main() {
  if (!env('KV_USER')) { log('Chưa có KV_USER — bỏ qua'); return; }
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh', viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  try {
    await login(page);
    if (MODE === 'discover') await discover(page);
    else throw new Error('MODE chưa hỗ trợ: ' + MODE);
  } finally { await browser.close(); }
}
main().catch(e => { console.error('LỖI:', e.message); process.exit(1); });
