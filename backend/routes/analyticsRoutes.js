/**
 * 📊 مسارات التحليلات:
 *   POST /api/analytics/collect → استقبال دفعات الأحداث (عام + حد معدل)
 *   GET  /api/analytics/summary?days=7 → ملخص كامل للوحة الإدارة (admin)
 */
const AnalyticsEvent = require('../models/analyticsEvent.model.js');
const security = require('../services/security.service');

const VALID_TYPES = ['pageview', 'novel_open', 'chapter_read', 'download'];

function cleanStr(v, max = 200) {
    return typeof v === 'string' ? v.slice(0, max) : undefined;
}

module.exports = (app, verifyToken, verifyAdmin) => {
    // استقبال الأحداث — fire-and-forget، لا يبطئ الاستجابة أبداً
    app.post('/api/analytics/collect', security.collectRateLimit, async (req, res) => {
        res.status(204).end();
        try {
            const { cid, sid, device, screen, events } = req.body || {};
            if (!Array.isArray(events) || events.length === 0 || events.length > 20) return;
            const docs = events
                .filter((e) => e && VALID_TYPES.includes(e.type))
                .slice(0, 20)
                .map((e) => ({
                    cid: cleanStr(cid, 64) || 'anon',
                    sid: cleanStr(sid, 64),
                    type: e.type,
                    path: cleanStr(e.path, 200),
                    novelId: cleanStr(e.novelId, 64),
                    referrer: cleanStr(e.referrer, 200),
                    device: cleanStr(device, 20),
                    screen: cleanStr(screen, 12),
                    t: new Date(),
                }));
            if (docs.length) await AnalyticsEvent.insertMany(docs, { ordered: false });
        } catch { /* التحليلات لا تفشل أبداً بصوت عالٍ */ }
    });

    // الملخص الإداري
    app.get('/api/analytics/summary', verifyAdmin, async (req, res) => {
        try {
            const days = Math.min(90, Math.max(1, parseInt(req.query.days) || 7));
            const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

            const [totalsAgg, daily, topPages, topNovels, referrers, devices] = await Promise.all([
                AnalyticsEvent.aggregate([
                    { $match: { t: { $gte: since } } },
                    {
                        $group: {
                            _id: null,
                            pageViews: { $sum: { $cond: [{ $eq: ['$type', 'pageview'] }, 1, 0] } },
                            novelOpens: { $sum: { $cond: [{ $eq: ['$type', 'novel_open'] }, 1, 0] } },
                            chapterReads: { $sum: { $cond: [{ $eq: ['$type', 'chapter_read'] }, 1, 0] } },
                            uniqueVisitors: { $addToSet: '$cid' },
                            sessions: { $addToSet: '$sid' },
                        },
                    },
                    {
                        $project: {
                            _id: 0,
                            pageViews: 1,
                            novelOpens: 1,
                            chapterReads: 1,
                            uniqueVisitors: { $size: '$uniqueVisitors' },
                            sessions: { $size: '$sessions' },
                        },
                    },
                ]),
                AnalyticsEvent.aggregate([
                    { $match: { t: { $gte: since }, type: 'pageview' } },
                    {
                        $group: {
                            _id: { $dateToString: { format: '%Y-%m-%d', date: '$t' } },
                            views: { $sum: 1 },
                            visitors: { $addToSet: '$cid' },
                        },
                    },
                    { $project: { views: 1, visitors: { $size: '$visitors' } } },
                    { $sort: { _id: -1 } },
                ]),
                AnalyticsEvent.aggregate([
                    { $match: { t: { $gte: since }, type: 'pageview' } },
                    { $group: { _id: '$path', count: { $sum: 1 } } },
                    { $sort: { count: -1 } },
                    { $limit: 20 },
                ]),
                AnalyticsEvent.aggregate([
                    { $match: { t: { $gte: since }, type: 'novel_open' } },
                    { $group: { _id: '$novelId', count: { $sum: 1 } } },
                    { $sort: { count: -1 } },
                    { $limit: 20 },
                ]),
                AnalyticsEvent.aggregate([
                    { $match: { t: { $gte: since }, type: 'pageview' } },
                    {
                        $group: {
                            _id: {
                                $cond: [
                                    { $or: [{ $eq: ['$referrer', ''] }, { $eq: ['$referrer', null] }] },
                                    '',
                                    { $arrayElemAt: [{ $split: ['$referrer', '/'] }, 2] },
                                ],
                            },
                            count: { $sum: 1 },
                        },
                    },
                    { $sort: { count: -1 } },
                    { $limit: 15 },
                ]),
                AnalyticsEvent.aggregate([
                    { $match: { t: { $gte: since } } },
                    { $group: { _id: '$device', count: { $sum: 1 } } },
                    { $sort: { count: -1 } },
                ]),
            ]);

            // تعيين أسماء الروايات لأكثر الروايات قراءة
            let topNovelsNamed = topNovels;
            try {
                const Novel = require('../models/novel.model.js');
                const ids = topNovels.map((n) => n._id).filter(Boolean);
                if (ids.length) {
                    const novels = await Novel.find({ _id: { $in: ids } }, { title: 1 }).lean();
                    const map = new Map(novels.map((n) => [String(n._id), n.title]));
                    topNovelsNamed = topNovels.map((n) => ({ ...n, title: map.get(String(n._id)) || 'رواية محذوفة' }));
                }
            } catch { /* بدون أسماء — مقبول */ }

            res.json({
                totals: totalsAgg[0] || { pageViews: 0, novelOpens: 0, chapterReads: 0, uniqueVisitors: 0, sessions: 0 },
                daily,
                topPages,
                topNovels: topNovelsNamed,
                referrers,
                devices,
                days,
            });
        } catch (e) {
            res.status(500).json({ message: e.message });
        }
    });
};
