// backend/services/chaptersListCache.service.js
//
// 🔥 كاش قائمة الفصول المدموجة (MongoDB + Firestore) في الذاكرة.
//
// كان مسار /api/novels/:id/chapters-list يقرأ *كل* فصول الرواية من Firestore
// في *كل* طلب — حتى مع pagination! (رواية من 1000 فصل = 1000 قراءة Firestore
// لكل مستخدم لكل صفحة). الآن: القائمة المدموجة تُبنى مرة واحدة وتُحفظ هنا
// (TTL دقيقة) والصفحات/الترتيب/البحث تُطبق على النسخة المخزنة — صفحات لا نهائية
// بصفر استهلاك Firestore.
//
// الإبطال تلقائي عبر chapterMirror (كل مسار كتابة فصل يستدعيها) + TTL كشبكة أمان.

const TTL_MS = 60 * 1000; // دقيقة واحدة — فصل جديد يظهر بحد أقصى بعد دقيقة
const MAX_NOVELS = 300;   // حوالي: 300 رواية نشطة × قائمة وصفية صغيرة

// `${novelId}:${roleBucket}` -> { chapters: [...], at }
const cache = new Map();

function roleBucketOf(isAdmin) {
    return isAdmin ? 'admin' : 'user';
}

function get(novelId, isAdmin) {
    const key = `${novelId}:${roleBucketOf(isAdmin)}`;
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.at > TTL_MS) {
        cache.delete(key);
        return null;
    }
    return entry.chapters;
}

function set(novelId, isAdmin, chapters) {
    const key = `${novelId}:${roleBucketOf(isAdmin)}`;
    if (cache.size >= MAX_NOVELS) {
        // أزل الأقدم أولاً (Map يحفظ ترتيب الإدراج)
        const oldest = cache.keys().next().value;
        cache.delete(oldest);
    }
    cache.set(key, { chapters, at: Date.now() });
}

function invalidate(novelId) {
    const prefix = `${novelId}:`;
    for (const key of Array.from(cache.keys())) {
        if (key.startsWith(prefix)) cache.delete(key);
    }
}

function invalidateAll() {
    cache.clear();
}

module.exports = {
    get,
    set,
    invalidate,
    invalidateAll,
    TTL_MS,
};
