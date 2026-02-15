const mongoose = require('mongoose');

const RoleSchema = new mongoose.Schema({
  discordId: {
    type: String,
    required: true,
    unique: true
  },
  serverId: {
    type: String,
    required: true
  },
  sourceRoleId: {
    type: String,
    required: false  // ID du rôle sur le serveur SOURCE (pour la correspondance)
  },
  name: {
    type: String,
    required: true
  },
  synced: {
    type: Boolean,
    default: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Index composé pour les lookups de correspondance source -> mirror
// Utilisé dans channelSyncService.syncRoles() : Role.findOne({ sourceRoleId, serverId })
RoleSchema.index({ sourceRoleId: 1, serverId: 1 });

module.exports = mongoose.model('Role', RoleSchema);