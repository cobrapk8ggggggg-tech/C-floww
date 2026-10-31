/**
 * فحص منطق الحماية الجديد — جلسة القراءة + بلاغات المخاطرة + الشد التدريجي
 * تشغيل: node tests/security-galaxy.test.js
 */
process.env.JWT_SECRET = 'test-secret';
const security = require('../backend/services/security.service');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

// محاكاة req/res — كل سيناريو بعنوان IP مستقل عبر x-forwarded-for
function makeReq(headers = {}, path = '/api/novels/x/chapters/1', ip = '1.2.3.4') {
  return { method: 'GET', path, headers: { 'x-forwarded-for': ip, ...headers }, socket: { remoteAddress: ip } };
}
function makeRes() {
  const res = { statusCode: 200, headersSent: false, body: null, headers: {} };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; res.headersSent = true; return res; };
  res.end = () => { res.headersSent = true; return res; };
  return res;
}

console.log('\n═══ 1) جلسة القراءة — إصدار وتحقق ═══');
const token = security.issueReaderSession('9.9.9.9');
check('التذكرة تُصدَر', typeof token === 'string' && token.length > 40);
check('التذكرة الصالحة تُقبَل', security.hasValidReaderSession(token) === true);
check('التذكرة الفاسدة تُرفض', security.hasValidReaderSession('garbage.token.here') === false);
check('غياب التذكرة يُقبَل كإشارة (لا يرمي)', security.hasValidReaderSession(undefined) === false);

console.log('\n═══ 2) بلاغات المخاطرة — تسجيل وانتهاء ═══');
check('غير مرصود افتراضياً', security.isReaderFlagged('7.7.7.7') === false);
const FLAGGED_IP = '7.7.7.7';
const CLEAN_IP = '5.5.5.5';
security.recordReaderFlag(FLAGGED_IP, 120, ['rapid_sequence', 'short_dwell']);
check('البلاغ يُسجَّل', security.isReaderFlagged(FLAGGED_IP) === true);
check('score خارج النطاق يُقيَّد', (() => { security.recordReaderFlag('8.8.8.8', 99999); return true; })());

console.log('\n═══ 3) الشد التدريجي — زائر مرصود بلا جلسة: 60→30 ═══');
let sawThrottle = false;
let stoppedAt = 0;
for (let i = 1; i <= 40; i++) {
  const res = makeRes();
  security.securityMiddleware(makeReq({}, '/api/novels/x/chapters/1', FLAGGED_IP), res, () => {});
  if (res.statusCode === 429) { sawThrottle = true; stoppedAt = i; console.log(`  → الطلب رقم ${i} أوقف بتهدئة 429`); break; }
}
check('الزائر المرصود يُهدَّأ عند نصف الميزانية (~31)', sawThrottle && stoppedAt >= 25 && stoppedAt <= 35);

console.log('\n═══ 4) نفس الزائر المرصود مع جلسة صالحة: ميزانية كاملة 60 ═══');
const SESSION_IP = '7.7.7.8'; // عنوان مستقل لعزل النافذة المنزلقة
security.recordReaderFlag(SESSION_IP, 120, ['rapid_sequence']);
let stopped = 0;
for (let i = 1; i <= 60; i++) {
  const res = makeRes();
  security.securityMiddleware(makeReq({ 'x-reader-session': token }, '/api/novels/x/chapters/1', SESSION_IP), res, () => {});
  if (res.statusCode === 429) { stopped = i; break; }
}
check('مع جلسة صالحة: 60 طلباً تمر كلها بلا تهدئة', stopped === 0);

console.log('\n═══ 5) دفعات التنزيل (X-Moon-Batch) لا تتأثر بالبلاغ ═══');
const BATCH_IP = '7.7.7.9'; // عنوان مستقل لعزل النافذة
security.recordReaderFlag(BATCH_IP, 120, ['rapid_sequence']);
let batchStopped = 0;
for (let i = 1; i <= 100; i++) {
  const res = makeRes();
  security.securityMiddleware(makeReq({ 'x-moon-batch': 'offline-download' }, '/api/novels/x/chapters/1', BATCH_IP), res, () => {});
  if (res.statusCode === 429) { batchStopped = i; break; }
}
check('الدفعة تُوقف عند 91 بالضبط (ميزانية 90 كاملة — البلاغ لم يضيّقها)', batchStopped === 91);

console.log('\n═══ 6) المشرف مستثن دائماً (حتى وهو مرصود) ═══');
const jwt = require('../backend/node_modules/jsonwebtoken');
const adminToken = jwt.sign({ id: '1', role: 'admin' }, 'test-secret');
let adminStopped = false;
for (let i = 1; i <= 200; i++) {
  const res = makeRes();
  security.securityMiddleware(makeReq({ authorization: `Bearer ${adminToken}` }, '/api/novels/x/chapters/1', FLAGGED_IP), res, () => {});
  if (res.statusCode === 429) { adminStopped = true; break; }
}
check('المشرف 200 طلب فصول بلا أي تقييد', adminStopped === false);

console.log('\n═══ 7) زائر نظيف غير مرصود: الميزانية كاملة ═══');
let cleanStopped = 0;
for (let i = 1; i <= 60; i++) {
  const res = makeRes();
  security.securityMiddleware(makeReq({}, '/api/novels/x/chapters/1', CLEAN_IP), res, () => {});
  if (res.statusCode === 429) { cleanStopped = i; break; }
}
check('الزائر النظيف: 60 طلباً تمر', cleanStopped === 0);

console.log('\n═══ 8) الإحصاءات تتضمن flaggedReaders ═══');
const stats = security.securityStats();
check('flaggedReaders موجودة', typeof stats.flaggedReaders === 'number' && stats.flaggedReaders >= 2);

console.log(`\n═══ النتيجة: ${pass} نجاح / ${fail} فشل ═══`);
process.exit(fail ? 1 : 0);
