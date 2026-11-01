/**
 * 📊 أحداث التحليلات — تخزين Mongo مع انتهاء تلقائي بعد 45 يوماً.
 * حدث واحد = صفحة مشاهدة / فتح رواية / قراءة فصل / تنزيل.
 * بدون بيانات شخصية: معرّف زائر عشوائي (cid) فقط — موثق في سياسة الخصوصية.
 */
const mongoose = require('mongoose');

const analyticsEventSchema = new mongoose.Schema({
    cid: { type: String, required: true, index: true },   // client id عشوائي
    sid: { type: String, index: true },                    // session id
    type: { type: String, required: true, enum: ['pageview', 'novel_open', 'chapter_read', 'download'] },
    path: { type: String },                                // مسار الصفحة
    novelId: { type: String },
    referrer: { type: String },
    device: { type: String },                              // mobile/tablet/desktop
    screen: { type: String },
    t: { type: Date, default: Date.now, index: true },
}, { timestamps: false });

// انتهاء تلقائي — 45 يوماً
analyticsEventSchema.index({ t: 1 }, { expireAfterSeconds: 45 * 24 * 60 * 60 });

// تجميع اليومي السريع
analyticsEventSchema.index({ type: 1, t: 1 });

const AnalyticsEvent = mongoose.model('AnalyticsEvent', analyticsEventSchema);
module.exports = AnalyticsEvent;
