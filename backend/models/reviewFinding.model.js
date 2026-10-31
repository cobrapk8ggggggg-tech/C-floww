
const mongoose = require('mongoose');

// 🔍 سجل دائم للفصول المعلَّمة (مستقل عن مهام المراجعة):
// واجهة «الفصول التي بها خلل» تقرأ من هنا — تختار الرواية وتشاهد فصولها المشكلة،
// وبعد إعادة السحب/الترجمة يدوياً يزيل المستخدم العلامة يدوياً (أو تعزل تلقائياً
// إذا أُعيدت مراجعة الفصل وخرج سليماً).
const reviewFindingSchema = new mongoose.Schema({
    novelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Novel', required: true, index: true },
    novelTitle: String,
    cover: String,
    chapter: { type: Number, required: true },
    chapterTitle: String,
    types: [String],   // 'english' | 'short' | 'repeated' | 'gibberish'
    details: String,
    status: { type: String, enum: ['open', 'resolved'], default: 'open', index: true },
    at: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

reviewFindingSchema.index({ novelId: 1, chapter: 1, status: 1 });

const ReviewFinding = mongoose.model('ReviewFinding', reviewFindingSchema);
module.exports = ReviewFinding;
