const mongoose = require('mongoose');

const mentionBlacklistSchema = new mongoose.Schema({
  // ID du serveur source
  sourceGuildId: {
    type: String,
    required: true,
    index: true
  },
  
  // ID du serveur mirror
  mirrorGuildId: {
    type: String,
    required: true,
    index: true
  },
  
  // Nom du salon blacklisté
  channelName: {
    type: String,
    required: true,
    index: true
  },
  
  // ID du salon source (optionnel)
  sourceChannelId: {
    type: String,
    default: null
  },
  
  // Raison de la blacklist
  reason: {
    type: String,
    default: 'Ajouté manuellement'
  },
  
  // Qui a ajouté à la blacklist
  addedBy: {
    type: String,
    required: true
  },
  
  // Date d'ajout à la blacklist
  addedAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  
  // Actif ou non
  isActive: {
    type: Boolean,
    default: true,
    index: true
  }
}, {
  timestamps: true,
  collection: 'mentionBlacklists'
});

// Index composé pour optimiser les requêtes
mentionBlacklistSchema.index({ sourceGuildId: 1, channelName: 1 }, { unique: true });
mentionBlacklistSchema.index({ mirrorGuildId: 1, isActive: 1 });

// Méthodes statiques utiles
mentionBlacklistSchema.statics.isChannelBlacklisted = async function(sourceGuildId, channelName) {
  const blacklistEntry = await this.findOne({
    sourceGuildId: sourceGuildId,
    channelName: channelName,
    isActive: true
  });
  
  return !!blacklistEntry;
};

mentionBlacklistSchema.statics.getBlacklistedChannels = async function(sourceGuildId) {
  return await this.find({
    sourceGuildId: sourceGuildId,
    isActive: true
  }).sort({ addedAt: -1 });
};

mentionBlacklistSchema.statics.addToBlacklist = async function(data) {
  const { sourceGuildId, mirrorGuildId, channelName, sourceChannelId, reason, addedBy } = data;
  
  // Supprimer l'ancienne entrée si elle existe
  await this.deleteOne({
    sourceGuildId: sourceGuildId,
    channelName: channelName
  });
  
  // Créer la nouvelle entrée
  const newEntry = new this({
    sourceGuildId,
    mirrorGuildId,
    channelName,
    sourceChannelId,
    reason,
    addedBy,
    isActive: true
  });
  
  return await newEntry.save();
};

mentionBlacklistSchema.statics.removeFromBlacklist = async function(sourceGuildId, channelName) {
  return await this.deleteOne({
    sourceGuildId: sourceGuildId,
    channelName: channelName
  });
};

mentionBlacklistSchema.statics.clearBlacklist = async function(sourceGuildId) {
  return await this.deleteMany({
    sourceGuildId: sourceGuildId
  });
};

module.exports = mongoose.model('MentionBlacklist', mentionBlacklistSchema); 