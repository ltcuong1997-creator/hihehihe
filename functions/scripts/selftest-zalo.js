/* Kiểm thử bot Zalo — chạy: cd functions && npm test
   KHÔNG cần mạng, không cần emulator: phần thuần của zalo.js + cả luồng (webhook -> xử lý -> trả lời)
   chạy trên Firestore giả trong bộ nhớ, máy chủ Zalo giả ghi lại tin đã gửi. */
const assert = require('assert');
const Z = require('../zalo');

let pass = 0;
const t = async (name, fn) => { await fn(); pass++; console.log('  OK  ' + name); };

const SECRET = 'bi-mat-thu-123456';
let NOW = Date.parse('2026-11-15T03:00:00Z'); /* 10:00 sáng giờ VN, Chủ nhật 15/11/2026 */

/* ---------- Firestore giả: đủ cho zalo.js ---------- */
const FV = {
  serverTimestamp: () => ({ __ts: true }),
  increment: (n) => ({ __inc: n }),
  delete: () => ({ __del: true }),
};
function applyPatch(old, patch) {
  const out = { ...(old || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v && v.__del) delete out[k];
    else if (v && typeof v.__inc === 'number') out[k] = (Number(out[k]) || 0) + v.__inc;
    else if (v && v.__ts) out[k] = NOW;
    else if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') out[k] = applyPatch(out[k], v);
    else if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = applyPatch({}, v);
    else out[k] = v;
  }
  return out;
}
function fakeDb() {
  const store = {};
  const snap = (c, id) => {
    const k = c + '/' + id;
    return { id, exists: k in store, data: () => (k in store ? JSON.parse(JSON.stringify(store[k])) : undefined), ref: docRef(c, id) };
  };
  const docRef = (c, id) => ({
    _k: c + '/' + id, id,
    get: async () => snap(c, id),
    set: async (d, o) => { store[c + '/' + id] = o && o.merge ? applyPatch(store[c + '/' + id], d) : applyPatch({}, d); },
    update: async (d) => { if (!(c + '/' + id in store)) { const e = new Error('NOT_FOUND'); e.code = 5; throw e; } store[c + '/' + id] = applyPatch(store[c + '/' + id], d); },
    create: async (d) => { if (c + '/' + id in store) { const e = new Error('6 ALREADY_EXISTS: Document already exists'); e.code = 6; throw e; } store[c + '/' + id] = applyPatch({}, d); },
    delete: async () => { delete store[c + '/' + id]; },
  });
  const query = (c, filters = []) => ({
    where: (f, op, v) => query(c, filters.concat([[f, op, v]])),
    get: async () => {
      const docs = Object.keys(store).filter(k => k.startsWith(c + '/')).map(k => snap(c, k.slice(c.length + 1)))
        .filter(s => filters.every(([f, op, v]) => {
          const x = s.data()[f];
          return op === '==' ? x === v : op === '>=' ? x >= v : op === '<=' ? x <= v : false;
        }));
      return { docs, empty: !docs.length, size: docs.length };
    },
    count: () => ({ get: async () => { const r = await query(c, filters).get(); return { data: () => ({ count: r.size }) }; } }),
  });
  const db = {
    store,
    collection: (c) => ({ doc: (id) => docRef(c, id), where: (f, op, v) => query(c, [[f, op, v]]), get: () => query(c).get() }),
    runTransaction: async (fn) => fn({
      get: (r) => r.get(),
      set: (r, d, o) => r.set(d, o), update: (r, d) => r.update(d), create: (r, d) => r.create(d),
    }),
    batch: () => { const ops = []; return { delete: (r) => ops.push(() => r.delete()), commit: async () => { for (const o of ops) await o(); } }; },
  };
  return db;
}

