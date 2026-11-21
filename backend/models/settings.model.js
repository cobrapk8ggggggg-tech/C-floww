const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
    // 🔥 جعلنا المستخدم غير إجباري لكي تكون الإعدادات عامة للنظام
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, 
    
    provider: { type: String, default: 'gemini' },
    model: { type: String, default: 'gemini-1.5-flash' },
    temperature: { type: Number, default: 0.7 },
    geminiApiKeys: [{ key: String, status: String }],
    openrouterApiKeys: [{ key: String, status: String }],
    customProviders: [{
        id: String,
        name: String,
        baseUrl: String,
        models: [{ id: String, name: String }],
        apiKeys: [{ key: String, status: String }]
    }],
    customPrompt: { type: String, default: '' },
    
    // 🔥 Translator Specific Settings
    translatorModel: { type: String, default: 'gemini-2.5-flash' }, 
    // 🔥 UPDATED PROMPT HERE
    translatorExtractPrompt: { type: String, default: `ROLE: Expert Web Novel Terminology Extractor.
TASK: Analyze the "English Text" and "Arabic Translation" below. Extract key proper nouns, unique concepts, and specific terminology for a comprehensive Glossary (Codex).

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
    *   "name": The exact English name (Capitalized where appropriate).
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
    *   Each extracted English term must be unique.
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

RETURN ONLY JSON:` },
    translatorApiKeys: [{ type: String }], // Global Keys for Translator

    // 🔥 ScraperAPI keys for the novel scraper service (multi-key rotation)
    scraperApiKeys: [{ type: String }],

    // 🍪 كوكيز TomatoMTL (حساب قارئ tomatomtl.com) — حقل واجهة السكرابر.
    // فارغ = السكرابر يستخدم الكوكيز الثابتة بداخله (remember_* طويل الأمد).
    tomatomtlCookies: { type: String, default: '' },

    // 🍪 كوكيز WTR-LAB (حساب قارئ wtr-lab.com) — حقل واجهة السكرابر.
    // البيانات والفهرس تعمل بلا جلسة؛ محتوى الفصول يحتاج جلسة (Turnstile) —
    // فارغ = سحب مجهول (البيانات والفهرس فقط).
    wtrlabCookies: { type: String, default: '' },

    // 🔥 Multi-provider translation support (DeepSeek / Qwen / Gemini / OpenRouter / Cloudflare / custom)
    translationProviders: [{
        providerId: { type: String, required: true }, // e.g., 'gemini', 'openrouter', 'deepseek_...', 'qwen_...', 'custom1'
        name: { type: String, required: true }, // display name
        baseUrl: { type: String, default: '' }, // endpoint for custom/openrouter
        models: [{
            modelId: { type: String, required: true },
            modelName: { type: String, required: true }
        }],
        apiKeys: [{ type: String }], // API keys for this provider (single source of truth for non-app providers)
        selectedModel: { type: String }, // the currently active model for this provider
        priority: { type: Number, default: 0 }, // order in fallback sequence
        thinkingEnabled: { type: Boolean, default: false }, // DeepSeek: enable reasoning fragments
        searchEnabled: { type: Boolean, default: true }, // DeepSeek: enable web search
        deepSeekModelType: { type: String, enum: ['default', 'expert'], default: 'default' }, // DeepSeek: Default or Expert mode
        deepSeekTokens: [{ type: String }], // DeepSeek account tokens; falls back to default app token when empty
        qwenTokens: [{ type: String }], // Qwen account tokens; handled like DeepSeek tokens
        powProviders: [{
            id: { type: String, required: true },
            name: { type: String, required: true },
            url: { type: String, required: true }
        }], // DeepSeek POW service providers
        selectedPowProviderId: { type: String },
        chatgptAccountId: { type: String, default: '' },
        reasoningEffort: { type: String, default: 'auto' },
        geminiAccountIndex: { type: Number, default: 1 },
        geminiBuildLabel: { type: String, default: '' },
        geminiModelHeader: { type: String, default: '' },
        allowGuestFallback: { type: Boolean, default: false },
        temperature: { type: Number, default: 0.7 },
        maxTokens: { type: Number, default: 16384 },
        presencePenalty: { type: Number, default: 0 },
        frequencyPenalty: { type: Number, default: 0 },
        geminiParagraphMode: { type: Boolean, default: true },
        translationChunkChars: { type: Number, default: 2400 },
        taskConversations: { type: Map, of: new mongoose.Schema({
            mode: { type: String, enum: ['new', 'reuse', 'per_job'], default: 'per_job' },
            projectId: String, conversationId: String, responseId: String, choiceId: String,
            parentMessageId: String, model: String, reasoningEffort: String
        }, { _id: false }), default: {} }
    }],

    // 🔥 Qwen auto-created accounts (نظام إنشاء حسابات تلقائي من qwen.py):
    // عند فشل كل توكنات مزوّد Qwen أو عدم وجود مفتاح، يُنشأ حساب جديد
    // (بريد مؤقت → تسجيل → تفعيل → توكن) ويُخزَّن هنا بشكل دائم + يُضاف
    // توكنه إلى qwenTokens لمزوّد Qwen تلقائياً.
    qwenAutoAccounts: [{
        email: { type: String },
        password: { type: String },
        token: { type: String },
        providerId: { type: String, default: '' }, // 🔥 مالك الحساب: مزوّد Qwen الذي أُنشئ له — لا يُشارك مع مزوّدين آخرين
        createdAt: { type: Date, default: Date.now },
        rateLimitedUntil: { type: Date, default: null }, // موسم لمدة 24 ساعة عند RateLimited
        dead: { type: Boolean, default: false } // توكن مصداقيته فاشلة نهائياً
    }],

    // 🔥 Title Generator Specific Settings
    titleGenModel: { type: String, default: 'gemini-2.5-flash' },
    titleGenPrompt: { type: String, default: 'Read the following chapter content and suggest a short, engaging, and professional Arabic title for it (Maximum 6 words). Output ONLY the Arabic title string without any quotes, prefixes, or chapter numbers.' },
    titleGenApiKeys: [{ type: String }], 

    // 🔥 Categories Management (Master List)
    managedCategories: [{ type: String }],
    
    // 🔥 Category Normalization Rules (Dynamic)
    categoryNormalizationRules: [{ 
        original: { type: String, required: true }, 
        target: { type: String, required: true } 
    }],

    fontSize: { type: Number, default: 18 },
    globalBlocklist: [{ type: String }],

    // 🔥 Global Replacements (Server-Side)
    globalReplacements: [{ 
        original: { type: String, required: true }, 
        replacement: { type: String, default: '' } 
    }],

    // 🔥 Global App Rights (Copyrights) with Styling
    globalChapterStartText: { type: String, default: '' },
    globalChapterEndText: { type: String, default: '' },
    
    // 🔥 New: Chapter Separator Configuration
    chapterSeparatorText: { type: String, default: '________________________________________' },
    enableChapterSeparator: { type: Boolean, default: true },
    
    globalCopyrightStyles: {
        color: { type: String, default: '#888888' },
        opacity: { type: Number, default: 1 },
        alignment: { type: String, enum: ['left', 'center', 'right'], default: 'center' },
        isBold: { type: Boolean, default: true },
        fontSize: { type: Number, default: 14 } 
    },

    // 🔥 Frequency Control for Copyrights
    copyrightFrequency: { type: String, enum: ['always', 'random', 'every_x'], default: 'always' },
    copyrightEveryX: { type: Number, default: 5 } 

}, { timestamps: true });

const Settings = mongoose.model('Settings', settingsSchema);

module.exports = Settings;