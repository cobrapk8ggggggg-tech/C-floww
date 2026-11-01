
const mongoose = require('mongoose');

const commentSchema = new mongoose.Schema({
    novelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Novel', required: true, index: true },
    // 🔥 New: Chapter Number (Optional). If null, it's a general novel review.
    chapterNumber: { type: Number, default: null, index: true },
    
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    content: { type: String, required: true },
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Comment', default: null, index: true }, // للردود
    
    // التفاعلات
    likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    dislikes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    
    // ردود الفعل التعبيرية
    reactions: {
        love: { type: Number, default: 0 },
        funny: { type: Number, default: 0 },
        sad: { type: Number, default: 0 },
        angry: { type: Number, default: 0 },
        wow: { type: Number, default: 0 }
    },

    isSpoiler: { type: Boolean, default: false },
    isEdited: { type: Boolean, default: false }, // 🔥 New: Track if edited
    createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

// Virtual field for reply count to avoid deep population performance hit
commentSchema.virtual('replyCount', {
    ref: 'Comment',
    localField: '_id',
    foreignField: 'parentId',
    count: true
});

// إعدادات لجلب البيانات الافتراضية
commentSchema.set('toObject', { virtuals: true });
commentSchema.set('toJSON', { virtuals: true });

const Comment = mongoose.model('Comment', commentSchema);
module.exports = Comment;
