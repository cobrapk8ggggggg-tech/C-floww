// =================================================================
// 1. التحميل اليدوي لمتغيرات البيئة
// =================================================================
const fs = require('fs');
const path = require('path');

try {
    const envConfig = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    envConfig.split('\n').forEach(line => {
        const [key, value] = line.split('=');
        if (key && value) {
            process.env[key.trim()] = value.trim();
        }
    });
    console.log('✅ Environment variables loaded manually.');
} catch (error) {
    console.warn('⚠️  Could not find .env file. Using platform environment variables instead.');
}

console.log('MongoDB connection configured:', Boolean(process.env.MONGODB_URI));

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const multer = require('multer');

// Models (Required for Auth here)
const User = require('./models/user.model.js');

const app = express();

// إعداد Multer للتعامل مع رفع الصور في الذاكرة
const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

app.use(cors({
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Bounded health probe: configuration alone is not database readiness.
app.get('/api/automation/health', async (_req, res) => {
  try { await connectToDatabase(); } catch {}
  return res.json({
    service: 'zeus-cfloww', status: 'ok', databaseConfigured: Boolean(process.env.MONGODB_URI),
    databaseConnected: mongoose.connection.readyState === 1,
    databaseIsolated: mongoose.connection.readyState === 1 && mongoose.connection.name === configuredStagingDb,
    firestoreConfigured: Boolean(require('./config/firebaseAdmin').db),
    firestoreDatabase: require('./config/automationIsolation').firestoreDatabase(),
    automationConfigured: Boolean(process.env.AUTOMATION_SECRET && process.env.SCRAPER_SERVICE_URL && process.env.SCRAPER_API_SECRET && process.env.AUTOMATION_INGEST_SECRET),
    revision: process.env.VERCEL_GIT_COMMIT_SHA || 'local',
    durableEngine: process.env.DURABLE_ENGINE_V2 === 'true'
});
});

// Await bounded connection attempts inside requests; no background retry loop.
const configuredStagingDb = require('./config/automationIsolation').mongoDatabase();
const connectToDatabase = require('./services/databaseConnection.service')(mongoose, {
    uri: process.env.MONGODB_URI, dbName: configuredStagingDb
});
app.use(async (_req, res, next) => {
    try {
        if (!await connectToDatabase()) return res.status(503).json({error:'Database not configured'});
        next();
    } catch {
        return res.status(503).json({error:'Database temporarily unavailable'});
    }
});

// =========================================================
// 🛡️ طبقة الحماية (قبل كل المسارات):
// حظر IP مخالف + حدود معدل عام وفصول + فخ السكرابر
// =========================================================
const security = require('./services/security.service');
app.use(security.securityMiddleware);

// Middleware Definitions
function verifyToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'No token' });

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ message: 'Invalid token' });
        req.user = user;
        next();
    });
}

async function verifyAdmin(req, res, next) {
    verifyToken(req, res, async () => {
        const user = await User.findById(req.user.id);
        if (user && (user.role === 'admin' || user.role === 'contributor')) {
             next();
        } else {
            res.status(403).json({ message: 'Admin/Contributor access required' });
        }
    });
}

// =========================================================
// 🔗 MOUNT ROUTES
// =========================================================

// 🔥 تحميل مسارات المصادقة الجديدة (Login/Signup/Google)
require('./routes/authRoutes')(app, verifyToken);

require('./routes/durableRoutes')(app, verifyAdmin);

// تحميل مسارات الإدارة
require('./routes/adminRoutes')(app, verifyToken, verifyAdmin, upload);
// Bounded chapter jobs: opt-in, with MongoDB checkpoints and Cloudflare cron.
require('./routes/automationRoutes')(app, verifyAdmin);
require('./routes/automationImportRoutes')(app);
require('./routes/automationCatalogRoutes')(app);

// 🔥 تحميل مسارات المترجم الذكي
require('./routes/translatorRoutes')(app, verifyToken, verifyAdmin);
require('./routes/accountProviderRoutes')(app, verifyToken, verifyAdmin, upload);

// 🔍 تحميل مسارات المراجع الذكي (مراجعة جودة الفصول بالذكاء الاصطناعي)
require('./routes/reviewRoutes')(app, verifyToken, verifyAdmin);

// 📚 تحميل مسارات المستخرج الذكي (استخراج مصطلحات الرواية كاملة قبل الترجمة)
require('./routes/glossaryAiRoutes')(app, verifyToken, verifyAdmin);

// ⚡ تحميل مسارات المترجم الخالص (ترجمة فقط بالمسرد الجاهز — بلا استخراج مصطلحات — نظام مستقل)
require('./routes/pureTranslatorRoutes')(app, verifyToken, verifyAdmin);

// 🔥 تحميل مسارات مولد العناوين
require('./routes/titleGenRoutes')(app, verifyToken, verifyAdmin);

// تحميل المسارات العامة
require('./routes/publicRoutes')(app, verifyToken, upload);

// 🛡️ مسارات الأمان + 📊 التحليلات + 🗺️ sitemap الديناميكي
require('./routes/securityRoutes')(app, verifyToken, verifyAdmin);
require('./routes/analyticsRoutes')(app, verifyToken, verifyAdmin);
app.get('/api/sitemap', require('./routes/sitemapRoute'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});