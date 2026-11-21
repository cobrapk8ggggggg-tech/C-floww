/**
 * 🗺️ sitemap.xml ديناميكي — يولّد من قاعدة البيانات:
 *   الصفحات الثابتة + آخر 1000 رواية (بآخر تعديل لكل رواية).
 * يُخدم عبر إعادة توجيه Vercel: /sitemap.xml → /api/sitemap على الخادم.
 */
const Novel = require('../models/novel.model.js');

const SITE = 'https://moonnovel.vercel.app';

function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&apos;').replace(/"/g, '&quot;');
}

module.exports = async (req, res) => {
    try {
        const novels = await Novel.find(
            { status: { $ne: 'خاصة' } },
            { lastChapterUpdate: 1, updatedAt: 1, createdAt: 1 }
        )
            .sort({ lastChapterUpdate: -1, createdAt: -1 })
            .limit(1000)
            .lean();

        const urls = [
            { loc: `${SITE}/`, priority: '1.0', changefreq: 'daily' },
            { loc: `${SITE}/library`, priority: '0.9', changefreq: 'daily' },
            { loc: `${SITE}/about`, priority: '0.4', changefreq: 'monthly' },
            { loc: `${SITE}/privacy`, priority: '0.3', changefreq: 'yearly' },
            { loc: `${SITE}/terms`, priority: '0.3', changefreq: 'yearly' },
            ...novels.map((n) => ({
                loc: `${SITE}/novel/${n._id}`,
                lastmod: (n.lastChapterUpdate || n.updatedAt || n.createdAt || new Date()).toISOString(),
                priority: '0.8',
                changefreq: 'daily',
            })),
        ];

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}<changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`).join('\n')}
</urlset>`;

        res.set('Content-Type', 'application/xml; charset=utf-8');
        res.set('Cache-Control', 'public, max-age=3600'); // ساعة — يخفف الحمل
        res.send(xml);
    } catch (e) {
        res.status(500).send('sitemap error');
    }
};
