
const mongoose = require('mongoose');

const translationJobSchema = new mongoose.Schema({
    novelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Novel', required: true },
    novelTitle: String,
    cover: String,
    status: { type: String, enum: ['active', 'paused', 'completed', 'failed'], default: 'active' },
    currentChapter: { type: Number, default: 0 },
    targetChapters: [Number], // أرقام الفصول المستهدفة
    totalToTranslate: { type: Number, default: 0 },
    translatedCount: { type: Number, default: 0 },
    apiKeys: [String], // قائمة المفاتيح المستخدمة لهذه المهمة
    // Durable smart translator is opt-in; legacy jobs retain old behavior.
    durableMode: { type: Boolean, default: false },
    leaseToken: { type: String, default: '' },
    leaseUntil: { type: Date, default: () => new Date(0) },
    nextRunAt: { type: Date, default: Date.now },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: '' },
    logs: [{ 
        message: String, 
        type: { type: String, enum: ['info', 'success', 'error', 'warning'] },
        timestamp: { type: Date, default: Date.now }
    }],
    startTime: { type: Date, default: Date.now },
    lastUpdate: { type: Date, default: Date.now }
}, { timestamps: true });

const TranslationJob = mongoose.model('TranslationJob', translationJobSchema);
module.exports = TranslationJob;
