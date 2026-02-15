const mongoose = require('mongoose');

/**
 * Schema pour le cache des liens ProxAuth débloqués
 * Permet de réutiliser les liens débloqués et d'éviter de spammer ProxAuth
 */
const proxAuthCacheSchema = new mongoose.Schema({
  // URL ProxAuth originale (unique)
  proxauthUrl: {
    type: String,
    required: true,
    unique: true,
    index: true
  },

  // Lien final débloqué (null tant que pas encore débloqué)
  finalUrl: {
    type: String,
    default: null
  },

  // ID Discord de l'utilisateur qui a débloqué en premier
  unlockedBy: {
    type: String,
    default: null
  },

  // Date du premier déblocage
  unlockedAt: {
    type: Date,
    default: null
  },

  // Nombre de fois que le cache a été utilisé
  unlockCount: {
    type: Number,
    default: 0
  },

  // ID du message Discord (pour édition ultérieure)
  messageId: {
    type: String,
    required: true
  },

  // ID du webhook (pour édition)
  webhookId: {
    type: String,
    required: true
  },

  // Token du webhook (pour édition)
  webhookToken: {
    type: String,
    required: true
  },

  // Date de création (pour TTL)
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 604800 // TTL 7 jours (en secondes)
  }
});

// Index pour recherches rapides par messageId
proxAuthCacheSchema.index({ messageId: 1 });

module.exports = mongoose.model('ProxAuthCache', proxAuthCacheSchema);
