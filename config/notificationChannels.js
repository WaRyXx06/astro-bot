/**
 * CONFIGURATION DES SALONS DE NOTIFICATIONS
 * 
 * Ce fichier centralise tous les IDs des salons de notifications
 * pour faciliter leur modification et leur protection automatique.
 */

// 📋 CONFIGURATION PRINCIPALE
const NOTIFICATION_CHANNELS = {
  // 🎯 SALON PRINCIPAL DE MENTIONS
  MENTIONS_LOG: null, // Auto-détection ou création automatique
  
  // 🔄 SALON DE BACKUP (optionnel)
  MENTIONS_BACKUP: null, // Ajoutez un ID si vous voulez un salon de backup
  
  // 📢 SALON D'ANNONCES (optionnel)
  ANNOUNCEMENTS: null, // Pour les annonces importantes
  
  // 🚨 SALON D'ALERTES (optionnel)
  ALERTS: null, // Pour les alertes système
  
  // 🆘 SALON D'ERREURS CRITIQUES (système down)
  ERROR_ALERTS: null, // Auto-détecté : salon "error" dans catégorie Maintenance
};

// 🌍 CONFIGURATION PAR SERVEUR (si vous avez plusieurs serveurs)
const SERVER_SPECIFIC_CHANNELS = {
  // Format: 'ID_DU_SERVEUR': { 'TYPE_DE_SALON': 'ID_DU_SALON' }
  
  // Exemple pour un autre serveur :
  // '1387717123456789012': {
  //   MENTIONS_LOG: '1385968840432816129',
  //   MENTIONS_BACKUP: '1385968840432816130',
  // }
};

// 🎯 CANAL PAR DÉFAUT SI AUCUNE CONFIGURATION SPÉCIFIQUE
const DEFAULT_CHANNEL_TYPE = 'MENTIONS_LOG';

/**
 * Récupère l'ID du salon de notifications pour un serveur
 * @param {string} guildId - ID du serveur Discord
 * @param {string} channelType - Type de salon (MENTIONS_LOG, MENTIONS_BACKUP, etc.)
 * @returns {string|null} - ID du salon ou null si non configuré
 */
function getNotificationChannelId(guildId, channelType = DEFAULT_CHANNEL_TYPE) {
  // 1. Vérifier si le serveur a une configuration spécifique
  if (SERVER_SPECIFIC_CHANNELS[guildId] && SERVER_SPECIFIC_CHANNELS[guildId][channelType]) {
    return SERVER_SPECIFIC_CHANNELS[guildId][channelType];
  }
  
  // 2. Utiliser la configuration par défaut
  if (NOTIFICATION_CHANNELS[channelType]) {
    return NOTIFICATION_CHANNELS[channelType];
  }
  
  // 3. CAS SPÉCIAL : ERROR_ALERTS - Chercher le salon "error" dans la catégorie Maintenance
  if (channelType === 'ERROR_ALERTS') {
    return 'auto-detect-error'; // Signal pour auto-détection du salon error
  }
  
  // 4. Fallback vers le salon principal
  return NOTIFICATION_CHANNELS.MENTIONS_LOG;
}

/**
 * Récupère tous les IDs de salons de notifications configurés
 * @returns {Array<string>} - Liste de tous les IDs configurés (pour protection)
 */
function getAllNotificationChannelIds() {
  const allIds = new Set();
  
  // Ajouter les IDs de la configuration principale
  Object.values(NOTIFICATION_CHANNELS).forEach(id => {
    if (id) allIds.add(id);
  });
  
  // Ajouter les IDs des configurations spécifiques par serveur
  Object.values(SERVER_SPECIFIC_CHANNELS).forEach(serverConfig => {
    Object.values(serverConfig).forEach(id => {
      if (id) allIds.add(id);
    });
  });
  
  return Array.from(allIds);
}

/**
 * Met à jour l'ID d'un salon de notifications
 * @param {string} channelType - Type de salon à modifier
 * @param {string} newChannelId - Nouvel ID du salon
 * @param {string} guildId - ID du serveur (optionnel, pour configuration spécifique)
 */
function updateNotificationChannelId(channelType, newChannelId, guildId = null) {
  if (guildId) {
    // Configuration spécifique au serveur
    if (!SERVER_SPECIFIC_CHANNELS[guildId]) {
      SERVER_SPECIFIC_CHANNELS[guildId] = {};
    }
    SERVER_SPECIFIC_CHANNELS[guildId][channelType] = newChannelId;
  } else {
    // Configuration globale
    NOTIFICATION_CHANNELS[channelType] = newChannelId;
  }
  
  console.log(`✅ Salon de notifications mis à jour: ${channelType} = ${newChannelId}${guildId ? ` (serveur ${guildId})` : ' (global)'}`);
}

/**
 * Auto-détection du salon de notifications si pas configuré
 * @param {Object} guild - Objet guild Discord
 * @returns {string|null} - ID du salon détecté ou null
 */
function autoDetectNotificationChannel(guild) {
  // Rechercher des salons avec des noms typiques
  const typicalNames = [
    'mentions-logs', 'mentions-log', 'mention-logs', 'mention-log',
    'notifications', 'notification-logs', 'notifs',
    'mentions-log-test', 'test-mentions',
    'error', 'errors', 'error-logs', 'system-alerts', 'alerts'
  ];
  
  for (const name of typicalNames) {
    const channel = guild.channels.cache.find(ch => 
      ch.name.toLowerCase() === name.toLowerCase() && ch.type === 0
    );
    if (channel) {
      console.log(`🔍 Salon de notifications auto-détecté: #${channel.name} (${channel.id})`);
      return channel.id;
    }
  }
  
  return null;
}

