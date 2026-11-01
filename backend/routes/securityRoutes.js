/**
 * 🛡️ مسارات الأمان:
 *   POST /api/security/captcha         → تحقق Turnstile وإصدار رمز مرور مؤقت (عام)
 *   POST /api/security/reader-session  → تذكرة جلسة قراءة موقّعة 10د (عام)
 *   POST /api/security/reader-flag     → بلاغ نمط قراءة آلي من الموقع (عام، sendBeacon)
 *   GET  /api/security/honeypot        → فخ السكرابرز — حظر فوري (عام، يُفهرس عمداً)
 *   GET  /api/admin/security/bans      → قائمة الحظر (admin)
 *   POST /api/admin/security/unban     → فك حظر عنوان واحد (admin)
 *   POST /api/admin/security/unban-all → فك حظر الجميع (admin)
 *   GET  /api/admin/security/stats     → إحصاءات (admin)
 */
const express = require('express');
const security = require('../services/security.service');

module.exports = (app, verifyToken, verifyAdmin) => {
  // بوابة الكابتشا — عامة (الزائر المقيّد يحتاجها)
  app.post('/api/security/captcha', async (req, res) => {
    try {
      const { token } = req.body || {};
      if (!token) return res.status(400).json({ message: 'توكن التحقق مفقود' });
      if (!security.hasTurnstile()) {
        return res.status(400).json({ message: 'الكابتشا غير مضبوطة على الخادم' });
      }
      const ip = security.getIp(req);
      const pass = await security.issueCaptchaPass(token, ip);
      if (!pass) return res.status(400).json({ message: 'فشل التحقق — أعد المحاولة' });
      res.json({ pass });
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });

  // 🎫 جلسة القراءة — تذكرة موقّعة قصيرة العمر للمتصفح الحقيقي (على نمط
  // reader-session في قراءة مجرة الروايات). إشارة مخاطرة وليست قفل:
  // العملاء المشروعون بدون تذكرة لا يُرفضون، غيابها فقط يرفع مؤشر الخطر.
  app.post('/api/security/reader-session', (req, res) => {
    try {
      const ip = security.getIp(req);
      res.json({ token: security.issueReaderSession(ip), ttlMs: 10 * 60 * 1000 });
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  });

  // 🛡️ بلاغ نمط القراءة الآلي (من الموقع) — 8+ فصول متتالية
  // ببقاء قصير جداً. يضيّق ميزانية الفصول للعنوان تدريجياً (لا حظر هنا).
  // يُرسل الموقع البلاغ text/plain (طلب بسيط بلا preflight) — نفك JSON من أي نوع.
  app.post('/api/security/reader-flag', express.json({ type: ['application/json', 'text/plain'] }), (req, res) => {
    try {
      const ip = security.getIp(req);
      const { score, reasons } = req.body || {};
      security.recordReaderFlag(ip, score, reasons);
      res.status(204).end();
    } catch {
      res.status(204).end(); // البلاغ استشاري — لا يفشل أبداً
    }
  });

  // 🕳️ فخ السكرابر — أي زيارة هنا = حظر فوري (يعالجه الوسيط في index.js)
  app.get('/api/security/honeypot', (req, res) => {
    res.status(403).json({ message: 'Blocked' });
  });

  // ═══ الإدارة ═══
  app.get('/api/admin/security/bans', verifyAdmin, async (req, res) => {
    res.json({ bans: security.listBans() });
  });

  app.post('/api/admin/security/unban', verifyAdmin, async (req, res) => {
    const { ip } = req.body || {};
    if (!ip) return res.status(400).json({ message: 'ip مطلوب' });
    security.unbanIp(ip);
    res.json({ success: true });
  });

  // فك حظر جميع العناوين + مسح عدادات المخالفات (صفحة بيضاء فورية)
  app.post('/api/admin/security/unban-all', verifyAdmin, async (req, res) => {
    const removed = security.unbanAllIps();
    res.json({ success: true, removed });
  });

  app.get('/api/admin/security/stats', verifyAdmin, async (req, res) => {
    res.json(security.securityStats());
  });
};
