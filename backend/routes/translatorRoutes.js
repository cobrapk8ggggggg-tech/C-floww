const { callAccountProvider } = require('../services/accountProviders.service');
const { isChatGPTProvider, isDeepSeekWorkerProvider, normalizeAccountSettings } = require('../services/accountSettings.service');
const mongoose = require('mongoose');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require('axios'); // 🔥 NEW: for OpenRouter and custom providers
const Novel = require('../models/novel.model.js');
const Glossary = require('../models/glossary.model.js');
const TranslationJob = require('../models/translationJob.model.js');
const Settings = require('../models/settings.model.js');
const { askDeepSeek } = require('../services/deepseekAndroid.service.js');
const { askQwen } = require('../services/qwenAndroid.service.js');
// 🔥 Gemini Web — نقل مسار Gemini فقط من بروكسي المستخدم (jsnjbwjbw-ui/Proxy):
// كوكيز gemini.google.com → SNlM0e/FdrFJe → StreamGenerate + إكمال تلقائي ضد القطع
// 🔥 GUEST_TOKEN_SENTINEL: مفتاح وهمي يمثل جلسة الضيف عندما لا توجد كوكيز إطلاقاً
const { askGeminiWeb, GeminiWebAuthError, GUEST_TOKEN_SENTINEL } = require('../services/geminiWeb.service.js');
// 🔥 نظام إنشاء حسابات Qwen تلقائياً (منقول من qwen.py):
// عند عدم وجود مفتاح أو فشل كل المفاتيح يُنشأ حساب جديد وتُكمل الترجمة عليه — Qwen فقط.
const qwenAutoAccount = require('../services/qwenAutoAccount.service.js');
// 🔥 مرآة محتوى الفصول (MongoDB) — مزامنة مخرجات الترجمة مع شبكة أمان حصة Firestore
const chapterMirror = require('../services/chapterMirror.service.js');

const DEEPSEEK_CHAPTERS_PER_CONVERSATION = 100;
const DEEPSEEK_MAX_ATTEMPTS_PER_TOKEN = 5;
const DEFAULT_DEEPSEEK_POW_PROVIDERS = [
    // 🔥 خوادم Railway/Ngrok القديمة ماتت (404) — الوكيل الجديد هو الوحيد العامل (تم التحقق حياً)
    { id: '3mh', name: '3MH Telegram POW', url: 'https://deepseek-pow.contact-3mh.workers.dev/get_pow' },
    { id: 'zeus', name: 'Zeus POW', url: 'http://107.172.78.104:8800/get_pow' },
    { id: 'railway', name: 'Railway (قديم)', url: 'https://pow.up.railway.app/pow' },
    { id: 'ngrok', name: 'Ngrok (قديم)', url: 'https://immunize-quintet-trimmer.ngrok-free.dev/get_pow' }
];
// روابط معروف أنها ماتة — تُتجاوز تلقائياً حتى مع إعدادات مخزنة قديمة.
// 🔥 مطابقة رابط كامل (وليس مضيفاً) حتى لا يُحجب خادم POW مخصص للمستخدم
// يحدث أن يكون على ngrok أو Railway بعنوان مختلف تماماً.
const DEAD_POW_URLS = [
    'https://pow.up.railway.app/pow',
    'https://web-production-c09dc.up.railway.app/pow',
    'https://immunize-quintet-trimmer.ngrok-free.dev/get_pow'
].map(u => u.replace(/\/+$/, '').toLowerCase());
const stickyTokenAssignments = new Map();
let stickyNextTokenIndex = 0;


function normalizePowProviderUrl(url) {
    const value = url || '';
    return value.includes('/get_pow') ? value.split('?')[0] : value;
}

function resolveDeepSeekPowUrl(provider) {
    const powProviders = Array.isArray(provider.powProviders) && provider.powProviders.length > 0
        ? provider.powProviders
        : DEFAULT_DEEPSEEK_POW_PROVIDERS;
    const selected = powProviders.find(p => p.id === provider.selectedPowProviderId) || powProviders[0];
    const url = normalizePowProviderUrl(selected?.url);
    // شفاء تلقائي: إعدادات قديمة مخزنة تشير لخادم ميت → وكيل جديد عامل
    // (مطابقة الرابط الكامل فقط — الرابط المخصص للمستخدم لا يُمس أبداً)
    if (DEAD_POW_URLS.includes(url.replace(/\/+$/, '').toLowerCase())) {
        return normalizePowProviderUrl(DEFAULT_DEEPSEEK_POW_PROVIDERS[0].url);
    }
    return url;
}

function getDeepSeekConversationContext(contextStore, purpose, batchKey, scopeKey = 'default') {
    if (!contextStore || !purpose || batchKey === undefined || batchKey === null) return undefined;
    if (!contextStore[purpose]) contextStore[purpose] = new Map();
    const scopedStore = contextStore[purpose];
    const contextKey = `${scopeKey}:${batchKey}`;
    if (!scopedStore.has(contextKey)) {
        scopedStore.set(contextKey, {
            purpose,
            batchKey,
            scopeKey,
            sessionId: null,
            parentMessageId: null,
            requestMessageId: null,
            lastUpdated: null
        });
    }
    return scopedStore.get(contextKey);
}

function resetConversationContextsForScope(contextStore, scopeKey, batchKey) {
    if (!contextStore || !scopeKey) return;
    for (const scopedStore of Object.values(contextStore)) {
        if (!(scopedStore instanceof Map)) continue;
        for (const [contextKey, context] of scopedStore.entries()) {
            if (context?.scopeKey !== scopeKey) continue;
            if (batchKey !== undefined && batchKey !== null && context.batchKey !== batchKey) continue;
            scopedStore.delete(contextKey);
        }
    }
}

function resetConversationContextPurposeForScope(contextStore, purpose, scopeKey, batchKey) {
    const scopedStore = contextStore?.[purpose];
    if (!(scopedStore instanceof Map) || !scopeKey) return;
    for (const [contextKey, context] of scopedStore.entries()) {
        if (context?.scopeKey !== scopeKey) continue;
        if (batchKey !== undefined && batchKey !== null && context.batchKey !== batchKey) continue;
        scopedStore.delete(contextKey);
    }
}

function getTokenConversationScope(provider, key, keyIdx) {
    const providerKey = provider.providerId || provider.name || 'provider';
    const tokenHash = hashStringToIndex(key || `key-${keyIdx}`, 1000000007);
    return `${providerKey}:token-${keyIdx}:${tokenHash}`;
}

function hashStringToIndex(value, size) {
    if (!value || size <= 0) return 0;
    let hash = 0;
    for (let i = 0; i < value.length; i++) {
        hash = ((hash << 5) - hash) + value.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash) % size;
}

function getProviderAuthKeys(provider) {
    // DeepSeek/Qwen templates keep their own token fields (synced from apiKeys on save).
    if (isDeepSeekProvider(provider)) {
        const deepSeekTokens = Array.isArray(provider.deepSeekTokens)
            ? provider.deepSeekTokens.map(t => (t || '').trim()).filter(Boolean)
            : [];
        if (deepSeekTokens.length > 0) return deepSeekTokens;
    }
    if (isQwenProvider(provider)) {
        const qwenTokens = Array.isArray(provider.qwenTokens)
            ? provider.qwenTokens.map(t => (t || '').trim()).filter(Boolean)
            : [];
        if (qwenTokens.length > 0) return qwenTokens;
    }
    // Everything else (Gemini/OpenRouter/Cloudflare/custom) uses its OWN apiKeys.
    return Array.isArray(provider.apiKeys) ? provider.apiKeys.map(k => (k || '').trim()).filter(Boolean) : [];
}

function pickDeepSeekToken(provider, options = {}, explicitToken) {
    const directToken = (explicitToken || '').trim();
    if (directToken && !directToken.startsWith('dummy-key-for-')) return directToken;
    const tokenField = isQwenProvider(provider) ? provider.qwenTokens : provider.deepSeekTokens;
    const tokens = Array.isArray(tokenField)
        ? tokenField.map(t => (t || '').trim()).filter(Boolean)
        : [];
    if (tokens.length === 0) return provider.deepSeekToken || undefined;
    const stickyKey = `${options.deepSeekJobId || ''}:${provider.providerId || provider.name || 'deepseek'}`;
    if (options.deepSeekJobId) {
        if (!stickyTokenAssignments.has(stickyKey)) {
            stickyTokenAssignments.set(stickyKey, stickyNextTokenIndex % tokens.length);
            stickyNextTokenIndex++;
        }
        return tokens[stickyTokenAssignments.get(stickyKey) % tokens.length];
    }
    return tokens[hashStringToIndex(stickyKey, tokens.length)];
}

// --- Firestore Setup (MANDATORY) ---
let firestore;
try {
    const firebaseAdmin = require('../config/firebaseAdmin');
    firestore = firebaseAdmin.db;
} catch (e) {
    console.error("❌ CRITICAL: Firestore not loaded. Translator cannot work without it.");
}

