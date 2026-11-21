/**
 * 🛡️ خدمة حماية الخادم — الحد من الطلبات + الحظر التلقائي + الكابتشا.
 *
 * ═══ فلسفة التصعيد (بعد بلاغ «حُظر مشرف أثناء تنزيل رواية») ═══
 *   1) تهدئة (429 + Retry-After) — دائماً أولاً، لا حظر إطلاقاً.
 *   2) كابتشا (إن ضُبطت Turnstile) — لمن يرغب بإثبات أنه بشري فوراً.
 *   3) حظر مؤقت — الخيار الأخير الإضطراري: فقط لمن يتجاهل التهديدات
 *      مراراً متواصلة (10+ مخالفات خلال 15 دقيقة)، أو فخ السكرابر.
 *
 * ═══ قواعد مصالحبة صارمة ═══
 *   - المشرفون/المساهمون (توكن صالح بدور إداري): مستثنون تماماً — لا عدّ
 *     ولا تهدئة ولا حظر أبداً (كان المحرك السابق يحظرهم كالزوار!).
 *   - مسارات الفصول لا تُنتج حظراً مباشراً مهما بلغت السرعة — تهدئة فقط،
 *     لأن تنزيل رواية كاملة للقراءة دون إنترنت مشروع ويولد مئات الطلبات.
 *   - طلبات التنزيل دون اتصال (X-Moon-Batch) لها ميزانية سخية مستقلة:
 *     300/د للمسجلين و90/د للزوار — لا يمكن أن «يُخطئ» التنزيل المشروع.
 *   - رمز الكابتشا المحلول (X-Captcha-Pass) يعفي من تهدئة الفصول حياته (15د).
 *
 * - عدّاد نافذة منزلقة في الذاكرة لكل IP (خفيف جداً — لا قاعدة بيانات).
 *   • عام: 240 طلب/دقيقة (تهدئة عند ضعفه مضاعفاً — 480)
 *   • فصول: زائر 60/د — مسجل 180/د — دفعة تنزيل 300/د
 *   • جمع التحليلات: 60/دقيقة (تهدئة فقط)
 * - فخ السكرابر (honeypot): حظر فوري 24 ساعة (لا يصله إنسان أصلاً).
 *
 * ملاحظة صدق: القوائم في الذاكرة تُمسح مع إعادة تشغيل الحاوية — أي أن
 * إعادة نشر جديدة تمسح كل الحظرات الحالية تلقائياً، وزر «فك حظر الجميع»
 * في لوحة الأمان يفعل الشيء نفسه فوراً دون إعادة نشر.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// ─── الحالة في الذاكرة ───
const windows = new Map();       // ip → { global: [ts], chapters: [ts], collect: [ts] }
const bans = new Map();          // ip → { reason, until, requests }
const violations = new Map();    // ip → [ts] أحداث تجاوز التهديدات (للتصعيد)
const lastMinuteTotal = new Map(); // ip → count (لإحصاءات الأمان)
const readerFlags = new Map();   // ip → { score, reasons, t } بلاغات نمط القراءة الآلي (من الموقع)

const LIMITS = {
  global: { max: 240, windowMs: 60_000 },
  collect: { max: 60, windowMs: 60_000 },
  // حدود الفصول حسب هوية الطريقة (المشرفون مستثنون قبل الوصول لهنا)
  chapters: {
    guest: 60,
    user: 180,
    batchGuest: 90,
    batchUser: 300,
  },
};

const TEMP_BAN_MS = 15 * 60 * 1000;
const HONEYPOT_BAN_MS = 24 * 60 * 60 * 1000;
const VIOLATION_WINDOW_MS = 15 * 60 * 1000;
/** كم مخالفة تهدئة خلال نافذة الـ15د قبل اللجوء للحظر — رقم سخي عمداً:
 *  من يحترم Retry-After مرة واحدة لا يقترب منه أبداً. */
const VIOLATIONS_FOR_BAN = 10;

/** صلاحية بلاغ نمط القراءة الآلي (يأتي من موقع الويب — readerRisk) */
const READER_FLAG_TTL_MS = 30 * 60 * 1000;
/** معامل شد ميزانية الفصول للعناوين المرصودة بنمط آلي (نصف الميزانية) */
const FLAGGED_CAP_FACTOR = 0.5;

const hasTurnstile = () => !!process.env.TURNSTILE_SECRET;
const CHAPTER_RE = /^\/api\/novels\/[^/]+\/chapters\//;

function trimWindow(arr, windowMs) {
  const cutoff = Date.now() - windowMs;
  while (arr.length && arr[0] < cutoff) arr.shift();
}

