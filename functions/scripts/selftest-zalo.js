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
    select: () => query(c, filters),
    limit: () => query(c, filters),
    get: async () => {
      const docs = Object.keys(store).filter(k => k.startsWith(c + '/')).map(k => snap(c, k.slice(c.length + 1)))
        .filter(s => filters.every(([f, op, v]) => {
          const x = s.data()[f];
          return op === '==' ? x === v : op === '>=' ? x >= v : op === '<=' ? x <= v : op === 'in' ? v.includes(x) : false;
        }));
      return { docs, empty: !docs.length, size: docs.length };
    },
    count: () => ({ get: async () => { const r = await query(c, filters).get(); return { data: () => ({ count: r.size }) }; } }),
  });
  const db = {
    store,
    collection: (c) => ({ doc: (id) => docRef(c, id), where: (f, op, v) => query(c, [[f, op, v]]), select: () => query(c), get: () => query(c).get() }),
    getAll: async (...refs) => Promise.all(refs.map(r => r.get())),
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
    chat: { id: o.gid || o.zid || 'z1', chat_type: o.chatType || (o.gid ? 'GROUP' : 'PRIVATE') },
    text,
  },
});
/* Claude giả: mỗi lần gọi trả bước kế tiếp trong kịch bản; ghi lại tham số các lần gọi */
function fakeClaude(script) {
  const calls = [];
  const create = async (params) => {
    calls.push(JSON.parse(JSON.stringify(params)));
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    const usage = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    if (step.tool) return { stop_reason: 'tool_use', usage, content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'tool_use', id: 't' + calls.length, name: step.tool, input: step.input || {} }] };
    return { stop_reason: 'end_turn', usage, content: [{ type: 'text', text: step.text }] };
  };
  return { calls, messages: { create: async (p) => { const r = await create(p); r._plain = true; return r; } }, beta: { messages: { create } } };
}
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
  db.store['ops_employees/E1'] = { id: 'E1', name: 'Lan', role: 'GS', status: 'active', authUid: 'u1', email: 'lan@x.vn', branches: ['B1'] };
  db.store['ops_employees/E2'] = { id: 'E2', name: 'Minh', role: 'NV', status: 'active', authUid: 'u2', branches: ['B1'] };
  db.store['ops_employees/A1'] = { id: 'A1', name: 'Sếp', role: 'ADMIN', status: 'active', authUid: 'ua' };
  const findEmp = async (req) => {
    const r = await db.collection('ops_employees').where('authUid', '==', req.auth.uid).get();
    return r.empty ? null : { id: r.docs[0].id, ...r.docs[0].data() };
  };
  const claude = opts.claude || null;
  const z = Z.createZalo({ db, FV, HttpsError, findEmp, log, now: () => NOW, getToken: () => '123:abc', getSecret: () => SECRET, fetchFn: zl.fetchFn,
    getAiKey: () => (claude ? 'sk-test' : ''), makeAiClient: () => claude });
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
  const link = async (uid, zid) => { const r = await z.linkCode({ auth: { uid }, data: {} }); await say(r.code, { zid }); await say('DONG Y', { zid }); };
  return { db, zl, log, z, say, link, call: (fn, uid, data) => z[fn]({ auth: { uid }, data: data || {} }) };
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
  await t('tin nhóm KHÔNG gọi bot (chat thường) -> 200, không lưu, không trả lời', async () => {
    const w = world(); const n = Object.keys(w.db.store).length;
    await w.say('lich', { gid: 'g1' });
    assert.strictEqual(Object.keys(w.db.store).length, n);
    assert.strictEqual(w.zl.sent.length, 0);
  });
  await t('groupCall: "bot ơi, doanh thu?" -> "doanh thu?"; "/lich" -> "lich"; chat thường -> null', () => {
    assert.strictEqual(Z.groupCall('Bot ơi, doanh thu hôm nay?'), 'doanh thu hôm nay?');
    assert.strictEqual(Z.groupCall('/lich'), 'lich');
    assert.strictEqual(Z.groupCall('@Bot Hí Hế ket noi nhom', 'Bot Hí Hế'), 'ket noi nhom');
    assert.strictEqual(Z.groupCall('bottle nước'), null);
    assert.strictEqual(Z.groupCall('hôm nay vui ghê'), null);
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

  console.log('nhóm Zalo ban quản trị');
  await t('nhóm chưa gắn: gọi bot -> nhắc cách gắn 1 lần/ngày', async () => {
    const w = world();
    await w.say('bot doanh thu', { gid: 'g1', zid: 'zx' });
    await w.say('bot doanh thu nữa', { gid: 'g1', zid: 'zx' });
    assert.strictEqual(w.zl.sent.length, 1); assert.ok(/chưa được gắn/.test(w.zl.last()));
    assert.strictEqual(w.zl.sent[0].chat_id, 'g1');
  });
  await t('người không phải ADMIN không gắn được nhóm; ADMIN đã kết nối gắn được', async () => {
    const w = world();
    await w.link('u1', 'zl');
    await w.say('bot ket noi nhom', { gid: 'g1', zid: 'zl' });
    assert.ok(/Chỉ ADMIN/.test(w.zl.last()));
    await w.link('ua', 'za');
    await w.say('@Bot ket noi nhom', { gid: 'g1', zid: 'za' });
    assert.ok(/Đã gắn nhóm/.test(w.zl.last()));
    assert.strictEqual(w.db.store['ops_zgroup/g1'].active, true);
    await w.call('groupOff', 'ua', { groupId: 'g1' });
    assert.strictEqual(w.db.store['ops_zgroup/g1'].active, false);
  });

  await t('@tag bot tên không bắt đầu bằng "Bot" (lấy tên qua getMe) -> vẫn gắn được nhóm', async () => {
    const w = world();
    const f0 = w.zl.fetchFn;
    w.z = Z.createZalo({ db: w.db, FV, HttpsError, findEmp: async (req) => { const r = await w.db.collection('ops_employees').where('authUid', '==', req.auth.uid).get(); return r.empty ? null : { id: r.docs[0].id, ...r.docs[0].data() }; },
      log: quietLog(), now: () => NOW, getToken: () => '123:abc', getSecret: () => SECRET,
      fetchFn: async (url, init) => /getMe$/.test(url) ? { status: 200, json: async () => ({ ok: true, result: { id: 'b1', account_name: 'Hí Hế Trợ Lý' } }) } : f0(url, init) });
    const say = async (text, o) => { const ev = textEvt(text, o); await w.z.hook(mkReq({ headers: goodHdr, body: ev }), mkRes()); const id = Z.inDocId(ev.message.message_id); if (w.db.store['ops_zmsg/' + id]) await w.z.processIn(id); };
    const r = await w.z.linkCode({ auth: { uid: 'ua' }, data: {} });
    await say(r.code, { zid: 'za' }); await say('DONG Y', { zid: 'za' });
    await say('@Hí Hế Trợ Lý ket noi nhom', { gid: 'g9', zid: 'za' });
    assert.ok(w.db.store['ops_zgroup/g9'] && w.db.store['ops_zgroup/g9'].active === true, w.zl.last());
  });
  await t('nhóm chưa gắn: gõ sai lệnh gắn nhóm -> lần nào cũng nhắc (không im)', async () => {
    const w = world();
    await w.say('bot ket noi nhom di', { gid: 'g2', zid: 'zx' });
    await w.say('bot ket noi nhom', { gid: 'g2', zid: 'zx' });
    assert.strictEqual(w.zl.sent.length, 2);
  });

  console.log('trợ lý AI');
  const REV = { 'ops_revenue/B1_2026-11-15': { branchId: 'B1', date: '2026-11-15', amount: 5250000, invoices: 80, cash: 2000000, bank: 3250000, wallet: 0, at: '2026-11-15T02:30:00Z' } };
  await t('hỏi tự do -> gọi công cụ doanh_thu -> trả lời, cộng chi phí AI, Opus dùng fallbacks', async () => {
    const cl = fakeClaude([{ tool: 'doanh_thu', input: { tu_ngay: '2026-11-15', den_ngay: '2026-11-15' } }, { text: '**Doanh thu** hôm nay: 5.250.000đ' }]);
    const w = world({ claude: cl });
    Object.assign(w.db.store, REV);
    await w.link('u1', 'z1');
    await w.say('doanh thu hôm nay bao nhiêu');
    assert.strictEqual(w.zl.last(), 'Doanh thu hôm nay: 5.250.000đ', 'phải gỡ markdown');
    assert.strictEqual(cl.calls[0].model, 'claude-opus-5-5');
    assert.strictEqual(cl.calls[0].fallbacks, 'default');
    assert.ok(!('temperature' in cl.calls[0]) && !('thinking' in cl.calls[0]));
    const tr = cl.calls[1].messages[cl.calls[1].messages.length - 1].content[0];
    assert.strictEqual(tr.type, 'tool_result');
    const out = JSON.parse(tr.content);
    assert.strictEqual(out.tong, 5250000);
    assert.strictEqual(cl.calls[1].messages[cl.calls[1].messages.length - 2].content[0].type, 'thinking', 'phải gửi lại khối thinking nguyên vẹn');
    assert.ok(w.db.store['ops_zquota/2026-11'].ai.usd > 0);
  });
  await t('GS không có quyền trang Doanh thu? -> công cụ báo lỗi quyền (NV)', async () => {
    const cl = fakeClaude([{ tool: 'doanh_thu', input: { tu_ngay: '2026-11-15', den_ngay: '2026-11-15' } }, { text: 'Anh/chị không có quyền xem doanh thu.' }]);
    const w = world({ claude: cl, cfg: { zalo: { allowRoles: ['NV', 'GS', 'ADMIN'] } } });
    Object.assign(w.db.store, REV);
    await w.link('u2', 'z2');
    await w.say('doanh thu hôm nay', { zid: 'z2' });
    const tr = cl.calls[1].messages[cl.calls[1].messages.length - 1].content[0];
    assert.ok(JSON.parse(tr.content).loi, 'NV phải bị chặn');
    assert.strictEqual(tr.is_error, true);
  });
  await t('Haiku: gọi messages.create thường (không fallbacks)', async () => {
    const cl = fakeClaude([{ text: 'Chào anh/chị.' }]);
    const w = world({ claude: cl, cfg: { zalo: { aiModel: 'claude-haiku-5-5' } } });
    await w.link('u1', 'z1');
    await w.say('chào em');
    assert.strictEqual(cl.calls[0].model, 'claude-haiku-5-5');
    assert.ok(!('fallbacks' in cl.calls[0]));
  });
  await t('báo sự cố: AI soạn nháp -> chưa ghi; nhắn OK -> tạo ops_issues (src zalo)', async () => {
    const cl = fakeClaude([{ tool: 'soan_bao_su_co', input: { chi_nhanh: 'B1', loai: 'máy pha', muc_do: 'KHAN', tieu_de: 'Máy pha không lên nhiệt' } }, { text: 'Em đã soạn báo sự cố máy pha.' }]);
    const w = world({ claude: cl });
    await w.link('u1', 'z1');
    await w.say('máy pha hư rồi');
    assert.ok(/BẢN NHÁP/.test(w.zl.last()) && /Nhắn OK/.test(w.zl.last()));
    assert.ok(!Object.keys(w.db.store).some(k => k.startsWith('ops_issues/')));
    await w.say('ok');
    const iss = Object.entries(w.db.store).find(([k]) => k.startsWith('ops_issues/'));
    assert.ok(iss, 'phải tạo sự cố');
    assert.strictEqual(iss[1].src, 'zalo'); assert.strictEqual(iss[1].by, 'E1'); assert.strictEqual(iss[1].status, 'MOI');
    assert.strictEqual(iss[1].cat, 'Máy pha chế'); assert.strictEqual(iss[1].sev, 'KHAN');
    assert.ok(/Đã gửi báo sự cố/.test(w.zl.last()));
  });
  await t('đề xuất mua: khớp danh mục -> nháp -> OK -> ops_preq status wait', async () => {
    const items = [{ code: 'SD01', name: 'Sữa đặc Ông Thọ', unit: 'hộp', group: 'Nguyên liệu' }, { code: 'CF01', name: 'Cà phê hạt', unit: 'kg', group: 'Nguyên liệu' }, { code: 'LY01', name: 'Ly nhựa 500', unit: 'cây', group: 'Bao bì' }];
    const cl = fakeClaude([{ tool: 'soan_de_xuat_mua', input: { chi_nhanh: 'B1', hang: [{ ten: 'sữa đặc', so_luong: 10 }, { ten: 'CF01', so_luong: 2 }] } }, { text: 'Em đã soạn đề xuất mua.' }]);
    const w = world({ claude: cl, cfg: { items } });
    await w.link('u1', 'z1');
    await w.say('đặt 10 hộp sữa đặc với 2kg cà phê');
    assert.ok(/BẢN NHÁP/.test(w.zl.last()));
    await w.say('OK');
    const pq = Object.entries(w.db.store).find(([k]) => k.startsWith('ops_preq/'));
    assert.ok(pq, 'phải tạo đề xuất');
    assert.strictEqual(pq[1].status, 'wait'); assert.strictEqual(pq[1].group, 'Nguyên liệu'); assert.strictEqual(pq[1].items.length, 2);
    assert.strictEqual(pq[1].items[0].code, 'SD01'); assert.strictEqual(pq[1].items[0].qty, 10);
  });
  await t('đề xuất mua: món khác nhóm -> công cụ từ chối, không soạn', async () => {
    const items = [{ code: 'SD01', name: 'Sữa đặc', unit: 'hộp', group: 'Nguyên liệu' }, { code: 'LY01', name: 'Ly nhựa', unit: 'cây', group: 'Bao bì' }];
    const cl = fakeClaude([{ tool: 'soan_de_xuat_mua', input: { chi_nhanh: 'B1', hang: [{ ten: 'sữa đặc', so_luong: 1 }, { ten: 'ly nhựa', so_luong: 1 }] } }, { text: 'Cần tách 2 đề xuất.' }]);
    const w = world({ claude: cl, cfg: { items } });
    await w.link('u1', 'z1');
    await w.say('mua sữa đặc với ly nhựa');
    const out = JSON.parse(cl.calls[1].messages[cl.calls[1].messages.length - 1].content[0].content);
    assert.ok(/một nhóm hàng/.test(out.loi));
    assert.ok(!/BẢN NHÁP/.test(w.zl.last()));
  });
  await t('nhắn HUY -> bỏ nháp, không ghi gì', async () => {
    const cl = fakeClaude([{ tool: 'soan_bao_su_co', input: { chi_nhanh: 'B1', loai: 'Điện', muc_do: 'CAO', tieu_de: 'Mất điện tầng 2' } }, { text: 'Đã soạn.' }]);
    const w = world({ claude: cl });
    await w.link('u1', 'z1');
    await w.say('tầng 2 mất điện');
    await w.say('huỷ');
    assert.ok(/Đã bỏ bản nháp/.test(w.zl.last()));
    assert.ok(!Object.keys(w.db.store).some(k => k.startsWith('ops_issues/')));
  });
  await t('người kết nối từ trước bản AI (consentV 1): hỏi đồng ý lại, DONG Y -> consentV 2', async () => {
    const cl = fakeClaude([{ text: 'x' }]);
    const w = world({ claude: cl });
    await w.link('u1', 'z1');
    w.db.store['ops_zlink/z1'].consentV = 1;
    await w.say('lich');
    assert.ok(/trợ lý AI/.test(w.zl.last()) && /DONG Y/.test(w.zl.last()));
    await w.say('đồng ý');
    assert.strictEqual(w.db.store['ops_zlink/z1'].consentV, Z.CONSENT_V);
    assert.strictEqual(cl.calls.length, 0, 'chưa đồng ý thì không gọi AI');
  });
  await t('chưa đồng ý AI: câu hỏi tự do -> nhắc DONG Y (không trả "chưa hiểu"); DONG Y bất cứ lúc nào cũng nhận', async () => {
    const cl = fakeClaude([{ text: 'Doanh thu hôm nay 5 triệu.' }]);
    const w = world({ claude: cl });
    await w.link('u1', 'z1');
    w.db.store['ops_zlink/z1'].consentV = 1;
    await w.say('giup');
    await w.say('doanh thu hôm nay');
    assert.ok(/DONG Y/.test(w.zl.last()) && !/chưa hiểu/.test(w.zl.last()), w.zl.last());
    await w.say('doanh thu hôm nay');
    assert.ok(/DONG Y/.test(w.zl.last()));
    w.db.store['ops_zguard/z1'].aiAsk = false;
    await w.say('dong y');
    assert.strictEqual(w.db.store['ops_zlink/z1'].consentV, Z.CONSENT_V);
    await w.say('doanh thu hôm nay');
    assert.strictEqual(w.zl.last(), 'Doanh thu hôm nay 5 triệu.');
  });
  await t('chạm trần chi phí AI -> báo hết ngân sách, không gọi AI', async () => {
    const cl = fakeClaude([{ text: 'x' }]);
    const w = world({ claude: cl, cfg: { zalo: { aiCapUsd: 1 } } });
    await w.link('u1', 'z1');
    w.db.store['ops_zquota/2026-11'].ai = { usd: 1.5 };
    await w.say('doanh thu tuần này');
    assert.ok(/hết ngân sách/.test(w.zl.last()));
    assert.strictEqual(cl.calls.length, 0);
  });
  await t('nhóm đã gắn: người CHƯA kết nối hỏi số liệu được (quyền nhóm), soạn ghi thì bị chặn', async () => {
    const cl = fakeClaude([{ tool: 'doanh_thu', input: { tu_ngay: '2026-11-15', den_ngay: '2026-11-15' } }, { tool: 'soan_bao_su_co', input: { chi_nhanh: 'B1', loai: 'Điện', muc_do: 'CAO', tieu_de: 'x' } }, { text: 'Doanh thu 5.250.000đ. Báo sự cố cần kết nối.' }]);
    const w = world({ claude: cl });
    Object.assign(w.db.store, REV);
    w.db.store['ops_zgroup/g1'] = { active: true };
    await w.say('bot doanh thu hôm nay, báo luôn mất điện', { gid: 'g1', zid: 'stranger' });
    const r1 = JSON.parse(cl.calls[1].messages[cl.calls[1].messages.length - 1].content[0].content);
    const r2 = JSON.parse(cl.calls[2].messages[cl.calls[2].messages.length - 1].content[0].content);
    assert.strictEqual(r1.tong, 5250000);
    assert.ok(/kết nối Zalo/.test(r2.loi));
    assert.strictEqual(w.zl.sent[w.zl.sent.length - 1].chat_id, 'g1');
  });
  await t('công cụ ban_theo_mon / nguoi_trong_ca / tra_cuu đọc đúng dữ liệu Hí Hế', async () => {
    const w = world();
    const T2 = require('../zalotools').createTools({ db: w.db, now: () => NOW, log: quietLog(), fetchFn: async () => ({}), helpers: { dayVN: Z.dayVN, dAdd: Z.dAdd, buildWeek: Z.buildWeek, fmtWeek: Z.fmtWeek } });
    w.db.store['ops_sales/B1_2026-11'] = { branchId: 'B1', ym: '2026-11', items: {
      BX: { name: 'Bạc xỉu', group: 'Cà phê', unit: 'ly', qty: 50, amount: 1450000, d: { '2026-11-14': 20, '2026-11-15': 30 }, da: { '2026-11-14': 580000, '2026-11-15': 870000 } },
      TD: { name: 'Trà đào', group: 'Trà', unit: 'ly', qty: 5, amount: 175000, d: { '2026-11-15': 5 }, da: { '2026-11-15': 175000 } },
    } };
    w.db.store['ops_attendance/E1_2026-11-15'] = { empId: 'E1', date: '2026-11-15', branchId: 'B1', shift: 'S1', inAt: '2026-11-15T00:05:00Z', outAt: '', late: 5 };
    w.db.store['ops_attendance/E2_2026-11-15'] = { empId: 'E2', date: '2026-11-15', branchId: 'B1', shift: 'S1', inAt: '2026-11-15T00:00:00Z', outAt: '2026-11-15T02:00:00Z', late: 0 };
    const cfg = w.db.store['ops_config/main'];
    const admin = { id: 'A1', name: 'Sếp', role: 'ADMIN', status: 'active', branches: [] };
    const c = T2.ctxOf(cfg, admin, { zaloId: 'z' });
    const b = await T2.run(c, 'ban_theo_mon', { tu_ngay: '2026-11-15', den_ngay: '2026-11-15' });
    assert.strictEqual(b.mon[0].mon, 'Bạc xỉu'); assert.strictEqual(b.mon[0].so_luong, 30); assert.strictEqual(b.tong_doanh_thu, 1045000);
    const n = await T2.run(c, 'nguoi_trong_ca', {});
    assert.strictEqual(n.chi_nhanh[0].so_nguoi, 1); assert.strictEqual(n.chi_nhanh[0].nguoi[0].ten, 'Lan'); assert.strictEqual(n.chi_nhanh[0].nguoi[0].vao_luc, '07:05');
    const tc = await T2.run(c, 'tra_cuu', { loai: 'cham_cong', tu_ngay: '2026-11-15', den_ngay: '2026-11-15', dem_theo: 'empId', tong_theo: 'late' });
    assert.strictEqual(tc.so_ban_ghi, 2); assert.strictEqual(tc.nhom[0].gia_tri, 'Lan'); assert.strictEqual(tc.nhom[0].tong, 5);
    const nv = T2.ctxOf(cfg, { id: 'E2', role: 'NV', branches: ['B1'] }, { zaloId: 'z' });
    const own = await T2.run(nv, 'tra_cuu', { loai: 'cham_cong', tu_ngay: '2026-11-15', den_ngay: '2026-11-15' });
    assert.strictEqual(own.chi_cua_nguoi_hoi, true); assert.strictEqual(own.so_ban_ghi, 1);
    const deny = await T2.run(nv, 'tra_cuu', { loai: 'doanh_thu_ngay' });
    assert.ok(deny.loi);
  });
  await t('tra_cuu che trường nhạy cảm (SĐT, lương) ở nhân sự', async () => {
    const L = require('../zalolookup');
    const c = L.compact({ name: 'Lan', phone: '0909', email: 'a@b', hourRate: 25000, base: 1, role: 'GS', bankAcc: '123' }, L.SRC.nhan_su);
    assert.deepStrictEqual(Object.keys(c).sort(), ['name', 'role']);
  });

  console.log('\n' + pass + ' ca kiểm thử đều qua.');
})().catch(e => { console.error('\nLỖI:', e && e.stack || e); process.exit(1); });
