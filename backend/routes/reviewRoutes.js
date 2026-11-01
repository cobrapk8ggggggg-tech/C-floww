/**
 * 🔍 نظام المراجعة الذكية — مراجعة جودة الفصول المترجمة بالذكاء الاصطناعي
 *
 * نفس نمط المترجم الذكي بالضبط (translatorRoutes):
 *  - مهمة (ReviewJob) لها حالة/سجل حي/إيقاف مؤقت/استئناف/حذف
 *  - عامل خلفي يفحص الفصول واحداً تلو الآخر من نفس مخزن النصوص (Firestore)
 *  - يستدعي نفس مزوّدات الذكاء الاصطناعي المضبوطة في إعدادات المترجم (نفس المفاتيح)
 *
 * المراجع (الذكاء الاصطناعي) يحدد إن كان الفصل يعاني أحد المشاكل:
 *   english    — الفصل ما زال بالإنجليزية / مقاطع إنجليزية كبيرة غير مترجمة
 *   short      — الفصل قصير جداً بشكل غير طبيعي
 *   repeated   — فقرات مكررة (نفس الفقرة/الجملة تتكرر)
 *   gibberish  — لغة مخربطة غير مفهومة / نص مشوش أو إعلانات عشوائية
 *
 * الرد: نعم → تسجيل الفصل مع نوع المشكلة في ReviewFinding + سجل المهمة
 *       لا  → الفصل التالي (ويُزال أي تعليم قديم لهذا الفصل)
 *
 * واجهة «الفصول التي بها خلل»: تختار الرواية فتشاهد فصولها المعلَّمة
 * لتحذفها يدوياً وتعيد استيرادها بالسكرابر ثم تعيد ترجمتها.
 */
const mongoose = require('mongoose');
const Novel = require('../models/novel.model.js');
const ReviewJob = require('../models/reviewJob.model.js');
const ReviewFinding = require('../models/reviewFinding.model.js');
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
} = require('./translatorRoutes')._ai;