// --- Helper: Delay ---
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 🔥 Helper to get GLOBAL Settings (Singleton)
async function getGlobalSettings() {
    let settings = await Settings.findOne();
    if (!settings) {
        settings = new Settings({});
        await settings.save();
    }
    return settings;
}

// 🔥 New Default Prompt as provided by user
const DEFAULT_EXTRACT_PROMPT = `ROLE: Expert Web Novel Terminology Extractor.
TASK: Analyze the "Source Text" (any language: English/Chinese/Korean/Japanese/Russian/...) and "Arabic Translation" below. Extract key proper nouns, unique concepts, and specific terminology for a comprehensive Glossary (Codex).

STRICT RULES:
1.  Categories: Classify each extracted term into one of: 'character', 'location', 'item', 'rank', 'concept', 'other'.
    *   character: Names of individuals, specific titles referring to a person.
    *   location: Cities, villages, geographical regions, buildings, headquarters.
    *   item: Tools, weapons, materials, unique objects, or specific creatures.
    *   rank: General military, social, or cultivation ranks (not specific character names).
    *   concept: Spiritual, philosophical, agricultural terms, general techniques, or abstract ideas.
    *   other: Any other important term that doesn't fit the above categories.
2.  Format: Return a clean JSON array of objects.
3.  Content:
    *   "name": The exact original term as written in the source (any language: English/Chinese/Korean/...). Capitalized where appropriate.
    *   "translation": The exact Arabic translation used in the text.
    *   "description": وصف قصير جداً باللغة العربية (2-4 كلمات)، مثل: "البطل الرئيسي", "مهارة سيف", "طريقة زراعة", "طاقة روحية".
4.  Filtering & Exclusion (قواعد التصفية والاستبعاد):
    *   Ignore common words. Only specific names, places, unique cultivation terms, and key concepts should be extracted.
    *   Blacklist (تجاهل تام - لا تستخرج هذه أبداً):
        *   الأرقام المنفردة أو أرقام الفصول (مثال: 1, 500, Chapter 10).
        *   عبارات النظام أو الإشعارات (مثال: Ding, System alert, Level Up).
        *   جمل التفاعل والإعلانات (مثال: Subscribe, Read at..., Translator notes, ...).
        *   الأفعال والصفات العادية (مثال: run, fast, big, eat, go).
        *   الكلمات الشائعة جداً التي لا تعتبر مصطلحات خاصة.
5.  Accuracy (الدقة):
    *   Each extracted term must be unique (in its original language).
    *   The Arabic translation must exactly match the word or phrase used in the provided Arabic text.
    *   Extracted terms must be meaningful within their context.

Focus Areas (مجالات التركيز - لتوجيه الاستخراج):
*   مصطلحات الزراعة والتقنيات: مثل أنواع النباتات، أساليب الزراعة، أدوات وتقنيات زراعية، أمراض النباتات، حلول هندسية زراعية.
*   أسماء المواقع والمقرات: أسماء المدن، القرى، المناطق الجغرافية، المباني، المقرات الحكومية أو الخاصة، أي موقع ذي أهمية.
*   الشخصيات والرتب الخالدة: أسماء الأشخاص، الألقاب، الرتب العسكرية أو الاجتماعية، الشخصيات التاريخية أو الخيالية.
*   المفاهيم الروحية والزراعية: المصطلحات الدينية، الفلسفية، الروحية، أو المفاهيم المتعلقة بالزراعة العضوية، الاستدامة، التنوع البيولوجي.

OUTPUT JSON STRUCTURE:
[
  { "category": "character", "name": "Fang Yuan", "translation": "فانغ يوان", "description": "البطل الرئيسي" },
  { "category": "concept", "name": "Immortal Gu", "translation": "غو الخالد", "description": "عنصر زراعة" },
  { "category": "location", "name": "Green Mountain Sect", "translation": "طائفة الجبل الأخضر", "description": "مقر الطائفة" }
]

RETURN ONLY JSON:`;

// 🔥 Check if a model is a translation-only model (cannot do JSON extraction)
function isTranslationOnlyModel(modelId) {
    if (!modelId) return false;
    // Cloudflare translation models – cannot instruct with prompts
    if (modelId.startsWith('@cf/meta/m2m100')) return true;
    // Add other translation-only models here if needed
    return false;
}

// 🔥 Find the first LLM model in a provider (for extraction)
function findLLMModel(provider) {
    if (!provider.models || provider.models.length === 0) return null;
    return provider.models.find(m => !isTranslationOnlyModel(m.modelId)) || null;
}

// 🔥 PROVIDER CLASSIFICATION — by providerId ONLY (never by name/model substrings).
// Old logic matched "name/model includes deepseek/qwen/gpt", which HIJACKED custom
// (OpenAI-compatible) providers: a custom provider with a gpt/qwen/deepseek model
// was silently routed into the Android-app conversation flow, its baseUrl ignored
// and its real API key replaced by a dummy token. Custom providers are now
// completely independent: they always go through their own baseUrl with their own key.
function isDeepSeekProvider(provider) {
    const providerId = String(provider.providerId || '').toLowerCase();
    return providerId === 'deepseek' || providerId.startsWith('deepseek_');
}

function isQwenProvider(provider) {
    const providerId = String(provider.providerId || '').toLowerCase();
    return providerId === 'qwen' || providerId.startsWith('qwen_');
}

// 🔥 Gemini Web: مزوّد كوكيز حساب Google عبر واجهة الويب (مثل قالب deepseek/qwen —
// المفاتيح = سلاسل كوكيز من gemini.google.com وليست مفاتيح API رسمية)
function isGeminiWebProvider(provider) {
    const providerId = String(provider.providerId || '').toLowerCase();
    return providerId === 'gemini_web' || providerId.startsWith('gemini_web_');
}

function isStickyChatProvider(provider) {
    return isDeepSeekProvider(provider) || isQwenProvider(provider) || isGeminiWebProvider(provider) || isChatGPTProvider(provider);
}

const ARABIC_FULL_CHAPTER_WORD_THRESHOLD = 800;
const SHORT_CHAPTER_SOURCE_WORD_THRESHOLD = 900;
const MIN_ARABIC_TO_ENGLISH_WORD_RATIO = 0.35;
const ALLOWED_SHORT_LATIN_TOKEN_PATTERN = /^[A-Z]{2,4}\d*$/;

function stripCodeBlocks(text) {
    return (text || '').replace(/```[\s\S]*?```/g, ' ');
}

function removeDeepSeekFinishedMarker(text) {
    return (text || '').replace(/(?:\r?\n|\s)*FINISHED\s*$/i, '').trim();
}

function getArabicLetterCount(text) {
    return (text || '').match(/[\u0600-\u06FF]/g)?.length || 0;
}

function getArabicWordCount(text) {
    return ((text || '').match(/[\u0600-\u06FF]+/g) || []).length;
}

