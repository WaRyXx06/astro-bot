const mongoose = require('mongoose');

const ServerSchema = new mongoose.Schema({
  discordId: {
    type: String,
    required: true,
    unique: true
  },
  name: {
    type: String,
    required: true
  },
  addedAt: {
    type: Date,
    default: Date.now
  },
  active: {
    type: Boolean,
    default: true
  }
});

module.exports = mongoose.model('Server', ServerSchema); 