/**
 * ⚡ المترجم الخالص — ترجمة فقط (بلا استخراج مصطلحات إطلاقاً) — نظام جديد مستقل
 *
 * 🎯 الفكرة (طلب المستخدم):
 *   المترجم الذكي القائم يترجم ويستخرج المصطلحات في نفس الوقت (خطوة إضافية
 *   بعد كل فصل تبطئ الترجمة وتستهلك الطلبات). هذا النظام الجديد منفصل عنه
 *   تماماً ويتكامل مع «المستخرج الذكي» (glossaryAiRoutes):
 *     1) المستخرج الذكي يستخرج مصطلحات الرواية كاملة أولاً ← المسرد يكتمل.
 *     2) المترجم الخالص يقرأ المسرد الجاهز ويترجم الفصول فقط — لا يضيف
 *        ولا يعدّل أي مصطلح في المسرد أبداً، ولا يجري أي استخراج.
 *
 * ✅ نفس خط الترجمة المؤكد في المترجم الذكي حرفياً (عبر تصدير _ai — إعادة
 *    استخدام لنفس الدوال بلا نسخ ولا انحراف):
 *    - قواعد عدم الحذف/الدمج (noOmissionRules) + حقن المسرد في التوجيه.
 *    - فحص الترجمة الصارم (validateTranslatedChapter) + ترجمة المقاطع
 *      الأجنبية فقط (translateResiduesOnly) + المراجع الآلي
 *      (reviewQuestionableChapter) + إعادة الترجمة الإصلاحية
 *      (buildRepairTranslationPrompt).
 *    - Qwen = حسابات تلقائية + وسوم فشل (24س/ميت/30د) + لا انتقال لمزوّد
 *      آخر أبداً + تفضيل المزوّد/التوكن الناجح (sticky) — حرفياً كالمترجم.
 *    - الحفظ: Firestore + مرآة MongoDB (chapterMirror) + قائمة فصول الرواية.
 *
 * ⚠️ نظام إضافي مستقل تماماً: لا يمس المترجم الذكي ولا المستخرج ولا المراجع
 *    ولا أي نظام قائم — مهامه في مجموعة (PureTranslationJob) منفصلة كلياً.
 */
const mongoose = require('mongoose');
const Novel = require('../models/novel.model.js');
const Glossary = require('../models/glossary.model.js');
const PureTranslationJob = require('../models/pureTranslationJob.model.js');
const Settings = require('../models/settings.model.js');
const qwenAutoAccount = require('../services/qwenAutoAccount.service.js');
const chapterMirror = require('../services/chapterMirror.service.js');
const {
    callTranslationProvider,
    getGlobalSettings,
    getProviderAuthKeys,
    isDeepSeekProvider,
    isQwenProvider,
    isGeminiWebProvider,
    GUEST_TOKEN_SENTINEL,
    // أدوات خط الترجمة المؤكد — نفس دوال المترجم الذكي بلا أي نسخ:
    isStickyChatProvider,
    validateTranslatedChapter,
    translateResiduesOnly,
    reviewQuestionableChapter,
    buildRepairTranslationPrompt,
    removeDeepSeekFinishedMarker,
    resetConversationContextPurposeForScope,
    getTokenConversationScope,
    DEEPSEEK_CHAPTERS_PER_CONVERSATION,
    DEEPSEEK_MAX_ATTEMPTS_PER_TOKEN,
} = require('./translatorRoutes')._ai;

