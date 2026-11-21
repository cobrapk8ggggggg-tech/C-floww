const cloudinary = require('cloudinary').v2;

// إعداد Cloudinary
// Credentials are configured through the environment.
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'djuhxdjj',
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

console.log("☁️ Cloudinary Configured Successfully");

module.exports = cloudinary;
