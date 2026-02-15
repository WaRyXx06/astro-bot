require('dotenv').config();
const mongoose = require('mongoose');
const Log = require('../models/Log');

async function purgeLogs() {
  console.log('🧹 PURGE DES LOGS - Script de nettoyage immédiat\n');

  try {
    const mongoUri = process.env.MONGODB_URI;

    if (!mongoUri) {
      console.error('❌ MONGODB_URI non définie dans .env');
      process.exit(1);
    }

    console.log('📡 Connexion à MongoDB...');
    await mongoose.connect(mongoUri);
    console.log('✅ Connecté à MongoDB\n');

    console.log('📊 Analyse avant purge...');
    const countBefore = await Log.countDocuments();
    console.log(`   Total de logs actuels: ${countBefore}`);

    if (countBefore === 0) {
      console.log('\n✅ Aucun log à supprimer, collection déjà vide');
      await mongoose.connection.close();
      process.exit(0);
    }

    const estimatedSize = Math.round((countBefore * 0.5) / 1024);
    console.log(`   Espace estimé: ~${estimatedSize}MB\n`);

    console.log('🗑️  Suppression de TOUS les logs en cours...');
    const startTime = Date.now();

    const result = await Log.deleteMany({});

    const duration = Date.now() - startTime;

    console.log('\n✅ PURGE TERMINÉE!');
    console.log('═══════════════════════════════════════');
    console.log(`📊 Logs supprimés: ${result.deletedCount}`);
    console.log(`💾 Espace libéré: ~${estimatedSize}MB`);
    console.log(`⏱️  Durée: ${duration}ms`);
    console.log('═══════════════════════════════════════\n');

    console.log('📋 Vérification après purge...');
    const countAfter = await Log.countDocuments();
    console.log(`   Total de logs restants: ${countAfter}`);

    if (countAfter === 0) {
      console.log('✅ Collection logs entièrement purgée\n');
    } else {
      console.log(`⚠️  ${countAfter} logs restants (possible condition de course)\n`);
    }

    await mongoose.connection.close();
    console.log('📡 Déconnexion MongoDB\n');
    console.log('🎉 Script terminé avec succès!');

    process.exit(0);

  } catch (error) {
    console.error('\n❌ ERREUR LORS DE LA PURGE:');
    console.error('═══════════════════════════════════════');
    console.error(error.message);
    console.error('═══════════════════════════════════════\n');

    try {
      await mongoose.connection.close();
    } catch (closeError) {
      console.error('Erreur lors de la fermeture de connexion:', closeError.message);
    }

    process.exit(1);
  }
}

console.log('\n');
console.log('════════════════════════════════════════════════════');
console.log('  🧹 PURGE IMMÉDIATE DES LOGS SYSTÈME');
console.log('════════════════════════════════════════════════════');
console.log('⚠️  ATTENTION: Cette opération supprime TOUS les logs');
console.log('⚠️  Cette action est IRRÉVERSIBLE');
console.log('════════════════════════════════════════════════════\n');

setTimeout(() => {
  purgeLogs();
}, 1000);