// --- Firestore Setup (MANDATORY — نفس مخزن فصول المترجم) ---
let firestore;
try {
    const firebaseAdmin = require('../config/firebaseAdmin');
    firestore = firebaseAdmin.db;
} catch (e) {
    console.error("❌ CRITICAL: Firestore not loaded. Reviewer cannot work without it.");
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const REVIEW_TYPES = ['english', 'short', 'repeated', 'gibberish'];
const TYPE_LABELS = {
    english: 'فصل إنجليزي/غير مترجم',
    short: 'فصل قصير جداً',
    repeated: 'فقرات مكررة',
    gibberish: 'لغة مخربطة/غير مفهومة',
};

// 🔧 فحوص آلية رخيصة تُمرَّر للمرجع كتلميحات (وهو الحكم النهائي)
function chapterHeuristics(text) {
    const content = (text || '').trim();
    const length = content.length;
    const letters = content.replace(/[^\p{L}]/gu, '');
    let arabic = 0, latin = 0;
    for (const ch of letters) {
        const code = ch.codePointAt(0);
        if (code >= 0x0600 && code <= 0x06FF) arabic++;
        else if ((code >= 0x0041 && code <= 0x005A) || (code >= 0x0061 && code <= 0x007A)) latin++;
    }
    const letterTotal = letters.length || 1;
    const arabicRatio = Math.round((arabic / letterTotal) * 100);
    const latinRatio = Math.round((latin / letterTotal) * 100);

    // نسبة تكرار الفقرات (تطابق حرفي بعد تطبيع بسيط للمسافات)
    const paragraphs = content.split(/\n+/).map(p => p.replace(/\s+/g, ' ').trim()).filter(p => p.length >= 15);
    const counts = new Map();
    for (const p of paragraphs) counts.set(p, (counts.get(p) || 0) + 1);
    let duplicated = 0;
    for (const [, n] of counts) if (n > 1) duplicated += (n - 1);
    const duplicateRatio = paragraphs.length > 0 ? Math.round((duplicated / paragraphs.length) * 100) : 0;

    return { length, arabicRatio, latinRatio, duplicateRatio };
}

function buildReviewPrompt(content, heur) {
    return `أنت مراجع جودة محترف لفصول روايات مترجمة إلى العربية في تطبيق روايات.
قيّم نص الفصل أدناه وحدد إن كان يعاني أياً من المشاكل الأربع التالية:

1) english — الفصل ما زال بالإنجليزية أو يحتوي جمل/مقاطع إنجليزية كاملة غير مترجمة (جُمل كاملة، وليس رموز رتب قصيرة مثل A/S/LV/HP أو كلمة اسم واحدة).
2) short — الفصل قصير جداً بشكل غير طبيعي لفصل رواية ويب، أو مجرد عنوان بلا محتوى حقيقي.
3) repeated — فقرات مكررة: نفس الفقرة أو نفس الجملة تتكرر أكثر من مرة بشكل واضح وليس تكراراً قصصياً مقصوداً.
4) gibberish — لغة مخربطة غير مفهومة: نص مشوش، حروف عشوائية/مبتورة، إعلانات أو كلام عشوائي متناثر، أو ترجمة ركيكة لا يفهمها القارئ إطلاقاً.

معلومات مساعدة (فحوص آلية تلقائية — استرشد بها وأنت الحكم النهائي):
- طول النص: ${heur.length} حرفاً (فصول روايات الويب عادةً أكثر من 1000 حرف)
- نسبة الحروف العربية من الحروف: ${heur.arabicRatio}٪ — نسبة الحروف الإنجليزية: ${heur.latinRatio}٪
- نسبة التكرار الحرفي في الفقرات: ${heur.duplicateRatio}٪

مهم جداً: الفصل المكتوب بالعربية الفصحى/الرواياتية المفهوم والطبيعي حتى لو كان قصيراً نسبياً (فصول قصيرة موجودة طبيعياً في بعض الروايات) وليس فيه تكرار شاذ — هو فصل سليم، لا تتعلمه.

أجب بـ JSON فقط دون أي شرح أو علامات إضافية، بالشكل التالي بالضبط:
{"hasProblem": true, "types": ["english"], "details": "وصف قصير بالعربية لسبب المشكلة"}
أو إن كان الفصلاً سليماً:
{"hasProblem": false, "types": [], "details": "الفصل سليم"}

--- نص الفصل ---
${content}
--- نهاية نص الفصل ---`;
}

/** استخراج JSON حكم المراجعة من رد النموذج (متسامح مع backticks والزوائد) */
function parseReviewVerdict(rawText) {
    let jsonText = String(rawText || '').trim();
    if (jsonText.startsWith('```json')) jsonText = jsonText.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    else if (jsonText.startsWith('```')) jsonText = jsonText.replace(/^```\s*/, '').replace(/\s*```$/, '');
    if (/^json\s*[\n\r]/i.test(jsonText)) jsonText = jsonText.replace(/^json\s*[\n\r]+/i, '');
    const match = jsonText.match(/(\{[\s\S]*\})/);
    if (match) jsonText = match[1];
    const parsed = JSON.parse(jsonText);
    const types = Array.isArray(parsed.types)
        ? parsed.types.map(t => String(t).toLowerCase().trim()).filter(t => REVIEW_TYPES.includes(t))
        : [];
    return {
        hasProblem: Boolean(parsed.hasProblem) || types.length > 0,
        types,
        details: String(parsed.details || '').trim(),
    };
}

async function pushLog(jobId, message, type) {
    try {
        await ReviewJob.findByIdAndUpdate(jobId, {
            $push: { logs: { message, type: type || 'info' } },
            $set: { lastUpdate: new Date() }
        });
    } catch (e) { console.log('pushLog error:', e.message); }
}

// =========================================================
// 🔁 عامل المراجعة — نفس دورة عامل الترجمة (مزوّدات/مفاتيح/استئناف)
// =========================================================
async function processReviewJob(jobId) {
    try {
        const job = await ReviewJob.findById(jobId);
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
            job.logs.push({ message: 'لا توجد مزوّدات ذكاء اصطناعي مفعّلة — أضف المفاتيح من إعدادات المترجم أولاً (المراجع يستخدم نفس المزوّدات)', type: 'error' });
            await job.save();
            return;
        }
        providers.sort((a, b) => (a.priority || 0) - (b.priority || 0));

        const chaptersToProcess = (job.targetChapters || []).slice().sort((a, b) => a - b);

        // ⏱️ الفاصل بين الفصول — مضبوط من الواجهة (ثواني) ويُقرأ حياً من المهمة كل فصل
        const initialDelaySec = Math.max(0, Math.min(3600, Number(job.chapterDelayMs ?? 3000) / 1000));
        await pushLog(jobId, `🔍 بدء المراجعة: ${chaptersToProcess.length} فصلاً — المزوّد الأول ${providers[0].name || providers[0].providerId} | ⏱️ الفاصل بين الفصول: ${initialDelaySec} ثانية`, 'info');

        // 🔥 تفضيل المزوّد/التوكن الذي نجح في الفصل السابق (نفس سلوك المترجم:
        // «سيُكمل النظام من هذا المزود/التوكن في الفصل التالي»)
        let stickySuccessRoute = null;

        for (const chapterNum of chaptersToProcess) {
            const freshJob = await ReviewJob.findById(jobId);
            if (!freshJob || freshJob.status !== 'active') {
                if (freshJob && freshJob.status === 'paused') {
                    await pushLog(jobId, `⏸️ تم إيقاف المراجعة مؤقتاً عند الفصل ${chapterNum}`, 'warning');
                }
                break;
            }

            // 1) جلب نص الفصل من نفس مخزن المترجم
            let content = '';
            let storedTitle = '';
            try {
                const docSnap = await firestore.collection('novels').doc(novel._id.toString())
                    .collection('chapters').doc(chapterNum.toString()).get();
                if (docSnap.exists) {
                    const data = docSnap.data();
                    content = data.content || '';
                    storedTitle = data.title || '';
                }
            } catch (fsErr) {
                console.log(`Firestore fetch error (review) Ch ${chapterNum}:`, fsErr.message);
            }

            if (!content || content.trim().length === 0) {
                await pushLog(jobId, `تخطي الفصل ${chapterNum}: المحتوى غير موجود في السيرفر`, 'warning');
                // فصل بلا محتوى أصلاً = خلل بحد ذاته (فصل فارغ) — علّمه short
                await recordFinding(job, novel, chapterNum, storedTitle, ['short'], 'الفصل فارغ بلا أي محتوى محفوظ');
                await ReviewJob.findByIdAndUpdate(jobId, {
                    $pull: { targetChapters: chapterNum },
                    $set: { currentChapter: chapterNum, lastUpdate: new Date() }
                });
                await delay(Math.max(0, Math.min(3600000, freshJob.chapterDelayMs ?? 3000)));
                continue;
            }

            // 2) استدعاء المرجع (الذكاء الاصطناعي) — نفس منطق المزوّدات في المترجم حرفياً:
            //    Qwen = حسابات تلقائية + وسوم فشل + لا انتقال لمزوّد آخر أبداً.
            const heur = chapterHeuristics(content);
            const prompt = buildReviewPrompt(content, heur);
            let verdict = null;
            let lastErr = null;

            /** محاولة فحص واحدة بتوكن محدد — تُعيد true عند النجاح */
            const attemptReviewWithToken = async (prov, model, key, keyIdx, keysCount) => {
                const provName = prov.name || prov.providerId;
                let raw = null;
                try {
                    await pushLog(jobId, `🔎 فحص الفصل ${chapterNum} عبر ${provName} | نموذج: ${model} | مفتاح ${keyIdx + 1}/${keysCount}`, 'info');
                    raw = await callTranslationProvider(prov, model, key, prompt, {
                        timeout: 300000,
                        conversationPurpose: 'review',
                        deepSeekJobId: jobId.toString(),
                    });
                } catch (err) {
                    lastErr = err;
                    // 🔥 قاتل حلقة «نفس الحساب» — نفس وسوم المترجم:
                    // RateLimited → 24 ساعة، مصادقة → ميت، خطأ غير مصنّف → موسم 30 دقيقة
                    if (isQwenProvider(prov)) {
                        const v = qwenAutoAccount.markTokenFailure(key, err);
                        if (v === 'rate-limited-24h') {
                            await pushLog(jobId, `⏳ توكن Qwen مستهلك (RateLimited): وُسم 24 ساعة وسيُستبعد ويُستبدل بحساب جديد تلقائياً`, 'warning');
                        } else if (v === 'dead') {
                            await pushLog(jobId, `🔒 توكن Qwen غير صالح (فشل مصادقة): وُسم ميتاً وسيُستبعد`, 'warning');
                        } else if (v === 'limited-30m') {
                            await pushLog(jobId, `🧯 فشل غير مصنّف من حساب Qwen (${err.message}) — وُسم التوكن 30 دقيقة احتياطاً حتى لا يتكرر نفس الحساب في الحلقة`, 'warning');
                        }
                    }
                    console.error(`❌ review provider fail (${provName}): ${err.message}`);
                    await pushLog(jobId, `⚠️ فشل فحص عبر ${provName}: ${err.message}`, 'warning');
                    return false;
                }
                // تحليل الحكم خارج فشل المزوّد — رد JSON تالف لا يوسم التوكن
                try {
                    verdictBox.value = parseReviewVerdict(raw);
                    return true;
                } catch (_) {
                    lastErr = new Error('رد غير مفهوم من المرجع (فشل تحليل JSON)');
                    await pushLog(jobId, `⚠️ رد غير مفهوم من ${provName} (فشل تحليل JSON) — إعادة المحاولة`, 'warning');
                    return false;
                }
            };

            const verdictBox = { value: null };

            const orderedProviders = stickySuccessRoute
                ? [...providers.slice(stickySuccessRoute.providerIndex), ...providers.slice(0, stickySuccessRoute.providerIndex)]
                : providers;

            outer:
            for (const provider of orderedProviders) {
                if (verdictBox.value) break;
                const providerIndex = providers.indexOf(provider);
                const providerName = provider.name || provider.providerId;
                const modelToUse = provider.selectedModel
                    || (provider.models && provider.models[0]?.modelId)
                    || 'gemini-2.5-flash';
                let keys = getProviderAuthKeys(provider);
                const isDeepSeek = isDeepSeekProvider(provider);
                const isQwen = isQwenProvider(provider);
                const isGeminiWeb = isGeminiWebProvider(provider);

                if (keys.length === 0 && !isDeepSeek && !isQwen && !(isGeminiWeb && provider.allowGuestFallback)) {
                    await pushLog(jobId, `⚠️ المزوّد ${providerName} ليس لديه مفاتيح – تخطيه`, 'warning');
                    continue;
                }
                if (isGeminiWeb && provider.allowGuestFallback && keys.length === 0) {
                    keys = [GUEST_TOKEN_SENTINEL];
                    await pushLog(jobId, `🟡 تنبيه — وضع الضيف: مزوّد Gemini Web "${providerName}" بلا كوكيز، سيعمل الفحص عبر الوصول المجهول`, 'warning');
                }
                if (isDeepSeek && keys.length === 0) {
                    keys = ['dummy-key-for-deepseek'];
                    await pushLog(jobId, `🔑 مزوّد DeepSeek: لا توجد توكنات محفوظة، سيتم استخدام الرمز الافتراضي من تطبيق DeepSeek`, 'info');
                }

                // 🔥🔥🔥 Qwen AUTO-ACCOUNT (Qwen فقط — نفس طريقة المترجم وقانص qwen.py) 🔥🔥🔥
                // استبعاد التوكنات المستهلكة/الميتة/المملوكة لمزوّد Qwen آخر، وإن لم يبقَ أي توكن
                // صالح يُنشأ حساب Qwen جديد تلقائياً (بريد مؤقت → تسجيل → تفعيل → توكن).
                if (isQwen) {
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
                                await pushLog(jobId, `✅ تم إنشاء حساب Qwen جديد خاص بهذا المزوّد (${account.email}) وسيبدأ الفحص عليه مباشرة`, 'success');
                            } else {
                                await pushLog(jobId, `♻️ إعادة استخدام الحساب التلقائي الصالح الخاص بهذا المزوّد (${account.email}) — لم يُنشأ حساب جديد`, 'info');
                            }
                        } catch (accErr) {
                            await pushLog(jobId, `❌ تعذر إنشاء حساب Qwen تلقائياً الآن: ${accErr.message} — لن ننتقل لمزوّد آخر، سيُعاد الفحص على Qwen عند الاستئناف`, 'warning');
                            break; // Qwen فقط: لا انتقال لمزوّد آخر أبداً
                        }
                    } else {
                        await pushLog(jobId, `🔑 مزوّد Qwen: سيتم استخدام ${keys.length} توكن صالح`, 'info');
                    }
                }

                // تفضيل التوكن الذي نجح في الفصل السابق (نفس المترجم)
                let preferredKeyIdx = 0;
                if (stickySuccessRoute && stickySuccessRoute.providerIndex === providerIndex && stickySuccessRoute.key) {
                    const ki = keys.indexOf(stickySuccessRoute.key);
                    preferredKeyIdx = ki >= 0 ? ki : 0;
                }
                const orderedKeyIndexes = [...Array(keys.length).keys()].slice(preferredKeyIdx).concat([...Array(keys.length).keys()].slice(0, preferredKeyIdx));

                for (const keyIdx of orderedKeyIndexes) {
                    const ok = await attemptReviewWithToken(provider, modelToUse, keys[keyIdx], keyIdx, keys.length);
                    if (ok) {
                        stickySuccessRoute = { providerIndex, key: keys[keyIdx] };
                        break outer;
                    }
                    if (verdictBox.value) break outer;
                }

                // 🔥🔥🔥 Qwen: فشلت كل التوكنات → إنشاء حساب جديد فوراً ومتابعة على Qwen فقط 🔥🔥🔥
                // (جولتان لكل فصل كما في المترجم — لا توقف ولا انتقال لمزوّد آخر)
                if (!verdictBox.value && isQwen) {
                    const AUTO_ROUNDS = 2;
                    for (let round = 1; round <= AUTO_ROUNDS && !verdictBox.value; round++) {
                        await pushLog(jobId, `🤖 مزوّد Qwen: فشلت جميع التوكنات — إنشاء حساب Qwen جديد كلياً (جولة ${round}/${AUTO_ROUNDS}) ومتابعة المراجعة على Qwen فقط`, 'info');
                        let account;
                        try {
                            // forceNew: بعد فشل فعلي يُنشأ حساب جديد كلياً دائماً (قاتل الحلقة المفرغة)
                            const ensured = await qwenAutoAccount.ensureQwenAccount(provider.providerId, { forceNew: true });
                            account = ensured.account;
                        } catch (accErr) {
                            await pushLog(jobId, `❌ تعذر إنشاء حساب Qwen تلقائياً الآن: ${accErr.message} — لن ننتقل لمزوّد آخر، سيُعاد الفحص على Qwen عند الاستئناف`, 'warning');
                            break;
                        }
                        provider.qwenTokens = Array.isArray(provider.qwenTokens) ? provider.qwenTokens : [];
                        if (!provider.qwenTokens.includes(account.token)) provider.qwenTokens.push(account.token);
                        try { await qwenAutoAccount.persistProviderToken(provider.providerId, account.token); } catch (_) {}
                        keys.push(account.token);
                        await pushLog(jobId, `✅ حساب Qwen جديد كلياً جاهز (${account.email}) — إعادة فحص الفصل ${chapterNum} بالتوكن الجديد`, 'success');

                        const autoKeyIdx = keys.length - 1;
                        for (let tokenAttempt = 1; tokenAttempt <= 2 && !verdictBox.value; tokenAttempt++) {
                            const ok = await attemptReviewWithToken(provider, modelToUse, account.token, autoKeyIdx, keys.length);
                            if (ok) {
                                stickySuccessRoute = { providerIndex, key: account.token };
                                break outer;
                            }
                        }
                    }
                }

                if (!verdictBox.value) {
                    await pushLog(jobId, `🚫 جميع مفاتيح ${providerName} فشلت`, 'warning');
                    // 🔥 Qwen فقط: لا انتقال إلى مزوّد آخر — الفصل يبقى معلقاً ويُعاد عند الاستئناف
                    if (isQwen) break;
                }
            }

            verdict = verdictBox.value;

            if (!verdict) {
                // لا نُفشل المهمة كلها — يبقى الفصل في قائمة الانتظار ويُعاد عند الاستئناف
                await pushLog(jobId, `❌ تعذر فحص الفصل ${chapterNum} عبر كل المزوّدات (${lastErr?.message || 'خطأ غير معروف'}) — سيُعاد عند الاستئناف`, 'error');
                break;
            }

            // 3) نأخذ رد الذكاء الاصطناعي: نعم → سجّل الخلل مع نوعه / لا → الفصل التالي
            if (verdict.hasProblem && verdict.types.length > 0) {
                const typesLabel = verdict.types.map(t => TYPE_LABELS[t] || t).join(' + ');
                await pushLog(jobId, `🚩 الفصل ${chapterNum}: ${typesLabel} — ${verdict.details || 'بلا تفاصيل'}`, 'warning');
                await recordFinding(job, novel, chapterNum, storedTitle, verdict.types, verdict.details);
                await ReviewJob.findByIdAndUpdate(jobId, {
                    $inc: { flaggedCount: 1 },
                    $pull: { targetChapters: chapterNum },
                    $set: { currentChapter: chapterNum, lastUpdate: new Date() }
                });
            } else {
                await pushLog(jobId, `✅ الفصل ${chapterNum} سليم — ننتقل للفصل التالي`, 'success');
                // الفصل أصبح سليماً → أزل أي تعليم قديم عليه
                await ReviewFinding.updateOne(
                    { novelId: novel._id, chapter: chapterNum, status: 'open' },
                    { $set: { status: 'resolved', updatedAt: new Date() } }
                );
                await ReviewJob.findByIdAndUpdate(jobId, {
                    $inc: { reviewedCount: 1 },
                    $pull: { targetChapters: chapterNum },
                    $set: { currentChapter: chapterNum, lastUpdate: new Date() }
                });
            }

            // ⏱️ الفاصل بين الفصول — يُقرأ حياً من المهمة حتى يسري تغييره من الواجهة فوراً
            const postJob = await ReviewJob.findById(jobId).select('chapterDelayMs');
            await delay(Math.max(0, Math.min(3600000, postJob?.chapterDelayMs ?? 3000)));
        }

        // النهاية: إن لم تبق فصول مستهدفة والمهمة لا تزال نشطة → مكتملة
        const finalJob = await ReviewJob.findById(jobId);
        if (finalJob && finalJob.status === 'active') {
            const remaining = (finalJob.targetChapters || []).length;
            if (remaining === 0) {
                await ReviewJob.findByIdAndUpdate(jobId, { status: 'completed' });
                await pushLog(jobId, `🏁 اكتملت المراجعة! فحص سليم: ${finalJob.reviewedCount} — فصول بها خلل: ${finalJob.flaggedCount}. راجعها من قسم «الفصول التي بها خلل»`, 'success');
            } else {
                await pushLog(jobId, `⏳ توقفت المراجعة مع ${remaining} فصلاً لم يُفحص بعد (استئناف متاح)`, 'warning');
            }
        }
    } catch (err) {
        console.error('Review Job Error:', err);
        try {
            await ReviewJob.findByIdAndUpdate(jobId, { status: 'failed' });
            await pushLog(jobId, `❌ خطأ قاتل في المهمة: ${err.message}`, 'error');
        } catch (_) { /* ignore */ }
    }
}

