/**
 * 📚 المستخرج الذكي — استخراج مصطلحات الرواية كاملة قبل الترجمة (نظام جديد مستقل)
 *
 * ⚡ حلقة المزوّدات هنا منقولة حرفياً من المترجم الأصلي (translatorRoutes →
 *    processTranslationJob) — نفس البنية ونفس السجلات ونفس السلوك بلا أي ابتعاد:
 *      • محادثات لاصقة لكل توكن (نفس أغراض/دفاتر المترجم — 100 فصل لكل دفعة)
 *      • التوكن اللاصق لديه 5 محاولات (DEEPSEEK_MAX_ATTEMPTS_PER_TOKEN) ثم ينتقل
 *        للتوكِن التالي («➡️ فشل التوكن ... الانتقال لتوكن آخر»)
 *      • Qwen = استبعاد التوكنات الموسومة/الميتة/المملوكة لمزوّد آخر + حسابات
 *        تلقائية عند نقص التوكنات + جولتا حساب جديد كلياً (forceNew) عند فشل الكل
 *        + «لا انتقال لمزوّد آخر أبداً» + وسوم الفشل (24س/ميت/30د) كما هي
 *      • فشل كامل → انتظار 30 دقيقة وإعادة المحاولة على نفس الفصل (كالمترجم)
 *      • تفضيل المزوّد/التوكن الناجح في الفصل السابق (stickySuccessRoute)
 *
 * الفرق الوحيد عن المترجم: بدل ترجمة الفصل، يستخرج من نصه الأصلي (أي لغة)
 * المصطلحات (أسماء شخصيات/أماكن/عناصر/رتب/مفاهيم) مع اقتراح الترجمة العربية،
 * ويغذيها في المسرد (Glossary) — ليكتمل مسرد الرواية كله قبل بدء الترجمة،
 * فتُوزَّع فصول الرواية بعد ذلك على عدة مهام ترجمة تعمل بسرعة مع مسرد جاهز.
 *
 * ⚠️ نظام إضافي مستقل تماماً: لا يمس المترجم ولا المراجع ولا أي نظام قائم.
 */
const mongoose = require('mongoose');
const Novel = require('../models/novel.model.js');
const Glossary = require('../models/glossary.model.js');
const GlossaryExtractionJob = require('../models/glossaryExtractionJob.model.js');
const Settings = require('../models/settings.model.js');
const qwenAutoAccount = require('../services/qwenAutoAccount.service.js');
const {
    callTranslationProvider,
    getGlobalSettings,
    getProviderAuthKeys,
    isDeepSeekProvider,
    isQwenProvider,
    isGeminiWebProvider,
    GUEST_TOKEN_SENTINEL,
    // 🔥 نفس أدوات حلقة المترجم الأصلي — إعادة استخدام بلا نسخ ولا انحراف:
    isStickyChatProvider,
    resetConversationContextPurposeForScope,
    getTokenConversationScope,
    isTranslationOnlyModel,
    findLLMModel,
    DEEPSEEK_CHAPTERS_PER_CONVERSATION,
    DEEPSEEK_MAX_ATTEMPTS_PER_TOKEN,
} = require('./translatorRoutes')._ai;

