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

console.log('MONGODB_URI used:', process.env.MONGODB_URI ? process.env.MONGODB_URI.replace(/:[^:@]+@/, ':****@') : 'undefined');

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

// Database Connection with retry logic (no crash on failure)
let cachedDb = null;
let connectionAttempts = 0;
const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 7000;

async function connectToDatabase(retry = true) {
    if (cachedDb) return cachedDb;
    try {
        const db = await mongoose.connect(process.env.MONGODB_URI, {
            serverSelectionTimeoutMS: 5000,
        });
        cachedDb = db;
        connectionAttempts = 0;
        console.log("✅ Connected to MongoDB Atlas");
        return db;
    } catch (error) {
        console.error("❌ MongoDB connection error:", error.message);
        if (retry && connectionAttempts < MAX_RETRIES) {
            connectionAttempts++;
            console.log(`🔄 Retrying connection (${connectionAttempts}/${MAX_RETRIES}) in ${RETRY_DELAY_MS/1000} seconds...`);
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
            return connectToDatabase(true);
        } else if (retry && connectionAttempts >= MAX_RETRIES) {
            console.error(`❌ CRITICAL: Could not connect to MongoDB after ${MAX_RETRIES} attempts. Server will continue but database features will fail.`);
            // لا نرمي الخطأ، نستمر بدون قاعدة بيانات
            return null;
        } else {
            throw error; // فقط إذا retry=false (لم نستخدمها حالياً)
        }
    }
}

// Start connection in background without blocking server startup
connectToDatabase(true).catch(err => {
    // Already handled inside function, but for safety:
    console.error("Unhandled MongoDB connection failure:", err.message);
});

// Middleware to ensure DB is connected (or at least attempted)
app.use(async (req, res, next) => {
    if (!cachedDb) {
        // محاولة الاتصال مرة أخرى إذا لم يكن هناك اتصال بعد
        await connectToDatabase(true);
    }
    next();
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

// تحميل مسارات الإدارة
require('./routes/adminRoutes')(app, verifyToken, verifyAdmin, upload);

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