/* ===================== CLOUD FUNCTIONS — HÍ HẾ =====================
   Hiện chỉ có BOT ZALO NỘI BỘ (port từ ZSpace, rút gọn — xem zalo.js). Hướng dẫn cài từ đầu:
   HUONG-DAN-ZALO-BOT.md ở gốc repo.
     · zaloHook     — webhook công khai: kiểm header X-Bot-Api-Secret-Token (sai -> 401), lưu tin vào
                      ops_zmsg (mã tin Zalo làm id, create() chống trùng) rồi trả 200 ngay
     · zaloProcess  — chạy khi có document mới trong ops_zmsg: xử lý lệnh, gửi trả lời
     · zaloLinkCode — nhân viên xin mã 6 số để kết nối (Hồ sơ của tôi › Kết nối Zalo)
     · zaloUnlink   — tự ngắt, hoặc ADMIN ngắt hộ
   CHỈ ĐỌC ops_config (khoá `zalo`), không bao giờ ghi.

   Khoá nằm trong Secret Manager (KHÔNG BAO GIỜ commit — repo này công khai):
     firebase functions:secrets:set ZALO_BOT_TOKEN
     firebase functions:secrets:set ZALO_WEBHOOK_SECRET   (8–256 ký tự, khai trùng ở setWebhook)
*/
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
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
const zalo = ZL.createZalo({
  db, FV: FieldValue, HttpsError, findEmp, log: logger,
  /* trim: đặt secret bằng `echo ... | firebase functions:secrets:set` sẽ dính ký tự xuống dòng ở cuối
     -> mọi webhook bị 401. Token Zalo và secret_token không có khoảng trắng hai đầu. */
  getToken: () => String(ZALO_BOT_TOKEN.value() || '').trim(),
  getSecret: () => String(ZALO_WEBHOOK_SECRET.value() || '').trim(),
});
const ZL_OPTS = { region: REGION, memory: '256MiB', cpu: LOW_CPU };

/* Webhook chỉ cần mã bí mật — không nạp token gửi tin vào hàm công khai này */
exports.zaloHook = onRequest({ ...ZL_OPTS, secrets: [ZALO_WEBHOOK_SECRET], invoker: 'public', timeoutSeconds: 30, maxInstances: 5 },
  (req, res) => zalo.hook(req, res));

/* Tin đi (dir 'out') cũng nằm trong ops_zmsg -> lọc ngay từ dữ liệu sự kiện, khỏi tốn lượt đọc */
exports.zaloProcess = onDocumentCreated({ ...ZL_OPTS, document: ZL.COL.msg + '/{id}', secrets: [ZALO_BOT_TOKEN], timeoutSeconds: 60, retry: false, maxInstances: 5 },
  async (ev) => {
    const d = ev.data && ev.data.data();
    if (!d || d.dir !== 'in' || d.st !== 'new') return;
    await zalo.processIn(ev.params.id);
  });

exports.zaloLinkCode = onCall({ ...ZL_OPTS, cpu: 1, secrets: [ZALO_BOT_TOKEN], timeoutSeconds: 30 }, (req) => zalo.linkCode(req));
exports.zaloUnlink = onCall({ ...ZL_OPTS, cpu: 1, timeoutSeconds: 30 }, (req) => zalo.unlink(req));
