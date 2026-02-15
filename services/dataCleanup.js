const ProcessedMessage = require('../models/ProcessedMessage');
const Log = require('../models/Log');
const MemberCount = require('../models/MemberCount');
const RoleMention = require('../models/RoleMention');

class DataCleanupService {
  constructor(client) {
    this.client = client;
    this.retentionDays = 15; // Conserver 15 jours de données (optimisation espace DB)
    this.logger = client?.services?.logger || console;
  }

  /**
   * Méthode générique pour nettoyer les anciennes données
   * @param {Model} Model - Le modèle Mongoose
   * @param {string} dateField - Le champ de date à utiliser (processedAt, timestamp, createdAt)
   * @param {string} label - Label pour le log
   * @returns {Promise<number>} - Nombre d'entrées supprimées
   */
  async cleanOldData(Model, dateField, label) {
    try {
      const cutoffDate = new Date(Date.now() - this.retentionDays * 24 * 60 * 60 * 1000);
      const result = await Model.deleteMany({
        [dateField]: { $lt: cutoffDate }
      });

      console.log(`🧹 ${label}: ${result.deletedCount} entrées supprimées (> ${this.retentionDays} jours)`);
      return result.deletedCount;
    } catch (error) {
      console.error(`❌ Erreur nettoyage ${label}:`, error.message);
      return 0;
    }
  }

  // Nettoyer les anciens messages traités
  async cleanOldProcessedMessages() {
    return this.cleanOldData(ProcessedMessage, 'processedAt', 'ProcessedMessages');
  }

  // Nettoyer les anciens logs
  async cleanOldLogs() {
    return this.cleanOldData(Log, 'timestamp', 'Logs');
  }

  // Nettoyer les anciens comptages de membres
  async cleanOldMemberCounts() {
    return this.cleanOldData(MemberCount, 'timestamp', 'MemberCounts');
  }

  // Nettoyer les anciennes mentions de rôles
  async cleanOldRoleMentions() {
    return this.cleanOldData(RoleMention, 'createdAt', 'RoleMentions');
  }

  // Obtenir les statistiques de stockage
  async getStorageStats() {
    try {
      const stats = {
        processedMessages: await ProcessedMessage.countDocuments(),
        logs: await Log.countDocuments(),
        memberCounts: await MemberCount.countDocuments(),
        roleMentions: await RoleMention.countDocuments(),
        totalDocuments: 0
      };

      stats.totalDocuments = stats.processedMessages + stats.logs +
                             stats.memberCounts + stats.roleMentions;

      return stats;
    } catch (error) {
      console.error('❌ Erreur récupération statistiques:', error.message);
      return null;
    }
  }

  // Effectuer un nettoyage complet
  async performFullCleanup() {
    console.log(`🧹 Début du nettoyage automatique (données > ${this.retentionDays} jours)...`);

    // Obtenir les stats avant nettoyage
    const statsBefore = await this.getStorageStats();
    if (statsBefore) {
      console.log(`📊 Avant nettoyage: ${statsBefore.totalDocuments} documents total`);
    }

    const results = {
      processedMessages: 0,
      logs: 0,
      memberCounts: 0,
      roleMentions: 0,
      totalDeleted: 0,
      errors: []
    };

    try {
      // Nettoyer chaque collection (continue même si une échoue)
      results.processedMessages = await this.cleanOldProcessedMessages();
      results.logs = await this.cleanOldLogs();
      results.memberCounts = await this.cleanOldMemberCounts();
      results.roleMentions = await this.cleanOldRoleMentions();

      results.totalDeleted = results.processedMessages + results.logs +
                             results.memberCounts + results.roleMentions;

      // Obtenir les stats après nettoyage
      const statsAfter = await this.getStorageStats();
      if (statsAfter) {
        console.log(`📊 Après nettoyage: ${statsAfter.totalDocuments} documents restants`);
      }

      if (results.totalDeleted > 0) {
        console.log(`✅ Nettoyage terminé: ${results.totalDeleted} entrées supprimées au total`);

        // Logger le détail si des entrées ont été supprimées
        console.log(`📋 Détail du nettoyage:`);
        console.log(`   - ProcessedMessages: ${results.processedMessages}`);
        console.log(`   - Logs: ${results.logs}`);
        console.log(`   - MemberCounts: ${results.memberCounts}`);
        console.log(`   - RoleMentions: ${results.roleMentions}`);
      } else {
        console.log(`✅ Nettoyage terminé: Aucune donnée à supprimer`);
      }

    } catch (error) {
      console.error('❌ Erreur lors du nettoyage complet:', error);
      results.errors.push(error.message);
    }

    return {
      totalDeleted: results.totalDeleted,
      details: {
        processedMessages: results.processedMessages,
        logs: results.logs,
        memberCounts: results.memberCounts,
        roleMentions: results.roleMentions
      },
      errors: results.errors
    };
  }

  // Définir la période de rétention (en jours)
  setRetentionDays(days) {
    if (days > 0 && days <= 365) {
      this.retentionDays = days;
      console.log(`📅 Période de rétention définie à ${days} jours`);
      return true;
    }
    return false;
  }
}

module.exports = DataCleanupService;
