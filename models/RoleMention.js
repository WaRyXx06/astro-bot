const mongoose = require('mongoose');

const roleMentionSchema = new mongoose.Schema({
  // Message original
  messageId: {
    type: String,
    required: true,
    index: true
  },
  channelId: {
    type: String,
    required: true
  },
  channelName: {
    type: String,
    required: true
  },
  guildId: {
    type: String,
    required: true
  },
  
  // Message mirror
  mirrorMessageId: {
    type: String,
    required: true
  },
  mirrorChannelId: {
    type: String,
    required: true
  },
  mirrorGuildId: {
    type: String,
    required: true
  },
  
  // Informations du message
  authorTag: {
    type: String,
    required: true
  },
  authorId: {
    type: String,
    required: true
  },
  messageContent: {
    type: String,
    required: true,
    maxlength: 2000
  },
  
  // Mentions de rôles détectées
  mentionedRoles: [{
    roleId: {
      type: String,
      required: true
    },
    roleName: {
      type: String,
      required: true
    }
  }],
  
  // Timestamps
  // Note: Index géré par l'index TTL ci-dessous (évite duplication)
  createdAt: {
    type: Date,
    default: Date.now
  },
  messageTimestamp: {
    type: Date,
    required: true
  }
});

// Index composé pour des requêtes efficaces
roleMentionSchema.index({ guildId: 1, createdAt: -1 });
roleMentionSchema.index({ mirrorGuildId: 1, createdAt: -1 });

// 🧹 Index TTL pour suppression automatique après 30 jours
roleMentionSchema.index({ createdAt: 1 }, { 
  expireAfterSeconds: 30 * 24 * 60 * 60 // 30 jours
});

module.exports = mongoose.model('RoleMention', roleMentionSchema); 