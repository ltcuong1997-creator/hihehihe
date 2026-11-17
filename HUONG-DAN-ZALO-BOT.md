# Bot Zalo nội bộ Hí Hế — hướng dẫn cài

Port từ bot ZSpace (`zspacemusicbox/functions/zalo.js`):

- Nhân viên kết nối Zalo với hồ sơ trong app bằng **mã 6 số**, rồi nhắn **DONG Y** (đồng ý lưu tin nhắn và cho trợ lý AI xử lý).
- **Trợ lý AI (Claude)**: nhắn bình thường là bot hiểu. Bot đọc dữ liệu theo đúng quyền của người hỏi trong app (luật quyền trích nguyên văn từ `index.html`):
  - tra: doanh thu (kèm **nguồn đơn**: tại chỗ, mang về, GrabFood, ShopeeFood, beFood, kênh khác), món bán chạy, ai đang trong ca, sự cố, lịch, việc chờ duyệt, và tra cứu chung (chấm công, đi trễ, đơn công, đề xuất mua, phiếu mua hàng, đề nghị, thông báo, nộp tiền, thu chi, kiểm kho, xuất huỷ / điều chuyển, voucher nhân viên, nhân sự);
  - **ảnh lịch làm việc** tuần (của mình hoặc cả chi nhánh), cùng mẫu với ảnh lịch của app; lệnh nhanh `LICH` cũng gửi ảnh;
  - ghi vào app: **báo sự cố**, **phiếu huỷ hàng** (bắt buộc ảnh), **phiếu nhập bổ sung**, **đề nghị thanh toán chi phí** (chạy đúng chuỗi duyệt của app), **đề xuất mua hàng**, **duyệt / từ chối** đề xuất mua, đơn công, phiếu huỷ / nhập. Bot luôn soạn **bản nháp** trước, người dùng nhắn **OK** thì mới ghi thật. Phiếu huỷ / nhập do nhân viên lập nằm **chờ duyệt**, quản lý duyệt (qua bot hoặc trong app › Kho) xong mới trừ / cộng tồn; đề nghị thanh toán duyệt trong app › Đề xuất.
  - không tra được: lương, phiếu lương, thưởng phạt, thông tin riêng nhân viên, mã voucher.
  - phân tích: vì sao doanh thu tăng / tụt (so kỳ trước / tuần trước, theo nguồn, khung giờ, món tăng giảm), tiến độ target tháng, món bán chậm, **dự báo hết nguyên liệu** (tính đúng như trang Nhập-Xuất-Tồn) kèm gợi ý lượng mua, tìm người rảnh thay ca, công tháng của tôi, tra công thức pha chế;
  - đọc **ảnh hoá đơn nhà cung cấp** để soạn phiếu nhập / đề nghị thanh toán; soạn câu trả lời review của khách.
- **P&L qua Zalo** (17/11/2026): chủ (ADMIN) nhắn "chi 60tr tiền lương" → bot gửi danh sách nhóm chi phí đánh số 1–8 → nhắn số là ghi thẳng vào P&L (trong nhóm cũng chỉ cần nhắn `1`, không cần gõ chữ bot). Hỏi "lãi tháng này bao nhiêu" → bot trả P&L đúng như trang P&L. Ảnh báo cáo 23:50 có thêm khối P&L luỹ kế tháng.
  Trang P&L: doanh thu lấy Sổ quỹ; **giá vốn** chọn *Định mức* (số bán × giá vốn công thức) hoặc *Thực tế* (tồn đầu + tiền nhập hàng ± điều chuyển − tồn cuối, theo bản **chốt tồn** ở Kho); tab **Định mức vs thực tế** so từng nguyên liệu. Mã "Nhập hàng hóa" không vào chi phí (đã nằm trong giá vốn). Không dùng sao kê nữa (bật lại bằng `pnl.useStmt` trong cấu hình nếu cần).
- **Bot tự báo** (bật / tắt từng loại trong tab Bot Zalo): ảnh báo cáo cuối ngày 23:50, cảnh báo chưa vào ca / sự cố quá hạn / doanh thu 20h tụt / việc chờ duyệt quá 24 giờ, 20h nhắc riêng lịch ca ngày mai. Gửi vào nhóm ban quản trị; chưa gắn nhóm thì nhắn riêng OM / ADMIN đã kết nối.
- Lệnh nhanh không tốn AI: **LICH**, **GIUP**, **HUY KET NOI**.
- **Nhóm Zalo ban quản trị**: thêm bot vào nhóm, ADMIN (đã kết nối) gõ `bot ket noi nhom`. Trong nhóm, ai cũng hỏi được bằng `bot` + câu hỏi (số liệu theo quyền ADMIN, mọi chi nhánh). Việc ghi vào app chỉ người đã kết nối Zalo, theo quyền của chính họ, xác nhận bằng `ok` (hoặc `bot ok`). Chat bình thường trong nhóm bot không đọc.
- Người lạ nhắn bot chỉ nhận 1 câu hướng dẫn mỗi ngày, không lộ dữ liệu gì.
- Giới hạn gói Zalo Bot miễn phí: tối đa 50 người, 3.000 tin gửi đi mỗi tháng, 3 nhóm. Chi phí AI có trần USD/tháng, chạm trần thì AI tự tắt tới đầu tháng sau.
- ADMIN xem danh sách kết nối, nhóm, nhật ký tin nhắn, hạn mức và chi phí AI ở **Cấu hình › Hệ thống › Bot Zalo**; chọn model và trần chi phí ở đó.

