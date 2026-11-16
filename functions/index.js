/* ===================== CLOUD FUNCTIONS — HÍ HẾ =====================
   Hiện chỉ có BOT ZALO NỘI BỘ (port từ ZSpace — xem zalo.js, trợ lý AI ở zaloai.js + zalotools.js).
   Hướng dẫn cài từ đầu: HUONG-DAN-ZALO-BOT.md ở gốc repo.
     · zaloHook     — webhook công khai: kiểm header X-Bot-Api-Secret-Token (sai -> 401), lưu tin vào
                      ops_zmsg (mã tin Zalo làm id, create() chống trùng) rồi trả 200 ngay
     · zaloProcess  — chạy khi có document mới trong ops_zmsg: xử lý lệnh, gửi trả lời
     · zaloLinkCode — nhân viên xin mã 6 số để kết nối (Hồ sơ của tôi › Kết nối Zalo)
     · zaloUnlink   — tự ngắt, hoặc ADMIN ngắt hộ
     · zaloGroupOff — ADMIN gỡ một nhóm Zalo ban quản trị (gắn nhóm bằng lệnh "bot ket noi nhom" trong nhóm)
     · zaloReportDaily — 23:50 giờ VN: ảnh báo cáo ngày vào nhóm ban quản trị (zaloauto.js)
     · zaloTick     — mỗi 15 phút 7h–23h45: cảnh báo chưa vào ca / sự cố quá hạn / doanh thu tụt / việc chờ duyệt, 20h nhắc lịch
     · zaloReportTest — ADMIN gửi thử báo cáo hôm nay vào Zalo của chính mình
   CHỈ ĐỌC ops_config (khoá `zalo`), không bao giờ ghi.

   Khoá nằm trong Secret Manager (KHÔNG BAO GIỜ commit — repo này công khai):
     firebase functions:secrets:set ZALO_BOT_TOKEN
     firebase functions:secrets:set ZALO_WEBHOOK_SECRET   (8–256 ký tự, khai trùng ở setWebhook)
     firebase functions:secrets:set ANTHROPIC_API_KEY     (khoá API Claude, tạo ở console.anthropic.com)
*/
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const { FieldValue } = require('firebase-admin/firestore');
const ZL = require('./zalo');

admin.initializeApp();
const db = admin.firestore();

const REGION = 'asia-southeast1';   /* app gọi đúng vùng này (bootCloud: functions('asia-southeast1')) */
/* CPU thế hệ 1 (chia sẻ) — đủ cho bot nhắn tin, rẻ hơn hẳn CPU riêng */
const LOW_CPU = 'gcf_gen1';
const COL_EMP = 'ops_employees';

/* Tra hồ sơ của người gọi: 1) authUid (app tự ghép lần đăng nhập đầu) 2) email khớp nguyên văn.
   Cố ý KHÔNG quét cả bảng nhân sự. Không thấy thì người dùng đăng xuất rồi đăng nhập lại là xong. */
async function findEmp(req) {
  const uid = req.auth && req.auth.uid;
  const mail = String((req.auth && req.auth.token && req.auth.token.email) || '').trim();
  const q1 = await db.collection(COL_EMP).where('authUid', '==', uid).limit(1).get();
  if (!q1.empty) return { id: q1.docs[0].id, ...q1.docs[0].data() };
  if (mail) {
    const q2 = await db.collection(COL_EMP).where('email', '==', mail).limit(1).get();
    if (!q2.empty) return { id: q2.docs[0].id, ...q2.docs[0].data() };
  }
  return null;
}

const ZALO_BOT_TOKEN = defineSecret('ZALO_BOT_TOKEN');
const ZALO_WEBHOOK_SECRET = defineSecret('ZALO_WEBHOOK_SECRET');
/* Trợ lý AI — chỉ nạp vào zaloProcess */
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

/* ---- Ảnh gửi qua Zalo (ảnh lịch) -> Firebase Storage, link có mã tải ----
   Tên kho: dự án tạo trước 10/2024 thường là "<dự án>.appspot.com", sau đó là "<dự án>.firebasestorage.app"
   -> thử lần lượt, nhớ tên chạy được. Chưa bật Storage (Firebase Console › Storage › Bắt đầu) thì lỗi,
   bot tự quay về gửi lịch bằng chữ. Ảnh cũ hơn 14 ngày tự xoá (dọn mỗi lần gửi, tối đa 1 lần/giờ). */
