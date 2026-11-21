
const mongoose = require('mongoose');

// 🔍 مهمة مراجعة جودة الفصول — نفس بنية مهمة الترجمة بالضبط:
// عامل ذكاء اصطناعي يفحص الفصول واحداً تلو الآخر ويسجل الفصول التي بها خلل
const reviewJobSchema = new mongoose.Schema({
    novelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Novel', required: true },
    novelTitle: String,
    cover: String,
    status: { type: String, enum: ['active', 'paused', 'completed', 'failed'], default: 'active' },
    currentChapter: { type: Number, default: 0 },
    targetChapters: [Number], // أرقام الفصول المستهدفة (تُسحب من القائمة عند إنجاز كل فصل)
    totalToReview: { type: Number, default: 0 },
    reviewedCount: { type: Number, default: 0 },  // فصول فُحصت وسليمة
    flaggedCount: { type: Number, default: 0 },   // فصول وُجد فيها خلل
    // ⏱️ الفاصل بين كل فصل والذي يليه (بالملي ثانية) — يُضبط من الواجهة ويُقرأ حياً كل فصل
    chapterDelayMs: { type: Number, default: 3000 },
    // الفصول المعلَّمة داخل هذه المهمة (نسخة عرض سريع — المصدر الدائم ReviewFinding)
    findings: [{
        chapter: Number,
        title: String,
        types: [String],   // 'english' | 'short' | 'repeated' | 'gibberish'
        details: String,
        at: { type: Date, default: Date.now }
    }],
    logs: [{
        message: String,
        type: { type: String, enum: ['info', 'success', 'error', 'warning'] },
        timestamp: { type: Date, default: Date.now }
    }],
    startTime: { type: Date, default: Date.now },
    lastUpdate: { type: Date, default: Date.now }
}, { timestamps: true });

const ReviewJob = mongoose.model('ReviewJob', reviewJobSchema);
module.exports = ReviewJob;
