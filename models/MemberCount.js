const mongoose = require('mongoose');

const MemberCountSchema = new mongoose.Schema({
  // Note: Index géré par l'index composé ci-dessous (guildId + timestamp)
  guildId: {
    type: String,
    required: true
  },
  guildName: {
    type: String,
    required: true
  },
  totalMembers: {
    type: Number,
    required: true
  },
  onlineMembers: {
    type: Number,
    required: true
  },
  // Note: Index géré par l'index TTL ci-dessous (évite duplication)
  timestamp: {
    type: Date,
    default: Date.now
  },
  // Différences calculées par rapport au count précédent
  dailyChange: {
    type: Number,
    default: 0
  },
  weeklyChange: {
    type: Number,
    default: 0
  },
  monthlyChange: {
    type: Number,
    default: 0
  }
});

// Index composé pour des requêtes efficaces
MemberCountSchema.index({ guildId: 1, timestamp: -1 });

// 🧹 Index TTL pour suppression automatique après 30 jours
MemberCountSchema.index({ timestamp: 1 }, { 
  expireAfterSeconds: 30 * 24 * 60 * 60 // 30 jours
});

module.exports = mongoose.model('MemberCount', MemberCountSchema); 