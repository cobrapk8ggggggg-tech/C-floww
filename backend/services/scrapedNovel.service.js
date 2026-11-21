'use strict';
const { createHash } = require('node:crypto');

module.exports = async function prepareScrapedNovel(Novel, sourceUrl, metadata, owner) {
  const candidates = await Novel.find({ sourceUrl }).select('_id').limit(2);
  if (candidates.length > 1) throw new Error('Ambiguous existing source identity');
  const novelId = candidates[0]?._id ||
    createHash('sha256').update('automation-novel\n' + sourceUrl).digest('hex').slice(0, 24);
  const authorId = /^[a-f\d]{24}$/i.test(owner?.ownerId || '') ? owner.ownerId : undefined;
  await Novel.updateOne({ _id: novelId }, {
    $setOnInsert: {
      title: metadata.title,
      titleEn: metadata.title,
      author: 'System Scraper',
      authorEmail: 'system@scraper',
      ...(authorId ? { authorId } : {}),
      description: metadata.description || '',
      status: 'خاصة',
      sourceUrl,
      isWatched: false,
      chapters: []
    }
  }, { upsert: true, runValidators: true, writeConcern: { w: 'majority' } });
  return novelId;
};