const quietLog = () => { const l = { warns: [], errors: [] }; l.warn = (...a) => l.warns.push(a); l.error = (...a) => l.errors.push(a); return l; };
const mkReq = ({ method = 'POST', headers = {}, body } = {}) => {
  const h = {};
  for (const k of Object.keys(headers)) h[k.toLowerCase()] = headers[k];
  return { method, headers: h, body, get: (n) => h[String(n).toLowerCase()] };
};
const mkRes = () => {
  const r = { code: null, json_: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (j) => { r.json_ = j; return r; };
  return r;
};
const goodHdr = { 'X-Bot-Api-Secret-Token': SECRET, 'Content-Type': 'application/json' };
let msgSeq = 0;
const textEvt = (text, o = {}) => ({
  event_name: 'message.text.received',
  message: {
    message_id: 'm' + (++msgSeq), date: NOW, message_type: 'CHAT_TEXT',
    from: { id: o.zid || 'z1', display_name: 'Ted', is_bot: false },
    chat: { id: o.zid || 'z1', chat_type: o.chatType || 'PRIVATE' },
    text,
  },
});
class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

/* Máy chủ Zalo giả: ghi lại tin gửi */
function fakeZalo() {
  const sent = [];
  const fetchFn = async (url, init) => {
    const method = url.split('/').pop();
    const body = JSON.parse(init.body || '{}');
    if (!/\/bot123:abc\//.test(url)) return { status: 401, json: async () => ({ ok: false, error_code: 401, description: 'Unauthorized' }) };
    if (method === 'getMe') return { status: 200, json: async () => ({ ok: true, result: { id: 'b1', account_name: 'Bot Hí Hế' } }) };
    if (method === 'sendMessage') { sent.push(body); return { status: 200, json: async () => ({ ok: true, result: { message_id: 'o' + sent.length } }) }; }
    return { status: 404, json: async () => ({ ok: false, error_code: 404, description: 'not found' }) };
  };
  return { sent, fetchFn, last: () => (sent[sent.length - 1] || {}).text || '' };
}

function world(opts = {}) {
  const db = fakeDb();
  const zl = fakeZalo();
  const log = quietLog();
  db.store['ops_config/main'] = {
    branches: [{ id: 'B1', name: 'Hí Hế 1' }, { id: 'B9', name: 'Đã đóng', status: 'closed' }],
    shifts: [{ id: 'S1', name: 'Ca sáng', start: '07:00', end: '12:00' }, { id: 'S2', name: 'Ca tối', start: '17:00', end: '22:00' }],
    ...(opts.cfg || {}),
  };
  db.store['ops_employees/E1'] = { id: 'E1', name: 'Lan', role: 'GS', status: 'active', authUid: 'u1', email: 'lan@x.vn' };
  db.store['ops_employees/E2'] = { id: 'E2', name: 'Minh', role: 'NV', status: 'active', authUid: 'u2' };
  db.store['ops_employees/A1'] = { id: 'A1', name: 'Sếp', role: 'ADMIN', status: 'active', authUid: 'ua' };
  const findEmp = async (req) => {
    const r = await db.collection('ops_employees').where('authUid', '==', req.auth.uid).get();
    return r.empty ? null : { id: r.docs[0].id, ...r.docs[0].data() };
  };
  const z = Z.createZalo({ db, FV, HttpsError, findEmp, log, now: () => NOW, getToken: () => '123:abc', getSecret: () => SECRET, fetchFn: zl.fetchFn });
  /* Gửi một tin như Zalo gọi webhook, rồi chạy zaloProcess như trigger Firestore */
  const say = async (text, o) => {
    const ev = textEvt(text, o);
    const res = mkRes();
    await z.hook(mkReq({ headers: goodHdr, body: ev }), res);
    assert.strictEqual(res.code, 200);
    const id = Z.inDocId(ev.message.message_id);
    if (db.store['ops_zmsg/' + id]) await z.processIn(id);
    return db.store['ops_zmsg/' + id];
  };
  return { db, zl, log, z, say, call: (fn, uid, data) => z[fn]({ auth: { uid }, data: data || {} }) };
}

(async () => {
  console.log('xác minh header');
  await t('đúng bí mật -> true', () => assert.strictEqual(Z.secretOk(SECRET, SECRET), true));
  await t('sai bí mật -> false', () => assert.strictEqual(Z.secretOk('sai', SECRET), false));
  await t('thiếu header -> false', () => assert.strictEqual(Z.secretOk(undefined, SECRET), false));
  await t('secret chưa cấu hình (rỗng) -> false, kể cả header rỗng', () => assert.strictEqual(Z.secretOk('', ''), false));
  await t('header dạng mảng -> false', () => assert.strictEqual(Z.secretOk([SECRET], SECRET), false));

  console.log('webhook zaloHook');
  await t('GET -> 405, không lưu gì', async () => {
    const w = world(); const res = mkRes(); const n = Object.keys(w.db.store).length;
    await w.z.hook(mkReq({ method: 'GET', headers: goodHdr }), res);
    assert.strictEqual(res.code, 405); assert.strictEqual(Object.keys(w.db.store).length, n);
  });
  await t('thiếu / sai header -> 401, không lưu gì', async () => {
    const w = world(); const n = Object.keys(w.db.store).length;
    const r1 = mkRes(); await w.z.hook(mkReq({ body: textEvt('lich') }), r1);
    const r2 = mkRes(); await w.z.hook(mkReq({ headers: { 'X-Bot-Api-Secret-Token': SECRET + 'x' }, body: textEvt('lich') }), r2);
    assert.strictEqual(r1.code, 401); assert.strictEqual(r2.code, 401);
    assert.strictEqual(Object.keys(w.db.store).length, n);
  });
  await t('đúng header -> lưu ops_zmsg/in_<mã tin> st=new, trả 200', async () => {
    const w = world(); const ev = textEvt('Lịch'); const res = mkRes();
    await w.z.hook(mkReq({ headers: goodHdr, body: ev }), res);
    const d = w.db.store['ops_zmsg/' + Z.inDocId(ev.message.message_id)];
    assert.strictEqual(res.code, 200); assert.ok(d);
    assert.strictEqual(d.dir, 'in'); assert.strictEqual(d.st, 'new'); assert.strictEqual(d.text, 'Lịch');
    assert.strictEqual(w.zl.sent.length, 0, 'webhook không được tự gửi tin');
  });
  await t('tin trùng (Zalo gửi lại) -> 200, giữ bản đầu', async () => {
    const w = world(); const ev = textEvt('một');
    await w.z.hook(mkReq({ headers: goodHdr, body: ev }), mkRes());
    ev.message.text = 'hai';
    const res = mkRes(); await w.z.hook(mkReq({ headers: goodHdr, body: ev }), res);
    assert.strictEqual(res.code, 200);
    assert.strictEqual(w.db.store['ops_zmsg/' + Z.inDocId(ev.message.message_id)].text, 'một');
  });
  await t('request kiểm tra không có message / body hỏng -> 200, không lưu', async () => {
    const w = world(); const n = Object.keys(w.db.store).length;
    const r1 = mkRes(); await w.z.hook(mkReq({ headers: goodHdr, body: {} }), r1);
    const r2 = mkRes(); await w.z.hook(mkReq({ headers: goodHdr, body: '{hỏng' }), r2);
    assert.strictEqual(r1.code, 200); assert.strictEqual(r2.code, 200);
    assert.strictEqual(Object.keys(w.db.store).length, n);
  });
  await t('tin trong nhóm -> 200, không lưu (Hí Hế chỉ chat riêng)', async () => {
    const w = world(); const n = Object.keys(w.db.store).length;
    await w.say('bot lich', { chatType: 'GROUP' });
    assert.strictEqual(Object.keys(w.db.store).length, n);
  });

  console.log('phân tích lệnh');
  const P = (s) => Z.parseCmd(s).cmd;
  await t('giúp / GIUP / help / ?', () => { ['giúp', 'GIUP', ' help ', '?', 'Giúp đỡ!'].forEach(s => assert.strictEqual(P(s), 'help', s)); });
  await t('lịch / LICH / xem lịch', () => { ['lịch', 'LICH', 'xem lịch', 'Lịch làm việc'].forEach(s => assert.strictEqual(P(s), 'lich', s)); });
  await t('huỷ kết nối / hủy kết nối / ngắt kết nối', () => { ['huỷ kết nối', 'hủy kết nối', 'HUY KET NOI', 'ngắt kết nối'].forEach(s => assert.strictEqual(P(s), 'unlink', s)); });
  await t('đồng ý / DONG Y / dongy', () => { ['đồng ý', 'DONG Y', 'dongy', 'Đồng ý.'].forEach(s => assert.strictEqual(P(s), 'agree', s)); });
  await t('mã 6 số, chấp nhận dấu cách / chấm', () => {
    assert.deepStrictEqual(Z.parseCmd('123456'), { cmd: 'code', code: '123456' });
    assert.deepStrictEqual(Z.parseCmd('123 456'), { cmd: 'code', code: '123456' });
    assert.strictEqual(P('12345'), 'unknown'); assert.strictEqual(P('1234567'), 'unknown');
  });

  console.log('hạn mức tin gửi');
  await t('< 80% gửi mọi loại; 80% chỉ trả lời + cảnh báo; 100% không gửi', () => {
    assert.strictEqual(Z.quotaGate('guide', 2399, 3000), true);
    assert.strictEqual(Z.quotaGate('guide', 2400, 3000), false);
    assert.strictEqual(Z.quotaGate('reply', 2999, 3000), true);
    assert.strictEqual(Z.quotaGate('alert', 2900, 3000), true);
    assert.strictEqual(Z.quotaGate('reply', 3000, 3000), false);
    assert.strictEqual(Z.needWarn95(2850, 3000, false), true);
    assert.strictEqual(Z.needWarn95(2850, 3000, true), false);
  });

  console.log('luồng đầy đủ');
  await t('người lạ nhắn -> 1 câu hướng dẫn, nhắn tiếp trong ngày -> im', async () => {
    const w = world();
    await w.say('xin chào');
    assert.strictEqual(w.zl.sent.length, 1); assert.ok(/Kết nối Zalo/.test(w.zl.last()));
    await w.say('alo');
    assert.strictEqual(w.zl.sent.length, 1);
  });
  await t('NV (không trong allowRoles mặc định) không lấy được mã', async () => {
    const w = world();
    await assert.rejects(w.call('linkCode', 'u2'), /chưa được dùng bot/);
  });
  await t('lấy mã -> nhắn mã -> DONG Y -> kết nối, zaloLinked=true, lưu đồng ý', async () => {
    const w = world();
    const r = await w.call('linkCode', 'u1');
    assert.ok(/^\d{6}$/.test(r.code)); assert.strictEqual(r.botName, 'Bot Hí Hế');
    await w.say(r.code);
    assert.ok(/DONG Y/.test(w.zl.last()));
    await w.say('đồng ý');
    assert.ok(/Chào Lan/.test(w.zl.last()));
    const l = w.db.store['ops_zlink/z1'];
    assert.strictEqual(l.active, true); assert.strictEqual(l.empId, 'E1'); assert.strictEqual(l.consentV, Z.CONSENT_V);
    assert.strictEqual(w.db.store['ops_employees/E1'].zaloLinked, true);
    assert.strictEqual(w.db.store['ops_zcode/' + r.code].used, true);
    assert.ok(w.db.store['ops_zquota/2026-11'].sent >= 2);
  });
  await t('LICH trả đúng lịch của chính người hỏi, bỏ chi nhánh đã đóng', async () => {
    const w = world();
    w.db.store['ops_schedule/B1_2026-11-15_S2'] = { branchId: 'B1', date: '2026-11-15', shiftId: 'S2', empIds: ['E1'] };
    w.db.store['ops_schedule/B1_2026-11-16_S1'] = { branchId: 'B1', date: '2026-11-16', shiftId: 'S1', empIds: ['E2'] };
    w.db.store['ops_schedule/B9_2026-11-17_S1'] = { branchId: 'B9', date: '2026-11-17', shiftId: 'S1', empIds: ['E1'] };
    const r = await w.call('linkCode', 'u1');
    await w.say(r.code); await w.say('DONG Y');
    await w.say('lịch');
    const txt = w.zl.last();
    assert.ok(/\(1 ca\)/.test(txt), txt);
    assert.ok(/CN 15\/11: Ca tối 17:00-22:00, Hí Hế 1/.test(txt), txt);
    assert.ok(/T2 16\/11: nghỉ/.test(txt), txt);
  });
  await t('HUY KET NOI -> ngắt, zaloLinked=false; nhắn tiếp -> người lạ', async () => {
    const w = world();
    const r = await w.call('linkCode', 'u1');
    await w.say(r.code); await w.say('dong y');
    await w.say('huỷ kết nối');
    assert.ok(/Đã ngắt kết nối/.test(w.zl.last()));
    assert.strictEqual(w.db.store['ops_zlink/z1'].active, false);
    assert.strictEqual(w.db.store['ops_employees/E1'].zaloLinked, false);
  });
  await t('nhân viên chuyển "Đã nghỉ" -> bot ngừng nhận lệnh', async () => {
    const w = world();
    const r = await w.call('linkCode', 'u1');
    await w.say(r.code); await w.say('dong y');
    w.db.store['ops_employees/E1'].status = 'off';
    await w.say('lich');
    assert.ok(/ngừng kết nối/.test(w.zl.last()));
    assert.strictEqual(w.db.store['ops_zlink/z1'].active, false);
  });
  await t('mã sai 5 lần trong 15 phút -> khoá', async () => {
    const w = world();
    for (let i = 0; i < 5; i++) await w.say('00000' + i);
    assert.ok(/sai mã quá nhiều/.test(w.zl.last()));
    assert.ok(w.db.store['ops_zguard/z1'].lockUntil > NOW);
  });
  await t('mã hết hạn -> từ chối', async () => {
    const w = world();
    const r = await w.call('linkCode', 'u1');
    NOW += 11 * 60e3;
    await w.say(r.code);
    assert.ok(/hết hạn/.test(w.zl.last()));
    assert.ok(!w.db.store['ops_zlink/z1']);
    NOW -= 11 * 60e3;
  });
  await t('mã đang chờ DONG Y ở Zalo khác -> Zalo thứ hai bị từ chối', async () => {
    const w = world();
    const r = await w.call('linkCode', 'u1');
    await w.say(r.code, { zid: 'z1' });
    await w.say(r.code, { zid: 'z2' });
    assert.ok(/không đúng hoặc đã hết hạn/.test(w.zl.last()));
  });
  await t('đủ chỗ (maxUsers) -> từ chối lấy mã', async () => {
    const w = world({ cfg: { zalo: { maxUsers: 1 } } });
    w.db.store['ops_zlink/zx'] = { empId: 'A1', active: true };
    await assert.rejects(w.call('linkCode', 'u1'), /đủ 1 người/);
  });
  await t('ADMIN ngắt hộ được; người thường không ngắt hộ người khác', async () => {
    const w = world();
    const r = await w.call('linkCode', 'u1');
    await w.say(r.code); await w.say('dong y');
    await assert.rejects(w.call('unlink', 'u2', { empId: 'E1' }), /Chỉ ADMIN/);
    const out = await w.call('unlink', 'ua', { empId: 'E1' });
    assert.strictEqual(out.n, 1);
    assert.strictEqual(w.db.store['ops_zlink/z1'].active, false);
  });
  await t('token không bao giờ nằm trong log / nhật ký khi gửi lỗi', async () => {
    const w = world();
    const z = Z.createZalo({ db: w.db, FV, HttpsError, findEmp: async () => null, log: w.log, now: () => NOW, getToken: () => 'SAI-TOKEN-999', getSecret: () => SECRET, fetchFn: w.zl.fetchFn });
    await z.send({ zaloId: 'z9', chatId: 'z9', kind: 'reply', text: 'thử' });
    const dump = JSON.stringify(w.db.store) + JSON.stringify(w.log.errors);
    assert.ok(!dump.includes('SAI-TOKEN-999'));
    assert.ok(Object.values(w.db.store).some(d => d.result === 'failed'));
  });

  console.log('\n' + pass + ' ca kiểm thử đều qua.');
})().catch(e => { console.error('\nLỖI:', e && e.stack || e); process.exit(1); });
