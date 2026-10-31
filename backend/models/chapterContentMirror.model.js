// backend/models/chapterContentMirror.model.js
//
// 🔥 Firestore content mirror (MongoDB) — شبكة أمان ضد نفاد حصة Firestore
// (RESOURCE_EXHAUSTED: Quota exceeded) وخفض قراءات Firestore بشكل جذري.
//
// كل قراءة فصل ناجحة من Firestore تُخزَّن هنا (upsert، بلا تعطيل الطلب).
// عند نفاد حصة Firestore تُقرأ الفصول من هذه المرآة بدلاً من فشل الطلب —
// فتبقى القراءة تعمل (المستخدم/الموقع) حتى مع الحصة الميتة.
//
// التحديثات عبر مسارات الإدارة (تعديل/حذف/تنظيف) تكتب في Firestore أولاً،
// وتُحدّث المرآة أيضاً عبر upsert/deleteAll في نفس المسارات.
const mongoose = require('mongoose');

const chapterContentMirrorSchema = new mongoose.Schema({
    novelId: { type: String, required: true },
    number: { type: Number, required: true },
    content: { type: String, default: '' },
    updatedAt: { type: Date, default: Date.now },
}, { collection: 'chapter_content_mirror', versionKey: false });

chapterContentMirrorSchema.index({ novelId: 1, number: 1 }, { unique: true });

module.exports = mongoose.model('ChapterContentMirror', chapterContentMirrorSchema);
