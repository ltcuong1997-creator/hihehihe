# Bot Zalo nội bộ Hí Hế — hướng dẫn cài

Port từ bot ZSpace (`zspacemusicbox/functions/zalo.js`), rút gọn còn phần lõi:

- Nhân viên kết nối Zalo với hồ sơ trong app bằng **mã 6 số**, rồi nhắn **DONG Y** (đồng ý lưu tin nhắn).
- Lệnh: **LICH** (lịch làm 7 ngày tới của chính mình), **GIUP**, **HUY KET NOI**.
- Người lạ nhắn bot chỉ nhận 1 câu hướng dẫn mỗi ngày, không lộ dữ liệu gì.
- Tính giới hạn gói Zalo Bot miễn phí: tối đa 50 người, 3.000 tin gửi đi mỗi tháng (từ 80% bot chỉ trả lời lệnh, 95% báo ADMIN).
- ADMIN xem danh sách kết nối, nhật ký tin nhắn, hạn mức ở **Cấu hình › Hệ thống › Bot Zalo**.

Chưa có (ZSpace có, làm sau nếu cần): trợ lý AI, nhóm Zalo, báo cáo 0h, tự báo sự cố.

## Các file

| File | Việc |
|---|---|
| `functions/zalo.js` | Toàn bộ logic bot |
| `functions/index.js` | Khai báo 4 hàm: `zaloHook`, `zaloProcess`, `zaloLinkCode`, `zaloUnlink` (vùng `asia-southeast1`) |
| `functions/scripts/selftest-zalo.js` | 29 ca kiểm thử, không cần mạng: `cd functions && npm test` |
| `functions/scripts/zalo-setup.mjs` | Kiểm token, tạo mã bí mật, đặt webhook |
| `firestore.rules` | Khoá 5 bảng `ops_z*`: chỉ máy chủ ghi, chỉ ADMIN đọc nhật ký |
| `index.html` | Thẻ "Kết nối Zalo" trong Hồ sơ của tôi + tab "Bot Zalo" |

## Cài lần đầu

### 0. Điều kiện

- Firebase project `hihehihe` phải ở **gói Blaze** (trả theo dùng, phải gắn thẻ) vì Cloud Functions không chạy trên gói Spark miễn phí. Với lượng tin của một quán thì gần như 0đ, nhưng nên đặt cảnh báo ngân sách trong Google Cloud Billing.
- Máy có Node 22 và Firebase CLI: `npm i -g firebase-tools`, rồi `firebase login`.

### 1. Tạo bot Zalo, lấy token

1. Trong app Zalo, tìm tài khoản **Zalo Bot Manager**, chọn **Tạo bot**. Tên bot phải bắt đầu bằng "Bot", ví dụ `Bot Hí Hế`.
2. Tạo xong, Zalo gửi **token** của bot vào tin nhắn. Token có dạng `123456789:abcXYZ...`.
3. **Không dán token vào code, vào chat hay vào file nào trong repo.** Repo này để công khai.

### 2. Kiểm token và tạo mã bí mật webhook

```bash
cd functions
npm install
node scripts/zalo-setup.mjs me
```

Dán token khi được hỏi. Nếu đúng, script in ra tên bot.

```bash
node scripts/zalo-setup.mjs secret
```

Lệnh này in ra một chuỗi ngẫu nhiên. Đó là **mã bí mật webhook**, giữ tạm lại cho bước 3 và bước 5.

### 3. Lưu token + mã bí mật vào Secret Manager

Chạy ở gốc repo:

```bash
firebase functions:secrets:set ZALO_BOT_TOKEN
```

```bash
firebase functions:secrets:set ZALO_WEBHOOK_SECRET
```

Mỗi lệnh sẽ hỏi giá trị: lệnh thứ nhất dán token, lệnh thứ hai dán mã bí mật.

### 4. Deploy luật Firestore và các hàm

```bash
firebase deploy --only firestore:rules
```

```bash
firebase deploy --only functions
```

Lần đầu deploy, Google sẽ tự bật vài API (Cloud Functions, Cloud Build, Eventarc, Secret Manager…). Nếu báo lỗi kiểu "permissions for Eventarc… retry in a few minutes" thì đợi 2–5 phút rồi chạy lại lệnh deploy functions.

Khi xong, terminal in ra URL của `zaloHook`, dạng `https://zalohook-xxxxx-as.a.run.app` hoặc `https://asia-southeast1-hihehihe.cloudfunctions.net/zaloHook`. Copy URL này.

### 5. Đặt webhook cho bot

```bash
cd functions
node scripts/zalo-setup.mjs webhook https://DÁN-URL-zaloHook-Ở-ĐÂY
```

Dán token và mã bí mật (đúng cái đã lưu ở bước 3) khi được hỏi. Kiểm lại:

```bash
node scripts/zalo-setup.mjs info
```

Nếu script báo lỗi, bạn cũng có thể đặt webhook trong trang quản lý bot của Zalo. Khi đó, điền URL ở bước 4 và **Secret token** là mã bí mật ở bước 2.

### 6. Bật app

1. Merge nhánh này vào `main`. CI sẽ tự deploy app.
2. ADMIN mở **Voucher nhân viên › Cài đặt › Cập nhật danh sách**. Luật Firestore dùng danh sách ADMIN ở đó (`ops_vacl/main.admins`) để cho phép đọc nhật ký bot. Nếu bỏ qua bước này, tab Bot Zalo báo "Chưa có quyền đọc".
3. Mở **Cấu hình › Hệ thống › Bot Zalo** và chọn vai trò được dùng bot (mặc định là GS, AM, OM, ADMIN; có thể thêm từng người).
4. Thử: **Hồ sơ của tôi › Kết nối Zalo › Lấy mã kết nối**. Nhắn mã cho bot, nhắn `DONG Y`, rồi nhắn `LICH`.

## Gỡ lỗi

| Hiện tượng | Nguyên nhân thường gặp |
|---|---|
| Nhắn bot không thấy trả lời | Webhook chưa đặt, hoặc mã bí mật ở bước 5 khác bước 3. Mở Firebase Console › Functions › Logs, nếu thấy `zaloHook: sai hoặc thiếu header bí mật` thì là lệch mã bí mật. Đặt lại cả 2 chỗ, sau đó chạy lại `firebase deploy --only functions` để hàm nhận secret mới. |
| Log `sendMessage lỗi: http 401` | Token sai hoặc đã đổi. Chạy lại `secrets:set ZALO_BOT_TOKEN`, rồi deploy lại functions. |
| App báo "Chưa kết nối được máy chủ" / lỗi `not-found` khi lấy mã | Các hàm chưa được deploy, hoặc deploy sai vùng (phải là `asia-southeast1`). |
| "Tài khoản của bạn chưa được dùng bot Zalo" | Vai trò của người đó chưa được tick trong tab Bot Zalo. |
| Tab Bot Zalo báo "Chưa có quyền đọc" | Chưa deploy luật mới (bước 4), hoặc chưa làm bước 6.2. |

Đổi bot (tạo bot mới) chỉ cần làm lại bước 1, 3, 5, rồi deploy lại functions. Liên kết cũ gắn với tài khoản Zalo của nhân viên, nên mọi người phải kết nối lại với bot mới.