function getEnglishWordCount(text) {
    return ((text || '').match(/\b[A-Za-z][A-Za-z'’\-]*\b/g) || []).length;
}

// 🔥 MULTILINGUAL: any non-Arabic, non-Latin script that must NEVER survive
// translation — Chinese/Japanese (Han + Kana), Korean (Hangul), Cyrillic,
// Greek, Hebrew, Thai, Devanagari... Unlike Latin there are NO exceptions
// for these scripts (the user asked: "بلا استثناءات").
const FOREIGN_SCRIPT_RUNS = /([㐀-䶿一-鿿豈-﫿぀-ヿㇰ-ㇿ가-힯ᄀ-ᇿ㄰-㆏Ѐ-ӿͰ-Ͽ֐-׿฀-๿ऀ-ॿ]+)/g;

function getForeignScriptRuns(text) {
    return (text || '').match(FOREIGN_SCRIPT_RUNS) || [];
}

function isLatinWord(word) {
    return /^[A-Za-z][A-Za-z'’\-]*$/.test(word || '');
}

// Estimate of how much "content" the source carries, used by the Arabic-ratio
// check. English counts words; CJK counts characters (≈2 chars per word);
// space-delimited scripts (Korean/Cyrillic/...) count words.
function getSourceMagnitude(text) {
    const value = String(text || '');
    const englishWords = getEnglishWordCount(value);
    const cjkChars = (value.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/g) || []).length;
    const hangulWords = (value.match(/[\uac00-\ud7af]+/g) || []).length;
    const otherWords = (value.match(/[\u0400-\u04ff\u0370-\u03ff\u0590-\u05ff\u0e00-\u0e7f]{2,}/g) || []).length;
    return englishWords + Math.ceil(cjkChars / 2) + hangulWords + otherWords;
}

function escapeRegex(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isAllowedShortLatinToken(word) {
    const normalized = (word || '').trim();
    if (normalized.length <= 1) return true;
    
    // ✅ جديد: السماح بأي سلسلة مكررة من نفس الحرف (SS, SSS, AAA, bb ...)
    if (/^([a-zA-Z])\1+$/.test(normalized)) return true;
    
    // السلوك القديم: السماح باختصارات معينة بشرط عدم وجود حروف علة
    return ALLOWED_SHORT_LATIN_TOKEN_PATTERN.test(normalized) && !/[AEIOU]/.test(normalized);
}

function extractEnglishResidues(text) {
    const cleaned = stripCodeBlocks(removeDeepSeekFinishedMarker(text));
    const matches = cleaned.match(/\b[A-Za-z][A-Za-z'’\-]*\b/g) || [];
    const seen = new Set();
    const residues = [];

    for (const word of matches) {
        const normalized = word.trim();
        if (normalized.toUpperCase() === 'FINISHED') continue;
        // السماح بالرموز اللاتينية القصيرة للرتب/المستويات مثل A أو S أو LV أو HP.
        if (isAllowedShortLatinToken(normalized)) continue;
        const key = normalized.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        residues.push(normalized);
    }

    return residues;
}

// 🔥 MULTILINGUAL: leftover Chinese/Korean/Japanese/Russian/... fragments in the
// "translated" output. استثناءات ممنوعة — every foreign run must be translated.
function extractForeignResidues(text) {
    const cleaned = stripCodeBlocks(removeDeepSeekFinishedMarker(text));
    const matches = getForeignScriptRuns(cleaned);
    const seen = new Set();
    const residues = [];
    for (const run of matches) {
        const normalized = (run || '').trim();
        if (!normalized) continue;
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        residues.push(normalized);
    }
    return residues;
}

function getResidueContexts(text, residues, contextChars = 45) {
    const value = text || '';
    return residues.slice(0, 80).map(item => {
        let start = -1, len = item.length;
        if (isLatinWord(item)) {
            const match = new RegExp(`\\b${escapeRegex(item)}\\b`, 'i').exec(value);
            if (match) { start = match.index; }
        } else {
            start = value.indexOf(item);
        }
        if (start === -1) return { word: item, context: item };
        const end = Math.min(value.length, start + len + contextChars);
        return { word: item, context: value.substring(Math.max(0, start - contextChars), end).replace(/\s+/g, ' ').trim() };
    });
}

function parseJsonFromAiText(text) {
    let jsonText = (text || '').trim();
    if (jsonText.startsWith('```json')) jsonText = jsonText.replace(/^```json\s*/i, '').replace(/\s*```$/, '');
    else if (jsonText.startsWith('```')) jsonText = jsonText.replace(/^```\s*/, '').replace(/\s*```$/, '');
    if (/^json\s*[\n\r]/i.test(jsonText)) jsonText = jsonText.replace(/^json\s*[\n\r]+/i, '');
    const jsonMatch = jsonText.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
    if (jsonMatch) jsonText = jsonMatch[1];
    return JSON.parse(jsonText);
}

function isLikelyAiRefusalOrMeta(text) {
    const lower = (text || '').toLowerCase();
    const patterns = [
        /\bas an ai\b/,
        /\bi (?:can'?t|cannot|am unable to)\b/,
        /\bi need (?:the )?(?:chapter|text|content)\b/,
        /\bplease provide\b/,
        /\btranslation\s+instructions?\b/,
        /\bglossary\b[\s\S]{0,120}\bjson\b/,
        /\benglish text to translate\b/,
        /\boutput only\b/
    ];
    return patterns.some(pattern => pattern.test(lower));
}

function validateTranslatedChapter(translatedText, sourceContent) {
    const text = removeDeepSeekFinishedMarker(translatedText);
    const source = (sourceContent || '').trim();
    const reasons = [];
    const englishResidues = extractEnglishResidues(text);
    const foreignResidues = extractForeignResidues(text);
    const arabicWords = getArabicWordCount(text);
    const sourceWords = getSourceMagnitude(source);
    const wordRatio = sourceWords > 0 ? arabicWords / sourceWords : 0;
    const sourceLooksShort = sourceWords > 0 && sourceWords < SHORT_CHAPTER_SOURCE_WORD_THRESHOLD;

    if (text.length < 80 && source.length >= 200) reasons.push('الناتج قصير جداً ولا يبدو فصلاً مترجماً كاملاً');
    if (!sourceLooksShort && source.length >= 500 && text.length < source.length * 0.20) reasons.push('الناتج أقصر بكثير من الفصل الأصلي');
    if (getArabicLetterCount(text) < 50) reasons.push('الناتج لا يحتوي على نص عربي كافٍ');
    // 🔥 كشف تكرار الفقرات (شكوى المستخدم على Gemini Web: "يكرر نفس الفقرات في الفصل"):
    // فقرة طويلة (≥60 حرفاً) بعد التطبيع تظهر 3+ مرات، أو فقرتان مميزتان+ تكررتا مرتين+
    // = فشل واضح يعاد الترجمة/الإصلاح بسببه. آمن من الإنذارات الكاذبة (مقاطع حوار قصيرة < 60 حرفاً غير محسوبة).
    const repeatedInfo = detectRepeatedParagraphs(text);
    if (repeatedInfo) reasons.push(repeatedInfo);
    if (englishResidues.length > 0) reasons.push(`الناتج يحتوي على كلمات إنجليزية غير مترجمة: ${englishResidues.slice(0, 12).join(', ')}`);
    if (foreignResidues.length > 0) reasons.push(`الناتج يحتوي على نص أجنبي غير مترجم (صيني/كوري/ياباني/غيره): ${foreignResidues.slice(0, 8).map(r => r.length > 24 ? r.substring(0, 24) + '…' : r).join(' ، ')}`);
    if (isLikelyAiRefusalOrMeta(text)) reasons.push('الناتج يبدو كرسالة من الذكاء الاصطناعي أو تعليمات وليس فصلاً مترجماً');
    if (!sourceLooksShort && sourceWords >= SHORT_CHAPTER_SOURCE_WORD_THRESHOLD && arabicWords > 0 && arabicWords < ARABIC_FULL_CHAPTER_WORD_THRESHOLD && wordRatio < MIN_ARABIC_TO_ENGLISH_WORD_RATIO) {
        reasons.push(`الناتج العربي قصير مقارنة بالأصل: ${arabicWords} كلمة عربية مقابل ${sourceWords} كلمة/رمز في الأصل تقريباً`);
    }

    return { ok: reasons.length === 0, reasons, englishResidues, foreignResidues, residues: [...englishResidues, ...foreignResidues], arabicWords, sourceWords, wordRatio };
}

// 🔥 كشف تكرار الفقرات في النص المترجم (بلاغ المستخدم على Gemini Web):
// يطبّع الفقرات (طول ≥ 60 حرفاً) ويعدّ التكرارات الحرفية — حوار رواية شرعي قصير لا يُحتسب.
function detectRepeatedParagraphs(translatedText) {
    try {
        const paragraphs = String(translatedText || '')
            .split(/\n+/)
            .map(p => p.trim().replace(/\s+/g, ' '))
            .filter(p => p.length >= 60);
        if (paragraphs.length < 3) return null;
        const counts = new Map();
        for (const p of paragraphs) counts.set(p, (counts.get(p) || 0) + 1);
        const repeated = [...counts.entries()].filter(([, c]) => c >= 2);
        if (!repeated.length) return null;
        const worst = repeated.reduce((a, b) => (b[1] > a[1] ? b : a));
        // نُفشل عند: تكرار 3+ لفقرة، أو فقرتان مكررتان+، أو فقرة واحدة مكررة مرتين
        // لكنها طويلة (≥100 حرف) — الزخارف/التراتيل المقصودة في الروايات قصيرة عادة فلا تُحتسب.
        if (worst[1] >= 3 || repeated.length >= 2 || worst[0].length >= 100) {
            const preview = worst[0].length > 50 ? worst[0].substring(0, 50) + '…' : worst[0];
            return `الناتج يكرر نفس الفقرات (${repeated.length} فقرة مكررة، أسوأها تكررت ${worst[1]} مرات): «${preview}» — يجب أن يكون كل فقرة محتواها الخاص دون تكرار`;
        }
        return null;
    } catch (_) { return null; }
}

async function translateResiduesOnly(provider, modelToUse, key, translatedText, residues, options) {
    if (!residues.length) return translatedText;
    const contexts = getResidueContexts(translatedText, residues);
    const prompt = `
أنت مدقق ترجمة عربية محترف. بقي داخل فصل عربي مقاطع غير مترجمة بلغات أجنبية (إنجليزية/صينية/كورية/يابانية/روسية أو أي لغة أخرى).
المطلوب:
- ترجم كل مقطع إلى العربية ONLY اعتماداً على السياق المجاور، ولا تعِد ترجمة الجملة كاملة.
- الكلمات الإنجليزية: الكلمات المستقلة القصيرة التي تمثل رتبة/تصنيف مثل A أو S أو LV أو HP تُترك كما هي (أعدها كما هي في حقل translation).
- اللغات الأخرى (الصينية/الكورية/اليابانية/الروسية/غيرها): لا توجد أي استثناءات إطلاقاً — كل مقطع يجب أن يُترجم إلى العربية.
أعد JSON فقط بالشكل:
[{"word":"المقطع الأصلي كما هو","translation":"الترجمة العربية"}]

المقاطع والسياقات:
${JSON.stringify(contexts, null, 2)}
`;
    const response = await callTranslationProvider(provider, modelToUse, key, prompt, options);
    let replacements = [];
    try {
        const parsed = parseJsonFromAiText(response);
        replacements = Array.isArray(parsed) ? parsed : (parsed.replacements || []);
    } catch (e) {
        throw new Error(`فشل تحليل بدائل الكلمات الأجنبية: ${e.message}`);
    }

    let fixedText = translatedText;
    for (const item of replacements) {
        const word = (item.word || '').trim();
        const translation = (item.translation || '').trim();
        if (!word || !translation) continue;
        if (word.length <= 1 && isLatinWord(word)) continue;
        // 🔥 SAFETY: Latin words are replaced with word boundaries; foreign scripts
        // (Chinese/Korean/...) have no word boundaries so they are replaced with a
        // literal split/join. '$' in replacements must be escaped either way.
        const safeTranslation = translation.replace(/\$/g, '$$$$');
        try {
            if (isLatinWord(word)) {
                fixedText = fixedText.replace(new RegExp(`\\b${escapeRegex(word)}\\b`, 'g'), safeTranslation);
            } else {
                fixedText = fixedText.split(word).join(safeTranslation);
            }
        } catch (e) { /* skip malformed term */ }
    }
    return fixedText;
}

async function reviewQuestionableChapter(provider, modelToUse, key, translatedText, sourceContent, validation, options) {
    const prompt = `
أنت مراجع جودة لترجمة فصول روايات من أي لغة (إنجليزية/صينية/كورية/يابانية/روسية أو غيرها) إلى العربية.
قارن النص الأصلي بالنص العربي الناتج.

مؤشرات آلية:
- كلمات/رموز الأصل تقريباً: ${validation.sourceWords}
- كلمات النص العربي تقريباً: ${validation.arabicWords}
- نسبة العربي إلى الأصل تقريباً: ${validation.wordRatio.toFixed(2)}
- الملاحظات:
- ${validation.reasons.join('\n- ')}

القرار المطلوب نهائي وحاسم:
- أجب بكلمة واحدة فقط: نعم أو لا.
- نعم = اقبل الترجمة واتركها كما هي.
- لا = أعد ترجمة الفصل لأنه ناقص/مختصر/ليس فصلاً كاملاً.
- إذا كان النص العربي يغطي أحداث الأصل فعلاً فالإجابة نعم حتى لو كان عدد الكلمات أقل.
- إذا كان النص العربي مجرد سطرين أو جزء صغير من الفصل فالإجابة لا.

النص الأصلي للمقارنة (قد يكون بأي لغة):
"""${sourceContent.substring(0, 7000)}"""

النص العربي للمراجعة:
"""${translatedText.substring(0, 12000)}"""
`;
    const response = await callTranslationProvider(provider, modelToUse, key, prompt, options);
    const answer = String(response || '').trim().toLowerCase();
    const firstToken = answer.replace(/["'`{}\[\]().،,:;!؟]/g, ' ').trim().split(/\s+/)[0] || '';

    if (['نعم', 'yes', 'accept', 'accepted', 'ok', 'pass'].includes(firstToken) || /^نعم\b/i.test(answer)) {
        return { decision: 'accept', reason: 'المراجع أجاب: نعم', rawResponse: response };
    }
    if (['لا', 'no', 'retranslate', 'retry', 'reject', 'rejected'].includes(firstToken) || /^لا\b/i.test(answer)) {
        return { decision: 'retranslate', reason: 'المراجع أجاب: لا', rawResponse: response };
    }

    try {
        const parsed = parseJsonFromAiText(response);
        const rawDecision = String(parsed.decision || parsed.Decision || parsed.status || parsed.result || parsed.answer || '').trim().toLowerCase();
        const decision = ['accept', 'accepted', 'ok', 'pass', 'yes', 'نعم', 'قبول', 'مقبول'].includes(rawDecision)
            ? 'accept'
            : 'retranslate';
        return { decision, reason: parsed.reason || `قرار المراجع الآلي: ${rawDecision || 'غير واضح'}`, rawResponse: response };
    } catch (e) {
        return { decision: 'retranslate', reason: `رد المراجع غير واضح ولم يكن نعم/لا: ${String(response || '').substring(0, 120)}`, rawResponse: response };
    }
}

function buildRepairTranslationPrompt(basePrompt, glossaryText, sourceContent, previousTranslation, reasons) {
    return `
${basePrompt}

--- قواعد إلزامية ---
ترجم كل الفقرات دون حذف أو تلخيص أو دمج. أخرج الترجمة العربية الكاملة فقط بدون شرح.

مراجعة صارمة: الترجمة السابقة فشلت للأسباب التالية:
- ${reasons.join('\n- ')}

أعد ترجمة الفصل كاملاً من النص الأصلي أدناه إلى العربية فقط مهما كانت لغة الأصل (إنجليزية/صينية/كورية/يابانية/روسية أو غيرها).
الإنجليزية فقط: يُسمح برموز لاتينية قصيرة للرتب/التصنيفات/المستويات مثل A أو S أو LV أو HP عند الحاجة.
أي لغة أخرى غير العربية: لا استثناءات إطلاقاً — كل حرف صيني/كوري/ياباني/روسي/أجنبي يجب أن يُترجم إلى العربية.
ممنوع ترك أي كلمة أو مقطع أجنبي كامل داخل السرد. ممنوع الاعتذار أو شرح ما فعلته. ممنوع إخراج JSON أو مصطلحات فقط.
أخرج الفصل المترجم كاملاً فقط.

--- GLOSSARY (Use these strictly) ---
${glossaryText}
-------------------------------------

--- PREVIOUS FAILED OUTPUT (Do not copy its foreign/meta errors) ---
${(previousTranslation || '').substring(0, 5000)}
-------------------------------------

--- SOURCE Text TO TRANSLATE (any language) ---
${sourceContent}
---------------------------------
`;
}

// 🔥 Unified provider caller supporting Gemini, OpenRouter, Cloudflare, custom APIs, DeepSeek and Qwen
async function callTranslationProvider(provider, modelName, apiKey, prompt, options = {}) {
    // Mongoose subdocuments (including Map task settings) need a plain representation.
    provider = typeof provider.toObject === 'function' ? provider.toObject({ flattenMaps: true }) : provider;
    if (isChatGPTProvider(provider) || isGeminiWebProvider(provider) || isDeepSeekWorkerProvider(provider)) {
        return callAccountProvider(provider, modelName, apiKey, prompt, options);
    }
    const providerId = (provider.providerId || 'gemini').toLowerCase();
    const isCloudflare = (providerId === 'cloudflare');
    const isDeepSeek = isDeepSeekProvider(provider);

    // ---- DeepSeek Android/Web API (same flow as the standalone DeepSeek app) ----
    if (isDeepSeek) {
        const deepSeekToken = pickDeepSeekToken(provider, options, apiKey);
        const deepSeekOptions = {
            // DeepSeek هنا هو مزوّد تطبيق المحادثة وليس واجهة API الرسمية.
            // لذلك لا نمرر مفاتيح OpenAI-compatible مثل sk-* كـ Bearer token لأنها تسبب
            // Authorization Failed، ونستخدم رمز التطبيق الافتراضي مثل التطبيق المستقل.
            token: deepSeekToken,
            thinkingEnabled: Boolean(provider.thinkingEnabled),
            searchEnabled: provider.searchEnabled !== false,
            modelType: provider.deepSeekModelType === 'expert' ? 'expert' : 'default',
            powUrl: resolveDeepSeekPowUrl(provider),
            timeout: options.timeout || 500000,
            context: getDeepSeekConversationContext(
                options.conversationContexts,
                options.conversationPurpose,
                options.conversationBatchKey,
                options.conversationScopeKey
            )
        };
        return askDeepSeek(prompt, deepSeekOptions);
    }

    // ---- Gemini native ----
    if (providerId === 'gemini' && !provider.baseUrl) {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent(prompt);
        const response = await result.response;
        return response.text();
    }

    // ---- Qwen Android API (same conversation/token behavior as DeepSeek) ----
    if (isQwenProvider(provider)) {
        return askQwen(prompt, {
            token: apiKey && !apiKey.startsWith('dummy-key-for-')
                ? apiKey
                : ((Array.isArray(provider.qwenTokens) && provider.qwenTokens[0]) || undefined),
            model: modelName || 'qwen3.8-max',
            thinkingEnabled: Boolean(provider.thinkingEnabled),
            searchEnabled: provider.searchEnabled !== false,
            timeout: options.timeout || 500000,
            context: getDeepSeekConversationContext(
                options.conversationContexts,
                options.conversationPurpose,
                options.conversationBatchKey,
                options.conversationScopeKey
            )
        });
    }

    // ---- Cloudflare Workers AI ----
    if (isCloudflare) {
        // baseUrl should be like: https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/run
        const baseUrl = provider.baseUrl || '';
        const url = `${baseUrl.replace(/\/+$/, '')}/${modelName}`;

        const headers = {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        };

        let body;
        if (isTranslationOnlyModel(modelName)) {
            // Translation model (e.g., @cf/meta/m2m100-1.2b)
            body = {
                text: prompt,
                source_lang: options.sourceLang || 'en',
                target_lang: options.targetLang || 'ar'
            };
        } else {
            // LLM model (e.g., @cf/meta/llama-3.1-8b-instruct)
            body = {
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.3
            };
        }

        const res = await axios.post(url, body, { headers, timeout: 500000 });
        const data = res.data;
        if (data.success && data.result) {
            // Translation models return translated_text, LLM models return response
            return data.result.translated_text || data.result.response || '';
        }
        throw new Error(`Cloudflare error: ${JSON.stringify(data)}`);
    }

    // ---- OpenAI-compatible (OpenRouter, custom baseUrl) ----
    const baseUrl = provider.baseUrl || 'https://openrouter.ai/api/v1';
    const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
    };
    // Add OpenRouter specific headers if needed
    if (providerId === 'openrouter') {
        headers['HTTP-Referer'] = 'https://zeus-novel.app';
        headers['X-Title'] = 'Zeus Novel Translator';
    }

    const body = {
        model: modelName,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3
    };

    const res = await axios.post(url, body, { headers, timeout: 500000 });
    const choice = res.data?.choices?.[0];
    if (choice && choice.message && choice.message.content) {
        // 🔥 FIX: a translation cut by the provider's output limit silently loses the
        // ending of the chapter. Detect it and fail so the retry loop can retranslate.
        if (choice.finish_reason === 'length') {
            throw new Error(`الترجمة مبتورة عند حد أقصى مخرجات النموذج (${providerId}/${modelName}) — سيتم إعادة المحاولة`);
        }
        return choice.message.content;
    }
    throw new Error(`Invalid response from ${providerId}: ${JSON.stringify(res.data)}`);
}

// --- THE TRANSLATION WORKER (STRICT FIRESTORE MODE) ---
async function processTranslationJob(jobId) {
    try {
        const job = await TranslationJob.findById(jobId);
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
        
        // 🔥🔥 NEW: Read providers from new system; fallback to old keys if empty
        let providers = settings.translationProviders && settings.translationProviders.length > 0
            ? settings.translationProviders.slice()
            : [];

        // Fallback: if no new providers, build one from legacy settings
        if (providers.length === 0) {
            const legacyKeys = (job.apiKeys && job.apiKeys.length > 0) ? job.apiKeys : (settings?.translatorApiKeys || []);
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
            job.logs.push({ message: 'لا توجد مزوّدات ترجمة مفعلة مع مفاتيح API.', type: 'error' });
            await job.save();
            return;
        }

        // Sort by priority ascending
        providers.sort((a, b) => (a.priority || 0) - (b.priority || 0));

        const transPrompt = settings?.customPrompt || "You are a professional translator. Translate the novel chapter into Arabic. The source may be in ANY language (English, Chinese, Korean, Japanese, Russian, etc.) — translate ALL of it into Arabic with no exceptions. Output ONLY the Arabic translation. Use the glossary provided.";
        const extractPrompt = settings?.translatorExtractPrompt || DEFAULT_EXTRACT_PROMPT;

        const chaptersToProcess = job.targetChapters.sort((a, b) => a - b);
        const conversationContexts = { chapters: new Map(), glossary: new Map(), chapter_review: new Map() };
        let stickySuccessRoute = null;

        for (const [chapterIndex, chapterNum] of chaptersToProcess.entries()) {
            const freshJob = await TranslationJob.findById(jobId);
            // 🔥 Check for pause or stop
            if (!freshJob || freshJob.status !== 'active') {
                if (freshJob && freshJob.status === 'paused') {
                    await pushLog(jobId, `⏸️ تم إيقاف المهمة مؤقتاً عند الفصل ${chapterNum}`, 'warning');
                }
                break;
            }

            const conversationBatchKey = Math.floor(chapterIndex / DEEPSEEK_CHAPTERS_PER_CONVERSATION);
            const isFirstChapterInDeepSeekBatch = chapterIndex % DEEPSEEK_CHAPTERS_PER_CONVERSATION === 0;
            if (isFirstChapterInDeepSeekBatch) {
                await pushLog(jobId, `💬 بدء 3 محادثات جديدة للفصول ${chapterIndex + 1}-${Math.min(chapterIndex + DEEPSEEK_CHAPTERS_PER_CONVERSATION, chaptersToProcess.length)} (ترجمة الفصول + المراجعة/إصلاح الكلمات + المصطلحات)`, 'info');
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
                console.log(`Firestore fetch error for Ch ${chapterNum}:`, fsErr.message);
            }

            if (!sourceContent || sourceContent.trim().length === 0) {
                 await pushLog(jobId, `تخطي الفصل ${chapterNum}: المحتوى غير موجود في السيرفر (Firestore)`, 'warning');
                 continue;
            }

            const glossaryItems = await Glossary.find({ novelId: freshNovel._id });
            const glossaryText = glossaryItems.map(g => `"${g.term}": "${g.translation}"`).join(',\n');

            // 🔥 Guardrails appended on EVERY translation regardless of the custom prompt:
            // they forbid dropping/summarizing/merging sentences (the missing-words bug).
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
            let usedProvider = null; // track which provider succeeded
            let usedKey = null; // 🔥 التوكن الذي نجحت به الترجمة (يُستخدم أولاً في استخراج المصطلحات)

            // ========== Multi-provider translation with strict validation ==========
            const RETRY_DELAY_MS = 30 * 60 * 1000;
            let attempt = 0;
            let lastValidationReasons = [];

            while (!translationSuccess) {
                attempt++;
                const freshAttemptJob = await TranslationJob.findById(jobId);
                if (!freshAttemptJob || freshAttemptJob.status !== 'active') break;

                if (attempt > 1) {
                    await pushLog(jobId, `🔄 محاولة ${attempt}: إعادة ترجمة الفصل ${chapterNum} حتى ينجح ولا يبقى نصاً أجنبياً`, 'info');
                }

                const promptForAttempt = lastValidationReasons.length > 0
                    ? buildRepairTranslationPrompt(transPrompt, glossaryText, sourceContent, translatedText, lastValidationReasons)
                    : translationInput;

                // 🔥 محاولة ترجمة كاملة (توليد + فحص + ترجمة المقاطع + مراجع) بتوكن واحد.
                // تُستخدم في حلقة التوكنات المحفوظة وفي نظام حسابات Qwen التلقائية على حد سواء.
                // النتيجة: { ok: true } عند النجاح، أو { ok: false, kind: 'review' | 'error' }.
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
                                // 🔥 يسمح لخدمة Gemini Web بإظهار ملاحظات الإكمال التلقائي في سجل المهمة
                                log: (msg, level) => pushLog(jobId, `[Gemini Web] ${msg}`, level || 'info')
                            });
                        } catch (genErr) {
                            // 🔥 قاتل حلقة "نفس الحساب": أي فشل توليد لحظياً يوسم التوكن حسب نوعه
                            // (RateLimited → 24 ساعة، مصادقة → ميت، خطأ غير مصنّف → موسم 30 دقيقة
                            // شبكة أمان، شبكة عابرة → بلا وسم) بحيث لا يُعاد استخدام الحساب الفاشل أبداً
                            // في الجولة التالية، ويُنشأ حساب جديد بدلاً منه.
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
                        usedProvider = prov;
                        usedKey = key;
                        stickySuccessRoute = { providerIndex: providers.indexOf(prov), keyIdx, key };
                        await pushLog(jobId, `✅ نجحت الترجمة والمراجعة باستخدام ${provName} (سيُكمل النظام من هذا المزود/التوكن في الفصل التالي)`, 'success');
                        return { ok: true, kind: null };
                    } catch (err) {
                        console.error(`❌ فشل ${provName} مفتاح ${keyIdx + 1}: ${err.message}`);
                        await pushLog(jobId, `❌ فشل: ${err.message}`, 'warning');

                        // 🔥 Qwen: وسوم صامتة لأخطاء المراجعة اللاحقة (التوليد وُسم أصلاً في catch الداخلي أعلاه
                        // مع السجل الكامل؛ هنا نغطي أخطاء المراجعة/المقاطع المصنّفة فقط دون رسائل مكرّرة)
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
                    // 🔥🔥 وضع الضيف (طلب المستخدم): مزوّد Gemini Web يعمل حتى بدون أي كوكيز —
                    // وصول مجهول إلى gemini.google.com مع تنبيه واضح في سجل المهمة عند الدخول لوضع الضيف
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

                    // 🔥🔥🔥 Qwen AUTO-ACCOUNT (Qwen فقط — نفس طريقة qwen.py) 🔥🔥🔥
                    // لا نعتمد فقط على المفاتيح المحفوظة: تُستبعد التوكنات المستهلكة/الميتة،
                    // وإن لم يبقَ أي توكن صالح يُنشأ حساب Qwen جديد تلقائياً
                    // (بريد مؤقت → تسجيل → تفعيل → توكن) وتُكمل الترجمة عليه فوراً.
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

                    // 🔥🔥🔥 Qwen AUTO-ACCOUNT: فشلت كل التوكنات → إنشاء حساب جديد فوراً ومتابعة على Qwen فقط 🔥🔥🔥
                    // "مهما فشل يستطيع عمل حساب جديد وتكملة الترجمة" — جولتان لكل محاولة (مرتين كما طلب المستخدم).
                    // لا يتوقف ولا ينتقل لمزوّد آخر: إن فشل الإنشاء أيضاً تُعاد المحاولة على نفس الفصل لاحقاً.
                    if (!translationSuccess && isQwen && lastFailureKind === 'error') {
                        const AUTO_ROUNDS = 2;
                        for (let round = 1; round <= AUTO_ROUNDS && !translationSuccess; round++) {
                            await pushLog(jobId, `🤖 مزوّد Qwen: فشلت جميع التوكنات (${keys.length}) — إنشاء حساب Qwen جديد كلياً (جولة ${round}/${AUTO_ROUNDS}) ومتابعة الترجمة على Qwen فقط`, 'info');
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
                        // على نفس الفصل (مع إنشاء حسابات Qwen جديدة عند الحاجة) حتى تنجح الترجمة.
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

            // 🔥🔥🔥 NEW: EXTRACT TITLE FROM TRANSLATED CONTENT 🔥🔥🔥
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
                console.log("Title extraction error:", titleErr);
            }
            // 🔥🔥🔥 END TITLE EXTRACTION 🔥🔥🔥

            try {
                // 🔥 GLOSSARY EXTRACTION — STRICTLY on the provider that succeeded in
                // translating this chapter. Old logic treated "0 terms found" as a
                // FAILURE and fell back to OTHER providers (e.g. DeepSeek), so with a
                // successful Qwen translation the glossary still ran on a different
                // provider. "0 new terms" is a SUCCESS (nothing new to learn), not a
                // failure — only a thrown error (network/auth) may fall back.
                let extractionDone = false;

                // Helper: persist extracted terms into the glossary collection
                const saveExtractedTerms = async (terms) => {
                    let newTermsCount = 0;
                    for (const termObj of terms) {
                        const rawTerm = termObj.name || termObj.term;
                        const translation = termObj.translation;
                        if (rawTerm && translation) {
                            let category = termObj.category ? termObj.category.toLowerCase() : 'other';
                            if (category === 'character') category = 'characters';
                            else if (category === 'location') category = 'locations';
                            else if (category === 'item') category = 'items';
                            else if (category === 'rank') category = 'ranks';
                            else if (category === 'concept') category = 'other';
                            if (!['characters', 'locations', 'items', 'ranks'].includes(category)) category = 'other';
                            await Glossary.updateOne(
                                { novelId: freshNovel._id, term: rawTerm },
                                {
                                    $set: { translation: translation, category: category, description: termObj.description || '' },
                                    $setOnInsert: { autoGenerated: true }
                                },
                                { upsert: true }
                            );
                            newTermsCount++;
                        }
                    }
                    return newTermsCount;
                };

                // Helper function to try extraction with a specific provider + model
                const tryExtraction = async (extProvider, extModelId, extKey) => {
                    const extractionInput = `
${extractPrompt}

English/Source Text (Excerpt):
"""${sourceContent.substring(0, 8000)}"""

Arabic Text (Excerpt):
"""${translatedText.substring(0, 8000)}"""
`;
                    let jsonText;
                    const extId = String(extProvider.providerId || '').toLowerCase();
                    if (extId === 'gemini' && !extProvider.baseUrl) {
                        // Gemini native with JSON mode
                        const genAI = new GoogleGenerativeAI(extKey);
                        const modelJSON = genAI.getGenerativeModel({ model: extModelId });
                        modelJSON.generationConfig = { responseMimeType: "application/json" };
                        const resultExt = await modelJSON.generateContent(extractionInput);
                        const responseExt = await resultExt.response;
                        jsonText = responseExt.text().trim();
                    } else {
                        // OpenAI-compatible / Cloudflare LLM / DeepSeek / Qwen (through their own callers)
                        const extPrompt = extractionInput + "\n\nRETURN ONLY JSON.";
                        jsonText = await callTranslationProvider(extProvider, extModelId, extKey, extPrompt, {
                            deepSeekJobId: jobId.toString(),
                            conversationContexts,
                            conversationPurpose: 'glossary',
                            conversationBatchKey,
                            conversationScopeKey: getTokenConversationScope(extProvider, extKey, 0)
                        });
                    }

                    // Cleanup JSON string - ROBUST VERSION
jsonText = jsonText.trim();

// Remove markdown code blocks (with or without backticks)
if (jsonText.startsWith("```json")) {
    jsonText = jsonText.replace(/^```json\s*/, "").replace(/\s*```$/, "");
} else if (jsonText.startsWith("```")) {
    jsonText = jsonText.replace(/^```\s*/, "").replace(/\s*```$/, "");
}

// 🔥 FIX: DeepSeek يُرجع "json\n[...]" بدون backticks
if (/^json\s*[\n\r]/i.test(jsonText)) {
    jsonText = jsonText.replace(/^json\s*[\n\r]+/i, "");
}

// 🔥 الأقوى: استخرج أول [ ] أو { } مباشرة
const jsonMatch = jsonText.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
if (jsonMatch) {
    jsonText = jsonMatch[1];
}


                    let parsedTerms = [];
                    try {
                        const parsed = JSON.parse(jsonText);
                        if (Array.isArray(parsed)) {
                            parsedTerms = parsed;
                        } else if (parsed.newTerms && Array.isArray(parsed.newTerms)) {
                            parsedTerms = parsed.newTerms;
                        } else if (parsed.terms && Array.isArray(parsed.terms)) {
                            parsedTerms = parsed.terms;
                        }
                    } catch (e) {
                        console.log("JSON Parse Error", e);
                    }

                    return parsedTerms;
                };

                const extractionKeysFor = (provider) => {
                    const keys = getProviderAuthKeys(provider);
                    if (keys.length === 0) {
                        if (isDeepSeekProvider(provider)) return ['dummy-key-for-deepseek'];
                        if (isQwenProvider(provider)) return ['dummy-key-for-qwen'];
                    }
                    return keys;
                };

                // ---- STEP 1: Use the SAME provider + model + key that translated successfully ----
                if (usedProvider) {
                    const extProviderName = usedProvider.name || usedProvider.providerId;
                    const extModel = isTranslationOnlyModel(usedProvider.selectedModel)
                        ? (findLLMModel(usedProvider)?.modelId || usedProvider.selectedModel)
                        : usedProvider.selectedModel;
                    await pushLog(jobId, `2️⃣ استخراج المصطلحات بنفس مزوّد الترجمة الناجح: ${extProviderName} | نموذج: ${extModel}`, 'info');

                    const keys = extractionKeysFor(usedProvider);
                    // 🔥 ضع التوكن الذي نجحت به الترجمة أولاً (خاصة توكن حساب Qwen التلقائي)
                    if (usedKey) {
                        const ki = keys.indexOf(usedKey);
                        if (ki > 0) keys.unshift(keys.splice(ki, 1)[0]);
                    }
                    for (const key of keys) {
                        try {
                            const terms = await tryExtraction(usedProvider, extModel, key);
                            // SUCCESS regardless of count: 0 terms = nothing new to learn.
                            const newTermsCount = await saveExtractedTerms(terms);
                            if (newTermsCount > 0) await pushLog(jobId, `✅ تم إضافة/تحديث ${newTermsCount} مصطلح للمسرد (${extProviderName})`, 'success');
                            else await pushLog(jobId, `ℹ️ لم يتم استخراج مصطلحات جديدة (${extProviderName})`, 'info');
                            extractionDone = true;
                            break;
                        } catch (extErr) {
                            console.error("Extraction error with same provider:", extErr.message);
                            await pushLog(jobId, `⚠️ فشل استخراج المصطلحات عبر ${extProviderName}: ${extErr.message}`, 'warning');
                        }
                    }
                }

                // ---- STEP 2: Fallback – any provider with an LLM (only if the successful provider errored) ----
                if (!extractionDone) {
                    await pushLog(jobId, `↪️ تعذر الاستخراج من مزوّد الترجمة الناجح — تجربة بقية المزوّدين احتياطاً`, 'warning');
                    const orderedProviders = stickySuccessRoute
                    ? [...providers.slice(stickySuccessRoute.providerIndex), ...providers.slice(0, stickySuccessRoute.providerIndex)]
                    : providers;

                for (const provider of orderedProviders) {
                        if (extractionDone) break;
                        const llmModel = findLLMModel(provider);
                        if (!llmModel) continue;
                        const providerName = provider.name || provider.providerId;
                        const keys = extractionKeysFor(provider);
                        for (const key of keys) {
                            try {
                                const terms = await tryExtraction(provider, llmModel.modelId, key);
                                const newTermsCount = await saveExtractedTerms(terms);
                                if (newTermsCount > 0) await pushLog(jobId, `✅ تم إضافة/تحديث ${newTermsCount} مصطلح للمسرد (${providerName} — احتياطي)`, 'success');
                                else await pushLog(jobId, `ℹ️ لم يتم استخراج مصطلحات جديدة (${providerName} — احتياطي)`, 'info');
                                extractionDone = true;
                                break;
                            } catch (extErr) {
                                console.error("Extraction error fallback:", extErr.message);
                            }
                        }
                    }
                }

                if (!extractionDone) {
                    await pushLog(jobId, `⚠️ فشل استخراج المصطلحات لهذا الفصل`, 'warning');
                }

                try {
                    await firestore.collection('novels').doc(freshNovel._id.toString())
                        .collection('chapters').doc(chapterNum.toString())
                        .set({
                            title: extractedTitle,
                            content: translatedText,
                            lastUpdated: new Date()
                        }, { merge: true });
                    // 🔥 مزامنة المرآة (الترجمة الجديدة تصير متاحة حتى مع نفاد الحصة)
                    chapterMirror.upsertMirror(freshNovel._id.toString(), chapterNum, translatedText);
                    
                } catch (fsSaveErr) {
                    throw new Error(`فشل الحفظ في Firestore: ${fsSaveErr.message}`);
                }

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

                await TranslationJob.findByIdAndUpdate(jobId, {
                    $inc: { translatedCount: 1 },
                    $set: { currentChapter: chapterNum, lastUpdate: new Date() },
                    $pull: { targetChapters: chapterNum }
                });

                await pushLog(jobId, `🎉 تم إنجاز الفصل ${chapterNum} بعنوان "${extractedTitle}" وحفظه في السيرفر`, 'success');

            } catch (err) {
                console.error("Extraction/Save Error:", err);
                
                if (translatedText) {
                    try {
                        await firestore.collection('novels').doc(freshNovel._id.toString())
                            .collection('chapters').doc(chapterNum.toString())
                            .set({ content: translatedText }, { merge: true });
                        // 🔥 مزامنة المرآة
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
                            }
                        }

                        await TranslationJob.findByIdAndUpdate(jobId, {
                            $pull: { targetChapters: chapterNum }
                        });

                        await pushLog(jobId, `⚠️ تم حفظ الترجمة (فشل الاستخراج): ${err.message}`, 'warning');
                    } catch (saveErr) {
                        await pushLog(jobId, `❌ فشل الحفظ النهائي: ${saveErr.message}`, 'error');
                    }
                } else {
                    await pushLog(jobId, `❌ فشل العملية: ${err.message}`, 'error');
                }
            }

            await delay(2000); 
        }

        // Final check
        const finalJob = await TranslationJob.findById(jobId);
        if (finalJob.status === 'active') {
            await TranslationJob.findByIdAndUpdate(jobId, { status: 'completed' });
            await pushLog(jobId, `🏁 اكتملت جميع الفصول!`, 'success');
        }

    } catch (e) {
        console.error("Worker Critical Error:", e);
        await TranslationJob.findByIdAndUpdate(jobId, { status: 'failed' });
    }
}

async function pushLog(jobId, message, type) {
    const prefix = type ? `[translator:${type}]` : '[translator]';
    console.log(`${new Date().toISOString()} ${prefix} job=${jobId} ${message}`);
    await TranslationJob.findByIdAndUpdate(jobId, {
        $push: { logs: { message, type, timestamp: new Date() } }
    });
}


    function normalizeProviderForStorage(p) {
        const id = String(p.providerId || `provider_${Date.now()}`);
        const apiKeys = Array.isArray(p.apiKeys)
            ? p.apiKeys.map(k => String(k || '').trim()).filter(Boolean)
            : [];
        const models = Array.isArray(p.models)
            ? p.models
                .map(m => ({ modelId: String(m.modelId || '').trim(), modelName: String(m.modelName || m.modelId || '').trim() }))
                .filter(m => m.modelId)
            : [];
        const isDeepSeek = id === 'deepseek' || id.startsWith('deepseek_');
        const isQwen = id === 'qwen' || id.startsWith('qwen_');
        const normalized = {
            providerId: id,
            name: String(p.name || 'مزوّد').trim() || 'مزوّد',
            baseUrl: String(p.baseUrl || '').trim(),
            models,
            apiKeys,
            selectedModel: String(p.selectedModel || (models[0]?.modelId) || '').trim(),
            priority: Number.isFinite(+p.priority) ? +p.priority : 0,
            thinkingEnabled: !!p.thinkingEnabled,
            searchEnabled: p.searchEnabled !== false,
            deepSeekModelType: p.deepSeekModelType === 'expert' ? 'expert' : 'default',
            deepSeekTokens: [],
            qwenTokens: [],
            powProviders: [],
            selectedPowProviderId: ''
        };
        if (isDeepSeek) {
            const tokens = Array.isArray(p.deepSeekTokens) ? p.deepSeekTokens.map(t => String(t || '').trim()).filter(Boolean) : [];
            normalized.deepSeekTokens = Array.from(new Set([...apiKeys, ...tokens]));
            normalized.powProviders = Array.isArray(p.powProviders) && p.powProviders.length
                ? p.powProviders.filter(pw => pw && pw.url).map(pw => ({ id: String(pw.id || 'pow'), name: String(pw.name || 'POW'), url: String(pw.url) }))
                : DEFAULT_DEEPSEEK_POW_PROVIDERS;
            normalized.selectedPowProviderId = String(p.selectedPowProviderId || '3mh');
        } else if (isQwen) {
            const tokens = Array.isArray(p.qwenTokens) ? p.qwenTokens.map(t => String(t || '').trim()).filter(Boolean) : [];
            normalized.qwenTokens = Array.from(new Set([...apiKeys, ...tokens]));
        }
        return { ...normalized, ...normalizeAccountSettings(p) };
    }

module.exports = function(app, verifyToken, verifyAdmin) {

    mongoose.connection.once('open', async () => {
        try {
            const collection = mongoose.connection.db.collection('glossaries');
            const indexes = await collection.indexes();
            if (indexes.some(idx => idx.name === 'user_1_key_1')) {
                await collection.dropIndex('user_1_key_1');
                console.log('✅ Deleted old conflicting index: user_1_key_1');
            }
        } catch (err) {
            console.log('ℹ️ No old indexes to delete or already cleaned.');
        }
    });

    // 1. Get Novels (🔥 OPTIMIZED FOR LAZY LOADING & PERFORMANCE 🔥)
    app.get('/api/translator/novels', verifyToken, async (req, res) => {
        try {
            const { search, page = 1, limit = 20 } = req.query;
            const pageNum = parseInt(page);
            const limitNum = parseInt(limit);
            const skip = (pageNum - 1) * limitNum;

            let query = {};
            if (search) {
                query.title = { $regex: search, $options: 'i' };
            }
            
            const novels = await Novel.aggregate([
                { $match: query },
                {
                    $project: {
                        _id: 1,
                        title: 1,
                        cover: 1,
                        author: 1,
                        status: 1,
                        createdAt: 1,
                        chaptersCount: {
                            $ifNull: [
                                "$sourceChaptersCount",
                                { $size: { $ifNull: ["$chapters", []] } }
                            ]
                        }
                    }
                },
                { $sort: { createdAt: -1 } },
                { $skip: skip },
                { $limit: limitNum }
            ]);
            
            res.json(novels);
        } catch (e) {
            console.error("Translator Novels Error:", e);
            res.status(500).json({ error: e.message });
        }
    });

    // 2. Start Job
    app.post('/api/translator/start', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const { novelId, chapters, apiKeys, resumeFrom, jobId } = req.body; 
            
            if (jobId) {
                const existingJob = await TranslationJob.findById(jobId);
                if (!existingJob) return res.status(404).json({ message: "Job not found" });
                
                existingJob.status = 'active';
                existingJob.logs.push({ message: '▶️ تم استئناف المهمة', type: 'info' });
                await existingJob.save();
                
                processTranslationJob(existingJob._id);
                return res.json({ message: "Job resumed", jobId: existingJob._id });
            }

            const novel = await Novel.findById(novelId);
            if (!novel) return res.status(404).json({ message: "Novel not found" });

            const userSettings = await getGlobalSettings();
            
            // 🔥 CHECK providers instead of legacy keys
            const providers = userSettings?.translationProviders || [];
            // 🔥 مزوّد Gemini Web يُقبل حتى بلا مفاتيح (وضع الضيف بدون كوكيز)
            const anyKeys = providers.some(p => (p.apiKeys && p.apiKeys.length > 0) || isDeepSeekProvider(p) || isQwenProvider(p) || (isGeminiWebProvider(p) && p.allowGuestFallback));
            const legacyKeys = userSettings?.translatorApiKeys || [];
            
            if (!anyKeys && legacyKeys.length === 0) {
                return res.status(400).json({ message: "No API keys found. Please add keys in Settings first." });
            }

            let targetChapters = [];
            
            if (resumeFrom) {
                targetChapters = novel.chapters
                    .filter(c => c.number >= resumeFrom)
                    .map(c => c.number);
            } else if (chapters === 'all') {
                const mongoChapters = novel.chapters.map(c => c.number);
                
                let firestoreChapters = [];
                if (firestore) {
                    try {
                        const chaptersRef = firestore.collection('novels').doc(novelId.toString()).collection('chapters');
                        const snapshot = await chaptersRef.get();
                        firestoreChapters = snapshot.docs.map(doc => parseInt(doc.id)).filter(num => !isNaN(num));
                    } catch (err) {
                        console.error("Failed to fetch chapters from Firestore:", err);
                    }
                }
                
                const allChaptersSet = new Set([...mongoChapters, ...firestoreChapters]);
                targetChapters = Array.from(allChaptersSet).sort((a, b) => a - b);
                
                if (novel.sourceChaptersCount && novel.sourceChaptersCount > targetChapters.length) {
                    for (let i = 1; i <= novel.sourceChaptersCount; i++) {
                        allChaptersSet.add(i);
                    }
                    targetChapters = Array.from(allChaptersSet).sort((a, b) => a - b);
                }
            } else if (Array.isArray(chapters)) {
                targetChapters = chapters;
            }

            const job = new TranslationJob({
                novelId,
                novelTitle: novel.title,
                cover: novel.cover,
                targetChapters,
                totalToTranslate: targetChapters.length,
                apiKeys: legacyKeys, // keep for backward compatibility, but actual translation will use providers
                logs: [{ message: `تم بدء المهمة (استهداف ${targetChapters.length} فصل)`, type: 'info' }]
            });

            await job.save();

            processTranslationJob(job._id);

            res.json({ message: "Job started", jobId: job._id });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 🔥 Pause Job
    app.post('/api/translator/jobs/:id/pause', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const job = await TranslationJob.findById(req.params.id);
            if (!job) return res.status(404).json({ message: "Job not found" });
            
            job.status = 'paused';
            job.logs.push({ message: '⏸️ طلب إيقاف مؤقت من المستخدم...', type: 'warning' });
            await job.save();
            
            res.json({ message: "Job paused" });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 🔥 Delete Job
    app.delete('/api/translator/jobs/:id', verifyToken, verifyAdmin, async (req, res) => {
        try {
            await TranslationJob.findByIdAndDelete(req.params.id);
            res.json({ message: "Job deleted" });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 3. Get Jobs List (🔥 OPTIMIZED: Exclude logs and apiKeys)
    app.get('/api/translator/jobs', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const jobs = await TranslationJob.find()
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

    // 4. Get Job Details
    app.get('/api/translator/jobs/:id', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const job = await TranslationJob.findById(req.params.id);
            if (!job) return res.status(404).json({message: "Job not found"});

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

    // 5. Manage Glossary
    app.get('/api/translator/glossary/:novelId', verifyToken, async (req, res) => {
        try {
            const terms = await Glossary.find({ novelId: req.params.novelId });
            res.json(terms);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/translator/glossary', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const { novelId, term, translation, category, description } = req.body; 
            
            const finalCategory = category && ['characters', 'locations', 'items', 'ranks', 'other'].includes(category) 
                                  ? category 
                                  : 'other';

            const newTerm = await Glossary.findOneAndUpdate(
                { novelId, term },
                { 
                    translation, 
                    category: finalCategory,
                    description: description || '',
                    autoGenerated: false 
                },
                { new: true, upsert: true }
            );
            res.json(newTerm);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.delete('/api/translator/glossary/:id', verifyToken, verifyAdmin, async (req, res) => {
        try {
            await Glossary.findByIdAndDelete(req.params.id);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    
    app.post('/api/translator/glossary/bulk-delete', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const { ids } = req.body;
            await Glossary.deleteMany({ _id: { $in: ids } });
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 6. Translator Settings API (GLOBAL) – updated to include providers
    app.get('/api/translator/settings', verifyToken, verifyAdmin, async (req, res) => {
        try {
            let settings = await getGlobalSettings();
            res.json({
                customPrompt: settings.customPrompt || '',
                translatorExtractPrompt: settings.translatorExtractPrompt || DEFAULT_EXTRACT_PROMPT,
                translatorModel: settings.translatorModel || 'gemini-2.5-flash',
                translatorApiKeys: settings.translatorApiKeys || [],
                translationProviders: settings.translationProviders || [] // 🔥 NEW
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 🔥 Server-side provider normalization — guarantees keys are never dropped or
    // hijacked by a wrong engine. Rules:
    //   - deepseek_*  → tokens live in deepSeekTokens (synced with apiKeys)
    //   - qwen_*      → tokens live in qwenTokens (synced with apiKeys)
    //   - everything else (gemini/openrouter/cloudflare/custom) → apiKeys ONLY,
    //     all chat-app token fields are cleared so a custom provider with a
    //     gpt/qwen/deepseek model can never be misrouted again.

    app.post('/api/translator/settings', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const { customPrompt, translatorExtractPrompt, translatorModel, translatorApiKeys, translationProviders } = req.body;

            let settings = await getGlobalSettings();

            if (customPrompt !== undefined) settings.customPrompt = customPrompt;
            if (translatorExtractPrompt !== undefined) settings.translatorExtractPrompt = translatorExtractPrompt;
            if (translatorModel !== undefined) settings.translatorModel = translatorModel;
            if (translatorApiKeys !== undefined) settings.translatorApiKeys = translatorApiKeys;
            if (translationProviders !== undefined) {
                settings.translationProviders = translationProviders.map(normalizeProviderForStorage); // 🔥 normalized server-side
            }

            await settings.save();
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 🔥 Fetch available models from a custom OpenAI-compatible base URL
    // (GET {baseUrl}/models) — lets the user pick a model instead of typing it.
    app.post('/api/translator/providers/models', verifyToken, verifyAdmin, async (req, res) => {
        try {
            const { baseUrl, apiKey } = req.body;
            let base = String(baseUrl || '').trim();
            if (!base) return res.status(400).json({ error: 'Base URL مطلوب' });
            // tolerate pasting the full chat/completions endpoint
            base = base.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
            const headers = { 'Content-Type': 'application/json' };
            if (apiKey) headers['Authorization'] = `Bearer ${String(apiKey).trim()}`;

            const response = await axios.get(`${base}/models`, { headers, timeout: 20000 });
            const raw = response.data?.data || response.data?.models || response.data;
            if (!Array.isArray(raw)) {
                return res.status(502).json({ error: `استجابة غير متوقعة من المزوّد: ${JSON.stringify(response.data).substring(0, 200)}` });
            }
            const models = raw
                .map(m => {
                    const id = typeof m === 'string' ? m : (m.id || m.model || m.name || '');
                    return { modelId: String(id).trim(), modelName: String(id).trim() };
                })
                .filter(m => m.modelId)
                .sort((a, b) => a.modelId.localeCompare(b.modelId));
            res.json({ models, baseUrl: base });
        } catch (e) {
            const status = e.response?.status;
            const detail = status ? `HTTP ${status}` : e.message;
            res.status(502).json({ error: `فشل جلب النماذج: ${detail}` });
        }
    });
};

// 🔥 تصدير داخلي: أدوات مزوّدات الذكاء الاصطناعي لإعادة استخدامها في نظام المراجعة
// (reviewRoutes) — نفس المزوّدات ونفس المفاتيح المضبوطة في إعدادات المترجم.
// 🔥 إضافة خالصة (لا تمس أي منطق قائم): أدوات الترجمة/التحقق/الإصلاح تُصدَّر أيضاً
// ليستخدمها المترجم الخالص (pureTranslatorRoutes — ترجمة فقط بلا استخراج مصطلحات)
// بنفس خط الترجمة المؤكد حرفياً (فحص البقايا + مراجع + إصلاح + حسابات Qwen تلقائية).
module.exports._ai = {
    normalizeProviderForStorage,
    isChatGPTProvider,
    isDeepSeekWorkerProvider,
    callTranslationProvider,
    getGlobalSettings,
    getProviderAuthKeys,
    isDeepSeekProvider,
    isQwenProvider,
    isGeminiWebProvider,
    GUEST_TOKEN_SENTINEL,
    // أدوات إضافية للمترجم الخالص (إعادة كشف فقط — نفس الدوال المستخدمة هنا):
    isStickyChatProvider,
    validateTranslatedChapter,
    translateResiduesOnly,
    reviewQuestionableChapter,
    buildRepairTranslationPrompt,
    removeDeepSeekFinishedMarker,
    resetConversationContextPurposeForScope,
    getTokenConversationScope,
    isTranslationOnlyModel,
    findLLMModel,
    DEEPSEEK_CHAPTERS_PER_CONVERSATION,
    DEEPSEEK_MAX_ATTEMPTS_PER_TOKEN,
};
