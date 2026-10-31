
const mongoose = require('mongoose');

const novelLibrarySchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    novelId: { type: String, required: true }, // ID from Firebase or local data
    title: { type: String },
    cover: { type: String },
    author: { type: String },
    lastChapterId: { type: Number }, // The bookmark (where to resume)
    maxReadChapterId: { type: Number, default: 0 }, // Kept for legacy support/sorting
    readChapters: [{ type: Number }], // ✨ New: Array to store specifically read chapter numbers
    lastChapterTitle: { type: String },
    progress: { type: Number, default: 0 }, // Percentage 0-100
    isFavorite: { type: Boolean, default: false },
    lastReadAt: { type: Date, default: Date.now }
}, { timestamps: true });

// Ensure unique novel per user
novelLibrarySchema.index({ user: 1, novelId: 1 }, { unique: true });

const NovelLibrary = mongoose.model('NovelLibrary', novelLibrarySchema);
module.exports = NovelLibrary;