// --- Firestore Setup (MANDATORY — نفس مخزن فصول المترجم) ---
let firestore;
try {
    const firebaseAdmin = require('../config/firebaseAdmin');
    firestore = firebaseAdmin.db;
} catch (e) {
    console.error("❌ CRITICAL: Firestore not loaded. Glossary extractor cannot work without it.");
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** تصنيفات المسرد المسموحة (نفس نموذج Glossary) */
const TERM_CATEGORIES = ['characters', 'locations', 'items', 'ranks', 'other'];
const CATEGORY_LABELS = {
    characters: 'شخصيات',
    locations: 'أماكن',
    items: 'عناصر',
    ranks: 'رتب',
    other: 'أخرى',
};

/** تطبيع تصنيف الرد من النموذج إلى تصنيفات المسرد (نفس تحويل المترجم) */
function normalizeCategory(raw) {
    let c = String(raw || '').toLowerCase().trim();
    if (c === 'character' || c === 'شخصية' || c === 'شخصيات') return 'characters';
    if (c === 'location' || c === 'مكان' || c === 'أماكن' || c === 'موقع') return 'locations';
    if (c === 'item' || c === 'عنصر' || c === 'عناصر' || c === 'شيء') return 'items';
    if (c === 'rank' || c === 'رتبة' || c === 'رتب') return 'ranks';
    if (c === 'concept' || c === 'مفهوم' || c === 'مفاهيم') return 'other';
    return TERM_CATEGORIES.includes(c) ? c : 'other';
}

/**
 * 🧠 بناء توجيه الاستخراج — من النص الأصلي فقط (قبل الترجمة — لا يوجد نص عربي
 * مقترن بعد). النموذج يقترح الترجمة العربية المعتمدة لكل مصطلح بنفسه.
 * نفس قواعد قالب الاستخراج الافتراضي في المترجم (DEFAULT_EXTRACT_PROMPT).
 */
function buildExtractionPrompt(content, chapterNum) {
    return `ROLE: Expert Web Novel Terminology Extractor.
TASK: Analyze the "Source Text" below (any language: English/Chinese/Korean/Japanese/Russian/...) which is chapter ${chapterNum} of a web novel, and extract key proper nouns, unique concepts, and specific terminology to build a comprehensive Glossary (Codex) for the whole novel BEFORE translation.

STRICT RULES:
1.  Categories: Classify each extracted term into one of: 'character', 'location', 'item', 'rank', 'concept', 'other'.
    *   character: Names of individuals, specific titles referring to a person.
    *   location: Cities, villages, geographical regions, buildings, headquarters.
    *   item: Tools, weapons, materials, unique objects, or specific creatures.
    *   rank: General military, social, or cultivation ranks (not specific character names).
    *   concept: Spiritual, philosophical, cultivation terms, general techniques, or abstract ideas.
    *   other: Any other important term that doesn't fit the above categories.
2.  Format: Return a clean JSON array of objects.
3.  Content:
    *   "name": The exact original term as written in the source text (any language). Capitalized where appropriate.
    *   "translation": الترجمة العربية المقترحة المعتمدة للمصطلح (النقل الصوتي الصحيح للأسماء، والترجمة الدقيقة للمصطلحات).
    *   "description": وصف قصير جداً باللغة العربية (2-4 كلمات)، مثل: "البطل الرئيسي", "مهارة سيف", "طريقة زراعة", "طاقة روحية".
4.  Filtering & Exclusion (قواعد التصفية والاستبعاد):
    *   Ignore common words. Only specific names, places, unique cultivation terms, and key concepts should be extracted.
    *   Blacklist (تجاهل تام - لا تستخرج هذه أبداً):
        *   الأرقام المنفردة أو أرقام الفصول (مثال: 1, 500, Chapter 10, 第10章).
        *   عبارات النظام أو الإشعارات (مثال: Ding, System alert, Level Up).
        *   جمل التفاعل والإعلانات (مثال: Subscribe, Read at..., Translator notes).
        *   الأفعال والصفات العادية (مثال: run, fast, big, eat, go).
        *   الكلمات الشائعة جداً التي لا تعتبر مصطلحات خاصة.
5.  Accuracy (الدقة):
    *   Each extracted term must be unique (in its original language).
    *   Extracted terms must be meaningful within their context.
    *   إذا لم تجد مصطلحات جديدة حقيقية في الفصل أعد مصفوفة فارغة [] — هذا نجاح وليس فشلاً.

OUTPUT JSON STRUCTURE:
[
  { "category": "character", "name": "Fang Yuan", "translation": "فانغ يوان", "description": "البطل الرئيسي" },
  { "category": "concept", "name": "Immortal Gu", "translation": "غو الخالد", "description": "عنصر زراعة" },
  { "category": "location", "name": "Green Mountain Sect", "translation": "طائفة الجبل الأخضر", "description": "مقر الطائفة" }
]

RETURN ONLY JSON:

--- Source Text ---
${String(content || '').substring(0, 9000)}
--- نهاية النص الأصلي ---`;
}

/** استخراج مصفوفة المصطلحات من رد النموذج (متسامح مع backticks والزوائد — نفس منطق المترجم) */
function parseExtractedTerms(rawText) {
    let jsonText = String(rawText || '').trim();
    if (jsonText.startsWith('```json')) jsonText = jsonText.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    else if (jsonText.startsWith('```')) jsonText = jsonText.replace(/^```\s*/, '').replace(/\s*```$/, '');
    if (/^json\s*[\n\r]/i.test(jsonText)) jsonText = jsonText.replace(/^json\s*[\n\r]+/i, '');
    // 🔥 الأقوى: استخرج أول [ ] أو { } مباشرة
    const match = jsonText.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
    if (match) jsonText = match[1];
    const parsed = JSON.parse(jsonText);
    const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.terms) ? parsed.terms : []);
    const terms = [];
    const seen = new Set();
    for (const t of arr) {
        const name = String(t.name || t.term || '').trim();
        const translation = String(t.translation || '').trim();
        if (!name || !translation) continue;
        if (name.length > 80 || translation.length > 120) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        terms.push({
            name,
            translation,
            category: normalizeCategory(t.category),
            description: String(t.description || '').trim().substring(0, 160),
        });
    }
    return terms;
}

/** حفظ المصطلحات في المسرد (نفس upsert المترجم — فريد لكل novelId+term) */
async function saveExtractedTerms(novelId, terms) {
    let saved = 0;
    for (const t of terms) {
        try {
            await Glossary.updateOne(
                { novelId, term: t.name },
                {
                    $set: { translation: t.translation, category: t.category, description: t.description },
                    $setOnInsert: { autoGenerated: true }
                },
                { upsert: true }
            );
            saved++;
        } catch (e) { console.log('Glossary upsert error:', e.message); }
    }
    return saved;
}

async function pushLog(jobId, message, type) {
    try {
        await GlossaryExtractionJob.findByIdAndUpdate(jobId, {
            $push: { logs: { message, type: type || 'info' } },
            $set: { lastUpdate: new Date() }
        });
    } catch (e) { console.log('pushLog error:', e.message); }
}

