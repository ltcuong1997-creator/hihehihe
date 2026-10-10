/* Biên dịch sẵn JSX của index.html ra app.js — chạy lúc deploy (GitHub Actions), không phải trên điện thoại.

   Trước đây mỗi lần có bản mới, MỌI máy phải tải Babel (~3MB) rồi tự dịch 3.7MB mã ngay trên điện thoại
   (máy yếu mất 10–20 giây). Bản đã dịch được cất vào localStorage, nhưng nó ~3.5 triệu ký tự — vượt hạn
   mức của Safari/iPhone, nên iPhone dịch lại ở MỌI lần mở app.

   Giờ: bộ nạp trong index.html tải /app.js?v=<chữ ký>, kiểm tra dòng đầu "/*ZSPRE:<chữ ký>*\/" khớp đúng
   bản mã trong trang thì chạy luôn. Không khớp (quên chạy bước này, hay deploy tay) thì tự quay về
   dịch bằng Babel như cũ — nên bước này hỏng cũng không làm sập app, chỉ chậm như trước.

   Chạy:  npm i --prefix tools  &&  node tools/prebuild.mjs   (ở thư mục gốc repo) */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Babel = require('@babel/standalone');

const html = fs.readFileSync('index.html', 'utf8');
const m = html.match(/<script id="src" type="text\/plain">([\s\S]*?)<\/script>/);
if (!m) { console.error('Không thấy <script id="src"> trong index.html'); process.exit(1); }
/* Trình duyệt đổi CRLF → LF khi đọc HTML; làm y hệt để chữ ký khớp với bộ nạp */
const SRC = m[1].replace(/\r\n?/g, '\n');

/* PHẢI giống hệt hàm hash() của bộ nạp trong index.html */
const hash = (str) => {
  let h = 5381;
  for (let i = 0; i < str.length; i += 7) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return String(h) + '_' + str.length;
};
const sig = hash(SRC);
const t0 = Date.now();
const out = Babel.transform(SRC, { presets: ['react'], compact: false }).code;
fs.writeFileSync('app.js', '/*ZSPRE:' + sig + '*/\n' + out);
console.log('app.js: chữ ký ' + sig + ', ' + (out.length / 1e6).toFixed(2) + ' triệu ký tự, dịch ' + (Date.now() - t0) + 'ms');
