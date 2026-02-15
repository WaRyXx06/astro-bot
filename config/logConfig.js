// Configuration centralisée pour les niveaux de logging
//
// Niveaux disponibles (via LOG_LEVEL env var):
// - SILENT: Aucun log (dangereux, pas recommandé)
// - ERROR: Erreurs uniquement
// - WARN: Erreurs + Warnings
// - INFO: Erreurs + Warnings + Infos importantes (défaut prod)
// - DEBUG: Tout (développement)
// - TRACE: Tout + traces détaillées

const LOG_LEVELS = {
  SILENT: -1,  // Aucun log (sauf critiques)
  ERROR: 0,    // Erreurs uniquement
  WARN: 1,     // Erreurs + Warnings
  INFO: 2,     // Erreurs + Warnings + Infos importantes
  DEBUG: 3,    // Tout (mode développement)
  TRACE: 4     // Tout + traces détaillées
};

// Niveau de log par défaut - INFO en prod (silencieux mais informatif)
const DEFAULT_LOG_LEVEL = process.env.LOG_LEVEL || 'INFO';

// Configuration des logs à ignorer ou réduire
const LOG_CONFIG = {
  // Niveau de log actuel
  level: LOG_LEVELS[DEFAULT_LOG_LEVEL] !== undefined ? LOG_LEVELS[DEFAULT_LOG_LEVEL] : LOG_LEVELS.INFO,

  // Logs à désactiver complètement
  disabled: {
    botAssociation: true,        // Désactiver les logs d'association de bots webhook
    messageBuffering: true,       // Réduire les logs de buffering
    ignoredServers: true,         // Ne pas logger les messages des autres serveurs
    channelTypeConversion: true,  // Réduire les logs de conversion de type
    handlerCheck: true           // Ne pas logger "Handlers trouvés"
  },

  // Logs à compresser sur une ligne
  compressed: {
    messageProcessing: true,      // Compresser le traitement des messages
    webhookOperations: true,      // Compresser les opérations webhook
    channelSearch: true          // Compresser la recherche de canaux
  },

  // Limites de répétition (éviter le spam)
  rateLimits: {
    errorThrottle: 60000,        // Ne pas répéter la même erreur pendant 60s
    warningThrottle: 30000       // Ne pas répéter le même warning pendant 30s
  }
};

// Fonction helper pour vérifier si un log doit être affiché
function shouldLog(level) {
  const levelValue = typeof level === 'string' ? LOG_LEVELS[level] : level;
  return levelValue <= LOG_CONFIG.level;
}

// Fonction pour logger avec niveau
function log(level, category, message, ...args) {
  // Vérifier le niveau
  if (!shouldLog(level)) return;

  // Vérifier si la catégorie est désactivée
  if (LOG_CONFIG.disabled[category]) return;

  // Logger selon le niveau
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp.split('T')[1].split('.')[0]}]`;

  switch(level) {
    case LOG_LEVELS.ERROR:
      console.error(`${prefix} ❌`, message, ...args);
      break;
    case LOG_LEVELS.WARN:
      console.warn(`${prefix} ⚠️`, message, ...args);
      break;
    case LOG_LEVELS.INFO:
      console.log(`${prefix} ℹ️`, message, ...args);
      break;
    case LOG_LEVELS.DEBUG:
      console.log(`${prefix} 🔍`, message, ...args);
      break;
    case LOG_LEVELS.TRACE:
      console.log(`${prefix} 🔬`, message, ...args);
      break;
  }
}

// Fonction pour créer un logger avec contexte
function createLogger(context) {
  return {
    error: (category, message, ...args) => log(LOG_LEVELS.ERROR, category, `[${context}] ${message}`, ...args),
    warn: (category, message, ...args) => log(LOG_LEVELS.WARN, category, `[${context}] ${message}`, ...args),
    info: (category, message, ...args) => log(LOG_LEVELS.INFO, category, `[${context}] ${message}`, ...args),
    debug: (category, message, ...args) => log(LOG_LEVELS.DEBUG, category, `[${context}] ${message}`, ...args),
    trace: (category, message, ...args) => log(LOG_LEVELS.TRACE, category, `[${context}] ${message}`, ...args),
  };
}

// Fonction pour logger un message traité de manière compressée
function logCompressedMessage(messageId, author, channel, status) {
  if (!shouldLog(LOG_LEVELS.INFO)) return;

  const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
  console.log(`[${timestamp}] 📨 MSG#${messageId.slice(-6)} | ${author} → #${channel} | ${status}`);
}

// Fonction pour logger un succès de message traité (1 ligne unique)
// Format: [HH:MM:SS] ✅ MSG#XXXXXX | Author → #channel | XKB
function logMessageSuccess(messageId, author, channel, sizeKB) {
  if (!shouldLog(LOG_LEVELS.INFO)) return;

  const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
  const shortId = messageId ? messageId.slice(-6) : '??????';
  const size = sizeKB ? `${sizeKB}KB` : '';
  console.log(`[${timestamp}] ✅ ${shortId} | ${author} → #${channel}${size ? ` | ${size}` : ''}`);
}

// Fonction pour logger une édition de message (1 ligne)
function logMessageEdit(author, channel) {
  if (!shouldLog(LOG_LEVELS.INFO)) return;

  const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
  console.log(`[${timestamp}] ✏️ EDIT | ${author} → #${channel}`);
}

// Fonction pour vérifier si on est en mode debug
function isDebugMode() {
  return LOG_CONFIG.level >= LOG_LEVELS.DEBUG;
}

module.exports = {
  LOG_LEVELS,
  LOG_CONFIG,
  shouldLog,
  log,
  createLogger,
  logCompressedMessage,
  logMessageSuccess,
  logMessageEdit,
  isDebugMode
};