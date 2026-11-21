const mongoose = require('mongoose');

const metadataTranslationJobSchema = new mongoose.Schema({
    novelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Novel', required: true },
    novelTitle: String,
    cover: String,
    status: { type: String, enum: ['active', 'completed', 'failed'], default: 'active' },
    processedCount: { type: Number, default: 0 },
    totalSteps: { type: Number, default: 3 }, // عنوان، وصف، تصنيفات
    logs: [{
        message: String,
        type: { type: String, enum: ['info', 'success', 'error', 'warning'] },
        timestamp: { type: Date, default: Date.now }
    }],
    startTime: { type: Date, default: Date.now },
    lastUpdate: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model('MetadataTranslationJob', metadataTranslationJobSchema);