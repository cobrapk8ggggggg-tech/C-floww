const mongoose = require('mongoose');

// ⚡ المترجم الخالص — مهمة ترجمة "فقط" (بلا استخراج مصطلحات إطلاقاً).
//
// نظام جديد مستقل تماماً عن المترجم الذكي القائم (الذي يترجم ويستخرج المصطلحات
// في نفس الوقت): هذا النظام يفترض أن مسرد الرواية (Glossary) مستخرج مسبقاً
// وكامل — عادةً عبر «المستخرج الذكي» (glossaryAiRoutes) — فيقرأه ويحقنه في
// توجيه الترجمة ويترجم الفصل فقط. لا يضيف ولا يعدّل أي مصطلح في المسرد أبداً.
//
// بنية المهمة نفس بنية مهمة الترجمة القائمة بالضبط (+ chapterDelayMs للفاصل
// القابل للضبط من الواجهة وقراءته حياً كل فصل) لكنها وثيقة/مجموعة منفصلة كلياً:
// مهام المترجم الخالص لا تظهر في قائمة المترجم القديم ولا العكس — صفر تداخل.
const pureTranslationJobSchema = new mongoose.Schema({
    novelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Novel', required: true },
    novelTitle: String,
    cover: String,
    status: { type: String, enum: ['active', 'paused', 'completed', 'failed'], default: 'active' },
    currentChapter: { type: Number, default: 0 },
    targetChapters: [Number], // أرقام الفصول المستهدفة (تُسحب من القائمة عند إنجاز كل فصل)
    totalToTranslate: { type: Number, default: 0 },
    translatedCount: { type: Number, default: 0 },
    // ⏱️ الفاصل بين كل فصل والذي يليه (بالملي ثانية) — يُضبط من الواجهة ويُقرأ حياً كل فصل
    chapterDelayMs: { type: Number, default: 2000 },
    logs: [{
        message: String,
        type: { type: String, enum: ['info', 'success', 'error', 'warning'] },
        timestamp: { type: Date, default: Date.now }
    }],
    startTime: { type: Date, default: Date.now },
    lastUpdate: { type: Date, default: Date.now }
}, { timestamps: true });

const PureTranslationJob = mongoose.model('PureTranslationJob', pureTranslationJobSchema);
module.exports = PureTranslationJob;
