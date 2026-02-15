const mongoose = require('mongoose');

const CategorySchema = new mongoose.Schema({
  discordId: {
    type: String,
    required: true,
    unique: true
  },
  serverId: {
    type: String,
    required: true
  },
  name: {
    type: String,
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  // 🆕 Marquage intelligent pour suppression manuelle
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
  deletedBy: {
    type: String,
    default: null
  }
});

module.exports = mongoose.model('Category', CategorySchema); 