// 🎯 FONCTIONS D'AIDE POUR LE DEBUGGING
function getConfigurationStatus() {
  return {
    mainChannel: NOTIFICATION_CHANNELS.MENTIONS_LOG,
    backupChannel: NOTIFICATION_CHANNELS.MENTIONS_BACKUP,
    totalConfiguredServers: Object.keys(SERVER_SPECIFIC_CHANNELS).length,
    totalProtectedChannels: getAllNotificationChannelIds().length,
    serverSpecificConfigs: SERVER_SPECIFIC_CHANNELS
  };
}

/**
 * 🆕 Récupère l'ID du salon de notifications depuis la DB en priorité
 * Avec fallback sur la config mémoire si pas trouvé en DB
 * @param {string} guildId - ID du serveur Discord
 * @param {string} channelType - Type de salon (MENTIONS_LOG, MENTIONS_BACKUP, etc.)
 * @returns {Promise<string|null>} - ID du salon ou null si non configuré
 */
async function getNotificationChannelIdFromDB(guildId, channelType = DEFAULT_CHANNEL_TYPE) {
  try {
    // 1. PRIORITÉ: Chercher dans la base de données (config persistante)
    const ServerConfig = require('../models/ServerConfig');
    const config = await ServerConfig.findOne({ guildId });

    if (config?.mentionLogsConfig) {
      if (channelType === 'MENTIONS_LOG' && config.mentionLogsConfig.channelId) {
        return config.mentionLogsConfig.channelId;
      }
      if (channelType === 'MENTIONS_BACKUP' && config.mentionLogsConfig.backupChannelId) {
        return config.mentionLogsConfig.backupChannelId;
      }
    }

    // 2. FALLBACK: Config mémoire (rétrocompatibilité)
    if (SERVER_SPECIFIC_CHANNELS[guildId]?.[channelType]) {
      return SERVER_SPECIFIC_CHANNELS[guildId][channelType];
    }

    // 3. Config globale mémoire
    if (NOTIFICATION_CHANNELS[channelType]) {
      return NOTIFICATION_CHANNELS[channelType];
    }

    // 4. Auto-détection (dernier recours)
    // Note: Nécessite l'objet guild, donc retourne null ici
    // L'appelant devra faire autoDetectNotificationChannel si besoin
    return null;

  } catch (error) {
    console.error('❌ Erreur récupération config notifications depuis DB:', error.message);
    // Fallback sur config mémoire en cas d'erreur DB
    return getNotificationChannelId(guildId, channelType);
  }
}

/**
 * 🆕 Sauvegarde la configuration des notifications en base de données
 * @param {string} guildId - ID du serveur Discord
 * @param {string} channelType - Type de salon (MENTIONS_LOG, MENTIONS_BACKUP)
 * @param {string} channelId - ID du salon à sauvegarder
 * @returns {Promise<boolean>} - true si succès, false si erreur
 */
async function saveNotificationChannelToDB(guildId, channelType, channelId) {
  try {
    const ServerConfig = require('../models/ServerConfig');

    const updateField = channelType === 'MENTIONS_BACKUP'
      ? 'mentionLogsConfig.backupChannelId'
      : 'mentionLogsConfig.channelId';

    await ServerConfig.findOneAndUpdate(
      { guildId },
      {
        $set: {
          [updateField]: channelId,
          'mentionLogsConfig.configuredAt': new Date()
        }
      },
      { upsert: true }
    );

    // Mettre aussi à jour la config mémoire pour cohérence
    updateNotificationChannelId(channelType, channelId, guildId);

    console.log(`✅ Config mention-logs sauvegardée en DB: ${channelType} = ${channelId} (serveur ${guildId})`);
    return true;

  } catch (error) {
    console.error('❌ Erreur sauvegarde config notifications en DB:', error.message);
    return false;
  }
}

/**
 * 🆕 Récupère la configuration complète des mentions depuis la DB
 * @param {string} guildId - ID du serveur Discord
 * @returns {Promise<Object>} - Configuration des mentions ou valeurs par défaut
 */
async function getMentionLogsConfig(guildId) {
  try {
    const ServerConfig = require('../models/ServerConfig');
    const config = await ServerConfig.findOne({ guildId });

    // Retourner config DB ou valeurs par défaut
    return {
      channelId: config?.mentionLogsConfig?.channelId || null,
      backupChannelId: config?.mentionLogsConfig?.backupChannelId || null,
      detectEveryone: config?.mentionLogsConfig?.detectEveryone ?? true,
      detectRoles: config?.mentionLogsConfig?.detectRoles ?? true,
      deduplicationWindow: config?.mentionLogsConfig?.deduplicationWindow || 60000,
      allowBotMentions: config?.mentionLogsConfig?.allowBotMentions || false,
      configuredAt: config?.mentionLogsConfig?.configuredAt || null
    };

  } catch (error) {
    console.error('❌ Erreur récupération config mention-logs:', error.message);
    return {
      channelId: null,
      backupChannelId: null,
      detectEveryone: true,
      detectRoles: true,
      deduplicationWindow: 60000,
      allowBotMentions: false,
      configuredAt: null
    };
  }
}

module.exports = {
  // Fonctions principales
  getNotificationChannelId,
  getAllNotificationChannelIds,
  updateNotificationChannelId,
  autoDetectNotificationChannel,

  // 🆕 Fonctions avec persistance DB
  getNotificationChannelIdFromDB,
  saveNotificationChannelToDB,
  getMentionLogsConfig,

  // Données brutes (pour lecture seulement)
  NOTIFICATION_CHANNELS,
  SERVER_SPECIFIC_CHANNELS,

  // Debugging
  getConfigurationStatus
}; 