// =========================================================
// 🔁 عامل الاستخراج — حلقة المزوّدات منقولة حرفياً من عامل المترجم الأصلي:
//    مزوّدات مرتبة بالأولوية → 5 محاولات لكل توكن لاصق → انتقال للتوكِن التالي
//    → حسابات Qwen تلقائية (جولتان forceNew) → بلا انتقال لمزوّد آخر أبداً
//    → إعادة المحاولة على نفس الفصل بعد 30 دقيقة حتى ينجح.
//    الفرق الوحيد: بعد نجاح النداء نستخرج المصطلحات بدل ترجمة الفصل.
// =========================================================
async function processGlossaryJob(jobId) {
    try {
        const job = await GlossaryExtractionJob.findById(jobId);
        if (!job || job.status !== 'active') return;

        if (!firestore) {
            job.status = 'failed';
            job.logs.push({ message: 'خطأ خادم: قاعدة بيانات النصوص (Firestore) غير متصلة', type: 'error' });
            await job.save();
            return;
        }

        const novel = await Novel.findById(job.novelId);
        if (!novel) {
            job.status = 'failed';
            job.logs.push({ message: 'الرواية لم تعد موجودة', type: 'error' });
            await job.save();
            return;
        }

        const settings = await getGlobalSettings();

        // 🔥 نفس منطق المترجم: مزوّدات جديدة ← احتياطياً مفاتيح قديمة كمزوّد Gemini
        let providers = settings?.translationProviders && settings.translationProviders.length > 0
            ? settings.translationProviders.slice()
            : [];
        if (providers.length === 0) {
            const legacyKeys = settings?.translatorApiKeys || [];
            if (legacyKeys.length > 0) {
                const legacyModel = settings?.translatorModel || 'gemini-2.5-flash';
                providers = [{
                    providerId: 'gemini',
                    name: 'Gemini (Legacy)',
                    baseUrl: '',
                    models: [{ modelId: legacyModel, modelName: legacyModel }],
                    apiKeys: legacyKeys,
                    selectedModel: legacyModel,
                    priority: 0
                }];
            }
        }
        if (providers.length === 0) {
            job.status = 'failed';
            job.logs.push({ message: 'لا توجد مزوّدات ذكاء اصطناعي مفعّلة مع مفاتيح API.', type: 'error' });
            await job.save();
            return;
        }
        providers.sort((a, b) => (a.priority || 0) - (b.priority || 0));

        const chaptersToProcess = (job.targetChapters || []).slice().sort((a, b) => a - b);

        // ⏱️ الفاصل بين الفصول — مضبوط من الواجهة (ثواني) ويُقرأ حياً من المهمة كل فصل
        const initialDelaySec = Math.max(0, Math.min(3600, Number(job.chapterDelayMs ?? 3000) / 1000));
        await pushLog(jobId, `📚 بدء استخراج المصطلحات: ${chaptersToProcess.length} فصلاً — المزوّد الأول ${providers[0].name || providers[0].providerId} | ⏱️ الفاصل بين الفصول: ${initialDelaySec} ثانية`, 'info');

        // 🔥 محادثات لاصقة لكل توكن (نفس نظام المترجم: أغراض المحادثة + دفعة 100 فصل)
        const conversationContexts = { glossary: new Map() };
        // 🔥 تفضيل المزوّد/التوكن الذي نجح في الفصل السابق (نفس سلوك المترجم)
        let stickySuccessRoute = null;

        for (const [chapterIndex, chapterNum] of chaptersToProcess.entries()) {
            const freshJob = await GlossaryExtractionJob.findById(jobId);
            // 🔥 Check for pause or stop (كالمترجم حرفياً)
            if (!freshJob || freshJob.status !== 'active') {
                if (freshJob && freshJob.status === 'paused') {
                    await pushLog(jobId, `⏸️ تم إيقاف الاستخراج مؤقتاً عند الفصل ${chapterNum}`, 'warning');
                }
                break;
            }

            const conversationBatchKey = Math.floor(chapterIndex / DEEPSEEK_CHAPTERS_PER_CONVERSATION);
            const isFirstChapterInBatch = chapterIndex % DEEPSEEK_CHAPTERS_PER_CONVERSATION === 0;
            if (isFirstChapterInBatch) {
                await pushLog(jobId, `💬 بدء محادثات جديدة للفصول ${chapterIndex + 1}-${Math.min(chapterIndex + DEEPSEEK_CHAPTERS_PER_CONVERSATION, chaptersToProcess.length)} (استخراج المصطلحات)`, 'info');
            }

            // 1) جلب نص الفصل الأصلي من نفس مخزن المترجم
            let content = '';
            try {
                const docSnap = await firestore.collection('novels').doc(novel._id.toString())
                    .collection('chapters').doc(chapterNum.toString()).get();
                if (docSnap.exists) content = docSnap.data().content || '';
            } catch (fsErr) {
                console.log(`Firestore fetch error (glossary-extract) Ch ${chapterNum}:`, fsErr.message);
            }

            if (!content || content.trim().length === 0) {
                await pushLog(jobId, `تخطي الفصل ${chapterNum}: المحتوى غير موجود في السيرفر`, 'warning');
                await GlossaryExtractionJob.findByIdAndUpdate(jobId, {
                    $pull: { targetChapters: chapterNum },
                    $set: { currentChapter: chapterNum, lastUpdate: new Date() }
                });
                await delay(Math.max(0, Math.min(3600000, freshJob.chapterDelayMs ?? 3000)));
                continue;
            }

            // 2) 🔁 نفس حلقة المترجم حرفياً: while → مزوّدات → 5 محاولات لكل توكن →
            //    حسابات Qwen تلقائية → انتظار 30 دقيقة → إعادة المحاولة على نفس الفصل
            const prompt = buildExtractionPrompt(content, chapterNum);
            const RETRY_DELAY_MS = 30 * 60 * 1000;
            let attempt = 0;
            let extractedTerms = null;
            let extractionSuccess = false;
            // نفس مبدأ lastValidationReasons في المترجم: نوع فشل المحاولة السابقة
            // ('review' = رد غير JSON → توجيه إصلاحي | 'error' = فشل مزوّد)
            let chapterFailureKind = null;

            while (!extractionSuccess) {
                attempt++;
                const freshAttemptJob = await GlossaryExtractionJob.findById(jobId);
                if (!freshAttemptJob || freshAttemptJob.status !== 'active') break;

                if (attempt > 1) {
                    await pushLog(jobId, `🔄 محاولة ${attempt}: إعادة استخراج مصطلحات الفصل ${chapterNum} حتى ينجح`, 'info');
                }

                // نفس مبدأ إعادة الترجمة الإصلاحية (buildRepairTranslationPrompt) في المترجم:
                // فشل JSON في المحاولة السابقة → توجيه إصلاحي يصرّ بمخرجات JSON فقط
                const promptForAttempt = chapterFailureKind === 'review'
                    ? `${prompt}\n\n⚠️ ملاحظة إصلاحية: محاولتك السابقة لم تُرجع JSON صالحاً. أعد المحاولة وأخرج مصفوفة JSON فقط (تبدأ بـ [ وتنتهي بـ ]) دون أي شرح أو backticks أو أي نص إضافي.`
                    : prompt;

                // 🔥 محاولة استخراج كاملة بتوكن واحد — نفس بنية attemptChapterWithToken في المترجم
                //    حرفياً: النتيجة { ok: true } أو { ok: false, kind: 'review' | 'error' }.
                const attemptExtractWithToken = async (prov, model, key, keyIdx, keysCount, tokenAttempt, tokenAttempts, attemptNo) => {
                    const provName = prov.name || prov.providerId;
                    const provIsSticky = isStickyChatProvider(prov);
                    const conversationScopeKey = provIsSticky ? getTokenConversationScope(prov, key, keyIdx) : undefined;
                    try {
                        const retryLabel = provIsSticky ? ` | محاولة التوكن ${tokenAttempt}/${tokenAttempts}` : '';
                        await pushLog(jobId, `1️⃣ مزوّد: ${provName} | نموذج: ${model} | مفتاح ${keyIdx + 1}/${keysCount} | محاولة ${attemptNo}${retryLabel}`, 'info');
                        let raw;
                        try {
                            raw = await callTranslationProvider(prov, model, key, promptForAttempt, {
                                deepSeekJobId: jobId.toString(),
                                conversationContexts,
                                conversationPurpose: 'glossary',
                                conversationBatchKey,
                                conversationScopeKey,
                                // 🔥 يسمح لخدمة Gemini Web بإظهار ملاحظات الإكمال التلقائي في سجل المهمة
                                log: (msg, level) => pushLog(jobId, `[Gemini Web] ${msg}`, level || 'info')
                            });
                        } catch (genErr) {
                            // 🔥 قاتل حلقة "نفس الحساب" — نفس وسوم المترجم حرفياً:
                            // RateLimited → 24 ساعة، مصادقة → ميت، خطأ غير مصنّف → موسم 30 دقيقة
                            if (isQwenProvider(prov)) {
                                const verdict = qwenAutoAccount.markTokenFailure(key, genErr);
                                if (verdict === 'rate-limited-24h') {
                                    await pushLog(jobId, `⏳ توكن Qwen مستهلك (RateLimited): وُسم 24 ساعة وسيُستبعد ويُستبدل بحساب جديد تلقائياً`, 'warning');
                                } else if (verdict === 'dead') {
                                    await pushLog(jobId, `🔒 توكن Qwen غير صالح (فشل مصادقة): وُسم ميتاً وسيُستبعد`, 'warning');
                                } else if (verdict === 'limited-30m') {
                                    await pushLog(jobId, `🧯 فشل غير مصنّف من حساب Qwen (${genErr.message}) — وُسم التوكن 30 دقيقة احتياطاً حتى لا يتكرر نفس الحساب في الحلقة`, 'warning');
                                }
                            }
                            throw genErr;
                        }
                        // تحليل الرد خارج فشل المزوّد — رد JSON تالف لا يوسم التوكن
                        // (نفس مبدأ فشل المراجعة في المترجم: kind 'review' → إعادة محاولة بلا إنشاء حسابات)
                        try {
                            const terms = parseExtractedTerms(raw);
                            extractedTerms = terms;
                            chapterFailureKind = null;
                            extractionSuccess = true;
                            stickySuccessRoute = { providerIndex: providers.indexOf(prov), keyIdx, key };
                            await pushLog(jobId, `✅ نجح استخراج المصطلحات باستخدام ${provName} (سيُكمل النظام من هذا المزود/التوكن في الفصل التالي)`, 'success');
                            return { ok: true, kind: null };
                        } catch (_) {
                            chapterFailureKind = 'review';
                            if (provIsSticky) resetConversationContextPurposeForScope(conversationContexts, 'glossary', conversationScopeKey, conversationBatchKey);
                            await pushLog(jobId, `⚠️ رد غير مفهوم من ${provName} (فشل تحليل JSON) — إعادة المحاولة`, 'warning');
                            return { ok: false, kind: 'review' };
                        }
                    } catch (err) {
                        console.error(`❌ (glossary-extract) فشل ${provName} مفتاح ${keyIdx + 1}: ${err.message}`);
                        chapterFailureKind = 'error';
                        await pushLog(jobId, `❌ فشل: ${err.message}`, 'warning');

                        // 🔥 Qwen: وسوم صامتة لأخطاء المصنّفة (كالمترجم حرفياً)
                        if (isQwenProvider(prov)) {
                            if (err && err.name === 'QwenRateLimitedError') qwenAutoAccount.markTokenRateLimited(key);
                            else if (err && err.name === 'QwenAuthError') qwenAutoAccount.markTokenDead(key);
                        }

                        if (provIsSticky && tokenAttempt < tokenAttempts) {
                            resetConversationContextPurposeForScope(conversationContexts, 'glossary', conversationScopeKey, conversationBatchKey);
                            await pushLog(jobId, `🔁 مزوّد المحادثة: سيتم إنشاء محادثات جديدة لنفس التوكن قبل إعادة المحاولة ${tokenAttempt + 1}/${tokenAttempts}`, 'warning');
                            await delay(3000);
                        }
                        return { ok: false, kind: 'error' };
                    }
                };

                const orderedProviders = stickySuccessRoute
                    ? [...providers.slice(stickySuccessRoute.providerIndex), ...providers.slice(0, stickySuccessRoute.providerIndex)]
                    : providers;

                for (const provider of orderedProviders) {
                    if (extractionSuccess) break;
                    const providerIndex = providers.indexOf(provider);
                    const providerName = provider.name || provider.providerId;
                    const modelToUse = provider.selectedModel || (provider.models && provider.models[0]?.modelId) || 'gemini-2.5-flash';
                    // 🔥 نفس استبدال خطوة الاستخراج في المترجم: نموذج ترجمة فقط (مثل m2m100)
                    // لا يصلح للاستخراج → يُستبدل بأول نموذج LLM لدى المزوّد
                    const modelForExtraction = isTranslationOnlyModel(modelToUse)
                        ? (findLLMModel(provider)?.modelId || modelToUse)
                        : modelToUse;
                    let keys = getProviderAuthKeys(provider);
                    const isDeepSeek = isDeepSeekProvider(provider);
                    const isQwen = isQwenProvider(provider);
                    const isGeminiWeb = isGeminiWebProvider(provider);
                    const isStickyChat = isStickyChatProvider(provider);

                    if (keys.length === 0 && !isDeepSeek && !isQwen && !(isGeminiWeb && provider.allowGuestFallback)) {
                        await pushLog(jobId, `⚠️ المزوّد ${providerName} ليس لديه مفاتيح – تخطيه`, 'warning');
                        continue;
                    }
                    // 🔥 وضع الضيف (نفس المترجم): مزوّد Gemini Web يعمل حتى بدون أي كوكيز
                    if (isGeminiWeb && provider.allowGuestFallback && keys.length === 0) {
                        keys = [GUEST_TOKEN_SENTINEL];
                        await pushLog(jobId, `🟡 تنبيه — وضع الضيف: مزوّد Gemini Web "${providerName}" بلا كوكيز، سيعمل الاستخراج عبر الوصول المجهول (بدون حساب). لتجربة أفضل وأسرع أضف كوكيز حساب Google في حقل المفاتيح`, 'warning');
                    }
                    if (isDeepSeek && keys.length === 0) {
                        keys = ['dummy-key-for-deepseek'];
                        await pushLog(jobId, `🔑 مزوّد DeepSeek: لا توجد توكنات محفوظة، سيتم استخدام الرمز الافتراضي من تطبيق DeepSeek`, 'info');
                    } else if (isDeepSeek) {
                        await pushLog(jobId, `🔑 مزوّد DeepSeek: سيتم استخدام ${keys.length} توكن محفوظ من حقل المفاتيح/التوكنات`, 'info');
                    }

                    // 🔥🔥🔥 Qwen AUTO-ACCOUNT (Qwen فقط — نفس طريقة المترجم حرفياً) 🔥🔥🔥
                    // لا نعتمد فقط على المفاتيح المحفوظة: تُستبعد التوكنات المستهلكة/الميتة،
                    // وإن لم يبقَ أي توكن صالح يُنشأ حساب Qwen جديد تلقائياً
                    // (بريد مؤقت → تسجيل → تفعيل → توكن) ويُكمل الاستخراج عليه فوراً.
                    if (isQwen) {
                        // 🔥 وعي الملكية: يُستبعد أيضاً أي توكن حساب تلقائي مملوك لمزوّد Qwen آخر —
                        // كل مزوّد يعمل على حساباته هو فقط فلا يتشارك مزوّدان حساباً واحداً.
                        const usableTokens = qwenAutoAccount.filterUsableQwenTokens(keys, provider.providerId);
                        if (usableTokens.length < keys.length) {
                            await pushLog(jobId, `🧹 مزوّد Qwen: استبعاد ${keys.length - usableTokens.length} توكن (موسوم/ميت أو مملوك لمزوّد آخر)`, 'info');
                            keys = usableTokens;
                        }
                        if (keys.length === 0) {
                            await pushLog(jobId, `🤖 مزوّد Qwen: لا يوجد أي توكن صالح لهذا المزوّد — جاري تجهيز حساب Qwen خاص به (بريد مؤقت → تسجيل → تفعيل → توكن)...`, 'info');
                            try {
                                const { account, created } = await qwenAutoAccount.ensureQwenAccount(provider.providerId);
                                provider.qwenTokens = Array.isArray(provider.qwenTokens) ? provider.qwenTokens : [];
                                if (!provider.qwenTokens.includes(account.token)) provider.qwenTokens.push(account.token);
                                try { await qwenAutoAccount.persistProviderToken(provider.providerId, account.token); } catch (_) {}
                                keys = [account.token];
                                if (created) {
                                    await pushLog(jobId, `✅ تم إنشاء حساب Qwen جديد خاص بهذا المزوّد (${account.email}) وسيبدأ الاستخراج عليه مباشرة`, 'success');
                                } else {
                                    await pushLog(jobId, `♻️ إعادة استخدام الحساب التلقائي الصالح الخاص بهذا المزوّد (${account.email}) — لم يُنشأ حساب جديد`, 'info');
                                }
                            } catch (accErr) {
                                await pushLog(jobId, `❌ تعذر إنشاء حساب Qwen تلقائياً الآن: ${accErr.message} — لن ننتقل لمزوّد آخر، ستُعاد المحاولة على Qwen`, 'warning');
                                break; // Qwen فقط: لا انتقال لمزوّد آخر أبداً
                            }
                        } else {
                            await pushLog(jobId, `🔑 مزوّد Qwen: سيتم استخدام ${keys.length} توكن صالح`, 'info');
                        }
                    }

                    // تفضيل التوكن الذي نجح في الفصل السابق (مطابقة بالنص لتحمّل تصفية التوكنات)
                    let preferredKeyIdx = 0;
                    if (stickySuccessRoute && stickySuccessRoute.providerIndex === providerIndex && stickySuccessRoute.key) {
                        const ki = keys.indexOf(stickySuccessRoute.key);
                        preferredKeyIdx = ki >= 0 ? ki : 0;
                    }
                    const orderedKeyIndexes = [...Array(keys.length).keys()].slice(preferredKeyIdx).concat([...Array(keys.length).keys()].slice(0, preferredKeyIdx));

                    let lastFailureKind = null;
                    for (const keyIdx of orderedKeyIndexes) {
                        const key = keys[keyIdx];
                        // 🔥 التوكن اللاصق لديه 5 محاولات (كالمترجم حرفياً) ثم ينتقل للتوكِن التالي
                        const tokenAttempts = isStickyChat ? DEEPSEEK_MAX_ATTEMPTS_PER_TOKEN : 1;
                        let tokenFailed = false;

                        for (let tokenAttempt = 1; tokenAttempt <= tokenAttempts; tokenAttempt++) {
                            const result = await attemptExtractWithToken(provider, modelForExtraction, key, keyIdx, keys.length, tokenAttempt, tokenAttempts, attempt);
                            if (result.ok) { lastFailureKind = null; break; }
                            tokenFailed = true;
                            lastFailureKind = result.kind || 'error';
                        }

                        if (extractionSuccess) break;
                        if (isStickyChat && tokenFailed && keyIdx < keys.length - 1) {
                            await pushLog(jobId, `➡️ ${providerName}: فشل التوكن ${keyIdx + 1} بعد ${tokenAttempts} محاولات؛ الانتقال لتوكن آخر وسيستمر استخدامه إذا نجح`, 'warning');
                            await delay(3000);
                        } else if (!isStickyChat && keyIdx < keys.length - 1) {
                            await delay(3000);
                        }
                    }

                    // 🔥🔥🔥 Qwen AUTO-ACCOUNT: فشلت كل التوكنات → إنشاء حساب جديد فوراً ومتابعة على Qwen فقط 🔥🔥🔥
                    // جولتان لكل محاولة (كالمترجم حرفياً). لا يتوقف ولا ينتقل لمزوّد آخر.
                    if (!extractionSuccess && isQwen && lastFailureKind === 'error') {
                        const AUTO_ROUNDS = 2;
                        for (let round = 1; round <= AUTO_ROUNDS && !extractionSuccess; round++) {
                            await pushLog(jobId, `🤖 مزوّد Qwen: فشلت جميع التوكنات (${keys.length}) — إنشاء حساب Qwen جديد كلياً (جولة ${round}/${AUTO_ROUNDS}) ومتابعة الاستخراج على Qwen فقط`, 'info');
                            let account;
                            let accountCreated = false;
                            try {
                                // 🔥 forceNew: بعد فشل فعلي يُنشأ حساب جديد كلياً دائماً —
                                // لا إعادة استخدام للحساب الفاشل مهما كان (قاتل الحلقة المفرغة).
                                const ensured = await qwenAutoAccount.ensureQwenAccount(provider.providerId, { forceNew: true });
                                account = ensured.account;
                                accountCreated = ensured.created;
                            } catch (accErr) {
                                await pushLog(jobId, `❌ تعذر إنشاء حساب Qwen تلقائياً الآن: ${accErr.message} — لن ننتقل لمزوّد آخر، ستُعاد المحاولة على Qwen`, 'warning');
                                break;
                            }
                            provider.qwenTokens = Array.isArray(provider.qwenTokens) ? provider.qwenTokens : [];
                            if (!provider.qwenTokens.includes(account.token)) provider.qwenTokens.push(account.token);
                            try { await qwenAutoAccount.persistProviderToken(provider.providerId, account.token); } catch (_) {}
                            keys.push(account.token);
                            if (accountCreated) {
                                await pushLog(jobId, `✅ حساب Qwen جديد كلياً جاهز (${account.email}) — إعادة استخراج الفصل ${chapterNum} بالتوكن الجديد`, 'success');
                            } else {
                                await pushLog(jobId, `⚠️ تعذّر إنشاء حساب مختلف الآن — إعادة المحاولة على حساب موجود (${account.email})`, 'warning');
                            }

                            const autoKeyIdx = keys.length - 1;
                            const autoTokenAttempts = 2;
                            for (let tokenAttempt = 1; tokenAttempt <= autoTokenAttempts && !extractionSuccess; tokenAttempt++) {
                                await attemptExtractWithToken(provider, modelForExtraction, account.token, autoKeyIdx, keys.length, tokenAttempt, autoTokenAttempts, attempt);
                            }
                            if (!extractionSuccess && round < AUTO_ROUNDS) await delay(3000);
                        }
                    }

                    if (!extractionSuccess) {
                        await pushLog(jobId, `🚫 جميع مفاتيح ${providerName} فشلت أو لم تجتز التحقق`, 'warning');
                        // 🔥 Qwen فقط: لا انتقال إلى مزوّد آخر — الدورة الخارجية ستعيد المحاولة
                        // على نفس الفصل (مع إنشاء حسابات Qwen جديدة عند الحاجة) حتى ينجح الاستخراج.
                        if (isQwen) break;
                    }
                }

                if (!extractionSuccess) {
                    stickySuccessRoute = null;
                    await pushLog(jobId, `⏳ لم ينجح استخراج الفصل ${chapterNum} بعد تجربة كل المزودين/التوكنات. سيتم الانتظار 30 دقيقة وإعادة المحاولة على نفس الفصل.`, 'warning');
                    await delay(RETRY_DELAY_MS);
                }
            }

            if (!extractionSuccess) break;
            // ========== End multi-provider extraction loop (مطابقة للمترجم) ==========

            // 3) حفظ المصطلحات في المسرد
            if (extractedTerms.length === 0) {
                await pushLog(jobId, `✅ الفصل ${chapterNum}: لا مصطلحات جديدة (فصل حواري/خالٍ من الأسماء)`, 'success');
            } else {
                const savedCount = await saveExtractedTerms(novel._id, extractedTerms);
                const catSummary = extractedTerms.reduce((acc, t) => { acc[t.category] = (acc[t.category] || 0) + 1; return acc; }, {});
                const catText = Object.entries(catSummary).map(([c, n]) => `${CATEGORY_LABELS[c] || c}: ${n}`).join('، ');
                await pushLog(jobId, `✅ الفصل ${chapterNum}: استُخرج ${extractedTerms.length} مصطلحاً وحُفظ ${savedCount} في المسرد (${catText})`, 'success');
            }

            await GlossaryExtractionJob.findByIdAndUpdate(jobId, {
                $inc: { processedCount: 1, newTermsCount: extractedTerms.length },
                $pull: { targetChapters: chapterNum },
                $set: { currentChapter: chapterNum, lastUpdate: new Date() }
            });

            // ⏱️ الفاصل بين الفصول — يُقرأ حياً من المهمة حتى يسري تغييره من الواجهة فوراً
            const postJob = await GlossaryExtractionJob.findById(jobId).select('chapterDelayMs');
            await delay(Math.max(0, Math.min(3600000, postJob?.chapterDelayMs ?? 3000)));
        }

        // النهاية: إن لم تبق فصول مستهدفة والمهمة لا تزال نشطة → مكتملة
        const finalJob = await GlossaryExtractionJob.findById(jobId);
        if (finalJob && finalJob.status === 'active') {
            const remaining = (finalJob.targetChapters || []).length;
            if (remaining === 0) {
                await GlossaryExtractionJob.findByIdAndUpdate(jobId, { status: 'completed' });
                await pushLog(jobId, `🏁 اكتمل استخراج المصطلحات! فصول معالجة: ${finalJob.processedCount} — مجموع المصطلحات: ${finalJob.newTermsCount}. المسرد جاهز الآن لتوزيع الترجمة على مهام متعددة`, 'success');
            } else {
                await pushLog(jobId, `⏳ توقف الاستخراج مع ${remaining} فصلاً لم يُعالج بعد (استئناف متاح)`, 'warning');
            }
        }
    } catch (err) {
        console.error('Glossary Extraction Job Error:', err);
        try {
            await GlossaryExtractionJob.findByIdAndUpdate(jobId, { status: 'failed' });
            await pushLog(jobId, `❌ خطأ قاتل في المهمة: ${err.message}`, 'error');
        } catch (_) { /* ignore */ }
    }
}