function trimViolations(arr) {
  const cutoff = Date.now() - VIOLATION_WINDOW_MS;
  while (arr.length && arr[0] < cutoff) arr.shift();
}

function getIp(req) {
  return (
    req.headers['cf-connecting-ip'] ||
    req.headers['x-real-ip'] ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

/**
 * قراءة هوية الطالب من توكن JWT إن وُجد (تحقق تشفيري فقط — دون قاعدة بيانات).
 * يعيد { id, role, isStaff, isUser } أو null للزائر.
 */
function identify(req) {
  try {
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return null;
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'moon-secret');
    if (!decoded || !decoded.id) return null;
    const role = decoded.role || 'user';
    return {
      id: String(decoded.id),
      role,
      isStaff: role === 'admin' || role === 'contributor',
      isUser: true,
    };
  } catch {
    return null;
  }
}

/** هل يحمل الطلب رمز مرور كابتشا صالحاً؟ */
function hasValidCaptchaPass(req) {
  const pass = req.headers['x-captcha-pass'];
  if (!pass || typeof pass !== 'string') return false;
  return checkCaptchaPass(pass);
}

function recordViolation(ip) {
  if (!violations.has(ip)) violations.set(ip, []);
  const arr = violations.get(ip);
  arr.push(Date.now());
  trimViolations(arr);
  return arr.length;
}

/** الحظر الأخير الإضطراري — فقط عند تجاهل متواصل للتهديدات */
function shouldEmergencyBan(ip) {
  const arr = violations.get(ip);
  if (!arr) return false;
  trimViolations(arr);
  return arr.length >= VIOLATIONS_FOR_BAN;
}

function minutesLeft(until) {
  return Math.max(1, Math.ceil((until - Date.now()) / 60_000));
}

function throttle(res, { seconds, captcha, message }) {
  res.set('Retry-After', String(seconds));
  return res.status(429).json({
    message,
    retryAfter: seconds,
    ...(captcha ? { captchaRequired: true } : {}),
  });
}

/**
 * الوسيط الرئيسي — يُركّب قبل كل المسارات.
 */
function securityMiddleware(req, res, next) {
  const ip = getIp(req);

  // 0) طلبات CORS المسبقة والكابتشا نفسها لا تُحتسب ولا تُهدَّأ
  if (req.method === 'OPTIONS' || req.path === '/api/security/captcha') {
    return next();
  }

  const identity = identify(req);

  // 1) المشرفون/المساهمون مستثنون تماماً — لا عدّ، لا تهدئة، لا حظر.
  if (identity?.isStaff) {
    return next();
  }

  // 2) محظور؟
  const ban = bans.get(ip);
  if (ban && ban.until > Date.now()) {
    ban.requests++;
    return res.status(403).json({
      message: `تم تقييد عنوان IP مؤقتاً بسبب نشاط آلي مخالف — يُرفع الحظر تلقائياً بعد ${minutesLeft(ban.until)} دقيقة.`,
      until: ban.until,
      retryAfter: Math.ceil((ban.until - Date.now()) / 1000),
    });
  }
  if (ban) bans.delete(ip); // انتهى الحظر

  // 3) فخ السكرابر — حظر فوري (ما يزور هذا المسار بوت مباشر بلا استثناء)
  if (req.path === '/api/security/honeypot') {
    bans.set(ip, { reason: 'فخ السكرابر (honeypot)', until: Date.now() + HONEYPOT_BAN_MS, requests: 1 });
    return res.status(403).json({ message: 'تم رصد نشاط آلي مخالف وحظر العنوان.' });
  }

  // 4) النوافذ المنزلقة
  if (!windows.has(ip)) windows.set(ip, { global: [], chapters: [], collect: [] });
  const w = windows.get(ip);

  trimWindow(w.global, LIMITS.global.windowMs);
  w.global.push(Date.now());
  lastMinuteTotal.set(ip, w.global.length);

  // 5) تتبع فتح الفصول — ميزانية حسب الهوية ونوع الطلب
  const isChapterReq = CHAPTER_RE.test(req.path);
  if (isChapterReq) {
    const batch = req.headers['x-moon-batch'] === 'offline-download';
    let cap = identity?.isUser
      ? (batch ? LIMITS.chapters.batchUser : LIMITS.chapters.user)
      : (batch ? LIMITS.chapters.batchGuest : LIMITS.chapters.guest);

    // 🎫 جلسة قراءة صالحة (متصفح حقيقي يشغّل JS) → ميزانية كاملة
    const readerSessionOk = hasValidReaderSession(req.headers['x-reader-session']);
    // 🛡️ بلاغ نمط آلي من موقع الويب (فصول متتالية بسرعة غير بشرية) → شد تدريجي
    // (نصف الميزانية) — خطوة وسيطة لطيفة قبل التهدئة، لا حظر ولا رفض.
    const flagged = isReaderFlagged(ip);
    if (flagged && !readerSessionOk && !batch) cap = Math.max(8, Math.round(cap * FLAGGED_CAP_FACTOR));

    trimWindow(w.chapters, LIMITS.global.windowMs);
    w.chapters.push(Date.now());

    // من حل الكابتشا مؤخراً يقرأ بحرية طوال صلاحية الرمز
    const humanVerified = hasValidCaptchaPass(req);

    if (!humanVerified && w.chapters.length > cap) {
      // المرحلة 1: تهدئة فقط — لا حظر من مسارات الفصول أبداً.
      const count = recordViolation(ip);
      if (shouldEmergencyBan(ip) && !batch) {
        // المرحلة 3 (الأخيرة): يتجاهل التهديدات عشر مرات خلال 15د —
        // لا معنى لهذا النمط إلا سحب آلي. (طلبات الدفعات لا تُحظر حتى هنا
        // احتراماً للتنزيل المشروع — تبقى تهدئة فقط.)
        const until = Date.now() + TEMP_BAN_MS;
        bans.set(ip, {
          reason: 'نشاط آلي عنيد — تجاهل متكرر لتهدئة الخادم',
          until,
          requests: w.chapters.length,
        });
        violations.delete(ip);
        return res.status(403).json({
          message: 'تم تقييد العنوان مؤقتاً بعد تجاهل متكرر لتحذيرات السرعة — يُرفع الحظر تلقائياً بعد 15 دقيقة.',
          until,
          retryAfter: TEMP_BAN_MS / 1000,
        });
      }
      // المرحلة 2: كابتشا إن توفرت، وإلا انتظار زمني صادق.
      if (hasTurnstile()) {
        return throttle(res, {
          seconds: 20,
          captcha: true,
          message: 'سرعة غير طبيعية في فتح الفصول — أكمل تحققاً بشرياً سريعاً أو انتظر قليلاً.',
        });
      }
      return throttle(res, {
        seconds: 20,
        captcha: false,
        message: 'سرعة فتح الفصول أعلى من المسموح الآن — سيعيد التنزيل المحاولة تلقائياً بعد لحظات.',
      });
    }
  }

  // حد عام: تهدئة عند الطوفان (ضعف الحد مضاعفاً) — الحظر عبر عداد المخالفات فقط
  if (w.global.length > LIMITS.global.max * 2) {
    recordViolation(ip);
    if (shouldEmergencyBan(ip)) {
      bans.set(ip, {
        reason: 'طوفان طلبات متواصل رغم التحذيرات',
        until: Date.now() + TEMP_BAN_MS,
        requests: w.global.length,
      });
      violations.delete(ip);
      return throttle(res, {
        seconds: TEMP_BAN_MS / 1000,
        captcha: false,
        message: 'حجم طلبات غير طبيعي بشكل متواصل — تم تقييد العنوان مؤقتاً 15 دقيقة.',
      });
    }
    return throttle(res, {
      seconds: 60,
      captcha: false,
      message: 'حجم طلبات غير طبيعي — خفف الوتيرة وأعد المحاولة بعد دقيقة.',
    });
  }

  // تنظيف دوري للذاكرة (كل فترة)
  if (windows.size > 20000) {
    const now = Date.now();
    for (const [k, v] of windows) {
      if (!v.global.length || now - v.global[v.global.length - 1] > 10 * 60_000) windows.delete(k);
    }
  }
  if (violations.size > 5000) {
    for (const [k, arr] of violations) {
      trimViolations(arr);
      if (!arr.length) violations.delete(k);
    }
  }

  next();
}

/** وسطي خفيف لمسار جمع التحليلات (حد خاص — تهدئة فقط، لا حظر) */
function collectRateLimit(req, res, next) {
  if (req.method === 'OPTIONS') return next();
  const ip = getIp(req);
  const w = windows.get(ip) || windows.set(ip, { global: [], chapters: [], collect: [] }).get(ip);
  trimWindow(w.collect, LIMITS.collect.windowMs);
  w.collect.push(Date.now());
  if (w.collect.length > LIMITS.collect.max) {
    return throttle(res, { seconds: 30, captcha: false, message: 'أحداث تحليلات كثيرة جداً' });
  }
  next();
}

// ─── الكابتشا (Cloudflare Turnstile) ───

async function verifyTurnstileToken(token, ip) {
  try {
    const res = await fetch('https://api.cloudflare.com/client/v4/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: process.env.TURNSTILE_SECRET,
        response: token,
        remoteip: ip || undefined,
      }),
    });
    const data = await res.json();
    return !!data.success;
  } catch {
    return false;
  }
}

