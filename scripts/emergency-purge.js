require('dotenv').config();
const mongoose = require('mongoose');
const ProcessedMessage = require('../models/ProcessedMessage');
const Log = require('../models/Log');
const MemberDetail = require('../models/MemberDetail');
const MemberCount = require('../models/MemberCount');
const RoleMention = require('../models/RoleMention');

/**
 * 🚨 EMERGENCY PURGE - Libération immédiate d'espace MongoDB
 *
 * ⚠️ ATTENTION: Ce script supprime TOUTES les données temporaires:
 * - ProcessedMessage (messages traités)
 * - Log (logs système)
 * - MemberDetail (détails membres)
 * - MemberCount (comptages membres)
 * - RoleMention (mentions de rôles)
 *
 * ✅ Collections PRÉSERVÉES (critiques):
 * - ServerConfig (configuration serveurs)
 * - Channel (mappings canaux)
 * - Role (rôles synchronisés)
 * - Category (catégories)
 * - MentionBlacklist (blacklist)
 *
 * 💡 Impact: AUCUN sur le fonctionnement du bot
 * 📊 Gain estimé: 50-90% de l'espace MongoDB
 */

async function emergencyPurge() {
  console.log('\n');
  console.log('════════════════════════════════════════════════════════════');
  console.log('  🚨 EMERGENCY PURGE - LIBÉRATION ESPACE MONGODB');
  console.log('════════════════════════════════════════════════════════════');
  console.log('⚠️  ATTENTION: Suppression de TOUTES les données temporaires');
  console.log('⚠️  Cette action est IRRÉVERSIBLE');
  console.log('✅  Impact: AUCUN sur le fonctionnement du bot');
  console.log('════════════════════════════════════════════════════════════\n');

  try {
    const mongoUri = process.env.MONGODB_URI;

    if (!mongoUri) {
      console.error('❌ MONGODB_URI non définie dans .env');
      process.exit(1);
    }

    console.log('📡 Connexion à MongoDB...');
    await mongoose.connect(mongoUri);
    console.log('✅ Connecté à MongoDB\n');

    // ═══════════════════════════════════════════════════════════
    // PHASE 1: ANALYSE AVANT PURGE
    // ═══════════════════════════════════════════════════════════
    console.log('📊 PHASE 1: ANALYSE AVANT PURGE');
    console.log('─────────────────────────────────────────────────────────\n');

    const statsBefore = {
      processedMessages: await ProcessedMessage.countDocuments(),
      logs: await Log.countDocuments(),
      memberDetails: await MemberDetail.countDocuments(),
      memberCounts: await MemberCount.countDocuments(),
      roleMentions: await RoleMention.countDocuments()
    };

    const totalBefore = Object.values(statsBefore).reduce((a, b) => a + b, 0);

    console.log('📋 Collections temporaires (à supprimer):');
    console.log(`   ProcessedMessage : ${statsBefore.processedMessages.toLocaleString()} documents`);
    console.log(`   Log              : ${statsBefore.logs.toLocaleString()} documents`);
    console.log(`   MemberDetail     : ${statsBefore.memberDetails.toLocaleString()} documents`);
    console.log(`   MemberCount      : ${statsBefore.memberCounts.toLocaleString()} documents`);
    console.log(`   RoleMention      : ${statsBefore.roleMentions.toLocaleString()} documents`);
    console.log(`   ─────────────────────────────────────────────────────`);
    console.log(`   TOTAL            : ${totalBefore.toLocaleString()} documents\n`);

    // Estimation de l'espace (moyenne ~0.5KB par document)
    const estimatedSizeMB = Math.round((totalBefore * 0.5) / 1024);
    console.log(`💾 Espace estimé à libérer: ~${estimatedSizeMB}MB\n`);

    if (totalBefore === 0) {
      console.log('✅ Aucune donnée à supprimer, collections déjà vides');
      await mongoose.connection.close();
      process.exit(0);
    }

    // ═══════════════════════════════════════════════════════════
    // PHASE 2: PURGE DES COLLECTIONS
    // ═══════════════════════════════════════════════════════════
    console.log('🗑️  PHASE 2: PURGE DES COLLECTIONS TEMPORAIRES');
    console.log('─────────────────────────────────────────────────────────\n');

    const startTime = Date.now();
    const results = {};

    // 1. ProcessedMessage (généralement la plus volumineuse)
    console.log('🧹 [1/5] Purge ProcessedMessage...');
    const pmStart = Date.now();
    results.processedMessages = await ProcessedMessage.deleteMany({});
    console.log(`   ✅ ${results.processedMessages.deletedCount.toLocaleString()} supprimés (${Date.now() - pmStart}ms)\n`);

    // 2. Log
    console.log('🧹 [2/5] Purge Log...');
    const logStart = Date.now();
    results.logs = await Log.deleteMany({});
    console.log(`   ✅ ${results.logs.deletedCount.toLocaleString()} supprimés (${Date.now() - logStart}ms)\n`);

    // 3. MemberDetail (peut être très volumineuse avec historique)
    console.log('🧹 [3/5] Purge MemberDetail...');
    const mdStart = Date.now();
    results.memberDetails = await MemberDetail.deleteMany({});
    console.log(`   ✅ ${results.memberDetails.deletedCount.toLocaleString()} supprimés (${Date.now() - mdStart}ms)\n`);

    // 4. MemberCount
    console.log('🧹 [4/5] Purge MemberCount...');
    const mcStart = Date.now();
    results.memberCounts = await MemberCount.deleteMany({});
    console.log(`   ✅ ${results.memberCounts.deletedCount.toLocaleString()} supprimés (${Date.now() - mcStart}ms)\n`);

    // 5. RoleMention
    console.log('🧹 [5/5] Purge RoleMention...');
    const rmStart = Date.now();
    results.roleMentions = await RoleMention.deleteMany({});
    console.log(`   ✅ ${results.roleMentions.deletedCount.toLocaleString()} supprimés (${Date.now() - rmStart}ms)\n`);

    const totalDuration = Date.now() - startTime;
    const totalDeleted =
      results.processedMessages.deletedCount +
      results.logs.deletedCount +
      results.memberDetails.deletedCount +
      results.memberCounts.deletedCount +
      results.roleMentions.deletedCount;

    // ═══════════════════════════════════════════════════════════
    // PHASE 3: VÉRIFICATION APRÈS PURGE
    // ═══════════════════════════════════════════════════════════
    console.log('📋 PHASE 3: VÉRIFICATION APRÈS PURGE');
    console.log('─────────────────────────────────────────────────────────\n');

    const statsAfter = {
      processedMessages: await ProcessedMessage.countDocuments(),
      logs: await Log.countDocuments(),
      memberDetails: await MemberDetail.countDocuments(),
      memberCounts: await MemberCount.countDocuments(),
      roleMentions: await RoleMention.countDocuments()
    };

    const totalAfter = Object.values(statsAfter).reduce((a, b) => a + b, 0);

    console.log('📊 Collections après purge:');
    console.log(`   ProcessedMessage : ${statsAfter.processedMessages.toLocaleString()} documents`);
    console.log(`   Log              : ${statsAfter.logs.toLocaleString()} documents`);
    console.log(`   MemberDetail     : ${statsAfter.memberDetails.toLocaleString()} documents`);
    console.log(`   MemberCount      : ${statsAfter.memberCounts.toLocaleString()} documents`);
    console.log(`   RoleMention      : ${statsAfter.roleMentions.toLocaleString()} documents`);
    console.log(`   ─────────────────────────────────────────────────────`);
    console.log(`   TOTAL            : ${totalAfter.toLocaleString()} documents\n`);

    // ═══════════════════════════════════════════════════════════
    // RÉSUMÉ FINAL
    // ═══════════════════════════════════════════════════════════
    console.log('\n✅ EMERGENCY PURGE TERMINÉE!');
    console.log('════════════════════════════════════════════════════════════');
    console.log(`📊 Documents supprimés : ${totalDeleted.toLocaleString()}`);
    console.log(`💾 Espace libéré       : ~${estimatedSizeMB}MB`);
    console.log(`⏱️  Durée totale        : ${totalDuration}ms`);
    console.log(`📉 Réduction           : ${Math.round((totalDeleted / totalBefore) * 100)}%`);
    console.log('════════════════════════════════════════════════════════════\n');

    console.log('✅ Collections critiques PRÉSERVÉES:');
    console.log('   ✓ ServerConfig (configuration serveurs)');
    console.log('   ✓ Channel (mappings canaux)');
    console.log('   ✓ Role (rôles synchronisés)');
    console.log('   ✓ Category (catégories)');
    console.log('   ✓ MentionBlacklist (blacklist)\n');

    console.log('🔄 Prochaines étapes:');
    console.log('   1. Redémarrer le bot (Coolify auto-restart)');
    console.log('   2. Vérifier les logs dans Coolify');
    console.log('   3. Le bot continuera à fonctionner normalement');
    console.log('   4. Les nouvelles données seront automatiquement créées\n');

    await mongoose.connection.close();
    console.log('📡 Déconnexion MongoDB');
    console.log('🎉 Script terminé avec succès!\n');

    process.exit(0);

  } catch (error) {
    console.error('\n❌ ERREUR LORS DE LA PURGE EMERGENCY:');
    console.error('════════════════════════════════════════════════════════════');
    console.error('Message:', error.message);
    console.error('Stack:', error.stack);
    console.error('════════════════════════════════════════════════════════════\n');

    try {
      await mongoose.connection.close();
    } catch (closeError) {
      console.error('Erreur lors de la fermeture de connexion:', closeError.message);
    }

    process.exit(1);
  }
}

// Lancer le script avec un délai de 2 secondes pour lire le warning
console.log('\n⏳ Lancement dans 2 secondes...');
console.log('💡 Press Ctrl+C pour annuler\n');

setTimeout(() => {
  emergencyPurge();
}, 2000);