// --- Firestore Setup (MANDATORY — نفس مخزن فصول المترجم) ---
let firestore;
try {
    const firebaseAdmin = require('../config/firebaseAdmin');
    firestore = firebaseAdmin.db;
} catch (e) {
    console.error("❌ CRITICAL: Firestore not loaded. Pure translator cannot work without it.");
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function pushLog(jobId, message, type) {
    const prefix = type ? `[pure-translator:${type}]` : '[pure-translator]';
    console.log(`${new Date().toISOString()} ${prefix} job=${jobId} ${message}`);
    try {
        await PureTranslationJob.findByIdAndUpdate(jobId, {
            $push: { logs: { message, type, timestamp: new Date() } },
            $set: { lastUpdate: new Date() }
        });
    } catch (e) { console.log('pushLog error:', e.message); }
}

// =========================================================
// ⚡ عامل الترجمة الخالصة — نفس دورة عامل المترجم الذكي حرفياً
//    (مزوّدات/مفاتيح/تحقق/مراجعة/إصلاح/Qwen) — بلا أي استخراج مصطلحات
// =========================================================
async function processPureTranslationJob(jobId) {
    try {
        const job = await PureTranslationJob.findById(jobId);
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
            job.logs.push({ message: 'لا توجد مزوّدات ترجمة مفعلة مع مفاتيح API — أضف المفاتيح من إعدادات المترجم أولاً (المترجم الخالص يستخدم نفس المزوّدات)', type: 'error' });
            await job.save();
            return;
        }
        providers.sort((a, b) => (a.priority || 0) - (b.priority || 0));

        // ⚡ نفس توجيه الترجمة القائم: customPrompt من الإعدادات (أو الافتراضي) —
        // ⚡ لا يوجد extractPrompt هنا إطلاقاً: المترجم الخالص لا يستخرج مصطلحات.
        const transPrompt = settings?.customPrompt || "You are a professional translator. Translate the novel chapter into Arabic. The source may be in ANY language (English, Chinese, Korean, Japanese, Russian, etc.) — translate ALL of it into Arabic with no exceptions. Output ONLY the Arabic translation. Use the glossary provided.";

        const chaptersToProcess = (job.targetChapters || []).slice().sort((a, b) => a - b);
        const conversationContexts = { chapters: new Map(), chapter_review: new Map() };
        let stickySuccessRoute = null;

        // ⏱️ الفاصل بين الفصول — مضبوط من الواجهة (ثواني) ويُقرأ حياً من المهمة كل فصل
        const initialDelaySec = Math.max(0, Math.min(3600, Number(job.chapterDelayMs ?? 2000) / 1000));
        await pushLog(jobId, `⚡ بدء الترجمة الخالصة (ترجمة فقط — بلا استخراج مصطلحات): ${chaptersToProcess.length} فصلاً — المزوّد الأول ${providers[0].name || providers[0].providerId} | ⏱️ الفاصل بين الفصول: ${initialDelaySec} ثانية`, 'info');

        for (const [chapterIndex, chapterNum] of chaptersToProcess.entries()) {
            const freshJob = await PureTranslationJob.findById(jobId);
            if (!freshJob || freshJob.status !== 'active') {
                if (freshJob && freshJob.status === 'paused') {
                    await pushLog(jobId, `⏸️ تم إيقاف المهمة مؤقتاً عند الفصل ${chapterNum}`, 'warning');
                }
                break;
            }

            const conversationBatchKey = Math.floor(chapterIndex / DEEPSEEK_CHAPTERS_PER_CONVERSATION);
            const isFirstChapterInDeepSeekBatch = chapterIndex % DEEPSEEK_CHAPTERS_PER_CONVERSATION === 0;
            if (isFirstChapterInDeepSeekBatch) {
                await pushLog(jobId, `💬 بدء محادثات جديدة للفصول ${chapterIndex + 1}-${Math.min(chapterIndex + DEEPSEEK_CHAPTERS_PER_CONVERSATION, chaptersToProcess.length)} (ترجمة الفصول + المراجعة/إصلاح الكلمات)`, 'info');
            }

            const freshNovel = await Novel.findById(job.novelId);

            let sourceContent = "";
            try {
                const docRef = firestore.collection('novels').doc(freshNovel._id.toString()).collection('chapters').doc(chapterNum.toString());
                const docSnap = await docRef.get();
                if (docSnap.exists) {
                    const data = docSnap.data();
                    sourceContent = data.content || "";
                }
            } catch (fsErr) {
                console.log(`Firestore fetch error (pure) for Ch ${chapterNum}:`, fsErr.message);
            }

            if (!sourceContent || sourceContent.trim().length === 0) {
                await pushLog(jobId, `تخطي الفصل ${chapterNum}: المحتوى غير موجود في السيرفر (Firestore)`, 'warning');
                await PureTranslationJob.findByIdAndUpdate(jobId, {
                    $pull: { targetChapters: chapterNum },
                    $set: { currentChapter: chapterNum, lastUpdate: new Date() }
                });
                // ⏱️ الفاصل يُطبق حتى عند التخطي (نفس إيقاع المستخرج الذكي)
                const skipJob = await PureTranslationJob.findById(jobId).select('chapterDelayMs');
                await delay(Math.max(0, Math.min(3600000, skipJob?.chapterDelayMs ?? 2000)));
                continue;
            }

            // 🔥 المسرد يُقرأ فقط (لا كتابة أبداً) — مفترض مكتمل مسبقاً من المستخرج الذكي
            const glossaryItems = await Glossary.find({ novelId: freshNovel._id });
            const glossaryText = glossaryItems.map(g => `"${g.term}": "${g.translation}"`).join(',\n');
            if (chapterIndex === 0) {
                await pushLog(jobId, `📚 المسرد الجاهز للرواية: ${glossaryItems.length} مصطلحاً (يُستخدم في الترجمة ولا يُعدَّل — استخراج المصطلحات من اختصاص «المستخرج الذكي»)`, 'info');
            }

            // 🔥 Guardrails مطابقة للمترجم القائم حرفياً
            const noOmissionRules = `
--- قواعد إلزامية (تنطبق دائماً) ---
1. ترجم الفصل كاملاً فقرة بفقرة. ممنوع حذف أو تلخيص أو دمج أي جملة أو فقرة أو حوار.
2. كل جملة في النص الأصلي (أي كانت لغته: إنجليزية/صينية/كورية/يابانية/روسية أو غيرها) يجب أن يكون لها مقابل عربي بنفس الترتيب وبنفس الفقرة.
3. أخرج الترجمة العربية فقط: بدون مقدمات، بدون شرح، بدون عناوين إضافية، بدون JSON.
4. لا تترك أي نص أجنبي في الناتج النهائي: اللغات غير الإنجليزية (الصينية/الكورية/اليابانية/الروسية...) لا استثناءات لها إطلاقاً — كل مقطع يُترجم إلى العربية.
5. الاستثناء الوحيد المسموح: رموز لاتينية قصيرة تمثل رتباً/تصنيفات مثل A أو S أو LV أو HP.
-------------------------------------`;
            const translationInput = `
${transPrompt}

--- GLOSSARY (Use these strictly) ---
${glossaryText}
-------------------------------------
${noOmissionRules}

--- SOURCE Text TO TRANSLATE (any language) ---
${sourceContent}
---------------------------------
`;

            let translatedText = "";
            let translationSuccess = false;

            // ========== Multi-provider translation with strict validation (كالمترجم حرفياً) ==========
            const RETRY_DELAY_MS = 30 * 60 * 1000;
            let attempt = 0;
            let lastValidationReasons = [];

            while (!translationSuccess) {
                attempt++;
                const freshAttemptJob = await PureTranslationJob.findById(jobId);
                if (!freshAttemptJob || freshAttemptJob.status !== 'active') break;

                if (attempt > 1) {
                    await pushLog(jobId, `🔄 محاولة ${attempt}: إعادة ترجمة الفصل ${chapterNum} حتى ينجح ولا يبقى نصاً أجنبياً`, 'info');
                }

                const promptForAttempt = lastValidationReasons.length > 0
                    ? buildRepairTranslationPrompt(transPrompt, glossaryText, sourceContent, translatedText, lastValidationReasons)
                    : translationInput;

                // محاولة ترجمة كاملة (توليد + فحص + ترجمة المقاطع + مراجع) بتوكن واحد —
                // نفس بنية المترجم القائم: النتيجة { ok: true } أو { ok: false, kind: 'review' | 'error' }.
                const attemptChapterWithToken = async (prov, model, key, keyIdx, keysCount, tokenAttempt, tokenAttempts, attemptNo) => {
                    const provName = prov.name || prov.providerId;
                    const provIsSticky = isStickyChatProvider(prov);
                    const conversationScopeKey = provIsSticky ? getTokenConversationScope(prov, key, keyIdx) : undefined;
                    try {
                        const retryLabel = provIsSticky ? ` | محاولة التوكن ${tokenAttempt}/${tokenAttempts}` : '';
                        await pushLog(jobId, `1️⃣ مزوّد: ${provName} | نموذج: ${model} | مفتاح ${keyIdx + 1}/${keysCount} | محاولة ${attemptNo}${retryLabel}`, 'info');
                        let candidateText;
                        try {
                            candidateText = await callTranslationProvider(prov, model, key, promptForAttempt, {
                                deepSeekJobId: jobId.toString(),
                                conversationContexts,
                                conversationPurpose: 'chapters',
                                sourceText: sourceContent,
                                conversationBatchKey,
                                conversationScopeKey,
                                log: (msg, level) => pushLog(jobId, `[Gemini Web] ${msg}`, level || 'info')
                            });
                        } catch (genErr) {
                            // نفس وسوم المترجم: RateLimited → 24س، مصادقة → ميت، غير مصنّف → 30 دقيقة
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
                        let candidateTextForReview = removeDeepSeekFinishedMarker(candidateText);
                        if (candidateTextForReview !== (candidateText || '').trim()) {
                            await pushLog(jobId, `✂️ تم حذف علامة DeepSeek النهائية FINISHED من الفصل ${chapterNum} قبل المراجعة والحفظ`, 'info');
                        }
                        let validation = validateTranslatedChapter(candidateTextForReview, sourceContent);

                        if (validation.residues.length > 0) {
                            await pushLog(jobId, `🔎 وُجد نص غير مترجم في الفصل ${chapterNum}: ${validation.residues.slice(0, 8).map(r => String(r).length > 18 ? String(r).substring(0, 18) + '…' : r).join(' ، ')} — ترجمة المقاطع فقط ثم استبدالها`, 'warning');
                            try {
                                candidateTextForReview = await translateResiduesOnly(prov, model, key, candidateTextForReview, validation.residues, {
                                    deepSeekJobId: jobId.toString(),
                                    conversationContexts,
                                    conversationPurpose: 'chapter_review',
                                    conversationBatchKey,
                                    conversationScopeKey
                                });
                                validation = validateTranslatedChapter(candidateTextForReview, sourceContent);
                            } catch (replaceErr) {
                                await pushLog(jobId, `⚠️ فشل استبدال المقاطع الأجنبية فقط: ${replaceErr.message}`, 'warning');
                            }
                        }

                        if (!validation.ok) {
                            const review = await reviewQuestionableChapter(prov, model, key, candidateTextForReview, sourceContent, validation, {
                                deepSeekJobId: jobId.toString(),
                                conversationContexts,
                                conversationPurpose: 'chapter_review',
                                conversationBatchKey,
                                conversationScopeKey
                            });

                            if (review.decision !== 'accept') {
                                translatedText = candidateTextForReview || '';
                                lastValidationReasons = [...validation.reasons, review.reason];
                                await pushLog(jobId, `🧪 فشلت مراجعة الفصل ${chapterNum}: ${lastValidationReasons.join('، ')} — ستتم إعادة الترجمة ولن ننتقل للفصل التالي`, 'warning');
                                if (provIsSticky) resetConversationContextPurposeForScope(conversationContexts, 'chapters', conversationScopeKey, conversationBatchKey);
                                return { ok: false, kind: 'review' };
                            }

                            await pushLog(jobId, `✅ قبل المراجع الآلي الفصل رغم تنبيه الفحص: ${review.reason}`, 'success');
                        }

                        translatedText = candidateTextForReview;
                        lastValidationReasons = [];
                        translationSuccess = true;
                        stickySuccessRoute = { providerIndex: providers.indexOf(prov), keyIdx, key };
                        await pushLog(jobId, `✅ نجحت الترجمة والمراجعة باستخدام ${provName} (سيُكمل النظام من هذا المزود/التوكن في الفصل التالي)`, 'success');
                        return { ok: true, kind: null };
                    } catch (err) {
                        console.error(`❌ (pure) فشل ${provName} مفتاح ${keyIdx + 1}: ${err.message}`);
                        await pushLog(jobId, `❌ فشل: ${err.message}`, 'warning');

                        if (isQwenProvider(prov)) {
                            if (err && err.name === 'QwenRateLimitedError') qwenAutoAccount.markTokenRateLimited(key);
                            else if (err && err.name === 'QwenAuthError') qwenAutoAccount.markTokenDead(key);
                        }

                        if (provIsSticky && tokenAttempt < tokenAttempts) {
                            resetConversationContextPurposeForScope(conversationContexts, 'chapters', conversationScopeKey, conversationBatchKey);
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
                    if (translationSuccess) break;
                    const providerIndex = providers.indexOf(provider);
                    const providerName = provider.name || provider.providerId;
                    const modelToUse = provider.selectedModel || (provider.models && provider.models[0]?.modelId) || 'gemini-2.5-flash';
                    let keys = getProviderAuthKeys(provider);
                    const isDeepSeek = isDeepSeekProvider(provider);
                    const isQwen = isQwenProvider(provider);
                    const isGeminiWeb = isGeminiWebProvider(provider);
                    const isStickyChat = isStickyChatProvider(provider);

                    if (keys.length === 0 && !isDeepSeek && !isQwen && !(isGeminiWeb && provider.allowGuestFallback)) {
                        await pushLog(jobId, `⚠️ المزوّد ${providerName} ليس لديه مفاتيح – تخطيه`, 'warning');
                        continue;
                    }
                    // وضع الضيف — نفس سلوك المترجم القائم
                    if (isGeminiWeb && provider.allowGuestFallback && keys.length === 0) {
                        keys = [GUEST_TOKEN_SENTINEL];
                        await pushLog(jobId, `🟡 تنبيه — وضع الضيف: مزوّد Gemini Web "${providerName}" بلا كوكيز، ستعمل الترجمة عبر الوصول المجهول (بدون حساب). لتجربة أفضل وأسرع أضف كوكيز حساب Google في حقل المفاتيح`, 'warning');
                    }
                    if (isDeepSeek && keys.length === 0) {
                        keys = ['dummy-key-for-deepseek'];
                        await pushLog(jobId, `🔑 مزوّد DeepSeek: لا توجد توكنات محفوظة، سيتم استخدام الرمز الافتراضي من تطبيق DeepSeek`, 'info');
                    } else if (isDeepSeek) {
                        await pushLog(jobId, `🔑 مزوّد DeepSeek: سيتم استخدام ${keys.length} توكن محفوظ من حقل المفاتيح/التوكنات`, 'info');
                    }

                    // 🔥🔥🔥 Qwen AUTO-ACCOUNT — حرفياً كالمترجم القائم 🔥🔥🔥
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
                                    await pushLog(jobId, `✅ تم إنشاء حساب Qwen جديد خاص بهذا المزوّد (${account.email}) وستُكمل الترجمة عليه مباشرة`, 'success');
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

                    // تفضيل التوكن الذي نجح في الفصل السابق
                    let preferredKeyIdx = 0;
                    if (stickySuccessRoute && stickySuccessRoute.providerIndex === providerIndex && stickySuccessRoute.key) {
                        const ki = keys.indexOf(stickySuccessRoute.key);
                        preferredKeyIdx = ki >= 0 ? ki : 0;
                    }
                    const orderedKeyIndexes = [...Array(keys.length).keys()].slice(preferredKeyIdx).concat([...Array(keys.length).keys()].slice(0, preferredKeyIdx));

                    let lastFailureKind = null;
                    for (const keyIdx of orderedKeyIndexes) {
                        const key = keys[keyIdx];
                        const tokenAttempts = isStickyChat ? DEEPSEEK_MAX_ATTEMPTS_PER_TOKEN : 1;
                        let tokenFailed = false;

                        for (let tokenAttempt = 1; tokenAttempt <= tokenAttempts; tokenAttempt++) {
                            const result = await attemptChapterWithToken(provider, modelToUse, key, keyIdx, keys.length, tokenAttempt, tokenAttempts, attempt);
                            if (result.ok) { lastFailureKind = null; break; }
                            tokenFailed = true;
                            lastFailureKind = result.kind || 'error';
                        }

                        if (translationSuccess) break;
                        if (isStickyChat && tokenFailed && keyIdx < keys.length - 1) {
                            await pushLog(jobId, `➡️ ${providerName}: فشل التوكن ${keyIdx + 1} بعد ${tokenAttempts} محاولات؛ الانتقال لتوكن آخر وسيستمر استخدامه إذا نجح`, 'warning');
                            await delay(3000);
                        } else if (!isStickyChat && keyIdx < keys.length - 1) {
                            await delay(3000);
                        }
                    }

                    // 🔥🔥🔥 Qwen: فشلت كل التوكنات → جولتا حساب جديد كلياً على Qwen فقط 🔥🔥🔥
                    if (!translationSuccess && isQwen && lastFailureKind === 'error') {
                        const AUTO_ROUNDS = 2;
                        for (let round = 1; round <= AUTO_ROUNDS && !translationSuccess; round++) {
                            await pushLog(jobId, `🤖 مزوّد Qwen: فشلت جميع التوكنات (${keys.length}) — إنشاء حساب Qwen جديد كلياً (جولة ${round}/${AUTO_ROUNDS}) ومتابعة الترجمة على Qwen فقط`, 'info');
                            let account;
                            let accountCreated = false;
                            try {
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
                                await pushLog(jobId, `✅ حساب Qwen جديد كلياً جاهز (${account.email}) — إعادة ترجمة الفصل ${chapterNum} بالتوكن الجديد`, 'success');
                            } else {
                                await pushLog(jobId, `⚠️ تعذّر إنشاء حساب مختلف الآن — إعادة المحاولة على حساب موجود (${account.email})`, 'warning');
                            }

                            const autoKeyIdx = keys.length - 1;
                            const autoTokenAttempts = 2;
                            for (let tokenAttempt = 1; tokenAttempt <= autoTokenAttempts && !translationSuccess; tokenAttempt++) {
                                await attemptChapterWithToken(provider, modelToUse, account.token, autoKeyIdx, keys.length, tokenAttempt, autoTokenAttempts, attempt);
                            }
                            if (!translationSuccess && round < AUTO_ROUNDS) await delay(3000);
                        }
                    }

                    if (!translationSuccess) {
                        await pushLog(jobId, `🚫 جميع مفاتيح ${providerName} فشلت أو لم تجتز المراجعة`, 'warning');
                        // 🔥 Qwen فقط: لا انتقال إلى مزوّد آخر — الدورة الخارجية ستعيد المحاولة
                        if (isQwen) break;
                    }
                }

                if (!translationSuccess) {
                    stickySuccessRoute = null;
                    await pushLog(jobId, `⏳ لم ينجح الفصل ${chapterNum} بعد تجربة كل المزودين/التوكنات. سيتم تصفير نقطة البدء ثم الانتظار 30 دقيقة وإعادة المحاولة على نفس الفصل.`, 'warning');
                    await delay(RETRY_DELAY_MS);
                }
            }

            if (!translationSuccess) break;
            // ========== End multi-provider translation with strict validation ==========

            // 🔥 استخراج العنوان من الترجمة — نفس منطق المترجم القائم حرفياً
            let extractedTitle = `الفصل ${chapterNum}`;
            try {
                const lines = translatedText.split('\n');
                let firstParagraph = "";
                for (const line of lines) {
                    if (line.trim().length > 0) {
                        firstParagraph = line.trim();
                        break;
                    }
                }
                if (firstParagraph && (firstParagraph.includes('الفصل') || firstParagraph.includes('Chapter')) && firstParagraph.includes(':')) {
                    const parts = firstParagraph.split(':');
                    if (parts.length > 1) {
                        const potentialTitle = parts.slice(1).join(':').trim();
                        if (potentialTitle.length > 0) {
                            extractedTitle = potentialTitle;
                        }
                    }
                }
            } catch (titleErr) {
                console.log("Title extraction error (pure):", titleErr);
            }

            // 🔥🔥🔥 ⚡ لا يوجد استخراج مصطلحات هنا إطلاقاً — الحفظ مباشرة ⚡ 🔥🔥🔥
            try {
                await firestore.collection('novels').doc(freshNovel._id.toString())
                    .collection('chapters').doc(chapterNum.toString())
                    .set({
                        title: extractedTitle,
                        content: translatedText,
                        lastUpdated: new Date()
                    }, { merge: true });
                // مزامنة المرآة (نفس شبكة أمان المترجم القائم)
                chapterMirror.upsertMirror(freshNovel._id.toString(), chapterNum, translatedText);

                const now = new Date();
                const existingChapterIndex = freshNovel.chapters.findIndex(c => c.number === chapterNum);

                if (existingChapterIndex === -1) {
                    await Novel.updateOne(
                        { _id: freshNovel._id },
                        {
                            $push: {
                                chapters: {
                                    number: chapterNum,
                                    title: extractedTitle,
                                    createdAt: now,
                                    views: 0
                                }
                            },
                            $set: {
                                lastChapterUpdate: now,
                                status: freshNovel.status === 'خاصة' ? 'مستمرة' : freshNovel.status
                            }
                        }
                    );
                    await pushLog(jobId, `✅ تم إضافة الفصل ${chapterNum} إلى قاعدة البيانات (الرواية أصبحت عامة)`, 'success');
                } else {
                    await Novel.updateOne(
                        { _id: freshNovel._id, "chapters.number": chapterNum },
                        {
                            $set: {
                                "chapters.$.title": extractedTitle,
                                "chapters.$.createdAt": now,
                                "lastChapterUpdate": now
                            }
                        }
                    );
                    if (freshNovel.status === 'خاصة') {
                        await Novel.updateOne(
                            { _id: freshNovel._id },
                            { $set: { status: 'مستمرة' } }
                        );
                        await pushLog(jobId, `🔓 تم تغيير حالة الرواية إلى 'مستمرة' (عامة)`, 'success');
                    }
                    await pushLog(jobId, `✅ تم تحديث الفصل ${chapterNum} وتاريخه`, 'success');
                }

                await PureTranslationJob.findByIdAndUpdate(jobId, {
                    $inc: { translatedCount: 1 },
                    $set: { currentChapter: chapterNum, lastUpdate: new Date() },
                    $pull: { targetChapters: chapterNum }
                });

                await pushLog(jobId, `🎉 تم إنجاز الفصل ${chapterNum} بعنوان "${extractedTitle}" وحفظه في السيرفر (ترجمة خالصة — بلا استخراج مصطلحات)`, 'success');

            } catch (saveErr) {
                console.error("Pure Save Error:", saveErr);
                await pushLog(jobId, `❌ فشل الحفظ: ${saveErr.message}`, 'error');
            }

            // ⏱️ الفاصل بين الفصول — يُقرأ حياً من المهمة حتى يسري تغييره من الواجهة فوراً
            const postJob = await PureTranslationJob.findById(jobId).select('chapterDelayMs');
            await delay(Math.max(0, Math.min(3600000, postJob?.chapterDelayMs ?? 2000)));
        }

        // النهاية: إن لم تبق فصول مستهدفة والمهمة لا تزال نشطة → مكتملة
        const finalJob = await PureTranslationJob.findById(jobId);
        if (finalJob && finalJob.status === 'active') {
            const remaining = (finalJob.targetChapters || []).length;
            if (remaining === 0) {
                await PureTranslationJob.findByIdAndUpdate(jobId, { status: 'completed' });
                await pushLog(jobId, `🏁 اكتملت جميع الفصول! فصول مترجمة: ${finalJob.translatedCount} — ترجمة خالصة بالمسرد الجاهز وبدون أي استخراج مصطلحات`, 'success');
            } else {
                await pushLog(jobId, `⏳ توقفت المهمة مع ${remaining} فصلاً لم يُترجم بعد (استئناف متاح)`, 'warning');
            }
        }

    } catch (err) {
        console.error('Pure Translation Job Error:', err);
        try {
            await PureTranslationJob.findByIdAndUpdate(jobId, { status: 'failed' });
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
// ⚡ المسارات — /api/pure-translate/* (نفس واجهة المترجم/المستخرج حرفياً)
// =========================================================
module.exports = function (app, verifyToken, verifyAdmin) {

    // 1) روايات الترجمة — نفس نداء المترجم/المستخرج حرفياً
    app.get('/api/pure-translate/novels', verifyToken, verifyAdmin, async (req, res) => {
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
            console.error("Pure Translator Novels Error:", e);
            res.status(500).json({ error: e.message });
        }
    });

    // 2) بدء مهمة ترجمة خالصة (أو استئناف ب jobId) — يقبل chapterDelay بالثواني
    app.post('/api/pure-translate/start', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const { novelId, chapters, jobId, chapterDelay } = req.body;

            if (jobId) {
                const existingJob = await PureTranslationJob.findById(jobId);
                if (!existingJob) return res.status(404).json({ message: "Job not found" });
                if ((existingJob.targetChapters || []).length === 0) {
                    return res.status(400).json({ message: "لا توجد فصول متبقية في هذه المهمة" });
                }
                const delayMs = parseChapterDelaySeconds(chapterDelay);
                if (delayMs !== null) existingJob.chapterDelayMs = delayMs;
                existingJob.status = 'active';
                existingJob.logs.push({ message: '▶️ تم استئناف مهمة الترجمة الخالصة' + (delayMs !== null ? ` | ⏱️ الفاصل: ${delayMs / 1000} ثانية` : ''), type: 'info' });
                await existingJob.save();
                processPureTranslationJob(existingJob._id);
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
                        console.error("Failed to fetch chapters from Firestore (pure-translate):", err.message);
                    }
                }
                const allChaptersSet = new Set([...mongoChapters, ...firestoreChapters]);
                // نفس توسعة المترجم القائم: تغطية sourceChaptersCount كاملاً
                if (novel.sourceChaptersCount && novel.sourceChaptersCount > allChaptersSet.size) {
                    for (let i = 1; i <= novel.sourceChaptersCount; i++) allChaptersSet.add(i);
                }
                targetChapters = Array.from(allChaptersSet).sort((a, b) => a - b);
            } else if (Array.isArray(chapters)) {
                targetChapters = chapters.map(n => parseInt(n)).filter(n => !isNaN(n));
            }

            if (targetChapters.length === 0) {
                return res.status(400).json({ message: "لا توجد فصول لترجمتها" });
            }

            const delayMs = parseChapterDelaySeconds(chapterDelay);
            const effectiveDelayMs = delayMs === null ? 2000 : delayMs;

            const job = new PureTranslationJob({
                novelId,
                novelTitle: novel.title,
                cover: novel.cover,
                targetChapters,
                totalToTranslate: targetChapters.length,
                chapterDelayMs: effectiveDelayMs,
                logs: [{ message: `تم بدء الترجمة الخالصة لـ«${novel.title}» (استهداف ${targetChapters.length} فصلاً — ترجمة فقط بلا استخراج مصطلحات، بالمسرد الجاهز) | ⏱️ الفاصل بين الفصول: ${effectiveDelayMs / 1000} ثانية`, type: 'info' }]
            });
            await job.save();
            processPureTranslationJob(job._id);
            res.json({ message: "Pure translation started", jobId: job._id });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 3) إيقاف مؤقت
    app.post('/api/pure-translate/jobs/:id/pause', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const job = await PureTranslationJob.findById(req.params.id);
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
    app.delete('/api/pure-translate/jobs/:id', verifyToken, verifyAdmin, async (req, res) => {
        try {
            await PureTranslationJob.findByIdAndDelete(req.params.id);
            res.json({ message: "Job deleted" });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 4.5) ⏱️ تغيير الفاصل بين الفصول لمهمة جارية (يتأثر من الفصل التالي فوراً)
    app.post('/api/pure-translate/jobs/:id/delay', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const delayMs = parseChapterDelaySeconds(req.body?.seconds);
            if (delayMs === null) {
                return res.status(400).json({ message: "قيمة فاصل غير صالحة — أدخل عدد ثوانٍ بين 0 و 3600" });
            }
            const job = await PureTranslationJob.findByIdAndUpdate(
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

    // 5) قائمة المهام
    app.get('/api/pure-translate/jobs', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const jobs = await PureTranslationJob.find()
                .select('novelTitle cover status translatedCount totalToTranslate startTime')
                .sort({ updatedAt: -1 })
                .limit(20);
            const uiJobs = jobs.map(j => ({
                id: j._id,
                novelTitle: j.novelTitle,
                cover: j.cover,
                status: j.status,
                translated: j.translatedCount,
                total: j.totalToTranslate,
                startTime: j.startTime
            }));
            res.json(uiJobs);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 6) تفاصيل مهمة (مع السجل الحي)
    app.get('/api/pure-translate/jobs/:id', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const job = await PureTranslationJob.findById(req.params.id);
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