/**
 * تُستدعى من مسار /api/security/captcha:
 * تحقق من توكن Turnstile ثم إصدار رمز مرور مؤقت.
 */
async function issueCaptchaPass(token, ip) {
  const ok = await verifyTurnstileToken(token, ip);
  if (!ok) return null;
  const pass = jwt.sign({ ip, kind: 'captcha-pass' }, process.env.JWT_SECRET || 'moon-secret', { expiresIn: '15m' });
  return pass;
}

/** هل رمز المرور صالح؟ */
function checkCaptchaPass(passToken) {
  try {
    const decoded = jwt.verify(passToken, process.env.JWT_SECRET || 'moon-secret');
    return decoded.kind === 'captcha-pass';
  } catch {
    return false;
  }
}

// ─── جلسة القراءة (على نمط reader-session في قراءة مجرة الروايات) ───
// تذكرة موقّعة قصيرة العمر يصدرها الخادم للمتصفح الحقيقي (يشغّل JS) وتُرفق
// مع طلبات الفصول. **إشارة وليست قفل** — التطبيق والعملاء المشروعون بدون
// تذكرة لا يُرفضون أبداً؛ غيابها فقط إشارة مخاطرة عند السرعات العالية.

/** إصدار تذكرة جلسة قراءة (10 دقائق) */
function issueReaderSession(ip) {
  return jwt.sign({ kind: 'reader-session', ip }, process.env.JWT_SECRET || 'moon-secret', { expiresIn: '10m' });
}

