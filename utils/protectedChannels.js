/**
 * GESTION CENTRALISÉE DES SALONS PROTÉGÉS
 * 
 * Ce fichier centralise la liste de tous les salons qui ne doivent JAMAIS être supprimés
 * par les systèmes automatiques (auto-discovery, nettoyage, etc.)
 */

/**
 * Liste des salons protégés par nom
 * Ces salons ne seront jamais supprimés automatiquement
 */
const PROTECTED_CHANNEL_NAMES = [
  // Salons de maintenance système
  'newroom',
  'error',
  'roles-logs',
  'admin-logs',
  'members-log',
  'members-logs',
  'membres-dangereux',
  'commands',
  'chat-staff',
  'roles',

  // Salons de notifications de mentions
  'mentions-logs',
  'mentions-log',
  'notifications',
  'notification-logs',
  'mention-notifications',

  // Salons de logs généraux
  'logs',
  'bot-logs',
  'system-logs',
  'activity-logs'
];

/**
 * Liste des IDs de salons protégés
 * Protection par ID pour les salons spécifiques critiques
 */
const PROTECTED_CHANNEL_IDS = [
  '1387761593760354435', // Salon mentions-logs principal
  // Ajoutez ici d'autres IDs de salons critiques si nécessaire
];

/**
 * Liste des patterns de noms protégés
 * Salons dont le nom correspond à ces patterns sont protégés
 */
const PROTECTED_NAME_PATTERNS = [
  /^mentions?-logs?$/i,        // mentions-logs, mention-log, etc.
  /^notifications?$/i,         // notifications, notification
  /^logs?$/i,                  // logs, log
  /^admin-/i,                  // tout salon commençant par admin-
  /^bot-/i,                    // tout salon commençant par bot-
  /^system-/i,                 // tout salon commençant par system-
  /-logs?$/i,                  // tout salon finissant par -logs ou -log
];

/**
 * Vérifier si un salon est protégé par son nom
 * @param {string} channelName - Nom du salon
 * @returns {boolean} - True si le salon est protégé
 */
function isChannelProtectedByName(channelName) {
  if (!channelName) return false;
  
  // Vérification exacte dans la liste
  if (PROTECTED_CHANNEL_NAMES.includes(channelName.toLowerCase())) {
    return true;
  }
  
  // Vérification par patterns
  return PROTECTED_NAME_PATTERNS.some(pattern => pattern.test(channelName));
}

/**
 * Vérifier si un salon est protégé par son ID
 * @param {string} channelId - ID du salon
 * @returns {boolean} - True si le salon est protégé
 */
function isChannelProtectedById(channelId) {
  if (!channelId) return false;
  return PROTECTED_CHANNEL_IDS.includes(channelId);
}

/**
 * Vérifier si un salon est protégé (par nom OU par ID)
 * @param {string} channelName - Nom du salon
 * @param {string} channelId - ID du salon (optionnel)
 * @returns {boolean} - True si le salon est protégé
 */
function isChannelProtected(channelName, channelId = null) {
  return isChannelProtectedByName(channelName) || isChannelProtectedById(channelId);
}

/**
 * Obtenir la raison de la protection d'un salon
 * @param {string} channelName - Nom du salon
 * @param {string} channelId - ID du salon (optionnel)
 * @returns {string|null} - Raison de la protection ou null si pas protégé
 */
function getProtectionReason(channelName, channelId = null) {
  if (isChannelProtectedById(channelId)) {
    return `Salon protégé par ID critique (${channelId})`;
  }
  
  if (PROTECTED_CHANNEL_NAMES.includes(channelName?.toLowerCase())) {
    return `Salon de maintenance système (${channelName})`;
  }
  
  if (channelName && /mentions?-logs?|notifications?/i.test(channelName)) {
    return `Salon de notifications de mentions (${channelName})`;
  }
  
  if (channelName && /-logs?$/i.test(channelName)) {
    return `Salon de logs système (${channelName})`;
  }
  
  for (const pattern of PROTECTED_NAME_PATTERNS) {
    if (pattern.test(channelName)) {
      return `Salon protégé par pattern (${channelName})`;
    }
  }
  
  return null;
}

/**
 * Ajouter un salon à la protection par nom
 * @param {string} channelName - Nom du salon à protéger
 */
function addProtectedChannelName(channelName) {
  if (channelName && !PROTECTED_CHANNEL_NAMES.includes(channelName.toLowerCase())) {
    PROTECTED_CHANNEL_NAMES.push(channelName.toLowerCase());
    console.log(`🛡️ Salon ajouté à la protection: ${channelName}`);
  }
}

/**
 * Ajouter un salon à la protection par ID
 * @param {string} channelId - ID du salon à protéger
 */
function addProtectedChannelId(channelId) {
  if (channelId && !PROTECTED_CHANNEL_IDS.includes(channelId)) {
    PROTECTED_CHANNEL_IDS.push(channelId);
    console.log(`🛡️ Salon ajouté à la protection par ID: ${channelId}`);
  }
}

/**
 * Obtenir toutes les informations de protection
 * @returns {Object} - Informations complètes sur les protections
 */
function getProtectionInfo() {
  return {
    protectedNames: [...PROTECTED_CHANNEL_NAMES],
    protectedIds: [...PROTECTED_CHANNEL_IDS],
    protectedPatterns: PROTECTED_NAME_PATTERNS.map(p => p.toString()),
    totalProtected: PROTECTED_CHANNEL_NAMES.length + PROTECTED_CHANNEL_IDS.length
  };
}

/**
 * Vérifier et logger la tentative de suppression d'un salon protégé
 * @param {string} channelName - Nom du salon
 * @param {string} channelId - ID du salon
 * @param {string} action - Action tentée (ex: "nettoyage automatique")
 * @returns {boolean} - True si l'action doit être bloquée
 */
function checkAndLogProtection(channelName, channelId, action = "suppression") {
  const protectionReason = getProtectionReason(channelName, channelId);
  
  if (protectionReason) {
    console.log(`🛡️ ${action} bloqué pour salon protégé: ${channelName || channelId}`);
    console.log(`🔒 Raison de protection: ${protectionReason}`);
    return true; // Bloquer l'action
  }
  
  return false; // Autoriser l'action
}

module.exports = {
  // Fonctions principales
  isChannelProtected,
  isChannelProtectedByName,
  isChannelProtectedById,
  getProtectionReason,
  checkAndLogProtection,
  
  // Gestion dynamique
  addProtectedChannelName,
  addProtectedChannelId,
  
  // Informations
  getProtectionInfo,
  
  // Constantes (pour compatibilité avec l'ancien code)
  PROTECTED_CHANNEL_NAMES,
  PROTECTED_CHANNEL_IDS
}; 