const crypto = require('crypto');
const IMG_PREFIX = 'zalo-img/';
let okBucket = null, lastClean = 0;
const bucketNames = () => {
  let cfgB = '', pid = process.env.GCLOUD_PROJECT || '';
  try { const fc = JSON.parse(process.env.FIREBASE_CONFIG || '{}'); cfgB = fc.storageBucket || ''; pid = pid || fc.projectId || ''; } catch (e) { /* bỏ qua */ }
  return [...new Set([cfgB, pid && pid + '.firebasestorage.app', pid && pid + '.appspot.com'].filter(Boolean))];
};
async function uploadImage(png, name) {
  const tries = okBucket ? [okBucket] : bucketNames().map(n => admin.storage().bucket(n));
  const errs = [];
  for (const bucket of tries) {
    const file = bucket.file(IMG_PREFIX + name);
    const token = crypto.randomUUID();
    try {
      await file.save(png, { resumable: false, contentType: 'image/png', metadata: { cacheControl: 'public, max-age=604800', metadata: { firebaseStorageDownloadTokens: token } } });
    } catch (e) { errs.push(bucket.name + ': ' + String((e && e.message) || e).slice(0, 160)); continue; }
    okBucket = bucket;
    if (Date.now() - lastClean > 3600e3) {
      lastClean = Date.now();
      bucket.getFiles({ prefix: IMG_PREFIX }).then(([files]) => Promise.all(files
        .filter(f => Date.now() - Date.parse((f.metadata || {}).timeCreated || 0) > 14 * 864e5).map(f => f.delete().catch(() => {}))))
        .catch(() => {});
    }
    return 'https://firebasestorage.googleapis.com/v0/b/' + bucket.name + '/o/' + encodeURIComponent(IMG_PREFIX + name) + '?alt=media&token=' + token;
  }
  throw new Error('Không ghi được ảnh vào Storage (' + errs.join(' | ') + ')');
}

const zalo = ZL.createZalo({
  db, FV: FieldValue, HttpsError, findEmp, log: logger,
  /* trim: đặt secret bằng `echo ... | firebase functions:secrets:set` sẽ dính ký tự xuống dòng ở cuối
     -> mọi webhook bị 401. Token Zalo và secret_token không có khoảng trắng hai đầu. */
  getToken: () => String(ZALO_BOT_TOKEN.value() || '').trim(),
  getSecret: () => String(ZALO_WEBHOOK_SECRET.value() || '').trim(),
  getAiKey: () => { try { return String(ANTHROPIC_API_KEY.value() || '').trim(); } catch (e) { return ''; } },
  uploadImage,
});
const ZL_OPTS = { region: REGION, memory: '256MiB', cpu: LOW_CPU };

/* Webhook: mã bí mật để kiểm header; token chỉ để hỏi Zalo tên bot (getMe) — nhận ra tin @tag bot trong nhóm */
exports.zaloHook = onRequest({ ...ZL_OPTS, secrets: [ZALO_WEBHOOK_SECRET, ZALO_BOT_TOKEN], invoker: 'public', timeoutSeconds: 30, maxInstances: 5 },
  (req, res) => zalo.hook(req, res));

/* Tin đi (dir 'out') cũng nằm trong ops_zmsg -> lọc ngay từ dữ liệu sự kiện, khỏi tốn lượt đọc */
exports.zaloProcess = onDocumentCreated({ ...ZL_OPTS, memory: '1GiB', document: ZL.COL.msg + '/{id}', secrets: [ZALO_BOT_TOKEN, ANTHROPIC_API_KEY], timeoutSeconds: 180, retry: false, maxInstances: 5 },
  async (ev) => {
    const d = ev.data && ev.data.data();
    if (!d || d.dir !== 'in' || d.st !== 'new') return;
    await zalo.processIn(ev.params.id);
  });

exports.zaloLinkCode = onCall({ ...ZL_OPTS, cpu: 1, secrets: [ZALO_BOT_TOKEN], timeoutSeconds: 30 }, (req) => zalo.linkCode(req));
exports.zaloUnlink = onCall({ ...ZL_OPTS, cpu: 1, timeoutSeconds: 30 }, (req) => zalo.unlink(req));
exports.zaloGroupOff = onCall({ ...ZL_OPTS, cpu: 1, timeoutSeconds: 30 }, (req) => zalo.groupOff(req));
const TZ = 'Asia/Ho_Chi_Minh';
exports.zaloReportDaily = onSchedule({ ...ZL_OPTS, memory: '1GiB', schedule: '50 23 * * *', timeZone: TZ, retryCount: 0, secrets: [ZALO_BOT_TOKEN], timeoutSeconds: 300 },
  async () => { const r = await zalo.reportDaily(); logger.info('zalo: báo cáo ngày', { day: r.day, sent: r.sent, skipped: r.skipped || '', imgErr: r.imgErr || '' }); });
exports.zaloTick = onSchedule({ ...ZL_OPTS, memory: '512MiB', schedule: '*/15 7-23 * * *', timeZone: TZ, retryCount: 0, secrets: [ZALO_BOT_TOKEN], timeoutSeconds: 240 },
  async () => { const r = await zalo.autoTick(); if (r.sent) logger.info('zalo: tự báo', { sent: r.sent, kinds: r.kinds.join(',') }); });
exports.zaloReportTest = onCall({ ...ZL_OPTS, cpu: 1, memory: '1GiB', secrets: [ZALO_BOT_TOKEN], timeoutSeconds: 120 }, (req) => zalo.reportTest(req));
