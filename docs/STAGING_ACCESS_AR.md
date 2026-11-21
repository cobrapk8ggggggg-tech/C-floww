# تشغيل نسخة الاختبار المنشورة — 1 نوفمبر 2026

هذه مشاريع مستقلة عن الموقع والخادم والسكرابر الأصليين. نُشر الفرع التجريبي إلى عنوان كل مشروع اختبار الثابت؛ كلمة production في هدف Vercel لهذه المشاريع تعني عنوان **مشروع الاختبار** فقط.

| الخدمة | الرابط | المراجعة المنشورة أولًا |
|---|---|---|
| الواجهة | https://zeus-web-staging.vercel.app | 731ef95 |
| الخادم | https://zeus-cfloww-staging.vercel.app | 680f958؛ يتبعه تصحيح تهيئة المشرف في الفرع نفسه |
| السكرابر | https://zeus-scraper-staging.vercel.app | 304e8f0 |

الواجهة مبنية مع VITE_DURABLE_JOBS=true وVITE_API_URL للخادم التجريبي. الخادم مربوط بالسكرابر التجريبي والعكس. وُضع اعتماد ingest إضافي مشترك وسر JWT جديد خاص بالاختبار، دون تغيير API_SECRET القديم أو سر Cloudflare. حماية Vercel SSO أزيلت عن مشروعي **الاختبار** ليتمكنا من الاتصال آليًا؛ تبقى مصادقة التطبيق ومسارات العامل الخاصة مطلوبة.

## الحالة المقاسة بعد النشر

- الواجهة: HTTP 200، وحزمة JavaScript تحتوي عنوان الخادم التجريبي.
- الخادم: HTTP 200 في `/api/automation/health`، وdurableEngine=true وautomationConfigured=true، لكن databaseConfigured=false وdatabaseConnected=false وfirestoreConfigured=false. لذلك تسجيل الدخول وحفظ الفصول غير متاحين بعد.
- السكرابر: `/automation/health` يعيد protocol=2 وingestConfigured=true والمراجعة الصحيحة؛ `/health` يحافظ على النص القديم، و`/sites` يعرض 37 مصدرًا. لا اختبار سحب خارجي في هذه الجولة.
- نُشر كود Cloudflare الجديد مع الإبقاء على bindings، بما فيها السر الموجود دون قراءته أو تغييره. AUTOMATION_ENABLED يبقى false حتى تجهيز التخزين.
- حساب Atlas المتصل يعرض عنقودًا مجانيًا zeus-cloud، دون مستخدمي قواعد بيانات أو قائمة وصول عند الفحص. طلب إنشاء مستخدم readWrite مقتصر على zeus_automation_staging لم يُنفّذ؛ أداة Atlas أعادت أن التنفيذ لم يُؤكّد. لم نفتح وصولًا شبكيًا أو نغيّر صلاحيات MongoDB.

## الإعدادات المطلوبة داخل Vercel فقط

افتح [إعدادات متغيرات الخادم التجريبي](https://vercel.com/jooosos-projects/zeus-cfloww-staging/settings/environment-variables). لا تضع أسرارًا في Git أو المحادثة أو متغيرات VITE.

1. أضف MONGODB_URI كـSecret. يمكن استعمال اتصال Atlas الموجود مع اسم قاعدة الاختبار المفروض في الكود، أو مستخدم مستقل بصلاحية readWrite على zeus_automation_staging وحدها. المتغير مضبوط فعليًا باسم `AUTOMATION_DB_NAME=zeus_automation_staging`؛ لا تغيّره إلى قاعدة الروايات الأصلية.
2. جهّز مشروع Firebase مجانيًا مستقلًا بمعرّف يبدأ بـzeus-automation-. أضف AUTOMATION_FIREBASE_PROJECT_ID بمعرّفه، وFIREBASE_SERVICE_ACCOUNT كـSecret بحساب خدمة لهذا المشروع نفسه. اختر AUTOMATION_FIRESTORE_DATABASE=(default) لقاعدة المشروع المجانية المستقلة. لا تستعمل مشروع Firestore الإنتاجي.
3. لتهيئة المشرف دون CLI، ضع AUTOMATION_STAGING_BOOTSTRAP=true، وSTAGING_ADMIN_EMAIL ببريد تختاره، وSTAGING_ADMIN_PASSWORD كـSecret بكلمة مرور من 12 إلى 256 حرفًا. ينشئ الخادم حساب الاختبار عند أول طلب بعد اتصال MongoDB. إذا كان الحساب موجودًا، يجب أن تطابق كلمة المرور الحالية؛ لا يستبدلها أو يستولي على الحساب. التهيئة ترفض أي قاعدة خارج zeus_automation_. تسجيل بريد من قائمة المشرفين التاريخية وحده لا يمنح إدارة في V2.
4. أعد نشر مشروع **zeus-cfloww-staging** من فرع التطوير بعد حفظ المتغيرات. سجّل الدخول في الواجهة بالبريد وكلمة المرور المحددين. لا تعتمد على حساب الموقع الأصلي؛ قاعدة الحسابات مستقلة.
5. تحقق أن حقول databaseConfigured وdatabaseConnected وdatabaseIsolated وfirestoreConfigured وautomationConfigured في `/api/automation/health` كلها true. بعد ذلك فعّل AUTOMATION_ENABLED=true في إعدادات Worker zeus-automation-coordinator. يبقى Cron كل دقيقتين، وتوقظ المهمة سلسلة الرسائل عند إنشائها. لا حاجة لبقاء المتصفح مفتوحًا.
6. افتح `/dashboard/automation` بعد الدخول، واختر سحب فصل واحد من مصدر تملك إذن اختباره. افحص الفصل في الرواية ثم أعد الطلب للتحقق من عدم الازدواج، قبل زيادة العدد.
7. للترجمة، اضبط المزود والمسرد في لوحة الاختبار. تسمية المزود وحدها لا تثبت أنه مجاني؛ بعد التأكد من الحصة المجانية ضع معرفه في AUTOMATION_FREE_PROVIDER_IDS وأعد نشر الخادم. القائمة فارغة افتراضيًا لمنع تكلفة AI غير معتمدة. المزودات المصنفة long تحتاج عامل دفعات؛ Daemon وActions الفعليان غير مشغّلين.

بعد تهيئة المشرف يمكن تعطيل AUTOMATION_STAGING_BOOTSTRAP وإزالة STAGING_ADMIN_PASSWORD من إعدادات الاختبار وإعادة النشر؛ الحساب وكلمة مروره المحفوظة يبقيان صالحين. لا تجر اختبارات كبيرة قبل قياس حدود التخزين والمصدر والمزود.
