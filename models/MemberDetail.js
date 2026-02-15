const mongoose = require('mongoose');

const MemberDetailSchema = new mongoose.Schema({
  // Identifiants principaux
  guildId: {
    type: String,
    required: true,
    index: true
  },
  guildName: {
    type: String,
    required: true
  },
  userId: {
    type: String,
    required: true,
    index: true
  },

  // Informations du membre
  username: {
    type: String,
    required: true
  },
  discriminator: {
    type: String,
    default: '0' // Discord a retiré les discriminators pour la plupart
  },
  displayName: {
    type: String // Nom d'affichage sur le serveur
  },

  // Statut de présence
  isPresent: {
    type: Boolean,
    default: true,
    index: true
  },
  joinedAt: {
    type: Date,
    default: Date.now
  },
  leftAt: {
    type: Date,
    default: null
  },
  lastSeen: {
    type: Date,
    default: Date.now
  },
  lastFetched: {
    type: Date,
    default: null // Pour le cache (éviter de refetch si < 1h)
  },
  avatar: {
    type: String,
    default: null // Hash de l'avatar Discord
  },

  // Tracking multi-serveurs
  servers: [{
    guildId: String,
    guildName: String,
    joinedAt: Date,
    isPresent: Boolean
  }],

  // Analyse de danger
  isDangerous: {
    type: Boolean,
    default: false,
    index: true
  },
  dangerLevel: {
    type: Number,
    default: 0 // 0: safe, 1: low, 2: medium, 3: high
  },
  dangerReason: {
    type: String // "Présent sur X serveurs concurrents"
  },

  // Métadonnées
  firstSeenAt: {
    type: Date,
    default: Date.now
  },
  totalJoins: {
    type: Number,
    default: 1
  },
  totalLeaves: {
    type: Number,
    default: 0
  },

  // Tracking des changements
  history: [{
    date: Date,
    action: String, // 'join', 'leave', 'nameChange', 'serverAdded', 'serverRemoved'
    details: String,
    guildId: String,
    guildName: String
  }],

  // Données pour l'analyse
  isOpportunity: {
    type: Boolean,
    default: false // True si a quitté un concurrent récemment
  },
  opportunityDate: {
    type: Date
  },
  opportunityFrom: {
    type: String // Nom du serveur concurrent quitté
  }
});

// Index composés pour requêtes optimisées
MemberDetailSchema.index({ guildId: 1, userId: 1 }, { unique: true });
MemberDetailSchema.index({ userId: 1, isPresent: 1 });
MemberDetailSchema.index({ isDangerous: 1, guildId: 1 });
MemberDetailSchema.index({ isOpportunity: 1, opportunityDate: -1 });

// Index TTL pour nettoyer les anciennes données (90 jours)
MemberDetailSchema.index({ lastSeen: 1 }, {
  expireAfterSeconds: 90 * 24 * 60 * 60
});

// Méthode pour calculer le niveau de danger
MemberDetailSchema.methods.calculateDangerLevel = function() {
  const serverCount = this.servers.filter(s => s.isPresent).length;

  if (serverCount <= 1) {
    this.dangerLevel = 0;
    this.isDangerous = false;
    this.dangerReason = null;
  } else if (serverCount === 2) {
    this.dangerLevel = 1;
    this.isDangerous = true;
    this.dangerReason = `Présent sur ${serverCount} serveurs`;
  } else if (serverCount === 3) {
    this.dangerLevel = 2;
    this.isDangerous = true;
    this.dangerReason = `Présent sur ${serverCount} serveurs`;
  } else {
    this.dangerLevel = 3;
    this.isDangerous = true;
    this.dangerReason = `Présent sur ${serverCount} serveurs (ALERTE)`;
  }

  return this.dangerLevel;
};

// Méthode pour ajouter un historique
MemberDetailSchema.methods.addHistory = function(action, details, guildId, guildName) {
  this.history.push({
    date: new Date(),
    action,
    details,
    guildId,
    guildName
  });

  // Limiter l'historique à 100 entrées
  if (this.history.length > 100) {
    this.history = this.history.slice(-100);
  }
};

module.exports = mongoose.model('MemberDetail', MemberDetailSchema);