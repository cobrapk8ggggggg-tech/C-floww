
const mongoose = require('mongoose');

// 📚 مهمة استخراج المصطلحات بالذكاء الاصطناعي (المستخرج الذكي) — نفس بنية مهمة
// المراجعة/الترجمة بالضبط: عامل خلفي يمر على الفصول واحداً تلو الآخر ويستخرج
// من كل فصل مصطلحاته (أسماء/أماكن/عناصر/رتب/مفاهيم) ويغذيها في المسرد (Glossary)
// قبل الترجمة — ليصبح المسرد كاملاً وتُوزَّع ترجمة الرواية لاحقاً على مهام متعددة.
const glossaryExtractionJobSchema = new mongoose.Schema({
    novelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Novel', required: true },
    novelTitle: String,
    cover: String,
    status: { type: String, enum: ['active', 'paused', 'completed', 'failed'], default: 'active' },
    currentChapter: { type: Number, default: 0 },
    targetChapters: [Number], // أرقام الفصول المستهدفة (تُسحب من القائمة عند إنجاز كل فصل)
    totalToExtract: { type: Number, default: 0 },
    processedCount: { type: Number, default: 0 },  // فصول عولجت بنجاح
    newTermsCount: { type: Number, default: 0 },   // مجموع المصطلحات المضافة/المحدثة في المسرد
    // ⏱️ الفاصل بين كل فصل والذي يليه (بالملي ثانية) — يُضبط من الواجهة ويُقرأ حياً كل فصل
    chapterDelayMs: { type: Number, default: 3000 },
    logs: [{
        message: String,
        type: { type: String, enum: ['info', 'success', 'error', 'warning'] },
        timestamp: { type: Date, default: Date.now }
    }],
    startTime: { type: Date, default: Date.now },
    lastUpdate: { type: Date, default: Date.now }
}, { timestamps: true });

const GlossaryExtractionJob = mongoose.model('GlossaryExtractionJob', glossaryExtractionJobSchema);
module.exports = GlossaryExtractionJob;
