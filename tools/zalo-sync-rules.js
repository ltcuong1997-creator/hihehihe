/* ===================== ĐỒNG BỘ LUẬT QUYỀN APP -> MÁY CHỦ (bot Zalo) =====================
   Port từ ZSpace. Bot Zalo đọc / ghi dữ liệu thay người dùng nên phải kiểm quyền Y HỆT app. Thay vì viết
   lại bằng tay (dễ lệch dần), script này TRÍCH NGUYÊN VĂN các khai báo cần dùng từ <script id="src"> của
   index.html (bằng trình phân tích của Babel, không dò chuỗi) rồi ghi ra functions/apprules.js.

   Chạy (ở gốc repo, cần npm ci --prefix tools trước):
           node tools/zalo-sync-rules.js           -> ghi lại functions/apprules.js
           node tools/zalo-sync-rules.js --check   -> chỉ so sánh; lệch thì thoát mã 1 */
const fs = require('fs');
const path = require('path');

/* Thứ tự = thứ tự trong file đích. Hàm nào dùng biến toàn cục của app thì biến đó phải có ở đây
   hoặc được truyền vào (CFG). */
const NAMES = [
  'pad', 'hoursTxt', 'dShort', '_uidSeq', 'uid',
  'ALL_PAGES', 'BASE_PAGES', 'DEFAULT_ROLES', 'ROLE_FALLBACK', '_rlSrc', 'roleList', 'roleOf',
  'inScope', 'scopeBranches', 'isBiz', 'bizList', 'canIssue', 'ISSUE_SEV', 'DEFAULT_ISSUE_CATS',
  'itemGroups', 'itemsInGroup', 'canPreq', 'canPreqAll', 'canPreqAppr', 'pqSees',
  'canConfirmAtt', 'attApprCfg', 'attChain', 'attStepOK', 'posOf', 'attStepLabel', 'attStepIdx', 'attIsLast', 'attCanStep',
  'noAccent', 'pushCfg', 'pushWho', 'pushTargets', 'pushTokensOf', 'pushSend', 'pushBulk',
  'canAttAll', 'canRecView',
  /* Kho: phiếu huỷ / nhập bổ sung qua bot */
  'canStkMove', 'canStkMoveAppr', 'stockItems',
  /* Đề xuất / đề nghị thanh toán (ops_requests): loại phiếu, chuỗi duyệt */
  'DEFAULT_REQ_TYPES', 'nextReqId', 'typeList', 'typeListOn', 'tOf', 'DEFAULT_APPROVAL', 'pickerList', 'reqPickDept', 'pickersFor',
  'stepOK', 'stepLabel', 'apprCfg', 'tierOf', 'reqAmountRaw', 'chainOf', 'stepIdx', 'chainNow', 'curStep', 'skipFrom', 'canStep',
];
const EXPORTS = ['ALL_PAGES', 'BASE_PAGES', 'DEFAULT_ROLES', 'roleList', 'roleOf', 'inScope', 'scopeBranches', 'isBiz', 'bizList', 'canIssue', 'ISSUE_SEV',
  'DEFAULT_ISSUE_CATS', 'itemGroups', 'itemsInGroup', 'canPreq', 'canPreqAll', 'canPreqAppr', 'pqSees', 'canConfirmAtt', 'attChain', 'attStepLabel',
  'attStepIdx', 'attIsLast', 'attCanStep', 'pad', 'hoursTxt', 'dShort', 'uid', 'noAccent', 'pushCfg', 'pushTargets', 'pushBulk', 'canAttAll', 'canRecView',
  'canStkMove', 'canStkMoveAppr', 'stockItems', 'nextReqId', 'typeListOn', 'tOf', 'apprCfg', 'pickersFor', 'reqPickDept', 'stepLabel',
  'chainOf', 'chainNow', 'curStep', 'skipFrom', 'canStep', 'reqAmountRaw'];

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'functions', 'apprules.js');

function build() {
  let Babel;
  try { Babel = require('@babel/standalone'); }
  catch (e) {
    try { Babel = require(path.join(__dirname, 'node_modules', '@babel/standalone')); }
    catch (e2) { console.error('[zalo-sync-rules] Chưa cài @babel/standalone — chạy: npm ci --prefix tools'); process.exit(2); }
  }
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n?/g, '\n');
  const m = html.match(/<script id="src"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('Không thấy <script id="src">');
  const src = m[1];
  const ast = Babel.packages.parser.parse(src, { sourceType: 'script', plugins: ['jsx'] });
  const found = {};
  for (const node of ast.program.body) {
    if (node.type === 'VariableDeclaration') {
      /* Khai báo nhiều biến một dòng (let a = null, b = null) -> lấy cả câu, gán cho từng tên */
      node.declarations.forEach(d => { if (d.id && d.id.name && NAMES.includes(d.id.name)) found[d.id.name] = found[d.id.name] || src.slice(node.start, node.end); });
    } else if (node.type === 'FunctionDeclaration' && node.id && NAMES.includes(node.id.name)) {
      found[node.id.name] = src.slice(node.start, node.end);
    }
  }
  const miss = NAMES.filter(n => !found[n]);
  if (miss.length) throw new Error('Không tìm thấy trong app: ' + miss.join(', ') + ' — app đổi tên hàm? sửa NAMES trong tools/zalo-sync-rules.js');
  const seen = new Set();
  const parts = [];
  NAMES.forEach(n => { if (!seen.has(found[n])) { seen.add(found[n]); parts.push(found[n]); } });
  return `/* ===================== LUẬT QUYỀN CỦA APP — FILE SINH TỰ ĐỘNG, KHÔNG SỬA TAY =====================
   Trích nguyên văn từ index.html bằng tools/zalo-sync-rules.js. Sửa luật quyền trong app rồi chạy:
   node tools/zalo-sync-rules.js — rồi deploy lại functions.
   Dùng: const R = require('./apprules')(cfg)  — cfg là ops_config/main (chỉ đọc). */
/* eslint-disable */
module.exports = function appRules(CFG) {
  CFG = CFG || {};
${parts.join('\n')}
  return { ${EXPORTS.join(', ')} };
};
`;
}

const out = build();
if (process.argv.includes('--check')) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (cur !== out) {
    console.error('[zalo-sync-rules] functions/apprules.js LỆCH với luật quyền trong app — chạy: node tools/zalo-sync-rules.js rồi commit');
    process.exit(1);
  }
  console.log('[zalo-sync-rules] Luật quyền bot Zalo khớp app — OK');
} else {
  fs.writeFileSync(OUT, out);
  console.log('[zalo-sync-rules] Đã ghi functions/apprules.js (' + out.length + ' byte)');
}
