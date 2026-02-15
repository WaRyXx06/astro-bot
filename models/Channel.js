const mongoose = require('mongoose');

const ChannelSchema = new mongoose.Schema({
  discordId: {
    type: String,
    required: true,
    unique: true
  },
  serverId: {
    type: String,
    required: true
  },
  sourceChannelId: {
    type: String,
    required: false  // ID du salon sur le serveur SOURCE (pour la correspondance)
  },
  name: {
    type: String,
    required: true
  },
  category: {
    type: String,
    default: null
  },
  scraped: {
    type: Boolean,
    default: false
  },
  delaySeconds: {
    type: Number,
    default: null // null = utilise le délai global
  },
  lastScraped: {
    type: Date,
    default: null
  },
  inactive: {
    type: Boolean,
    default: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  failedAttempts: {
    type: Number,
    default: 0
  },
  lastFailedAt: {
    type: Date,
    default: null
  },
  blacklistedUntil: {
    type: Date,
    default: null
  },
  isBlacklisted: {
    type: Boolean,
    default: false
  },
  // 🆕 MÉTHODE 2 : Marquage intelligent pour suppression manuelle
  manuallyDeleted: {
    type: Boolean,
    default: false
  },
  deletedAt: {
    type: Date,
    default: null
  },
  deletedReason: {
    type: String,
    default: null
  },
  // 🔕 ÉVITER LES LOGS RÉPÉTÉS : Dernière fois qu'un log de nettoyage a été envoyé
  lastCleanupLog: {
    type: Date,
    default: null
  },
  // 📝 RENOMMAGE : Dernière mise à jour du nom
  lastNameUpdate: {
    type: Date,
    default: null
  },
  // 🔄 ACTIVITÉ : Dernière activité sur ce channel (incluant opérations système)
  // Note: Index géré par l'index TTL partiel ci-dessous (évite duplication)
  lastActivity: {
    type: Date,
    default: Date.now
  },
  // 💬 MESSAGES : Dernière activité de MESSAGE réel (pour détecter l'inactivité)
  // Note: Index séparé ajouté ci-dessous pour les requêtes /autoclean
  lastMessageActivity: {
    type: Date,
    default: null  // null = jamais eu de message
  },
  // 📊 COMPTEUR : Nombre de messages traités
  messageCount: {
    type: Number,
    default: 0
  },
  // 🔧 STATUT : Channel actif ou non (pour exclusion du TTL)
  isActive: {
    type: Boolean,
    default: true
  }
});

// 🧹 Index TTL pour suppression automatique après 30 jours d'inactivité
// Ne supprime que les channels inactifs et non protégés
ChannelSchema.index(
  { lastActivity: 1 },
  {
    expireAfterSeconds: 30 * 24 * 60 * 60, // 30 jours
    partialFilterExpression: {
      isActive: false,
      manuallyDeleted: false,
      isBlacklisted: false
    }
  }
);

// 📊 Index pour les requêtes /autoclean (recherche par inactivité message)
ChannelSchema.index({ lastMessageActivity: 1 });

// 🔍 Index pour les requêtes par serverId (multi-instance)
// Utilisé dans Channel.find({ serverId: guildId }) partout
ChannelSchema.index({ serverId: 1 });

// 🔗 Index composé pour les correspondances source -> mirror
// Utilisé pour trouver le channel mirror à partir du channel source
ChannelSchema.index({ sourceChannelId: 1, serverId: 1 });

module.exports = mongoose.model('Channel', ChannelSchema); 