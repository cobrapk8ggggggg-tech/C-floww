const admin = require("firebase-admin");

// دالة لمحاولة استخراج إعدادات Firebase سواء من متغيرات البيئة أو من ملف محلي (للتطوير)
const getServiceAccount = () => {
  // 1. الخيار الأول: القراءة من متغير البيئة في Vercel/Railway (Stringified JSON)
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } catch (e) {
      console.error("❌ Failed to parse FIREBASE_SERVICE_ACCOUNT environment variable. Ensure it is a valid JSON string.");
      return null;
    }
  }
  
  // 2. الخيار الثاني: القراءة من الملف المحلي (فقط أثناء التطوير المحلي)
  try {
    return require("../serviceAccountKey.json");
  } catch (e) {
    // Only log warn if we don't have the env var either
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
      console.warn("⚠️ Firebase credentials not found (env or file). Firestore features will be disabled.");
    }
    return null;
  }
};

const serviceAccount = getServiceAccount();
let db = null;

if (serviceAccount) {
  try {
    require('./automationIsolation').firebaseProject(serviceAccount.project_id);
    // التأكد من عدم تهيئة التطبيق مرتين
    const projectId=process.env.AUTOMATION_FIREBASE_PROJECT_ID;
    const name='zeus-automation-'+projectId;
    const application=admin.apps.find(a=>a.name===name)||admin.initializeApp({
      credential:admin.credential.cert(serviceAccount),projectId
    },name);
    // This development branch must never select the production default database.
    const databaseId = require('./automationIsolation').firestoreDatabase();
    db = require('firebase-admin/firestore').getFirestore(application, databaseId);
  } catch (error) {
    console.error("❌ Firebase Admin Initialization Error:", error.message);
  }
} else {
  console.error("❌ Firebase Admin Config Missing! Check FIREBASE_SERVICE_ACCOUNT env var.");
}

module.exports = { admin, db };
