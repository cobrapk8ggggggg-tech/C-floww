# C — ChatZeus account providers

نسخة من [C-app-new](https://github.com/zeus82256-lang/C-app-new) عند الإصدار `b47e7bd2721040dd46b30d13f65335fef72acf7d`، مع دمج بروتوكولي ChatGPT Android وGemini من ملفّي Python المرفقين، ودعم [DeepSeek 3MH / Telegram](https://deepseek-pow.contact-3mh.workers.dev/).

- [الإعداد والاستخدام وحدود الدعم](docs/providers.md)
- [تحليل بنية المستودع والملاحظات](docs/source-analysis.md)
- [جرد جميع الملفات الأصلية مع بصماتها واعتمادياتها ومسارات HTTP](docs/source-inventory.json)
- [الاختبارات ونتيجة التجربة الحية](docs/testing.md)
- [نتيجة Gemini الحية](docs/gemini-live-result.json) · [الفصل المترجم](docs/alice-chapter-1-ar.gemini.txt)

التشغيل المحلي:

```sh
cd backend
npm ci
cp .env.example .env
# Configure MongoDB, Firebase and JWT_SECRET privately.
npm start
```

وفي نافذة أخرى:

```sh
cd web
npm ci
# Set EXPO_PUBLIC_API_URL to your backend URL.
npm start
```

من لوحة الإدارة ← إعدادات المترجم، أضف المزوّد ثم أدخل بيانات الحساب. لكل مهمة يمكنك اختيار مشروع ChatGPT ومحادثة مستقلة، أو إنشاء محادثة في المشروع، أو اختيار محادثة جديدة لكل طلب/لكل مهمة تشغيل. احفظ الإعدادات بعد الاختيار.

لم تُضمّن كوكيز الحساب المرفقة أو رموز الجلسات في الملفات المنشورة.
