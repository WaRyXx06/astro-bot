const mongoose = require('mongoose');

const LogSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['newroom', 'error', 'roles', 'admin', 'auto-start', 'members'],
    required: true
  },
  message: {
    type: String,
    required: true
  },
  timestamp: {
    type: Date,
    default: Date.now
  },
  channelId: {
    type: String,
    default: null
  }
});

// 🧹 Index TTL pour suppression automatique après 15 jours (optimisation espace DB)
LogSchema.index({ timestamp: 1 }, {
  expireAfterSeconds: 15 * 24 * 60 * 60 // 15 jours
});

module.exports = mongoose.model('Log', LogSchema); 