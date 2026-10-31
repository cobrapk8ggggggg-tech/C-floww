const mongoose = require('mongoose');
const schema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    context: { type: mongoose.Schema.Types.Mixed, default: {} },
    expiresAt: { type: Date, required: true, index: { expires: 0 } }
}, { timestamps: true });
module.exports = mongoose.model('ProviderConversation', schema);
