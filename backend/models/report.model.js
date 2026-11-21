const mongoose = require('mongoose');

// Reader chapter report (الإبلاغ عن فصل) submitted from the reader screen.
const reportSchema = new mongoose.Schema({
    novelId: { type: String, default: '' },
    novelTitle: { type: String, default: '' },
    chapterNumber: { type: Number, default: 0 },
    chapterTitle: { type: String, default: '' },
    types: { type: [String], default: [] },
    details: { type: String, default: '', maxLength: 2000 },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    status: { type: String, enum: ['open', 'resolved'], default: 'open' },
    createdAt: { type: Date, default: Date.now },
}, { timestamps: true });

reportSchema.index({ createdAt: -1 });

const Report = mongoose.model('Report', reportSchema);
module.exports = Report;