/** تسجيل فصل معلَّم: داخل المهمة + في السجل الدائم (واجهة الفصول التي بها خلل) */
async function recordFinding(job, novel, chapterNum, storedTitle, types, details) {
    const finding = {
        chapter: chapterNum,
        title: storedTitle || (novel.chapters || []).find(c => c.number === chapterNum)?.title || `الفصل ${chapterNum}`,
        types: types.filter(t => REVIEW_TYPES.includes(t)),
        details: details || '',
        at: new Date(),
    };
    try {
        await ReviewJob.findByIdAndUpdate(job._id, { $push: { findings: finding } });
    } catch (e) { console.log('findings push error:', e.message); }

    try {
        const existing = await ReviewFinding.findOne({ novelId: novel._id, chapter: chapterNum, status: 'open' });
        if (existing) {
            existing.types = Array.from(new Set([...(existing.types || []), ...finding.types]));
            existing.details = finding.details || existing.details;
            existing.updatedAt = new Date();
            await existing.save();
        } else {
            await ReviewFinding.create({
                novelId: novel._id,
                novelTitle: novel.title,
                cover: novel.cover,
                chapter: chapterNum,
                chapterTitle: finding.title,
                types: finding.types,
                details: finding.details,
                status: 'open',
            });
        }
    } catch (e) { console.log('ReviewFinding upsert error:', e.message); }
}

