
const mongoose = require('mongoose');

const titleGenJobSchema = new mongoose.Schema({
    novelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Novel', required: true },
    novelTitle: String,
    cover: String,
    status: { type: String, enum: ['active', 'paused', 'completed', 'failed'], default: 'active' },
    currentChapter: { type: Number, default: 0 },
    targetChapters: [Number], // أرقام الفصول المستهدفة
    processedCount: { type: Number, default: 0 },
    totalToProcess: { type: Number, default: 0 },
    logs: [{ 
        message: String, 
        type: { type: String, enum: ['info', 'success', 'error', 'warning'] },
        timestamp: { type: Date, default: Date.now }
    }],
    startTime: { type: Date, default: Date.now },
    lastUpdate: { type: Date, default: Date.now }
}, { timestamps: true });

const TitleGenJob = mongoose.model('TitleGenJob', titleGenJobSchema);
module.exports = TitleGenJob;
