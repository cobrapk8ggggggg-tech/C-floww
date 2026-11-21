const mongoose = require('mongoose');

const chapterSchema = new mongoose.Schema({
    number: { type: Number, required: true },
    title: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }, 
    views: { type: Number, default: 0 }
});

const novelSchema = new mongoose.Schema({
    title: { type: String, required: true, index: true },
    titleEn: { type: String },
    author: { type: String, required: true }, 
    authorEmail: { type: String }, 
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // 🔥 NEW FIELD
    cover: { type: String }, 
    description: { type: String },
    category: { type: String, index: true },
    tags: [{ type: String, index: true }], 
    status: { type: String, default: 'مستمرة' }, // Internal Status
    rating: { type: Number, default: 0 },
    
    // 🔥 Watchlist & Scraper Fields
    sourceUrl: { type: String }, // رابط المصدر الأصلي
    sourceStatus: { type: String }, // الحالة في المصدر (Ongoing/Completed)
    sourceChaptersCount: { type: Number, default: 0 }, // 🔥 NEW: أعلى رقم فصل تم استلامه من المصدر (يستخدم لعرض العدد الإجمالي للفصول حتى قبل الترجمة)
    isWatched: { type: Boolean, default: false }, // هل هي في قائمة المراقبة اليومية؟
    
    views: { type: Number, default: 0 }, 
    viewedBy: [{ type: String }], 

    dailyViews: { type: Number, default: 0 },
    weeklyViews: { type: Number, default: 0 },
    monthlyViews: { type: Number, default: 0 },
    
    favorites: { type: Number, default: 0 },
    
    reactions: {
        like: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], 
        love: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], 
        funny: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], 
        sad: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], 
        angry: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }] 
    },

    chapters: [chapterSchema],
    lastChapterUpdate: { type: Date, default: Date.now },
    isRecommended: { type: Boolean, default: false },
    isTrending: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
});

novelSchema.index({ title: 'text', author: 'text' });
novelSchema.index({ views: -1 });
novelSchema.index({ lastChapterUpdate: -1 });
novelSchema.index({ authorEmail: 1 }); 
novelSchema.index({ isWatched: 1 }); // فهرس للبحث السريع عن الروايات المراقبة

const Novel = mongoose.model('Novel', novelSchema);
module.exports = Novel;