// ⏱️ تحويل قيمة الفاصل من الواجهة (ثواني) إلى ملي ثانية مع تحقق صارم — null إن كانت غير صالحة
function parseChapterDelaySeconds(value) {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 3600) return null;
    return Math.round(n * 1000);
}

// =========================================================
// 🔗 المسارات
// =========================================================
module.exports = function (app, verifyToken, verifyAdmin) {

    // 1) روايات المراجعة — نفس نداء المترجم حرفياً (نفس واجهة اختيار الرواية)
    app.get('/api/review/novels', verifyToken, verifyAdmin, async (req, res) => {
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
            console.error("Review Novels Error:", e);
            res.status(500).json({ error: e.message });
        }
    });

    // 2) بدء مهمة مراجعة (أو استئناف ب jobId) — يقبل chapterDelay بالثواني (الفاصل بين الفصول)
    app.post('/api/review/start', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const { novelId, chapters, jobId, chapterDelay } = req.body;

            if (jobId) {
                const existingJob = await ReviewJob.findById(jobId);
                if (!existingJob) return res.status(404).json({ message: "Job not found" });
                if ((existingJob.targetChapters || []).length === 0) {
                    return res.status(400).json({ message: "لا توجد فصول متبقية في هذه المهمة" });
                }
                const delayMs = parseChapterDelaySeconds(chapterDelay);
                if (delayMs !== null) existingJob.chapterDelayMs = delayMs;
                existingJob.status = 'active';
                existingJob.logs.push({ message: '▶️ تم استئناف مهمة المراجعة' + (delayMs !== null ? ` | ⏱️ الفاصل: ${delayMs / 1000} ثانية` : ''), type: 'info' });
                await existingJob.save();
                processReviewJob(existingJob._id);
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
                        console.error("Failed to fetch chapters from Firestore (review):", err.message);
                    }
                }
                targetChapters = Array.from(new Set([...mongoChapters, ...firestoreChapters])).sort((a, b) => a - b);
            } else if (Array.isArray(chapters)) {
                targetChapters = chapters.map(n => parseInt(n)).filter(n => !isNaN(n));
            }

            if (targetChapters.length === 0) {
                return res.status(400).json({ message: "لا توجد فصول لمراجعتها" });
            }

            const delayMs = parseChapterDelaySeconds(chapterDelay);
            const effectiveDelayMs = delayMs === null ? 3000 : delayMs;

            const job = new ReviewJob({
                novelId,
                novelTitle: novel.title,
                cover: novel.cover,
                targetChapters,
                totalToReview: targetChapters.length,
                chapterDelayMs: effectiveDelayMs,
                logs: [{ message: `تم بدء مراجعة «${novel.title}» (استهداف ${targetChapters.length} فصلاً) | ⏱️ الفاصل بين الفصول: ${effectiveDelayMs / 1000} ثانية`, type: 'info' }]
            });
            await job.save();
            processReviewJob(job._id);
            res.json({ message: "Review started", jobId: job._id });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 3) إيقاف مؤقت
    app.post('/api/review/jobs/:id/pause', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const job = await ReviewJob.findById(req.params.id);
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
    app.delete('/api/review/jobs/:id', verifyToken, verifyAdmin, async (req, res) => {
        try {
            await ReviewJob.findByIdAndDelete(req.params.id);
            res.json({ message: "Job deleted" });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 4.5) ⏱️ تغيير الفاصل بين الفصول لمهمة جارية (يتأثر من الفصل التالي فوراً)
    app.post('/api/review/jobs/:id/delay', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const delayMs = parseChapterDelaySeconds(req.body?.seconds);
            if (delayMs === null) {
                return res.status(400).json({ message: "قيمة فاصل غير صالحة — أدخل عدد ثوانٍ بين 0 و 3600" });
            }
            const job = await ReviewJob.findByIdAndUpdate(
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

    // 5) قائمة المهام (بدون سجلات/تفاصيل — مثل المترجم)
    app.get('/api/review/jobs', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const jobs = await ReviewJob.find()
                .select('novelTitle cover status reviewedCount flaggedCount totalToReview startTime')
                .sort({ updatedAt: -1 })
                .limit(20);
            const uiJobs = jobs.map(j => ({
                id: j._id,
                novelTitle: j.novelTitle,
                cover: j.cover,
                status: j.status,
                reviewed: j.reviewedCount,
                flagged: j.flaggedCount,
                total: j.totalToReview,
                startTime: j.startTime
            }));
            res.json(uiJobs);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 6) تفاصيل مهمة (مع الفصول المعلَّمة + السجل الحي)
    app.get('/api/review/jobs/:id', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const job = await ReviewJob.findById(req.params.id);
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

    // 7) الفصول التي بها خلل — مجمعة حسب الرواية (واجهة الاختيار)
    app.get('/api/review/findings', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const { novelId } = req.query;
            if (!novelId) {
                const grouped = await ReviewFinding.aggregate([
                    { $match: { status: 'open' } },
                    {
                        $group: {
                            _id: '$novelId',
                            novelTitle: { $first: '$novelTitle' },
                            cover: { $first: '$cover' },
                            count: { $sum: 1 },
                            lastAt: { $max: '$at' }
                        }
                    },
                    { $sort: { lastAt: -1 } }
                ]);
                return res.json(grouped.map(g => ({
                    novelId: g._id,
                    novelTitle: g.novelTitle,
                    cover: g.cover,
                    count: g.count,
                    lastAt: g.lastAt
                })));
            }
            const findings = await ReviewFinding.find({ novelId, status: 'open' }).sort({ chapter: 1 });
            res.json(findings);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 8) إزالة علامة عن فصل (بعد حذفه وإعادة استيراده وترجمته يدوياً)
    app.delete('/api/review/findings/:id', verifyToken, verifyAdmin, async (req, res) => {
        try {
            await ReviewFinding.findByIdAndDelete(req.params.id);
            res.json({ message: "Finding removed" });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 9) إعادة مراجعة كل الفصول المعلَّمة لرواية — تبدأ مهمة جديدة تستهدفها حصراً
    app.post('/api/review/findings/re-review', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const { novelId } = req.body;
            const findings = await ReviewFinding.find({ novelId, status: 'open' });
            if (findings.length === 0) return res.status(400).json({ message: "لا توجد فصول معلَّمة لهذه الرواية" });
            const novel = await Novel.findById(novelId);
            if (!novel) return res.status(404).json({ message: "Novel not found" });
            const reReviewDelayMs = parseChapterDelaySeconds(req.body?.chapterDelay) ?? 3000;
            const job = new ReviewJob({
                novelId,
                novelTitle: novel.title,
                cover: novel.cover,
                targetChapters: findings.map(f => f.chapter),
                totalToReview: findings.length,
                chapterDelayMs: reReviewDelayMs,
                logs: [{ message: `🔁 إعادة مراجعة ${findings.length} فصلاً معلَّماً | ⏱️ الفاصل: ${reReviewDelayMs / 1000} ثانية`, type: 'info' }]
            });
            await job.save();
            processReviewJob(job._id);
            res.json({ message: "Re-review started", jobId: job._id });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
};