// ⏱️ تحويل قيمة الفاصل من الواجهة (ثواني) إلى ملي ثانية مع تحقق صارم — null إن كانت غير صالحة
function parseChapterDelaySeconds(value) {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 3600) return null;
    return Math.round(n * 1000);
}

// =========================================================
// 🔗 المسارات — /api/glossary-ai/* (نفس واجهة المراجع حرفياً)
// =========================================================
module.exports = function (app, verifyToken, verifyAdmin) {

    // 1) روايات الاستخراج — نفس نداء المراجع حرفياً (نفس واجهة اختيار الرواية)
    app.get('/api/glossary-ai/novels', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const { search, page = 1, limit = 20 } = req.query;
            const pageNum = parseInt(page);
            const limitNum = parseInt(limit);
            const skip = (pageNum - 1) * limitNum;
            let query = {};
            if (search) query.title = { $regex: search, $options: 'i' };
            const novels = await Novel.aggregate([
                { $match: query },
                {
                    $project: {
                        _id: 1, title: 1, cover: 1, author: 1, status: 1, createdAt: 1,
                        chaptersCount: {
                            $ifNull: ["$sourceChaptersCount", { $size: { $ifNull: ["$chapters", []] } }]
                        }
                    }
                },
                { $sort: { createdAt: -1 } },
                { $skip: skip },
                { $limit: limitNum }
            ]);
            res.json(novels);
        } catch (e) {
            console.error("Glossary AI Novels Error:", e);
            res.status(500).json({ error: e.message });
        }
    });

    // 2) بدء مهمة استخراج (أو استئناف ب jobId) — يقبل chapterDelay بالثواني
    app.post('/api/glossary-ai/start', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const { novelId, chapters, jobId, chapterDelay } = req.body;

            if (jobId) {
                const existingJob = await GlossaryExtractionJob.findById(jobId);
                if (!existingJob) return res.status(404).json({ message: "Job not found" });
                if ((existingJob.targetChapters || []).length === 0) {
                    return res.status(400).json({ message: "لا توجد فصول متبقية في هذه المهمة" });
                }
                const delayMs = parseChapterDelaySeconds(chapterDelay);
                if (delayMs !== null) existingJob.chapterDelayMs = delayMs;
                existingJob.status = 'active';
                existingJob.logs.push({ message: '▶️ تم استئناف مهمة استخراج المصطلحات' + (delayMs !== null ? ` | ⏱️ الفاصل: ${delayMs / 1000} ثانية` : ''), type: 'info' });
                await existingJob.save();
                processGlossaryJob(existingJob._id);
                return res.json({ message: "Job resumed", jobId: existingJob._id });
            }

            const novel = await Novel.findById(novelId);
            if (!novel) return res.status(404).json({ message: "Novel not found" });

            const settings = await getGlobalSettings();
            const providers = settings?.translationProviders || [];
            const anyKeys = providers.some(p => (p.apiKeys && p.apiKeys.length > 0) || isDeepSeekProvider(p) || isQwenProvider(p) || (isGeminiWebProvider(p) && p.allowGuestFallback));
            const legacyKeys = settings?.translatorApiKeys || [];
            if (!anyKeys && legacyKeys.length === 0) {
                return res.status(400).json({ message: "لا توجد مزوّدات ذكاء اصطناعي — أضف المفاتيح من إعدادات المترجم أولاً" });
            }

            let targetChapters = [];
            if (chapters === 'all' || chapters === undefined || chapters === null) {
                const mongoChapters = (novel.chapters || []).map(c => c.number);
                let firestoreChapters = [];
                if (firestore) {
                    try {
                        const snapshot = await firestore.collection('novels').doc(novel._id.toString()).collection('chapters').get();
                        firestoreChapters = snapshot.docs.map(doc => parseInt(doc.id)).filter(num => !isNaN(num));
                    } catch (err) {
                        console.error("Failed to fetch chapters from Firestore (glossary-ai):", err.message);
                    }
                }
                targetChapters = Array.from(new Set([...mongoChapters, ...firestoreChapters])).sort((a, b) => a - b);
            } else if (Array.isArray(chapters)) {
                targetChapters = chapters.map(n => parseInt(n)).filter(n => !isNaN(n));
            }

            if (targetChapters.length === 0) {
                return res.status(400).json({ message: "لا توجد فصول لاستخراج مصطلحاتها" });
            }

            const delayMs = parseChapterDelaySeconds(chapterDelay);
            const effectiveDelayMs = delayMs === null ? 3000 : delayMs;

            const job = new GlossaryExtractionJob({
                novelId,
                novelTitle: novel.title,
                cover: novel.cover,
                targetChapters,
                totalToExtract: targetChapters.length,
                chapterDelayMs: effectiveDelayMs,
                logs: [{ message: `تم بدء استخراج مصطلحات «${novel.title}» (استهداف ${targetChapters.length} فصلاً) | ⏱️ الفاصل بين الفصول: ${effectiveDelayMs / 1000} ثانية`, type: 'info' }]
            });
            await job.save();
            processGlossaryJob(job._id);
            res.json({ message: "Glossary extraction started", jobId: job._id });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 3) إيقاف مؤقت
    app.post('/api/glossary-ai/jobs/:id/pause', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const job = await GlossaryExtractionJob.findById(req.params.id);
            if (!job) return res.status(404).json({ message: "Job not found" });
            job.status = 'paused';
            job.logs.push({ message: '⏸️ طلب إيقاف مؤقت من المستخدم...', type: 'warning' });
            await job.save();
            res.json({ message: "Job paused" });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 4) حذف المهمة
    app.delete('/api/glossary-ai/jobs/:id', verifyToken, verifyAdmin, async (req, res) => {
        try {
            await GlossaryExtractionJob.findByIdAndDelete(req.params.id);
            res.json({ message: "Job deleted" });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 4.5) ⏱️ تغيير الفاصل بين الفصول لمهمة جارية (يتأثر من الفصل التالي فوراً)
    app.post('/api/glossary-ai/jobs/:id/delay', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const delayMs = parseChapterDelaySeconds(req.body?.seconds);
            if (delayMs === null) {
                return res.status(400).json({ message: "قيمة فاصل غير صالحة — أدخل عدد ثوانٍ بين 0 و 3600" });
            }
            const job = await GlossaryExtractionJob.findByIdAndUpdate(
                req.params.id,
                {
                    $set: { chapterDelayMs: delayMs, lastUpdate: new Date() },
                    $push: { logs: { message: `⏱️ تم تغيير الفاصل بين الفصول إلى ${delayMs / 1000} ثانية`, type: 'info' } }
                },
                { new: true }
            );
            if (!job) return res.status(404).json({ message: "Job not found" });
            res.json({ message: "Delay updated", chapterDelayMs: job.chapterDelayMs });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 5) قائمة المهام (بدون سجلات/تفاصيل — مثل المراجع)
    app.get('/api/glossary-ai/jobs', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const jobs = await GlossaryExtractionJob.find()
                .select('novelTitle cover status processedCount newTermsCount totalToExtract startTime')
                .sort({ updatedAt: -1 })
                .limit(20);
            const uiJobs = jobs.map(j => ({
                id: j._id,
                novelTitle: j.novelTitle,
                cover: j.cover,
                status: j.status,
                processed: j.processedCount,
                newTerms: j.newTermsCount,
                total: j.totalToExtract,
                startTime: j.startTime
            }));
            res.json(uiJobs);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 6) تفاصيل مهمة (مع السجل الحي)
    app.get('/api/glossary-ai/jobs/:id', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const job = await GlossaryExtractionJob.findById(req.params.id);
            if (!job) return res.status(404).json({ message: "Job not found" });
            const novelStats = await Novel.aggregate([
                { $match: { _id: job.novelId } },
                { $project: { maxChapter: { $max: "$chapters.number" } } }
            ]);
            const maxChapter = (novelStats[0] && novelStats[0].maxChapter) ? novelStats[0].maxChapter : 0;
            const response = job.toObject();
            response.novelMaxChapter = maxChapter;
            res.json(response);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
};