Chưa có: đếm kho qua chat, checklist mở / đóng ca bằng ảnh, đối chiếu nộp tiền.

## Các file

| File | Việc |
|---|---|
| `functions/zalo.js` | Logic bot: webhook, kết nối, lệnh nhanh, nhóm, gọi AI |
| `functions/zaloai.js` | Gọi Claude: lời dặn, vòng lặp công cụ, tính chi phí |
| `functions/zalotools.js` | Các công cụ của AI: tra cứu + soạn nháp + ghi sau khi OK |
| `functions/zaloimg.js` | Vẽ ảnh lịch làm việc + ảnh báo cáo ngày (SVG -> PNG, font Space Grotesk trong `functions/fonts`) |
| `functions/zaloauto.js` | Bot tự báo: báo cáo 23:50, cảnh báo mỗi 15 phút, nhắc lịch 20h |
| `functions/zalolookup.js` | Tra cứu chung: loại dữ liệu nào, trang app nào mới được xem, trường nào bị che |
| `functions/apprules.js` | Luật quyền **sinh tự động** từ `index.html` bằng `node tools/zalo-sync-rules.js` — sửa phân quyền trong app thì chạy lại lệnh này rồi deploy functions |
| `functions/index.js` | Khai báo 5 hàm: `zaloHook`, `zaloProcess`, `zaloLinkCode`, `zaloUnlink`, `zaloGroupOff` (vùng `asia-southeast1`) |
| `functions/scripts/selftest-zalo.js` | 44 ca kiểm thử (dùng Claude giả), không cần mạng: `cd functions && npm test` |
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

## Bật trợ lý AI (khi bot đã chạy)

1. Lưu khoá API Claude lên Firebase (chạy ở folder `hihehihe`, thay `KHOA_API` bằng khoá tạo ở console.anthropic.com):
   ```powershell
   "KHOA_API" | firebase functions:secrets:set ANTHROPIC_API_KEY --data-file -
   ```
2. Lấy code mới rồi deploy lại luật và functions:
   ```powershell
   git pull
   firebase deploy --only firestore:rules
   firebase deploy --only functions
   ```
3. Vào **Cấu hình › Hệ thống › Bot Zalo**: kiểm tra đã tick **Bật trợ lý AI**, chọn model, đặt trần USD/tháng, rồi bấm **Lưu cài đặt**.
4. Người đã kết nối từ trước: lần nhắn kế tiếp bot sẽ hỏi đồng ý AI một lần, nhắn `DONG Y` là dùng được.
5. Nhóm ban quản trị: thêm bot vào nhóm Zalo, ADMIN gõ `bot ket noi nhom`.
6. **Ảnh lịch**: vào Firebase Console › **Storage** › **Bắt đầu (Get started)** để bật kho ảnh (một lần, gói Blaze có hạn mức miễn phí). Chưa bật thì bot gửi lịch bằng chữ. Ảnh cũ hơn 14 ngày tự xoá.

Model mặc định là **Claude Opus 5.5** (thông minh nhất, $4 / $20 mỗi triệu token vào / ra). **Haiku 5.5** rẻ hơn khoảng 40 lần ($0,1 / $0,5), ZSpace đang dùng loại này. Đổi model trong tab Bot Zalo, không cần deploy lại.

## Gỡ lỗi

| Hiện tượng | Nguyên nhân thường gặp |
|---|---|
| Nhắn bot không thấy trả lời | Webhook chưa đặt, hoặc mã bí mật ở bước 5 khác bước 3. Mở Firebase Console › Functions › Logs, nếu thấy `zaloHook: sai hoặc thiếu header bí mật` thì là lệch mã bí mật. Đặt lại cả 2 chỗ, sau đó chạy lại `firebase deploy --only functions` để hàm nhận secret mới. |
| Log `sendMessage lỗi: http 401` | Token sai hoặc đã đổi. Chạy lại `secrets:set ZALO_BOT_TOKEN`, rồi deploy lại functions. |
| App báo "Chưa kết nối được máy chủ" / lỗi `not-found` khi lấy mã | Các hàm chưa được deploy, hoặc deploy sai vùng (phải là `asia-southeast1`). |
| "Tài khoản của bạn chưa được dùng bot Zalo" | Vai trò của người đó chưa được tick trong tab Bot Zalo. |
| Tab Bot Zalo báo "Chưa có quyền đọc" | Chưa deploy luật mới (bước 4), hoặc chưa làm bước 6.2. |
| Bot trả "Trợ lý AI đang tắt" | Chưa lưu `ANTHROPIC_API_KEY` rồi deploy lại functions, hoặc AI đang tắt trong tab Bot Zalo. |
| Bot trả "Em chưa xử lý được câu này" liên tục | Xem Logs của `zaloProcess`: dòng `zalo: gọi AI lỗi` có mã http (401 = khoá sai, 429 = hết hạn mức tài khoản Anthropic, 400 = báo tao). |

Đổi bot (tạo bot mới) chỉ cần làm lại bước 1, 3, 5, rồi deploy lại functions. Liên kết cũ gắn với tài khoản Zalo của nhân viên, nên mọi người phải kết nối lại với bot mới.