/** هل تذكرة جلسة القراءة صالحة؟ */
function hasValidReaderSession(token) {
  if (!token || typeof token !== 'string') return false;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'moon-secret');
    return decoded.kind === 'reader-session';
  } catch {
    return false;
  }
}

// ─── بلاغات نمط القراءة الآلي (من موقع الويب — readerRisk) ───

/** تسجيل بلاغ: الموقع رصد 8+ فصول متتالية ببقاء قصير جداً (نمط سحب آلي) */
function recordReaderFlag(ip, score, reasons) {
  readerFlags.set(ip, {
    score: Math.max(0, Math.min(1000, Number(score) || 100)),
    reasons: Array.isArray(reasons) ? reasons.slice(0, 6).map(String) : [],
    t: Date.now(),
  });
}

/** هل العنوان يحمل بلاغاً حياً؟ */
function isReaderFlagged(ip) {
  const flag = readerFlags.get(ip);
  if (!flag) return false;
  if (Date.now() - flag.t > READER_FLAG_TTL_MS) {
    readerFlags.delete(ip);
    return false;
  }
  return true;
}

/** إحصاءات الأمان للوحة الإدارة */
function securityStats() {
  let requestsLastMinute = 0;
  let throttlesLastMinute = 0;
  const now = Date.now();
  for (const [, w] of windows) {
    const arr = w.global.filter((t) => t > now - 60_000);
    requestsLastMinute += arr.length;
  }
  for (const [, arr] of violations) {
    trimViolations(arr);
    throttlesLastMinute += arr.length;
  }
  return {
    bannedIps: bans.size,
    trackedIps: windows.size,
    flaggedReaders: readerFlags.size,
    requestsLastMinute,
    throttlesLastMinute,
    captchaChallenges: hasTurnstile() ? 'Turnstile مفعّل' : 'تهدئة زمنية',
    turnstileEnabled: hasTurnstile(),
  };
}

function listBans() {
  return [...bans.entries()].map(([ip, v]) => ({ ip, reason: v.reason, until: v.until, requests: v.requests }));
}

function unbanIp(ip) {
  return bans.delete(ip);
}

/** فك حظر جميع العناوين + مسح عدادات المخالفات (صفحة بيضاء كاملة) */
function unbanAllIps() {
  const removed = bans.size;
  bans.clear();
  violations.clear();
  return removed;
}

module.exports = {
  securityMiddleware,
  collectRateLimit,
  getIp,
  identify,
  issueCaptchaPass,
  checkCaptchaPass,
  issueReaderSession,
  hasValidReaderSession,
  recordReaderFlag,
  isReaderFlagged,
  securityStats,
  listBans,
  unbanIp,
  unbanAllIps,
  hasTurnstile,
};
