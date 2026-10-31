// backend/services/chapterMirror.service.js
//
// 🔥 مرآة محتوى الفصول (MongoDB) + ذاكرة فورية — ضد نفاد حصة Firestore.
//
// القراءة العامة للفصول تمر عبر: الذاكرة الفورية → Firestore (وتُرسَّب في
// المرآة) → المرآة عند نفاد الحصة. مسارات الكتابة (إضافة/تعديل/حذف/تنظيف/
// ترجمة) تُبقي المرآة متزامنة عبر هذه الدوال — كلها fire & forget بلا تعطيل
// الطلب الأصلي ولا إسقاطه إن فشلت المرآة (المرآة شبكة أمان فقط).
const ChapterContentMirror = require('../models/chapterContentMirror.model.js');
// كاش قائمة الفصول المدموجة — يُبطل تلقائياً مع كل كتابة فصل (كل مسارات الكتابة تمر هنا)
const chaptersListCache = require('./chaptersListCache.service.js');

// ---------- الذاكرة الفورية ----------
const memCache = new Map(); // `${novelId}:${number}` -> { content, at }
const MEM_CACHE_MAX = 600;

function memSet(novelId, number, content) {
    const key = `${novelId}:${number}`;
    if (memCache.size >= MEM_CACHE_MAX) {
        const oldest = memCache.keys().next().value;
        memCache.delete(oldest);
    }
    memCache.set(key, { content, at: Date.now() });
}

function memGet(novelId, number) {
    return memCache.get(`${novelId}:${number}`)?.content;
}

function memDelete(novelId, number) {
    memCache.delete(`${novelId}:${number}`);
}

function memClearNovel(novelId) {
    const prefix = `${novelId}:`;
    for (const key of memCache.keys()) {
        if (key.startsWith(prefix)) memCache.delete(key);
    }
}

function memClearAll() {
    memCache.clear();
}

// ---------- عمليات المرآة (كلها آمنة الفشل) ----------
function upsertMirror(novelId, number, content) {
    memSet(novelId, number, content);
    chaptersListCache.invalidate(novelId);
    return ChapterContentMirror.updateOne(
        { novelId: String(novelId), number: Number(number) },
        { content: String(content || ''), updatedAt: new Date() },
        { upsert: true }
    ).catch((e) => console.error('❌ mirror upsert failed:', e.message));
}

function deleteMirror(novelId, number) {
    memDelete(novelId, number);
    chaptersListCache.invalidate(novelId);
    return ChapterContentMirror.deleteOne({ novelId: String(novelId), number: Number(number) })
        .catch((e) => console.error('❌ mirror delete failed:', e.message));
}

function clearNovelMirror(novelId) {
    memClearNovel(novelId);
    chaptersListCache.invalidate(novelId);
    return ChapterContentMirror.deleteMany({ novelId: String(novelId) })
        .catch((e) => console.error('❌ mirror clear-novel failed:', e.message));
}

function clearAllMirror() {
    memClearAll();
    chaptersListCache.invalidateAll();
    return ChapterContentMirror.deleteMany({})
        .catch((e) => console.error('❌ mirror clear-all failed:', e.message));
}

function isFirestoreQuotaError(err) {
    const msg = String(err?.message || '');
    return /RESOURCE_EXHAUSTED|Quota exceeded|quota/i.test(msg) || err?.code === 8;
}

// ---------- القراءة الموحّدة: الذاكرة → Firestore (+ ترسيب المرآة) → المرآة ----------
async function fetchChapterContent(firestore, novelId, chapterNumber) {
    const cached = memGet(novelId, chapterNumber);
    if (cached !== undefined) return cached;

    if (!firestore) throw new Error('FIRESTORE_NOT_INITIALIZED');

    try {
        const docRef = firestore.collection('novels').doc(String(novelId)).collection('chapters').doc(String(chapterNumber));
        const docSnap = await docRef.get();
        if (!docSnap.exists) {
            console.warn(`⚠️ Chapter content not found in Firestore for novel ${novelId}, chapter ${chapterNumber}`);
            return null;
        }
        const content = docSnap.data().content || '';
        memSet(novelId, chapterNumber, content);
        // ترسيب المرآة (fire & forget — لا يعرقل الاستجابة)
        ChapterContentMirror.updateOne(
            { novelId: String(novelId), number: Number(chapterNumber) },
            { content, updatedAt: new Date() },
            { upsert: true }
        ).catch((e) => console.error('❌ mirror upsert failed:', e.message));
        // قراءة المحتوى لا تغيّر قائمة الفصول — لا إبطال هنا عمداً
        return content;
    } catch (firestoreError) {
        if (isFirestoreQuotaError(firestoreError)) {
            // 🔥 الحصة نفدت → المرآة هي الشبكة الأمان
            try {
                const mirror = await ChapterContentMirror.findOne({ novelId: String(novelId), number: Number(chapterNumber) }).lean();
                if (mirror && mirror.content) {
                    console.warn(`⚠️ Firestore quota exceeded — serving chapter ${chapterNumber} of ${novelId} from MongoDB mirror`);
                    memSet(novelId, chapterNumber, mirror.content);
                    return mirror.content;
                }
            } catch (mirrorErr) {
                console.error('❌ Mirror read failed:', mirrorErr.message);
            }
            console.error('❌ Firestore quota exceeded and no mirror copy for chapter', chapterNumber, 'of', novelId);
            throw firestoreError;
        }
        throw firestoreError;
    }
}

module.exports = {
    upsertMirror,
    deleteMirror,
    clearNovelMirror,
    clearAllMirror,
    isFirestoreQuotaError,
    fetchChapterContent,
};
