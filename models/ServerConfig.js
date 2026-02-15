const mongoose = require('mongoose');

const ServerConfigSchema = new mongoose.Schema({
  guildId: {
    type: String,
    required: true,
    unique: true
  },
  sourceGuildId: {
    type: String,
    required: false
  },
  sourceGuildName: {
    type: String,
    required: false
  },
  scrapingActive: {
    type: Boolean,
    default: false
  },
  lastUserAccount: {
    type: String, // username#discriminator pour info
    required: false
  },
  configuredAt: {
    type: Date,
    default: Date.now
  },
  lastStarted: {
    type: Date,
    default: null
  },
  lastStopped: {
    type: Date,
    default: null
  },
  autoRestoreEnabled: {
    type: Boolean,
    default: true
  },
  scrapingSettings: {
    delaySeconds: {
      type: Number,
      default: 1
    },
    filterInactive: {
      type: Boolean,
      default: true
    },
    lastUpdated: {
      type: Date,
      default: Date.now
    }
  },
  // Pas de token stocké - juste une indication pour l'utilisateur
  needsTokenReconfig: {
    type: Boolean,
    default: false
  },
  crashCount: {
    type: Number,
    default: 0
  },
  lastCrash: {
    type: Date,
    default: null
  },
  // 🆕 ÉTAT D'INITIALISATION
  botInitialized: {
    type: Boolean,
    default: false
  },
  systemRolesCreated: {
    type: Boolean,
    default: false
  },
  logChannelsCreated: {
    type: Boolean,
    default: false
  },
  adminLogsCreated: {
    type: Boolean,
    default: false
  },
  initializedAt: {
    type: Date,
    default: null
  },
  // 🆕 INFOS POUR SIMPLIFIER LA RECONNEXION
  lastTokenHint: {
    type: String, // Derniers caractères du token pour aide mémoire
    required: false
  },
  hasValidConfig: {
    type: Boolean,
    default: false
  },
  // 🔧 AUTO-REPAIR - Système de correction automatique
  autoRepairEnabled: {
    type: Boolean,
    default: false // Désactivé par défaut pour sécurité
  },
  autoRepairStats: {
    createdCount: {
      type: Number,
      default: 0
    },
    lastRepairAt: {
      type: Date,
      default: null
    }
  },
  // 🔔 MENTION-LOGS - Configuration persistante des notifications
  mentionLogsConfig: {
    channelId: {
      type: String,
      default: null
    },
    backupChannelId: {
      type: String,
      default: null
    },
    detectEveryone: {
      type: Boolean,
      default: true // Détecter @everyone/@here
    },
    detectRoles: {
      type: Boolean,
      default: true // Détecter mentions de rôles
    },
    deduplicationWindow: {
      type: Number,
      default: 60000 // 60 secondes
    },
    allowBotMentions: {
      type: Boolean,
      default: false // Ignorer les bots par défaut
    },
    configuredAt: {
      type: Date,
      default: null
    }
  }
});

// 🚀 Index pour la requête d'auto-start au démarrage
// Utilisé pour trouver les serveurs avec scraping actif
ServerConfigSchema.index({ scrapingActive: 1, botInitialized: 1 });

module.exports = mongoose.model('ServerConfig', ServerConfigSchema); 