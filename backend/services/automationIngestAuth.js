'use strict';
const {timingSafeEqual} = require('node:crypto');
const {usesExistingDatabases} = require('../config/automationIsolation');

function matches(expected, actual) {
  const wanted = Buffer.from(expected || '');
  const supplied = Buffer.from(actual || '');
  return wanted.length > 0 && wanted.length === supplied.length && timingSafeEqual(wanted, supplied);
}

module.exports = function authenticateIngest(req, res, next) {
  const secret = process.env.AUTOMATION_INGEST_SECRET;
  if (!secret) return res.sendStatus(503);
  if (!matches(secret, req.get('x-automation-ingest-secret'))) return res.sendStatus(403);
  if (!usesExistingDatabases() && !matches(process.env.SCRAPER_API_SECRET, req.get('authorization'))) {
    return res.sendStatus(403);
  }
  next();
};
