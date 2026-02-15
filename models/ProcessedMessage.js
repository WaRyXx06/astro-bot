const mongoose = require('mongoose');

const ProcessedMessageSchema = new mongoose.Schema({
  discordId: {
    type: String,
    required: true,
    unique: true
  },
  channelId: {
    type: String,
    required: true
  },
  // 🆕 ID du message créé sur le serveur mirror
  mirrorMessageId: {
    type: String,
    required: false
  },
  // 🆕 ID du salon mirror où le message a été créé
  mirrorChannelId: {
    type: String,
    required: false
  },
  // 🆕 ID du serveur mirror
  mirrorGuildId: {
    type: String,
    required: false
  },
  // 🆕 Webhook details pour permettre l'édition
  webhookId: {
    type: String,
    required: false
  },
  webhookToken: {
    type: String,
    required: false
  },
  // 🆕 Flag pour indiquer si le message attend un embed
  awaitingEmbed: {
    type: Boolean,
    default: false
  },
  // 🆕 Contenu traité du message (avec mentions converties)
  processedContent: {
    type: String,
    required: false
  },
  processedAt: {
    type: Date,
    default: Date.now
  }
});

// 🧹 Index TTL pour suppression automatique après 15 jours
ProcessedMessageSchema.index({ processedAt: 1 }, {
  expireAfterSeconds: 15 * 24 * 60 * 60 // 15 jours
});

module.exports = mongoose.model('ProcessedMessage', ProcessedMessageSchema); 