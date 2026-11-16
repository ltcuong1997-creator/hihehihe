/* Công cụ cài bot Zalo cho Hí Hế — chạy trên máy của chủ, KHÔNG chạy trên máy chủ.
   Token chỉ nhập lúc chạy (hoặc biến môi trường ZALO_BOT_TOKEN), không lưu vào file nào.

     cd functions
     node scripts/zalo-setup.mjs secret                 tạo mã bí mật webhook ngẫu nhiên (để dán vào secrets:set)
     node scripts/zalo-setup.mjs me                     kiểm token: in tên + id bot
     node scripts/zalo-setup.mjs webhook <URL zaloHook> đặt webhook (hỏi token + mã bí mật)
     node scripts/zalo-setup.mjs info                   xem webhook đang đặt
     node scripts/zalo-setup.mjs unhook                 gỡ webhook

   API theo tài liệu Zalo Bot Platform (bot.zaloplatforms.com/docs): POST
   https://bot-api.zaloplatforms.com/bot<TOKEN>/<method>, body JSON, trả { ok, result | error_code, description }.
   setWebhook nhận { url, secret_token } — secret_token 8–256 ký tự, Zalo gửi lại trong header
   X-Bot-Api-Secret-Token ở mỗi lần gọi webhook. */
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { stdin, stdout, env, argv, exit } from 'node:process';

const BASE = 'https://bot-api.zaloplatforms.com';

const ask = async (q) => {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try { return String(await rl.question(q)).trim(); } finally { rl.close(); }
};
const token = async () => String(env.ZALO_BOT_TOKEN || '').trim() || ask('Dán token bot Zalo: ');

async function call(tk, method, payload) {
  const r = await fetch(`${BASE}/bot${tk}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(payload || {}),
  });
  let j = null;
  try { j = await r.json(); } catch (_) { /* không phải JSON */ }
  if (!j || j.ok !== true) {
    /* không in URL (có token) */
    throw new Error(`${method} lỗi: http ${r.status}` + (j ? ` · ${j.error_code || ''} ${j.description || ''}` : ''));
  }
  return j.result;
}

const [cmd, arg] = argv.slice(2);
try {
  if (cmd === 'secret') {
    console.log(crypto.randomBytes(24).toString('base64url'));
  } else if (cmd === 'me') {
    const r = await call(await token(), 'getMe');
    console.log('Token đúng. Bot:', r && r.account_name, '· id:', r && r.id);
  } else if (cmd === 'webhook') {
    const url = String(arg || '').trim();
    if (!/^https:\/\/\S+$/.test(url)) throw new Error('Thiếu URL https của hàm zaloHook, vd: node scripts/zalo-setup.mjs webhook https://asia-southeast1-hihehihe.cloudfunctions.net/zaloHook');
    const tk = await token();
    const sec = String(env.ZALO_WEBHOOK_SECRET || '').trim() || await ask('Dán mã bí mật webhook (đúng cái đã đặt ở ZALO_WEBHOOK_SECRET): ');
    if (sec.length < 8 || sec.length > 256) throw new Error('Mã bí mật phải dài 8–256 ký tự');
    const r = await call(tk, 'setWebhook', { url, secret_token: sec });
    console.log('Đã đặt webhook:', url);
    if (r && typeof r === 'object') console.log(JSON.stringify(r));
  } else if (cmd === 'info') {
    console.log(JSON.stringify(await call(await token(), 'getWebhookInfo'), null, 2));
  } else if (cmd === 'unhook') {
    await call(await token(), 'deleteWebhook');
    console.log('Đã gỡ webhook');
  } else {
    console.log('Lệnh: secret | me | webhook <URL> | info | unhook  (xem đầu file)');
    exit(cmd ? 1 : 0);
  }
} catch (e) {
  console.error(e.message || e);
  exit(1);
}
