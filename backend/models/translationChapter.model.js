const mongoose = require('mongoose');

const translationChapterSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    fileName: { type: String, required: true }, // اسم الملف (مثال: Chapter1.txt)
    content: { type: String, default: "" }, // النص الإنجليزي
    translatedContent: { type: String, default: "" }, // النص المترجم
    lastModified: { type: Number, default: Date.now }
}, { timestamps: true });

// فهرس لضمان عدم تكرار اسم الملف لنفس المستخدم وتسريع البحث
translationChapterSchema.index({ user: 1, fileName: 1 }, { unique: true });

const TranslationChapter = mongoose.model('TranslationChapter', translationChapterSchema);
module.exports = TranslationChapter;