// Bot version 1.0.1 - Fix sync
require('dotenv').config();
const { Client, GatewayIntentBits, Collection, REST, Routes, PermissionFlagsBits, Options } = require('discord.js');
const connectDB = require('./config/database');
const LoggerService = require('./services/logger');
const ChannelManager = require('./services/channelManager');
const RoleManager = require('./services/roleManager');
const ScraperService = require('./services/scraper');
const UserClientService = require('./services/userClient');
const MentionNotifierService = require('./services/mentionNotifier');
const ChannelMonitorService = require('./services/channelMonitor');
const MemberTrackerService = require('./services/memberTracker');
const MemberDetectionService = require('./services/memberDetectionService');
const ActivityMonitorService = require('./services/activityMonitor');
const { ensureSystemRoles, filterSafePermissions, analyzeRolePermissions } = require('./utils/permissions');
const { isChannelProtected, checkAndLogProtection, getProtectionInfo, addProtectedChannelId } = require('./utils/protectedChannels');
const cron = require('node-cron');

// 🚨 HANDLERS D'EXCEPTIONS GLOBAUX POUR CAPTURER LES ERREURS NON GÉRÉES
process.on('uncaughtException', (error) => {
  console.error('🚨🚨🚨 UNCAUGHT EXCEPTION DÉTECTÉE 🚨🚨🚨');
  console.error('Timestamp:', new Date().toISOString());
  console.error('Error name:', error.name);
  console.error('Error message:', error.message);
  console.error('Stack trace:', error.stack);
  console.error('Full error object:', error);
  console.error('🚨🚨🚨 FIN DE L\'EXCEPTION NON GÉRÉE 🚨🚨🚨');

  // Logger l'erreur mais ne pas faire process.exit immédiatement
  // pour laisser le temps aux logs d'être envoyés
  setTimeout(() => {
    console.error('❌ Exception non gérée - Arrêt du bot');
    process.exit(1);
  }, 2000);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🚨🚨🚨 UNHANDLED REJECTION DÉTECTÉE 🚨🚨🚨');
  console.error('Timestamp:', new Date().toISOString());
  console.error('Reason:', reason);
  console.error('Promise:', promise);
  if (reason instanceof Error) {
    console.error('Error stack:', reason.stack);
  }
  console.error('🚨🚨🚨 FIN DE LA REJECTION NON GÉRÉE 🚨🚨🚨');

  // Ne pas arrêter le bot sur une promise rejetée, juste logger
  // car souvent c'est moins critique qu'une exception
});

// Initialisation du client Discord (Bot officiel)
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent
  ],
  // Limiter la taille des caches en mémoire pour éviter les memory leaks
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: 100,       // Max 100 messages par salon (au lieu d'infini)
    UserManager: 500,          // Max 500 users en cache global
    PresenceManager: 0,        // Pas besoin des presences
    VoiceStateManager: 0,      // Pas besoin des voice states
    ReactionManager: 0,        // Pas besoin des reactions
    ReactionUserManager: 0,    // Pas besoin des reaction users
    // GuildMemberManager: garder défaut (members.me utilisé pour permission checks)
    // GuildEmojiManager: garder défaut (emojis.cache utilisé pour mirror reactions)
  }),
  // Sweepers pour nettoyer périodiquement les caches restants
  sweepers: {
    messages: {
      interval: 300,    // Nettoyer toutes les 5 min
      lifetime: 1800    // Supprimer messages > 30 min
    },
    users: {
      interval: 3600,   // Nettoyer toutes les heures
      filter: () => (user) => !user.bot  // Garder les bots (webhooks), sweep les users
    },
    guildMembers: {
      interval: 3600,   // Nettoyer toutes les heures
      filter: () => (member) => !member.user.bot  // Garder les bots, sweep les membres humains
    },
    threads: {
      interval: 3600,   // Nettoyer toutes les heures
      lifetime: 7200    // Supprimer threads > 2h
    }
  }
});

// Collections pour stocker les commandes et services
client.commands = new Collection();
client.services = {
  logger: null,
  channelManager: null,
  roleManager: null,
  scraper: null,
  userClient: null,
  mentionNotifier: null,
  channelMonitor: null,
  memberTracker: null,
  activityMonitor: null,
  memberDetection: null
};

// Variables globales
let botInitialized = false;
let botStartTimestamp = null; // 🆕 Timestamp de démarrage du bot

// 🚀 NOUVEAU: Import de la configuration des commandes
const { GLOBAL_COMMANDS, GUILD_COMMANDS } = require('./config/commandsConfig');

// 🚀 NOUVEAU: Fonction pour déployer les commandes
async function deployCommands() {
  try {

    // 1. Déployer les commandes globales (admin)
    const globalCommands = await client.application.commands.set(GLOBAL_COMMANDS);

    // 2. Déployer les commandes par guilde
    // FIX: Utiliser ServerConfig au lieu de Server, et botInitialized au lieu de initialized
    const ServerConfig = require('./models/ServerConfig');
    const servers = await ServerConfig.find({ botInitialized: true });


    // Créer un Set pour tracker les guilds déjà traitées
    const deployedGuilds = new Set();

    for (const serverConfig of servers) {
      try {
        const guild = client.guilds.cache.get(serverConfig.guildId);
        if (guild) {
          // Déployer les commandes spécifiques à cette guilde
          const guildCommands = await guild.commands.set(GUILD_COMMANDS);
          deployedGuilds.add(guild.id);
        } else {
        }
      } catch (error) {
        console.error(`❌ Erreur déploiement commandes pour ${serverConfig.guildId}:`, error);
      }
    }

    // 3. NOUVEAU: Déployer aussi sur TOUS les serveurs où le bot est présent (fallback)
    for (const guild of client.guilds.cache.values()) {
      if (!deployedGuilds.has(guild.id)) {
        try {
          const guildCommands = await guild.commands.set(GUILD_COMMANDS);
        } catch (error) {
          console.error(`❌ Erreur déploiement fallback pour ${guild.name}:`, error.message);
        }
      }
    }

  } catch (error) {
    console.error('❌ Erreur lors du déploiement des commandes:', error);
  }
}

// Commandes slash (conservées pour référence, mais non utilisées directement)
const commands = [
  // Commandes Admin
  {
    name: 'initialise',
    description: 'Initialisation complète du bot mirror',
  },
  {
    name: 'addservor',
    description: '🔐 Connecter votre token utilisateur et configurer le serveur source',
    options: [
      {
        name: 'token',
        type: 3, // STRING
        description: 'Votre token utilisateur Discord',
        required: true
      },
      {
        name: 'server_id',
        type: 3, // STRING
        description: 'ID du serveur source à mirror (optionnel si un seul serveur accessible)',
        required: false
      }
    ]
  },
  {
    name: 'listservor',
    description: '📋 Lister les serveurs accessibles avec votre token',
    options: [
      {
        name: 'token',
        type: 3, // STRING
        description: 'Votre token utilisateur Discord',
        required: true
      }
    ]
  },
  {
    name: 'clone',
    description: 'Clonage automatique avec filtration',
    options: [
      {
        name: 'filter_inactive',
        type: 5, // BOOLEAN
        description: 'Filtrer les salons inactifs',
        required: false
      }
    ]
  },
  {
    name: 'start',
    description: 'Démarrer le scraping automatique'
  },
  {
    name: 'stop',
    description: 'Arrêter le scraping automatique'
  },
  {
    name: 'addroom',
    description: 'Ajouter un salon manuellement',
    options: [{
      name: 'channel_id',
      type: 3, // STRING
      description: 'ID du salon (serveur source OU mirror) à ajouter',
      required: true
    }]
  },
  {
    name: 'delroom',
    description: 'Supprimer un salon',
    options: [{
      name: 'channel_name',
      type: 3, // STRING
      description: 'Nom ou ID du salon à supprimer',
      required: true
    }]
  },
  {
    name: 'syncroles',
    description: 'Synchronisation des rôles'
  },
  {
    name: 'sync-correspondances',
    description: 'Synchroniser les correspondances entre serveur distant et mirror (rôles et salons)'
  },
  {
    name: 'fix-correspondances',
    description: 'Réparer les correspondances de salons manquantes (corrige #inconnu)'
  },
  {
    name: 'fix-mappings',
    description: '🔧 Réparer TOUS les mappings de salons (DB + cache) - Solution complète'
  },
  {
    name: 'setup-roles',
    description: 'Créer un système de rôles automatique pour les utilisateurs'
  },
  {
    name: 'disconnect',
    description: 'Déconnecter le token utilisateur et arrêter le mirror'
  },
  {
    name: 'discovery',
    description: 'Lancer manuellement la détection de nouveaux salons'
  },
  {
    name: 'monitor',
    description: '🔍 Gestion de la surveillance automatique des nouveaux salons (10min)',
    options: [
      {
        name: 'action',
        type: 3, // STRING
        description: 'Action à effectuer',
        required: true,
        choices: [
          { name: 'Démarrer la surveillance', value: 'start' },
          { name: 'Arrêter la surveillance', value: 'stop' },
          { name: 'Vérification manuelle immédiate', value: 'check' },
          { name: 'Changer la fréquence', value: 'frequency' }
        ]
      },
      {
        name: 'minutes',
        type: 4, // INTEGER
        description: 'Nouvelle fréquence en minutes (min 1, défaut 10)',
        required: false,
        min_value: 1,
        max_value: 1440
      }
    ]
  },
  {
    name: 'monitor-status',
    description: '📊 Statut de la surveillance automatique des nouveaux salons'
  },
  {
    name: 'retry-blocked',
    description: 'Réactiver manuellement les salons blacklistés (accès refusé)'
  },
  {
    name: 'cleanup',
    description: 'Nettoyer automatiquement les salons mirror supprimés de la base de données'
  },
  {
    name: 'delcategories',
    description: 'Supprimer une catégorie entière avec tous ses salons',
    options: [{
      name: 'category_id',
      type: 3, // STRING
      description: 'ID de la catégorie à supprimer (avec tous ses salons)',
      required: true
    }]
  },

  
  // Commandes Publiques
  {
    name: 'commandes',
    description: 'Liste des commandes disponibles'
  },
  {
    name: 'listroom',
    description: 'Vue préfiltrée des salons'
  },

  {
    name: 'seeroom',
    description: 'Voir les 50 derniers messages d\'un salon',
    options: [{
      name: 'channel_id',
      type: 3, // STRING
      description: 'ID du salon',
      required: false
    }]
  },
  {
    name: 'roles',
    description: 'Gestion des rôles'
  },
  {
    name: 'status',
    description: 'Statut du système de mirror'
  },
  {
    name: 'filter',
    description: 'Affiche les catégories et salons ignorés pour éviter le rate limiting'
  },

  {
    name: 'dashboard',
    description: 'Tableau de bord en temps réel du système Mirror'
  },
  {
    name: 'activateall',
    description: '🚀 Activer tous les salons pour le scraping temps réel (mode événementiel)'
  },
  {
    name: 'blacklist',
    description: '🚫 Gestion de la blacklist des salons (accès refusé)',
    options: [
      {
        name: 'action',
        type: 3, // STRING
        description: 'Action à effectuer',
        required: true,
        choices: [
          { name: 'Voir la liste', value: 'list' },
          { name: 'Supprimer un salon', value: 'remove' },
          { name: 'Ajouter un salon', value: 'add' },
          { name: 'Nettoyer tout', value: 'clear' }
        ]
      },
      {
        name: 'channel_name',
        type: 3, // STRING
        description: 'Nom du salon (pour ajouter/supprimer)',
        required: false
      }
    ]
  },
  {
    name: 'undelete',
    description: '🔄 Réactiver un salon ou une catégorie marqué(e) comme supprimé(e) manuellement',
    options: [
      {
        name: 'name',
        type: 3, // STRING
        description: 'Nom du salon ou de la catégorie à réactiver',
        required: true
      },
      {
        name: 'type',
        type: 3, // STRING
        description: 'Type à réactiver',
        required: false,
        choices: [
          {
            name: 'Salon (défaut)',
            value: 'channel'
          },
          {
            name: 'Catégorie',
            value: 'category'
          }
        ]
      }
    ]
  },
  {
    name: 'restore-maintenance',
    description: '🛡️ Restaurer les salons de maintenance supprimés (chat-staff, roles)'
  },

  {
    name: 'protected-channels',
    description: '🛡️ Gestion des salons protégés contre la suppression automatique',
    options: [
      {
        name: 'action',
        type: 3, // STRING
        description: 'Action à effectuer',
        required: true,
        choices: [
          { name: 'Voir la liste des salons protégés', value: 'list' },
          { name: 'Ajouter un salon par nom', value: 'add_name' },
          { name: 'Ajouter un salon par ID', value: 'add_id' },
          { name: 'Vérifier un salon', value: 'check' }
        ]
      },
      {
        name: 'value',
        type: 3, // STRING
        description: 'Nom ou ID du salon (selon l\'action choisie)',
        required: false
      }
    ]
  },
  {
    name: 'notification-channels',
    description: '🔔 Gestion de la configuration des salons de notifications',
    options: [
      {
        name: 'action',
        type: 3, // STRING
        description: 'Action à effectuer',
        required: true,
        choices: [
          { name: 'Voir la configuration actuelle', value: 'show' },
          { name: 'Modifier le salon principal', value: 'set_main' },
          { name: 'Modifier le salon de backup', value: 'set_backup' },
          { name: 'Auto-détecter le salon', value: 'auto_detect' },
          { name: 'Tester la configuration', value: 'test' }
        ]
      },
      {
        name: 'channel_id',
        type: 3, // STRING
        description: 'ID du nouveau salon (pour les actions set_main et set_backup)',
        required: false
      }
    ]
  },
  {
    name: 'member-count',
    description: '📊 Obtenir le nombre de membres actuel du serveur source'
  },
  {
    name: 'check-config',
    description: '🔍 Vérifier la configuration en base de données pour ce serveur'
  },
  {
    name: 'activity-monitor',
    description: '🔍 Gestion du monitoring d\'activité (détection système down)',
    options: [
      {
        name: 'action',
        type: 3, // STRING
        description: 'Action à effectuer',
        required: true,
        choices: [
          { name: 'Voir les statistiques', value: 'stats' },
          { name: 'Forcer une vérification', value: 'check' },
          { name: 'Tester une alerte', value: 'test' }
        ]
      }
    ]
  },
  // 🆕 NOUVELLES COMMANDES AVEC API D'INTERACTION (OPTION A)
  {
    name: 'jdsports',
    description: '👟 Rechercher les dernières offres JD Sports'
  },
  {
    name: 'adidas-instore',
    description: '👟 Rechercher les offres Adidas en magasin'
  },
  {
    name: 'courir-instore',
    description: '🏃‍♂️ Rechercher les offres Courir en magasin'
  },
  {
    name: 'nike-instore',
    description: '✔️ Rechercher les offres Nike en magasin'
  },
  {
    name: 'footlocker-instore',
    description: '👟 Rechercher les offres Footlocker en magasin'
  },
  {
    name: 'test-interaction',
    description: '🧪 Tester l\'association d\'interaction (debug)'
  },
  {
    name: 'mention-blacklist',
    description: '🚫 Gestion de la blacklist des salons pour les mentions de rôles',
    options: [
      {
        name: 'action',
        type: 3, // STRING
        description: 'Action à effectuer',
        required: true,
        choices: [
          { name: 'Voir la liste des salons blacklistés', value: 'list' },
          { name: 'Blacklister un salon', value: 'add' },
          { name: 'Supprimer un salon de la blacklist', value: 'remove' },
          { name: 'Nettoyer toute la blacklist', value: 'clear' }
        ]
      },
      {
        name: 'channel_name',
        type: 3, // STRING
        description: 'Nom du salon (pour ajouter/supprimer)',
        required: false
      },
      {
        name: 'reason',
        type: 3, // STRING
        description: 'Raison de la blacklist (optionnel)',
        required: false
      }
    ]
  }
];

// Événement ready
client.once('ready', async () => {
  console.log(`✅ ${client.user.tag} connecté`);
  const startMem = process.memoryUsage();
  console.log(`📊 [Memory] Démarrage - Heap: ${(startMem.heapUsed / 1024 / 1024).toFixed(1)}MB | RSS: ${(startMem.rss / 1024 / 1024).toFixed(1)}MB`);

  // Marquer le timestamp de démarrage
  botStartTimestamp = new Date();

  try {
    // Connexion à la base de données
    await connectDB();
    
    // Initialisation des services
    client.services.logger = new LoggerService(client);
    client.services.channelManager = new ChannelManager(client, client.services.logger);
    client.services.roleManager = new RoleManager(client, client.services.logger);
    client.services.scraper = new ScraperService(client, client.services.logger);
    client.services.userClient = new UserClientService();
    client.services.mentionNotifier = new MentionNotifierService(client, client.services.logger);
    client.services.channelMonitor = new ChannelMonitorService(client, client.services.logger);
    client.services.memberTracker = new MemberTrackerService(client, client.services.logger);
    client.services.activityMonitor = new ActivityMonitorService(client, client.services.logger);

    // 🔍 Initialiser le service de détection des membres (après userClient)
    client.services.memberDetection = new MemberDetectionService(client.services.userClient);
    
    // 🧹 Initialiser le service de nettoyage des données
    const DataCleanupService = require('./services/dataCleanup');
    client.services.dataCleanup = new DataCleanupService(client);
    
    // Initialiser le service de notification avec le gestionnaire de correspondances
    const CorrespondenceManager = require('./services/correspondenceManager');
    const correspondenceManager = new CorrespondenceManager(client, client.services.logger);
    client.services.mentionNotifier.initialize(correspondenceManager);

    // 🔄 Initialiser le service de synchronisation automatique des salons
    const ChannelSyncService = require('./services/channelSyncService');
    client.services.channelSync = new ChannelSyncService(client, client.services.logger, correspondenceManager);

    // 🆕 Initialiser le service de récupération automatique
    const AutoRecoveryService = require('./services/autoRecoveryService');
    client.services.autoRecovery = new AutoRecoveryService(
      client,
      correspondenceManager,
      client.services.channelSync,
      client.services.userClient
    );

    // Injecter le service de récupération dans le gestionnaire de correspondances
    correspondenceManager.setAutoRecoveryService(client.services.autoRecovery);

    // Protection automatique des salons critiques
    const { getAllNotificationChannelIds } = require('./config/notificationChannels');
    const notificationChannelIds = getAllNotificationChannelIds();
    for (const channelId of notificationChannelIds) {
      addProtectedChannelId(channelId);
    }

    // 🚀 NOUVEAU: Déployer les commandes slash par guilde
    await deployCommands();

    // 🔴 TEMPORAIREMENT DÉSACTIVÉ - registerSlashCommands crash sur Hetzner VPS (Coolify)
    // Les commandes sont DÉJÀ déployées par deployCommands() juste avant
    // Cette fonction fait doublon et provoque un crash violent qui empêche l'auto-start


    // TODO: Investiguer pourquoi le setTimeout dans registerSlashCommands crash en production (Coolify/Hetzner)
    // try {
    //   await registerSlashCommands();
    // } catch (error) {
    //   console.error('🔴 [DEBUG-AUTO-START] ERREUR FATALE dans registerSlashCommands:', error);
    //   console.error('Stack:', error.stack);
    // }


    // 🔴 DEBUG: Tracer l'exécution pour identifier le blocage

    try {
      // Auto-initialisation
      await autoInitializeIfNeeded();
    } catch (error) {
      console.error('🔴 [DEBUG-AUTO-START] ERREUR dans autoInitializeIfNeeded:', error);
    }

    try {
      // Restauration des délais globaux
      await restoreGlobalDelays();
    } catch (error) {
      console.error('🔴 [DEBUG-AUTO-START] ERREUR dans restoreGlobalDelays:', error);
    }

    // Point 5.5: Chargement automatique des tokens depuis les variables d'environnement Coolify
    try {
      const userToken = process.env.USER_TOKEN;
      const serverId = process.env.SERVER_ID;

      if (userToken && serverId) {
        console.log(`🔑 [AUTO-START] Chargement token Coolify pour ${client.guilds.cache.size} serveur(s)...`);

        // Charger les tokens pour chaque guild du bot
        let loadedCount = 0;
        for (const guild of client.guilds.cache.values()) {
          try {
            await client.services.userClient.addUserToken(
              guild.id,
              userToken,
              serverId
            );
            loadedCount++;
            console.log(`✅ [AUTO-START] Token chargé pour ${guild.name}`);
          } catch (error) {
            console.error(`❌ [AUTO-START] Échec chargement token pour ${guild.name}:`, error.message);
          }
        }
        console.log(`🔑 [AUTO-START] ${loadedCount}/${client.guilds.cache.size} token(s) chargé(s)`);
      } else {
        console.warn('⚠️ [AUTO-START] USER_TOKEN ou SERVER_ID non configuré dans .env');
      }
    } catch (error) {
      console.error('🔴 [AUTO-START] ERREUR critique chargement tokens:', error.message);
    }

    // Restauration automatique des configurations
    const savedConfigs = await client.services.userClient.restoreFromDatabase();

    if (savedConfigs.length === 0) {
      console.log('📭 [AUTO-START] Aucune configuration sauvegardée trouvée');
    } else {
      // 🚀 REDÉMARRAGE AUTOMATIQUE - Basé sur botInitialized (pas scrapingActive)
      // Le scraping démarre pour TOUS les serveurs initialisés, peu importe l'état précédent
      const initializedConfigs = savedConfigs.filter(cfg => cfg.botInitialized === true);
      const uninitializedConfigs = savedConfigs.filter(cfg => cfg.botInitialized !== true);

      console.log(`🚀 [AUTO-START] ${savedConfigs.length} config(s): ${initializedConfigs.length} initialisée(s), ${uninitializedConfigs.length} non-initialisée(s)`);

      // Démarrer la surveillance automatique
      client.services.channelMonitor.startMonitoring();

      // Logger les serveurs non initialisés (ignorés)
      for (const uninitConfig of uninitializedConfigs) {
        const guild = client.guilds.cache.get(uninitConfig.guildId);
        const guildName = guild ? guild.name : `ID: ${uninitConfig.guildId}`;
        console.log(`⏭️ [AUTO-START] Skip ${guildName}: botInitialized=false`);
      }

      for (const config of savedConfigs) {
        try {
          const targetGuild = client.guilds.cache.get(config.guildId);
          if (!targetGuild) {
            console.warn(`⚠️ [AUTO-START] Guild ${config.guildId} non trouvée dans le cache bot`);
            continue;
          }

          // Skip seulement les serveurs NON initialisés (pas /initialise fait)
          if (!config.botInitialized) {
            continue;
          }

          console.log(`🎯 [AUTO-START] Démarrage scraping pour ${targetGuild.name}...`);


          // 📝 Initialiser les salons de logs si nécessaire
          if (!client.services.logger.logChannels.has(targetGuild.id)) {
            await client.services.logger.initializeLogChannels(targetGuild);
          }

          // Chercher ou créer le salon commands
          let commandsChannel = targetGuild.channels.cache.find(ch =>
            ch.name === 'commands' || ch.name === 'command' || ch.name === 'commandes'
          );

          if (!commandsChannel) {

            // Trouver ou créer la catégorie Maintenance
            let maintenanceCategory = targetGuild.channels.cache.find(c =>
              c.type === 4 && c.name.toLowerCase() === 'maintenance'
            );

            if (!maintenanceCategory) {
              maintenanceCategory = await targetGuild.channels.create({
                name: 'Maintenance',
                type: 4 // CategoryChannel
              });
            }

            // Créer le salon commands
            commandsChannel = await targetGuild.channels.create({
              name: 'commands',
              type: 0, // TextChannel
              parent: maintenanceCategory.id,
              topic: '🤖 Salon pour les commandes du bot et auto-start'
            });
          }

          // Auto-start messages supprimés - un seul message consolidé sera envoyé à la fin

          // Simuler l'exécution de la commande /start avec permissions système
          const fakeInteraction = {
            guild: targetGuild,
            user: { tag: 'System Auto-Restart', id: client.user.id },
            member: {
              id: client.user.id,
              roles: {
                cache: {
                  some: (predicate) => true
                }
              },
              permissions: { has: () => true },
              guild: { ownerId: client.user.id }
            },
            isAutoStart: true,
            deferReply: async () => {
              // Silencieux pendant l'auto-start
            },
            editReply: async (content) => {
              // Logger les erreurs/warnings pour debug (silencieux sinon)
              const contentStr = typeof content === 'string' ? content : content?.content || '';
              if (contentStr.includes('❌') || contentStr.includes('⚠️')) {
                console.warn(`🔔 [AUTO-START] ${targetGuild.name}: ${contentStr.substring(0, 200)}`);
              }
            },
            reply: async (content) => {
              // Seulement pour les erreurs de permissions
              await commandsChannel.send(`🤖 **Système :** ${content}`);
            },
            options: {
              getBoolean: () => null,
              getString: () => null,
              getInteger: () => null
            }
          };


          // Tentative d'exécution avec retry
          let retryCount = 0;
          const maxRetries = 3;
          let success = false;

          while (retryCount < maxRetries && !success) {
            try {
              await handleStart(fakeInteraction);
              success = true;
            } catch (startError) {
              retryCount++;
              console.error(`❌ Tentative ${retryCount}/${maxRetries} échouée pour ${targetGuild.name}:`, startError.message);
              console.error(`   Stack trace (première ligne):`, startError.stack?.split('\n')[1]);

              if (retryCount < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, 5000)); // Attendre 5s avant retry
              } else {
                // Logger l'échec après toutes les tentatives
                console.error(`   ❌ Échec définitif après ${maxRetries} tentatives pour ${targetGuild.name}`);
                await client.services.logger.logAutoStart(targetGuild, 'error', {
                  error: startError.message,
                  attempts: maxRetries
                });
                await commandsChannel.send(`❌ **Échec de l'auto-start après ${maxRetries} tentatives**\n\`\`\`${startError.message}\`\`\``);
              }
            }
          }

          if (success) {
            console.log(`✅ [AUTO-START] Scraping démarré avec succès pour ${targetGuild.name}`);

            // Envoyer un seul message consolidé avec embed
            try {
              const { EmbedBuilder } = require('discord.js');

              // Récupérer les infos du serveur source via getSourceGuild
              let sourceGuildName = 'Serveur source';
              let username = 'Utilisateur';
              let channelCount = 0;

              try {
                const sourceGuild = await client.services.userClient.getSourceGuild(targetGuild.id);
                const userData = client.services.userClient.getUserData(targetGuild.id);

                if (sourceGuild && sourceGuild.name) {
                  sourceGuildName = sourceGuild.name;
                  if (sourceGuild.channels?.cache) {
                    channelCount = sourceGuild.channels.cache.filter(ch => ch.type === 0 || ch.type === 5).size;
                  }
                }

                if (userData && userData.username) {
                  username = `${userData.username}#${userData.discriminator || '0'}`;
                }
              } catch (infoError) {
                console.warn(`⚠️ Impossible de récupérer les infos du serveur source:`, infoError.message);
                // Utiliser les valeurs par défaut
              }

              const embed = new EmbedBuilder()
                .setColor('#00FF00')
                .setTitle('✅ Auto-Start Réussi')
                .setDescription('Le bot a redémarré et le scraping est maintenant actif')
                .addFields(
                  { name: '🎯 Serveur source', value: sourceGuildName, inline: true },
                  { name: '🔗 Compte connecté', value: username, inline: true },
                  { name: '📊 Salons actifs', value: `${channelCount} salon(s)`, inline: true }
                )
                .setTimestamp();

              await commandsChannel.send({ embeds: [embed] });
            } catch (embedError) {
              console.error(`❌ Erreur lors de l'envoi de l'embed auto-start:`, embedError.message);
              // Envoyer un message simple en fallback
              await commandsChannel.send(`✅ **Auto-start réussi!** Le scraping est maintenant actif.`);
            }
          }

        } catch (error) {
          console.error(`❌ Erreur critique auto-start pour ${config.guildId}:`, error.message);
          console.error(`   Stack trace:`, error.stack);

          // Essayer de logger l'erreur si possible
          try {
            const targetGuild = client.guilds.cache.get(config.guildId);
            if (targetGuild) {
              await client.services.logger.logAutoStart(targetGuild, 'critical', {
                error: error.message,
                stack: error.stack
              });
            }
          } catch (logError) {
            console.error('Impossible de logger l\'erreur:', logError);
          }
        }

        // Délai entre chaque serveur pour éviter le spam
        await new Promise(resolve => setTimeout(resolve, 3000));
      }

    }


    // 🧹 Nettoyage initial des données > 30 jours au démarrage
    try {
      const cleanupStats = await client.services.dataCleanup.performFullCleanup();
      if (cleanupStats.totalDeleted > 0) {
      } else {
      }
    } catch (error) {
      console.error('❌ Erreur lors du nettoyage initial:', error.message);
    }

    // 📊 SYSTÈME DE RAPPORT QUOTIDIEN DES MEMBRES DANGEREUX

    // Calculer le temps jusqu'à minuit
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    const msUntilMidnight = tomorrow.getTime() - now.getTime();

    // Programmer le premier rapport à minuit
    setTimeout(async () => {
      await runDailyMembersReport();

      // Puis le répéter toutes les 24h
      setInterval(async () => {
        await runDailyMembersReport();
      }, 24 * 60 * 60 * 1000); // 24 heures
    }, msUntilMidnight);


    // Démarrer le monitoring d'activité pour détecter si le système est down
    client.services.activityMonitor.startMonitoring();
    
    // Tâches cron
    setupCronJobs();
    
    // Résumé de l'état
    const ServerConfig = require('./models/ServerConfig');
    const totalConfigs = await ServerConfig.countDocuments({});
    const initializedConfigs = await ServerConfig.countDocuments({ botInitialized: true });
    const activeConfigs = await ServerConfig.countDocuments({ scrapingActive: true });
    

  } catch (error) {
    console.error('❌ Erreur initialisation:', error.message);
    console.error('🔴 [DEBUG-AUTO-START] ERREUR FATALE dans le ready event:', error.stack);
  }
});

// Gestionnaire d'interactions (commandes slash, menus déroulants, boutons)
client.on('interactionCreate', async (interaction) => {
  // 🆕 INTERCEPTEUR POUR FORCER L'USAGE DE L'API D'INTERACTION (OPTION A)
  // S'assurer que TOUTES les commandes slash utilisent interaction.reply() au lieu de webhooks
  if (interaction.isChatInputCommand()) {
    
    // 🔄 STOCKER L'INTERACTION POUR RÉPONSES FUTURES
    if (!client.activeInteractions) {
      client.activeInteractions = new Map();
    }
    
    // Stocker l'interaction avec timestamp pour timeout automatique
    client.activeInteractions.set(interaction.id, {
      interaction: interaction,
      timestamp: Date.now(),
      user: interaction.user,
      commandName: interaction.commandName,
      responded: false
    });
    
    
    // 🧹 NETTOYAGE AUTOMATIQUE DES INTERACTIONS EXPIRÉES
    const now = Date.now();
    for (const [id, data] of client.activeInteractions.entries()) {
      if (now - data.timestamp > 900000) { // 15 minutes
        client.activeInteractions.delete(id);
      }
    }
  }

  // Gestionnaire des commandes slash
  if (interaction.isChatInputCommand()) {
  const { commandName } = interaction;
  
  try {
    switch (commandName) {
      case 'initialise':
        await handleInitialise(interaction);
        break;
      case 'listservor':
        await handleListServor(interaction);
        break;

      case 'clone':
        await handleClone(interaction);
        break;
      case 'start':
        await handleStart(interaction);
        break;
      case 'stop':
        await handleStop(interaction);
        break;
      case 'addroom':
        await handleAddRoom(interaction);
        break;
      case 'delchannel':
        await handleDelRoom(interaction);
        break;
      case 'syncroles':
        await handleSyncRoles(interaction);
        break;
      case 'sync-correspondances':
        await handleSyncCorrespondances(interaction);
        break;
      case 'fix-correspondances':
        await handleFixCorrespondances(interaction);
        break;
      case 'fix-mappings':
        await handleFixMappings(interaction);
        break;
        case 'setup-roles':
          await handleSetupRoles(interaction);
          break;
      case 'disconnect':
        await handleDisconnect(interaction);
        break;
      case 'discovery':
        await handleDiscovery(interaction);
        break;
      case 'cleanup':
        await handleCleanup(interaction);
        break;
      case 'purge-logs':
        await handlePurgeLogs(interaction);
        break;
      case 'emergency-purge':
        await handleEmergencyPurge(interaction);
        break;
      case 'delcategories':
        await handleDelCategories(interaction);
        break;

        case 'eventstats':
          await handleEventStats(interaction);
          break;
        case 'blacklist':
          await handleBlacklist(interaction);
          break;
        case 'undelete':
          await handleUndelete(interaction);
          break;
        case 'autoclean':
          await handleAutoclean(interaction);
          break;
        case 'auto-repair':
          await handleAutoRepair(interaction);
          break;
        case 'members-analysis':
          await handleMembersAnalysis(interaction);
          break;
        case 'test-access':
          await handleTestAccess(interaction);
          break;
        case 'test-proxauth':
          await handleTestProxAuth(interaction);
          break;
        case 'restore-maintenance':
          await handleRestoreMaintenance(interaction);
          break;
        case 'mention-blacklist':
          await handleMentionBlacklist(interaction);
          break;
        case 'protected-channels':
          await handleProtectedChannels(interaction);
          break;
        case 'notification-channels':
          await handleNotificationChannels(interaction);
          break;
        case 'scan-members':
          await handleScanMembers(interaction);
          break;
        case 'backfill':
          await handleBackfill(interaction);
          break;
        case 'member-count':
          await handleMemberCount(interaction);
          break;
          break;
        case 'activity-monitor':
          await handleActivityMonitor(interaction);
          break;
      // 🆕 NOUVELLES COMMANDES AVEC API D'INTERACTION (SHOPIFY, COURIR, ETC.)
      case 'jdsports':
        await handleShopifyCommand(interaction, 'jdsports');
        break;
      case 'adidas-instore':
        await handleShopifyCommand(interaction, 'adidas-instore');
        break;
      case 'courir-instore':
        await handleShopifyCommand(interaction, 'courir-instore');
        break;
      case 'nike-instore':
        await handleShopifyCommand(interaction, 'nike-instore');
        break;
      case 'footlocker-instore':
        await handleShopifyCommand(interaction, 'footlocker-instore');
        break;
      case 'test-interaction':
        await handleTestInteraction(interaction);
        break;
      default:
        // ⚠️ COMMANDE NON GÉRÉE - ESSAYER LE NOUVEAU SYSTÈME D'INTERACTION
        await handleGenericSlashCommand(interaction);
    }
      
    // 🔄 MARQUER L'INTERACTION COMME RÉPONDUE
    if (client.activeInteractions && client.activeInteractions.has(interaction.id)) {
      const storedInteraction = client.activeInteractions.get(interaction.id);
      storedInteraction.responded = true;
    }
    
    } catch (error) {
    
    const errorMessage = '❌ Une erreur est survenue lors de l\'exécution de cette commande.';
    
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(errorMessage);
    } else {
      await interaction.reply(errorMessage);
      }
    }
  }
  
  // Gestionnaire des menus déroulants de rôles
  else if (interaction.isStringSelectMenu() && interaction.customId.startsWith('role_select_')) {
    try {
      await handleRoleSelectMenu(interaction);
    } catch (error) {
      const errorMessage = '❌ Erreur lors de la gestion des rôles.';
      
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(errorMessage);
      } else {
        await interaction.reply({ content: errorMessage, ephemeral: true });
      }
    }
  }
  
  // Gestionnaire des boutons (notamment "Y aller" pour les messages Proxcop)
  // Note: Les boutons "Y aller" sont maintenant des liens directs, plus besoin de gestionnaire d'interaction
  
  // Gestionnaire des boutons du système de rôles
  else if (interaction.isButton()) {
    try {
      if (interaction.customId === 'refresh_user_roles') {
        await handleRefreshUserRoles(interaction);
      } else if (interaction.customId === 'add_all_roles') {
        await handleAddAllRoles(interaction);
      } else if (interaction.customId === 'clear_all_roles') {
        await handleClearAllRoles(interaction);
      } else if (interaction.customId.startsWith('proxauth_unlock_')) {
        // Handler ProxAuth
        await handleProxAuthUnlock(interaction);
      }
    } catch (error) {
      const errorMessage = '❌ Erreur lors de l\'exécution.';

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(errorMessage);
      } else {
        await interaction.reply({ content: errorMessage, ephemeral: true });
      }
    }
  }

  // Gestionnaire d'autocomplete pour les options channel_name
  else if (interaction.isAutocomplete()) {
    try {
      const focusedOption = interaction.options.getFocused(true);
      if (focusedOption.name !== 'channel_name') {
        await interaction.respond([]);
        return;
      }

      const typed = focusedOption.value.replace(/^#/, '').toLowerCase();
      const Channel = require('./models/Channel');

      // Récupérer le sourceGuild (null-safe si bot pas encore démarré)
      const sourceGuild = client.services?.userClient?.getSourceGuild(interaction.guild.id);
      if (!sourceGuild) {
        await interaction.respond([]);
        return;
      }

      // Query DB avec filtre partiel sur le nom
      const filter = {
        serverId: sourceGuild.id,
        manuallyDeleted: { $ne: true }
      };

      const channels = await Channel.find(filter)
        .select('name')
        .sort({ name: 1 })
        .lean();

      // Filtrer par saisie utilisateur + limiter à 25 (max Discord)
      const filtered = channels
        .filter(ch => ch.name && ch.name.toLowerCase().includes(typed))
        .slice(0, 25)
        .map(ch => ({ name: `#${ch.name}`, value: ch.name }));

      await interaction.respond(filtered);
    } catch (error) {
      // Erreur silencieuse - Discord affichera juste "aucun résultat"
      try { await interaction.respond([]); } catch (_) {}
    }
  }
});

// 🔓 FONCTION - HANDLER BOUTON PROXAUTH
async function handleProxAuthUnlock(interaction) {
  try {

    // Defer la réponse - VISIBLE par tous (pas ephemeral)
    await interaction.deferReply();

    const ProxAuthCache = require('./models/ProxAuthCache');
    const proxauthBypasser = require('./services/proxauthBypasser');
    const { WebhookClient } = require('discord.js');

    // Récupérer les données du cache via le messageId
    const cache = await ProxAuthCache.findOne({
      messageId: interaction.message.id
    });

    if (!cache) {
      console.error('❌ ProxAuth: Lien introuvable en base');
      return interaction.editReply('❌ Lien introuvable. Le message est peut-être trop ancien.');
    }

    let finalUrl = cache.finalUrl;
    let wasAlreadyCached = !!finalUrl;

    // Vérifier si le lien est déjà en cache
    if (!finalUrl) {
      // Bypass nécessaire
      await interaction.editReply('⏳ Déblocage en cours... (peut prendre 10-30 secondes)');

      // Vérifier que le token Discord est configuré
      if (!process.env.USER_TOKEN) {
        console.error('❌ ProxAuth: USER_TOKEN non configuré');
        return interaction.editReply('❌ Token Discord non configuré. Contactez un administrateur.');
      }

      // Lancer le bypass (utilise token + cookies optionnels)
      finalUrl = await proxauthBypasser.bypassUrl(cache.proxauthUrl);

      if (!finalUrl) {
        console.error('❌ ProxAuth: Échec du bypass');
        return interaction.editReply('❌ Échec du déblocage. Token invalide ou URL expirée. Réessayez plus tard.');
      }

      // Sauvegarder en cache
      cache.finalUrl = finalUrl;
      cache.unlockedBy = interaction.user.id;
      cache.unlockedAt = new Date();
      cache.unlockCount = 1;
      await cache.save();

    } else {
      // Déjà en cache
      cache.unlockCount += 1;
      await cache.save();
    }

    // Éditer le message original pour révéler le lien
    let messageEdited = false;
    try {
      const webhook = new WebhookClient({
        id: cache.webhookId,
        token: cache.webhookToken
      });

      const originalContent = interaction.message.content;

      // Stratégie 1: Remplacer le placeholder
      let unmaskedContent = originalContent.replace(
        /\[🔓 Lien protégé - Cliquer sur le bouton\]/g,
        finalUrl
      );

      // Stratégie 2: Si le placeholder n'existait pas, remplacer l'URL ProxAuth directement
      if (unmaskedContent === originalContent && cache.proxauthUrl) {
        const escapedUrl = cache.proxauthUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        unmaskedContent = originalContent.replace(new RegExp(escapedUrl, 'g'), finalUrl);
      }

      await webhook.editMessage(interaction.message.id, {
        content: unmaskedContent,
        components: [] // Supprimer le bouton
      });

      messageEdited = true;
    } catch (webhookError) {
      console.error('❌ ProxAuth: Erreur lors de l\'édition du message:', webhookError.message);
      messageEdited = false;
    }

    // Répondre à l'utilisateur avec contexte approprié
    if (messageEdited) {
      if (wasAlreadyCached) {
        // Lien était déjà en cache
        await interaction.editReply(`✅ **Lien récupéré du cache** par ${interaction.user}\n\n🔗 ${finalUrl}`);
      } else {
        // Premier déblocage
        await interaction.editReply(`✅ **Lien débloqué** par ${interaction.user} !\n\n🔗 ${finalUrl}`);
      }
    } else {
      // L'édition a échoué - informer clairement
      await interaction.editReply(
        `⚠️ **Lien débloqué mais édition du message impossible**\n\n` +
        `🔗 **Lien direct :** ${finalUrl}\n\n` +
        `_Débloqué par ${interaction.user}_`
      );
    }


  } catch (error) {
    console.error('❌ ProxAuth: Erreur dans handleProxAuthUnlock:', error);

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('❌ Une erreur est survenue lors du déblocage. Veuillez réessayer.');
      } else {
        await interaction.reply({ content: '❌ Une erreur est survenue.', ephemeral: true });
      }
    } catch (replyError) {
      console.error('❌ ProxAuth: Impossible de répondre à l\'interaction:', replyError.message);
    }
  }
}

// 🧪 FONCTION - HANDLER COMMANDE /test-proxauth
async function handleTestProxAuth(interaction) {
  try {

    // Defer la réponse
    await interaction.deferReply({ ephemeral: true });

    // Récupérer l'URL depuis les options
    const proxauthUrl = interaction.options.getString('url');

    // Valider l'URL
    const ProxAuthDetector = require('./utils/proxauthDetector');
    const detectedUrls = ProxAuthDetector.detectProxAuthUrls(proxauthUrl);

    if (detectedUrls.length === 0) {
      return interaction.editReply('❌ URL invalide. Format attendu: `https://proxauth.fr/links/XXXXXX`');
    }

    const validUrl = detectedUrls[0];

    // Récupérer ou créer le webhook pour le canal courant
    const channel = interaction.channel;

    if (!channel) {
      return interaction.editReply('❌ Impossible d\'accéder au canal.');
    }

    let webhook;
    try {
      webhook = await getOrCreateWebhook(channel);
    } catch (webhookError) {
      console.error('❌ ProxAuth Test: Erreur création webhook:', webhookError.message);
      return interaction.editReply('❌ Impossible de créer le webhook dans ce canal. Vérifiez les permissions du bot.');
    }

    // Masquer l'URL et créer le message de test
    const testContent = `🧪 **[TEST PROXAUTH]**\n\nVoici un lien protégé à tester:\n${validUrl}`;
    const { maskedText } = ProxAuthDetector.maskProxAuthUrls(testContent);
    const buttonRow = ProxAuthDetector.createUnlockButtonRow(validUrl);

    // Envoyer le message via webhook
    const sentMessage = await webhook.send({
      content: maskedText,
      username: 'ProxAuth Test',
      avatarURL: 'https://cdn.discordapp.com/embed/avatars/0.png',
      components: [buttonRow]
    });


    // Sauvegarder dans le cache pour que le handler de bouton puisse le retrouver
    // Utilise upsert pour éviter erreur duplicate key si l'URL existe déjà
    const ProxAuthCache = require('./models/ProxAuthCache');
    await ProxAuthCache.findOneAndUpdate(
      { proxauthUrl: validUrl },
      {
        $set: {
          messageId: sentMessage.id,
          webhookId: webhook.id,
          webhookToken: webhook.token,
          finalUrl: null,
          unlockedBy: null
        }
      },
      { upsert: true, new: true }
    );


    // Répondre à l'utilisateur
    await interaction.editReply(`✅ **Message de test créé !**\n\n🔓 Clique sur le bouton "Débloquer le lien" dans le message ci-dessus pour tester le bypass.\n\n⏱️ Le bypass peut prendre 10-30 secondes.`);


  } catch (error) {
    console.error('❌ ProxAuth Test: Erreur:', error);

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('❌ Une erreur est survenue lors de la création du test.');
      } else {
        await interaction.reply({ content: '❌ Une erreur est survenue.', ephemeral: true });
      }
    } catch (replyError) {
      console.error('❌ ProxAuth Test: Impossible de répondre:', replyError.message);
    }
  }
}

// 📊 FONCTION - RAPPORT QUOTIDIEN DES MEMBRES DANGEREUX
async function runDailyMembersReport() {
  try {

    // Récupérer tous les serveurs configurés
    const stats = client.services.userClient.getStats();

    for (const guildData of stats.guilds) {
      const targetGuild = client.guilds.cache.get(guildData.guildId);

      if (!targetGuild) continue;

      // Trouver ou créer le canal membres-dangereux
      let dangerousChannel = targetGuild.channels.cache.find(ch => ch.name === 'membres-dangereux');

      if (!dangerousChannel) {
        const maintenanceCategory = targetGuild.channels.cache.find(
          c => c.type === 4 && c.name === 'MAINTENANCE'
        );

        try {
          dangerousChannel = await targetGuild.channels.create({
            name: 'membres-dangereux',
            type: 0,
            parent: maintenanceCategory?.id,
            reason: 'Canal pour rapport quotidien des membres dangereux'
          });
        } catch (error) {
          console.error(`❌ Impossible de créer #membres-dangereux sur ${targetGuild.name}:`, error);
          continue;
        }
      }

      // Générer le rapport
      const report = await client.services.memberTracker.generateDailyReport(guildData.guildId);

      if (!report) {
        console.error(`❌ Impossible de générer le rapport pour ${targetGuild.name}`);
        continue;
      }

      // Formater le message
      const date = new Date().toLocaleDateString('fr-FR');
      let reportMessage = `🚨 **RAPPORT QUOTIDIEN AUTOMATIQUE - ${date}**\n`;
      reportMessage += `${'═'.repeat(50)}\n\n`;

      // Membres dangereux
      if (report.dangerousMembers && report.dangerousMembers.length > 0) {
        reportMessage += `⚠️ **MEMBRES À SURVEILLER** (sur plusieurs serveurs):\n`;
        for (const member of report.dangerousMembers.slice(0, 15)) {
          reportMessage += `• **${member.username}** - Niveau: ${member.dangerLevel}/3\n`;
          if (member.servers && member.servers.length > 1) {
            reportMessage += `  └ Présent sur: ${member.servers.map(s => s.guildName).join(', ')}\n`;
          }
        }
        reportMessage += '\n';
      }

      // Opportunités
      if (report.recentDepartures && report.recentDepartures.length > 0) {
        reportMessage += `🎯 **OPPORTUNITÉS** (départs de concurrents):\n`;
        for (const opp of report.recentDepartures.slice(0, 10)) {
          reportMessage += `• **${opp.username}** - Parti de ${opp.opportunityFrom}\n`;
          if (opp.opportunityDate) {
            reportMessage += `  └ <t:${Math.floor(new Date(opp.opportunityDate).getTime() / 1000)}:R>\n`;
          }
        }
        reportMessage += '\n';
      }

      // Mouvements du jour
      if (report.todayJoins && report.todayJoins.length > 0) {
        reportMessage += `✅ **NOUVELLES ARRIVÉES** (${report.todayJoins.length}):\n`;
        for (const member of report.todayJoins.slice(0, 10)) {
          reportMessage += `• ${member.username}\n`;
        }
        if (report.todayJoins.length > 10) {
          reportMessage += `  _...et ${report.todayJoins.length - 10} autres_\n`;
        }
        reportMessage += '\n';
      }

      if (report.todayLeaves && report.todayLeaves.length > 0) {
        reportMessage += `❌ **DÉPARTS DU JOUR** (${report.todayLeaves.length}):\n`;
        for (const member of report.todayLeaves.slice(0, 10)) {
          reportMessage += `• ${member.username}\n`;
        }
        if (report.todayLeaves.length > 10) {
          reportMessage += `  _...et ${report.todayLeaves.length - 10} autres_\n`;
        }
        reportMessage += '\n';
      }

      // Statistiques globales
      if (report.stats) {
        reportMessage += `📊 **STATISTIQUES GLOBALES**:\n`;
        reportMessage += `• Membres actifs: ${report.stats.totalMembers}\n`;
        reportMessage += `• Membres dangereux: ${report.stats.totalDangerous}\n`;
        reportMessage += `• Opportunités actives: ${report.stats.totalOpportunities}\n`;
      }

      // Envoyer le rapport
      try {
        // Diviser le message s'il est trop long
        if (reportMessage.length > 2000) {
          const parts = reportMessage.match(/[\s\S]{1,2000}/g) || [];
          for (const part of parts) {
            await dangerousChannel.send(part);
          }
        } else {
          await dangerousChannel.send(reportMessage);
        }


        // Logger dans admin-logs aussi
        await client.services.logger.logAdminAction(
          targetGuild.id,
          `📊 Rapport quotidien généré automatiquement dans ${dangerousChannel}`
        );

      } catch (error) {
        console.error(`❌ Erreur envoi rapport pour ${targetGuild.name}:`, error);
      }
    }


  } catch (error) {
    console.error('❌ Erreur globale rapport quotidien:', error);
  }
}

// 🔄 ==========================================
// 🔄 SURVEILLANCE EN TEMPS RÉEL DES SERVEURS SOURCES
// 🔄 ==========================================

// 🆕 FONCTION UTILITAIRE POUR ENVOYER DE LONGS MESSAGES SANS TRONCATURE
async function sendLongResponse(interaction, response) {
  const maxLength = 1950; // Limite sécurisée pour Discord
  
  if (response.length <= maxLength) {
    // Message court, envoyer normalement
    await interaction.editReply(response);
    return;
  }
  
  // Message long, diviser en plusieurs parties
  const lines = response.split('\n');
  let currentChunk = '';
  let isFirstChunk = true;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const testChunk = currentChunk + (currentChunk ? '\n' : '') + line;
    
    // Si l'ajout de cette ligne dépasse la limite
    if (testChunk.length > maxLength && currentChunk.length > 0) {
      // Envoyer le chunk actuel
      if (isFirstChunk) {
        await interaction.editReply(currentChunk);
        isFirstChunk = false;
      } else {
        await interaction.followUp(currentChunk);
      }
      
      // Commencer un nouveau chunk avec la ligne actuelle
      currentChunk = line;
    } else {
      // Ajouter la ligne au chunk actuel
      currentChunk = testChunk;
    }
    
    // Si c'est la dernière ligne, envoyer le chunk restant
    if (i === lines.length - 1 && currentChunk.length > 0) {
      if (isFirstChunk) {
        await interaction.editReply(currentChunk);
      } else {
        await interaction.followUp(currentChunk);
      }
    }
  }
}

// 🏠 VÉRIFIER SI UN SERVEUR EST UNE SOURCE CONFIGURÉE
function isSourceGuild(guildId) {
  try {
    // Parcourir toutes les configurations pour voir si ce serveur est une source
    const configs = client.services.userClient.getAllConfigurations();
    
    for (const config of configs) {
      if (config.sourceGuildId === guildId) {
        return {
          isSource: true,
          mirrorGuildId: config.targetGuildId,
          mirrorGuild: client.guilds.cache.get(config.targetGuildId)
        };
      }
    }
    
    return { isSource: false };
  } catch (error) {
    console.error('❌ Erreur vérification serveur source:', error);
    return { isSource: false };
  }
}

// 🆕 GESTIONNAIRE - SALON CRÉÉ SUR SERVEUR SOURCE
async function handleSourceChannelCreate(channel) {
  try {
    const sourceCheck = isSourceGuild(channel.guild.id);
    if (!sourceCheck.isSource || !sourceCheck.mirrorGuild) return;
    
    const sourceGuild = channel.guild;
    const mirrorGuild = sourceCheck.mirrorGuild;
    
    
    // Ignorer les salons système/temporaires
    if (channel.name.includes('temp-') || channel.name.includes('voice-') || channel.type === 1) {
      return;
    }
    
    // Créer automatiquement le salon sur le serveur mirror
    try {
      // Créer la catégorie si nécessaire
      let targetCategory = null;
      if (channel.parent) {
        targetCategory = mirrorGuild.channels.cache.find(
          ch => ch.type === 4 && ch.name === channel.parent.name
        );
        
        if (!targetCategory) {
          targetCategory = await mirrorGuild.channels.create({
            name: channel.parent.name,
            type: 4,
            position: channel.parent.position
          });
          
        }
      }
      
      // Créer le salon
      const channelOptions = {
        name: channel.name,
        type: channel.type,
        topic: channel.topic || `Mirror de #${channel.name}`,
        position: channel.position
      };
      
      if (targetCategory) {
        channelOptions.parent = targetCategory;
      }
      
      // Options spécifiques aux salons vocaux
      if (channel.type === 2) {
        channelOptions.bitrate = channel.bitrate || 64000;
        channelOptions.userLimit = channel.user_limit || 0;
      }
      
      const newMirrorChannel = await mirrorGuild.channels.create(channelOptions);
      
      // Sauvegarder en base de données avec l'ID source
      await client.services.channelManager.saveChannelToDatabase(newMirrorChannel, sourceGuild.id, channel.id);
      
      // Logger la création automatique avec mention cliquable
      await client.services.logger.logNewRoom(
        mirrorGuild.id,
        `🚀 **CRÉATION AUTOMATIQUE** - <#${newMirrorChannel.id}>\n` +
        `📁 Catégorie: ${targetCategory?.name || 'Aucune'}\n` +
        `🔄 **Source:** ${sourceGuild.name}\n` +
        `⚡ **Détection en temps réel**`,
        'Création Auto',
        newMirrorChannel.id
      );
      
      
    } catch (error) {
      console.error(`❌ Erreur création automatique salon ${channel.name}:`, error);
      
      await client.services.logger.logError(
        mirrorGuild.id,
        `❌ **Échec création automatique**\n` +
        `📁 Salon: #${channel.name}\n` +
        `🔄 Source: ${sourceGuild.name}\n` +
        `❌ Erreur: ${error.message}`,
        channel.name,
        {
          error: error,
          channelId: channel.id,
          channelName: channel.name,
          channelType: channel.type,
          categoryId: channel.parent?.id,
          categoryName: channel.parent?.name,
          sourceGuildId: sourceGuild.id,
          targetGuildId: mirrorGuild.id,
          systemInfo: {
            eventType: 'channelCreate',
            sourceGuildName: sourceGuild.name,
            targetGuildName: mirrorGuild.name,
            sourceChannelCount: sourceGuild.channels.cache.size,
            targetChannelCount: mirrorGuild.channels.cache.size
          }
        }
      );
    }
    
  } catch (error) {
    console.error('❌ Erreur handleSourceChannelCreate:', error);
  }
}

// 🗑️ GESTIONNAIRE - SALON SUPPRIMÉ SUR SERVEUR SOURCE  
async function handleSourceChannelDelete(channel) {
  try {
    const sourceCheck = isSourceGuild(channel.guild.id);
    if (!sourceCheck.isSource || !sourceCheck.mirrorGuild) return;
    
    const sourceGuild = channel.guild;
    const mirrorGuild = sourceCheck.mirrorGuild;
    
    
    // Trouver le salon correspondant sur le serveur mirror
    const mirrorChannel = mirrorGuild.channels.cache.find(ch => ch.name === channel.name);
    
    if (mirrorChannel) {
      // 🛡️ PROTECTION RENFORCÉE : Ignorer les salons système ET les salons de maintenance
      const systemChannels = ['newroom', 'error', 'roles-logs', 'admin-logs', 'members-log', 'commands', 'chat-staff', 'roles'];
      if (systemChannels.includes(mirrorChannel.name)) {
        return;
      }
      
      // 🛡️ PROTECTION CATÉGORIE : Ignorer TOUS les salons de la catégorie Maintenance
      if (mirrorChannel.parent && 
          (mirrorChannel.parent.name.toLowerCase().includes('maintenance') || 
           mirrorChannel.parent.name === '🔧 Maintenance')) {
        return;
      }
      
      try {
        // Supprimer de la base de données d'abord
        const Channel = require('./models/Channel');
        await Channel.deleteOne({ discordId: mirrorChannel.id });
        
        // Supprimer le salon Discord
        await mirrorChannel.delete();
        
        // Logger la suppression automatique vers #admin-logs (pas #newroom)
        await client.services.logger.logAdminAction(
          mirrorGuild.id,
          `🗑️ **SUPPRESSION AUTOMATIQUE** - #${channel.name}\n` +
          `🔄 **Source:** ${sourceGuild.name}\n` +
          `⚡ **Détection en temps réel**\n` +
          `✅ **Base de données:** Nettoyée automatiquement`
        );
        
        
      } catch (error) {
        console.error(`❌ Erreur suppression automatique salon ${channel.name}:`, error);
        
        await client.services.logger.logError(
          mirrorGuild.id,
          `❌ **Échec suppression automatique**\n` +
          `📁 Salon: #${channel.name}\n` +
          `🔄 Source: ${sourceGuild.name}\n` +
          `❌ Erreur: ${error.message}`,
          channel.name,
          {
            error: error,
            channelId: channel.id,
            channelName: channel.name,
            mirrorChannelId: mirrorChannel.id,
            sourceGuildId: sourceGuild.id,
            targetGuildId: mirrorGuild.id,
            systemInfo: {
              eventType: 'channelDelete',
              sourceGuildName: sourceGuild.name,
              targetGuildName: mirrorGuild.name,
              mirrorChannelExists: !!mirrorChannel
            }
          }
        );
      }
    } else {
      // Logger que le salon n'existait pas sur le mirror vers #admin-logs
      await client.services.logger.logAdminAction(
        mirrorGuild.id,
        `🗑️ **Salon supprimé sur la source** - #${channel.name}\n` +
        `🔄 **Source:** ${sourceGuild.name}\n` +
        `ℹ️ **Aucun salon correspondant sur le mirror**`
      );
    }
    
  } catch (error) {
    console.error('❌ Erreur handleSourceChannelDelete:', error);
  }
}

// 🔄 GESTIONNAIRE - SALON MODIFIÉ SUR SERVEUR SOURCE
async function handleSourceChannelUpdate(oldChannel, newChannel) {
  try {
    const sourceCheck = isSourceGuild(newChannel.guild.id);
    if (!sourceCheck.isSource || !sourceCheck.mirrorGuild) return;
    
    const sourceGuild = newChannel.guild;
    const mirrorGuild = sourceCheck.mirrorGuild;
    
    // Utiliser correspondenceManager pour trouver le salon mirror
    const mirrorChannelId = await client.services.correspondenceManager.getMirrorChannelId(
      newChannel.id,
      sourceGuild.id,
      mirrorGuild.id
    );
    
    if (!mirrorChannelId) {
      // Si le salon n'est pas trouvé et qu'il a été renommé, essayer avec l'ancien nom
      if (oldChannel.name !== newChannel.name) {
      }
      return;
    }
    
    const mirrorChannel = mirrorGuild.channels.cache.get(mirrorChannelId);
    
    const changes = [];
    let shouldUpdate = false;
    
    // Détecter les changements
    if (oldChannel.name !== newChannel.name) {
      changes.push(`📝 **Nom:** ${oldChannel.name} → ${newChannel.name}`);
      shouldUpdate = true;
    }
    
    if (oldChannel.topic !== newChannel.topic) {
      changes.push(`📋 **Sujet:** ${oldChannel.topic || 'Aucun'} → ${newChannel.topic || 'Aucun'}`);
      shouldUpdate = true;
    }
    
    if (oldChannel.parent?.name !== newChannel.parent?.name) {
      changes.push(`📁 **Catégorie:** ${oldChannel.parent?.name || 'Aucune'} → ${newChannel.parent?.name || 'Aucune'}`);
      shouldUpdate = true;
    }
    
    if (shouldUpdate) {
      try {
        // Mettre à jour le salon mirror
        const updateOptions = {
          name: newChannel.name,
          topic: newChannel.topic
        };
        
        // Gérer le changement de catégorie
        if (oldChannel.parent?.name !== newChannel.parent?.name) {
          if (newChannel.parent) {
            let targetCategory = mirrorGuild.channels.cache.find(
              ch => ch.type === 4 && ch.name === newChannel.parent.name
            );
            
            if (!targetCategory) {
              targetCategory = await mirrorGuild.channels.create({
                name: newChannel.parent.name,
                type: 4,
                position: newChannel.parent.position
              });
            }
            
            updateOptions.parent = targetCategory;
          } else {
            updateOptions.parent = null;
          }
        }
        
        await mirrorChannel.edit(updateOptions);
        
        // Mettre à jour la base de données si le nom a changé
        if (oldChannel.name !== newChannel.name) {
          const Channel = require('./models/Channel');
          await Channel.updateOne(
            { discordId: mirrorChannel.id },
            { name: newChannel.name }
          );
        }
        
        // Logger les modifications avec mention cliquable
        await client.services.logger.logNewRoom(
          mirrorGuild.id,
          `🔄 **MODIFICATION AUTOMATIQUE** - <#${mirrorChannel.id}>\n` +
          `🔄 **Source:** ${sourceGuild.name}\n` +
          `⚡ **Détection en temps réel**\n\n` +
          `**Changements :**\n${changes.join('\n')}`,
          'Modification Auto',
          mirrorChannel.id
        );
        
        
      } catch (error) {
        console.error(`❌ Erreur modification automatique salon ${newChannel.name}:`, error);
        
        await client.services.logger.logError(
          mirrorGuild.id,
          `❌ **Échec modification automatique**\n` +
          `📁 Salon: #${newChannel.name}\n` +
          `🔄 Source: ${sourceGuild.name}\n` +
          `❌ Erreur: ${error.message}`
        );
      }
    }
    
  } catch (error) {
    console.error('❌ Erreur handleSourceChannelUpdate:', error);
  }
}

// 🎭 GESTIONNAIRE - RÔLE CRÉÉ SUR SERVEUR SOURCE
async function handleSourceRoleCreate(role) {
  try {
    const sourceCheck = isSourceGuild(role.guild.id);
    if (!sourceCheck.isSource || !sourceCheck.mirrorGuild) return;
    
    const sourceGuild = role.guild;
    const mirrorGuild = sourceCheck.mirrorGuild;
    
    // Ignorer les rôles système et managés
    if (role.managed || ['@everyone', 'ladmin', 'lmembres'].includes(role.name)) {
      return;
    }
    
    
    try {
      // Créer automatiquement le rôle sur le serveur mirror
      const newRole = await mirrorGuild.roles.create({
        name: role.name,
        color: role.color,
        permissions: role.permissions,
        hoist: role.hoist,
        mentionable: role.mentionable
      });
      
      // Sauvegarder en base de données
      await client.services.roleManager.saveRoleToDatabase(newRole, sourceGuild.id);
      
      // Logger la création automatique
      await client.services.logger.logRoleAction(
        mirrorGuild.id,
        `🚀 **CRÉATION AUTOMATIQUE** - Rôle: ${role.name}\n` +
        `🎨 Couleur: #${role.color?.toString(16).padStart(6, '0') || '000000'}\n` +
        `🔄 **Source:** ${sourceGuild.name}\n` +
        `⚡ **Détection en temps réel**`
      );
      
      
    } catch (error) {
      console.error(`❌ Erreur création automatique rôle ${role.name}:`, error);
      
      await client.services.logger.logRoleAction(
        mirrorGuild.id,
        `❌ **Échec création automatique**\n` +
        `🎭 Rôle: ${role.name}\n` +
        `🔄 Source: ${sourceGuild.name}\n` +
        `❌ Erreur: ${error.message}`
      );
    }
    
  } catch (error) {
    console.error('❌ Erreur handleSourceRoleCreate:', error);
  }
}

// 🗑️ GESTIONNAIRE - RÔLE SUPPRIMÉ SUR SERVEUR SOURCE
async function handleSourceRoleDelete(role) {
  try {
    const sourceCheck = isSourceGuild(role.guild.id);
    if (!sourceCheck.isSource || !sourceCheck.mirrorGuild) return;
    
    const sourceGuild = role.guild;
    const mirrorGuild = sourceCheck.mirrorGuild;
    
    
    // Trouver le rôle correspondant sur le serveur mirror
    const mirrorRole = mirrorGuild.roles.cache.find(r => r.name === role.name);
    
    if (mirrorRole) {
      // Ignorer les rôles système
      if (['ladmin', 'lmembres'].includes(mirrorRole.name)) {
        return;
      }
      
      try {
        // Supprimer de la base de données d'abord
        const Role = require('./models/Role');
        await Role.deleteOne({ discordId: mirrorRole.id });
        
        // Supprimer le rôle Discord
        await mirrorRole.delete();
        
        // Logger la suppression automatique
        await client.services.logger.logRoleAction(
          mirrorGuild.id,
          `🗑️ **SUPPRESSION AUTOMATIQUE** - Rôle: ${role.name}\n` +
          `🎨 Couleur: #${role.color?.toString(16).padStart(6, '0') || '000000'}\n` +
          `🔄 **Source:** ${sourceGuild.name}\n` +
          `⚡ **Détection en temps réel**\n` +
          `✅ **Base de données:** Nettoyée automatiquement`
        );
        
        
      } catch (error) {
        console.error(`❌ Erreur suppression automatique rôle ${role.name}:`, error);
        
        await client.services.logger.logRoleAction(
          mirrorGuild.id,
          `❌ **Échec suppression automatique**\n` +
          `🎭 Rôle: ${role.name}\n` +
          `🔄 Source: ${sourceGuild.name}\n` +
          `❌ Erreur: ${error.message}`
        );
      }
    }
    
  } catch (error) {
    console.error('❌ Erreur handleSourceRoleDelete:', error);
  }
}

// 🔄 GESTIONNAIRE - RÔLE MODIFIÉ SUR SERVEUR SOURCE
async function handleSourceRoleUpdate(oldRole, newRole) {
  try {
    const sourceCheck = isSourceGuild(newRole.guild.id);
    if (!sourceCheck.isSource || !sourceCheck.mirrorGuild) return;
    
    const sourceGuild = newRole.guild;
    const mirrorGuild = sourceCheck.mirrorGuild;
    
    // Ignorer les rôles système et managés
    if (newRole.managed || ['@everyone', 'ladmin', 'lmembres'].includes(newRole.name)) {
      return;
    }
    
    // Trouver le rôle correspondant sur le serveur mirror
    const mirrorRole = mirrorGuild.roles.cache.find(r => r.name === oldRole.name);
    
    if (!mirrorRole) return; // Pas de rôle mirror correspondant
    
    const changes = [];
    let shouldUpdate = false;
    
    // Détecter les changements
    if (oldRole.name !== newRole.name) {
      changes.push(`📝 **Nom:** ${oldRole.name} → ${newRole.name}`);
      shouldUpdate = true;
    }
    
    if (oldRole.color !== newRole.color) {
      const oldColor = `#${oldRole.color?.toString(16).padStart(6, '0') || '000000'}`;
      const newColor = `#${newRole.color?.toString(16).padStart(6, '0') || '000000'}`;
      changes.push(`🎨 **Couleur:** ${oldColor} → ${newColor}`);
      shouldUpdate = true;
    }
    
    if (oldRole.hoist !== newRole.hoist) {
      changes.push(`📌 **Affichage séparé:** ${oldRole.hoist ? 'Oui' : 'Non'} → ${newRole.hoist ? 'Oui' : 'Non'}`);
      shouldUpdate = true;
    }
    
    if (oldRole.mentionable !== newRole.mentionable) {
      changes.push(`📢 **Mentionnable:** ${oldRole.mentionable ? 'Oui' : 'Non'} → ${newRole.mentionable ? 'Oui' : 'Non'}`);
      shouldUpdate = true;
    }
    
    if (shouldUpdate) {
      try {
        // Mettre à jour le rôle mirror
        await mirrorRole.edit({
          name: newRole.name,
          color: newRole.color,
          permissions: newRole.permissions,
          hoist: newRole.hoist,
          mentionable: newRole.mentionable
        });
        
        // Mettre à jour la base de données si le nom a changé
        if (oldRole.name !== newRole.name) {
          const Role = require('./models/Role');
          await Role.updateOne(
            { discordId: mirrorRole.id },
            { name: newRole.name }
          );
        }
        
        // Logger les modifications
        await client.services.logger.logRoleAction(
          mirrorGuild.id,
          `🔄 **MODIFICATION AUTOMATIQUE** - Rôle: ${oldRole.name}\n` +
          `🔄 **Source:** ${sourceGuild.name}\n` +
          `⚡ **Détection en temps réel**\n\n` +
          `**Changements :**\n${changes.join('\n')}`
        );
        
        
      } catch (error) {
        console.error(`❌ Erreur modification automatique rôle ${newRole.name}:`, error);
        
        await client.services.logger.logRoleAction(
          mirrorGuild.id,
          `❌ **Échec modification automatique**\n` +
          `🎭 Rôle: ${newRole.name}\n` +
          `🔄 Source: ${sourceGuild.name}\n` +
          `❌ Erreur: ${error.message}`
        );
      }
    }
    
  } catch (error) {
    console.error('❌ Erreur handleSourceRoleUpdate:', error);
  }
}

// 👋 GESTIONNAIRE - MEMBRE REJOINT LE SERVEUR SOURCE
async function handleSourceMemberAdd(member) {
  try {
    const sourceCheck = isSourceGuild(member.guild.id);
    if (!sourceCheck.isSource || !sourceCheck.mirrorGuild) return;

    const sourceGuild = member.guild;
    const mirrorGuild = sourceCheck.mirrorGuild;

    // Sauvegarder le membre détaillé
    await client.services.memberTracker.saveMemberDetail(
      member,
      sourceGuild.id,
      sourceGuild.name,
      'join'
    );

    // Logger l'arrivée du membre avec pseudo complet dans members-logs
    const membersLogsChannel = mirrorGuild.channels.cache.find(ch => ch.name === 'members-logs');
    if (membersLogsChannel) {
      await membersLogsChannel.send(
        `✅ **${member.user.tag}** (${member.user.username}) a rejoint **${sourceGuild.name}**\n` +
        `📅 <t:${Math.floor(Date.now() / 1000)}:F>`
      );
    }

    // Logger aussi dans le système existant
    await client.services.logger.logMemberJoin(
      mirrorGuild.id,
      member,
      sourceGuild.name
    );


  } catch (error) {
    console.error('❌ Erreur handleSourceMemberAdd:', error);
  }
}

// 👋 GESTIONNAIRE - MEMBRE QUITTÉ LE SERVEUR SOURCE
async function handleSourceMemberRemove(member) {
  try {
    const sourceCheck = isSourceGuild(member.guild.id);
    if (!sourceCheck.isSource || !sourceCheck.mirrorGuild) return;

    const sourceGuild = member.guild;
    const mirrorGuild = sourceCheck.mirrorGuild;

    // Sauvegarder le départ dans MemberDetail
    await client.services.memberTracker.saveMemberDetail(
      member,
      sourceGuild.id,
      sourceGuild.name,
      'leave'
    );

    // Vérifier si c'est une opportunité (départ d'un concurrent)
    const MemberDetail = require('./models/MemberDetail');
    const memberDetail = await MemberDetail.findOne({
      userId: member.id,
      guildId: sourceGuild.id
    });

    if (memberDetail && sourceGuild.name !== 'Notify France') {
      memberDetail.isOpportunity = true;
      memberDetail.opportunityDate = new Date();
      memberDetail.opportunityFrom = sourceGuild.name;
      await memberDetail.save();
    }

    // Logger le départ avec pseudo complet dans members-logs
    const membersLogsChannel = mirrorGuild.channels.cache.find(ch => ch.name === 'members-logs');
    if (membersLogsChannel) {
      await membersLogsChannel.send(
        `❌ **${member.user.tag}** (${member.user.username}) a quitté **${sourceGuild.name}**\n` +
        `📅 <t:${Math.floor(Date.now() / 1000)}:F>` +
        (memberDetail?.isOpportunity ? '\n🎯 **OPPORTUNITÉ DÉTECTÉE**' : '')
      );
    }

    // Logger aussi dans le système existant
    await client.services.logger.logMemberLeave(
      mirrorGuild.id,
      member,
      sourceGuild.name
    );


  } catch (error) {
    console.error('❌ Erreur handleSourceMemberRemove:', error);
  }
}

// 🔄 GESTIONNAIRE - MEMBRE MODIFIÉ SUR SERVEUR SOURCE
async function handleSourceMemberUpdate(oldMember, newMember) {
  try {
    const sourceCheck = isSourceGuild(newMember.guild.id);
    if (!sourceCheck.isSource || !sourceCheck.mirrorGuild) return;
    
    const sourceGuild = newMember.guild;
    const mirrorGuild = sourceCheck.mirrorGuild;
    
    // Logger les modifications du membre
    await client.services.logger.logMemberUpdate(
      mirrorGuild.id,
      oldMember,
      newMember,
      sourceGuild.name
    );
    
  } catch (error) {
    console.error('❌ Erreur handleSourceMemberUpdate:', error);
  }
}

// 🔄 EVENT LISTENERS - SURVEILLANCE EN TEMPS RÉEL
client.on('channelCreate', handleSourceChannelCreate);
client.on('channelDelete', handleSourceChannelDelete);  
client.on('channelUpdate', handleSourceChannelUpdate);

client.on('roleCreate', handleSourceRoleCreate);
client.on('roleDelete', handleSourceRoleDelete);
client.on('roleUpdate', handleSourceRoleUpdate);

client.on('guildMemberAdd', handleSourceMemberAdd);
client.on('guildMemberRemove', handleSourceMemberRemove);
client.on('guildMemberUpdate', handleSourceMemberUpdate);

// 🔧 AUTO-REPAIR - Surveillance du canal #error pour correction automatique
client.on('messageCreate', async (message) => {
  // Vérifier si c'est dans le canal #error et de notre bot
  if (message.channel.name === 'error' && message.author.id === client.user.id) {
    // Vérifier si l'auto-repair est activé pour ce serveur
    const ServerConfig = require('./models/ServerConfig');
    const serverConfig = await ServerConfig.findOne({ guildId: message.guild.id });

    if (serverConfig && serverConfig.autoRepairEnabled && serverConfig.sourceGuildId) {
      await handleErrorAutoRepair(message, serverConfig.sourceGuildId);
    }
  }
});

// 🔄 ==========================================
// 🔄 FIN DE LA SURVEILLANCE EN TEMPS RÉEL
// 🔄 ==========================================

// 🔧 SYSTÈME AUTO-REPAIR - Correction automatique des correspondances manquantes
async function handleErrorAutoRepair(message, sourceGuildId) {
  try {

    // Parser le message pour extraire les informations
    const channelNameMatch = message.content.match(/📍 Salon source : (.+)/);
    const channelIdMatch = message.content.match(/🔍 ID source : (\d+)/);

    if (!channelNameMatch || !channelIdMatch) {
      return;
    }

    const channelName = channelNameMatch[1].replace('#', '').trim();
    const sourceChannelId = channelIdMatch[1];


    // Vérifier si le canal existe déjà sur le serveur mirror
    const existingChannel = message.guild.channels.cache.find(ch => ch.name === channelName);
    if (existingChannel) {

      // Mettre à jour la correspondance dans la base de données
      const Channel = require('./models/Channel');
      await Channel.findOneAndUpdate(
        { sourceChannelId: sourceChannelId, serverId: sourceGuildId },
        {
          name: channelName,
          discordId: existingChannel.id,
          scraped: true,
          lastActivity: new Date()
        },
        { upsert: true }
      );

      // Logger le succès
      await client.services.logger.logAdminAction(
        message.guild.id,
        `✅ **AUTO-REPAIR** - Correspondance réparée\n` +
        `📍 Canal: ${channelName}\n` +
        `🔗 ID Source: ${sourceChannelId}\n` +
        `🎯 Canal existant utilisé: ${existingChannel.id}`
      );

      // Supprimer le message d'erreur
      try {
        await message.delete();
      } catch (err) {
      }

      return;
    }

    // Le canal n'existe pas, vérifier les limites avant création
    const autoRepairStats = client.autoRepairStats || new Map();
    const guildStats = autoRepairStats.get(message.guild.id) || { count: 0, lastReset: Date.now() };

    // Réinitialiser le compteur toutes les heures
    if (Date.now() - guildStats.lastReset > 3600000) {
      guildStats.count = 0;
      guildStats.lastReset = Date.now();
    }

    // Limite de 10 créations par heure
    if (guildStats.count >= 10) {
      await client.services.logger.logAdminAction(
        message.guild.id,
        `⚠️ **AUTO-REPAIR** - Limite atteinte\n` +
        `📍 Canal: ${channelName}\n` +
        `⏰ Limite: 10 créations/heure atteinte\n` +
        `🔄 Prochaine réinitialisation dans ${Math.round((3600000 - (Date.now() - guildStats.lastReset)) / 60000)} minutes`
      );
      return;
    }

    // Vérifier d'abord dans la base si le canal n'est pas marqué comme supprimé manuellement
    const Channel = require('./models/Channel');
    const deletedChannel = await Channel.findOne({
      name: channelName,
      serverId: sourceGuildId,
      manuallyDeleted: true
    });

    if (deletedChannel) {
      await client.services.logger.logAdminAction(
        message.guild.id,
        `🚫 **AUTO-REPAIR** - Canal bloqué\n` +
        `📍 Canal: ${channelName}\n` +
        `❌ Ce canal a été supprimé manuellement\n` +
        `💡 Utilisez /undelete pour le réactiver`
      );
      return;
    }

    // Créer le canal manquant

    try {
      // Déterminer la catégorie appropriée
      let category = null;
      const maintenanceCategory = message.guild.channels.cache.find(
        c => c.type === 4 && c.name === 'MAINTENANCE'
      );

      if (maintenanceCategory) {
        category = maintenanceCategory;
      }

      // Créer le nouveau canal
      const newChannel = await message.guild.channels.create({
        name: channelName,
        type: 0, // Text channel
        parent: category?.id,
        reason: `AUTO-REPAIR: Canal créé automatiquement suite à erreur de correspondance`
      });

      // Sauvegarder la correspondance
      await Channel.findOneAndUpdate(
        { sourceChannelId: sourceChannelId, serverId: sourceGuildId },
        {
          name: channelName,
          discordId: newChannel.id,
          scraped: true,
          lastActivity: new Date()
        },
        { upsert: true }
      );

      // Incrémenter le compteur
      guildStats.count++;
      autoRepairStats.set(message.guild.id, guildStats);
      client.autoRepairStats = autoRepairStats;

      // Mettre à jour les stats globales dans la config
      const ServerConfig = require('./models/ServerConfig');
      await ServerConfig.findOneAndUpdate(
        { guildId: message.guild.id },
        {
          $inc: { 'autoRepairStats.createdCount': 1 },
          'autoRepairStats.lastRepairAt': new Date()
        }
      );

      // Logger le succès dans admin-logs
      await client.services.logger.logAdminAction(
        message.guild.id,
        `✅ **AUTO-REPAIR** - Canal créé automatiquement\n` +
        `📍 Canal: ${channelName}\n` +
        `🔗 ID Source: ${sourceChannelId}\n` +
        `🎯 Nouveau canal: ${newChannel.id}\n` +
        `📊 Créations cette heure: ${guildStats.count}/10`
      );

      // Notifier dans newroom si le canal existe
      const newroomChannel = message.guild.channels.cache.find(ch => ch.name === 'newroom');
      if (newroomChannel) {
        await newroomChannel.send(
          `🔧 **AUTO-REPAIR**\n` +
          `✨ Nouveau canal créé automatiquement: <#${newChannel.id}>\n` +
          `🔗 Correspondance établie avec le salon source`
        );
      }

      // Supprimer le message d'erreur
      try {
        await message.delete();
      } catch (err) {
      }


    } catch (error) {
      console.error(`❌ [AUTO-REPAIR] Erreur création canal:`, error);
      await client.services.logger.logAdminAction(
        message.guild.id,
        `❌ **AUTO-REPAIR** - Échec création\n` +
        `📍 Canal: ${channelName}\n` +
        `❌ Erreur: ${error.message}`
      );
    }

  } catch (error) {
    console.error('❌ [AUTO-REPAIR] Erreur globale:', error);
  }
}

// 🎭 GESTIONNAIRE DU MENU DÉROULANT DE SÉLECTION DE RÔLES
async function handleRoleSelectMenu(interaction) {
  await interaction.deferReply({ ephemeral: true });
  
  try {
    const selectedRoleValues = interaction.values;
    const member = interaction.member;
    
    let addedRoles = [];
    let removedRoles = [];
    let errorRoles = [];
    
    // 🔧 FORCER LA MISE À JOUR DU CACHE MEMBRE AVANT TRAITEMENT
    await member.fetch();
    
    for (const roleValue of selectedRoleValues) {
      try {
        // 🔧 CORRECTION : Utiliser la map pour récupérer le nom du rôle depuis l'ID court
        const roleName = roleIdMapping.get(roleValue);

        if (!roleName) {
          console.error(`❌ Nom de rôle introuvable pour l'ID: ${roleValue}`);
          continue;
        }

        // Trouver le rôle sur le serveur
        const role = interaction.guild.roles.cache.find(r => r.name === roleName);

        if (!role) {
          errorRoles.push(roleName);
          continue;
        }
        
        // 🔧 VÉRIFICATION ROBUSTE : Refetch le membre pour avoir le cache à jour
        const freshMember = await interaction.guild.members.fetch(member.id);
        
        // Vérifier si l'utilisateur a déjà ce rôle
        if (freshMember.roles.cache.has(role.id)) {
          // Retirer le rôle
          await freshMember.roles.remove(role);
          removedRoles.push(roleName);
          
        } else {
          // Ajouter le rôle
          await freshMember.roles.add(role);
          addedRoles.push(roleName);
          
        }
        
        // Délai plus long pour éviter les race conditions
        await new Promise(resolve => setTimeout(resolve, 200));
        
      } catch (error) {
        console.error(`❌ Erreur gestion rôle ${roleName}:`, error);
        errorRoles.push(roleName);
      }
    }
    
    // Construire le message de réponse
    let response = '🎭 **Gestion des rôles terminée !**\n\n';
    
    if (addedRoles.length > 0) {
      response += `✅ **Rôles ajoutés (${addedRoles.length}) :**\n`;
      addedRoles.forEach(role => response += `• ${role}\n`);
      response += '\n';
    }
    
    if (removedRoles.length > 0) {
      response += `➖ **Rôles retirés (${removedRoles.length}) :**\n`;
      removedRoles.forEach(role => response += `• ${role}\n`);
      response += '\n';
    }
    
    if (errorRoles.length > 0) {
      response += `❌ **Erreurs (${errorRoles.length}) :**\n`;
      errorRoles.forEach(role => response += `• ${role}\n`);
      response += '\n';
    }
    
    response += `💡 **Astuce :** Utilisez le bouton "Rafraîchir mes rôles" pour voir vos rôles actuels.`;
    
    await interaction.editReply(response);
    
  } catch (error) {
    console.error('❌ Erreur menu rôles:', error);
    await interaction.editReply('❌ **Erreur lors de la gestion des rôles.** Veuillez réessayer.');
  }
}

// 🔄 GESTIONNAIRE DU BOUTON "RAFRAÎCHIR MES RÔLES"
async function handleRefreshUserRoles(interaction) {
  await interaction.deferReply({ ephemeral: true });
  
  try {
    const member = interaction.member;
    
    // 🔧 FORCER LA MISE À JOUR DU CACHE MEMBRE
    const freshMember = await interaction.guild.members.fetch(member.id);
    
    // Récupérer tous les rôles de l'utilisateur (exclure @everyone et rôles système)
    const userRoles = freshMember.roles.cache.filter(role => 
      role.name !== '@everyone' && 
      !['ladmin', 'lmembres'].includes(role.name)
    );
    
    let response = `🎭 **Vos rôles actuels :**\n\n`;
    
    if (userRoles.size === 0) {
      response += `ℹ️ **Aucun rôle assigné pour le moment.**\n\n`;
      response += `💡 Utilisez les menus déroulants ci-dessus pour vous attribuer des rôles !`;
    } else {
      response += `📊 **Total :** ${userRoles.size} rôle(s)\n\n`;
      
      // 🚨 LIMITATION POUR ÉVITER LE DÉPASSEMENT DE 2000 CARACTÈRES
      const maxRolesToShow = 50; // Limiter à 50 rôles pour éviter le dépassement
      const rolesToShow = Array.from(userRoles.values()).slice(0, maxRolesToShow);
      
      for (const role of rolesToShow) {
        const colorHex = role.color ? `\`#${role.color.toString(16).padStart(6, '0')}\`` : '`#000000`';
        const roleEntry = `• **${role.name}** ${colorHex}\n`;
        
        // Vérifier si l'ajout de ce rôle dépasse la limite
        if ((response + roleEntry).length > 1800) { // Marge de sécurité
          const remaining = userRoles.size - rolesToShow.indexOf(role);
          response += `\n... et ${remaining} autres rôles\n`;
          response += `\n💡 **Astuce :** Trop de rôles pour tout afficher ! Utilisez les menus pour les gérer.`;
          break;
        }
        
        response += roleEntry;
      }
      
      // Si tous les rôles ont été affichés
      if (rolesToShow.length === userRoles.size && userRoles.size <= maxRolesToShow) {
        response += `\n💡 **Astuce :** Sélectionnez un rôle que vous avez déjà pour le retirer !`;
      } else if (userRoles.size > maxRolesToShow) {
        const remaining = userRoles.size - maxRolesToShow;
        response += `\n... et ${remaining} autres rôles\n`;
        response += `\n💡 **Note :** Vous avez ${userRoles.size} rôles au total. Seuls les premiers ${maxRolesToShow} sont affichés pour éviter le spam.`;
      }
    }
    
    await interaction.editReply(response);
    
  } catch (error) {
    console.error('❌ Erreur rafraîchissement rôles:', error);
    await interaction.editReply('❌ **Erreur lors de l\'affichage des rôles.** Veuillez réessayer.');
  }
}

// 🗑️ GESTIONNAIRE DU BOUTON "RETIRER TOUS MES RÔLES"
async function handleClearAllRoles(interaction) {
  await interaction.deferReply({ ephemeral: true });
  
  try {
    const member = interaction.member;
    
    // 🔧 FORCER LA MISE À JOUR DU CACHE MEMBRE
    const freshMember = await interaction.guild.members.fetch(member.id);
    
    // Récupérer tous les rôles de l'utilisateur (exclure @everyone et rôles système)
    const userRoles = freshMember.roles.cache.filter(role => 
      role.name !== '@everyone' && 
      !['ladmin', 'lmembres'].includes(role.name)
    );
    
    if (userRoles.size === 0) {
      await interaction.editReply('ℹ️ **Vous n\'avez aucun rôle à retirer !**');
      return;
    }
    
    let removedCount = 0;
    let errorCount = 0;
    let removedRoles = [];
    
    for (const role of userRoles.values()) {
      try {
        await freshMember.roles.remove(role);
        removedRoles.push(role.name);
        removedCount++;
        
        
        // Délai plus long pour éviter les race conditions
        await new Promise(resolve => setTimeout(resolve, 200));
        
      } catch (error) {
        console.error(`❌ Erreur suppression rôle ${role.name}:`, error);
        errorCount++;
      }
    }
    
    let response = `🗑️ **Nettoyage des rôles terminé !**\n\n`;
    response += `✅ **Rôles retirés :** ${removedCount}\n`;
    
    if (errorCount > 0) {
      response += `❌ **Erreurs :** ${errorCount}\n`;
    }
    
    if (removedRoles.length > 0) {
      response += `\n**Rôles supprimés :**\n`;
      removedRoles.forEach(role => response += `• ${role}\n`);
    }
    
    response += `\n💡 Vous pouvez maintenant sélectionner de nouveaux rôles avec les menus déroulants !`;
    
    await interaction.editReply(response);
    
  } catch (error) {
    console.error('❌ Erreur suppression rôles:', error);
    await interaction.editReply('❌ **Erreur lors de la suppression des rôles.** Veuillez réessayer.');
  }
}

// ➕ GESTIONNAIRE DU BOUTON "AJOUTER TOUS LES RÔLES"
async function handleAddAllRoles(interaction) {
  await interaction.deferReply({ ephemeral: true });
  
  try {
    const member = interaction.member;
    
    // Récupérer le serveur source pour obtenir la liste de tous les rôles disponibles
    const sourceGuild = client.services.userClient.getSourceGuild(interaction.guild.id);

    if (!sourceGuild) {
      await interaction.editReply('❌ Configuration serveur source manquante. Vérifiez SERVER_ID dans les variables d\'environnement Coolify.');
      return;
    }
    const userData = client.services.userClient.getUserData(interaction.guild.id);
    const sourceRoles = await client.services.userClient.fetchGuildRoles(userData.token, sourceGuild.id);
    
    // Filtrer les rôles disponibles (même logique que pour la génération du système)
    const availableRoleNames = sourceRoles.filter(role => 
      role.name !== '@everyone' && 
      !role.managed &&
      !['ladmin', 'lmembres'].includes(role.name) &&
      !role.name.toLowerCase().includes('staff') &&
      !role.name.toLowerCase().includes('admin') &&
      !role.name.toLowerCase().includes('mod')
    ).map(role => role.name);
    
    // 🔧 FORCER LA MISE À JOUR DU CACHE MEMBRE
    const freshMember = await interaction.guild.members.fetch(member.id);
    
    // Trouver les rôles qui existent sur le serveur mirror
    const availableRoles = [];
    for (const roleName of availableRoleNames) {
      const role = interaction.guild.roles.cache.find(r => r.name === roleName);
      if (role && !freshMember.roles.cache.has(role.id)) {
        availableRoles.push(role);
      }
    }
    
    if (availableRoles.length === 0) {
      await interaction.editReply('ℹ️ **Vous avez déjà tous les rôles disponibles !**\n\n💡 Ou aucun rôle n\'est disponible pour attribution.');
      return;
    }
    
    let addedCount = 0;
    let errorCount = 0;
    let addedRoles = [];
    
    await interaction.editReply(`⏳ **Ajout de ${availableRoles.length} rôles en cours...**`);
    
    for (const role of availableRoles) {
      try {
        await freshMember.roles.add(role);
        addedRoles.push(role.name);
        addedCount++;
        
        
        // Délai plus long pour éviter les race conditions
        await new Promise(resolve => setTimeout(resolve, 200));
        
      } catch (error) {
        console.error(`❌ Erreur ajout rôle ${role.name}:`, error);
        errorCount++;
      }
    }
    
    let response = `➕ **Ajout de tous les rôles terminé !**\n\n`;
    response += `✅ **Rôles ajoutés :** ${addedCount}\n`;
    
    if (errorCount > 0) {
      response += `❌ **Erreurs :** ${errorCount}\n`;
    }
    
    if (addedRoles.length > 0) {
      response += `\n**Rôles ajoutés :**\n`;
      // Limiter l'affichage pour éviter les messages trop longs
      const displayRoles = addedRoles.slice(0, 20);
      displayRoles.forEach(role => response += `• ${role}\n`);
      
      if (addedRoles.length > 20) {
        response += `... et ${addedRoles.length - 20} autres rôles\n`;
      }
    }
    
    response += `\n💡 **Astuce :** Utilisez "Rafraîchir mes rôles" pour voir tous vos rôles actuels !`;
    
    await interaction.editReply(response);
    
  } catch (error) {
    console.error('❌ Erreur ajout de tous les rôles:', error);
    await interaction.editReply('❌ **Erreur lors de l\'ajout des rôles.** Veuillez réessayer.');
  }
}

// Note: La fonction handleButtonInteraction a été supprimée car les boutons "Y aller" sont maintenant des liens directs

// 🔔 CRÉER AUTOMATIQUEMENT LE SALON MENTION-LOGS
async function ensureMentionLogsChannel(guild) {
  try {
    const { getNotificationChannelIdFromDB, saveNotificationChannelToDB, autoDetectNotificationChannel, updateNotificationChannelId } = require('./config/notificationChannels');
    const { addProtectedChannelId } = require('./utils/protectedChannels');

    // 1. PRIORITÉ: Vérifier config en DB (persistante)
    let mentionLogsId = await getNotificationChannelIdFromDB(guild.id, 'MENTIONS_LOG');

    if (mentionLogsId) {
      const existingChannel = guild.channels.cache.get(mentionLogsId);
      if (existingChannel) {
        addProtectedChannelId(mentionLogsId);
        console.log(`✅ Salon mention-logs existant trouvé: #${existingChannel.name} (${mentionLogsId})`);
        return existingChannel;
      } else {
        console.log(`⚠️ Salon mention-logs configuré mais supprimé, recréation...`);
        mentionLogsId = null;
      }
    }

    // 2. Essayer l'auto-détection
    if (!mentionLogsId) {
      mentionLogsId = autoDetectNotificationChannel(guild);
      if (mentionLogsId) {
        const detectedChannel = guild.channels.cache.get(mentionLogsId);
        // Sauvegarder en DB pour persistance
        await saveNotificationChannelToDB(guild.id, 'MENTIONS_LOG', mentionLogsId);
        addProtectedChannelId(mentionLogsId);
        console.log(`🔍 Salon mention-logs auto-détecté et sauvegardé: #${detectedChannel.name}`);
        return detectedChannel;
      }
    }

    // 3. Créer automatiquement le salon s'il n'existe pas
    console.log(`🔔 Création automatique du salon mention-logs...`);

    // Créer le salon mention-logs en position 0 (tout en haut du serveur)
    const mentionLogsChannel = await guild.channels.create({
      name: 'mention-logs',
      type: 0, // Text channel
      position: 0, // Tout en haut du serveur
      topic: 'Notifications automatiques des mentions de rôles et @everyone 🔔',
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          allow: ['ViewChannel', 'ReadMessageHistory'],
          deny: ['SendMessages', 'AddReactions']
        }
      ]
    });

    // 🆕 Sauvegarder en DB pour persistance (survit aux restarts)
    await saveNotificationChannelToDB(guild.id, 'MENTIONS_LOG', mentionLogsChannel.id);
    addProtectedChannelId(mentionLogsChannel.id);

    // Envoyer un message de bienvenue amélioré
    const { EmbedBuilder } = require('discord.js');
    const welcomeEmbed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('🔔 Salon Mention-Logs Configuré Automatiquement')
      .setDescription('Ce salon va recevoir automatiquement toutes les notifications de mentions du système Mirror.')
      .addFields([
        {
          name: '✅ Configuration automatique',
          value: '• Salon créé et configuré automatiquement\n• Configuration persistante (survit aux redémarrages)\n• Protection contre la suppression activée',
          inline: false
        },
        {
          name: '🔔 Détections activées',
          value: '• **@everyone/@here** : Activé\n• **Mentions de rôles** : Activé\n• **Messages de bots** : Ignorés par défaut',
          inline: false
        },
        {
          name: '🛠️ Commandes de gestion',
          value: '• `/notification-channels` - Modifier la configuration\n• `/mention-blacklist` - Exclure des salons des notifications',
          inline: false
        }
      ])
      .setTimestamp()
      .setFooter({ text: 'Configuration sauvegardée en base de données' });

    await mentionLogsChannel.send({ embeds: [welcomeEmbed] });

    console.log(`✅ Salon mention-logs créé et configuré: #${mentionLogsChannel.name} (${mentionLogsChannel.id})`);
    return mentionLogsChannel;

  } catch (error) {
    console.error('❌ Erreur création salon mention-logs:', error);
    throw error;
  }
}

// 🆕 SAUVEGARDER L'ÉTAT D'INITIALISATION
async function saveInitializationState(guildId) {
  try {
    const ServerConfig = require('./models/ServerConfig');
    
    await ServerConfig.findOneAndUpdate(
      { guildId: guildId },
      {
        $set: {
          botInitialized: true,
          systemRolesCreated: true,
          logChannelsCreated: true,
          adminLogsCreated: true,
          initializedAt: new Date(),
          hasValidConfig: true
        }
      },
      { upsert: true, new: true }
    );
    
  } catch (error) {
    console.error('❌ Erreur sauvegarde initialisation:', error);
  }
}

// Restauration des délais globaux depuis la base
async function restoreGlobalDelays() {
  try {
    const ServerConfig = require('./models/ServerConfig');
    const configs = await ServerConfig.find({ 
      botInitialized: true,
      'scrapingSettings.delaySeconds': { $exists: true }
    });
    
    // Utiliser le délai le plus récent configuré
    let mostRecentDelay = null;
    let mostRecentDate = null;
    
    for (const config of configs) {
      if (config.scrapingSettings?.delaySeconds && config.scrapingSettings?.lastUpdated) {
        if (!mostRecentDate || config.scrapingSettings.lastUpdated > mostRecentDate) {
          mostRecentDelay = config.scrapingSettings.delaySeconds;
          mostRecentDate = config.scrapingSettings.lastUpdated;
        }
      }
    }
    
    if (mostRecentDelay) {
      const delayMs = mostRecentDelay * 1000;
      process.env.DEFAULT_SCRAPE_DELAY = delayMs.toString();
    }
    
  } catch (error) {
    console.error('❌ Erreur restauration délais:', error);
  }
}

// Auto-initialisation au démarrage
async function autoInitializeIfNeeded() {
  try {
    const ServerConfig = require('./models/ServerConfig');
    const configs = await ServerConfig.find({ botInitialized: true });
    
    for (const config of configs) {
      try {
        const guild = client.guilds.cache.get(config.guildId);
        if (!guild) continue;
        
        // Restaurer les rôles système
        await ensureSystemRoles(guild);
        
        // Restaurer les salons de log
        await client.services.logger.initializeLogChannels(guild);
        
        // 🔔 RESTAURER/CRÉER LE SALON MENTION-LOGS AUTOMATIQUEMENT
        await ensureMentionLogsChannel(guild);
        
        // Mettre à jour le flag admin-logs si nécessaire
        if (!config.adminLogsCreated) {
          await ServerConfig.updateOne(
            { guildId: config.guildId },
            { $set: { adminLogsCreated: true } }
          );
        }
      } catch (error) {
        console.error(`❌ Auto-init ${config.guildId}:`, error);
      }
    }
  } catch (error) {
    console.error('❌ Erreur auto-initialisation:', error);
  }
}

// Service wrapper pour les tokens utilisateur (remplace l'ancien createUserClient)
async function addUserToken(targetGuildId, userToken, serverId) {
  try {
    
    const result = await client.services.userClient.addUserToken(targetGuildId, userToken, serverId);
    
    return result;
  } catch (error) {
    console.error('❌ Erreur configuration token utilisateur:', error);
    throw error;
  }
}

// Fonction pour vérifier les permissions admin
function checkAdminPermission(interaction) {
  const member = interaction.member;
  const isAdmin = member.roles.cache.some(role => role.name === 'ladmin') || 
                  member.permissions.has(PermissionFlagsBits.Administrator) ||
                  member.guild.ownerId === member.id;
  
  if (!isAdmin) {
    return {
      hasPermission: false,
      error: '❌ Cette commande nécessite le rôle @ladmin ou des permissions administrateur.'
    };
  }
  
  return { hasPermission: true };
}

// Handlers des commandes
async function handleInitialise(interaction) {
  const permissionCheck = checkAdminPermission(interaction);
  if (!permissionCheck.hasPermission) {
    await interaction.reply(permissionCheck.error);
    return;
  }
  
  await interaction.deferReply();
  
  try {
    const guild = interaction.guild;
    
    // Vérifier si déjà initialisé
    const existingConfig = await client.services.userClient.getSavedConfig(guild.id);
    if (existingConfig && existingConfig.botInitialized) {
      await interaction.editReply('ℹ️ **Bot déjà initialisé !**\n\n✅ Rôles système et salons de maintenance déjà configurés.\n🔄 **Restauration automatique active** - Plus besoin de réinitialiser !\n\n💡 **Prochaine étape :** Utilisez `/start` pour démarrer le scraping.');
      return;
    }
    
    // Créer les rôles système
    const { adminRole, memberRole } = await ensureSystemRoles(guild);
    
    // Initialiser les salons de log
    await client.services.logger.initializeLogChannels(guild);
    
    // 🆕 CRÉER AUTOMATIQUEMENT LE SALON MENTION-LOGS
    await ensureMentionLogsChannel(guild);

    // 🆕 SAUVEGARDER L'ÉTAT D'INITIALISATION
    await saveInitializationState(guild.id);

    // 🚀 NOUVEAU: Déployer les commandes spécifiques à cette guilde
    try {
      const guildCommands = await guild.commands.set(GUILD_COMMANDS);
    } catch (error) {
      console.error(`❌ Erreur déploiement commandes:`, error);
    }
    
    botInitialized = true;
    
    await interaction.editReply('✅ **Bot Mirror initialisé avec succès !**\n\n🎯 Rôles @ladmin et @lmembres créés\n📁 Salons de maintenance configurés\n🔔 **Salon mention-logs configuré automatiquement**\n💾 **État sauvegardé** - Plus besoin de réinitialiser après les redémarrages !\n\n🔐 **Prochaine étape :** Utilisez `/start` pour démarrer le scraping automatique.');
  } catch (error) {
    await interaction.editReply(`❌ Erreur lors de l'initialisation: ${error.message}`);
  }
}

// 🆕 SAUVEGARDER UN HINT DU TOKEN POUR AIDE-MÉMOIRE
async function saveTokenHint(guildId, tokenHint) {
  try {
    const ServerConfig = require('./models/ServerConfig');
    
    await ServerConfig.findOneAndUpdate(
      { guildId: guildId },
      { $set: { lastTokenHint: tokenHint } },
      { upsert: true, new: true }
    );
    
  } catch (error) {
    console.error('❌ Erreur sauvegarde hint token:', error);
  }
}

// 🆕 VÉRIFIER SI DES SALONS ONT DÉJÀ ÉTÉ CLONÉS
async function checkIfChannelsExist(guild) {
  try {
    // Compter les salons non-système
    const systemChannels = ['newroom', 'error', 'roles-logs', 'admin-logs', 'members-log', 'commands'];
    const nonSystemChannels = guild.channels.cache.filter(ch => 
      (ch.type === 0 || ch.type === 2) && // TEXT ou VOICE
      !systemChannels.includes(ch.name) &&
      ch.parent?.name !== 'Maintenance'
    );
    
    return nonSystemChannels.size > 0;
  } catch (error) {
    console.error('❌ Erreur vérification salons:', error);
    return false;
  }
}

// 🆕 RESTAURER LES DÉLAIS POUR UN SERVEUR SPÉCIFIQUE
// 🗑️ FONCTION SUPPRIMÉE : restoreDelaysForGuild (système de polling supprimé)

// 🆕 FONCTION DE REDÉMARRAGE AUTOMATIQUE (ÉVÉNEMENTIEL)
async function autoRestartScraping(targetGuild, restoration) {
  try {
    
    // Récupérer le serveur source
    const sourceGuild = client.services.userClient.getSourceGuild(targetGuild.id);
    
    // Redémarrer le scraping événementiel
    await client.services.scraper.startEventBasedScraping(
      targetGuild,
      { id: sourceGuild.id, name: sourceGuild.name },
      client.services.userClient
    );

    // Marquer comme actif en base
    await client.services.userClient.markScrapingActive(targetGuild.id);

    // 🔄 Démarrer le service de synchronisation si pas déjà actif
    if (client.services.channelSync && !client.services.channelSync.syncInterval) {
      await client.services.channelSync.start();
    }
    
    return true;
  } catch (error) {
    console.error('❌ Erreur redémarrage automatique:', error);
    throw error;
  }
}

async function handleSyncRoles(interaction) {
  const permissionCheck = checkAdminPermission(interaction);
  if (!permissionCheck.hasPermission) {
    await interaction.reply(permissionCheck.error);
    return;
  }
  
  await interaction.deferReply();

  try {
    // Récupérer le serveur source configuré
    const sourceGuild = client.services.userClient.getSourceGuild(interaction.guild.id);

    if (!sourceGuild) {
      await interaction.editReply('❌ Configuration serveur source manquante. Vérifiez SERVER_ID dans les variables d\'environnement Coolify.');
      return;
    }

    await interaction.editReply('🔄 **Synchronisation des rôles en cours...**');

    // Récupérer les données du token utilisateur
    const userData = client.services.userClient.getUserData(interaction.guild.id);
    
    // Récupérer les rôles du serveur source via API directe
    const sourceRoles = await client.services.userClient.fetchGuildRoles(userData.token, sourceGuild.id);
    
    // Filtrer les rôles à exclure
    const excludeRoles = ['@everyone', 'ladmin', 'lmembres'];
    const rolesToSync = sourceRoles.filter(role => 
      !excludeRoles.includes(role.name) && 
      !role.managed && // Ignorer les rôles managés par les bots
      role.name !== '@everyone'
    );
    
    let syncedCount = 0;
    let errorCount = 0;
    
    // Synchroniser chaque rôle
    let securedRolesCount = 0;
    let adminRolesSecured = 0;
    
    for (const sourceRole of rolesToSync) {
      try {
        // 🔒 ANALYSER ET FILTRER LES PERMISSIONS POUR LA SÉCURITÉ
        const permissionAnalysis = analyzeRolePermissions(sourceRole);
        const safePermissions = filterSafePermissions(sourceRole.permissions);
        
        // 🔍 COMPTER LES RÔLES SÉCURISÉS
        if (permissionAnalysis.filteringRequired) {
          securedRolesCount++;
          if (permissionAnalysis.hasAdministrator) {
            adminRolesSecured++;
          }
        }
        
        // Vérifier si le rôle existe déjà
        let existingRole = interaction.guild.roles.cache.find(role => role.name === sourceRole.name);
        
        if (existingRole) {
          // Mettre à jour le rôle existant avec permissions filtrées
          await existingRole.edit({
            name: sourceRole.name,
            color: sourceRole.color,
            permissions: safePermissions, // 🔒 PERMISSIONS FILTRÉES
            hoist: sourceRole.hoist,
            mentionable: sourceRole.mentionable
          });
        } else {
          // Créer un nouveau rôle avec permissions filtrées
          const newRole = await interaction.guild.roles.create({
            name: sourceRole.name,
            color: sourceRole.color,
            permissions: safePermissions, // 🔒 PERMISSIONS FILTRÉES
            hoist: sourceRole.hoist,
            mentionable: sourceRole.mentionable
          });
        }
        
        syncedCount++;
        
        // Sauvegarder en base de données
        await client.services.roleManager.saveRoleToDatabase(
          existingRole || interaction.guild.roles.cache.find(r => r.name === sourceRole.name), 
          sourceGuild.id
        );
        
        // 🔍 LOG AVEC INFO SÉCURITÉ SI NÉCESSAIRE
        let logMessage = `Rôle synchronisé: ${sourceRole.name} (couleur: #${sourceRole.color?.toString(16) || '000000'})`;
        if (permissionAnalysis.filteringRequired) {
          logMessage += `\n🔒 **SÉCURISÉ** - ${permissionAnalysis.dangerousPermissionsCount} permissions dangereuses supprimées`;
          if (permissionAnalysis.hasAdministrator) {
            logMessage += `\n🚫 **ADMIN NEUTRALISÉ** - Permission Administrator supprimée`;
          }
        }
        
        await client.services.logger.logRoleAction(interaction.guild.id, logMessage);
        
        // Délai pour éviter les rate limits
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (error) {
        console.log(`❌ Rôle ${sourceRole.name}: Échec sync`);
        errorCount++;
        
        await client.services.logger.logRoleAction(
          interaction.guild.id,
          `Erreur synchronisation rôle ${sourceRole.name}: ${error.message}`
        );
      }
    }
    
    let reportMessage = `✅ **Synchronisation terminée !**\n\n` +
      `👥 **Rôles synchronisés:** ${syncedCount}\n` +
      `❌ **Erreurs:** ${errorCount}\n` +
      `🏠 **Serveur source:** ${sourceGuild.name}\n` +
      `📝 **Rôles ignorés:** Rôles système et managés automatiquement\n`;
    
    // 🔒 AJOUTER INFORMATIONS DE SÉCURITÉ SI APPLICABLE
    if (securedRolesCount > 0) {
      reportMessage += `\n**🔒 SÉCURITÉ :**\n` +
        `• 🛡️ ${securedRolesCount} rôles sécurisés (permissions filtrées)\n` +
        `• 🚫 ${adminRolesSecured} rôles admin neutralisés\n` +
        `• ✅ **Serveur mirror PROTÉGÉ** contre élévation admin\n`;
    }
    
    reportMessage += `\n💡 **Prochaine étape :** Utilisez \`/setup-roles\` pour créer un système de rôles automatique pour vos utilisateurs.`;
    
    await interaction.editReply(reportMessage);
  } catch (error) {
    console.log('❌ Synchronisation: Échec global');
    await interaction.editReply(`❌ Erreur lors de la synchronisation: ${error.message}`);
  }
}

// 🔗 SYNCHRONISATION DES CORRESPONDANCES ENTRE SERVEUR DISTANT ET MIRROR
async function handleFixCorrespondances(interaction) {
  const permissionCheck = checkAdminPermission(interaction);
  if (!permissionCheck.hasPermission) {
    await interaction.reply(permissionCheck.error);
    return;
  }
  
  await interaction.deferReply();

  try {
    const sourceGuild = client.services.userClient.getSourceGuild(interaction.guild.id);

    if (!sourceGuild) {
      await interaction.editReply('❌ Configuration serveur source manquante. Vérifiez SERVER_ID dans les variables d\'environnement Coolify.');
      return;
    }

    await interaction.editReply('🔧 **Réparation des correspondances de salons en cours...**\n⏳ Analyse des salons existants...');

    const userData = client.services.userClient.getUserData(interaction.guild.id);
    const sourceChannels = await client.services.userClient.fetchGuildChannels(userData.token, sourceGuild.id);
    
    let fixed = 0;
    let alreadyMapped = 0;
    let notFound = 0;
    const Channel = require('./models/Channel');
    
    for (const sourceChannel of sourceChannels) {
      // Traiter uniquement les salons texte, vocaux, annonces et forums
      if (sourceChannel.type === 0 || sourceChannel.type === 2 || sourceChannel.type === 5 || sourceChannel.type === 15) {
        // Trouver le salon mirror par nom
        const mirrorChannel = interaction.guild.channels.cache.find(ch =>
          ch.name === sourceChannel.name &&
          (ch.type === 0 || ch.type === 2 || ch.type === 5 || ch.type === 15)
        );
        
        if (mirrorChannel) {
          // Vérifier si sourceChannelId est déjà rempli
          const existingChannel = await Channel.findOne({ discordId: mirrorChannel.id });
          
          if (existingChannel && !existingChannel.sourceChannelId) {
            // Mettre à jour la DB avec sourceChannelId
            existingChannel.sourceChannelId = sourceChannel.id;
            await existingChannel.save();
            
            // Enregistrer dans correspondenceManager pour le cache
            if (client.services.correspondenceManager) {
              await client.services.correspondenceManager.registerChannelMapping(
                sourceChannel.id,
                sourceGuild.id,
                sourceChannel.name,
                mirrorChannel.id
              );
            }
            
            fixed++;
          } else if (existingChannel && existingChannel.sourceChannelId) {
            alreadyMapped++;
          } else if (!existingChannel) {
            // Utiliser findOneAndUpdate avec upsert pour éviter les doublons
            await Channel.findOneAndUpdate(
              { sourceChannelId: sourceChannel.id, serverId: sourceGuild.id },
              {
                discordId: mirrorChannel.id,
                serverId: sourceGuild.id,
                sourceChannelId: sourceChannel.id,
                name: sourceChannel.name,
                category: mirrorChannel.parent?.name || null,
                scraped: false,
                inactive: false,
                // Retiré: lastActivity - ne pas mettre à jour lors du clonage
                isActive: true
              },
              { upsert: true, new: true }
            );
            
            if (client.services.correspondenceManager) {
              await client.services.correspondenceManager.registerChannelMapping(
                sourceChannel.id,
                sourceGuild.id,
                sourceChannel.name,
                mirrorChannel.id
              );
            }
            
            fixed++;
          }
        } else {
          notFound++;
        }
      }
    }
    
    // Nettoyer le cache pour forcer le rechargement
    if (client.services.correspondenceManager) {
      client.services.correspondenceManager.clearCache();
    }
    
    const { EmbedBuilder } = require('discord.js');
    const embed = new EmbedBuilder()
      .setTitle('🔧 Réparation des correspondances terminée')
      .setColor(0x00FF00)
      .addFields(
        { name: '✅ Correspondances réparées', value: `${fixed}`, inline: true },
        { name: '📌 Déjà mappées', value: `${alreadyMapped}`, inline: true },
        { name: '❌ Salons non trouvés', value: `${notFound}`, inline: true }
      )
      .addFields(
        { name: '📊 Total analysé', value: `${sourceChannels.filter(ch => ch.type === 0 || ch.type === 2 || ch.type === 5 || ch.type === 15).length} salons`, inline: true },
        { name: '🏠 Serveur source', value: sourceGuild.name, inline: true },
        { name: '🗄️ Cache', value: 'Nettoyé ✅', inline: true }
      )
      .setFooter({ text: 'Les mentions de salons devraient maintenant fonctionner correctement' })
      .setTimestamp();
    
    await interaction.editReply({ content: null, embeds: [embed] });
    
    // Logger l'action
    await client.services.logger.log(
      interaction.guild.id,
      `Réparation correspondances: ${fixed} corrigées, ${alreadyMapped} déjà mappées, ${notFound} non trouvées`
    );
    
  } catch (error) {
    console.error('❌ Erreur réparation correspondances:', error);
    await interaction.editReply(`❌ Erreur lors de la réparation: ${error.message}`);
  }
}

// 🔧 NOUVELLE COMMANDE : Réparer TOUS les mappings (DB + cache) - Solution complète
async function handleFixMappings(interaction) {
  const permissionCheck = checkAdminPermission(interaction);
  if (!permissionCheck.hasPermission) {
    await interaction.reply(permissionCheck.error);
    return;
  }
  
  await interaction.deferReply();

  try {
    const sourceGuild = client.services.userClient.getSourceGuild(interaction.guild.id);

    if (!sourceGuild) {
      await interaction.editReply('❌ Configuration serveur source manquante. Vérifiez SERVER_ID dans les variables d\'environnement Coolify.');
      return;
    }

    await interaction.editReply('🔧 **Réparation complète des mappings en cours...**\n\n📊 Phase 1/3: Analyse des salons...');

    const userData = client.services.userClient.getUserData(interaction.guild.id);
    const sourceChannels = await client.services.userClient.fetchGuildChannels(userData.token, sourceGuild.id);
    
    const Channel = require('./models/Channel');
    const correspondenceManager = client.services.correspondenceManager || new (require('./services/correspondenceManager'))(client, client.services.logger);
    
    let stats = {
      dbFixed: 0,
      dbCreated: 0,
      mappingsCreated: 0,
      alreadyOk: 0,
      orphaned: 0,
      notFound: 0
    };
    
    // Phase 1: Réparer les entrées DB existantes
    await interaction.editReply('🔧 **Réparation complète des mappings en cours...**\n\n📊 Phase 2/3: Réparation de la base de données...');
    
    const allDbChannels = await Channel.find({ serverId: sourceGuild.id });
    
    for (const dbChannel of allDbChannels) {
      // Vérifier si le salon mirror existe toujours
      const mirrorChannel = interaction.guild.channels.cache.get(dbChannel.discordId);
      
      if (mirrorChannel) {
        // Trouver le salon source correspondant
        let sourceChannel = sourceChannels.find(ch => ch.name === dbChannel.name);
        
        // Si pas trouvé par nom, essayer par ID (cas de renommage)
        if (!sourceChannel && dbChannel.sourceChannelId) {
          sourceChannel = sourceChannels.find(ch => ch.id === dbChannel.sourceChannelId);
          
          if (sourceChannel && sourceChannel.name !== dbChannel.name) {
            // Salon renommé détecté !
            dbChannel.name = sourceChannel.name;
            await dbChannel.save();
            stats.dbFixed++;
            
            // Optionnel : Renommer le salon mirror aussi
            if (mirrorChannel.name !== sourceChannel.name) {
              try {
                await mirrorChannel.setName(sourceChannel.name);
              } catch (renameError) {
              }
            }
          }
        }
        
        if (sourceChannel && !dbChannel.sourceChannelId) {
          // Mettre à jour sourceChannelId manquant
          dbChannel.sourceChannelId = sourceChannel.id;
          await dbChannel.save();
          stats.dbFixed++;
          
          // Enregistrer le mapping
          await correspondenceManager.registerChannelMapping(
            sourceChannel.id,
            sourceGuild.id,
            sourceChannel.name,
            mirrorChannel.id
          );
          stats.mappingsCreated++;
          
        } else if (sourceChannel && dbChannel.sourceChannelId) {
          // Vérifier que le mapping existe
          const mappingExists = await correspondenceManager.getMirrorChannelId(
            dbChannel.sourceChannelId,
            sourceGuild.id,
            interaction.guild.id
          );
          
          if (!mappingExists) {
            await correspondenceManager.registerChannelMapping(
              dbChannel.sourceChannelId,
              sourceGuild.id,
              dbChannel.name,
              mirrorChannel.id
            );
            stats.mappingsCreated++;
          } else {
            stats.alreadyOk++;
          }
        } else if (!sourceChannel) {
          stats.orphaned++;
        }
      }
    }
    
    // Phase 2: Créer les entrées manquantes pour les salons existants
    await interaction.editReply('🔧 **Réparation complète des mappings en cours...**\n\n📊 Phase 3/3: Création des mappings manquants...');
    
    for (const sourceChannel of sourceChannels) {
      if (sourceChannel.type === 0 || sourceChannel.type === 2 || sourceChannel.type === 5 || sourceChannel.type === 15) {
        const mirrorChannel = interaction.guild.channels.cache.find(ch =>
          ch.name === sourceChannel.name &&
          (ch.type === 0 || ch.type === 2 || ch.type === 5 || ch.type === 15)
        );
        
        if (mirrorChannel) {
          const existingDb = await Channel.findOne({ discordId: mirrorChannel.id });

          if (!existingDb) {
            // Utiliser findOneAndUpdate avec upsert pour éviter les doublons
            await Channel.findOneAndUpdate(
              { sourceChannelId: sourceChannel.id, serverId: sourceGuild.id },
              {
                discordId: mirrorChannel.id,
                serverId: sourceGuild.id,
                sourceChannelId: sourceChannel.id,
                name: sourceChannel.name,
                category: mirrorChannel.parent?.name || null,
                scraped: false,
                inactive: false,
                // Retiré: lastActivity - ne pas mettre à jour lors du clonage
                isActive: true
              },
              { upsert: true, new: true }
            );
            stats.dbCreated++;
            
            // Créer le mapping
            await correspondenceManager.registerChannelMapping(
              sourceChannel.id,
              sourceGuild.id,
              sourceChannel.name,
              mirrorChannel.id
            );
            stats.mappingsCreated++;
            
          }
        } else {
          stats.notFound++;
        }
      }
    }
    
    // Phase 3: Gérer les threads de forum
    await interaction.editReply('🔧 **Réparation complète des mappings en cours...**\n\n📊 Phase 4/4: Vérification des threads de forum...');
    
    let threadsFixed = 0;
    
    // Parcourir tous les forums pour mapper les threads
    const forums = interaction.guild.channels.cache.filter(ch => ch.type === 15); // Type 15 = Forum
    
    for (const [forumId, forum] of forums) {
      // Chercher le forum source correspondant
      const forumMapping = await Channel.findOne({ discordId: forumId, serverId: sourceGuild.id });
      
      if (forumMapping && forumMapping.sourceChannelId) {
        // Récupérer les threads actifs du forum
        const threads = forum.threads.cache;
        
        for (const [threadId, thread] of threads) {
          // Vérifier si le thread a un mapping
          const threadMapping = await Channel.findOne({ discordId: threadId });
          
          if (!threadMapping) {
            // Chercher le thread source correspondant par nom
            const sourceForumThreads = sourceChannels.filter(ch => 
              ch.parent_id === forumMapping.sourceChannelId && 
              ch.name === thread.name
            );
            
            if (sourceForumThreads.length > 0) {
              const sourceThread = sourceForumThreads[0];

              // Utiliser findOneAndUpdate avec upsert pour éviter les doublons
              await Channel.findOneAndUpdate(
                { sourceChannelId: sourceThread.id, serverId: sourceGuild.id },
                {
                  discordId: threadId,
                  serverId: sourceGuild.id,
                  sourceChannelId: sourceThread.id,
                  name: thread.name,
                  category: forum.name,
                  // Retiré: lastActivity - ne pas mettre à jour lors du clonage
                  isActive: true,
                  scraped: false,
                  inactive: false
                },
                { upsert: true, new: true }
              );
              
              // Enregistrer le mapping
              await correspondenceManager.registerChannelMapping(
                sourceThread.id,
                sourceGuild.id,
                thread.name,
                threadId
              );
              
              threadsFixed++;
            }
          }
        }
      }
    }
    
    stats.threadsFixed = threadsFixed;
    
    // Phase 4: Synchronisation finale et nettoyage cache
    await correspondenceManager.clearCache();
    
    // Créer l'embed de résultat
    const { EmbedBuilder } = require('discord.js');
    const embed = new EmbedBuilder()
      .setTitle('🔧 Réparation complète des mappings terminée')
      .setColor(0x00FF00)
      .setDescription('Tous les mappings de salons ont été vérifiés et réparés.')
      .addFields(
        { name: '🔧 Entrées DB réparées', value: `${stats.dbFixed}`, inline: true },
        { name: '➕ Entrées DB créées', value: `${stats.dbCreated}`, inline: true },
        { name: '🔗 Mappings créés', value: `${stats.mappingsCreated}`, inline: true },
        { name: '✅ Déjà corrects', value: `${stats.alreadyOk}`, inline: true },
        { name: '🧵 Threads réparés', value: `${stats.threadsFixed || 0}`, inline: true },
        { name: '❌ Non trouvés', value: `${stats.notFound}`, inline: true }
      )
      .addFields(
        { name: '📊 Total analysé', value: `${sourceChannels.filter(ch => ch.type === 0 || ch.type === 2 || ch.type === 5 || ch.type === 15).length} salons source`, inline: false },
        { name: '🏠 Serveur', value: `${sourceGuild.name} → ${interaction.guild.name}`, inline: false },
        { name: '💾 État', value: 'Base de données ✅\nCache nettoyé ✅\nMappings synchronisés ✅', inline: false }
      )
      .setFooter({ text: 'Les erreurs "#inconnu" devraient être résolues' })
      .setTimestamp();
    
    await interaction.editReply({ content: null, embeds: [embed] });
    
    // Logger l'action
    await client.services.logger.log(
      interaction.guild.id,
      `Réparation mappings complète: ${stats.dbFixed} DB réparées, ${stats.dbCreated} DB créées, ${stats.mappingsCreated} mappings créés`
    );
    
  } catch (error) {
    console.error('❌ Erreur réparation mappings:', error);
    await interaction.editReply(`❌ Erreur lors de la réparation: ${error.message}`);
  }
}

async function handleSyncCorrespondances(interaction) {
  const permissionCheck = checkAdminPermission(interaction);
  if (!permissionCheck.hasPermission) {
    await interaction.reply(permissionCheck.error);
    return;
  }
  
  await interaction.deferReply();

  try {
    // Récupérer les informations du serveur source
    const sourceGuild = client.services.userClient.getSourceGuild(interaction.guild.id);

    if (!sourceGuild) {
      await interaction.editReply('❌ Configuration serveur source manquante. Vérifiez SERVER_ID dans les variables d\'environnement Coolify.');
      return;
    }

    await interaction.editReply('🔄 **Synchronisation des correspondances en cours...**');
    const userData = client.services.userClient.getUserData(interaction.guild.id);
    
    let syncedChannels = 0;
    let syncedRoles = 0;
    let errorCount = 0;
    
    // 1. Synchroniser les correspondances de salons
    try {
      const sourceChannels = await client.services.userClient.fetchGuildChannels(userData.token, sourceGuild.id);
      
      for (const sourceChannel of sourceChannels) {
        if (sourceChannel.type === 0 || sourceChannel.type === 2) { // Text et Voice
          try {
            // Chercher le salon correspondant sur le serveur mirror
            const mirrorChannel = interaction.guild.channels.cache.find(ch => ch.name === sourceChannel.name);
            
            if (mirrorChannel) {
              // Enregistrer la correspondance
              await client.services.scraper.correspondenceManager.registerChannelMapping(
                sourceChannel.id, 
                sourceGuild.id, 
                sourceChannel.name, 
                mirrorChannel.id
              );
              syncedChannels++;
            }
          } catch (channelError) {
            console.error(`Erreur salon ${sourceChannel.name}:`, channelError);
            errorCount++;
          }
        }
      }
    } catch (channelsError) {
      console.error('Erreur synchronisation salons:', channelsError);
    }
    
    // 2. Synchroniser les correspondances de rôles
    try {
      const sourceRoles = await client.services.userClient.fetchGuildRoles(userData.token, sourceGuild.id);
      
      for (const sourceRole of sourceRoles) {
        if (sourceRole.name !== '@everyone') {
          try {
            // Chercher le rôle correspondant sur le serveur mirror
            const mirrorRole = interaction.guild.roles.cache.find(role => role.name === sourceRole.name);
            
            if (mirrorRole) {
              // Enregistrer la correspondance
              await client.services.scraper.correspondenceManager.registerRoleMapping(
                sourceRole.id, 
                sourceGuild.id, 
                sourceRole.name, 
                mirrorRole.id
              );
              syncedRoles++;
            }
          } catch (roleError) {
            console.error(`Erreur rôle ${sourceRole.name}:`, roleError);
            errorCount++;
          }
        }
      }
    } catch (rolesError) {
      console.error('Erreur synchronisation rôles:', rolesError);
    }
    
    // Logger l'action
    await client.services.logger.logAdminAction(
      interaction.guild.id,
      `🔗 Correspondances synchronisées par ${interaction.user.tag}\n` +
      `📺 Salons: ${syncedChannels}\n` +
      `🎭 Rôles: ${syncedRoles}\n` +
      `❌ Erreurs: ${errorCount}\n` +
      `🏠 Source: ${sourceGuild.name}`
    );
    
    await interaction.editReply(
      `✅ **Synchronisation des correspondances terminée !**\n\n` +
      `📺 **Salons synchronisés:** ${syncedChannels}\n` +
      `🎭 **Rôles synchronisés:** ${syncedRoles}\n` +
      `❌ **Erreurs:** ${errorCount}\n` +
      `🏠 **Serveur source:** ${sourceGuild.name}\n\n` +
      `🎯 **Résultat :**\n` +
      `• Les mentions de rôles seront maintenant correctement mappées\n` +
      `• Les mentions de salons redirigeront vers les bons salons mirror\n` +
      `• Le bouton "Y aller" des messages Proxcop fonctionnera\n\n` +
      `💡 **Note :** Cette synchronisation se fait automatiquement lors du traitement des messages, mais cette commande permet de pré-remplir la base de données.`
    );
    
  } catch (error) {
    console.error('❌ Sync correspondances: Erreur globale', error);
    await interaction.editReply(`❌ Erreur lors de la synchronisation des correspondances: ${error.message}`);
  }
}

// 🎭 NOUVEAU SYSTÈME DE RÔLES AUTOMATIQUE
async function handleSetupRoles(interaction) {
  const permissionCheck = checkAdminPermission(interaction);
  if (!permissionCheck.hasPermission) {
    await interaction.reply(permissionCheck.error);
    return;
  }

  await interaction.deferReply();

  try {
    // Récupérer le serveur source
    const sourceGuild = client.services.userClient.getSourceGuild(interaction.guild.id);

    if (!sourceGuild) {
      await interaction.editReply('❌ Configuration serveur source manquante. Vérifiez SERVER_ID dans les variables d\'environnement Coolify.');
      return;
    }
    const userData = client.services.userClient.getUserData(interaction.guild.id);

    // Gérer le paramètre mention_role si fourni (STRING maintenant)
    const roleInput = interaction.options.getString('mention_role');
    let mentionRole = null;
    if (roleInput) {
      const MemberResolver = require('./utils/memberResolver');
      mentionRole = await MemberResolver.resolveRole(
        roleInput,
        sourceGuild.id,
        client.services.userClient,
        interaction.guild.id
      );

      if (!mentionRole) {
        await interaction.editReply(`❌ Rôle "${roleInput}" non trouvé sur le serveur source`);
        return;
      }
      // TODO: Utiliser ce rôle pour les mentions dans le système
    }

    // Récupérer tous les rôles du serveur source
    const sourceRoles = await client.services.userClient.fetchGuildRoles(userData.token, sourceGuild.id);
    
    // Filtrer les rôles disponibles pour les utilisateurs (exclure @everyone, rôles managés et système)
    const availableRoles = sourceRoles.filter(role => 
      role.name !== '@everyone' && 
      !role.managed &&
      !['ladmin', 'lmembres'].includes(role.name) &&
      !role.name.toLowerCase().includes('staff') &&
      !role.name.toLowerCase().includes('admin') &&
      !role.name.toLowerCase().includes('mod') &&
      interaction.guild.roles.cache.find(r => r.name === role.name) // Le rôle doit exister sur le serveur mirror
    );
    
    if (availableRoles.length === 0) {
      await interaction.editReply('❌ **Aucun rôle disponible pour les utilisateurs.**\n\nUtilisez `/syncroles` d\'abord pour synchroniser les rôles du serveur source.');
      return;
    }
    
    // Créer ou trouver la catégorie "maintenance"
    let maintenanceCategory = interaction.guild.channels.cache.find(ch => 
      ch.type === 4 && ch.name.toLowerCase().includes('maintenance')
    );
    
    if (!maintenanceCategory) {
      maintenanceCategory = await interaction.guild.channels.create({
        name: '🔧 Maintenance',
        type: 4, // Category
        permissionOverwrites: [
          {
            id: interaction.guild.roles.everyone.id,
            allow: ['ViewChannel', 'ReadMessageHistory'],
            deny: ['SendMessages', 'AddReactions']
          }
        ]
      });
      
    }
    
    // Créer le salon mentions-log s'il n'existe pas déjà
    await ensureMentionLogsChannel(interaction.guild);
    
    // Créer ou mettre à jour le salon "roles"
    let rolesChannel = interaction.guild.channels.cache.find(ch => 
      ch.name === 'roles' && ch.parent?.id === maintenanceCategory.id
    );
    
    if (!rolesChannel) {
      rolesChannel = await interaction.guild.channels.create({
        name: 'roles',
        type: 0, // Text channel
        parent: maintenanceCategory.id,
        topic: 'Sélectionnez vos rôles automatiquement',
        permissionOverwrites: [
          {
            id: interaction.guild.roles.everyone.id,
            allow: ['ViewChannel', 'ReadMessageHistory'],
            deny: ['SendMessages', 'AddReactions']
          }
        ]
      });
      
    } else {
      // Nettoyer les anciens messages
      const messages = await rolesChannel.messages.fetch({ limit: 100 });
      if (messages.size > 0) {
        await rolesChannel.bulkDelete(messages);
      }
    }
    
    // Générer le système de rôles automatique
    await generateRoleSystem(rolesChannel, availableRoles, sourceGuild.name);
    
    // Logger l'action
    await client.services.logger.logAdminAction(
      interaction.guild.id,
      `🎭 Système de rôles créé par ${interaction.user.tag}\n` +
      `📁 Salon: #${rolesChannel.name}\n` +
      `🎯 ${availableRoles.length} rôles disponibles\n` +
      `🏠 Source: ${sourceGuild.name}`
    );
    
    await interaction.editReply(
      `✅ **Système de rôles créé avec succès !**\n\n` +
      `📁 **Salon :** ${rolesChannel}\n` +
      `🎭 **Rôles disponibles :** ${availableRoles.length}\n` +
      `🏠 **Serveur source :** ${sourceGuild.name}\n\n` +
      `🎯 **Fonctionnalités :**\n` +
      `• Menus déroulants automatiques\n` +
      `• Ajout/suppression de rôles en un clic\n` +
      `• Mise à jour automatique des rôles disponibles\n` +
      `• Interface utilisateur intuitive\n\n` +
      `💡 Les utilisateurs peuvent maintenant gérer leurs rôles facilement !`
    );
    
  } catch (error) {
    console.error('❌ Setup roles: Erreur', error);
    await interaction.editReply(`❌ **Erreur lors de la création du système de rôles :** ${error.message}`);
  }
}

// Map globale pour stocker les correspondances rôle-ID
const roleIdMapping = new Map();

// Générer le système de rôles avec menus déroulants (MULTI-MESSAGES)
async function generateRoleSystem(channel, availableRoles, sourceGuildName) {
  const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

  // Vider la map avant de la remplir
  roleIdMapping.clear();
  
  // 🔧 CORRECTION : Dédupliquer les rôles par nom pour éviter les valeurs dupliquées
  const uniqueRoleNames = new Set();
  const deduplicatedRoles = [];
  
  for (const role of availableRoles) {
    if (!uniqueRoleNames.has(role.name)) {
      uniqueRoleNames.add(role.name);
      deduplicatedRoles.push(role);
    } else {
    }
  }
  
  // Utiliser les rôles dédupliqués
  const rolesForMenu = deduplicatedRoles;
  
  
  // Configuration
  const rolesPerMenu = 25; // Discord limite à 25 options par menu
  const maxMenusPerMessage = 5; // Premier message peut avoir 5 menus maintenant
  const maxMenusForAdditionalMessages = 5; // Messages intermédiaires ont 5 menus
  const maxMenusForLastMessage = 4; // Dernier message : 4 menus + boutons
  
  // Calculer le nombre total de menus nécessaires
  const totalMenusNeeded = Math.ceil(rolesForMenu.length / rolesPerMenu);
  
  // Calculer le nombre de messages nécessaires
  let messagesNeeded = 1;
  if (totalMenusNeeded > maxMenusPerMessage) {
    const remainingMenus = totalMenusNeeded - maxMenusPerMessage;
    messagesNeeded += Math.ceil(remainingMenus / maxMenusForAdditionalMessages);
  }
  
  // Créer l'embed principal
  const description = `**Sélectionnez les rôles que vous souhaitez ajouter ou retirer :**\n\n` +
    `🎯 **Serveur source :** ${sourceGuildName}\n` +
    `🔄 **Rôles disponibles :** ${rolesForMenu.length}\n` +
    `📋 **Tous les rôles affichés** dans ${messagesNeeded} message(s)\n\n` +
    `💡 **Comment utiliser :**\n` +
    `• Utilisez les menus déroulants ci-dessous (et messages suivants)\n` +
    `• Sélectionnez un rôle pour l'ajouter/retirer\n` +
    `• Vous pouvez sélectionner plusieurs rôles à la fois\n` +
    `• Cliquez sur "Rafraîchir mes rôles" dans le dernier message pour voir vos rôles actuels`;
  
  const mainEmbed = new EmbedBuilder()
    .setTitle('🎭 Système de Rôles Automatique')
    .setDescription(description)
    .setColor(0x5865F2)
    .setTimestamp()
    .setFooter({ text: 'Système mis à jour automatiquement' });
  
  // Cas spécial : Un seul message (tous les rôles + boutons)
  if (totalMenusNeeded <= 4) { // Laisser 1 slot pour les boutons (max 4 menus + 1 bouton = 5 composants total)
    const components = [];
    
    // Ajouter tous les menus
    for (let i = 0; i < totalMenusNeeded; i++) {
      const startIndex = i * rolesPerMenu;
      const endIndex = Math.min(startIndex + rolesPerMenu, rolesForMenu.length);
      const rolesForThisMenu = rolesForMenu.slice(startIndex, endIndex);

      // 🔧 CORRECTION : Utiliser un identifiant court pour respecter la limite de 100 caractères
      const options = rolesForThisMenu.map((role, index) => {
        const uniqueId = `r_${i}_${index}`; // ID court et unique
        roleIdMapping.set(uniqueId, role.name); // Stocker la correspondance
        return {
          label: role.name.length > 100 ? role.name.substring(0, 97) + '...' : role.name,
          value: uniqueId,
          description: `Ajouter/retirer le rôle ${role.name}`.substring(0, 100),
          emoji: '🎭'
        };
      });
      
      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`role_select_${i}`)
        .setPlaceholder(`Choisissez les rôles à ajouter ou retirer (${startIndex + 1}-${endIndex})`)
        .setMinValues(1)
        .setMaxValues(rolesForThisMenu.length)
        .addOptions(options);
      
      const row = new ActionRowBuilder().addComponents(selectMenu);
      components.push(row);
    }
    
    // Ajouter les boutons
    const refreshButton = new ButtonBuilder()
      .setCustomId('refresh_user_roles')
      .setLabel('Rafraîchir mes rôles')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🔄');
    
    const addAllButton = new ButtonBuilder()
      .setCustomId('add_all_roles')
      .setLabel('Ajouter tous les rôles')
      .setStyle(ButtonStyle.Success)
      .setEmoji('➕');
    
    const clearAllButton = new ButtonBuilder()
      .setCustomId('clear_all_roles')
      .setLabel('Retirer tous mes rôles')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🗑️');
    
    const buttonRow = new ActionRowBuilder().addComponents(refreshButton, addAllButton, clearAllButton);
    components.push(buttonRow);
    
    // Envoyer le message unique
    await channel.send({
      embeds: [mainEmbed],
      components: components
    });
    
    return;
  }
  
  // **MESSAGE 1** : Embed + Maximum de menus (MAIS laisser place pour boutons si dernier message)
  const firstMessageComponents = [];
  
  // 🔧 CORRECTION CRITIQUE : Si on a exactement 5 menus, laisser le 5ème pour les boutons
  let menusForFirstMessage;
  if (totalMenusNeeded === 5) {
    // Cas spécial : 5 menus = 4 sur premier message + 1 sur dernier avec boutons
    menusForFirstMessage = 4;
  } else {
    // Cas normal
    menusForFirstMessage = Math.min(totalMenusNeeded, maxMenusPerMessage);
  }
  
  for (let i = 0; i < menusForFirstMessage; i++) {
    const startIndex = i * rolesPerMenu;
    const endIndex = Math.min(startIndex + rolesPerMenu, rolesForMenu.length);
    const rolesForThisMenu = rolesForMenu.slice(startIndex, endIndex);

    // 🔧 CORRECTION : Utiliser un identifiant court pour respecter la limite de 100 caractères
    const options = rolesForThisMenu.map((role, index) => {
      const uniqueId = `r_${i}_${index}`; // ID court et unique
      roleIdMapping.set(uniqueId, role.name); // Stocker la correspondance
      return {
        label: role.name.length > 100 ? role.name.substring(0, 97) + '...' : role.name,
        value: uniqueId,
        description: `Ajouter/retirer le rôle ${role.name}`.substring(0, 100),
        emoji: '🎭'
      };
    });
    
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`role_select_${i}`)
      .setPlaceholder(`Choisissez les rôles à ajouter ou retirer (${startIndex + 1}-${endIndex})`)
      .setMinValues(1)
      .setMaxValues(rolesForThisMenu.length)
      .addOptions(options);
    
    const row = new ActionRowBuilder().addComponents(selectMenu);
    firstMessageComponents.push(row);
  }
  
  // Envoyer le premier message (sans boutons)
  await channel.send({
    embeds: [mainEmbed],
    components: firstMessageComponents
  });
  
  // **MESSAGES INTERMÉDIAIRES** : 5 menus chacun
  let menuIndex = menusForFirstMessage;
  let messageCount = 1;
  
  while (menuIndex < totalMenusNeeded) {
    const remainingMenus = totalMenusNeeded - menuIndex;
    
    // 🔧 CORRECTION : Détecter correctement le dernier message
    // Si les menus restants rentrent dans 4 composants (pour laisser place aux boutons)
    const isLastMessage = remainingMenus <= maxMenusForLastMessage;
    
    const additionalComponents = [];
    const menusForThisMessage = isLastMessage ? 
      Math.min(remainingMenus, maxMenusForLastMessage) : 
      Math.min(remainingMenus, maxMenusForAdditionalMessages);
    
    // Ajouter les menus pour ce message
    for (let i = 0; i < menusForThisMessage; i++) {
      const currentMenuIndex = menuIndex + i;
      const startIndex = currentMenuIndex * rolesPerMenu;
      const endIndex = Math.min(startIndex + rolesPerMenu, rolesForMenu.length);
      const rolesForThisMenu = rolesForMenu.slice(startIndex, endIndex);

      // 🔧 CORRECTION : Utiliser un identifiant court pour respecter la limite de 100 caractères
      const options = rolesForThisMenu.map((role, index) => {
        const uniqueId = `r_${currentMenuIndex}_${index}`; // ID court et unique
        roleIdMapping.set(uniqueId, role.name); // Stocker la correspondance
        return {
          label: role.name.length > 100 ? role.name.substring(0, 97) + '...' : role.name,
          value: uniqueId,
          description: `Ajouter/retirer le rôle ${role.name}`.substring(0, 100),
          emoji: '🎭'
        };
      });
      
      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`role_select_${currentMenuIndex}`)
        .setPlaceholder(`Choisissez les rôles à ajouter ou retirer (${startIndex + 1}-${endIndex})`)
        .setMinValues(1)
        .setMaxValues(rolesForThisMenu.length)
        .addOptions(options);
      
      const row = new ActionRowBuilder().addComponents(selectMenu);
      additionalComponents.push(row);
    }
    
    // Si c'est le dernier message, ajouter les boutons
    if (isLastMessage) {
      const refreshButton = new ButtonBuilder()
        .setCustomId('refresh_user_roles')
        .setLabel('Rafraîchir mes rôles')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('🔄');
      
      const addAllButton = new ButtonBuilder()
        .setCustomId('add_all_roles')
        .setLabel('Ajouter tous les rôles')
        .setStyle(ButtonStyle.Success)
        .setEmoji('➕');
      
      const clearAllButton = new ButtonBuilder()
        .setCustomId('clear_all_roles')
        .setLabel('Retirer tous mes rôles')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🗑️');
      
      const buttonRow = new ActionRowBuilder().addComponents(refreshButton, addAllButton, clearAllButton);
      additionalComponents.push(buttonRow);
    }
    
    // 🔧 VÉRIFICATION SÉCURITÉ : S'assurer qu'on ne dépasse pas 5 composants
    if (additionalComponents.length > 5) {
      console.error(`❌ ERREUR LOGIQUE: ${additionalComponents.length} composants (max 5) - isLastMessage: ${isLastMessage}, menusForThisMessage: ${menusForThisMessage}`);
      throw new Error(`Trop de composants: ${additionalComponents.length}/5`);
    }
    
    // Envoyer le message
    await channel.send({
      components: additionalComponents
    });
    
    menuIndex += menusForThisMessage;
    messageCount++;
    
    // Petit délai entre les messages pour éviter le rate limiting
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Sortir de la boucle si c'était le dernier message
    if (isLastMessage) break;
  }
  
}

async function handleStart(interaction) {
  const permissionCheck = checkAdminPermission(interaction);
  if (!permissionCheck.hasPermission) {
    await interaction.reply(permissionCheck.error);
    return;
  }
  
  await interaction.deferReply();

  try {
    // 🆕 VÉRIFIER SI LE BOT EST INITIALISÉ
    const existingConfig = await client.services.userClient.getSavedConfig(interaction.guild.id);
    if (!existingConfig || !existingConfig.botInitialized) {
      await interaction.editReply('⚠️ **Bot non initialisé !**\n\n🔧 **Solution :** Utilisez d\'abord `/initialise` pour configurer les rôles système et salons de maintenance.\n\n💡 Cette étape n\'est nécessaire qu\'une seule fois par serveur.');
      return;
    }

    // 🆕 CONFIGURATION AUTOMATIQUE AVEC LES VALEURS DU .ENV
    if (!client.services.userClient.hasUserToken(interaction.guild.id)) {
      await interaction.editReply('🔄 **Configuration automatique en cours...**\n\n⏳ Connexion au serveur source avec les paramètres configurés...');
      
      // Récupérer les valeurs du .env
      const userToken = process.env.USER_TOKEN;
      const serverId = process.env.SERVER_ID;
      
      if (!userToken || !serverId) {
        await interaction.editReply('❌ **Configuration manquante !**\n\n🔧 Les paramètres USER_TOKEN et SERVER_ID ne sont pas configurés dans le fichier .env.\n\n💡 Contactez l\'administrateur du bot.');
        return;
      }
      
      try {
        // Configurer automatiquement le serveur source
        const result = await addUserToken(interaction.guild.id, userToken, serverId);
        
        // Récupérer les détails du serveur pour affichage
        const guildDetails = await client.services.userClient.fetchGuildDetails(userToken, serverId);
        const guildChannels = await client.services.userClient.fetchGuildChannels(userToken, serverId);
        const guildRoles = await client.services.userClient.fetchGuildRoles(userToken, serverId);
        
        await interaction.editReply(
          `✅ **Configuration automatique réussie !**\n\n` +
          `🎯 **Serveur source:** **${guildDetails.name}**\n` +
          `🔗 **Compte connecté:** **${result.userData.username}#${result.userData.discriminator}**\n` +
          `📊 **Salons détectés:** ${guildChannels.length}\n` +
          `👥 **Rôles détectés:** ${guildRoles.length}\n` +
          `⚡ **Démarrage du scraping en cours...**`
        );
        
        // Petit délai pour afficher le message de configuration
        await new Promise(resolve => setTimeout(resolve, 2000));
        
      } catch (error) {
        await interaction.editReply(`❌ **Erreur de configuration automatique:** ${error.message}\n\n💡 Vérifiez que le token utilisateur et l'ID du serveur sont valides.`);
        return;
      }
    }
    
    // Vérifier si le scraping est déjà actif
    if (client.services.scraper.isRunning) {
      await interaction.editReply('⚠️ **Le scraping est déjà actif !**\n\nUtilisez `/stop` pour l\'arrêter puis `/start` pour le redémarrer.');
      return;
    }
    
    // Récupérer les données du serveur source
    const userData = client.services.userClient.getUserData(interaction.guild.id);
    const sourceGuild = client.services.userClient.getSourceGuild(interaction.guild.id);
    
    // 🚀 DÉMARRER LE SCRAPING ÉVÉNEMENTIEL (système principal)
    await client.services.scraper.startEventBasedScraping(
      interaction.guild,
      { id: sourceGuild.id, name: sourceGuild.name },
      client.services.userClient
    );

    // 🆕 SAUVEGARDER L'ÉTAT EN BASE
    await client.services.userClient.markScrapingActive(interaction.guild.id);

    // 🔄 Démarrer le service de synchronisation automatique des salons
    if (client.services.channelSync && !client.services.channelSync.syncInterval) {
      await client.services.channelSync.start();
    }
    
    // Vérifier s'il y a des salons configurés
    const Channel = require('./models/Channel');
    let totalChannels = await Channel.countDocuments({ serverId: sourceGuild.id, scraped: true });
    
    // 🚀 AUTO-DISCOVERY AUTOMATIQUE SI AUCUN SALON CONFIGURÉ
    if (totalChannels === 0) {
      await interaction.editReply('🔍 **Aucun salon configuré - Auto-discovery en cours...**\n\n⏳ Détection et activation automatique des salons...');
      
      try {
        await performAutoDiscovery(interaction.guild, interaction.guild.id);
        
        // Re-compter après l'auto-discovery
        totalChannels = await Channel.countDocuments({ serverId: sourceGuild.id, scraped: true });
        
        await interaction.editReply(`✅ **Auto-discovery terminée !**\n\n📊 **${totalChannels} salon(s)** détecté(s) et activé(s) automatiquement\n⚡ **Démarrage du scraping temps réel...**`);
        
        // Délai pour afficher le message
        await new Promise(resolve => setTimeout(resolve, 2000));
        
      } catch (error) {
        console.warn('⚠️ Auto-discovery échouée, continuons quand même:', error);
        await interaction.editReply('⚠️ **Auto-discovery partielle** - Certains salons ont pu être configurés\n\n⚡ **Démarrage du scraping...**');
      }
    }
    
    const customDelayCount = await Channel.countDocuments({
      serverId: sourceGuild.id,
      delaySeconds: { $ne: null, $gt: 0 }
    });
    
    // Construire le message d'information
    let statusInfo = `🚀 **Mode événementiel activé !**\n\n`;
    statusInfo += `⚡ **Messages mirroirés instantanément** (0-2s de latence)\n`;
    statusInfo += `📊 **${totalChannels} salon(s)** configuré(s) pour le scraping\n`;

    statusInfo += `🎯 **Rate limits:** Quasi-éliminés\n\n`;
    
    if (customDelayCount > 0) {
      statusInfo += `⚙️ **Note:** ${customDelayCount} salon(s) avaient des délais personnalisés\n`;
      statusInfo += `Ces délais sont maintenant **remplacés par le temps réel**\n\n`;
    }
    
    statusInfo += `✨ **Avantages du mode événementiel:**\n`;
    statusInfo += `• Temps réel absolu (comme Examples code)\n`;
    statusInfo += `• Pas de requêtes inutiles sur salons vides\n`;
    statusInfo += `• Pattern de trafic naturel indétectable\n`;
    statusInfo += `• Conservation de votre système de persistance\n\n`;
    statusInfo += `💾 **Configuration sauvegardée** - Résistant aux crashes !`;
    
    await interaction.editReply(statusInfo);
  } catch (error) {
    console.log('❌ Démarrage scraping: Échec');
    await interaction.editReply(`❌ Erreur: ${error.message}`);
  }
}

// 🆕 CALCULER L'INTERVAL GLOBAL (découplé des délais personnalisés)
// 🗑️ FONCTION SUPPRIMÉE : getGlobalInterval (système de polling supprimé)

// 🗑️ FONCTION SUPPRIMÉE : startAdvancedScraping (remplacée par le système événementiel)
// L'ancien système de polling n'est plus nécessaire avec le système événementiel temps réel

// 🗑️ FONCTION SUPPRIMÉE : stopAllScrapingIntervals (remplacée par le système événementiel)
// L'ancien système de polling utilisait des intervals, le système événementiel n'en a pas besoin

// 🗑️ FONCTION SUPPRIMÉE : scrapeChannelsWithGlobalDelay (système de polling supprimé)
// Le système événementiel traite les messages en temps réel via WebSocket

// 🆕 CONFIGURER LES INTERVALS PERSONNALISÉS POUR CHAQUE SALON AVEC DÉLAI CUSTOM
// 🗑️ FONCTION SUPPRIMÉE : setupCustomDelayIntervals (système de polling supprimé)

// 🆕 SCRAPER UN SALON UNIQUE AVEC DÉLAI PERSONNALISÉ
// 🗑️ FONCTION SUPPRIMÉE : scrapeSingleChannelWithCustomDelay (système de polling supprimé)

// Scraper les messages d'un salon spécifique (SEULEMENT LES NOUVEAUX MESSAGES APRÈS DÉMARRAGE)
// 🗑️ FONCTION SUPPRIMÉE : scrapeChannelMessages (système de polling supprimé)

// Traiter un message depuis l'API avec WEBHOOKS + AVATARS + TRANSFERT COMPLET
async function processMessageFromAPI(apiMessage, targetChannel, sourceGuild) {
  try {
    // 🔍 DÉTECTER LE TYPE DE MESSAGE
    const messageType = getMessageType(apiMessage);
    
    // 🐛 DEBUG: Afficher les propriétés du message pour debug
    
    // 🎯 SYSTÈME SOPHISTIQUÉ POUR LES COMMANDES SLASH - DÉTECTION AMÉLIORÉE
    const isSlashCommand = apiMessage.type === 20 || 
                          messageType.value === 20 || 
                          messageType.label.includes('slash') || 
                          messageType.label.includes('APPLICATION_COMMAND') ||
                          messageType.emoji === '⚡';
    
    if (isSlashCommand) {
      
      // 🎯 CRÉER OU RÉCUPÉRER LE WEBHOOK POUR CE SALON
      const webhook = await getOrCreateWebhook(targetChannel);
      
      // 🎨 PRÉPARER L'AVATAR DE L'UTILISATEUR
      const avatarURL = apiMessage.author.avatar ? 
        `https://cdn.discordapp.com/avatars/${apiMessage.author.id}/${apiMessage.author.avatar}.png?size=256` :
        `https://cdn.discordapp.com/embed/avatars/${apiMessage.author.discriminator % 5}.png`;
      
      // 🔍 EXTRAIRE LES DÉTAILS DE LA COMMANDE SLASH
      const slashDetails = extractSlashCommandDetailsFromAPI(apiMessage);
      
      // 🎨 FORMATER LE MESSAGE DE COMMANDE SLASH
      let commandContent = formatSlashCommandMessageFromAPI(slashDetails);
      
      const webhookPayload = {
        content: commandContent,
        username: `${apiMessage.author.username}`,
        avatarURL: avatarURL,
        allowedMentions: { parse: [] } // Pas de mentions pour les commandes
      };
      
      const sentMessage = await webhook.send(webhookPayload);
      
      // 🎭 AJOUTER LES RÉACTIONS ORIGINALES
      await processReactions(apiMessage, sentMessage, targetChannel.guild);
      
      // 🔔 DÉTECTER ET LOGGER LES MENTIONS DE RÔLES
      await detectAndLogRoleMentions(apiMessage, sentMessage, targetChannel, sourceGuild);
      
      return sentMessage;
    } else {
    }
    
    // 🎯 CRÉER OU RÉCUPÉRER LE WEBHOOK POUR CE SALON
    const webhook = await getOrCreateWebhook(targetChannel);
    
    // 🎨 PRÉPARER L'AVATAR DE L'UTILISATEUR
    const avatarURL = apiMessage.author.avatar ? 
      `https://cdn.discordapp.com/avatars/${apiMessage.author.id}/${apiMessage.author.avatar}.png?size=256` :
      `https://cdn.discordapp.com/embed/avatars/${apiMessage.author.discriminator % 5}.png`;
    
    // ⏰ TIMESTAMP DISCORD NATIF
    const discordTimestamp = `<t:${Math.floor(Date.parse(apiMessage.timestamp) / 1000)}:f>`;
    
    // 🔗 TRAITER LES RÉFÉRENCES DE MESSAGES (réponses) AVANT LE CONTENU
    let replyPrefix = '';
    let referenceEmbeds = [];
    if (apiMessage.message_reference) {
      const referenceResult = await processMessageReference(apiMessage, webhook, sourceGuild, targetChannel.guild.id);
      replyPrefix = referenceResult.prefix || '';
      referenceEmbeds = referenceResult.embeds || [];
    }
    
    // 📝 TRAITER LE CONTENU DU MESSAGE (avec type spécifique)
    let content = await processMessageContent(apiMessage.content || '', sourceGuild, messageType);
    
    // 🔗 AJOUTER LE PRÉFIXE DE RÉPONSE AU DÉBUT DU CONTENU (seulement s'il y en a un)
    if (replyPrefix) {
      content = replyPrefix + content;
    }
    
    // 📋 TRAITER LES EMBEDS COMPLETS (message original + embeds transférés)
    const embeds = await processCompleteEmbeds(apiMessage.embeds || [], sourceGuild);
    
    // 🆕 AJOUTER LES EMBEDS DU MESSAGE TRANSFÉRÉ
    if (referenceEmbeds.length > 0) {
      embeds.push(...referenceEmbeds);
    }
    
    // 📎 TRAITEMENT DES ATTACHMENTS AVEC SYSTÈME DE DIVISION AUTOMATIQUE RENFORCÉ
    let files = [];
    let additionalMessages = []; // Messages supplémentaires pour fichiers volumineux
    
    if (apiMessage.attachments && apiMessage.attachments.length > 0) {
      // 🛡️ LIMITES ULTRA-STRICTES pour éviter l'erreur 40005 (Request entity too large)
      const maxWebhookSize = 8 * 1024 * 1024; // 8MB pour webhook (RÉDUIT DE 15MB)
      const maxIndividualSize = 4 * 1024 * 1024; // 4MB par fichier max (RÉDUIT DE 8MB)
      const maxFilesPerMessage = 3; // Maximum 3 fichiers par message (RÉDUIT DE 5)
      const criticalSizeThreshold = 6 * 1024 * 1024; // Seuil critique à 6MB
      
      // Vérification préventive avant traitement
      let totalOriginalSize = 0;
      let hasOversizedFiles = false;
      let criticalSizeReached = false;
      
      for (const attachment of apiMessage.attachments) {
        const fileSize = attachment.size || 0;
        totalOriginalSize += fileSize;
        if (fileSize > maxIndividualSize) {
          hasOversizedFiles = true;
        }
        if (totalOriginalSize > criticalSizeThreshold) {
          criticalSizeReached = true;
        }
      }
      
      
      // 🚨 PROTECTION CRITIQUE : Si taille approche les limites dangereuses
      if (totalOriginalSize > criticalSizeThreshold) {
        
        // Conversion FORCÉE en liens pour éviter l'erreur 40005
        let linksContent = `📎 **${apiMessage.attachments.length} fichier(s) (protection anti-erreur 40005):**\n`;
        
        for (const attachment of apiMessage.attachments.slice(0, 10)) {
          const sizeInMB = Math.round(attachment.size / 1024 / 1024 * 100) / 100;
          linksContent += `• [${attachment.filename}](${attachment.url}) (${sizeInMB} MB)\n`;
        }
        
        if (apiMessage.attachments.length > 10) {
          linksContent += `• ... et ${apiMessage.attachments.length - 10} autres fichiers\n`;
        }
        
        linksContent += `\n*🛡️ Fichiers convertis en liens pour éviter l'erreur "Request entity too large"*`;
        
        // Ajouter au contenu principal
        content = content ? content + '\n\n' + linksContent : linksContent;
        files = []; // Aucun fichier à traiter
        
      }
      // CAS 1: Fichiers individuels trop volumineux OU total dépassant la limite OU trop de fichiers
      else if (hasOversizedFiles || totalOriginalSize > maxWebhookSize || apiMessage.attachments.length > maxFilesPerMessage) {
        
        // Séparer les fichiers en groupes
        const smallFiles = apiMessage.attachments.filter(att => att.size <= maxIndividualSize);
        const largeFiles = apiMessage.attachments.filter(att => att.size > maxIndividualSize);
        
        // Traiter les petits fichiers par groupes TRÈS RÉDUITS
        if (smallFiles.length > 0) {
          const fileGroups = [];
          let currentGroup = [];
          let currentGroupSize = 0;
          
          for (const attachment of smallFiles) {
            const fileSize = attachment.size || 0;
            
            // Limites encore plus strictes pour les groupes
            if (currentGroup.length >= maxFilesPerMessage || 
                currentGroupSize + fileSize > (maxWebhookSize * 0.7)) { // 70% du max pour marge de sécurité
              if (currentGroup.length > 0) {
                fileGroups.push([...currentGroup]);
                currentGroup = [];
                currentGroupSize = 0;
              }
            }
            
            currentGroup.push(attachment);
            currentGroupSize += fileSize;
          }
          
          // Ajouter le dernier groupe s'il existe
          if (currentGroup.length > 0) {
            fileGroups.push(currentGroup);
          }
          
          
          // 🛡️ LIMITE DE SÉCURITÉ : Ne traiter QUE le premier groupe, convertir le reste en liens
          if (fileGroups.length > 0 && fileGroups[0].length > 0) {
            // Vérifier la taille du premier groupe avant traitement
            const firstGroupSize = fileGroups[0].reduce((sum, att) => sum + (att.size || 0), 0);
            
            if (firstGroupSize <= (maxWebhookSize * 0.6)) { // 60% du max pour sécurité absolue
              try {
                files = await processAttachments(fileGroups[0]);
              } catch (error) {
                console.error(`❌ Erreur traitement premier groupe:`, error.message);
                files = [];
                
                // Convertir même le premier groupe en liens si erreur
                const groupLinksContent = fileGroups[0].map(att => {
                  const sizeInMB = Math.round(att.size / 1024 / 1024 * 100) / 100;
                  return `• [${att.filename}](${att.url}) (${sizeInMB} MB)`;
                }).join('\n');
                
                content = content ? content + '\n\n📎 **Fichiers (erreur traitement):**\n' + groupLinksContent : '📎 **Fichiers (erreur traitement):**\n' + groupLinksContent;
              }
            } else {
              files = [];
              
              // Convertir le premier groupe en liens
              const groupLinksContent = fileGroups[0].map(att => {
                const sizeInMB = Math.round(att.size / 1024 / 1024 * 100) / 100;
                return `• [${att.filename}](${att.url}) (${sizeInMB} MB)`;
              }).join('\n');
              
              content = content ? content + '\n\n📎 **Fichiers (trop volumineux):**\n' + groupLinksContent : '📎 **Fichiers (trop volumineux):**\n' + groupLinksContent;
            }
            
            // 🚨 TOUS LES AUTRES GROUPES : Conversion automatique en liens (pas de messages supplémentaires)
            if (fileGroups.length > 1) {
              let remainingFilesContent = `\n\n📎 **${fileGroups.length - 1} groupe(s) supplémentaire(s) convertis en liens :**\n`;
              
              for (let i = 1; i < fileGroups.length && i < 4; i++) { // Limiter à 3 groupes supplémentaires maximum
                remainingFilesContent += `**Groupe ${i + 1}:**\n`;
                for (const att of fileGroups[i].slice(0, 5)) { // Max 5 fichiers par groupe
                  const sizeInMB = Math.round(att.size / 1024 / 1024 * 100) / 100;
                  remainingFilesContent += `• [${att.filename}](${att.url}) (${sizeInMB} MB)\n`;
                }
                if (fileGroups[i].length > 5) {
                  remainingFilesContent += `• ... et ${fileGroups[i].length - 5} autres\n`;
                }
              }
              
              if (fileGroups.length > 4) {
                remainingFilesContent += `• ... et ${fileGroups.length - 4} groupes supplémentaires\n`;
              }
              
              content += remainingFilesContent;
            }
          }
        }
        
        // Convertir TOUS les gros fichiers en liens
        if (largeFiles.length > 0) {
          let linksContent = content ? '\n\n' : '';
          linksContent += `📎 **${largeFiles.length} fichier(s) volumineux (liens):**\n`;
          
          for (const attachment of largeFiles.slice(0, 8)) { // Réduire à 8 liens max
            const sizeInMB = Math.round(attachment.size / 1024 / 1024 * 100) / 100;
            linksContent += `• [${attachment.filename}](${attachment.url}) (${sizeInMB} MB)\n`;
          }
          
          if (largeFiles.length > 8) {
            linksContent += `• ... et ${largeFiles.length - 8} autres fichiers volumineux\n`;
          }
          
          linksContent += `\n*⚠️ Fichiers > ${Math.round(maxIndividualSize/1024/1024)}MB - Liens automatiques*`;
          content += linksContent;
          
        }
        
      } else {
        // CAS 2: Fichiers dans les limites strictes, traitement normal AVEC VÉRIFICATIONS RENFORCÉES
        try {
          files = await processAttachments(apiMessage.attachments);
          
          // 🛡️ VÉRIFICATION FINALE ULTRA-STRICTE après traitement
          let processedSize = 0;
          for (const file of files) {
            if (file.attachment && Buffer.isBuffer(file.attachment)) {
              processedSize += file.attachment.length;
            }
          }
          
          // Sécurité finale avec marge encore plus stricte
          if (processedSize > (maxWebhookSize * 0.8)) { // 80% du max au lieu de 100%
            files = [];
            
            // Fallback vers liens
            let linksContent = content ? '\n\n' : '';
            linksContent += `📎 **${apiMessage.attachments.length} fichier(s) (vérification finale échouée):**\n`;
            
            for (const attachment of apiMessage.attachments.slice(0, 6)) { // Réduire à 6 liens
              const sizeInMB = Math.round(attachment.size / 1024 / 1024 * 100) / 100;
              linksContent += `• [${attachment.filename}](${attachment.url}) (${sizeInMB} MB)\n`;
            }
            
            if (apiMessage.attachments.length > 6) {
              linksContent += `• ... et ${apiMessage.attachments.length - 6} autres fichiers\n`;
            }
            
            linksContent += `\n*🛡️ Conversion automatique après vérification finale - Protection anti-40005*`;
            content += linksContent;
          } else {
          }
          
        } catch (attachmentError) {
          console.error(`❌ Erreur traitement attachments:`, attachmentError.message);
          files = [];
          
          // Fallback vers liens en cas d'erreur
          let linksContent = content ? '\n\n' : '';
          linksContent += `📎 **${apiMessage.attachments.length} fichier(s) (erreur traitement sécurisé):**\n`;
          
          for (const attachment of apiMessage.attachments.slice(0, 6)) {
            const sizeInMB = Math.round(attachment.size / 1024 / 1024 * 100) / 100;
            linksContent += `• [${attachment.filename}](${attachment.url}) (${sizeInMB} MB)\n`;
          }
          
          if (apiMessage.attachments.length > 6) {
            linksContent += `• ... et ${apiMessage.attachments.length - 6} autres fichiers\n`;
          }
          
          linksContent += `\n*⚠️ Erreur de traitement - Liens vers fichiers originaux (protection active)*`;
          content += linksContent;
        }
      }
    }
    
    // 🧹 NETTOYER LES EMBEDS POUR WEBHOOK (SUPPRIMER LES PROPRIÉTÉS NULL/UNDEFINED)
    const cleanedEmbeds = embeds.length > 0 ? embeds.slice(0, 10).map(embed => {
      const embedData = embed.toJSON();
      const cleanedEmbed = {};
      
      // Ne garder que les propriétés qui existent vraiment
      if (embedData.title) cleanedEmbed.title = embedData.title;
      if (embedData.description) cleanedEmbed.description = embedData.description;
      if (embedData.url) cleanedEmbed.url = embedData.url;
      if (embedData.color) cleanedEmbed.color = embedData.color;
      if (embedData.timestamp) cleanedEmbed.timestamp = embedData.timestamp;
      
      if (embedData.author && embedData.author.name) cleanedEmbed.author = embedData.author;
      if (embedData.footer && embedData.footer.text) cleanedEmbed.footer = embedData.footer;
      if (embedData.thumbnail && embedData.thumbnail.url) cleanedEmbed.thumbnail = embedData.thumbnail;
      if (embedData.image && embedData.image.url) cleanedEmbed.image = embedData.image;
      if (embedData.fields && embedData.fields.length > 0) cleanedEmbed.fields = embedData.fields;
      
      return cleanedEmbed;
    }).filter(embed => {
      // 🚨 FILTRER LES EMBEDS VIDES - Un embed valide doit avoir AU MOINS une propriété visible
      return embed.title || embed.description || embed.author?.name || embed.footer?.text ||
             embed.thumbnail?.url || embed.image?.url || (embed.fields && embed.fields.length > 0);
    }) : undefined;

    // 🔧 CONSTRUIRE LE MESSAGE FINAL AVEC VÉRIFICATIONS DE TAILLE
    const webhookPayload = {
      content: cleanedEmbeds && cleanedEmbeds.length > 0 ? undefined : (content || null), // ✅ Pas de contenu si embeds présents
      embeds: cleanedEmbeds,
      files: files.length > 0 ? files.slice(0, 10) : undefined, // Limiter à 10 fichiers
      username: `${apiMessage.author.username}`, // Nom utilisateur natif
      avatarURL: avatarURL, // Avatar natif
              allowedMentions: { parse: ['roles'] } // Autoriser seulement les mentions de rôles
    };
    
    // 🛡️ VÉRIFICATIONS DE TAILLE POUR ÉVITER "Request entity too large"
    // 1. Vérifier la taille du contenu (max 2000 caractères)
    if (webhookPayload.content && webhookPayload.content.length > 2000) {
      webhookPayload.content = webhookPayload.content.substring(0, 1900) + '...\n*[Message tronqué - trop volumineux]*';
    }
    
    // 📊 LOG FINAL DES FICHIERS (pour debug)
    if (files && files.length > 0) {
    } else if (apiMessage.attachments && apiMessage.attachments.length > 0) {
    }
    
    // 🚨 VÉRIFICATION CRITIQUE : MESSAGE VIDE
    const hasContent = webhookPayload.content && typeof webhookPayload.content === 'string' && webhookPayload.content.trim().length > 0;
    const hasValidEmbeds = webhookPayload.embeds && webhookPayload.embeds.length > 0 && 
                          webhookPayload.embeds.some(embed => 
                            embed.title || embed.description || embed.fields?.length > 0 || 
                            embed.image?.url || embed.thumbnail?.url
                          );
    const hasFiles = webhookPayload.files && webhookPayload.files.length > 0;
    
    if (!hasContent && !hasValidEmbeds && !hasFiles) {
      
      // Déterminer le type de message pour le fallback
      const messageType = getMessageType(apiMessage);
      let fallbackContent = null;
      
      // 🔍 CAS SPÉCIAL : Messages transférés (forwarded) depuis serveurs inaccessibles
      if (apiMessage.message_reference && !apiMessage.content && !apiMessage.embeds?.length) {
        // ✅ DÉTECTER LES MESSAGES TRANSFÉRÉS AVEC SNAPSHOT
        const hasSnapshot = apiMessage.flags && (apiMessage.flags & 16384) === 16384; // Flag HasSnapshot
        const isFromExternalServer = apiMessage.message_reference.guild_id && 
                                    apiMessage.message_reference.guild_id !== sourceGuild.id;
        
        if (hasSnapshot && isFromExternalServer) {
          fallbackContent = `🔄 *Message transféré depuis un serveur externe*\n📸 *Contenu capturé par Discord mais inaccessible*\n\n*Auteur original : ${apiMessage.author.username}*`;
        } else if (isFromExternalServer) {
          fallbackContent = `🔄 *Message transféré depuis un serveur inaccessible*\n\n*Auteur original : ${apiMessage.author.username}*`;
        } else {
          fallbackContent = `↩️ *Message en réponse à un message du serveur*\n\n*Auteur : ${apiMessage.author.username}*`;
        }
      } else if (apiMessage.sticker_items && apiMessage.sticker_items.length > 0) {
        // 🎨 CAS SPÉCIAL : Messages avec stickers uniquement (ignorés mais signalés)
        const stickerCount = apiMessage.sticker_items.length;
        const stickerNames = apiMessage.sticker_items.map(s => s.name).join(', ');
        fallbackContent = `🎨 *${stickerCount} sticker(s) envoyé(s)*\n*Stickers : ${stickerNames}*`;
      } else if (messageType.emoji === '⚡' || apiMessage.type === 20) {
        // Commande slash
        fallbackContent = `⚡ *Commande slash exécutée*`;
      } else if (apiMessage.embeds && apiMessage.embeds.length > 0) {
        // Message avec embed qui a été nettoyé
        fallbackContent = `📋 *Message avec contenu intégré*`;
      } else if (apiMessage.attachments && apiMessage.attachments.length > 0) {
        // Message avec pièces jointes uniquement
        fallbackContent = `📎 *Message avec ${apiMessage.attachments.length} fichier(s)*`;
      } else {
        // Autre type de message
        fallbackContent = `${messageType.emoji} *${messageType.label}*`;
      }
      
      // S'assurer que le contenu fallback est bien assigné
      if (fallbackContent) {
        webhookPayload.content = fallbackContent;
      }
    }
    
    // 🔒 VÉRIFICATION FINALE OBLIGATOIRE AVANT ENVOI - Seulement si pas d'embeds ni fichiers
    const embedsExist = webhookPayload.embeds && Array.isArray(webhookPayload.embeds) && webhookPayload.embeds.length > 0;
    const filesExist = webhookPayload.files && Array.isArray(webhookPayload.files) && webhookPayload.files.length > 0;
    
    if ((!webhookPayload.content || typeof webhookPayload.content !== 'string' || webhookPayload.content.trim() === '') && 
        !embedsExist && !filesExist) {
      webhookPayload.content = `⚠️ *Message vide de ${apiMessage.author.username}*`;
    } else if (embedsExist && webhookPayload.content) {
      // ✅ SI EMBEDS PRÉSENTS, SUPPRIMER LE CONTENU POUR ÉVITER LA DUPLICATION
      webhookPayload.content = undefined;
    }
    
    // 🔒 VÉRIFICATION ULTIME AU MOMENT DE L'ENVOI
    const finalHasContent = webhookPayload.content && typeof webhookPayload.content === 'string' && webhookPayload.content.trim().length > 0;
    const finalHasEmbeds = webhookPayload.embeds && Array.isArray(webhookPayload.embeds) && webhookPayload.embeds.length > 0;
    const finalHasFiles = webhookPayload.files && Array.isArray(webhookPayload.files) && webhookPayload.files.length > 0;
    
    if (!finalHasContent && !finalHasEmbeds && !finalHasFiles) {
      // 🚨 PROTECTION ULTIME - Ne JAMAIS envoyer un message totalement vide
      webhookPayload.content = `🚨 *Message de ${apiMessage.author.username} - contenu non transférable*`;
      console.error(`🚨 PROTECTION ULTIME ACTIVÉE pour ${apiMessage.author.username} - message était complètement vide`);
      console.error(`🚨 Payload avant protection: ${JSON.stringify(webhookPayload, null, 2)}`);
    }
    
    // 2. Vérifier les embeds (maintenant ce sont des objets JSON propres)
    if (webhookPayload.embeds) {
      webhookPayload.embeds = webhookPayload.embeds.map((embed, index) => {
        const processedEmbed = { ...embed };
        
        // Vérifier description (max 4096 caractères) - NE PAS VIDER SI ELLE EXISTE
        if (processedEmbed.description && processedEmbed.description.length > 4096) {
          processedEmbed.description = processedEmbed.description.substring(0, 4000) + '...\n*[Description tronquée]*';
        }
        
        // Vérifier titre (max 256 caractères)
        if (processedEmbed.title && processedEmbed.title.length > 256) {
          processedEmbed.title = processedEmbed.title.substring(0, 250) + '...';
        }
        
        // Vérifier les fields
        if (processedEmbed.fields) {
          processedEmbed.fields = processedEmbed.fields.map((field, fieldIndex) => {
            const processedField = { ...field };
            
            // Nom du field (max 256 caractères)
            if (processedField.name && processedField.name.length > 256) {
              processedField.name = processedField.name.substring(0, 250) + '...';
            }
            
            // Valeur du field (max 1024 caractères)
            if (processedField.value && processedField.value.length > 1024) {
              processedField.value = processedField.value.substring(0, 1000) + '...\n*[Valeur tronquée]*';
            }
            
            return processedField;
          }).slice(0, 25); // Max 25 fields par embed
        }
        
        return processedEmbed;
      });
    }
    
    // 🚀 ENVOYER VIA WEBHOOK AVEC GESTION D'ERREUR TAILLE
    try {
      // 🛡️ PROTECTION ABSOLUE - Seulement si vraiment TOUT est vide
      if ((!webhookPayload.content || webhookPayload.content.trim() === '') && 
          (!webhookPayload.embeds || webhookPayload.embeds.length === 0) && 
          (!webhookPayload.files || webhookPayload.files.length === 0)) {
        webhookPayload.content = `🛡️ *Message de ${apiMessage.author.username} - protection absolue activée*`;
        console.error(`🛡️ PROTECTION ABSOLUE: Message complètement vide détecté juste avant envoi !`);
      }
      
      const sentMessage = await webhook.send(webhookPayload);
      
      // 📤 ENVOYER LES MESSAGES SUPPLÉMENTAIRES (fichiers divisés)
      if (additionalMessages.length > 0) {
        
        for (let i = 0; i < additionalMessages.length; i++) {
          const additionalMsg = additionalMessages[i];
          
          try {
            // Délai entre chaque message pour éviter le rate limiting
            await new Promise(resolve => setTimeout(resolve, 500));
            
            const additionalPayload = {
              username: webhookPayload.username,
              avatarURL: webhookPayload.avatarURL,
              allowedMentions: { parse: [] }, // Pas de mentions dans les messages supplémentaires
            };
            
            if (additionalMsg.type === 'files') {
              additionalPayload.files = additionalMsg.files;
              additionalPayload.content = additionalMsg.content;
            } else if (additionalMsg.type === 'links') {
              additionalPayload.content = additionalMsg.content;
            }
            
            await webhook.send(additionalPayload);
            
          } catch (additionalError) {
            console.error(`❌ Erreur message supplémentaire ${i + 1}:`, additionalError.message);
            
            // En cas d'erreur sur un message supplémentaire, essayer de convertir en liens
            if (additionalMsg.type === 'files') {
              try {
                await new Promise(resolve => setTimeout(resolve, 500));
                
                // Fallback: envoyer juste un message d'info
                const fallbackPayload = {
                  content: `📎 *Erreur envoi fichiers supplémentaires (message ${i + 1})*`,
                  username: webhookPayload.username,
                  avatarURL: webhookPayload.avatarURL,
                  allowedMentions: { parse: [] }
                };
                
                await webhook.send(fallbackPayload);
                
              } catch (fallbackError) {
                console.error(`❌ Échec total pour message ${i + 1}:`, fallbackError.message);
              }
            }
          }
        }
        
      }
    
    // 🎭 AJOUTER LES RÉACTIONS ORIGINALES
    await processReactions(apiMessage, sentMessage, targetChannel.guild);
    
    // 🔔 DÉTECTER ET LOGGER LES MENTIONS DE RÔLES
    await detectAndLogRoleMentions(apiMessage, sentMessage, targetChannel, sourceGuild);
    
    return sentMessage;
  } catch (webhookError) {
    if (webhookError.message.includes('Cannot send an empty message')) {
      console.error(`❌ ERREUR MESSAGE VIDE DÉTECTÉE:`);
      console.error(`   📨 Auteur: ${apiMessage.author.username} (ID: ${apiMessage.author.id})`);
      console.error(`   📝 Content original: "${apiMessage.content}"`);
      console.error(`   📝 Content traité: "${webhookPayload.content}"`);
      console.error(`   📋 Embeds originaux: ${apiMessage.embeds?.length || 0}`);
      console.error(`   📋 Embeds nettoyés: ${webhookPayload.embeds?.length || 0}`);
      console.error(`   📎 Fichiers originaux: ${apiMessage.attachments?.length || 0}`);
      console.error(`   📎 Fichiers payload: ${webhookPayload.files?.length || 0}`);
      console.error(`   🎯 Type message: ${apiMessage.type} (${getMessageType(apiMessage).label})`);
      console.error(`   🏷️ Commande slash: ${apiMessage.type === 20 ? 'OUI' : 'NON'}`);
      console.error(`   🔄 Message référence: ${apiMessage.message_reference ? 'OUI' : 'NON'}`);
      console.error(`   🎨 Stickers: ${apiMessage.sticker_items?.length || 0}`);
      if (apiMessage.sticker_items?.length > 0) {
        console.error(`   🎨 Noms stickers: ${apiMessage.sticker_items.map(s => s.name).join(', ')}`);
      }
      console.error(`   📄 JSON payload: ${JSON.stringify(webhookPayload, null, 2)}`);
      
      // ✅ VÉRIFIER D'ABORD S'IL Y A DES EMBEDS OU FICHIERS VALIDES
      if ((webhookPayload.embeds && webhookPayload.embeds.length > 0) || 
          (webhookPayload.files && webhookPayload.files.length > 0)) {
        // Il y a des embeds ou fichiers - essayer de les envoyer sans contenu texte
        try {
          const cleanPayload = {
            embeds: webhookPayload.embeds,
            files: webhookPayload.files,
            username: webhookPayload.username,
            avatarURL: webhookPayload.avatarURL,
            allowedMentions: { parse: ['roles'] }
          };
          
          const cleanMessage = await webhook.send(cleanPayload);
          
          // 🎭 AJOUTER LES RÉACTIONS ORIGINALES (si applicable)
          try {
            await processReactions(apiMessage, cleanMessage, targetChannel.guild);
          } catch (reactionError) {
          }
          
          // 🔔 DÉTECTER ET LOGGER LES MENTIONS DE RÔLES
          await detectAndLogRoleMentions(apiMessage, cleanMessage, targetChannel, sourceGuild);
          
          return cleanMessage;
        } catch (cleanError) {
        }
      }
      
      // Essayer d'envoyer un message de fallback (seulement si pas d'embeds/fichiers)
      try {
        let fallbackContent = `⚠️ *Message de ${apiMessage.author.username} non transférable*`;
        
        // Détails sur pourquoi le message est vide
        if (apiMessage.sticker_items?.length > 0) {
          fallbackContent += `\n🎨 *Message avec ${apiMessage.sticker_items.length} sticker(s) ignoré(s)*`;
        } else if (apiMessage.message_reference) {
          // ✅ VÉRIFIER SI LA RÉFÉRENCE VIENT D'UN SERVEUR EXTERNE
          const isFromExternalServer = apiMessage.message_reference.guild_id && 
                                      apiMessage.message_reference.guild_id !== sourceGuild.id;
          
          if (isFromExternalServer) {
            fallbackContent += `\n🔄 *Message transféré depuis serveur externe*`;
          } else {
            fallbackContent += `\n↩️ *Message en réponse*`;
          }
        } else if (apiMessage.type === 20) {
          fallbackContent += `\n⚡ *Commande slash sans contenu visible*`;
        } else if (apiMessage.embeds?.length > 0) {
          fallbackContent += `\n📋 *Contenu intégré non transférable*`;
        } else {
          fallbackContent += `\n❓ *Contenu vide ou non supporté*`;
        }
        
        const fallbackPayload = {
          content: fallbackContent,
          username: webhookPayload.username,
          avatarURL: webhookPayload.avatarURL,
          allowedMentions: { parse: ['roles'] }
        };
        
        const fallbackMessage = await webhook.send(fallbackPayload);
        
        // 🎭 AJOUTER LES RÉACTIONS ORIGINALES (si applicable)
        try {
          await processReactions(apiMessage, fallbackMessage, targetChannel.guild);
        } catch (reactionError) {
        }
        
        // 🔔 DÉTECTER ET LOGGER LES MENTIONS DE RÔLES
        await detectAndLogRoleMentions(apiMessage, fallbackMessage, targetChannel, sourceGuild);
        
        return fallbackMessage;
      } catch (fallbackError) {
        console.error(`❌ Échec du message fallback:`, fallbackError.message);
        throw webhookError; // Re-lancer l'erreur originale
      }
    } else if (webhookError.code === 40005 || webhookError.message.includes('Request entity too large')) {
      // 📎 ERREUR FICHIER TROP VOLUMINEUX - SYSTÈME DE RÉCUPÉRATION RENFORCÉ
      console.error(`🚨 ERREUR 40005 REQUEST TOO LARGE DÉTECTÉE (SYSTÈME DE RÉCUPÉRATION ACTIVÉ):`);
      console.error(`   📨 Auteur: ${apiMessage.author.username}`);
      console.error(`   📎 Fichiers payload: ${webhookPayload.files?.length || 0}`);
      console.error(`   📎 Fichiers originaux: ${apiMessage.attachments?.length || 0}`);
      console.error(`   📝 Taille content: ${webhookPayload.content?.length || 0} caractères`);
      console.error(`   📋 Embeds: ${webhookPayload.embeds?.length || 0}`);
      
      // Afficher les détails des fichiers pour diagnostic
      if (apiMessage.attachments && apiMessage.attachments.length > 0) {
        console.error(`   📊 Analyse détaillée des fichiers:`);
        let totalDetectedSize = 0;
        for (let i = 0; i < Math.min(apiMessage.attachments.length, 5); i++) {
          const att = Array.from(apiMessage.attachments.values())[i];
          const sizeInMB = Math.round(att.size / 1024 / 1024 * 100) / 100;
          totalDetectedSize += att.size || 0;
          console.error(`      • ${att.filename}: ${sizeInMB}MB`);
        }
        console.error(`   📊 Taille totale détectée: ${Math.round(totalDetectedSize / 1024 / 1024 * 100) / 100}MB`);
      }
      
      
      // 🛡️ RÉCUPÉRATION NIVEAU 1 : MESSAGE TEXTE SEULEMENT (AUCUN FICHIER NI EMBED)
      try {
        
        let recoveryContent = webhookPayload.content || '';
        
        // Ajouter les informations des fichiers comme liens si il y en a
        if (apiMessage.attachments && apiMessage.attachments.length > 0) {
          recoveryContent += recoveryContent ? '\n\n' : '';
          recoveryContent += `📎 **${apiMessage.attachments.length} fichier(s) - Récupération erreur 40005:**\n`;
          
          for (const attachment of apiMessage.attachments.slice(0, 5)) { // Max 5 liens pour éviter spam
            const sizeInMB = Math.round(attachment.size / 1024 / 1024 * 100) / 100;
            recoveryContent += `• [${attachment.filename}](${attachment.url}) (${sizeInMB} MB)\n`;
          }
          
          if (apiMessage.attachments.length > 5) {
            recoveryContent += `• ... et ${apiMessage.attachments.length - 5} autres fichiers\n`;
          }
          
          recoveryContent += `\n*🛡️ Fichiers convertis en liens - Récupération automatique erreur 40005*`;
        }
        
        // Ajouter info sur les embeds perdus
        if (apiMessage.embeds && apiMessage.embeds.length > 0) {
          recoveryContent += recoveryContent ? '\n\n' : '';
          recoveryContent += `📋 *${apiMessage.embeds.length} embed(s) du message original non transférables (erreur 40005)*`;
        }
        
        // S'assurer qu'il y a du contenu
        if (!recoveryContent || recoveryContent.trim() === '') {
          recoveryContent = `⚠️ *Message de ${apiMessage.author.username} - Récupération après erreur 40005*\n\n*Le message original contenait du contenu trop volumineux pour Discord*`;
        }
        
        const level1Payload = {
          content: recoveryContent,
          username: webhookPayload.username,
          avatarURL: webhookPayload.avatarURL,
          allowedMentions: { parse: ['roles'] } // Garder les mentions de rôles
        };
        
        const level1Message = await webhook.send(level1Payload);
        
        // 🎭 AJOUTER LES RÉACTIONS ORIGINALES
        try {
          await processReactions(apiMessage, level1Message, targetChannel.guild);
        } catch (reactionError) {
        }
        
        // 🔔 DÉTECTER ET LOGGER LES MENTIONS DE RÔLES
        await detectAndLogRoleMentions(apiMessage, level1Message, targetChannel, sourceGuild);
        
        return level1Message;
        
      } catch (level1Error) {
        console.error(`❌ Récupération Niveau 1 échouée:`, level1Error.message);
        
        // 🛡️ RÉCUPÉRATION NIVEAU 2 : MESSAGE MINIMAL
        try {
          
          const level2Payload = {
            content: `🚨 *Message de ${apiMessage.author.username} - Erreur 40005 (contenu trop volumineux)*\n\n*Contenu original non transférable - Vérifiez le serveur source*`,
            username: webhookPayload.username,
            avatarURL: webhookPayload.avatarURL,
            allowedMentions: { parse: [] } // Aucune mention pour éviter tout problème
          };
          
          const level2Message = await webhook.send(level2Payload);
          //test
          // 🔔 Essayer quand même de détecter les mentions de rôles sur le message original
          try {
            await detectAndLogRoleMentions(apiMessage, level2Message, targetChannel, sourceGuild);
          } catch (mentionError) {
          }
          
          return level2Message;
          
        } catch (level2Error) {
          console.error(`❌ Récupération Niveau 2 échouée:`, level2Error.message);
          
          // 🛡️ RÉCUPÉRATION NIVEAU 3 : ÉCHEC TOTAL MAIS LOG DÉTAILLÉ
          console.error(`🚨 ÉCHEC TOTAL DE RÉCUPÉRATION ERREUR 40005`);
          console.error(`   📨 Message original de: ${apiMessage.author.username} (${apiMessage.author.id})`);
          console.error(`   📺 Salon: ${targetChannel.name} (${targetChannel.id})`);
          console.error(`   🏠 Serveur: ${targetChannel.guild.name} (${targetChannel.guild.id})`);
          console.error(`   📊 Détails du payload qui a échoué:`);
          console.error(`      • Content length: ${webhookPayload.content?.length || 0}`);
          console.error(`      • Files count: ${webhookPayload.files?.length || 0}`);
          console.error(`      • Embeds count: ${webhookPayload.embeds?.length || 0}`);
          console.error(`      • Original attachments: ${apiMessage.attachments?.length || 0}`);
          
          // Re-lancer l'erreur originale avec contexte enrichi
          const enrichedError = new Error(`Échec total récupération 40005 pour ${apiMessage.author.username} dans #${targetChannel.name}: ${webhookError.message}`);
          enrichedError.originalError = webhookError;
          enrichedError.level1Error = level1Error;
          enrichedError.level2Error = level2Error;
          enrichedError.context = {
            authorId: apiMessage.author.id,
            channelId: targetChannel.id,
            guildId: targetChannel.guild.id,
            originalSize: apiMessage.attachments?.reduce((sum, att) => sum + (att.size || 0), 0) || 0,
            processedSize: webhookPayload.files?.reduce((sum, file) => sum + (file.attachment?.length || 0), 0) || 0
          };
          
          throw enrichedError;
        }
      }
    } else {
      // Autre type d'erreur webhook
      console.error(`❌ Erreur webhook non gérée:`, webhookError.message);
      console.error(`   Code: ${webhookError.code || 'N/A'}`);
      console.error(`   Auteur: ${apiMessage.author.username}`);
      console.error(`   Canal: #${targetChannel.name}`);
      throw webhookError;
    }
  }
  
  // 🎭 AJOUTER LES RÉACTIONS ORIGINALES (sentMessage est maintenant défini dans le try/catch)
  // await processReactions(apiMessage, sentMessage, targetChannel.guild); - Déplacé dans chaque branche
  
  // Note: La fonction retourne directement depuis les try/catch ci-dessus
  
} catch (error) {
  console.log('❌ Traitement message avancé: Échec');
  console.error(`❌ Erreur détaillée: ${error.message}`);
  console.error(`❌ Stack trace:`, error.stack);
  throw error;
}
}

// 🎯 CRÉER OU RÉCUPÉRER LE WEBHOOK POUR UN SALON
async function getOrCreateWebhook(channel) {
  try {
    // 🛡️ VÉRIFICATION CRITIQUE : S'assurer que channel est un objet Discord.js valide
    if (!channel || typeof channel !== 'object') {
      throw new Error(`Canal invalide: objet null ou non-objet (type: ${typeof channel})`);
    }
    
    // Vérifier que c'est bien un canal Discord.js avec les méthodes nécessaires
    if (!channel.fetchWebhooks || typeof channel.fetchWebhooks !== 'function') {
      throw new Error(`Canal invalide: méthode fetchWebhooks manquante (type: ${channel.constructor?.name || 'unknown'}, id: ${channel.id || 'unknown'})`);
    }
    
    if (!channel.createWebhook || typeof channel.createWebhook !== 'function') {
      throw new Error(`Canal invalide: méthode createWebhook manquante (type: ${channel.constructor?.name || 'unknown'}, id: ${channel.id || 'unknown'})`);
    }
    
    // Vérifier les propriétés essentielles d'un canal Discord.js
    if (!channel.id || !channel.name || !channel.guild) {
      throw new Error(`Canal invalide: propriétés manquantes (id: ${channel.id || 'missing'}, name: ${channel.name || 'missing'}, guild: ${!!channel.guild})`);
    }
    
    // Vérifier que le type de canal supporte les webhooks
    if (channel.type !== 0 && channel.type !== 5 && channel.type !== 15) { // TEXT, GUILD_NEWS, FORUM
      throw new Error(`Type de canal non supporté pour webhooks: ${channel.type} (${channel.name}). Supportés: 0 (text), 5 (news), 15 (forum)`);
    }
    
    
    // Vérifier si un webhook existe déjà
    const webhooks = await channel.fetchWebhooks();
    let webhook = webhooks.find(wh => wh.name === 'Mirror Bot Webhook');
    
    if (!webhook) {
      // Créer un nouveau webhook
      webhook = await channel.createWebhook({
        name: 'Mirror Bot Webhook',
        avatar: null,
        reason: 'Webhook pour messages mirror avec avatars natifs'
      });
    } else {
    }
    
    return webhook;
  } catch (error) {
    console.error(`❌ Erreur création webhook #${channel?.name || 'unknown'}:`, error);
    
    // Log erreur webhook dans #error si possible
    try {
      await client.services.logger.logError(
        channel?.guild?.id,
        `Erreur création webhook pour #${channel?.name || 'unknown'}: ${error.message}`,
        channel?.name || 'unknown',
        {
          error: error,
          channelId: channel?.id || 'unknown',
          channelName: channel?.name || 'unknown',
          channelType: channel?.type || 'unknown',
          guildId: channel?.guild?.id || 'unknown',
          channelConstructor: channel?.constructor?.name || 'unknown',
          systemInfo: {
            operation: 'webhookCreation',
            guildName: channel?.guild?.name || 'unknown',
            channelPosition: channel?.position || 'unknown',
            hasRequiredMethods: {
              fetchWebhooks: typeof channel?.fetchWebhooks === 'function',
              createWebhook: typeof channel?.createWebhook === 'function'
            }
          }
        }
      );
    } catch (logError) {
      // Ignorer les erreurs de log si le système n'est pas encore initialisé
      console.error(`❌ Erreur de log webhook:`, logError.message);
    }
    
    throw error;
  }
}

// 🔍 DÉTECTER LE TYPE DE MESSAGE
function getMessageType(message) {
  const types = {
    0: { label: 'Message normal', emoji: '💬' },
    1: { label: 'Utilisateur ajouté', emoji: '➕' },
    2: { label: 'Utilisateur retiré', emoji: '➖' },
    3: { label: 'Appel', emoji: '📞' },
    4: { label: 'Nom salon changé', emoji: '📝' },
    5: { label: 'Icône salon changée', emoji: '🖼️' },
    6: { label: 'Message épinglé', emoji: '📌' },
    7: { label: 'Membre rejoint', emoji: '👋' },
    8: { label: 'Boost serveur', emoji: '🚀' },
    9: { label: 'Boost niveau 1', emoji: '🥉' },
    10: { label: 'Boost niveau 2', emoji: '🥈' },
    11: { label: 'Boost niveau 3', emoji: '🥇' },
    12: { label: 'Salon suivi', emoji: '📢' },
    14: { label: 'Découverte désactivée', emoji: '🔍' },
    15: { label: 'Découverte activée', emoji: '🔍' },
    18: { label: 'Thread créé', emoji: '🧵' },
    19: { label: 'Réponse', emoji: '↪️' },
    20: { label: 'Commande slash', emoji: '⚡' },
    21: { label: 'Début de thread', emoji: '🧵' },
    22: { label: 'Rappel guildes', emoji: '🏠' },
    23: { label: 'Jeu contexte', emoji: '🎮' },
    24: { label: 'Auto-modération', emoji: '🤖' }
  };
  
  return types[message.type] || { label: `Message spécial (${message.type})`, emoji: '📨' };
}

// 🎭 TRAITER LES MENTIONS D'UTILISATEURS AVEC RÉSOLUTION DES VRAIS PSEUDOS  
async function processUserMentions(content, sourceGuild) {
  const defaultNames = require('./config/defaultNames');
  
  if (!content || !content.includes('<@')) {
    return content;
  }
  
  try {
    const userMentionRegex = /<@!?(\d+)>/g;
    let processedContent = content;
    
    const matches = content.matchAll(userMentionRegex);
    for (const match of matches) {
      try {
        const userId = match[1];
        
        // Essayer de récupérer l'utilisateur via l'API
        const userData = client.services.userClient.getUserData(sourceGuild.id);
        if (userData && userData.token) {
          // Utiliser l'API Discord pour récupérer l'utilisateur
          const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
          const response = await fetch(`https://discord.com/api/v10/users/${userId}`, {
            headers: {
              'Authorization': userData.token,
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
          });
          
          if (response.ok) {
            const user = await response.json();
            processedContent = processedContent.replace(match[0], `**@${user.username}**`);
            continue;
          }
        }
        
        // Fallback : Essayer avec le client Discord officiel
        const user = await client.users.fetch(userId);
        processedContent = processedContent.replace(match[0], `**@${user.username}**`);
        
      } catch (error) {
        // Si impossible de récupérer l'utilisateur, utiliser le nom par défaut
        processedContent = processedContent.replace(match[0], `**@${defaultNames.mirrorDefaults.userName}**`);
      }
    }
    
    return processedContent;
    
  } catch (error) {
    console.error('❌ Erreur processUserMentions:', error);
    // En cas d'erreur générale, fallback vers le nom par défaut
    return content.replace(/<@!?(\d+)>/g, `**@${defaultNames.mirrorDefaults.userName}**`);
  }
}

// 🎭 TRAITER LES MENTIONS DE RÔLES AVEC CORRESPONDANCE INTELLIGENTE
async function processRoleMentions(content, sourceGuild, messageType) {
  if (!content || !content.includes('<@&')) {
    return content;
  }
  
  try {
    const roleMentionRegex = /<@&(\d+)>/g;
    let processedContent = content;
    
    // Utiliser le correspondenceManager du scraper
    const correspondenceManager = client.services.scraper.correspondenceManager;
    
    // Trouver le serveur mirror correspondant
    const targetGuildId = correspondenceManager.getTargetGuildId(sourceGuild.id);
    const targetGuild = client.guilds.cache.get(targetGuildId);
    
    if (!targetGuild) {
      const defaultNames = require('./config/defaultNames');
      return content.replace(roleMentionRegex, `**@${defaultNames.mirrorDefaults.roleName}**`);
    }
    
    const matches = content.matchAll(roleMentionRegex);
    for (const match of matches) {
      try {
        const sourceRoleId = match[1];
        
        // Utiliser le système de correspondance
        const mirrorRoleId = await correspondenceManager.getMirrorRoleId(
          sourceRoleId, 
          sourceGuild.id, 
          targetGuild.id
        );
        
        if (mirrorRoleId) {
          processedContent = processedContent.replace(match[0], `<@&${mirrorRoleId}>`);
          continue;
        }
        
        // Pas de correspondance, essayer de créer une
        let sourceRoleName = null;
        
        try {
          const userData = client.services.userClient.getUserData(sourceGuild.id);
          if (userData && userData.token) {
            const sourceRoles = await client.services.userClient.fetchGuildRoles(userData.token, sourceGuild.id);
            const sourceRole = sourceRoles.find(role => role.id === sourceRoleId);
            if (sourceRole) {
              sourceRoleName = sourceRole.name;
            }
          }
        } catch (apiError) {
          // Continuer sans nom
        }
        
        if (sourceRoleName) {
          const mirrorRole = targetGuild.roles.cache.find(role => role.name === sourceRoleName);
          
          if (mirrorRole) {
            await correspondenceManager.registerRoleMapping(
              sourceRoleId, 
              sourceGuild.id, 
              sourceRoleName, 
              mirrorRole.id
            );
            
            processedContent = processedContent.replace(match[0], `<@&${mirrorRole.id}>`);
            continue;
          } else {
            processedContent = processedContent.replace(match[0], `**@${sourceRoleName}**`);
            continue;
          }
        }
        
        // Fallback par défaut
        const defaultNames = require('./config/defaultNames');
        processedContent = processedContent.replace(match[0], `**@${defaultNames.mirrorDefaults.roleName}**`);
        
      } catch (error) {
        console.error(`❌ Erreur mention rôle:`, error.message);
        const defaultNames = require('./config/defaultNames');
        const fallback = `**@${defaultNames.mirrorDefaults.roleName}**`;
        processedContent = processedContent.replace(match[0], fallback);
      }
    }
    
    return processedContent;
    
  } catch (error) {
    console.error(`❌ Erreur processRoleMentions:`, error);
    const defaultNames = require('./config/defaultNames');
    return content.replace(/<@&(\d+)>/g, `**@${defaultNames.mirrorDefaults.roleName}**`);
  }
}

// 📝 TRAITER LE CONTENU AVEC MENTIONS INTELLIGENTES ET TYPE DE MESSAGE
async function processMessageContent(content, sourceGuild, messageType) {
  if (!content) {
    // Si pas de contenu, générer un message basé sur le type (sauf pour les réponses)
    if (messageType.emoji !== '💬' && messageType.emoji !== '↪️') {
      return `${messageType.emoji} *${messageType.label}*`;
    }
    return '';
  }
  
  // 🚨 CAS SPÉCIAL : Contenu vide pour commandes slash
  if (content.trim() === '' && messageType.emoji === '⚡') {
    return `⚡ *Commande slash exécutée*`;
  }
  
  let processedContent = content;
  
  // Ajouter un préfixe pour les types de messages spéciaux (SAUF les réponses car elles ont déjà leur préfixe)
  if (messageType.emoji !== '💬' && messageType.emoji !== '↪️') {
    processedContent = `${messageType.emoji} **${messageType.label}**\n${processedContent}`;
  }
  
  // Traiter les mentions d'utilisateurs (avec résolution des vrais pseudos)
  processedContent = await processUserMentions(processedContent, sourceGuild);
  
  // Traiter les mentions de salons
  processedContent = processedContent.replace(/<#(\d+)>/g, (match, channelId) => {
    return `**#salon**`; // Pour l'instant, remplacé par un texte générique
  });
  
  // Traiter les mentions de rôles
  processedContent = await processRoleMentions(processedContent, sourceGuild, messageType);
  
  // Les commandes slash sont déjà gérées par le préfixe général au-dessus
  // Plus besoin de traitement spécial ici
  
  return processedContent;
}

// 📋 TRAITER LES EMBEDS EXTERNES (SANS RÉSOLUTION DES MENTIONS)
async function processExternalEmbeds(sourceEmbeds) {
  const { EmbedBuilder } = require('discord.js');
  const processedEmbeds = [];
  
  for (const sourceEmbed of sourceEmbeds.slice(0, 10)) { // Discord limite à 10 embeds
    try {
      const embed = new EmbedBuilder();
      
      // Traiter le titre sans résolution des mentions
      if (sourceEmbed.title) {
        embed.setTitle(sourceEmbed.title.substring(0, 256));
      }
      
      // Traiter la description sans résolution des mentions
      if (sourceEmbed.description) {
        embed.setDescription(sourceEmbed.description.substring(0, 4096));
      }
      
      if (sourceEmbed.url) embed.setURL(sourceEmbed.url);
      if (sourceEmbed.color) embed.setColor(sourceEmbed.color);
      if (sourceEmbed.timestamp) embed.setTimestamp(new Date(sourceEmbed.timestamp));
      
      // Traiter l'auteur sans résolution des mentions
      if (sourceEmbed.author) {
        const authorName = sourceEmbed.author.name || '';
        embed.setAuthor({
          name: authorName.substring(0, 256),
          iconURL: sourceEmbed.author.icon_url || undefined,
          url: sourceEmbed.author.url || undefined
        });
      }
      
      // Traiter le footer sans résolution des mentions
      if (sourceEmbed.footer) {
        const footerText = sourceEmbed.footer.text || '';
        embed.setFooter({
          text: footerText.substring(0, 2048),
          iconURL: sourceEmbed.footer.icon_url || undefined
        });
      }
      
      // Images
      if (sourceEmbed.thumbnail?.url) {
        embed.setThumbnail(sourceEmbed.thumbnail.url);
      }
      
      if (sourceEmbed.image?.url) {
        embed.setImage(sourceEmbed.image.url);
      }
      
      // Traiter les fields sans résolution des mentions
      if (sourceEmbed.fields && sourceEmbed.fields.length > 0) {
        for (const field of sourceEmbed.fields.slice(0, 25)) { // Discord limite à 25 fields
          const fieldName = field.name?.substring(0, 256) || 'Champ';
          const fieldValue = field.value?.substring(0, 1024) || 'Valeur';
          
          embed.addFields({
            name: fieldName,
            value: fieldValue,
            inline: field.inline || false
          });
        }
      }
      
      processedEmbeds.push(embed);
      
    } catch (error) {
      console.error('❌ Erreur traitement embed externe:', error);
      // Continuer avec les autres embeds
    }
  }
  
  return processedEmbeds;
}

// 📋 TRAITER LES EMBEDS COMPLETS AVEC TOUTES LES PROPRIÉTÉS ET MENTIONS
async function processCompleteEmbeds(sourceEmbeds, sourceGuild = null) {
  const { EmbedBuilder } = require('discord.js');
  const processedEmbeds = [];
  
  for (const sourceEmbed of sourceEmbeds.slice(0, 10)) { // Discord limite à 10 embeds
    try {
      const embed = new EmbedBuilder();
      
      // 🎯 TRAITER LE TITRE AVEC MENTIONS
      if (sourceEmbed.title) {
        const processedTitle = await processRoleMentions(sourceEmbed.title, sourceGuild);
        embed.setTitle(processedTitle.substring(0, 256));
      }
      
      // 🎯 TRAITER LA DESCRIPTION AVEC MENTIONS  
      if (sourceEmbed.description) {
        let processedDescription = await processRoleMentions(sourceEmbed.description, sourceGuild);
        processedDescription = await processUserMentions(processedDescription, sourceGuild);
        processedDescription = processedDescription.replace(/<#(\d+)>/g, `**#important**`);
        embed.setDescription(processedDescription.substring(0, 4096));
      }
      
      if (sourceEmbed.url) embed.setURL(sourceEmbed.url);
      if (sourceEmbed.color) embed.setColor(sourceEmbed.color);
      if (sourceEmbed.timestamp) embed.setTimestamp(new Date(sourceEmbed.timestamp));
      
      // 🎯 TRAITER L'AUTEUR AVEC MENTIONS
      if (sourceEmbed.author) {
        let authorName = sourceEmbed.author.name || '';
        if (authorName) {
          authorName = await processRoleMentions(authorName, sourceGuild);
          authorName = await processUserMentions(authorName, sourceGuild);
        }
        
        embed.setAuthor({
          name: authorName.substring(0, 256),
          iconURL: sourceEmbed.author.icon_url || undefined,
          url: sourceEmbed.author.url || undefined
        });
      }
      
      // 🎯 TRAITER LE FOOTER AVEC MENTIONS
      if (sourceEmbed.footer) {
        let footerText = sourceEmbed.footer.text || '';
        if (footerText) {
          footerText = await processRoleMentions(footerText, sourceGuild);
          footerText = await processUserMentions(footerText, sourceGuild);
        }
        
        embed.setFooter({
          text: footerText.substring(0, 2048),
          iconURL: sourceEmbed.footer.icon_url || undefined
        });
      }
      
      // Images
      if (sourceEmbed.thumbnail?.url) {
        embed.setThumbnail(sourceEmbed.thumbnail.url);
      }
      
      if (sourceEmbed.image?.url) {
        embed.setImage(sourceEmbed.image.url);
      }
      
      // Traiter les fields avec mentions
      if (sourceEmbed.fields && sourceEmbed.fields.length > 0) {
        for (const field of sourceEmbed.fields.slice(0, 25)) { // Discord limite à 25 fields
          let fieldName = field.name?.substring(0, 256) || 'Champ';
          let fieldValue = field.value?.substring(0, 1024) || 'Valeur';
          
          // Traiter les mentions dans le nom du field
          if (fieldName.includes('<@&')) {
            fieldName = await processRoleMentions(fieldName, sourceGuild);
          }
          fieldName = await processUserMentions(fieldName, sourceGuild);
          fieldName = fieldName.replace(/<#(\d+)>/g, `**#important**`);
          
          // Traiter les mentions dans la valeur du field
          if (fieldValue.includes('<@&')) {
            fieldValue = await processRoleMentions(fieldValue, sourceGuild);
          }
          fieldValue = await processUserMentions(fieldValue, sourceGuild);
          fieldValue = fieldValue.replace(/<#(\d+)>/g, `**#important**`);
          
          embed.addFields({
            name: fieldName,
            value: fieldValue,
            inline: field.inline || false
          });
        }
      }
      
      processedEmbeds.push(embed);
      
    } catch (error) {
      console.error('❌ Erreur traitement embed:', error);
      // Continuer avec les autres embeds
    }
  }
  
  return processedEmbeds;
}

// 📎 TRAITER ET TÉLÉCHARGER LES ATTACHMENTS (IMAGES, VIDÉOS, FICHIERS) - VERSION ULTRA-SÉCURISÉE
async function processAttachments(sourceAttachments) {
  const { AttachmentBuilder } = require('discord.js');
  const axios = require('axios');
  const processedFiles = [];
  
  // Limites ULTRA-strictes pour éviter l'erreur 40005
  const maxFileSize = 7 * 1024 * 1024; // 7MB par fichier (encore plus strict)
  const maxTotalFiles = 4; // Maximum 4 fichiers par groupe
  
  let totalProcessedSize = 0;
  const maxTotalSize = 12 * 1024 * 1024; // 12MB total maximum par groupe
  
  for (const attachment of sourceAttachments.slice(0, maxTotalFiles)) {
    try {
      // Vérification de la taille individuelle
      if (attachment.size > maxFileSize) {
        continue;
      }
      
      // Vérification de la taille totale cumulée
      if (totalProcessedSize + attachment.size > maxTotalSize) {
        break;
      }
      
      
      // Télécharger avec timeout réduit pour éviter les blocages
      const response = await axios.get(attachment.url, {
        responseType: 'arraybuffer',
        timeout: 20000, // 20 secondes timeout (réduit)
        maxContentLength: maxFileSize, // Limite axios
        maxBodyLength: maxFileSize,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      
      const bufferData = Buffer.from(response.data);
      
      // Vérification finale de la taille après téléchargement
      if (bufferData.length > maxFileSize) {
        continue;
      }
      
      // Vérification de la taille totale après téléchargement
      if (totalProcessedSize + bufferData.length > maxTotalSize) {
        break;
      }
      
      // Créer l'attachment Discord
      const file = new AttachmentBuilder(bufferData, {
        name: attachment.filename,
        description: attachment.description || undefined
      });
      
      processedFiles.push(file);
      totalProcessedSize += bufferData.length;
      
      
      // Petit délai entre chaque fichier pour éviter de surcharger
      await new Promise(resolve => setTimeout(resolve, 200));
      
    } catch (error) {
      console.error(`❌ Erreur téléchargement ${attachment.filename}:`, error.message);
      
      // Ne PAS créer de fichier d'erreur pour éviter d'ajouter du poids
      // Les erreurs seront gérées par la logique de conversion en liens
    }
  }
  
  
  return processedFiles;
}

// 🎨 TRAITER LES STICKERS DISCORD
async function processStickers(stickers) {
  const { EmbedBuilder } = require('discord.js');
  const stickerEmbeds = [];
  
  for (const sticker of stickers.slice(0, 3)) { // Limiter à 3 stickers
    try {
      const stickerEmbed = new EmbedBuilder()
        .setTitle(`🎨 Sticker: ${sticker.name}`)
        .setColor(0x5865F2) // Couleur Discord bleu
        .setDescription(`*Sticker envoyé dans le message original*`);
      
      // Ajouter l'image du sticker si disponible
      if (sticker.id) {
        // Format de l'URL des stickers Discord
        const stickerFormat = sticker.format_type === 1 ? 'png' : 
                            sticker.format_type === 2 ? 'apng' : 
                            sticker.format_type === 3 ? 'lottie' : 'png';
        
        if (stickerFormat !== 'lottie') { // Lottie n'est pas supporté dans les embeds
          const stickerURL = `https://media.discordapp.net/stickers/${sticker.id}.${stickerFormat}?size=160`;
          stickerEmbed.setThumbnail(stickerURL);
        }
      }
      
      // Ajouter des détails sur le sticker - transmission intégrale
      if (sticker.description) {
        stickerEmbed.addFields({
          name: 'Description',
          value: sticker.description,
          inline: true
        });
      }
      
      stickerEmbeds.push(stickerEmbed);
    
  } catch (error) {
      console.error('❌ Erreur traitement sticker:', error);
      
      // Fallback: créer un embed simple
      const fallbackEmbed = new EmbedBuilder()
        .setTitle('🎨 Sticker')
        .setDescription(`Sticker "${sticker.name || 'Sticker personnalisé'}" envoyé`)
        .setColor(0x5865F2);
      
      stickerEmbeds.push(fallbackEmbed);
    }
  }
  
  return stickerEmbeds;
}

// 🎭 TRAITER LES RÉACTIONS ORIGINALES AVEC VÉRIFICATION D'EXISTENCE
async function processReactions(sourceMessage, targetMessage, targetGuild = null) {
  if (!sourceMessage.reactions || sourceMessage.reactions.length === 0) return;
  
  try {
    for (const reaction of sourceMessage.reactions.slice(0, 20)) { // Limiter à 20 réactions
      try {
        let emoji = reaction.emoji;
        let canAddReaction = false;
        
        // 🔍 VÉRIFIER SI L'EMOJI EXISTE SUR LE SERVEUR MIRROR
        if (emoji.id) {
          // Emoji personnalisé - vérifier s'il existe sur le serveur mirror
          if (targetGuild) {
            const mirrorEmoji = targetGuild.emojis.cache.get(emoji.id);
            if (mirrorEmoji) {
              canAddReaction = true;
            } else {
            }
          } else {
            // Si pas de targetGuild fourni, essayer quand même (pour compatibilité ascendante)
            canAddReaction = true;
          }
        } else {
          // Emoji unicode standard - toujours disponible
          canAddReaction = true;
        }
        
        if (canAddReaction) {
          // Gérer les emojis personnalisés vs unicode
          if (emoji.id) {
            // Emoji personnalisé
            await targetMessage.react(`<:${emoji.name}:${emoji.id}>`);
          } else {
            // Emoji unicode
            await targetMessage.react(emoji.name);
          }
        }
        
        // Petit délai entre chaque réaction
        await new Promise(resolve => setTimeout(resolve, 300));
        
      } catch (reactionError) {
        // Erreur 10014 = Unknown Emoji (emoji n'existe pas)
        if (reactionError.code === 10014) {
        } else {
          console.error(`❌ Erreur réaction ${reaction.emoji.name}:`, reactionError.message);
        }
        // Continuer avec les autres réactions
      }
    }
  } catch (error) {
    console.error('❌ Erreur traitement réactions:', error);
  }
}

// 🔔 DÉTECTER ET LOGGER LES MENTIONS DE RÔLES
async function detectAndLogRoleMentions(sourceMessage, mirrorMessage, targetChannel, sourceGuild) {
  try {
    const content = sourceMessage.content || '';
    
    // Vérifier s'il y a des mentions de rôles dans le contenu
    const roleMentionRegex = /<@&(\d+)>/g;
    const roleMentions = [...content.matchAll(roleMentionRegex)];
    
    if (roleMentions.length === 0) {
      return; // Pas de mentions de rôles
    }
    
    
    // Récupérer les informations des rôles mentionnés
    const mentionedRoles = [];
    const userData = client.services.userClient.getUserData(targetChannel.guild.id);
    
    if (userData && userData.token) {
      try {
        const sourceRoles = await client.services.userClient.fetchGuildRoles(userData.token, sourceGuild.id);
        
        for (const match of roleMentions) {
          const roleId = match[1];
          const sourceRole = sourceRoles.find(role => role.id === roleId);
          
          if (sourceRole) {
            mentionedRoles.push({
              roleId: roleId,
              roleName: sourceRole.name
            });
          } else {
            // Rôle non trouvé, utiliser l'ID comme nom de fallback
            mentionedRoles.push({
              roleId: roleId,
              roleName: `Rôle inconnu (${roleId})`
            });
          }
        }
      } catch (error) {
        console.error('❌ Erreur récupération rôles source:', error);
        // Fallback : utiliser les IDs comme noms
        for (const match of roleMentions) {
          mentionedRoles.push({
            roleId: match[1],
            roleName: `Rôle (${match[1]})`
          });
        }
      }
    }
    
    if (mentionedRoles.length === 0) {
      return; // Aucun rôle valide trouvé
    }
    
    // Préparer les données pour l'enregistrement
    const mentionData = {
      messageId: sourceMessage.id,
      channelId: sourceMessage.channel_id,
      channelName: targetChannel.name,
      guildId: sourceGuild.id,
      
      mirrorMessageId: mirrorMessage.id,
      mirrorChannelId: targetChannel.id,
      mirrorGuildId: targetChannel.guild.id,
      
      authorTag: `${sourceMessage.author.username}#${sourceMessage.author.discriminator}`,
      authorId: sourceMessage.author.id,
      messageContent: content.length > 1800 ? content.substring(0, 1800) + '...' : content,
      
      mentionedRoles: mentionedRoles,
      messageTimestamp: new Date(sourceMessage.timestamp)
    };
    
    // Sauvegarder en base de données
    await saveRoleMentionToDatabase(mentionData);
    
    // Logger dans le salon mentions-logs
    await client.services.logger.logRoleMention(targetChannel.guild.id, mentionData);
    
  } catch (error) {
    console.error('❌ Erreur détection mentions de rôles:', error);
  }
}

// 💾 SAUVEGARDER UNE MENTION DE RÔLE EN BASE DE DONNÉES
async function saveRoleMentionToDatabase(mentionData) {
  try {
    const RoleMention = require('./models/RoleMention');
    
    const roleMention = new RoleMention(mentionData);
    await roleMention.save();
    
    
  } catch (error) {
    console.error('❌ Erreur sauvegarde mention de rôle:', error);
  }
}

// 📨 TRAITER LES MESSAGES TRANSFÉRÉS ET RÉPONSES AVEC LIENS VERS LE SERVEUR MIRROR
async function processMessageReference(message, webhook, sourceGuild, targetGuildId) {
  try {
    const reference = message.message_reference;
    if (!reference) return { prefix: '', embeds: [] };
    
    // Déterminer le type de référence
    let referenceType = '↪️';
    if (message.type === 19) { // MESSAGE_TYPE_REPLY
      referenceType = '↪️';
    } else if (message.type === 21) { // MESSAGE_TYPE_THREAD_STARTER_MESSAGE  
      referenceType = '🧵';
    } else {
      referenceType = '📨';
    }
    
    // 🛡️ DÉTECTION PRÉCOCE D'INACCESSIBILITÉ
    const isExternalServer = reference.guild_id && reference.guild_id !== sourceGuild.id;
    const isInaccessibleReference = await checkMessageAccessibility(reference, sourceGuild);
    
    // 🆕 CHERCHER LE MESSAGE RÉFÉRENCÉ SUR LE SERVEUR MIRROR
    const ProcessedMessage = require('./models/ProcessedMessage');
    const referencedMessage = await ProcessedMessage.findOne({
      discordId: reference.message_id,
      mirrorGuildId: targetGuildId
    });
    
    if (referencedMessage && referencedMessage.mirrorMessageId) {
      // Message trouvé sur le serveur mirror - créer un lien vers le mirror
      const mirrorLink = `https://discord.com/channels/${targetGuildId}/${referencedMessage.mirrorChannelId}/${referencedMessage.mirrorMessageId}`;
      return { 
        prefix: `${referenceType} **[Réponse](${mirrorLink})**\n`,
        embeds: []
      };
    } else {
      // Message pas encore migré ou introuvable
      
      // 🛡️ SI DÉTECTION D'INACCESSIBILITÉ, UTILISER FALLBACK IMMÉDIAT
      if (isInaccessibleReference) {
        return await handleInaccessibleReference(message, referenceType, sourceGuild, isExternalServer);
      }
      
      // 🆕 MESSAGES TRANSFÉRÉS DEPUIS SERVEUR EXTERNE AVEC GESTION GRACIEUSE
      if (isExternalServer) {
        
        try {
          // 🛡️ TENTATIVE SÉCURISÉE DE RÉCUPÉRATION DU MESSAGE RÉFÉRENCÉ
          const referencedMessageData = await safelyFetchReferencedMessage(reference, sourceGuild);
          
          if (referencedMessageData) {
            // Message récupéré avec succès, traiter normalement
            return await processSuccessfulReference(referencedMessageData, referenceType);
          } else {
            // Impossible de récupérer le message, utiliser le contenu local
            return await extractContentFromSourceMessage(message, referenceType, isExternalServer);
          }
          
        } catch (referenceError) {
          
          // 🛡️ FALLBACK GRACIEUX : Extraire le contenu du message source
          return await extractContentFromSourceMessage(message, referenceType, isExternalServer);
        }
      } else {
        // Message de référence dans le même serveur - traitement standard
        
        try {
          // 🛡️ TENTATIVE SÉCURISÉE MÊME POUR LES MESSAGES INTERNES
          const referencedMessageData = await safelyFetchReferencedMessage(reference, sourceGuild);
          
          if (referencedMessageData) {
            return await processSuccessfulReference(referencedMessageData, referenceType);
          } else {
            // Fallback pour message interne inaccessible
            return await extractContentFromSourceMessage(message, referenceType, false);
          }
          
        } catch (referenceError) {
          return await extractContentFromSourceMessage(message, referenceType, false);
        }
      }
    }
    
  } catch (error) {
    console.error('❌ Erreur traitement message référencé:', error);
    
    // 🛡️ FALLBACK ULTIME TOUJOURS GRACIEUX
    const referenceType = message.type === 19 ? '↪️' : message.type === 21 ? '🧵' : '📨';
    return await extractContentFromSourceMessage(message, referenceType, false);
  }
}

// 🛡️ VÉRIFIER L'ACCESSIBILITÉ D'UN MESSAGE RÉFÉRENCÉ
async function checkMessageAccessibility(reference, sourceGuild) {
  try {
    // Si c'est un serveur externe, considérer comme potentiellement inaccessible
      if (reference.guild_id && reference.guild_id !== sourceGuild.id) {
      return true; // Potentiellement inaccessible
    }
    
    // Pour les messages internes, on peut faire un test rapide si on a l'ID du salon
    if (reference.channel_id) {
      const userData = client.services.userClient.getUserData(sourceGuild.id);
      if (userData && userData.token) {
        // Test rapide d'accès au salon
        const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
        const response = await fetch(`https://discord.com/api/v10/channels/${reference.channel_id}`, {
          method: 'HEAD',
          headers: {
            'Authorization': userData.token,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });
        
        return !response.ok; // Inaccessible si erreur
      }
    }
    
    return false; // Supposé accessible
  } catch (error) {
    return true; // En cas de doute, considérer comme inaccessible
  }
}

// 🛡️ RÉCUPÉRER UN MESSAGE RÉFÉRENCÉ DE MANIÈRE SÉCURISÉE
async function safelyFetchReferencedMessage(reference, sourceGuild) {
  try {
    if (!reference.channel_id || !reference.message_id) {
      return null;
    }
    
    const userData = client.services.userClient.getUserData(sourceGuild.id);
    if (!userData || !userData.token) {
      return null;
    }
    
    const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
    
    // Récupérer le message avec timeout court pour éviter les blocages
    const response = await fetch(
      `https://discord.com/api/v10/channels/${reference.channel_id}/messages/${reference.message_id}`,
      {
        headers: {
          'Authorization': userData.token,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 5000 // 5 secondes timeout
      }
    );
    
    if (!response.ok) {
      if (response.status === 403) {
      } else if (response.status === 404) {
      } else {
      }
      return null;
    }
    
    const messageData = await response.json();
    return messageData;
    
  } catch (error) {
    return null;
  }
}

// 🛡️ TRAITER UN MESSAGE RÉFÉRENCÉ RÉCUPÉRÉ AVEC SUCCÈS
async function processSuccessfulReference(messageData, referenceType) {
  try {
    // Extraire le contenu du message référencé
    let content = messageData.content || '';
    
    if (content.length > 200) {
      content = content.substring(0, 200) + '...';
    }
    
    const authorName = messageData.author?.username || 'Utilisateur';
    
    if (content) {
      return {
        prefix: `${referenceType} **En réponse à ${authorName}:**\n> ${content}\n`,
        embeds: []
      };
    } else if (messageData.embeds && messageData.embeds.length > 0) {
      return {
        prefix: `${referenceType} **En réponse à ${authorName}** (message avec embed)\n`,
        embeds: []
      };
    } else if (messageData.attachments && messageData.attachments.length > 0) {
      return {
        prefix: `${referenceType} **En réponse à ${authorName}** (message avec fichier(s))\n`,
        embeds: []
      };
    } else {
      return {
        prefix: `${referenceType} **En réponse à ${authorName}**\n`,
        embeds: []
      };
    }
    
  } catch (error) {
    return {
      prefix: `${referenceType} **En réponse à un message**\n`,
      embeds: []
    };
  }
}

// 🛡️ GÉRER UNE RÉFÉRENCE INACCESSIBLE
async function handleInaccessibleReference(message, referenceType, sourceGuild, isExternalServer) {
  
  if (isExternalServer) {
    return {
      prefix: `${referenceType} **Message transféré depuis serveur externe**\n> *Contenu inaccessible*\n`,
      embeds: []
    };
  } else {
    return {
      prefix: `${referenceType} **En réponse à un message**\n> *Message inaccessible*\n`,
      embeds: []
    };
  }
}

// 🛡️ EXTRAIRE LE CONTENU DU MESSAGE SOURCE (FALLBACK PRINCIPAL)
async function extractContentFromSourceMessage(message, referenceType, isExternalServer) {
  try {
    
    // 📋 ANALYSER LES EMBEDS DU MESSAGE SOURCE
          let transferredEmbeds = [];
          if (message.embeds && message.embeds.length > 0) {
            
      // Traiter les embeds du message source (qui peuvent contenir le message transféré)
            transferredEmbeds = await processExternalEmbeds(message.embeds);
          }
          
          // 📝 ANALYSER LE CONTENU TEXTE DU MESSAGE SOURCE
          let transferredContent = '';
          if (message.content) {
      transferredContent = message.content.trim();
          }
          
    // 🎯 CONSTRUIRE LA RÉPONSE APPROPRIÉE
          if (transferredEmbeds.length > 0) {
      const prefix = isExternalServer ? 
        `${referenceType} **Message transféré depuis serveur externe**\n` :
        `${referenceType} **En réponse à un message** (contenu intégré)\n`;
      
            return {
        prefix: prefix,
              embeds: transferredEmbeds
            };
    } else if (transferredContent) {
      
      // Nettoyer et limiter le contenu
      let cleanContent = transferredContent;
            if (cleanContent.length > 150) {
              cleanContent = cleanContent.substring(0, 150) + '...';
            }
      
      const prefix = isExternalServer ? 
        `${referenceType} **Message transféré depuis serveur externe**\n> ${cleanContent}\n` :
        `${referenceType} **En réponse à un message**\n> ${cleanContent}\n`;
      
            return {
        prefix: prefix,
              embeds: []
            };
            } else {
      const prefix = isExternalServer ? 
        `${referenceType} **Message transféré depuis serveur externe**\n> *Contenu non disponible*\n` :
        `${referenceType} **En réponse à un message**\n> *Contenu non disponible*\n`;
      
            return {
        prefix: prefix,
              embeds: []
            };
          }
          
        } catch (extractError) {
    const prefix = isExternalServer ? 
      `${referenceType} **Message transféré depuis serveur externe**\n> *Erreur d'extraction du contenu*\n` :
      `${referenceType} **En réponse à un message**\n> *Erreur d'extraction du contenu*\n`;
    
      return { 
      prefix: prefix,
      embeds: []
    };
  }
}

async function handleStop(interaction) {
  const permissionCheck = checkAdminPermission(interaction);
  if (!permissionCheck.hasPermission) {
    await interaction.reply(permissionCheck.error);
    return;
  }
  
  try {
    // 🚀 ARRÊTER LE SYSTÈME ÉVÉNEMENTIEL EN PRIORITÉ
    if (client.services.scraper.isEventBased) {
      await client.services.scraper.stopEventBasedScraping(interaction.guild.id);
      await interaction.reply('✅ **Scraping événementiel arrêté !**\n\n⚡ Événements WebSocket déconnectés\n💾 **État sauvegardé** - Résistant aux crashes');
    } else {
      // 🆕 ARRÊTER TOUS LES INTERVALS (GLOBAL + PERSONNALISÉS)
      // Note: stopAllScrapingIntervals() supprimé (système événementiel)
      await interaction.reply('✅ **Scraping classique arrêté !**\n\n💾 **État sauvegardé** - Le bot se souviendra de cet arrêt\n🔄 **Tous les intervals** (global + personnalisés) ont été nettoyés');
    }
    
    // 🆕 SAUVEGARDER L'ÉTAT EN BASE
    await client.services.userClient.markScrapingInactive(interaction.guild.id);

    // 🔄 Vérifier s'il faut arrêter le service de sync (si aucun serveur actif)
    const ServerConfig = require('./models/ServerConfig');
    const activeServers = await ServerConfig.countDocuments({ scrapingActive: true });
    if (activeServers === 0 && client.services.channelSync) {
      client.services.channelSync.stop();
    }
    
  } catch (error) {
    await interaction.reply(`❌ Erreur: ${error.message}`);
  }
}

async function handleDisconnect(interaction) {
  const permissionCheck = checkAdminPermission(interaction);
  if (!permissionCheck.hasPermission) {
    await interaction.reply(permissionCheck.error);
    return;
  }
  
  try {
    if (client.services.userClient.hasUserToken(interaction.guild.id)) {
      // Arrêter le scraping
      client.services.scraper.stopScraping();
      
      // Supprimer le token utilisateur
      client.services.userClient.removeUserToken(interaction.guild.id);
      
      await interaction.reply('✅ **Token utilisateur déconnecté**\n\n🔌 Connexion au serveur source fermée\n⏹️ Scraping automatique arrêté\n🔒 Token utilisateur supprimé de la mémoire');
    } else {
      await interaction.reply('ℹ️ Aucune connexion utilisateur active à déconnecter.');
    }
  } catch (error) {
    await interaction.reply(`❌ Erreur: ${error.message}`);
  }
}

async function handleDiscovery(interaction) {
  const permissionCheck = checkAdminPermission(interaction);
  if (!permissionCheck.hasPermission) {
    await interaction.reply(permissionCheck.error);
    return;
  }
  
  await interaction.deferReply();

  try {
    const sourceGuild = client.services.userClient.getSourceGuild(interaction.guild.id);

    if (!sourceGuild) {
      await interaction.editReply('❌ Configuration serveur source manquante. Vérifiez SERVER_ID dans les variables d\'environnement Coolify.');
      return;
    }

    await interaction.editReply('🔍 **Auto-discovery en cours...**\n\n⏳ Comparaison des salons entre source et mirror...');
    
    // Lancer l'auto-discovery manuellement
    await performAutoDiscovery(interaction.guild, interaction.guild.id);
    
    await interaction.editReply('✅ **Auto-discovery terminée !**\n\n📋 Consultez #newroom pour voir les détails des changements détectés.\n\n💡 **Rappel :** L\'auto-discovery s\'exécute automatiquement tous les jours à 4h00 du matin.');
    
  } catch (error) {
    console.log('❌ Discovery manuelle: Échec');
    await interaction.editReply(`❌ **Erreur lors de l'auto-discovery :** ${error.message}`);
  }
}

async function handleCleanup(interaction) {
  const permissionCheck = checkAdminPermission(interaction);
  if (!permissionCheck.hasPermission) {
    await interaction.reply(permissionCheck.error);
    return;
  }

  await interaction.deferReply();

  try {
    // Récupérer le serveur source (tokens depuis Coolify env vars)
    const sourceGuild = client.services.userClient.getSourceGuild(interaction.guild.id);

    if (!sourceGuild) {
      await interaction.editReply('❌ Configuration serveur source manquante. Vérifiez SERVER_ID dans les variables d\'environnement Coolify.');
      return;
    }

    // Vérifier si on doit inclure les salons blacklistés
    const includeBlacklisted = interaction.options?.getBoolean('include_blacklisted') || false;

    await interaction.editReply('🧹 **Nettoyage en cours...**\n\n🔍 Recherche des salons mirror supprimés...');

    // Lancer le nettoyage général
    const cleanedCount = await cleanupAllDeletedMirrorChannels(interaction.guild, sourceGuild.id);

    // 🆕 Nettoyage des channels obsolètes (> 30 jours d'inactivité)
    const Channel = require('./models/Channel');
    const cutoffDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const obsoleteChannelsResult = await Channel.deleteMany({
      serverId: sourceGuild.id,
      lastActivity: { $lt: cutoffDate },
      manuallyDeleted: false,
      isBlacklisted: false,
      isActive: false
    });

    let response = `✅ **Nettoyage terminé !**\n\n`;
    let blacklistedResult = null;

    // Si demandé, réactiver aussi les salons blacklistés
    if (includeBlacklisted) {
      const Channel = require('./models/Channel');

      const blacklistedChannels = await Channel.find({
        serverId: sourceGuild.id,
        isBlacklisted: true
      });

      if (blacklistedChannels.length > 0) {
        // Réactiver tous les salons blacklistés
        const result = await Channel.updateMany(
          {
            serverId: sourceGuild.id,
            isBlacklisted: true
          },
          {
            $set: {
              isBlacklisted: false,
              blacklistedUntil: null,
              failedAttempts: 0
            }
          }
        );

        blacklistedResult = result.modifiedCount;

        // Logger l'action dans #admin-logs
        await client.services.logger.logAdminAction(
          interaction.guild.id,
          `🔄 Réactivation: ${result.modifiedCount} salons blacklistés réactivés par ${interaction.user.tag}\n` +
          `🧹 Nettoyage: ${cleanedCount} salons supprimés de la base`
        );
      }
    }

    if (cleanedCount > 0 || obsoleteChannelsResult.deletedCount > 0) {
      response += `🧹 **Salons nettoyés :** ${cleanedCount}\n`;
      if (obsoleteChannelsResult.deletedCount > 0) {
        response += `🗑️ **Mappings obsolètes supprimés :** ${obsoleteChannelsResult.deletedCount}\n`;
      }
      response += `🗑️ **Actions effectuées :**\n`;
      response += `• Base de données nettoyée\n`;
      response += `• Intervals personnalisés arrêtés\n`;
      response += `• Messages associés supprimés\n`;
      if (obsoleteChannelsResult.deletedCount > 0) {
        response += `• Channels inactifs > 30j purgés\n`;
      }
      response += `\n`;
    } else {
      response += `✅ **Aucun nettoyage nécessaire**\n`;
      response += `📊 Tous les salons en base existent sur le serveur\n\n`;
    }

    if (blacklistedResult !== null && blacklistedResult > 0) {
      response += `🔄 **Salons blacklistés réactivés :** ${blacklistedResult}\n`;
      response += `💡 Ces salons seront testés lors du prochain cycle\n\n`;
    } else if (includeBlacklisted) {
      response += `ℹ️ **Aucun salon blacklisté trouvé**\n\n`;
    }

    response += `📊 **Résultat :** Système synchronisé avec vos salons actuels`;

    if (!includeBlacklisted) {
      response += `\n\n💡 **Tip :** Utilisez \`/cleanup include_blacklisted:true\` pour aussi réactiver les salons blacklistés`;
    }

    await sendLongResponse(interaction, response);

  } catch (error) {
    console.log('❌ Nettoyage manuel: Échec');
    await interaction.editReply(`❌ **Erreur:** ${error.message}`);
  }
}

async function handlePurgeLogs(interaction) {
  const permissionCheck = checkAdminPermission(interaction);
  if (!permissionCheck.hasPermission) {
    await interaction.reply(permissionCheck.error);
    return;
  }

  await interaction.deferReply();

  try {
    const Log = require('./models/Log');
    const { EmbedBuilder } = require('discord.js');


    const countBefore = await Log.countDocuments();

    if (countBefore === 0) {
      await interaction.editReply('✅ Aucun log à supprimer, collection déjà vide.');
      return;
    }

    const startTime = Date.now();
    const result = await Log.deleteMany({});
    const duration = Date.now() - startTime;

    const spaceMB = Math.round((result.deletedCount * 0.5) / 1024 * 100) / 100;

    await client.services.logger.logAdminAction(
      interaction.guild.id,
      `🧹 Purge logs: ${result.deletedCount} entrées supprimées par ${interaction.user.tag} (${spaceMB}MB libérés)`
    );

    const embed = new EmbedBuilder()
      .setColor('#00FF00')
      .setTitle('🧹 Purge des logs terminée')
      .setDescription('Tous les logs système ont été supprimés avec succès')
      .addFields(
        { name: '📊 Logs supprimés', value: `${result.deletedCount.toLocaleString()}`, inline: true },
        { name: '💾 Espace libéré', value: `~${spaceMB}MB`, inline: true },
        { name: '⏱️ Durée', value: `${duration}ms`, inline: true },
        { name: '✅ Statut', value: 'Collection entièrement purgée', inline: false }
      )
      .setFooter({ text: `Exécuté par ${interaction.user.tag}` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });


  } catch (error) {
    console.error('❌ Erreur purge logs:', error);
    await client.services.logger.logError(
      interaction.guild.id,
      `Erreur purge logs: ${error.message}`
    );
    await interaction.editReply(`❌ **Erreur lors de la purge:** ${error.message}`);
  }
}

async function handleEmergencyPurge(interaction) {
  const permissionCheck = checkAdminPermission(interaction);
  if (!permissionCheck.hasPermission) {
    await interaction.reply(permissionCheck.error);
    return;
  }

  await interaction.deferReply();

  try {
    const ProcessedMessage = require('./models/ProcessedMessage');
    const MemberDetail = require('./models/MemberDetail');
    const Log = require('./models/Log');
    const MemberCount = require('./models/MemberCount');
    const RoleMention = require('./models/RoleMention');
    const { EmbedBuilder } = require('discord.js');


    const startTime = Date.now();
    const results = {
      processedMessages: 0,
      memberDetails: 0,
      logs: 0,
      memberCounts: 0,
      roleMentions: 0
    };

    // 1. ProcessedMessage (généralement la plus volumineuse)
    const pmStart = Date.now();
    const pmResult = await ProcessedMessage.deleteMany({});
    results.processedMessages = pmResult.deletedCount;

    // 2. MemberDetail (tracking membres avec historique)
    const mdStart = Date.now();
    const mdResult = await MemberDetail.deleteMany({});
    results.memberDetails = mdResult.deletedCount;

    // 3. Log (logs système)
    const lgStart = Date.now();
    const lgResult = await Log.deleteMany({});
    results.logs = lgResult.deletedCount;

    // 4. MemberCount (statistiques)
    const mcStart = Date.now();
    const mcResult = await MemberCount.deleteMany({});
    results.memberCounts = mcResult.deletedCount;

    // 5. RoleMention (mentions rôles)
    const rmStart = Date.now();
    const rmResult = await RoleMention.deleteMany({});
    results.roleMentions = rmResult.deletedCount;

    const duration = Date.now() - startTime;
    const totalDeleted = results.processedMessages + results.memberDetails + results.logs + results.memberCounts + results.roleMentions;
    const spaceMB = Math.round((totalDeleted * 0.5) / 1024 * 100) / 100;

    // Logger action admin
    await client.services.logger.logAdminAction(
      interaction.guild.id,
      `🚨 Emergency Purge: ${totalDeleted.toLocaleString()} documents supprimés par ${interaction.user.tag} (${spaceMB}MB libérés) - ProcessedMessage: ${results.processedMessages}, MemberDetail: ${results.memberDetails}, Log: ${results.logs}, MemberCount: ${results.memberCounts}, RoleMention: ${results.roleMentions}`
    );

    // Créer embed avec breakdown détaillé
    const embed = new EmbedBuilder()
      .setColor('#FF0000')
      .setTitle('🚨 Emergency Purge MongoDB Terminée')
      .setDescription('Collections temporaires supprimées avec succès')
      .addFields(
        { name: '📊 ProcessedMessage', value: `${results.processedMessages.toLocaleString()}`, inline: true },
        { name: '👥 MemberDetail', value: `${results.memberDetails.toLocaleString()}`, inline: true },
        { name: '📝 Log', value: `${results.logs.toLocaleString()}`, inline: true },
        { name: '📈 MemberCount', value: `${results.memberCounts.toLocaleString()}`, inline: true },
        { name: '🏷️ RoleMention', value: `${results.roleMentions.toLocaleString()}`, inline: true },
        { name: '━━━━━━━━━━━━━━━━', value: '\u200b', inline: false },
        { name: '📊 TOTAL', value: `${totalDeleted.toLocaleString()} documents`, inline: true },
        { name: '💾 Espace libéré', value: `~${spaceMB}MB`, inline: true },
        { name: '⏱️ Durée', value: `${duration}ms`, inline: true }
      )
      .setFooter({ text: `Exécuté par ${interaction.user.tag}` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });


  } catch (error) {
    console.error('❌ [EMERGENCY PURGE] Erreur:', error);
    await client.services.logger.logError(
      interaction.guild.id,
      `Erreur emergency purge: ${error.message}`
    );
    await interaction.editReply(`❌ **Erreur lors de l'emergency purge:** ${error.message}`);
  }
}

async function handleDelCategories(interaction) {
  const permissionCheck = checkAdminPermission(interaction);
  if (!permissionCheck.hasPermission) {
    await interaction.reply(permissionCheck.error);
    return;
  }
  
  await interaction.deferReply();

  try {
    const sourceGuild = client.services.userClient.getSourceGuild(interaction.guild.id);

    if (!sourceGuild) {
      await interaction.editReply('❌ Configuration serveur source manquante. Vérifiez SERVER_ID dans les variables d\'environnement Coolify.');
      return;
    }

    const categoryId = interaction.options.getString('category_id');
    
    // Trouver la catégorie sur le serveur mirror par ID
    const targetCategory = interaction.guild.channels.cache.get(categoryId);
    
    if (!targetCategory) {
      await interaction.editReply(`❌ **Catégorie avec l'ID "${categoryId}" non trouvée sur ce serveur.**\n\n💡 Vérifiez l'ID de la catégorie ou utilisez \`/listroom\` pour voir les catégories disponibles.`);
      return;
    }
    
    if (targetCategory.type !== 4) {
      await interaction.editReply(`❌ **L'ID "${categoryId}" ne correspond pas à une catégorie.**\n\n💡 Assurez-vous de donner l'ID d'une catégorie, pas d'un salon.`);
      return;
    }
    
    // Récupérer tous les salons de cette catégorie
    const channelsInCategory = interaction.guild.channels.cache.filter(
      ch => ch.parentId === targetCategory.id
    );
    
    const channelCount = channelsInCategory.size;
    
    // 🆕 GESTION DES CATÉGORIES VIDES
    if (channelCount === 0) {
      await interaction.editReply(
        `⚠️ **Catégorie vide détectée**\n\n` +
        `📁 **Catégorie :** ${targetCategory.name}\n` +
        `📊 **Salons :** Aucun salon dans cette catégorie\n\n` +
        `✅ **Suppression et marquage en cours...**`
      );
      
      try {
        // 🆕 MARQUER LA CATÉGORIE COMME SUPPRIMÉE MANUELLEMENT
        const Category = require('./models/Category');
        const sourceGuild = client.services.userClient.getSourceGuild(interaction.guild.id);
        
        // Créer ou mettre à jour l'entrée de catégorie
        let categoryDB = await Category.findOne({
          name: targetCategory.name,
          serverId: sourceGuild.id
        });
        
        if (!categoryDB) {
          categoryDB = new Category({
            discordId: targetCategory.id,
            serverId: sourceGuild.id,
            name: targetCategory.name,
            manuallyDeleted: true,
            deletedAt: new Date(),
            deletedReason: `Catégorie vide supprimée par ${interaction.user.tag}`,
            deletedBy: interaction.user.tag
          });
        } else {
          categoryDB.manuallyDeleted = true;
          categoryDB.deletedAt = new Date();
          categoryDB.deletedReason = `Catégorie vide supprimée par ${interaction.user.tag}`;
          categoryDB.deletedBy = interaction.user.tag;
        }
        
        await categoryDB.save();
        
        // Supprimer la catégorie Discord
        await targetCategory.delete(`Catégorie vide supprimée par ${interaction.user.tag}`);
        
        // Logger l'action
        await client.services.logger.logAdminAction(
          interaction.guild.id,
          `🗑️ Catégorie vide "${targetCategory.name}" supprimée par ${interaction.user.tag}\n` +
          `🏷️ Marquée pour éviter recréation automatique\n` +
          `📊 0 salons supprimés`
        );
        
        await interaction.editReply(
          `✅ **Catégorie vide supprimée avec succès !**\n\n` +
          `🗑️ **Catégorie supprimée :** ${targetCategory.name}\n` +
          `🏷️ **Marquage :** Catégorie marquée en base de données\n` +
          `🛡️ **Auto-discovery :** Ne recrééra pas cette catégorie automatiquement\n` +
          `🔄 **Réactivation :** Utilisez \`/undelete\` si besoin\n\n` +
          `💡 **Astuce :** Cette catégorie ne sera plus recréée lors de l'auto-discovery quotidienne !`
        );
        
        return;
        
      } catch (error) {
        console.error(`❌ Erreur suppression catégorie vide ${targetCategory.name}:`, error);
        await interaction.editReply(`❌ **Erreur lors de la suppression :** ${error.message}`);
        return;
      }
    }
    
    await interaction.editReply(
      `⚠️ **ATTENTION - Suppression de catégorie**\n\n` +
      `🗑️ **Catégorie :** ${targetCategory.name}\n` +
      `📊 **Salons à supprimer :** ${channelCount}\n` +
      `📋 **Salons concernés :**\n${channelsInCategory.map(ch => `• #${ch.name}`).join('\n').substring(0, 800)}\n\n` +
      `🚨 **Cette action est IRRÉVERSIBLE !**\n` +
      `🧹 La base de données sera automatiquement nettoyée.\n\n` +
      `✅ **Suppression en cours...**`
    );
    
    let deletedChannels = 0;
    let deletedFromDB = 0;
    let stoppedIntervals = 0;
    
    // Supprimer tous les salons de la catégorie
    for (const channel of channelsInCategory.values()) {
      try {
        // 🏷️ MÉTHODE 2 : Marquer comme supprimé manuellement au lieu de supprimer de la base
        const Channel = require('./models/Channel');
        const channelDB = await Channel.findOne({ discordId: channel.id });
        
        if (channelDB) {
          // Marquer comme supprimé manuellement plutôt que supprimer de la base
          channelDB.manuallyDeleted = true;
          channelDB.deletedAt = new Date();
          channelDB.deletedReason = `Suppression catégorie "${targetCategory.name}" par ${interaction.user.tag}`;
          channelDB.scraped = false; // Arrêter le scraping
          await channelDB.save();
          
          deletedFromDB++;
        } else {
        }
        
        // Supprimer le salon Discord
        await channel.delete(`Suppression catégorie ${targetCategory.name} par ${interaction.user.tag}`);
        deletedChannels++;
        
        
        // Petit délai pour éviter le rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
        
      } catch (error) {
        console.error(`❌ Erreur suppression salon ${channel.name}:`, error);
        
        await client.services.logger.logError(
          interaction.guild.id,
          `Erreur suppression salon ${channel.name} (catégorie ${targetCategory.name}): ${error.message}`
        );
      }
    }
    
    // 🆕 MARQUER LA CATÉGORIE COMME SUPPRIMÉE MANUELLEMENT
    try {
      const Category = require('./models/Category');
      
      // Créer ou mettre à jour l'entrée de catégorie
      let categoryDB = await Category.findOne({
        name: targetCategory.name,
        serverId: sourceGuild.id
      });
      
      if (!categoryDB) {
        categoryDB = new Category({
          discordId: targetCategory.id,
          serverId: sourceGuild.id,
          name: targetCategory.name,
          manuallyDeleted: true,
          deletedAt: new Date(),
          deletedReason: `Catégorie + ${deletedChannels} salons supprimés par ${interaction.user.tag}`,
          deletedBy: interaction.user.tag
        });
      } else {
        categoryDB.manuallyDeleted = true;
        categoryDB.deletedAt = new Date();
        categoryDB.deletedReason = `Catégorie + ${deletedChannels} salons supprimés par ${interaction.user.tag}`;
        categoryDB.deletedBy = interaction.user.tag;
      }
      
      await categoryDB.save();
    } catch (error) {
      console.error(`❌ Erreur marquage catégorie ${targetCategory.name}:`, error);
    }
    
    // Supprimer la catégorie elle-même
    try {
      await targetCategory.delete(`Suppression catégorie par ${interaction.user.tag}`);
    } catch (error) {
      console.error(`❌ Erreur suppression catégorie ${targetCategory.name}:`, error);
    }
    
    // Logger l'action globale
    await client.services.logger.logCategoryDeletion(
      interaction.guild.id,
      targetCategory.name,
      deletedChannels,
      deletedFromDB,
      stoppedIntervals,
      interaction.user.tag
    );
    
    await client.services.logger.logAdminAction(
      interaction.guild.id,
      `🗑️ Catégorie "${targetCategory.name}" supprimée par ${interaction.user.tag}\n` +
      `📊 ${deletedChannels} salons supprimés automatiquement\n` +
      `🏷️ ${deletedFromDB} salons marqués pour éviter recréation auto`
    );
    
    // Réponse finale
    let response = `✅ **Suppression de catégorie terminée !**\n\n`;
    response += `🗑️ **Catégorie supprimée :** ${targetCategory.name}\n`;
    response += `📊 **Salons supprimés :** ${deletedChannels}/${channelCount}\n`;
    response += `🏷️ **Salons marqués :** ${deletedFromDB} (évite recréation auto)\n`;
    
    if (stoppedIntervals > 0) {
      response += `⏹️ **Intervals arrêtés :** ${stoppedIntervals} délais personnalisés\n`;
    }
    
    response += `\n🎯 **Résultat :** Catégorie supprimée, salons marqués intelligemment\n`;
    response += `🛡️ **Auto-discovery :** Ne recrééra pas ces salons automatiquement\n`;
    response += `🔄 **Réactivation :** Utilisez \`/undelete\` si besoin\n\n`;
    response += `💡 **Astuce :** Utilisez \`/listroom\` pour voir les catégories restantes`;
    
    await sendLongResponse(interaction, response);
    
  } catch (error) {
    console.log('❌ Suppression catégorie: Échec');
    await interaction.editReply(`❌ **Erreur:** ${error.message}`);
  }
}

// 📊 TABLEAU DE BORD EN TEMPS RÉEL DU SYSTÈME MIRROR
// 📊 FONCTION UTILITAIRE POUR GÉNÉRER UN GRAPHIQUE D'ACTIVITÉ
function generateActivityBar(messagesPerHour) {
  const maxWidth = 40;
  const maxMessages = Math.max(messagesPerHour, 10); // Au moins 10 pour la scale
  const barWidth = Math.round((messagesPerHour / maxMessages) * maxWidth);

  const filled = '█'.repeat(barWidth);
  const empty = '░'.repeat(maxWidth - barWidth);

  return `${messagesPerHour.toString().padStart(3, ' ')} msg/h |${filled}${empty}| ${maxMessages} max`;
}

// 🔍 COMMANDE CHECK-CONFIG - Debug de la configuration de la base de données
// 🔄 COMMANDE REFRESH-COMMANDS - Forcer le redéploiement des commandes
// Ajouter les handlers manquants (listroom, addroom, etc.)
// Fonction utilitaire pour détecter les salons inactifs (basée sur le nom)
function isChannelInactive(channel) {
  const inactiveKeywords = ['archived', 'old', 'inactive', 'deprecated', 'legacy', 'unused'];
  return inactiveKeywords.some(keyword => channel.name.toLowerCase().includes(keyword));
}

// 🆕 Fonction pour détecter les catégories à ignorer (anti rate-limit)
function shouldIgnoreCategory(categoryName, channelName) {
  if (!categoryName && !channelName) return false;
  
  // Catégories à ignorer par défaut (peu d'activité) - DÉSACTIVÉ TEMPORAIREMENT
  const ignoredCategories = [
    // 'archive', 'archives', 'archivé', 'archivés',
    // 'old', 'ancien', 'anciens', 'ancienne',
    // 'inactive', 'inactif', 'inactifs', 'inactives',
    // 'backup', 'sauvegarde', 'sauvegardes', 'bck',
    // 'logs', 'log', 'journaux', 'journal',
    // 'modération', 'moderation', 'modo', 'mod',
    // 'staff', 'équipe', 'admin', 'administration',
    // 'test', 'tests', 'testing', 'debug',
    // 'private', 'privé', 'privés', 'privées',
    // 'vip', 'premium', 'donateur', 'donateurs',
    // 'ticket', 'closed', 'cancel', 'nouveau',
    // 'market', 'wtb', 'wts', 'ventes',
    // 'developper', 'partenaire', 'fnf', 'helper',
    // 'parloir', 'check', 'legit',
    // 'feedback', 'dashboard', 'retailers', 'support',
    // 'authentication', 'on demand'
  ];
  
  // Salons spécifiques à ignorer (peu d'activité) - DÉSACTIVÉ TEMPORAIREMENT
  const ignoredChannels = [
    // 'règlement', 'reglement', 'rules', 'règles', 'regle',
    // 'welcome', 'bienvenue', 'accueil',
    // 'logs', 'log', 'audit-log',
    // 'bot-commands', 'commandes', 'commands',
    // 'musique', 'music', 'radio',
    // 'suggestions', 'suggestion', 'idées',
    // 'ticket', 'closed', 'webhook', 'cancel',
    // 'archive', 'nouveau', 'market', 'wtb', 'wts',
    // 'backup', 'debut', 'bck', 'admin', 'staff',
    // 'talk', 'developper', 'moderation', 'partenaire',
    // 'fnf', 'helper', 'parloir',
    // 'ventes', 'check', 'legit', 'feedback',
    // 'dashboard', 'retailers', 'support',
    // 'authentication'
  ];
  
  // Vérifier si la catégorie doit être ignorée
  if (categoryName) {
    const categoryLower = categoryName.toLowerCase();
    if (ignoredCategories.some(ignored => categoryLower.includes(ignored))) {
      return true;
    }
  }
  
  // Vérifier si le salon spécifique doit être ignoré
  if (channelName) {
    const channelLower = channelName.toLowerCase();
    if (ignoredChannels.some(ignored => channelLower.includes(ignored))) {
      return true;
    }
  }
  
  return false;
}

// 🆕 Fonction pour filtrer les salons selon les catégories autorisées
function filterChannelsForScraping(sourceChannels, allChannels, customDelayChannelIds = new Set()) {
  const filteredChannels = [];
  let ignoredCount = 0;
  
  for (const channel of sourceChannels) {
    // Obtenir le nom de la catégorie parent
    let categoryName = null;
    if (channel.parent_id) {
      const parentCategory = allChannels.find(c => c.id === channel.parent_id && c.type === 4);
      categoryName = parentCategory ? parentCategory.name : null;
    }
    
    // Vérifier si ce salon/catégorie doit être ignoré
    if (shouldIgnoreCategory(categoryName, channel.name)) {
      // 🎯 NE PAS afficher "ignoré" pour les salons avec délai personnalisé
      if (!customDelayChannelIds.has(channel.id)) {
      ignoredCount++;
      }
      continue;
    }
    
    filteredChannels.push(channel);
  }
  
  if (ignoredCount > 0) {
  }
  
  return filteredChannels;
}

async function handleAddRoom(interaction) {
  const permissionCheck = checkAdminPermission(interaction);
  if (!permissionCheck.hasPermission) {
    await interaction.reply(permissionCheck.error);
    return;
  }
  
  await interaction.deferReply();

  try {
    const sourceGuild = client.services.userClient.getSourceGuild(interaction.guild.id);

    if (!sourceGuild) {
      await interaction.editReply('❌ Configuration serveur source manquante. Vérifiez SERVER_ID dans les variables d\'environnement Coolify.');
      return;
    }

    const channelId = interaction.options.getString('channel_id');
    const Channel = require('./models/Channel');

    // Récupérer les données du token utilisateur
    const userData = client.services.userClient.getUserData(interaction.guild.id);

    // Récupérer les salons du serveur source via API (pas de threads via fetchGuildThreads car endpoint bot-only)
    const sourceChannels = await client.services.userClient.fetchGuildChannels(userData.token, sourceGuild.id);
    
    // 🧵 THREADS SPÉCIAUX : Vérifier si l'ID est directement un thread
    let potentialThread = null;
    if (!sourceChannels.find(ch => ch.id === channelId)) {
      try {
        // Essayer de récupérer directement le thread par son ID
        potentialThread = await client.services.userClient.fetchThreadById(userData.token, channelId);
        if (potentialThread && (potentialThread.type === 11 || potentialThread.type === 12)) {
        } else {
          potentialThread = null; // Reset si ce n'est pas un thread
        }
      } catch (error) {
        potentialThread = null;
      }
    }
    
    const allSourceChannels = potentialThread ? [...sourceChannels, potentialThread] : sourceChannels;
    
    // 🎯 DÉTECTER SI L'ID PROVIENT DU SERVEUR SOURCE OU MIRROR
    let sourceChannel = null;
    let isSourceId = false;
    let isMirrorId = false;
    
    // 1. Essayer de trouver par ID source (salons + threads)
    sourceChannel = allSourceChannels.find(ch => ch.id === channelId);
    if (sourceChannel) {
      isSourceId = true;
    } else {
      // 2. Essayer de trouver par ID mirror (chercher le salon mirror puis son équivalent source)
      const mirrorChannel = interaction.guild.channels.cache.get(channelId);
      if (mirrorChannel) {
        sourceChannel = allSourceChannels.find(ch => ch.name === mirrorChannel.name);
        if (sourceChannel) {
          isMirrorId = true;
        }
      }
    }
    
    if (!sourceChannel) {
      await interaction.editReply(
        `❌ **Salon avec l'ID "${channelId}" non trouvé.**\n\n` +
        `💡 **L'ID peut être :**\n` +
        `• ID d'un salon du serveur source\n` +
        `• ID d'un salon du serveur mirror\n\n` +
        `🔍 Utilisez \`/listroom\` pour voir tous les salons disponibles.`
      );
      return;
    }
    
    // 🆕 VÉRIFIER SI LE SALON EXISTE DÉJÀ SUR LE SERVEUR MIRROR
    const existingMirrorChannel = interaction.guild.channels.cache.find(ch => ch.name === sourceChannel.name);
    
    if (existingMirrorChannel) {
      // 🎯 SALON EXISTANT : Vérifier/créer l'entrée en base et supprimer le blacklist
      let channelDB = await Channel.findOne({ 
        name: sourceChannel.name,
        serverId: sourceGuild.id 
      });
      
      let wasCreatedInExisting = false;
      if (!channelDB) {
        // 🆕 AUTO-CRÉATION DE L'ENTRÉE EN BASE pour les salons/threads existants
        
        channelDB = new Channel({
          discordId: existingMirrorChannel.id,
          serverId: sourceGuild.id,
          sourceChannelId: sourceChannel.id,
          name: sourceChannel.name,
          category: existingMirrorChannel.parent?.name || null,
          scraped: false, // Sera activé juste après
          failedAttempts: 0,
          isBlacklisted: false,
          manuallyDeleted: false
        });
        
        await channelDB.save();
        wasCreatedInExisting = true;
      }
      
      if (!channelDB.isBlacklisted && !wasCreatedInExisting) {
        await interaction.editReply(`ℹ️ **Le salon #${sourceChannel.name} existe déjà et n'est pas blacklisté.**`);
        return;
      }
      
      // 🔓 SUPPRIMER LE BLACKLIST ET ACTIVER LE SCRAPING
      channelDB.isBlacklisted = false;
      channelDB.blacklistedUntil = null;
      channelDB.failedAttempts = 0;
      channelDB.lastFailedAt = null;
      channelDB.scraped = true; // 🚀 ACTIVER le scraping !
      // Mettre à jour l'ID Discord si nécessaire
      channelDB.discordId = existingMirrorChannel.id;
      channelDB.sourceChannelId = sourceChannel.id;
      await channelDB.save();
      
      
      // Logger l'action avec mention cliquable
      await client.services.logger.logNewRoom(
        targetGuild.id,
        `${wasCreatedInExisting ? '📝 Entrée créée et salon configuré' : '🔓 Blacklist supprimé'}: <#${existingMirrorChannel.id}>\n` +
        `👤 Action manuelle par: ${interaction.user.tag}\n` +
        `📊 Le salon va reprendre le scraping automatiquement`,
        wasCreatedInExisting ? 'Configuration Auto' : 'Déblocage',
        existingMirrorChannel.id
      );
      
      await client.services.logger.logAdminAction(
        targetGuild.id,
        `${wasCreatedInExisting ? '📝 Salon configuré' : '🔓 Salon débloqué'}: ${sourceChannel.name} par ${interaction.user.tag}\n` +
        `✅ Scraping réactivé automatiquement`
      );
      
      let successResponse = `✅ **Salon #${sourceChannel.name} ${wasCreatedInExisting ? 'configuré' : 'débloqué'} avec succès !**\n\n`;
      
      if (wasCreatedInExisting) {
        successResponse += `📝 **Entrée créée automatiquement** en base de données\n`;
      } else {
        successResponse += `🔓 **Blacklist supprimé** - Le salon est maintenant accessible\n`;
      }
      
      successResponse += `🆔 **ID Mirror :** ${existingMirrorChannel.id}\n` +
        `🔗 **ID Source :** ${sourceChannel.id}\n` +
        `🎯 **Type d'ID utilisé :** ${isSourceId ? 'ID Source' : 'ID Mirror'}\n\n` +
        `🎯 **Résultat :**\n` +
        `• Le scraping va reprendre automatiquement\n` +
        `• Utilisez \`/listroom\` pour voir tous les salons actifs`;
      
      await interaction.editReply(successResponse);
      return;
    }
    
    // 🆕 GESTION DU BLACKLIST - Vérifier et supprimer automatiquement
    let channelDB = await Channel.findOne({ 
      name: sourceChannel.name,
      serverId: sourceGuild.id 
    });
    
    let wasBlacklisted = false;
    let wasCreated = false;
    
    if (!channelDB) {
      // 🆕 AUTO-CRÉATION DE L'ENTRÉE EN BASE pour les nouveaux salons/threads
      
      channelDB = new Channel({
        discordId: sourceChannel.id, // Temporaire, sera mis à jour après création du salon mirror
        serverId: sourceGuild.id,
        sourceChannelId: sourceChannel.id,
        name: sourceChannel.name,
        category: null, // Sera mis à jour après création
        scraped: false, // Sera activé après création
        failedAttempts: 0,
        isBlacklisted: false,
        manuallyDeleted: false
      });
      
      await channelDB.save();
      wasCreated = true;
    } else if (channelDB.isBlacklisted) {
      // 🎯 SUPPRIMER LE BLACKLIST AUTOMATIQUEMENT
      channelDB.isBlacklisted = false;
      channelDB.blacklistedUntil = null;
      channelDB.failedAttempts = 0;
      channelDB.lastFailedAt = null;
      await channelDB.save();
      
      wasBlacklisted = true;
    }
    
    // Créer le salon sur le serveur mirror
    const targetGuild = interaction.guild;
    
    // Créer la catégorie si nécessaire
    let targetCategory = null;
    if (sourceChannel.parent_id) {
      const sourceCategory = sourceChannels.find(c => c.id === sourceChannel.parent_id && c.type === 4);
      if (sourceCategory) {
        targetCategory = targetGuild.channels.cache.find(
          channel => channel.type === 4 && channel.name === sourceCategory.name
        );
        
        if (!targetCategory) {
          const { resolveCategoryNameConflict } = require('./utils/nameConflict');
          const categoryName = await resolveCategoryNameConflict(targetGuild, sourceCategory.name);
          targetCategory = await targetGuild.channels.create({
            name: categoryName,
            type: 4
          });
        }
      }
    }
    
    // Créer le salon/thread Discord
    let newChannel;
    
    // 🧵 GESTION SPÉCIALE POUR LES THREADS
    if (sourceChannel.type === 11 || sourceChannel.type === 12) {
      // Pour les threads, on doit trouver le salon parent sur le mirror
      let parentChannel = null;
      if (sourceChannel.parent_id) {
        parentChannel = targetGuild.channels.cache.find(ch => {
          // Chercher par nom du parent sur la source
          const sourceParent = allSourceChannels.find(sc => sc.id === sourceChannel.parent_id);
          return sourceParent && ch.name === sourceParent.name;
        });
      }
      
      if (!parentChannel) {
        await interaction.editReply(`❌ **Impossible de créer le thread ${sourceChannel.name}**\n\n⚠️ **Salon parent introuvable** sur le serveur mirror.\n\nPour créer un thread, le salon parent doit exister sur le serveur mirror.`);
        return;
      }
      
      // Créer le thread sur le salon parent mirror
      const threadOptions = {
        name: sourceChannel.name,
        autoArchiveDuration: sourceChannel.thread_metadata?.auto_archive_duration || 1440,
        type: sourceChannel.type === 11 ? 'PUBLIC_THREAD' : 'PRIVATE_THREAD',
        reason: `Thread ajouté manuellement: ${sourceChannel.name} par ${interaction.user.tag}`
      };
      
      // Pour créer un thread, on a besoin d'un message de départ
      const startMessage = await parentChannel.send(`🧵 **Thread ajouté manuellement**: ${sourceChannel.name}\n\n*Ce thread a été ajouté manuellement par ${interaction.user.tag} pour mirrorer le contenu du serveur source.*`);
      
      newChannel = await startMessage.startThread(threadOptions);
      
    } else {
      // 📺 SALONS CLASSIQUES : Traitement normal
      let channelOptions;

      // 📢 GESTION SPÉCIALE POUR LES SALONS D'ANNONCES (type 5)
      if (sourceChannel.type === 5) {
        const { ChannelType } = require('discord.js');

        channelOptions = {
          name: sourceChannel.name,
          type: ChannelType.GuildAnnouncement, // 5
          topic: sourceChannel.topic || undefined,
          parent: targetCategory?.id || null,
          position: sourceChannel.position
        };

      }
      // 🏛️ GESTION SPÉCIALE POUR LES SALONS FORUM (type 15)
      else if (sourceChannel.type === 15) {
          const { ChannelType } = require('discord.js');

          channelOptions = {
            name: sourceChannel.name,
            type: ChannelType.GuildForum, // 15
            topic: sourceChannel.topic || undefined, // undefined plutôt que null
            parent: targetCategory?.id || null,
            position: sourceChannel.position, // Synchroniser la position du forum
            // Propriétés OBLIGATOIRES pour les forums Discord.js v14
            defaultAutoArchiveDuration: 1440, // 24 heures (obligatoire)
            // NE PAS utiliser rateLimitPerUser pour les forums - cette propriété n'existe pas pour ce type
            availableTags: [] // Tags disponibles (obligatoire, même vide)
          };
          
        } else {
          channelOptions = {
      name: sourceChannel.name,
      type: sourceChannel.type,
      topic: sourceChannel.topic || null,
      parent: targetCategory?.id || null,
      position: sourceChannel.position // Synchroniser la position
    };

    // Paramètres spécifiques aux salons vocaux
    if (sourceChannel.type === 2) {
      channelOptions.bitrate = sourceChannel.bitrate || 64000;
      channelOptions.userLimit = sourceChannel.user_limit || 0;
          }
        }
      
      try {
        newChannel = await targetGuild.channels.create(channelOptions);
        
        // ✅ SUCCÈS - Logger si c'était un forum
        if (sourceChannel.type === 15) {
        }
        
      } catch (createError) {
        // 📢 GESTION SPÉCIFIQUE ERREUR SALON D'ANNONCES
        if (sourceChannel.type === 5) {
          console.error(`❌ ERREUR CRÉATION SALON D'ANNONCES (handleAddRoom): ${sourceChannel.name}`);
          console.error(`   Code erreur: ${createError.code}`);
          console.error(`   Message: ${createError.message}`);

          // Si le serveur ne supporte pas les salons d'annonces, créer comme salon texte
          if (createError.code === 50035 || createError.message.includes('COMMUNITY_SERVER_ONLY')) {

            const fallbackOptions = {
              name: sourceChannel.name,
              type: 0, // Salon texte
              topic: `📢 [Salon d'annonces] ${sourceChannel.topic || ''}`,
              parent: targetCategory?.id || null
            };

            newChannel = await targetGuild.channels.create(fallbackOptions);
          } else {
            throw createError;
          }
        }
        // 🏛️ GESTION SPÉCIFIQUE ERREUR FORUM avec diagnostic détaillé
        else if (sourceChannel.type === 15) {
          console.error(`❌ ERREUR CRÉATION FORUM (handleAddRoom): ${sourceChannel.name}`);
          console.error(`   Code erreur: ${createError.code}`);
          console.error(`   Message: ${createError.message}`);
          console.error(`   Propriétés utilisées:`, JSON.stringify(channelOptions, null, 2));
          
          // Logger l'erreur détaillée pour investigation
          await client.services.logger.logAdminAction(
            targetGuild.id,
            `❌ **ÉCHEC CRÉATION FORUM (handleAddRoom)**\n` +
            `📛 Forum: \`${sourceChannel.name}\`\n` +
            `❌ Code: \`${createError.code}\`\n` +
            `💬 Message: \`${createError.message}\`\n` +
            `🔧 Propriétés: \`${JSON.stringify(channelOptions)}\`\n` +
            `💡 **ACTION REQUISE:** Vérifier les permissions et la configuration du serveur`
          );
          
          // NE PAS faire de fallback automatique - laisser échouer pour investigation
          throw new Error(`Création forum échouée pour ${sourceChannel.name}: ${createError.message} (Code: ${createError.code})`);
        } else {
          // Re-lancer l'erreur pour les autres types de salons
          throw createError;
        }
      }
    }
    
    // Créer ou mettre à jour l'entrée en base de données
    if (!channelDB) {
      channelDB = new Channel({
        discordId: newChannel.id,
        serverId: sourceGuild.id,
        sourceChannelId: sourceChannel.id,
        name: sourceChannel.name,
        category: targetCategory?.name || null,
        scraped: true, // 🚀 ACTIVER automatiquement le scraping !
        failedAttempts: 0,
        isBlacklisted: false
      });
    } else {
      // Mettre à jour l'ID Discord du salon mirror
      channelDB.discordId = newChannel.id;
      channelDB.sourceChannelId = sourceChannel.id;
      channelDB.category = targetCategory?.name || null;
    }
    
    await channelDB.save();
    
    // Logger l'ajout
    const isThread = sourceChannel.type === 11 || sourceChannel.type === 12;
    const channelTypeText = isThread ? 'Thread' : 'Salon';
    const locationText = isThread ? `Salon parent: ${newChannel.parent?.name || 'Inconnu'}` : `Catégorie: ${targetCategory?.name || 'Aucune'}`;
    
    await client.services.logger.logNewRoom(
      targetGuild.id,
      `✅ ${channelTypeText} ajouté manuellement: ${isThread ? '🧵 ' : ''}<#${newChannel.id}>${wasBlacklisted ? ' (blacklist supprimé)' : ''}\n` +
      `📁 ${locationText}\n` +
      `👤 Ajouté par: ${interaction.user.tag}`,
      'Ajout Manuel',
      newChannel.id
    );
    
    // Logger dans #admin-logs
    await client.services.logger.logAdminAction(
      targetGuild.id,
      `✅ ${channelTypeText} ajouté: ${isThread ? '🧵 ' : ''}${newChannel.name} par ${interaction.user.tag}${wasBlacklisted ? '\n🔓 Blacklist automatiquement supprimé' : ''}`
    );
    
    // Construire la réponse
    let response = `✅ **${channelTypeText} ${isThread ? '🧵 ' : '#'}${newChannel.name} ajouté avec succès !**\n\n`;
    response += `📁 **${isThread ? 'Salon parent' : 'Catégorie'} :** ${isThread ? (newChannel.parent?.name || 'Inconnu') : (targetCategory?.name || 'Aucune')}\n`;
    response += `🆔 **ID Mirror :** ${newChannel.id}\n`;
    response += `🔗 **ID Source :** ${sourceChannel.id}\n`;
    response += `🎯 **Type d'ID utilisé :** ${isSourceId ? 'ID Source' : 'ID Mirror'}\n`;
    
    if (isThread) {
      response += `🧵 **Type de thread :** ${sourceChannel.type === 11 ? 'Public' : 'Privé'}\n`;
    }
    
    if (wasBlacklisted) {
      response += `\n🔓 **Blacklist automatiquement supprimé** - Le salon est maintenant accessible\n`;
    }
    
    if (wasCreated) {
      response += `\n📝 **Entrée créée automatiquement** en base de données\n`;
    }
    
    response += `\n🎯 **Prochaines étapes :**\n`;
    response += `• Le salon sera automatiquement inclus dans le scraping\n`;
    response += `• Utilisez \`/listroom\` pour voir tous les salons actifs`;
    
    await interaction.editReply(response);
    
  } catch (error) {
    console.error('❌ Erreur handleAddRoom:', error);
    await interaction.editReply(`❌ **Erreur:** ${error.message}`);
  }
}

async function handleDelRoom(interaction) {
  const permissionCheck = checkAdminPermission(interaction);
  if (!permissionCheck.hasPermission) {
    await interaction.reply(permissionCheck.error);
    return;
  }
  
  await interaction.deferReply();
  
  try {
    const channelName = interaction.options.getString('channel_name');
    await client.services.channelManager.removeChannel(interaction.guild, channelName);
    
    await interaction.editReply(`✅ Salon **${channelName}** supprimé avec succès !`);
  } catch (error) {
    await interaction.editReply(`❌ Erreur: ${error.message}`);
  }
}

// 🔗 TRAITER LES MENTIONS DE SALONS SOURCE VERS MIRROR POUR /seeroom
async function processChannelMentionsInSeeroom(content, sourceGuild, targetGuild) {
  if (!content || !content.includes('<#')) {
    return content;
  }
  
  try {
    const channelMentionRegex = /<#(\d+)>/g;
    let processedContent = content;
    
    // Utiliser le correspondenceManager pour les conversions
    const CorrespondenceManager = require('./services/correspondenceManager');
    const correspondenceManager = new CorrespondenceManager(client, client.services.logger);
    
    const matches = content.matchAll(channelMentionRegex);
    for (const match of matches) {
      try {
        const sourceChannelId = match[1];
        
        // Utiliser le système de correspondance pour trouver l'ID mirror
        const mirrorChannelId = await correspondenceManager.getMirrorChannelId(
          sourceChannelId,
          sourceGuild.id,
          targetGuild.id
        );
        
        if (mirrorChannelId) {
          // Remplacer l'ID source par l'ID mirror
          processedContent = processedContent.replace(match[0], `<#${mirrorChannelId}>`);
          continue;
        }
        
        // Pas de correspondance trouvée, essayer de trouver par recherche dans la base de données
        const Channel = require('./models/Channel');
        const channelDB = await Channel.findOne({
          sourceChannelId: sourceChannelId,
          serverId: sourceGuild.id
        });
        
        if (channelDB && channelDB.discordId) {
          // Vérifier que le salon mirror existe toujours
          const mirrorChannel = targetGuild.channels.cache.get(channelDB.discordId);
          if (mirrorChannel) {
            processedContent = processedContent.replace(match[0], `<#${channelDB.discordId}>`);
            
            // 🔇 NE PAS enregistrer automatiquement pour éviter les logs "Correspondance salon enregistrée" en double
            // La correspondance existe déjà en base, pas besoin de l'enregistrer à nouveau
            continue;
          }
        }
        
        // Aucune correspondance trouvée - Utiliser le nom en dur du salon
        let channelDisplayName = 'salon-introuvable';
        
        // Essayer de récupérer le nom du salon depuis la base ou l'API
        if (channelDB && channelDB.name) {
          channelDisplayName = channelDB.name;
        } else {
          // Essayer de récupérer le nom depuis le serveur source
          try {
            const userData = client.services.userClient?.getUserData?.(targetGuild.id);
            if (userData) {
              const sourceChannels = await client.services.userClient.fetchGuildChannels(userData.token, sourceGuild.id);
              const sourceChannel = sourceChannels.find(ch => ch.id === sourceChannelId);
              if (sourceChannel) {
                channelDisplayName = sourceChannel.name;
              }
            }
          } catch (fetchError) {
          }
        }
        
        // Remplacer par le nom en dur au lieu de l'ID
        processedContent = processedContent.replace(match[0], `**#${channelDisplayName}**`);
        
      } catch (error) {
        console.error(`❌ Erreur traitement mention salon ${match[1]}:`, error.message);
        // En cas d'erreur, garder la mention originale
      }
    }
    
    return processedContent;
    
  } catch (error) {
    console.error('❌ Erreur processChannelMentionsInSeeroom:', error);
    // En cas d'erreur générale, retourner le contenu original
    return content;
  }
}

// 🚀 ACTIVATION EN MASSE DE TOUS LES SALONS
// 🚫 GESTION DE LA BLACKLIST DES SALONS
async function handleBlacklist(interaction) {
  const permissionCheck = checkAdminPermission(interaction);
  if (!permissionCheck.hasPermission) {
    await interaction.reply(permissionCheck.error);
    return;
  }

  await interaction.deferReply();

  try {
    const sourceGuild = client.services.userClient.getSourceGuild(interaction.guild.id);

    if (!sourceGuild) {
      await interaction.editReply('❌ Configuration serveur source manquante. Vérifiez SERVER_ID dans les variables d\'environnement Coolify.');
      return;
    }
    const Channel = require('./models/Channel');
    const action = interaction.options.getString('action');
    const channelName = interaction.options.getString('channel_name');

    switch (action) {
      case 'list':
        // Afficher la liste des salons blacklistés
        const blacklistedChannels = await Channel.find({
          serverId: sourceGuild.id,
          isBlacklisted: true
        }).sort({ blacklistedUntil: -1 });

        if (blacklistedChannels.length === 0) {
          await interaction.editReply('✅ **Aucun salon blacklisté !**\n\n🎯 Tous les salons sont accessibles pour le scraping.');
          return;
        }

        let listResponse = `🚫 **Salons blacklistés (${blacklistedChannels.length}):**\n\n`;
        
        for (const channel of blacklistedChannels) {
          const timeLeft = channel.blacklistedUntil ? 
            Math.max(0, Math.ceil((channel.blacklistedUntil - new Date()) / (1000 * 60))) : 0;
          
          listResponse += `📂 **#${channel.name}**\n`;
          listResponse += `   ❌ Échecs: ${channel.failedAttempts || 0}\n`;
          if (timeLeft > 0) {
            listResponse += `   ⏰ Réactivation: ${Math.floor(timeLeft / 60)}h${timeLeft % 60}min\n`;
          } else {
            listResponse += `   ⏰ Réactivation: **Maintenant** (sera réactivé au prochain cycle)\n`;
          }
          listResponse += `\n`;
        }

        listResponse += `💡 **Actions possibles:**\n`;
        listResponse += `• \`/blacklist action:remove channel_name:SALON\` - Débloquer un salon\n`;
        listResponse += `• \`/blacklist action:clear\` - Nettoyer toute la blacklist\n`;
        listResponse += `• \`/cleanup include_blacklisted:true\` - Alternative pour tout nettoyer`;

        await interaction.editReply(listResponse);
        break;

      case 'remove':
        if (!channelName) {
          await interaction.editReply('❌ **Nom du salon requis !**\n\nUtilisez: `/blacklist action:remove channel_name:NOM_DU_SALON`');
          return;
        }

        const channelToRemove = await Channel.findOne({
          name: channelName,
          serverId: sourceGuild.id,
          isBlacklisted: true
        });

        if (!channelToRemove) {
          await interaction.editReply(`❌ **Salon non trouvé dans la blacklist !**\n\n🔍 Salon: \`${channelName}\`\n💡 Utilisez \`/blacklist action:list\` pour voir les salons blacklistés`);
          return;
        }

        // Supprimer de la blacklist
        channelToRemove.isBlacklisted = false;
        channelToRemove.blacklistedUntil = null;
        channelToRemove.failedAttempts = 0;
        channelToRemove.lastFailedAt = null;
        await channelToRemove.save();

        await interaction.editReply(`✅ **Salon débloqué !**\n\n📂 **#${channelName}** a été retiré de la blacklist\n⚡ Le scraping va reprendre automatiquement`);

        // Logger l'action
        await client.services.logger.logAdminAction(
          interaction.guild.id,
          `🔓 Salon débloqué manuellement: #${channelName} par ${interaction.user.tag}`
        );
        break;

      case 'add':
        if (!channelName) {
          await interaction.editReply('❌ **Nom du salon requis !**\n\nUtilisez: `/blacklist action:add channel_name:NOM_DU_SALON`');
          return;
        }

        const channelToAdd = await Channel.findOne({
          name: channelName,
          serverId: sourceGuild.id
        });

        if (!channelToAdd) {
          await interaction.editReply(`❌ **Salon non trouvé !**\n\n🔍 Salon: \`${channelName}\`\n💡 Le salon doit exister en base de données d'abord`);
          return;
        }

        if (channelToAdd.isBlacklisted) {
          await interaction.editReply(`⚠️ **Salon déjà blacklisté !**\n\n📂 **#${channelName}** est déjà dans la blacklist`);
          return;
        }

        // Ajouter à la blacklist
        channelToAdd.isBlacklisted = true;
        channelToAdd.blacklistedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h
        channelToAdd.failedAttempts = 2; // Marquer comme ayant échoué
        channelToAdd.lastFailedAt = new Date();
        await channelToAdd.save();

        await interaction.editReply(`🚫 **Salon blacklisté !**\n\n📂 **#${channelName}** a été ajouté à la blacklist\n⏰ Réactivation automatique: 24h`);

        // Logger l'action
        await client.services.logger.logAdminAction(
          interaction.guild.id,
          `🚫 Salon blacklisté manuellement: #${channelName} par ${interaction.user.tag}`
        );
        break;

      case 'clear':
        const result = await Channel.updateMany(
          {
            serverId: sourceGuild.id,
            isBlacklisted: true
          },
          {
            $set: {
              isBlacklisted: false,
              blacklistedUntil: null,
              failedAttempts: 0,
              lastFailedAt: null
            }
          }
        );

        if (result.modifiedCount === 0) {
          await interaction.editReply('✅ **Blacklist déjà vide !**\n\n🎯 Aucun salon n\'était blacklisté');
          return;
        }

        await interaction.editReply(`✅ **Blacklist nettoyée !**\n\n🔓 **${result.modifiedCount} salon(s)** débloqué(s)\n⚡ Le scraping va reprendre sur tous les salons`);

        // Logger l'action
        await client.services.logger.logAdminAction(
          interaction.guild.id,
          `🔄 Blacklist complète nettoyée: ${result.modifiedCount} salons débloqués par ${interaction.user.tag}`
        );
        break;

      default:
        await interaction.editReply('❌ Action non reconnue.');
    }

  } catch (error) {
    console.log('❌ Blacklist: Échec');
    await interaction.editReply(`❌ Erreur: ${error.message}`);
  }
}

// 🚀 NOUVELLES STATISTIQUES ÉVÉNEMENTIELLES
async function handleEventStats(interaction) {
  const permissionCheck = checkAdminPermission(interaction);
  if (!permissionCheck.hasPermission) {
    await interaction.reply(permissionCheck.error);
    return;
  }

  await interaction.deferReply();

  try {
    // Obtenir les statistiques des événements
    const eventStats = client.services.scraper.getEventStats();
    const userEventStats = client.services.userClient.getEventStats();
    
    let response = `📊 **Statistiques du Système Événementiel**\n\n`;
    
    // État du système
    if (eventStats.isEventBased) {
      response += `✅ **Mode événementiel ACTIF**\n`;
      response += `⚡ Messages mirroirés en temps réel\n`;
      response += `🚀 Comme Examples code - Zero rate limits\n\n`;
    } else {
      response += `❌ **Mode polling classique**\n`;
      response += `🔄 Utilise encore les anciens délais\n`;
      response += `💡 Utilisez \`/start\` pour activer le mode événementiel\n\n`;
    }
    
    // Statistiques des messages
    if (eventStats.isEventBased) {
      response += `📈 **Messages traités :**\n`;
      response += `• ⚡ Temps réel : ${eventStats.totalEventMessages}\n\n`;
      
      if (eventStats.lastEventTime) {
        response += `• 🕐 Dernier événement : ${eventStats.lastEventTime.toLocaleString('fr-FR')}\n`;
      }
      response += `\n`;
    }
    
    // Statistiques des connexions WebSocket
    if (userEventStats.activeCount > 0) {
      response += `🔌 **Connexions WebSocket :**\n`;
      for (const event of userEventStats.events) {
        const pingDisplay = event.ping > 0 ? `${event.ping}ms` : 'N/A';
        response += `• ${event.selfbotTag} - ${event.status} (${pingDisplay})\n`;
      }
      response += `\n`;
    } else {
      response += `⚠️ **Aucune connexion WebSocket active**\n`;
      response += `💡 Le mode événementiel n'est pas opérationnel\n\n`;
    }
    
    // Avantages du système événementiel
    response += `✨ **Avantages du mode événementiel :**\n`;
    response += `• **Latence :** 0-2 secondes (vs 30s-3min)\n`;
    response += `• **Rate limits :** Quasi-éliminés (pattern naturel)\n`;
    response += `• **Efficacité :** Pas de requêtes sur salons vides\n`;
    response += `• **Indétectable :** Trafic comme un utilisateur normal\n`;
          response += `• **Robustesse :** Système événementiel pur\n\n`;
    
    response += `🔧 **Commandes utiles :**\n`;
    response += `• \`/start\` - Activer le mode événementiel\n`;
    response += `• \`/stop\` - Arrêter le scraping\n`;
    
    await interaction.editReply(response);
    
  } catch (error) {
    console.log('❌ EventStats: Échec');
    await interaction.editReply(`❌ Erreur: ${error.message}`);
  }
}

// 🧹 COMMANDE - NETTOYER AUTOMATIQUEMENT LES CANAUX INACTIFS
async function handleAutoclean(interaction) {
  const permissionCheck = checkAdminPermission(interaction);
  if (!permissionCheck.hasPermission) {
    await interaction.reply(permissionCheck.error);
    return;
  }

  await interaction.deferReply({ ephemeral: false });

  try {
    // Vérifications initiales
    const sourceGuild = client.services.userClient.getSourceGuild(interaction.guild.id);

    if (!sourceGuild) {
      await interaction.editReply('❌ Configuration serveur source manquante. Vérifiez SERVER_ID dans les variables d\'environnement Coolify.');
      return;
    }

    // Récupérer les options
    const days = interaction.options.getInteger('days') || 30;
    const dryRun = interaction.options.getBoolean('dry_run') || false;
    const limit = interaction.options.getInteger('limit') || 10;

    // Vérifier l'espace disponible
    const currentChannelCount = interaction.guild.channels.cache.size;
    const DISCORD_CHANNEL_LIMIT = 500;

    if (currentChannelCount < 450 && !dryRun) {
      await interaction.editReply(`ℹ️ **Espace suffisant disponible**\n\n📊 Canaux actuels: **${currentChannelCount}/500**\n✅ Espace libre: **${DISCORD_CHANNEL_LIMIT - currentChannelCount} canaux**\n\n💡 Le nettoyage n'est pas nécessaire actuellement.`);
      return;
    }

    // Récupérer les canaux de la base de données
    const Channel = require('./models/Channel');

    // D'abord nettoyer les entrées corrompues
    const corruptedCleaned = await cleanupCorruptedChannelEntries(sourceGuild.id);
    if (corruptedCleaned > 0) {
    }

    const cutoffDate = new Date(Date.now() - (days * 24 * 60 * 60 * 1000));

    // Debug: afficher les paramètres de recherche

    // Statistiques de debug pour comprendre les données
    const totalChannels = await Channel.countDocuments({ serverId: sourceGuild.id });
    const scrapedChannels = await Channel.countDocuments({ serverId: sourceGuild.id, scraped: true });
    const channelsWithActivity = await Channel.countDocuments({
      serverId: sourceGuild.id,
      lastActivity: { $exists: true, $ne: null }
    });


    // Chercher les canaux inactifs basés sur lastMessageActivity (vrais messages)
    const inactiveChannels = await Channel.find({
      serverId: sourceGuild.id,  // Utiliser la variable déjà validée
      $or: [
        { lastMessageActivity: { $lt: cutoffDate } },  // Canaux avec vieux messages
        { lastMessageActivity: null }  // Canaux qui n'ont JAMAIS eu de messages
      ],
      manuallyDeleted: false,
      isBlacklisted: false  // Utiliser le nom correct du champ: isBlacklisted
    })
      .sort({ lastMessageActivity: 1, messageCount: 1 }) // Trier par activité de messages
      .limit(limit);


    // Debug: afficher les premiers canaux trouvés
    if (inactiveChannels.length > 0) {
      inactiveChannels.slice(0, 3).forEach(ch => {
      });
    }

    if (inactiveChannels.length === 0) {
      await interaction.editReply(`✅ **Aucun canal inactif trouvé**\n\n📊 Aucun canal inactif depuis plus de **${days} jours**\n💡 Tous les canaux sont actifs ou protégés.`);
      return;
    }

    // Liste des canaux protégés
    const { isChannelProtected } = require('./utils/protectedChannels');
    const protectedChannelNames = ['admin-logs', 'mention-logs', 'chat-staff', 'roles', 'newroom', 'commands', 'errors'];

    // Filtrer les canaux protégés
    const channelsToClean = [];
    const protectedSkipped = [];

    for (const channelDB of inactiveChannels) {
      const mirrorChannel = interaction.guild.channels.cache.get(channelDB.discordId);

      if (!mirrorChannel) {
        // Canal déjà supprimé sur Discord
        continue;
      }

      // Vérifier si le canal est protégé (passer name et id, pas l'objet)
      if (isChannelProtected(mirrorChannel.name, mirrorChannel.id)) {
        protectedSkipped.push({
          name: mirrorChannel.name,
          lastMessageActivity: channelDB.lastMessageActivity,  // Utiliser lastMessageActivity
          messageCount: channelDB.messageCount || 0
        });
        continue;
      }

      channelsToClean.push({
        channel: mirrorChannel,
        dbEntry: channelDB,
        lastMessageActivity: channelDB.lastMessageActivity,  // Utiliser lastMessageActivity
        messageCount: channelDB.messageCount || 0
      });
    }

    if (channelsToClean.length === 0) {
      await interaction.editReply(`ℹ️ **Aucun canal à nettoyer**\n\n📊 ${inactiveChannels.length} canaux inactifs trouvés\n🛡️ ${protectedSkipped.length} canaux protégés ignorés\n\n💡 Tous les canaux inactifs sont protégés par le système.`);
      return;
    }

    // Mode dry-run : afficher ce qui serait supprimé
    if (dryRun) {
      let report = `🔍 **MODE SIMULATION - Canaux qui seraient supprimés**\n\n`;
      report += `📊 **Statistiques:**\n`;
      report += `• Canaux actuels: **${currentChannelCount}/500**\n`;
      report += `• Canaux à supprimer: **${channelsToClean.length}**\n`;
      report += `• Espace libéré: **${channelsToClean.length} places**\n`;
      report += `• Nouveaux canaux disponibles: **${currentChannelCount - channelsToClean.length}/500**\n\n`;

      report += `🗑️ **Canaux à supprimer (${channelsToClean.length}):**\n`;
      for (const item of channelsToClean.slice(0, 20)) { // Limiter l'affichage
        const daysSinceActivity = item.lastMessageActivity
          ? Math.floor((Date.now() - new Date(item.lastMessageActivity)) / (1000 * 60 * 60 * 24))
          : 'Jamais';
        const inactivityText = daysSinceActivity === 'Jamais' ? 'jamais actif' : `${daysSinceActivity}j d'inactivité`;
        report += `• #${item.channel.name} - ${inactivityText}, ${item.messageCount} msgs\n`;
      }

      if (channelsToClean.length > 20) {
        report += `*... et ${channelsToClean.length - 20} autres*\n`;
      }

      if (protectedSkipped.length > 0) {
        report += `\n🛡️ **Canaux protégés ignorés (${protectedSkipped.length}):**\n`;
        for (const skipped of protectedSkipped.slice(0, 10)) {
          report += `• #${skipped.name}\n`;
        }
      }

      report += `\n💡 **Pour exécuter le nettoyage:** Relancez la commande sans l'option \`dry_run\``;

      await interaction.editReply(report);
      return;
    }

    // Mode réel : supprimer les canaux
    await interaction.editReply(`🧹 **Nettoyage en cours...**\n\n⏳ Suppression de ${channelsToClean.length} canaux inactifs...`);

    let deletedCount = 0;
    let errorCount = 0;
    const errors = [];

    for (const item of channelsToClean) {
      try {
        // Supprimer le canal Discord
        await item.channel.delete(`Auto-nettoyage: inactif depuis ${days} jours`);

        // Vérifier discordId avant la sauvegarde
        if (!item.dbEntry.discordId) {
          await Channel.deleteOne({ _id: item.dbEntry._id });
          deletedCount++;
          continue; // Passer au canal suivant
        }

        // Marquer comme supprimé dans la base de données
        item.dbEntry.manuallyDeleted = true;
        item.dbEntry.deletedAt = new Date();
        item.dbEntry.deletedReason = `Auto-nettoyage: inactif depuis ${days} jours`;
        item.dbEntry.deletedBy = interaction.user.id;
        await item.dbEntry.save();

        deletedCount++;

        // Délai pour éviter le rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));

      } catch (error) {
        errorCount++;
        errors.push({ name: item.channel.name, error: error.message });
        console.error(`❌ Erreur suppression canal ${item.channel.name}:`, error);
      }
    }

    // Rapport final
    const newChannelCount = interaction.guild.channels.cache.size;
    let finalReport = `✅ **Nettoyage terminé !**\n\n`;
    finalReport += `📊 **Résultats:**\n`;
    finalReport += `• Canaux supprimés: **${deletedCount}/${channelsToClean.length}**\n`;
    finalReport += `• Erreurs: **${errorCount}**\n`;
    finalReport += `• Canaux avant: **${currentChannelCount}/500**\n`;
    finalReport += `• Canaux après: **${newChannelCount}/500**\n`;
    finalReport += `• Espace libéré: **${currentChannelCount - newChannelCount} places**\n`;

    if (protectedSkipped.length > 0) {
      finalReport += `\n🛡️ **Canaux protégés préservés:** ${protectedSkipped.length}`;
    }

    if (errors.length > 0) {
      finalReport += `\n\n❌ **Erreurs rencontrées:**\n`;
      for (const err of errors.slice(0, 5)) {
        finalReport += `• #${err.name}: ${err.error}\n`;
      }
    }

    finalReport += `\n💡 **Note:** Les canaux supprimés sont marqués comme \`manuallyDeleted\` et ne seront pas recréés automatiquement.`;

    // Logger l'action
    await client.services.logger.logAdminAction(
      interaction.guild.id,
      `🧹 **Auto-nettoyage exécuté**\n` +
      `👤 Par: ${interaction.user.tag}\n` +
      `📊 Canaux supprimés: ${deletedCount}\n` +
      `⏱️ Inactifs depuis: ${days} jours\n` +
      `📉 Espace libéré: ${currentChannelCount - newChannelCount} places`
    );

    await interaction.editReply(finalReport);

  } catch (error) {
    console.error('❌ Erreur handleAutoclean:', error);

    await interaction.editReply(`❌ **Erreur lors du nettoyage automatique**\n\n\`\`\`${error.message}\`\`\``);

    await client.services.logger.logError(
      interaction.guild.id,
      `Erreur auto-nettoyage: ${error.message}`,
      'handleAutoclean',
      { error }
    );
  }
}

// 🔧 COMMANDE - AUTO-REPAIR SYSTÈME DE CORRECTION AUTOMATIQUE
async function handleAutoRepair(interaction) {
  const permissionCheck = checkAdminPermission(interaction);
  if (!permissionCheck.hasPermission) {
    await interaction.reply(permissionCheck.error);
    return;
  }

  await interaction.deferReply({ ephemeral: false });

  try {
    const action = interaction.options.getString('action');
    const ServerConfig = require('./models/ServerConfig');
    const serverConfig = await ServerConfig.findOne({ guildId: interaction.guild.id });

    if (!serverConfig) {
      await interaction.editReply('❌ Serveur non initialisé. Utilisez `/initialise` d\'abord.');
      return;
    }

    switch (action) {
      case 'enable':
        serverConfig.autoRepairEnabled = true;
        await serverConfig.save();

        await interaction.editReply(
          '✅ **AUTO-REPAIR ACTIVÉ**\n\n' +
          '🔧 Le système surveillera le canal #error et corrigera automatiquement:\n' +
          '• Les correspondances de salons manquantes\n' +
          '• Création automatique des salons si nécessaire\n' +
          '• Limite: 10 créations par heure\n\n' +
          '📊 Les actions seront loggées dans #admin-logs'
        );

        await client.services.logger.logAdminAction(
          interaction.guild.id,
          `🔧 **AUTO-REPAIR** - Système activé par ${interaction.user.tag}`
        );
        break;

      case 'disable':
        serverConfig.autoRepairEnabled = false;
        await serverConfig.save();

        await interaction.editReply(
          '❌ **AUTO-REPAIR DÉSACTIVÉ**\n\n' +
          'Le système ne corrigera plus automatiquement les erreurs.'
        );

        await client.services.logger.logAdminAction(
          interaction.guild.id,
          `🔧 **AUTO-REPAIR** - Système désactivé par ${interaction.user.tag}`
        );
        break;

      case 'status':
        const stats = client.autoRepairStats?.get(interaction.guild.id) || { count: 0, lastReset: Date.now() };
        const timeUntilReset = Math.max(0, 3600000 - (Date.now() - stats.lastReset));
        const minutesUntilReset = Math.ceil(timeUntilReset / 60000);

        await interaction.editReply(
          `📊 **STATUT AUTO-REPAIR**\n\n` +
          `${serverConfig.autoRepairEnabled ? '✅ **ACTIVÉ**' : '❌ **DÉSACTIVÉ**'}\n\n` +
          `📈 **Statistiques cette heure:**\n` +
          `• Créations: ${stats.count}/10\n` +
          `• Réinitialisation dans: ${minutesUntilReset} minutes\n\n` +
          `📊 **Statistiques globales:**\n` +
          `• Total de réparations: ${serverConfig.autoRepairStats?.createdCount || 0}\n` +
          `• Dernière réparation: ${serverConfig.autoRepairStats?.lastRepairAt ?
            new Date(serverConfig.autoRepairStats.lastRepairAt).toLocaleString('fr-FR') :
            'Jamais'}`
        );
        break;

      default:
        await interaction.editReply('❌ Action non reconnue.');
    }

  } catch (error) {
    console.error('❌ Erreur /auto-repair:', error);
    await interaction.editReply(`❌ Erreur: ${error.message}`);

    await client.services.logger.logError(
      interaction.guild.id,
      `Erreur auto-repair: ${error.message}`,
      'handleAutoRepair',
      { error }
    );
  }
}

// 📥 COMMANDE - BACKFILL DES DERNIERS MESSAGES D'UN SALON
async function handleBackfill(interaction) {
  const permissionCheck = checkAdminPermission(interaction);
  if (!permissionCheck.hasPermission) {
    await interaction.reply(permissionCheck.error);
    return;
  }

  await interaction.deferReply();

  try {
    // Vérifier config
    const sourceGuild = client.services.userClient.getSourceGuild(interaction.guild.id);
    if (!sourceGuild) {
      await interaction.editReply('❌ Configuration serveur source manquante. Utilisez `/start` d\'abord.');
      return;
    }

    const rawChannelName = interaction.options.getString('channel_name');
    const channelName = rawChannelName.replace(/^#/, ''); // Strip # prefix si présent
    const count = Math.min(interaction.options.getInteger('count') || 10, 10);

    // Trouver le channel source par nom (find pluriel pour gérer les doublons/entrées corrompues)
    const Channel = require('./models/Channel');
    const channelDocs = await Channel.find({
      serverId: sourceGuild.id,
      name: { $regex: new RegExp(`^${channelName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
      manuallyDeleted: { $ne: true }
    });

    if (channelDocs.length === 0) {
      await interaction.editReply(`❌ Salon **#${channelName}** introuvable dans la base de données.\n\nVérifiez le nom exact ou lancez \`/discovery\` d'abord.`);
      return;
    }

    // Trouver la première entrée valide (discordId existe sur le mirror ET sourceChannelId présent)
    let channelDoc = null;
    let targetChannel = null;
    for (const doc of channelDocs) {
      if (!doc.sourceChannelId) continue;
      if (!doc.discordId || doc.discordId === 'pending' || doc.discordId.startsWith('pending_')) continue;
      const ch = interaction.guild.channels.cache.get(doc.discordId);
      if (ch) {
        channelDoc = doc;
        targetChannel = ch;
        break;
      }
    }

    // Fallback : chercher le salon mirror par nom dans le guild cache
    if (!channelDoc || !targetChannel) {
      const mirrorByName = interaction.guild.channels.cache.find(
        ch => ch.name === channelName && [0, 5, 15].includes(ch.type) // text, news, forum uniquement
      );
      if (mirrorByName) {
        // Trouver un doc avec sourceChannelId pour le backfill
        const docWithSource = channelDocs.find(d => d.sourceChannelId);
        if (docWithSource) {
          channelDoc = docWithSource;
          targetChannel = mirrorByName;

          // Réparer le mapping DB si discordId invalide
          if (!docWithSource.discordId || docWithSource.discordId === 'pending' || docWithSource.discordId !== mirrorByName.id) {
            await Channel.findOneAndUpdate(
              { _id: docWithSource._id },
              { $set: { discordId: mirrorByName.id } }
            );
          }
        }
      }
    }

    if (!channelDoc || !targetChannel) {
      await interaction.editReply(`❌ Salon mirror **#${channelName}** introuvable sur ce serveur.\n\n💡 Lancez \`/fix-correspondances\` ou \`/discovery\` pour réparer.`);
      return;
    }

    await interaction.editReply(`📥 **Backfill en cours** pour **#${channelName}**...\n⏳ Récupération des ${count} derniers messages (délais de sécurité actifs)`);

    // Lancer le backfill via le scraper
    const result = await client.services.scraper.backfillChannel(
      channelDoc.sourceChannelId,
      targetChannel,
      sourceGuild,
      client.services.userClient,
      interaction.guild.id,
      count
    );

    await interaction.editReply(
      `📥 **Backfill terminé** pour **#${channelName}**\n\n` +
      `📊 Messages récupérés: **${result.fetched}**\n` +
      `✅ Traités: **${result.processed}**\n` +
      `⏭️ Déjà présents: **${result.skipped}**`
    );

  } catch (error) {
    console.error('❌ Erreur backfill:', error.message);
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply(`❌ Erreur backfill: ${error.message}`);
    } else {
      await interaction.reply(`❌ Erreur backfill: ${error.message}`);
    }
  }
}

// 🔍 COMMANDE - SCAN COMPLET DES MEMBRES
async function handleScanMembers(interaction) {
  const permissionCheck = checkAdminPermission(interaction);
  if (!permissionCheck.hasPermission) {
    await interaction.reply(permissionCheck.error);
    return;
  }

  await interaction.deferReply({ ephemeral: false });

  try {
    const thorough = interaction.options.getBoolean('thorough') ?? false;

    // Vérifier que le service de détection est disponible
    if (!client.services.memberDetection) {
      await interaction.editReply('❌ Service de détection des membres non initialisé');
      return;
    }

    // Vérifier si un scan est déjà en cours
    if (client.services.memberDetection.isScanRunning()) {
      await interaction.editReply('⚠️ Un scan est déjà en cours. Veuillez patienter.');
      return;
    }

    // Récupérer la configuration du serveur
    const ServerConfig = require('./models/ServerConfig');
    const serverConfig = await ServerConfig.findOne({ guildId: interaction.guild.id });

    if (!serverConfig?.sourceGuildId) {
      await interaction.editReply('❌ Serveur source non configuré. Utilisez `/initialise` d\'abord.');
      return;
    }

    // Récupérer le guild source pour afficher le nom
    const sourceGuild = await client.services.userClient.getSourceGuild(interaction.guild.id);
    if (!sourceGuild) {
      await interaction.editReply('❌ Impossible d\'accéder au serveur source. Vérifiez le token utilisateur.');
      return;
    }

    // Envoyer un message de démarrage
    const startMessage = thorough
      ? `🔍 **Scan approfondi** de \`${sourceGuild.name}\` en cours...\n\n` +
        `📊 Méthodes utilisées:\n` +
        `• Cache Discord\n` +
        `• LAZY_REQUEST (sidebar)\n` +
        `• Opcode 8 (permissions)\n` +
        `• Recherche alphabétique (a-z, 0-9)\n\n` +
        `⏱️ Durée estimée: 2-5 minutes`
      : `🔍 **Scan rapide** de \`${sourceGuild.name}\` en cours...\n\n` +
        `📊 Méthodes utilisées:\n` +
        `• Cache Discord\n` +
        `• LAZY_REQUEST (sidebar)\n` +
        `• Opcode 8 (permissions)\n\n` +
        `⏱️ Durée estimée: 30 secondes - 2 minutes`;

    await interaction.editReply(startMessage);

    // Lancer le scan
    const result = await client.services.memberDetection.detectAllMembers(
      serverConfig.sourceGuildId,
      interaction.guild.id,
      { thorough, saveToDb: true }
    );

    if (!result) {
      await interaction.editReply('❌ Le scan a échoué. Consultez les logs pour plus de détails.');
      return;
    }

    // Construire le message de résultat
    let resultMessage = `✅ **Scan terminé** pour \`${sourceGuild.name}\`\n\n`;

    resultMessage += `📊 **Résultats:**\n`;
    resultMessage += `• Membres uniques détectés: **${result.stats.totalUnique}**\n`;
    resultMessage += `• Total sur le serveur: **${result.stats.totalMembers || 'inconnu'}**\n`;
    resultMessage += `• Couverture: **${result.stats.coverage}**\n`;
    resultMessage += `• Sauvegardés en DB: **${result.stats.saved || 0}**\n`;
    resultMessage += `• Durée: **${result.duration}s**\n\n`;

    resultMessage += `📋 **Détails par méthode:**\n`;
    for (const method of result.methods) {
      const methodName = {
        'cache': '💾 Cache Discord',
        'lazy_request': '📜 LAZY_REQUEST',
        'opcode_8': '🔌 Opcode 8',
        'brute_force': '🔍 Recherche alphabétique'
      }[method.name] || method.name;

      resultMessage += `• ${methodName}: ${method.count} membres`;
      if (method.new !== undefined) {
        resultMessage += ` (+${method.new} nouveaux)`;
      }
      resultMessage += '\n';
    }

    await interaction.editReply(resultMessage);

  } catch (error) {
    console.error('❌ Erreur scan-members:', error);
    await interaction.editReply(`❌ Erreur lors du scan: ${error.message}`);
  }
}

// 📊 COMMANDE - ANALYSE DES MEMBRES MULTI-SERVEURS
async function handleMembersAnalysis(interaction) {
  const permissionCheck = checkAdminPermission(interaction);
  if (!permissionCheck.hasPermission) {
    await interaction.reply(permissionCheck.error);
    return;
  }

  await interaction.deferReply({ ephemeral: false });

  try {
    const action = interaction.options.getString('action');
    const userInput = interaction.options.getString('user'); // STRING maintenant

    // Résoudre le membre si fourni (depuis le serveur SOURCE)
    let targetMember = null;
    if (userInput) {
      const MemberResolver = require('./utils/memberResolver');
      try {
        const sourceGuild = client.services.userClient.getSourceGuild(interaction.guild.id);
        targetMember = await MemberResolver.resolveMember(
          userInput,
          sourceGuild.id,
          client.services.userClient,
          interaction.guild.id
        );

        if (!targetMember) {
          await interaction.editReply(`❌ Membre "${userInput}" non trouvé sur le serveur source`);
          return;
        }
      } catch (error) {
        await interaction.editReply('❌ Erreur lors de la résolution du membre');
        console.error('Erreur résolution membre:', error);
        return;
      }
    }

    // Créer le canal membres-dangereux s'il n'existe pas
    let dangerousChannel = interaction.guild.channels.cache.find(ch => ch.name === 'membres-dangereux');
    if (!dangerousChannel) {
      const maintenanceCategory = interaction.guild.channels.cache.find(
        c => c.type === 4 && c.name === 'MAINTENANCE'
      );

      dangerousChannel = await interaction.guild.channels.create({
        name: 'membres-dangereux',
        type: 0, // Text channel
        parent: maintenanceCategory?.id,
        reason: 'Canal pour tracking des membres dangereux'
      });
    }

    switch (action) {
      case 'check': {
        await interaction.editReply('🔍 Analyse en cours...');

        // Si un membre spécifique est demandé
        if (targetMember) {
          const MemberDetail = require('./models/MemberDetail');
          const sourceGuild = client.services.userClient.getSourceGuild(interaction.guild.id);

          // Analyser ce membre spécifiquement
          await client.services.memberTracker.saveMemberDetail(
            targetMember,
            sourceGuild.id,
            sourceGuild.name,
            'update'
          );

          // Récupérer les infos du membre depuis la DB
          const memberInfo = await MemberDetail.findOne({
            userId: targetMember.userId,
            guildId: sourceGuild.id
          });

          let response = `📊 **Analyse de ${targetMember.username}**\n\n`;

          if (memberInfo) {
            response += `• **ID**: ${memberInfo.userId}\n`;
            response += `• **Nom d'affichage**: ${memberInfo.displayName || memberInfo.username}\n`;
            response += `• **Présent**: ${memberInfo.isPresent ? '✅ Oui' : '❌ Non'}\n`;

            if (memberInfo.servers && memberInfo.servers.length > 1) {
              response += `\n⚠️ **ATTENTION**: Présent sur ${memberInfo.servers.length} serveurs:\n`;
              for (const srv of memberInfo.servers) {
                response += `  • ${srv.guildName}\n`;
              }
              response += `\n**Niveau de danger**: ${memberInfo.dangerLevel}/3`;
            } else {
              response += `\n✅ **Sécurité**: Présent uniquement sur ce serveur`;
            }

            if (memberInfo.joinedAt) {
              response += `\n• **Rejoint le**: <t:${Math.floor(memberInfo.joinedAt.getTime() / 1000)}:f>`;
            }
            if (memberInfo.lastSeen) {
              response += `\n• **Dernière activité**: <t:${Math.floor(memberInfo.lastSeen.getTime() / 1000)}:R>`;
            }
          } else {
            response += `Membre nouvellement analysé - données en cours de traitement`;
          }

          await dangerousChannel.send(response);
          await interaction.editReply(`✅ Analyse de **${targetMember.username}** terminée\n📋 Rapport envoyé dans ${dangerousChannel}`);
        } else {
          // Scan global de tous les serveurs
          const stats = client.services.userClient.getStats();
          let totalAnalyzed = 0;

          for (const guildData of stats.guilds) {
            const targetGuild = client.guilds.cache.get(guildData.guildId);
            if (targetGuild && client.services.userClient.hasUserToken(guildData.guildId)) {
              try {
                // Récupérer la source guild
                const sourceGuild = client.services.userClient.getSourceGuild(guildData.guildId);

                const members = await client.services.memberTracker.fetchDetailedMemberList(guildData.guildId);
                totalAnalyzed += members.length;

                // Sauvegarder tous les membres
                for (const member of members) {
                  await client.services.memberTracker.saveMemberDetail(
                    member,
                    sourceGuild.id,
                    sourceGuild.name,
                    'update'
                  );
                }
              } catch (error) {
                console.error(`❌ Erreur analyse membres pour ${guildData.guildId}:`, error);
              }
            }
          }

          await interaction.editReply(
            `✅ **Analyse terminée**\n\n` +
            `📊 ${totalAnalyzed} membres analysés sur ${stats.guilds.length} serveurs\n` +
            `⏰ Prochaine analyse automatique: minuit`
          );
        }
        break;
      }

      case 'dangerous': {
        const dangerousMembers = await client.services.memberTracker.findDangerousMembers();

        if (dangerousMembers.length === 0) {
          await interaction.editReply('✅ Aucun membre dangereux détecté');
          return;
        }

        let response = '⚠️ **MEMBRES DANGEREUX DÉTECTÉS**\n\n';
        for (const member of dangerousMembers.slice(0, 20)) {
          response += `• **${member.username}** - Sur ${member.serverCount} serveurs\n`;
          response += `  └ ${member.servers.map(s => s.guildName).join(', ')}\n`;
        }

        await dangerousChannel.send(response);
        await interaction.editReply(`⚠️ ${dangerousMembers.length} membres dangereux identifiés\n📋 Rapport envoyé dans ${dangerousChannel}`);
        break;
      }

      case 'daily-report': {
        // Générer le rapport pour le serveur source configuré
        let sourceGuildId = null;
        try {
          const sourceGuild = client.services.userClient.getSourceGuild(interaction.guild.id);
          sourceGuildId = sourceGuild.id;
        } catch (error) {
          await interaction.editReply('❌ Aucun serveur source configuré');
          return;
        }

        const report = await client.services.memberTracker.generateDailyReport(interaction.guild.id);

        if (!report) {
          await interaction.editReply('❌ Erreur lors de la génération du rapport');
          return;
        }

        const date = new Date().toLocaleDateString('fr-FR');
        let reportMessage = `🚨 **RAPPORT QUOTIDIEN - ${date}**\n`;
        reportMessage += `${'═'.repeat(40)}\n\n`;

        // Membres dangereux
        if (report.dangerousMembers.length > 0) {
          reportMessage += `⚠️ **MEMBRES À SURVEILLER (Présents sur plusieurs serveurs):**\n`;
          for (const member of report.dangerousMembers.slice(0, 10)) {
            reportMessage += `• **${member.username}** - Danger: ${member.dangerLevel}/3\n`;
            reportMessage += `  └ ${member.dangerReason}\n`;
          }
          reportMessage += '\n';
        }

        // Opportunités
        if (report.recentDepartures.length > 0) {
          reportMessage += `🎯 **OPPORTUNITÉS (Départs récents de concurrents):**\n`;
          for (const opp of report.recentDepartures.slice(0, 10)) {
            reportMessage += `• **${opp.username}** - Quitté ${opp.opportunityFrom}\n`;
            reportMessage += `  └ <t:${Math.floor(opp.opportunityDate.getTime() / 1000)}:R>\n`;
          }
          reportMessage += '\n';
        }

        // Statistiques
        reportMessage += `📊 **STATISTIQUES:**\n`;
        reportMessage += `• Total membres: ${report.stats.totalMembers}\n`;
        reportMessage += `• Membres dangereux: ${report.stats.totalDangerous}\n`;
        reportMessage += `• Opportunités actives: ${report.stats.totalOpportunities}\n`;
        reportMessage += `• Arrivées aujourd'hui: +${report.todayJoins.length}\n`;
        reportMessage += `• Départs aujourd'hui: -${report.todayLeaves.length}\n`;

        await dangerousChannel.send(reportMessage);
        await interaction.editReply(`📊 Rapport quotidien généré et envoyé dans ${dangerousChannel}`);
        break;
      }

      case 'opportunities': {
        const MemberDetail = require('./models/MemberDetail');
        const opportunities = await MemberDetail.find({
          isOpportunity: true,
          opportunityDate: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
        }).sort({ opportunityDate: -1 }).limit(20);

        if (opportunities.length === 0) {
          await interaction.editReply('✅ Aucune opportunité récente');
          return;
        }

        let response = '🎯 **OPPORTUNITÉS RÉCENTES**\n\n';
        for (const opp of opportunities) {
          response += `• **${opp.username}** (${opp.userId})\n`;
          response += `  └ Quitté **${opp.opportunityFrom}** <t:${Math.floor(opp.opportunityDate.getTime() / 1000)}:R>\n`;
        }

        await dangerousChannel.send(response);
        await interaction.editReply(`🎯 ${opportunities.length} opportunités identifiées\n📋 Rapport envoyé dans ${dangerousChannel}`);
        break;
      }

      default:
        await interaction.editReply('❌ Action non reconnue');
    }

  } catch (error) {
    console.error('❌ Erreur /members-analysis:', error);
    await interaction.editReply(`❌ Erreur: ${error.message}`);

    await client.services.logger.logError(
      interaction.guild.id,
      `Erreur members-analysis: ${error.message}`,
      'handleMembersAnalysis',
      { error }
    );
  }
}

// 🧪 TEST D'ACCÈS AUX MEMBRES DU SERVEUR SOURCE
async function handleTestAccess(interaction) {
  const permissionCheck = checkAdminPermission(interaction);
  if (!permissionCheck.hasPermission) {
    await interaction.reply(permissionCheck.error);
    return;
  }

  await interaction.deferReply();

  try {
    const { EmbedBuilder } = require('discord.js');

    // Vérifier la configuration
    const sourceGuild = client.services.userClient.getSourceGuild(interaction.guild.id);

    if (!sourceGuild) {
      return interaction.editReply('❌ Configuration serveur source manquante. Vérifiez SERVER_ID dans les variables d\'environnement Coolify.');
    }
    const userData = client.services.userClient.getUserData(interaction.guild.id);
    const userToken = userData.token;
    const sourceGuildId = sourceGuild.id;


    const embed = new EmbedBuilder()
      .setTitle('🧪 Test d\'accès aux membres')
      .setDescription(`Testing permissions for **${sourceGuild.name}**`)
      .setColor(0x00AE86)
      .setTimestamp();

    const testResults = [];

    // TEST 1: Guild avec with_counts
    testResults.push('**📝 Test 1: Guild info avec counts**');
    try {
      const guildUrl = `https://discord.com/api/v9/guilds/${sourceGuildId}?with_counts=true`;
      const response = await fetch(guildUrl, {
        headers: {
          'Authorization': userToken,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      if (response.ok) {
        const data = await response.json();
        testResults.push(`✅ ${data.approximate_member_count || 'N/A'} membres`);
        testResults.push(`✅ ${data.approximate_presence_count || 'N/A'} en ligne`);
      } else {
        testResults.push(`❌ Erreur ${response.status}`);
      }
    } catch (error) {
      testResults.push(`❌ Erreur: ${error.message}`);
    }

    // TEST 2: Vérifier les permissions via selfbot
    testResults.push('\n**📝 Test 2: Permissions via selfbot**');

    const selfbot = client.services.userClient.selfbots.get(interaction.guild.id);
    if (selfbot && selfbot.guilds.cache.has(sourceGuildId)) {
      const guild = selfbot.guilds.cache.get(sourceGuildId);
      testResults.push(`✅ Selfbot dans le serveur`);
      testResults.push(`👥 ${guild.memberCount} membres visibles`);

      // Vérifier si on peut voir la liste des membres
      const me = guild.members.cache.get(selfbot.user.id);
      if (me) {
        const canViewMembers = me.permissions.has('VIEW_CHANNEL');
        testResults.push(canViewMembers ? '✅ Peut voir les membres' : '❌ Ne peut pas voir les membres');
      }
    } else {
      testResults.push('⚠️ Selfbot non connecté');
    }


    // TEST 3: WebSocket member fetching
    testResults.push('\n**📝 Test 3: WebSocket Member Fetch**');

    try {
      const startTime = Date.now();

      // Utiliser la nouvelle méthode WebSocket
      const wsMembers = await client.services.userClient.fetchMembersViaWebSocket(
        sourceGuildId,
        interaction.guild.id
      );

      if (wsMembers && wsMembers.length > 0) {
        const fetchTime = ((Date.now() - startTime) / 1000).toFixed(2);
        testResults.push(`✅ **${wsMembers.length} membres récupérés** en ${fetchTime}s`);
        testResults.push(`📊 Taux de récupération: ${((wsMembers.length / guild.memberCount) * 100).toFixed(1)}%`);

        // Compter les bots vs humains
        const bots = wsMembers.filter(m => m.user && m.user.bot).length;
        const humans = wsMembers.length - bots;
        testResults.push(`👥 ${humans} humains, 🤖 ${bots} bots`);
      } else {
        testResults.push('❌ Échec du fetch WebSocket');
      }
    } catch (error) {
      testResults.push(`❌ Erreur WebSocket: ${error.message}`);
    }

    // TEST 4: Cache member fetching
    testResults.push('\n**📝 Test 4: Cache Member Fetch**');

    try {
      const startTime = Date.now();

      // Récupérer le guild depuis le selfbot (comme dans Test 4)
      const cacheSelfbot = client.services.userClient.selfbots.get(interaction.guild.id);
      const cacheGuild = cacheSelfbot?.guilds.cache.get(sourceGuildId);

      // Utiliser la nouvelle méthode Cache
      const cacheMembers = await client.services.userClient.fetchMembersFromCache(
        sourceGuildId,
        interaction.guild.id
      );

      if (cacheMembers && cacheMembers.length > 0) {
        const fetchTime = ((Date.now() - startTime) / 1000).toFixed(2);
        testResults.push(`✅ **${cacheMembers.length} membres dans le cache** (${fetchTime}s)`);

        // Utiliser cacheGuild si disponible, sinon utiliser les données de sourceGuild
        const totalMembers = cacheGuild?.memberCount || sourceGuild?.member_count || cacheMembers.length;
        testResults.push(`📊 Couverture: ${((cacheMembers.length / totalMembers) * 100).toFixed(1)}%`);

        // Compter les bots vs humains
        const bots = cacheMembers.filter(m => m.user && m.user.bot).length;
        const humans = cacheMembers.length - bots;
        testResults.push(`👥 ${humans} humains, 🤖 ${bots} bots`);
      } else {
        testResults.push('❌ Cache vide ou insuffisant');
      }
    } catch (error) {
      testResults.push(`❌ Erreur Cache: ${error.message}`);
    }

    // Test 5 : Simulation de scroll (LAZY_REQUEST)
    testResults.push('\n**Test 5: Lazy Request (Scroll)**');

    try {
      const lazyMembers = await client.services.userClient.fetchMembersViaLazyRequestWithRetry(sourceGuildId, interaction.guild.id, 2);

      if (lazyMembers && lazyMembers.length > 0) {
        const percentage = ((lazyMembers.length / totalMembers) * 100).toFixed(1);
        testResults.push(`✅ ${lazyMembers.length}/${totalMembers} membres récupérés (${percentage}%)`);

        // Compter les bots vs humains
        const bots = lazyMembers.filter(m => m.user && m.user.bot).length;
        const humans = lazyMembers.length - bots;
        testResults.push(`👥 ${humans} humains, 🤖 ${bots} bots`);
      } else {
        testResults.push('❌ Simulation de scroll échouée');
      }
    } catch (error) {
      testResults.push(`❌ Erreur Lazy Request: ${error.message}`);
    }

    // Résumé et diagnostic
    testResults.push('\n**📊 DIAGNOSTIC**');

    // Nouveau diagnostic incluant Cache, Lazy Request et WebSocket
    const hasCache = testResults.some(r => r.includes('membres dans le cache') && r.includes('✅'));
    const hasLazyRequest = testResults.some(r => r.includes('Lazy Request') && r.includes('✅'));
    const hasWebSocket = testResults.some(r => r.includes('membres récupérés') && r.includes('✅'));

    if (hasCache) {
      testResults.push('✅ **Cache disponible** - Méthode OPTIMALE (instantané)');
      testResults.push('💡 Utilise les membres déjà en mémoire du selfbot');
      embed.setColor(0x00FF00);
    } else if (hasLazyRequest) {
      testResults.push('✅ **Simulation de scroll fonctionnelle** - Méthode RECOMMANDÉE');
      testResults.push('💡 Simule le comportement du client Discord pour charger tous les membres');
      embed.setColor(0x00FF00);
    } else if (hasWebSocket) {
      testResults.push('✅ **Accès WebSocket fonctionnel** - Méthode alternative');
      testResults.push('💡 Le WebSocket contourne les restrictions API');
      embed.setColor(0x00FF00);
    } else {
      testResults.push('❌ **Accès bloqué** - Toutes méthodes échouées');
      testResults.push('💡 Solution: Vérifier que le selfbot est bien connecté');
      testResults.push('💡 Assurez-vous que le token utilisateur est valide');
      embed.setColor(0xFF0000);
    }

    embed.setDescription(testResults.join('\n'));


    return interaction.editReply({ embeds: [embed] });

  } catch (error) {
    console.error('❌ Erreur test-access:', error);
    return interaction.editReply(`❌ Erreur lors du test: ${error.message}`);
  }
}

// 🔄 RÉACTIVER UN SALON OU UNE CATÉGORIE MARQUÉ(E) COMME SUPPRIMÉ(E) MANUELLEMENT
async function handleUndelete(interaction) {
  const permissionCheck = checkAdminPermission(interaction);
  if (!permissionCheck.hasPermission) {
    await interaction.reply(permissionCheck.error);
    return;
  }

  await interaction.deferReply();

  try {
    const sourceGuild = client.services.userClient.getSourceGuild(interaction.guild.id);

    if (!sourceGuild) {
      await interaction.editReply('❌ Configuration serveur source manquante. Vérifiez SERVER_ID dans les variables d\'environnement Coolify.');
      return;
    }

    const itemName = interaction.options.getString('name');
    const itemType = interaction.options.getString('type') || 'channel'; // Par défaut : salon

    // 🆕 GESTION DES CATÉGORIES
    if (itemType === 'category') {
      const Category = require('./models/Category');

      // Chercher la catégorie marquée comme supprimée manuellement
      const categoryDB = await Category.findOne({
        name: itemName,
        serverId: sourceGuild.id,
        manuallyDeleted: true
      });

      if (!categoryDB) {
        await interaction.editReply(`❌ **Catégorie non trouvée !**\n\n🔍 Aucune catégorie nommée \`${itemName}\` n'est marquée comme supprimée manuellement.\n\n💡 Utilisez \`/undelete name:${itemName} type:category\` pour les catégories.`);
        return;
      }

      // Vérifier si la catégorie existe toujours sur le serveur source
      const userData = client.services.userClient.getUserData(interaction.guild.id);
      const sourceChannels = await client.services.userClient.fetchGuildChannels(userData.token, sourceGuild.id);
      const sourceCategory = sourceChannels.find(ch => ch.name === itemName && ch.type === 4);

      if (!sourceCategory) {
        await interaction.editReply(`❌ **Catégorie source introuvable !**\n\n🔍 La catégorie \`${itemName}\` n'existe plus sur le serveur source **${sourceGuild.name}**\n\n🗑️ Vous pouvez la supprimer définitivement de la base avec \`/delcategories\``);
        return;
      }

      // Vérifier si la catégorie mirror existe déjà
      const existingMirrorCategory = interaction.guild.channels.cache.find(ch => ch.name === itemName && ch.type === 4);

      if (existingMirrorCategory) {
        // La catégorie mirror existe, juste réactiver le marquage
        categoryDB.manuallyDeleted = false;
        categoryDB.deletedAt = null;
        categoryDB.deletedReason = null;
        categoryDB.deletedBy = null;
        await categoryDB.save();

        await interaction.editReply(`✅ **Catégorie réactivée !**\n\n📁 **${itemName}** n'est plus marquée comme supprimée\n🛡️ **Auto-discovery :** Pourra maintenant synchroniser cette catégorie normalement\n🆔 **ID Mirror :** ${existingMirrorCategory.id}\n\n💡 Cette catégorie sera maintenant prise en compte lors de l'auto-discovery quotidienne !`);
      } else {
        // La catégorie mirror n'existe pas, la recréer
        await interaction.editReply(`🔄 **Recréation de la catégorie en cours...**\n\n⏳ Création de la catégorie mirror et réactivation...`);

        try {
          // Créer la catégorie sur le serveur mirror
          const newCategory = await interaction.guild.channels.create({
            name: sourceCategory.name,
            type: 4, // CategoryChannel
            position: sourceCategory.position
          });

          // Réactiver l'entrée en base de données
          categoryDB.manuallyDeleted = false;
          categoryDB.deletedAt = null;
          categoryDB.deletedReason = null;
          categoryDB.deletedBy = null;
          categoryDB.discordId = newCategory.id; // Nouveau ID
          await categoryDB.save();

          // Logger la réactivation
          await client.services.logger.logAdminAction(
            interaction.guild.id,
            `🔄 Catégorie réactivée: ${itemName} par ${interaction.user.tag}\n` +
            `📁 Catégorie recréée et marquage supprimé automatiquement`
          );

          await interaction.editReply(`✅ **Catégorie réactivée et recréée !**\n\n📁 **${itemName}** a été recréée avec succès\n🆔 **ID Mirror :** ${newCategory.id}\n🔗 **ID Source :** ${sourceCategory.id}\n🛡️ **Auto-discovery :** Pourra maintenant synchroniser cette catégorie normalement\n\n💡 Cette catégorie sera maintenant prise en compte lors de l'auto-discovery quotidienne !`);

        } catch (createError) {
          console.error(`❌ Erreur lors de la recréation de la catégorie ${itemName}:`, createError);

          await interaction.editReply(`❌ **Erreur lors de la recréation !**\n\n📁 Impossible de recréer **${itemName}**\n❌ **Erreur :** ${createError.message}\n\n🔧 **Solution :** Le marquage a été conservé. Vous pouvez :\n• Créer la catégorie manuellement sur Discord\n• Puis réessayer cette commande`);
        }
      }

      return; // Fin de gestion des catégories
    }

    // 🔄 GESTION DES SALONS (logique existante adaptée)
    const Channel = require('./models/Channel');

    // Chercher le salon marqué comme supprimé manuellement
    const channelDB = await Channel.findOne({
      name: itemName,
      serverId: sourceGuild.id,
      manuallyDeleted: true
    });

    if (!channelDB) {
      await interaction.editReply(`❌ **Salon non trouvé !**\n\n🔍 Aucun salon nommé \`${itemName}\` n'est marqué comme supprimé manuellement.\n\n💡 Utilisez la commande sans le \`#\` au début du nom.`);
      return;
    }

    // Vérifier si le salon existe toujours sur le serveur source
    const userData = client.services.userClient.getUserData(interaction.guild.id);
    const sourceChannels = await client.services.userClient.fetchGuildChannels(userData.token, sourceGuild.id);
    const sourceChannel = sourceChannels.find(ch => ch.name === itemName && ch.type === 0);

    if (!sourceChannel) {
      await interaction.editReply(`❌ **Salon source introuvable !**\n\n🔍 Le salon \`${itemName}\` n'existe plus sur le serveur source **${sourceGuild.name}**\n\n🗑️ Vous pouvez le supprimer définitivement avec \`/blacklist action:add channel_name:${itemName}\``);
      return;
    }

    // Vérifier si le salon mirror existe déjà
    const existingMirrorChannel = interaction.guild.channels.cache.find(ch => ch.name === itemName);

    if (existingMirrorChannel) {
      // Le salon mirror existe, juste réactiver le marquage
      channelDB.manuallyDeleted = false;
      channelDB.deletedAt = null;
      channelDB.deletedReason = null;
      channelDB.scraped = true; // Réactiver le scraping
      channelDB.discordId = existingMirrorChannel.id; // Mettre à jour l'ID
      await channelDB.save();

      await interaction.editReply(`✅ **Salon réactivé !**\n\n📂 **#${itemName}** n'est plus marqué comme supprimé\n⚡ **Scraping :** Réactivé automatiquement\n🆔 **ID Mirror :** ${existingMirrorChannel.id}\n\n💡 L'auto-discovery pourra maintenant synchroniser ce salon normalement.`);
    } else {
      // Le salon mirror n'existe pas, le recréer
      await interaction.editReply(`🔄 **Recréation du salon en cours...**\n\n⏳ Création du salon mirror et réactivation...`);

      try {
        // Créer le salon sur le serveur mirror
        const targetGuild = interaction.guild;

        // Créer la catégorie si nécessaire
        let targetCategory = null;
        if (sourceChannel.parent_id) {
          const sourceCategory = sourceChannels.find(c => c.id === sourceChannel.parent_id && c.type === 4);
          if (sourceCategory) {
            targetCategory = targetGuild.channels.cache.find(
              channel => channel.type === 4 && channel.name === sourceCategory.name
            );

            if (!targetCategory) {
              const { resolveCategoryNameConflict } = require('./utils/nameConflict');
              const categoryName = await resolveCategoryNameConflict(targetGuild, sourceCategory.name);
              targetCategory = await targetGuild.channels.create({
                name: categoryName,
                type: 4
              });
            }
          }
        }

        // Créer le salon Discord
        let channelOptions;
        
        // 🏛️ GESTION SPÉCIALE POUR LES SALONS FORUM (type 15)
        if (sourceChannel.type === 15) {
          try {
            const { ChannelType } = require('discord.js');

            channelOptions = {
              name: sourceChannel.name,
              type: ChannelType.GuildForum, // Utiliser l'enum Discord.js
              topic: sourceChannel.topic || `Forum réactivé - Mirror de #${sourceChannel.name}`,
              parent: targetCategory?.id || null,
              position: sourceChannel.position, // Synchroniser la position du forum
              // Propriétés obligatoires simplifiées
              defaultAutoArchiveDuration: 1440, // 24h par défaut
              defaultThreadRateLimitPerUser: 0,
              // Propriétés minimales
              availableTags: [], // Aucun tag par défaut
            };

          } catch (enumError) {
            channelOptions = {
              name: sourceChannel.name,
              type: 0, // TEXT fallback
              topic: `🏛️ Forum réactivé: ${sourceChannel.name}\n\n${sourceChannel.topic || 'Forum converti automatiquement en salon texte.'}`,
              parent: targetCategory?.id || null,
              position: sourceChannel.position // Synchroniser la position
            };
          }
        } else {
          channelOptions = {
          name: sourceChannel.name,
          type: sourceChannel.type,
          topic: sourceChannel.topic || `Salon réactivé - Mirror de #${sourceChannel.name}`,
          parent: targetCategory?.id || null,
          position: sourceChannel.position // Synchroniser la position
        };
        }

        let newChannel;
        try {
          newChannel = await targetGuild.channels.create(channelOptions);
        } catch (createError) {
          // 🏛️ GESTION SPÉCIFIQUE ERREUR FORUM (code 50024)
          if (createError.code === 50024 && sourceChannel.type === 15) {
            
            // Fallback : créer comme salon texte normal
            const fallbackOptions = {
              name: sourceChannel.name,
              type: 0, // TEXT
              topic: `🏛️ Forum source: ${sourceChannel.name}\n\n${sourceChannel.topic || 'Forum converti automatiquement en salon texte.'}`,
              parent: targetCategory?.id || null
            };
            
            newChannel = await targetGuild.channels.create(fallbackOptions);
            
          } else {
            // Re-lancer l'erreur si ce n'est pas une erreur de forum
            throw createError;
          }
        }

        // Réactiver l'entrée en base de données
        channelDB.manuallyDeleted = false;
        channelDB.deletedAt = null;
        channelDB.deletedReason = null;
        channelDB.scraped = true; // Réactiver le scraping
        channelDB.discordId = newChannel.id; // Nouveau ID
        channelDB.sourceChannelId = sourceChannel.id; // Mettre à jour l'ID source
        channelDB.category = targetCategory?.name || null;
        await channelDB.save();

        // Logger la réactivation avec mention cliquable
        await client.services.logger.logNewRoom(
          targetGuild.id,
          `🔄 **Salon réactivé** - <#${newChannel.id}>\n` +
          `📁 Catégorie: ${targetCategory?.name || 'Aucune'}\n` +
          `👤 Réactivé par: ${interaction.user.tag}\n` +
          `⚡ Scraping: Automatiquement activé`,
          'Réactivation',
          newChannel.id
        );

        await client.services.logger.logAdminAction(
          targetGuild.id,
          `🔄 Salon réactivé: #${itemName} par ${interaction.user.tag}\n` +
          `📂 Salon recréé et marquage supprimé automatiquement`
        );

        await interaction.editReply(`✅ **Salon réactivé et recréé !**\n\n📂 **#${itemName}** a été recréé avec succès\n📁 **Catégorie :** ${targetCategory?.name || 'Aucune'}\n🆔 **ID Mirror :** ${newChannel.id}\n🔗 **ID Source :** ${sourceChannel.id}\n⚡ **Scraping :** Activé automatiquement\n\n💡 L'auto-discovery pourra maintenant synchroniser ce salon normalement.`);

      } catch (createError) {
        console.error(`❌ Erreur lors de la recréation du salon ${itemName}:`, createError);

        await interaction.editReply(`❌ **Erreur lors de la recréation !**\n\n📂 Impossible de recréer **#${itemName}**\n❌ **Erreur :** ${createError.message}\n\n🔧 **Solution :** Le marquage a été conservé. Vous pouvez :\n• Créer le salon manuellement sur Discord\n• Puis réessayer cette commande\n• Ou utiliser \`/addroom channel_id:${sourceChannel.id}\``);
      }
    }

  } catch (error) {
    console.log('❌ Undelete: Échec');
    await interaction.editReply(`❌ **Erreur:** ${error.message}`);
  }
}

// Enregistrer les commandes slash
async function registerSlashCommands() {
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);


    // Vérifier que les nouvelles commandes sont présentes
    const addservorCmd = commands.find(cmd => cmd.name === 'addservor');

    if (addservorCmd) {
    } else {
    }

    // Flush les logs avant de continuer
    await new Promise(resolve => setTimeout(resolve, 100));

    // Vérifier que client.user existe
    if (!client.user || !client.user.id) {
      console.error('🔴 [DEBUG] ERREUR: client.user non défini!');
      throw new Error('Client user not available');
    }

    // Enregistrer globalement (prend jusqu'à 1h pour propager)
    try {
      await rest.put(
        Routes.applicationCommands(client.user.id),
        { body: commands }
      );
    } catch (putError) {
      console.error('🔴 [DEBUG] ERREUR dans rest.put:', putError);
      console.error('🔴 [DEBUG] Message:', putError.message);
      console.error('🔴 [DEBUG] Stack:', putError.stack);
      // Ne pas lancer l'erreur pour continuer avec les serveurs
    }
    
    // NOUVEAU: Enregistrer aussi pour chaque serveur (instantané)
    const guilds = client.guilds.cache;
    for (const [guildId, guild] of guilds) {
      try {
        await rest.put(
          Routes.applicationGuildCommands(client.user.id, guildId),
          { body: commands }
        );
      } catch (guildError) {
        console.error(`❌ Erreur pour ${guild.name}:`, guildError.message);
      }
    }
    
  } catch (error) {
    console.error('❌ Erreur enregistrement commandes:', error);
    console.error('Détails:', error.message);
  }
}

// 🆕 SYSTÈME DE BLACKLIST POUR SALONS AVEC ACCÈS REFUSÉ

// Filtrer les salons blacklistés (ne pas tenter le scraping)
async function filterBlacklistedChannels(channels, sourceGuildId) {
  try {
    const Channel = require('./models/Channel');
    const now = new Date();
    
    const accessibleChannels = [];
    
    for (const channel of channels) {
      // Vérifier si le salon est en base et blacklisté
      const channelDB = await Channel.findOne({ 
        name: channel.name,
        serverId: sourceGuildId 
      });
      
      if (channelDB && channelDB.isBlacklisted && channelDB.blacklistedUntil > now) {
        // Salon encore blacklisté, l'ignorer
        continue;
      } else if (channelDB && channelDB.isBlacklisted && channelDB.blacklistedUntil <= now) {
        // Blacklist expirée, réactiver le salon
        channelDB.isBlacklisted = false;
        channelDB.blacklistedUntil = null;
        channelDB.failedAttempts = 0;
        await channelDB.save();
        
      }
      
      accessibleChannels.push(channel);
    }
    
    return accessibleChannels;
  } catch (error) {
    console.error('❌ Erreur filtrage blacklist:', error);
    return channels; // Retourner tous les salons en cas d'erreur
  }
}

// Gérer les erreurs d'accès refusé (403) et blacklister après 2 échecs
async function handleChannelAccessDenied(sourceChannel, sourceGuildId, targetGuildId) {
  try {
    const Channel = require('./models/Channel');
    
    // Trouver ou créer l'entrée du salon en base
    let channelDB = await Channel.findOne({ 
      name: sourceChannel.name,
      serverId: sourceGuildId 
    });
    
    if (!channelDB) {
      // Créer l'entrée si elle n'existe pas
      channelDB = new Channel({
        discordId: sourceChannel.id,
        serverId: sourceGuildId,
        name: sourceChannel.name,
        scraped: false,
        failedAttempts: 0
      });
    }
    
    // 🚨 SI DÉJÀ BLACKLISTÉ : Ne rien faire, ignore silencieusement
    if (channelDB.isBlacklisted) {
      return; // Sortir sans logger ni incrémenter
    }
    
    // Incrémenter le compteur d'échecs SEULEMENT si pas encore blacklisté
    channelDB.failedAttempts += 1;
    channelDB.lastFailedAt = new Date();
    
    if (channelDB.failedAttempts >= 2) {
      // Blacklister jusqu'à 3:30 du matin suivant
      channelDB.isBlacklisted = true;
      channelDB.blacklistedUntil = getNext330AM();
      
      
      // Logger SEULEMENT lors du premier blacklist
      await client.services.logger.logError(
        targetGuildId,
        `🚫 Salon blacklisté: ${sourceChannel.name} (accès refusé ${channelDB.failedAttempts} fois)\n` +
        `⏰ Nouvelle tentative: ${channelDB.blacklistedUntil.toLocaleString('fr-FR')}\n` +
        `💡 Utilisez /cleanup include_blacklisted:true pour forcer la réactivation`,
        sourceChannel.name
      );
    } else {
      // 🆕 PREMIÈRE TENTATIVE : Seulement un log console, PAS dans #error
    }
    
    await channelDB.save();
    
  } catch (error) {
    console.error(`❌ Erreur gestion blacklist ${sourceChannel.name}:`, error);
  }
}

// Calculer la prochaine heure 3:30 du matin
function getNext330AM() {
  const now = new Date();
  const next330 = new Date();
  
  // Définir à 3:30 du matin
  next330.setHours(3, 30, 0, 0);
  
  // Si on est déjà passé 3:30 aujourd'hui, prendre demain
  if (now > next330) {
    next330.setDate(next330.getDate() + 1);
  }
  
  return next330;
}

// Réinitialiser toutes les blacklists (appelé à 3:30) - RESPECTE manuallyDeleted
async function resetChannelBlacklists() {
  try {
    const Channel = require('./models/Channel');

    // 🚀 OPTIMISATION: Clear le cache des salons définitivement inaccessibles
    if (client.services?.channelMonitor) {
      client.services.channelMonitor.permanentlyFailedChannels.clear();
    }

    // 🏷️ EXCLURE les salons marqués comme supprimés manuellement du reset
    const result = await Channel.updateMany(
      {
        isBlacklisted: true,
        $or: [
          { manuallyDeleted: { $ne: true } },
          { manuallyDeleted: { $exists: false } }
        ]
      },
      {
        $set: {
          isBlacklisted: false,
          blacklistedUntil: null,
          failedAttempts: 0
        }
      }
    );
    
    // Compter combien de salons étaient exclus du reset
    const excludedCount = await Channel.countDocuments({
      isBlacklisted: true,
      manuallyDeleted: true
    });
    
    if (result.modifiedCount > 0 || excludedCount > 0) {
      if (excludedCount > 0) {
      }
      
      // Logger dans tous les serveurs actifs
      const stats = client.services.userClient.getStats();
      for (const guildData of stats.guilds) {
        try {
          let logMessage = `🔄 Reset automatique blacklist: ${result.modifiedCount} salons réactivés\n⏰ Prochaine réactivation: demain 3:30`;
          if (excludedCount > 0) {
            logMessage += `\n🏷️ ${excludedCount} salon(s) marqué(s) manuellement conservé(s) en blacklist`;
          }
          
          // Log de reset va dans #admin-logs (action système)
          await client.services.logger.logAdminAction(
            guildData.guildId,
            logMessage
          );
        } catch (error) {
          // Ignorer les erreurs de log
        }
      }
    }
    
  } catch (error) {
    console.error('❌ Erreur reset blacklist:', error);
  }
}

// Auto-discovery automatique des salons
async function performAutoDiscovery(targetGuild, guildId) {
  try {
    
    // Récupérer les données du token utilisateur
    const userData = client.services.userClient.getUserData(guildId);
    const sourceGuild = client.services.userClient.getSourceGuild(guildId);
    
    // Récupérer tous les salons du serveur source (pas de threads via fetchGuildThreads car endpoint bot-only)
    const sourceChannels = await client.services.userClient.fetchGuildChannels(userData.token, sourceGuild.id);
    
    // Filtrer les salons texte, vocaux, annonces et forums
    const sourceTextChannels = sourceChannels.filter(ch =>
      ch.type === 0 ||  // TEXT
      ch.type === 2 ||  // VOICE
      ch.type === 5 ||  // NEWS (annonces)
      ch.type === 15    // FORUM (qui créent des threads)
    );
    const sourceCategories = sourceChannels.filter(ch => ch.type === 4); // CATEGORY
    
    // Récupérer les salons actuels du serveur mirror
    const mirrorChannels = targetGuild.channels.cache.filter(ch => ch.type === 0 || ch.type === 2 || ch.type === 5 || ch.type === 15);
    const mirrorCategories = targetGuild.channels.cache.filter(ch => ch.type === 4);
    
    let newChannelsCreated = 0;
    let channelsDeleted = 0;
    let categoriesCreated = 0;
    
    // 1. CRÉER LES NOUVELLES CATÉGORIES
    const categoryMap = new Map();
    
    // Mapper les catégories existantes
    for (const mirrorCat of mirrorCategories.values()) {
      const sourceCat = sourceCategories.find(sc => sc.name === mirrorCat.name);
      if (sourceCat) {
        categoryMap.set(sourceCat.id, mirrorCat);
      }
    }
    
    // Créer les nouvelles catégories
    for (const sourceCategory of sourceCategories) {
      const existingCategory = Array.from(mirrorCategories.values()).find(mc => mc.name === sourceCategory.name);
      if (!existingCategory) {
        // 🆕 VÉRIFIER SI LA CATÉGORIE A ÉTÉ SUPPRIMÉE MANUELLEMENT
        const Category = require('./models/Category');
        const manuallyDeletedCategory = await Category.findOne({
          name: sourceCategory.name,
          serverId: sourceGuild.id,
          manuallyDeleted: true
        });
        
        if (manuallyDeletedCategory) {
          continue; // Ignorer cette catégorie
        }
        
        try {
          const newCategory = await targetGuild.channels.create({
            name: sourceCategory.name,
            type: 4, // CategoryChannel
            position: sourceCategory.position
          });
          categoryMap.set(sourceCategory.id, newCategory);
          categoriesCreated++;
          
          await client.services.logger.logNewRoom(
            guildId,
            `Nouvelle catégorie: ${newCategory.name}`,
            'Auto-discovery'
          );
          
          
          // Délai pour éviter le rate limiting
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          console.error(`❌ Erreur création catégorie ${sourceCategory.name}:`, error);
        }
      }
    }
    
    // 2. CRÉER LES NOUVEAUX SALONS ET THREADS
    for (const sourceChannel of sourceTextChannels) {
      // Vérifier si le salon/thread existe déjà sur le mirror
      const existingChannel = Array.from(mirrorChannels.values()).find(mc => mc.name === sourceChannel.name);
      
      if (!existingChannel) {
        // 🏷️ MÉTHODE 2 : Vérifier si le salon a été supprimé manuellement
        const Channel = require('./models/Channel');
        const manuallyDeletedChannel = await Channel.findOne({
          name: sourceChannel.name,
          serverId: sourceGuild.id,
          manuallyDeleted: true
        });
        
        if (manuallyDeletedChannel) {
          continue; // Ignorer ce salon/thread
        }
        
        // 🧵 THREADS : Traitement spécial pour les threads
        if (sourceChannel.type === 11 || sourceChannel.type === 12) {
          
          try {
            // 🛡️ Tester l'accès avant de créer le thread
            await testChannelAccess(sourceChannel.id, userData, sourceGuild.id);
            
            // Pour les threads, on doit trouver le salon parent sur le mirror
            let parentChannel = null;
            if (sourceChannel.parent_id) {
              parentChannel = targetGuild.channels.cache.find(ch => {
                // Chercher par nom du parent sur la source
                const sourceParent = allSourceChannels.find(sc => sc.id === sourceChannel.parent_id);
                return sourceParent && ch.name === sourceParent.name;
              });
            }
            
            if (!parentChannel) {
              continue;
            }
            
            // Créer le thread sur le salon parent mirror
            const threadOptions = {
              name: sourceChannel.name,
              autoArchiveDuration: sourceChannel.thread_metadata?.auto_archive_duration || 1440,
              type: sourceChannel.type === 11 ? 'PUBLIC_THREAD' : 'PRIVATE_THREAD',
              reason: `Auto-discovery thread: ${sourceChannel.name}`
            };
            
            // Pour créer un thread, on a besoin d'un message de départ
            const startMessage = await parentChannel.send(`🧵 **Thread auto-créé**: ${sourceChannel.name}\n\n*Ce thread a été automatiquement créé pour mirrorer le contenu du serveur source.*`);
            
            const newThread = await startMessage.startThread(threadOptions);
            newChannelsCreated++;
            
            // Sauvegarder en base de données comme un salon classique avec l'ID source
            await client.services.channelManager.saveChannelToDatabase(newThread, sourceGuild.id, sourceChannel.id);
            
            // Logger la création avec mention cliquable
            await client.services.logger.logNewRoom(
              guildId,
              `🧵 <#${newThread.id}> (thread)`,
              parentChannel.name,
              newThread.id
            );
            
            
            // Délai pour éviter le rate limiting
            await new Promise(resolve => setTimeout(resolve, 2000));
            
          } catch (error) {
            if (error.isAccessError) {
              await autoBlacklistInaccessibleChannel(sourceChannel, sourceGuild.id, guildId, error.message);
            } else {
              console.error(`❌ Erreur création thread ${sourceChannel.name}:`, error);
              await client.services.logger.logError(
                guildId,
                `Erreur auto-création thread ${sourceChannel.name}: ${error.message}`
              );
            }
          }
          continue;
        }
        
        // 📺 SALONS CLASSIQUES ET FORUMS : Traitement normal
        // Vérifier si le salon doit être ignoré (filtrage anti rate-limit)
        let categoryName = null;
        if (sourceChannel.parent_id) {
          const parentCategory = sourceChannels.find(c => c.id === sourceChannel.parent_id && c.type === 4);
          categoryName = parentCategory ? parentCategory.name : null;
        }
        
        if (shouldIgnoreCategory(categoryName, sourceChannel.name)) {
          continue;
        }
        
        // 🆕 INITIALISER channelOptions AVANT LE TRY POUR ÉVITER "not defined"
        let channelOptions = null;
        
        try {
          // 🛡️ MÉTHODE 5 : Tester l'accès avant de créer le salon
          await testChannelAccess(sourceChannel.id, userData, sourceGuild.id);

          // 📢 GESTION SPÉCIALE POUR LES SALONS D'ANNONCES (type 5)
          if (sourceChannel.type === 5) {
            try {
              const { ChannelType } = require('discord.js');

              channelOptions = {
                name: sourceChannel.name,
                type: ChannelType.GuildAnnouncement, // 5
                topic: sourceChannel.topic || undefined,
                position: sourceChannel.position
              };

              // Assigner la catégorie si elle existe
              if (sourceChannel.parent_id && categoryMap.has(sourceChannel.parent_id)) {
                channelOptions.parent = categoryMap.get(sourceChannel.parent_id);
              }


              const newChannel = await targetGuild.channels.create(channelOptions);


              // Sauvegarder en base de données avec l'ID source
              await client.services.channelManager.saveChannelToDatabase(newChannel, sourceGuild.id, sourceChannel.id);

              // Logger la création avec mention cliquable
              await client.services.logger.logNewRoom(
                guildId,
                `📢 Nouveau salon d'annonces: <#${newChannel.id}>`,
                newChannel.parent?.name || 'Aucune',
                newChannel.id
              );

              newChannelsCreated++;

            } catch (newsError) {
              // 📢 FALLBACK SI LE SERVEUR NE SUPPORTE PAS LES SALONS D'ANNONCES
              if (newsError.code === 50035 || newsError.message.includes('COMMUNITY_SERVER_ONLY')) {

                // Créer comme salon texte avec topic adapté
                const fallbackOptions = {
                  name: sourceChannel.name,
                  type: 0, // Salon texte
                  topic: `📢 [Salon d'annonces] ${sourceChannel.topic || ''}`,
                  position: sourceChannel.position
                };

                if (sourceChannel.parent_id && categoryMap.has(sourceChannel.parent_id)) {
                  fallbackOptions.parent = categoryMap.get(sourceChannel.parent_id);
                }

                const fallbackChannel = await targetGuild.channels.create(fallbackOptions);
                await client.services.channelManager.saveChannelToDatabase(fallbackChannel, sourceGuild.id, sourceChannel.id);

                await client.services.logger.logNewRoom(
                  guildId,
                  `📢 Nouveau salon (converti de salon d'annonces): <#${fallbackChannel.id}>`,
                  fallbackChannel.parent?.name || 'Aucune',
                  fallbackChannel.id
                );

                newChannelsCreated++;
              } else {
                throw newsError;
              }
            }
          }
          // 🏛️ GESTION SPÉCIALE POUR LES SALONS FORUM (type 15)
          else if (sourceChannel.type === 15) {
            try {
              const { ChannelType } = require('discord.js');

              channelOptions = {
            name: sourceChannel.name,
                type: ChannelType.GuildForum, // 15
                topic: sourceChannel.topic || undefined, // undefined plutôt que null
                position: sourceChannel.position, // Synchroniser la position du forum
                // Propriétés OBLIGATOIRES pour les forums Discord.js v14
                defaultAutoArchiveDuration: 1440, // 24 heures (obligatoire)
                availableTags: [] // Tags disponibles (obligatoire, même vide)
          };

          // Assigner la catégorie si elle existe
          if (sourceChannel.parent_id && categoryMap.has(sourceChannel.parent_id)) {
            channelOptions.parent = categoryMap.get(sourceChannel.parent_id);
          }
              
              
              // 🛡️ TEST PRÉALABLE : Vérifier si le serveur supporte les forums
              const newChannel = await targetGuild.channels.create(channelOptions);
              
              
              // Sauvegarder en base de données avec l'ID source
              await client.services.channelManager.saveChannelToDatabase(newChannel, sourceGuild.id, sourceChannel.id);
              
              // Logger la création avec mention cliquable
              await client.services.logger.logNewRoom(
                guildId,
                `🏛️ Nouveau forum: <#${newChannel.id}>`,
                newChannel.parent?.name || 'Aucune',
                newChannel.id
              );
              
              newChannelsCreated++;
              
            } catch (forumError) {
              // 🏛️ FALLBACK SEULEMENT POUR LES ERREURS SPÉCIFIQUES DE NON-SUPPORT DES FORUMS
              if (forumError.code === 50035 && forumError.message.includes('COMMUNITY_SERVER_ONLY')) {
                
                // Créer comme salon texte avec topic adapté
                const fallbackOptions = {
                  name: sourceChannel.name,
                  type: 0, // TEXT
                  topic: `🏛️ Forum source: ${sourceChannel.name}\n\n${sourceChannel.topic || 'Forum converti automatiquement en salon texte car le serveur mirror ne supporte pas les forums.'}`,
                  position: sourceChannel.position
                };
                
                // Assigner la catégorie si elle existe
                if (sourceChannel.parent_id && categoryMap.has(sourceChannel.parent_id)) {
                  fallbackOptions.parent = categoryMap.get(sourceChannel.parent_id);
                }
                
                const fallbackChannel = await targetGuild.channels.create(fallbackOptions);
                
                
                // Sauvegarder en base de données avec l'ID source
                await client.services.channelManager.saveChannelToDatabase(fallbackChannel, sourceGuild.id, sourceChannel.id);
                
                // Logger la création avec mention cliquable et note de conversion
                await client.services.logger.logNewRoom(
                  guildId,
                  `📝 Forum→Texte: <#${fallbackChannel.id}> (serveur ne supporte pas les forums)`,
                  fallbackChannel.parent?.name || 'Aucune',
                  fallbackChannel.id
                );
                
                newChannelsCreated++;
              } else {
                // ✅ TOUTES LES AUTRES ERREURS : Échec réel de création du forum
                console.error(`❌ Erreur création forum ${sourceChannel.name}: ${forumError.message} (Code: ${forumError.code})`);
                throw forumError;
              }
            }
          } else {
            // Salons classiques (texte, vocal, etc.)
            channelOptions = {
              name: sourceChannel.name,
              type: sourceChannel.type,
              topic: sourceChannel.topic,
              position: sourceChannel.position
            };
          
          // Paramètres spécifiques aux salons vocaux
          if (sourceChannel.type === 2) {
            channelOptions.bitrate = sourceChannel.bitrate || 64000;
            channelOptions.userLimit = sourceChannel.user_limit || 0;
          }
            
            // Assigner la catégorie si elle existe
            if (sourceChannel.parent_id && categoryMap.has(sourceChannel.parent_id)) {
              channelOptions.parent = categoryMap.get(sourceChannel.parent_id);
          }
          
          const newChannel = await targetGuild.channels.create(channelOptions);
          newChannelsCreated++;
          
          // Sauvegarder en base de données avec l'ID source
          await client.services.channelManager.saveChannelToDatabase(newChannel, sourceGuild.id, sourceChannel.id);
          
          // Logger la création avec mention cliquable
          await client.services.logger.logNewRoom(
            guildId,
            `<#${newChannel.id}>`,
            newChannel.parent?.name || 'Aucune',
            newChannel.id
          );
          
            const channelTypeDisplay = sourceChannel.type === 2 ? 'vocal' : 'salon';
          }
          
          // Délai pour éviter le rate limiting
          await new Promise(resolve => setTimeout(resolve, 1500));
          
        } catch (error) {
          // 🛡️ MÉTHODE 5 : Gérer les erreurs d'accès spécifiquement
          if (error.isAccessError) {
            // Salon inaccessible, le blacklister automatiquement
            await autoBlacklistInaccessibleChannel(sourceChannel, sourceGuild.id, guildId, error.message);
          } else if (sourceChannel.type === 15) {
            // 🏛️ GESTION SPÉCIFIQUE ERREUR FORUM avec diagnostic détaillé
            console.error(`❌ ERREUR CRÉATION FORUM (autoDiscovery): ${sourceChannel.name}`);
            console.error(`   Code erreur: ${error.code}`);
            console.error(`   Message: ${error.message}`);
            console.error(`   Type salon: ${sourceChannel.type} (0=texte, 2=vocal, 15=forum)`);
            
            // Logger l'erreur détaillée pour investigation
            await client.services.logger.logAdminAction(
              guildId,
              `❌ **ÉCHEC CRÉATION FORUM (autoDiscovery)**\n` +
              `📛 Forum: \`${sourceChannel.name}\`\n` +
              `❌ Code: \`${error.code || 'N/A'}\`\n` +
              `💬 Message: \`${error.message}\`\n` +
              `🔧 Type: \`${sourceChannel.type}\` (15=forum)\n` +
              `💡 **ACTION REQUISE:** Activer les fonctionnalités communautaires sur le serveur mirror pour supporter les forums`
            );
            
            console.error(`❌ Forum ${sourceChannel.name} ignoré - Fonctionnalités communautaires requises`);
            
            await client.services.logger.logError(
              guildId,
              `Erreur auto-création forum ${sourceChannel.name}: ${error.message} (Code: ${error.code || 'N/A'}) - Vérifiez que les fonctionnalités communautaires sont activées`
            );
          } else {
            console.error(`❌ Erreur création salon ${sourceChannel.name}:`, error);
            
            await client.services.logger.logError(
              guildId,
              `Erreur auto-création salon ${sourceChannel.name}: ${error.message}`
            );
          }
        }
      }
    }
    
    // 3. SUPPRIMER LES SALONS QUI N'EXISTENT PLUS SUR LA SOURCE
    for (const mirrorChannel of mirrorChannels.values()) {
      // 🛡️ PROTECTION CENTRALISÉE : Utiliser le système de protection unifié
      if (checkAndLogProtection(mirrorChannel.name, mirrorChannel.id, 'auto-discovery')) {
        continue;
      }
      
      // 🛡️ PROTECTION CATÉGORIE : Ignorer TOUS les salons de la catégorie Maintenance
      if (mirrorChannel.parent && 
          (mirrorChannel.parent.name.toLowerCase().includes('maintenance') || 
           mirrorChannel.parent.name === '🔧 Maintenance')) {
        continue;
      }
      
      // Vérifier si le salon existe encore sur la source
      const sourceExists = sourceTextChannels.find(sc => sc.name === mirrorChannel.name);
      
      if (!sourceExists) {
        try {
          // Supprimer de la base de données d'abord
          const Channel = require('./models/Channel');
          await Channel.deleteOne({ discordId: mirrorChannel.id });
          
          // Supprimer le salon Discord
          await mirrorChannel.delete();
          channelsDeleted++;
          
          // Logger la suppression vers #admin-logs (pas #newroom)
          await client.services.logger.logAdminAction(
            guildId,
            `🗑️ **Salon supprimé** (n'existe plus sur la source): ${mirrorChannel.name}\n` +
            `📁 Catégorie: Auto-discovery`
          );
          
          
          // Délai pour éviter le rate limiting
          await new Promise(resolve => setTimeout(resolve, 1000));
          
        } catch (error) {
          console.error(`❌ Erreur suppression salon ${mirrorChannel.name}:`, error);
          
          await client.services.logger.logError(
            guildId,
            `Erreur auto-suppression salon ${mirrorChannel.name}: ${error.message}`
          );
        }
      }
    }
    
    // 4. 🆕 AUTO-DISCOVERY DES RÔLES
    let newRolesCreated = 0;
    let rolesDeleted = 0;
    let rolesUpdated = 0;
    
    // 🔧 INITIALISER LES VARIABLES DE SÉCURITÉ AVANT LE TRY POUR ÉVITER "not defined"
    let securedRolesCount = 0;
    let adminRolesSecured = 0;
    
    try {
      
      // Récupérer les rôles du serveur source
      const sourceRoles = await client.services.userClient.fetchGuildRoles(userData.token, sourceGuild.id);
      
      // Filtrer les rôles à synchroniser (exclure @everyone et rôles managés)
      const rolesToSync = sourceRoles.filter(role => 
        role.name !== '@everyone' && 
        !role.managed &&
        !['ladmin', 'lmembres'].includes(role.name) // Préserver les rôles système du mirror
      );
      
      // CRÉER/METTRE À JOUR LES NOUVEAUX RÔLES AVEC FILTRAGE SÉCURISÉ
      
      for (const sourceRole of rolesToSync) {
        try {
          // 🔒 ANALYSER ET FILTRER LES PERMISSIONS POUR LA SÉCURITÉ
          const permissionAnalysis = analyzeRolePermissions(sourceRole);
          const safePermissions = filterSafePermissions(sourceRole.permissions);
          
          // 🔍 COMPTER LES RÔLES SÉCURISÉS
          if (permissionAnalysis.filteringRequired) {
            securedRolesCount++;
            if (permissionAnalysis.hasAdministrator) {
              adminRolesSecured++;
            }
          }
          
          let existingRole = targetGuild.roles.cache.find(role => role.name === sourceRole.name);
          
          if (existingRole) {
            // Mettre à jour le rôle existant si nécessaire (avec permissions filtrées)
            const needsUpdate = 
              existingRole.color !== sourceRole.color ||
              existingRole.hoist !== sourceRole.hoist ||
              existingRole.mentionable !== sourceRole.mentionable;
            
            if (needsUpdate) {
              await existingRole.edit({
                color: sourceRole.color,
                hoist: sourceRole.hoist,
                mentionable: sourceRole.mentionable,
                permissions: safePermissions // 🔒 PERMISSIONS FILTRÉES
              });
              rolesUpdated++;
              
              // 🔍 LOG AVEC INFO SÉCURITÉ SI NÉCESSAIRE
              let logMessage = `🔄 Rôle mis à jour: ${sourceRole.name} (auto-discovery)`;
              if (permissionAnalysis.filteringRequired) {
                logMessage += `\n🔒 **SÉCURISÉ** - ${permissionAnalysis.dangerousPermissionsCount} permissions dangereuses supprimées`;
                if (permissionAnalysis.hasAdministrator) {
                  logMessage += `\n🚫 **ADMIN NEUTRALISÉ** - Permission Administrator supprimée`;
                }
              }
              
              await client.services.logger.logRoleAction(guildId, logMessage);
              
            }
          } else {
            // Créer un nouveau rôle avec permissions filtrées
            const newRole = await targetGuild.roles.create({
              name: sourceRole.name,
              color: sourceRole.color,
              permissions: safePermissions, // 🔒 PERMISSIONS FILTRÉES
              hoist: sourceRole.hoist,
              mentionable: sourceRole.mentionable
            });
            newRolesCreated++;
            
            // Sauvegarder en base de données
            await client.services.roleManager.saveRoleToDatabase(newRole, sourceGuild.id);
            
            // 🔍 LOG AVEC INFO SÉCURITÉ SI NÉCESSAIRE
            let logMessage = `✅ Nouveau rôle créé: ${sourceRole.name} (auto-discovery)`;
            if (permissionAnalysis.filteringRequired) {
              logMessage += `\n🔒 **SÉCURISÉ** - ${permissionAnalysis.dangerousPermissionsCount} permissions dangereuses supprimées`;
              if (permissionAnalysis.hasAdministrator) {
                logMessage += `\n🚫 **ADMIN NEUTRALISÉ** - Permission Administrator supprimée`;
              }
            }
            
            await client.services.logger.logRoleAction(guildId, logMessage);
            
          }
          
          // Délai pour éviter le rate limiting
          await new Promise(resolve => setTimeout(resolve, 800));
          
        } catch (error) {
          console.error(`❌ Erreur rôle ${sourceRole.name}:`, error);
          
          await client.services.logger.logRoleAction(
            guildId,
            `❌ Erreur auto-sync rôle ${sourceRole.name}: ${error.message}`
          );
        }
      }
      
      // SUPPRIMER LES RÔLES QUI N'EXISTENT PLUS SUR LA SOURCE
      const sourceRoleNames = new Set(rolesToSync.map(r => r.name));
      const mirrorRoles = targetGuild.roles.cache.filter(role => 
        role.name !== '@everyone' && 
        !role.managed &&
        !['ladmin', 'lmembres'].includes(role.name)
      );
      
      for (const mirrorRole of mirrorRoles.values()) {
        if (!sourceRoleNames.has(mirrorRole.name)) {
          try {
            // Supprimer de la base de données d'abord
            const Role = require('./models/Role');
            await Role.deleteOne({ discordId: mirrorRole.id });
            
            // Supprimer le rôle Discord
            await mirrorRole.delete();
            rolesDeleted++;
            
            await client.services.logger.logRoleAction(
              guildId,
              `🗑️ Rôle supprimé (n'existe plus sur la source): ${mirrorRole.name} (auto-discovery)`
            );
            
            
            // Délai pour éviter le rate limiting
            await new Promise(resolve => setTimeout(resolve, 600));
            
          } catch (error) {
            console.error(`❌ Erreur suppression rôle ${mirrorRole.name}:`, error);
            
            await client.services.logger.logRoleAction(
              guildId,
              `❌ Erreur auto-suppression rôle ${mirrorRole.name}: ${error.message}`
            );
          }
        }
      }
      
    } catch (error) {
      console.error(`❌ Erreur auto-discovery rôles:`, error);

      await client.services.logger.logRoleAction(
        guildId,
        `❌ Erreur auto-discovery rôles: ${error.message}`
      );
    }

    // 4.5 🔄 SYNCHRONISATION DES POSITIONS (catégories + salons)
    let categoriesRepositioned = 0;
    let channelsRepositioned = 0;

    console.log(`\n🔄 [POSITION-SYNC] Début synchronisation des positions...`);

    try {
      // Collecter les repositionnements nécessaires
      const categoryPositionChanges = [];
      const channelPositionChanges = [];

      // 4.5.1 Sync positions des CATÉGORIES
      for (const sourceCategory of sourceCategories) {
        // Trouver la catégorie mirror par nom (pattern existant ligne 8942)
        const mirrorCategory = Array.from(mirrorCategories.values()).find(mc => mc.name === sourceCategory.name);

        if (mirrorCategory && mirrorCategory.position !== sourceCategory.position) {
          categoryPositionChanges.push({
            channel: mirrorCategory.id,
            position: sourceCategory.position
          });
          categoriesRepositioned++;
          console.log(`📁 Position catégorie différente: "${sourceCategory.name}" (mirror: ${mirrorCategory.position} → source: ${sourceCategory.position})`);
        }
      }

      // 4.5.2 Sync positions des SALONS (types 0, 2, 5, 15)
      for (const sourceChannel of sourceTextChannels) {
        // Trouver le salon mirror par nom
        const mirrorChannel = Array.from(mirrorChannels.values()).find(mc => mc.name === sourceChannel.name);

        if (!mirrorChannel) continue;

        // Protection: Skip les salons système (Maintenance, mention-logs, etc.)
        if (checkAndLogProtection(mirrorChannel.name, mirrorChannel.id, 'position-sync')) {
          continue;
        }

        // Vérifier si la position est différente
        if (mirrorChannel.position !== sourceChannel.position) {
          channelPositionChanges.push({
            channel: mirrorChannel.id,
            position: sourceChannel.position
          });
          channelsRepositioned++;
          console.log(`📍 Position salon différente: #${sourceChannel.name} (mirror: ${mirrorChannel.position} → source: ${sourceChannel.position})`);
        }
      }

      // 4.5.3 Appliquer les repositionnements en BULK (discord.js v14)
      // Catégories d'abord (important pour l'ordre visuel)
      if (categoryPositionChanges.length > 0) {
        try {
          await targetGuild.channels.setPositions(categoryPositionChanges);
          console.log(`✅ [POSITION-SYNC] ${categoryPositionChanges.length} catégorie(s) repositionnée(s)`);
        } catch (posError) {
          console.error(`⚠️ Erreur repositionnement catégories:`, posError.message);
          // Pas de throw, continuer avec les salons
        }
      }

      // Puis salons
      if (channelPositionChanges.length > 0) {
        try {
          await targetGuild.channels.setPositions(channelPositionChanges);
          console.log(`✅ [POSITION-SYNC] ${channelPositionChanges.length} salon(s) repositionné(s)`);
        } catch (posError) {
          console.error(`⚠️ Erreur repositionnement salons:`, posError.message);
          // Pas de throw, continuer vers le rapport
        }
      }

      // Log si rien à repositionner
      if (categoryPositionChanges.length === 0 && channelPositionChanges.length === 0) {
        console.log(`✅ [POSITION-SYNC] Toutes les positions sont déjà synchronisées`);
      }

    } catch (error) {
      console.error(`❌ Erreur sync positions:`, error);

      await client.services.logger.logError(
        guildId,
        `Erreur sync positions: ${error.message}`
      );
    }

    // 5. RAPPORT FINAL (salons + rôles + positions + sécurité)
    const totalChanges = newChannelsCreated + channelsDeleted + categoriesCreated + newRolesCreated + rolesDeleted + rolesUpdated + categoriesRepositioned + channelsRepositioned;

    if (totalChanges > 0) {
      let reportMessage = `🔍 Auto-discovery terminée:\n` +
        `**📁 SALONS:**\n` +
        `• 📁 ${categoriesCreated} nouvelles catégories\n` +
        `• ✅ ${newChannelsCreated} nouveaux salons créés\n` +
        `• 🗑️ ${channelsDeleted} salons supprimés\n` +
        `**🎭 RÔLES:**\n` +
        `• ✅ ${newRolesCreated} nouveaux rôles créés\n` +
        `• 🔄 ${rolesUpdated} rôles mis à jour\n` +
        `• 🗑️ ${rolesDeleted} rôles supprimés\n`;

      // 🔄 AJOUTER INFORMATIONS POSITIONS SI APPLICABLE
      if (categoriesRepositioned > 0 || channelsRepositioned > 0) {
        reportMessage += `**🔄 POSITIONS:**\n` +
          `• 📁 ${categoriesRepositioned} catégories repositionnées\n` +
          `• 📍 ${channelsRepositioned} salons repositionnés\n`;
      }

      // 🔒 AJOUTER INFORMATIONS DE SÉCURITÉ SI APPLICABLE
      if (securedRolesCount > 0) {
        reportMessage += `**🔒 SÉCURITÉ:**\n` +
          `• 🛡️ ${securedRolesCount} rôles sécurisés (permissions filtrées)\n` +
          `• 🚫 ${adminRolesSecured} rôles admin neutralisés\n` +
          `• ✅ **Serveur mirror PROTÉGÉ** contre élévation admin`;
      }

      reportMessage += `\n**🎯 Source:** ${sourceGuild.name}`;
      
      await client.services.logger.logAdminAction(guildId, reportMessage);
      
      if (securedRolesCount > 0) {
      }
    } else {
    }
    
  } catch (error) {
    console.error(`❌ Erreur auto-discovery ${targetGuild.name}:`, error);
    
    await client.services.logger.logError(
      guildId,
      `Erreur auto-discovery: ${error.message}`
    );
  }
}

// 🛡️ MÉTHODE 5 : Tester l'accès à un salon avant de le créer
async function testChannelAccess(channelId, userData, sourceGuildId) {
  try {
    
    // Essayer de récupérer quelques messages pour tester l'accès réel
    const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
    const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=1`, {
      headers: {
        'Authorization': userData.token,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    if (response.status === 403) {
      // Accès refusé (Forbidden)
      const error = new Error(`Accès refusé au salon ${channelId} (403 Forbidden)`);
      error.isAccessError = true;
      error.statusCode = 403;
      throw error;
    } else if (response.status === 404) {
      // Salon introuvable
      const error = new Error(`Salon ${channelId} introuvable (404 Not Found)`);
      error.isAccessError = true;
      error.statusCode = 404;
      throw error;
    } else if (!response.ok) {
      // Autre erreur
      const error = new Error(`Erreur d'accès au salon ${channelId} (${response.status})`);
      error.isAccessError = true;
      error.statusCode = response.status;
      throw error;
    }
    
    return true;
    
  } catch (error) {
    if (error.isAccessError) {
      throw error; // Re-lancer les erreurs d'accès
    }
    
    // Erreur réseau ou autre - considérer comme problème d'accès
    console.error(`❌ Erreur lors du test d'accès au salon ${channelId}:`, error.message);
    const accessError = new Error(`Impossible de tester l'accès au salon ${channelId}: ${error.message}`);
    accessError.isAccessError = true;
    accessError.originalError = error;
    throw accessError;
  }
}

// 🛡️ MÉTHODE 5 : Blacklister automatiquement un salon inaccessible
async function autoBlacklistInaccessibleChannel(sourceChannel, sourceGuildId, targetGuildId, reason) {
  try {
    const Channel = require('./models/Channel');
    
    // D'abord, essayer de récupérer le document existant par discordId
    let channelDB = await Channel.findOne({ discordId: sourceChannel.id });
    
    let isFirstTimeBlacklist = false;
    
    if (channelDB) {
      // Le salon existe déjà - vérifier s'il était déjà blacklisté
      isFirstTimeBlacklist = !channelDB.isBlacklisted;
      
      // 🏷️ VÉRIFIER SI LE SALON EST MARQUÉ COMME SUPPRIMÉ MANUELLEMENT
      if (channelDB.manuallyDeleted) {
        
        // Mettre à jour silencieusement le blacklist (sans log spam)
        channelDB.isBlacklisted = true;
        channelDB.blacklistedUntil = getNext330AM();
        channelDB.scraped = false;
        channelDB.lastFailedAt = new Date();
        channelDB.failedAttempts = (channelDB.failedAttempts || 0) + 1;
        
        await channelDB.save();
        return true; // Succès silencieux
      }
      
      // Mettre à jour le document existant
      channelDB.isBlacklisted = true;
      channelDB.blacklistedUntil = getNext330AM();
      channelDB.lastFailedAt = new Date();
      channelDB.scraped = false;
      channelDB.failedAttempts = (channelDB.failedAttempts || 0) + 1;
      
      // Mettre à jour le nom si il a changé (cas de renommage)
      if (channelDB.name !== sourceChannel.name) {
        channelDB.name = sourceChannel.name;
      }
      
      await channelDB.save();
      
    } else {
      // Le salon n'existe pas - le créer avec blacklist
      isFirstTimeBlacklist = true;
      
      try {
        // Utiliser findOneAndUpdate avec upsert pour éviter les doublons
        channelDB = await Channel.findOneAndUpdate(
          { sourceChannelId: sourceChannel.id, serverId: sourceGuildId },
          {
            discordId: sourceChannel.id,
            serverId: sourceGuildId,
            sourceChannelId: sourceChannel.id,
            name: sourceChannel.name,
            category: null, // On ne peut pas récupérer la catégorie si inaccessible
            scraped: false,
            failedAttempts: 1,
            isBlacklisted: true,
            blacklistedUntil: getNext330AM(),
            lastFailedAt: new Date(),
            // Retiré: lastActivity - ne pas mettre à jour lors des erreurs
            isActive: true
          },
          { upsert: true, new: true }
        );
      } catch (createError) {
        // Si erreur E11000, c'est une condition de concurrence - réessayer avec update
        if (createError.code === 11000) {
          
          channelDB = await Channel.findOneAndUpdate(
            { discordId: sourceChannel.id },
            {
              $set: {
                isBlacklisted: true,
                blacklistedUntil: getNext330AM(),
                lastFailedAt: new Date(),
                scraped: false,
                name: sourceChannel.name // Mettre à jour le nom au cas où
              },
              $inc: { failedAttempts: 1 }
            },
            { new: true }
          );
          
          // Dans ce cas, on ne sait pas si c'était le premier blacklist
          isFirstTimeBlacklist = false;
        } else {
          throw createError;
        }
      }
    }
    
    // 🔕 NOTIFICATION DANS ADMIN-LOGS SEULEMENT POUR LE PREMIER BLACKLIST
    if (isFirstTimeBlacklist) {
      
      await client.services.logger.logAdminAction(
        targetGuildId,
        `🚫 **Auto-blacklist salon inaccessible**\n` +
        `🏷️ **Salon :** #${sourceChannel.name}\n` +
        `❌ **Raison :** ${reason}\n` +
        `⏰ **Réactivation :** ${channelDB.blacklistedUntil.toLocaleString('fr-FR')}\n` +
        `🛡️ **Auto-discovery ne tentera plus de créer ce salon**`
      );
    } else {
      // 🚀 OPTIMISATION: Limiter les logs de re-blacklist (même logique que channelMonitor)
      const MAX_SILENT_RETRIES = 10;
      const failedAttempts = channelDB.failedAttempts || 0;

      if (failedAttempts <= MAX_SILENT_RETRIES) {
        // Log normal pour les premières tentatives
      } else if (failedAttempts === MAX_SILENT_RETRIES + 1) {
        // Un seul log après la limite
      }
      // Après MAX_SILENT_RETRIES : Plus aucun log
    }
    
    return true;
    
  } catch (error) {
    console.error(`❌ Erreur lors de l'auto-blacklist du salon ${sourceChannel.name}:`, error);
    
    // Logger l'erreur
    try {
      await client.services.logger.logError(
        targetGuildId,
        `Erreur auto-blacklist salon ${sourceChannel.name}: ${error.message}`
      );
    } catch (logError) {
      // Ignorer les erreurs de log
    }
    
    return false;
  }
}

// Configuration des tâches cron
function setupCronJobs() {
  // Nettoyage quotidien des logs
  cron.schedule('0 3 * * *', async () => {
    await client.services.logger.cleanupOldLogs();
  });
  
  // 🆕 Reset automatique des blacklists à 3:30 du matin
  cron.schedule('30 3 * * *', async () => {
    await resetChannelBlacklists();
  });

  // 🧹 Nettoyage automatique des données > 30 jours toutes les 6 heures
  cron.schedule('0 */6 * * *', async () => {
    
    // Nettoyer les données de plus de 30 jours
    if (client.services.dataCleanup) {
      try {
        const cleanupStats = await client.services.dataCleanup.performFullCleanup();
        if (cleanupStats.totalDeleted > 0) {
        }
      } catch (error) {
        console.error('❌ Erreur lors du nettoyage des données:', error.message);
      }
    }
  });

  // 🧠 Nettoyage mémoire périodique toutes les 6 heures
  cron.schedule('30 */6 * * *', () => {
    try {
      const mem = process.memoryUsage();
      const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(1);
      const rssMB = (mem.rss / 1024 / 1024).toFixed(1);
      console.log(`📊 [Memory] Heap: ${heapMB}MB | RSS: ${rssMB}MB`);

      // Vider les caches du correspondenceManager
      if (client.services.scraper?.correspondenceManager) {
        const cm = client.services.scraper.correspondenceManager;
        const channelSize = cm.channelCache.size;
        const roleSize = cm.roleCache.size;
        cm.clearCache();
        if (channelSize > 0 || roleSize > 0) {
          console.log(`🧹 [Memory] CorrespondenceManager caches vidés (channels: ${channelSize}, roles: ${roleSize})`);
        }
      }

      // Vider le failedChannelCache du userClient
      if (client.services.userClient?.failedChannelCache) {
        const size = client.services.userClient.failedChannelCache.size;
        if (size > 0) {
          client.services.userClient.failedChannelCache.clear();
          console.log(`🧹 [Memory] failedChannelCache vidé (${size} entrées)`);
        }
      }

      // Log post-cleanup
      const memAfter = process.memoryUsage();
      const heapAfterMB = (memAfter.heapUsed / 1024 / 1024).toFixed(1);
      console.log(`📊 [Memory] Post-cleanup Heap: ${heapAfterMB}MB (${heapMB > heapAfterMB ? '-' : '+'}${Math.abs(heapMB - heapAfterMB).toFixed(1)}MB)`);
    } catch (error) {
      console.error('❌ Erreur nettoyage mémoire:', error.message);
    }
  });

  // 🧹 Nettoyage automatique des salons supprimés toutes les 6 heures
  cron.schedule('0 */6 * * *', async () => {
    
    try {
      const stats = client.services.userClient.getStats();
      let totalCleaned = 0;
      
      for (const guildData of stats.guilds) {
        try {
          const targetGuild = client.guilds.cache.get(guildData.guildId);
          if (targetGuild && client.services.userClient.hasUserToken(guildData.guildId)) {
            const sourceGuild = client.services.userClient.getSourceGuild(guildData.guildId);
            const cleaned = await cleanupAllDeletedMirrorChannels(targetGuild, sourceGuild.id);
            totalCleaned += cleaned;
          }
        } catch (error) {
          console.error(`❌ Erreur nettoyage programmé pour ${guildData.guildId}:`, error);
        }
      }
      
      if (totalCleaned > 0) {
      }
      
    } catch (error) {
      console.error('❌ Erreur nettoyage programmé global:', error);
    }
  });
  
  // Auto-discovery quotidienne à 4h du matin
  cron.schedule('0 4 * * *', async () => {
    const stats = client.services.userClient.getStats();
    
    for (const guildData of stats.guilds) {
      try {
        const targetGuild = client.guilds.cache.get(guildData.guildId);
        if (targetGuild && client.services.userClient.hasUserToken(guildData.guildId)) {
          await performAutoDiscovery(targetGuild, guildData.guildId);
        }
      } catch (error) {
        console.error(`❌ Auto-discovery pour ${guildData.guildId}:`, error);
      }
    }
  });

  // 📊 Tracking quotidien des membres à 5h du matin
  cron.schedule('0 5 * * *', async () => {
    try {
      await client.services.memberTracker.trackAllServers();
    } catch (error) {
      console.error('❌ Erreur tracking quotidien des membres:', error);
    }
  });

  // 🔍 Scan hebdomadaire complet des membres (dimanche 3h30 du matin)
  // Utilise toutes les méthodes de détection pour maximiser la couverture
  cron.schedule('30 3 * * 0', async () => {
    console.log('📊 [Cron] Début du scan hebdomadaire des membres...');

    try {
      const stats = client.services.userClient.getStats();

      if (!stats.guilds || stats.guilds.length === 0) {
        console.log('📊 [Cron] Aucun serveur configuré pour le scan');
        return;
      }

      for (const guildData of stats.guilds) {
        try {
          console.log(`📊 [Cron] Scan de ${guildData.guildId}...`);

          // Récupérer le sourceGuildId depuis la config
          const ServerConfig = require('./models/ServerConfig');
          const serverConfig = await ServerConfig.findOne({ guildId: guildData.guildId });

          if (!serverConfig?.sourceGuildId) {
            console.log(`  ⚠️ Pas de sourceGuildId configuré pour ${guildData.guildId}`);
            continue;
          }

          // Lancer le scan complet (thorough: true pour brute force)
          const result = await client.services.memberDetection.detectAllMembers(
            serverConfig.sourceGuildId,
            guildData.guildId,
            { thorough: true, saveToDb: true }
          );

          if (result) {
            console.log(`  ✅ ${result.stats.totalUnique} membres détectés (${result.stats.coverage}%)`);
          }

          // Attendre entre les serveurs pour éviter les rate limits
          await new Promise(resolve => setTimeout(resolve, 10000));

        } catch (error) {
          console.error(`❌ Erreur scan hebdomadaire pour ${guildData.guildId}:`, error.message);
        }
      }

      console.log('📊 [Cron] Scan hebdomadaire terminé');

    } catch (error) {
      console.error('❌ Erreur globale scan hebdomadaire:', error);
    }
  });
}

// Nettoyage lors de la fermeture
process.on('SIGINT', async () => {
  
  // Arrêter la surveillance automatique
  if (client.services.channelMonitor) {
    client.services.channelMonitor.stopMonitoring();
  }
  
  // Le nouveau système UserClientService se nettoie automatiquement
  
  process.exit(0);
});

// Gestion des erreurs non capturées
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.log('❌ Exception non gérée - Arrêt du bot');
  process.exit(1);
});

// Démarrage du bot
console.log('🤖 Démarrage du bot Discord Mirror...');

async function handleClone(interaction) {
  const permissionCheck = checkAdminPermission(interaction);
  if (!permissionCheck.hasPermission) {
    await interaction.reply(permissionCheck.error);
    return;
  }
  
  await interaction.deferReply();

  try {
    const sourceGuild = client.services.userClient.getSourceGuild(interaction.guild.id);

    if (!sourceGuild) {
      await interaction.editReply('❌ Configuration serveur source manquante. Vérifiez SERVER_ID dans les variables d\'environnement Coolify.');
      return;
    }

    const filterInactive = interaction.options.getBoolean('filter_inactive') ?? true;

    await interaction.editReply('🔄 **Clonage en cours...**\n\nCela peut prendre plusieurs minutes selon le nombre de salons.\n⏳ Veuillez patienter...');

    // Récupérer les données du token utilisateur
    const userData = client.services.userClient.getUserData(interaction.guild.id);

    // Récupérer les salons du serveur source via API directe
    const sourceChannels = await client.services.userClient.fetchGuildChannels(userData.token, sourceGuild.id);
    
    // Filtrer les salons texte, vocaux, annonces et forums
    const textChannels = sourceChannels.filter(ch => ch.type === 0 || ch.type === 2 || ch.type === 5 || ch.type === 15); // TEXT, VOICE, NEWS ou FORUM
    const categories = sourceChannels.filter(ch => ch.type === 4); // CATEGORY
    
    let clonedCount = 0;
    let errorCount = 0;
    
    // Créer les catégories d'abord
    const categoryMap = new Map();
    for (const category of categories) {
      try {
        const newCategory = await interaction.guild.channels.create({
          name: category.name,
          type: 4, // CategoryChannel
          position: category.position
        });
        categoryMap.set(category.id, newCategory);
      } catch (error) {
        console.error(`Erreur création catégorie ${category.name}:`, error);
        errorCount++;
      }
    }
    
    // Créer les salons
    for (const channel of textChannels) {
      try {
        // Vérifier si le salon existe déjà
        const existingChannel = interaction.guild.channels.cache.find(ch => ch.name === channel.name);
        if (existingChannel) {
          continue;
        }
        
        let channelOptions;
        
        // 🏛️ GESTION SPÉCIALE POUR LES SALONS FORUM (type 15)
        if (channel.type === 15) {
          const { ChannelType } = require('discord.js');

          channelOptions = {
            name: channel.name,
            type: ChannelType.GuildForum, // 15
            topic: channel.topic || undefined, // undefined plutôt que null
            position: channel.position, // Synchroniser la position du forum
            // Propriétés OBLIGATOIRES pour les forums Discord.js v14
            defaultAutoArchiveDuration: 1440, // 24 heures (obligatoire)
            availableTags: [] // Tags disponibles (obligatoire, même vide)
          };

        }
        // 📢 GESTION SPÉCIALE POUR LES SALONS D'ANNONCES (type 5)
        else if (channel.type === 5) {
          const { ChannelType } = require('discord.js');

          channelOptions = {
            name: channel.name,
            type: ChannelType.GuildAnnouncement, // 5 (nouveau nom dans discord.js v14)
            topic: channel.topic || undefined,
            position: channel.position
          };

        } else {
          // Salons classiques (texte, vocal, etc.)
          channelOptions = {
          name: channel.name,
          type: channel.type,
          topic: channel.topic,
          position: channel.position
        };
        
        // Paramètres spécifiques aux salons vocaux
        if (channel.type === 2) {
          channelOptions.bitrate = channel.bitrate || 64000;
          channelOptions.userLimit = channel.user_limit || 0;
          }
        }
        
        // Assigner la catégorie si elle existe (pour tous les types)
        if (channel.parent_id && categoryMap.has(channel.parent_id)) {
          channelOptions.parent = categoryMap.get(channel.parent_id);
        }
        
        const newChannel = await interaction.guild.channels.create(channelOptions);
        clonedCount++;
        
        // Supprimer les anciens mappings obsolètes pour ce sourceChannelId
        const Channel = require('./models/Channel');
        await Channel.deleteMany({
          sourceChannelId: channel.id,
          serverId: sourceGuild.id,
          discordId: { $ne: newChannel.id }
        });

        // Enregistrer la correspondance complète dans la DB avec sourceChannelId
        await Channel.findOneAndUpdate(
          { sourceChannelId: channel.id, serverId: sourceGuild.id },
          {
            discordId: newChannel.id,
            sourceChannelId: channel.id,  // ID du salon source
            serverId: sourceGuild.id,
            name: channel.name,
            category: newChannel.parent?.name || null,
            scraped: true,
            delayMinutes: 5,
            inactive: false,
            // Retiré: lastActivity - ne pas mettre à jour lors de création manuelle
            isActive: true
          },
          { upsert: true, new: true }
        );
        
        // Enregistrer aussi dans correspondenceManager pour le cache
        if (client.services.correspondenceManager) {
          await client.services.correspondenceManager.registerChannelMapping(
            channel.id,           // sourceChannelId
            sourceGuild.id,       // sourceGuildId  
            channel.name,         // channelName
            newChannel.id         // mirrorChannelId
          );
        }
        
        // Logger la création avec mention cliquable
        await client.services.logger.logNewRoom(
          interaction.guild.id,
          `<#${newChannel.id}>`,
          newChannel.parent?.name || 'Aucune',
          newChannel.id
        );
        
        
        // Délai pour éviter les rate limits
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (error) {
        console.error(`Erreur clonage salon ${channel.name}:`, error);
        errorCount++;
        
        await client.services.logger.logError(
          interaction.guild.id,
          `Erreur clonage ${channel.name}: ${error.message}`
        );
      }
    }
    
    await interaction.editReply(
      `✅ **Clonage terminé !**\n\n` +
      `📁 **Salons créés:** ${clonedCount}\n` +
      `📁 **Catégories créées:** ${categoryMap.size}\n` +
      `❌ **Erreurs:** ${errorCount}\n` +
      `📝 **Filtrage inactifs:** ${filterInactive ? 'Activé' : 'Désactivé'}\n` +
      `🏠 **Serveur source:** ${sourceGuild.name}\n\n` +
      `ℹ️ Consultez #newroom pour voir les détails des salons créés\n` +
      `🔄 **Prochaine étape :** Utilisez \`/syncroles\` puis \`/start\` pour démarrer le scraping`
    );
  } catch (error) {
    console.log('❌ Clonage: Échec global');
    await interaction.editReply(`❌ Erreur lors du clonage: ${error.message}`);
  }
}

// 🆕 SYSTÈME DE NETTOYAGE AUTOMATIQUE POUR SALONS MIRROR SUPPRIMÉS

// Nettoyer automatiquement un salon mirror supprimé (avec respect du marquage manuel)
async function cleanupDeletedMirrorChannel(channelName, sourceGuildId, targetGuildId, reason = 'Salon mirror supprimé manuellement') {
  try {
    // 🛡️ PROTECTION ABSOLUE : Utiliser le système centralisé de protection
    if (checkAndLogProtection(channelName, null, 'nettoyage automatique')) {
      return false; // Refuser le nettoyage
    }
    
    const Channel = require('./models/Channel');
    
    // Trouver l'entrée en base de données
    const channelDB = await Channel.findOne({ 
      name: channelName,
      serverId: sourceGuildId 
    });
    
    if (!channelDB) {
      return;
    }

    // 🔍 VALIDATION: Vérifier que discordId existe avant toute sauvegarde
    if (!channelDB.discordId) {

      // Supprimer l'entrée corrompue de la base de données
      try {
        await Channel.deleteOne({ _id: channelDB._id });

        // Logger la suppression d'entrée corrompue
        await client.services.logger.logChannelCleanup(
          targetGuildId,
          channelName,
          'Entrée corrompue (discordId manquant) - supprimée de la base',
          1
        );
      } catch (deleteError) {
        console.error(`❌ Erreur lors de la suppression de l'entrée corrompue ${channelName}:`, deleteError);
      }

      return true; // Considérer comme "nettoyé"
    }

    // 🔕 ANTI-SPAM UNIVERSEL : Éviter les logs répétés pour TOUS les salons (pas seulement marqués manuellement)
      const now = new Date();
    const lastLogTime = channelDB.lastCleanupLog || new Date(0);
      const timeSinceLastLog = now - lastLogTime;
      const hoursInMs = 24 * 60 * 60 * 1000; // 24 heures en millisecondes
    
    // 🏷️ MÉTHODE 2 : Vérifier si le salon a été marqué comme supprimé manuellement
    if (channelDB.manuallyDeleted) {
      
      // Ne pas supprimer de la base, juste mettre à jour
      channelDB.scraped = false; // S'assurer que le scraping est arrêté
      
      // 🔕 AUCUN LOG POUR LES SALONS MARQUÉS MANUELLEMENT
      // Pas de notification Discord, seulement log console
      
      await channelDB.save();
      return true;
    }
    
    // 🆕 ANTI-SPAM POUR SALONS NON MARQUÉS : Éviter de logger/supprimer en boucle
    if (timeSinceLastLog <= hoursInMs) {
      
      // S'assurer que le scraping est arrêté sans suppression
      channelDB.scraped = false;
      await channelDB.save();
      return true; // Considéré comme "nettoyé" mais sans action destructive
    }
    
    
    // Note: Arrêt des intervals personnalisés supprimé (système événementiel)
    // Anciennement: if (customIntervals.has(channelName)) clearInterval(customIntervals.get(channelName))
    // Plus nécessaire avec le système événementiel
    
    // 🔕 AU LIEU DE SUPPRIMER : Marquer et attendre confirmation manuelle
    channelDB.scraped = false; // Arrêter le scraping
    channelDB.lastCleanupLog = now; // Marquer comme traité pour éviter spam
    await channelDB.save();
    
    // Logger SEULEMENT le premier signalement (grâce à l'anti-spam)
    await client.services.logger.logChannelCleanup(
      targetGuildId,
      channelName,
      reason + ' (salon probablement encore présent sur la source - vérifiez avec /listroom)',
      0 // Pas de suppression automatique
    );
    
    
    return true;
    
  } catch (error) {
    console.error(`❌ Erreur nettoyage automatique ${channelName}:`, error);
    
    // Logger l'erreur de nettoyage
    try {
      await client.services.logger.logError(
        targetGuildId,
        `Erreur nettoyage automatique ${channelName}: ${error.message}`
      );
    } catch (logError) {
      // Ignorer les erreurs de log
    }
    
    return false;
  }
}

// 🧹 FONCTION DE NETTOYAGE DES ENTRÉES CORROMPUES SANS discordId
async function cleanupCorruptedChannelEntries(sourceGuildId) {
  try {
    const Channel = require('./models/Channel');

    // Rechercher toutes les entrées sans discordId ou avec discordId vide
    const corruptedEntries = await Channel.find({
      serverId: sourceGuildId,
      $or: [
        { discordId: { $exists: false } },
        { discordId: null },
        { discordId: '' }
      ]
    });

    if (corruptedEntries.length === 0) {
      return 0;
    }


    let deletedCount = 0;
    for (const entry of corruptedEntries) {
      try {
        await Channel.deleteOne({ _id: entry._id });
        deletedCount++;
      } catch (error) {
        console.error(`❌ Erreur suppression entrée corrompue:`, error.message);
      }
    }

    if (deletedCount > 0) {
    }

    return deletedCount;
  } catch (error) {
    console.error(`❌ Erreur lors du nettoyage des entrées corrompues:`, error);
    return 0;
  }
}

// 🆕 NETTOYAGE GÉNÉRAL DE TOUS LES SALONS MIRROR SUPPRIMÉS
async function cleanupAllDeletedMirrorChannels(targetGuild, sourceGuildId) {
  try {
    const Channel = require('./models/Channel');

    // D'abord nettoyer les entrées corrompues
    const corruptedCleaned = await cleanupCorruptedChannelEntries(sourceGuildId);
    if (corruptedCleaned > 0) {
    }

    // Récupérer toutes les entrées de la base pour ce serveur
    const allChannelDB = await Channel.find({ serverId: sourceGuildId });
    
    let cleanedCount = 0;
    
    for (const channelDB of allChannelDB) {
      // 🛡️ PROTECTION : Utiliser le système centralisé de protection
      if (isChannelProtected(channelDB.name, channelDB.discordId)) {
        continue; // Ne jamais nettoyer les salons protégés
      }

      // 🏷️ PROTECTION : Ne pas toucher aux salons marqués comme supprimés manuellement
      if (channelDB.manuallyDeleted) {
        continue;
      }

      // Vérifier si le salon mirror existe encore
      const mirrorChannel = targetGuild.channels.cache.find(ch => ch.name === channelDB.name);
      
      if (!mirrorChannel) {
        // Salon mirror supprimé, nettoyer
        const cleaned = await cleanupDeletedMirrorChannel(
          channelDB.name, 
          sourceGuildId, 
          targetGuild.id,
          'Détecté par nettoyage général'
        );
        
        if (cleaned) {
          cleanedCount++;
        }
        
        // Délai pour éviter le spam
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    if (cleanedCount > 0) {
      
      await client.services.logger.logAdminAction(
        targetGuild.id,
        `🧹 Nettoyage automatique général: ${cleanedCount} salons supprimés détectés et nettoyés`
      );
    }
    
    return cleanedCount;
    
  } catch (error) {
    console.error('❌ Erreur nettoyage général:', error);
    return 0;
  }
}

// 🛡️ RESTAURER LES SALONS DE MAINTENANCE SUPPRIMÉS
async function handleRestoreMaintenance(interaction) {
  const permissionCheck = checkAdminPermission(interaction);
  if (!permissionCheck.hasPermission) {
    await interaction.reply(permissionCheck.error);
    return;
  }

  await interaction.deferReply();

  try {
    const guild = interaction.guild;
    
    await interaction.editReply('🛡️ **Restauration des salons de maintenance en cours...**\n\n⏳ Vérification et recréation des salons manquants...');

    // Utiliser la fonction du service logger pour restaurer
    await client.services.logger.ensureMaintenanceChannels(guild);

    // Vérifier quels salons ont été restaurés
    const chatStaffChannel = guild.channels.cache.find(c => c.name === 'chat-staff');
    const rolesChannel = guild.channels.cache.find(c => c.name === 'roles');
    const maintenanceCategory = guild.channels.cache.find(c => 
      c.type === 4 && c.name.toLowerCase().includes('maintenance')
    );

    let response = `✅ **Restauration des salons de maintenance terminée !**\n\n`;
    
    response += `📁 **Catégorie Maintenance :** ${maintenanceCategory ? '✅ Existe' : '❌ Erreur création'}\n`;
    response += `💬 **Salon chat-staff :** ${chatStaffChannel ? '✅ Disponible' : '❌ Erreur création'}\n`;
    response += `🎭 **Salon roles :** ${rolesChannel ? '✅ Disponible' : '❌ Erreur création'}\n\n`;
    
    response += `🛡️ **Protection :** Ces salons sont maintenant **protégés** contre :\n`;
    response += `• ❌ Suppression par auto-discovery\n`;
    response += `• ❌ Suppression en temps réel\n`;
    response += `• ❌ Nettoyage automatique\n\n`;
    
    response += `💡 **Utilisation :**\n`;
    if (chatStaffChannel) {
      response += `• 💬 **#chat-staff** : Salon privé pour les admins\n`;
    }
    if (rolesChannel) {
      response += `• 🎭 **#roles** : Utilisez \`/setup-roles\` pour le configurer\n`;
    }

    // Logger l'action
    await client.services.logger.logAdminAction(
      guild.id,
      `🛡️ Salons de maintenance restaurés par ${interaction.user.tag}\n` +
      `✅ chat-staff: ${chatStaffChannel ? 'OK' : 'ERREUR'}\n` +
      `✅ roles: ${rolesChannel ? 'OK' : 'ERREUR'}\n` +
      `📁 Catégorie: ${maintenanceCategory?.name || 'ERREUR'}`
    );

    await interaction.editReply(response);

  } catch (error) {
    console.log('❌ Restore-maintenance: Échec');
    await interaction.editReply(`❌ **Erreur lors de la restauration :** ${error.message}`);
  }
}

// 🛡️ FONCTION DE GESTION DES SALONS PROTÉGÉS
async function handleProtectedChannels(interaction) {
  const permissionCheck = checkAdminPermission(interaction);
  if (!permissionCheck.hasPermission) {
    await interaction.reply(permissionCheck.error);
    return;
  }

  await interaction.deferReply();

  try {
    const action = interaction.options.getString('action');
    const value = interaction.options.getString('value');

    switch (action) {
      case 'list':
        const protectionInfo = getProtectionInfo();
        
        let response = `🛡️ **Salons protégés contre la suppression automatique**\n\n`;
        
        response += `📊 **Statistiques :**\n`;
        response += `• 📝 **Protégés par nom :** ${protectionInfo.protectedNames.length}\n`;
        response += `• 🆔 **Protégés par ID :** ${protectionInfo.protectedIds.length}\n`;
        response += `• 🔍 **Patterns actifs :** ${protectionInfo.protectedPatterns.length}\n`;
        response += `• 📋 **Total protégés :** ${protectionInfo.totalProtected}\n\n`;
        
        response += `📝 **Salons protégés par nom :**\n`;
        response += protectionInfo.protectedNames.map(name => `• \`${name}\``).join('\n');
        
        if (protectionInfo.protectedIds.length > 0) {
          response += `\n\n🆔 **Salons protégés par ID :**\n`;
          response += protectionInfo.protectedIds.map(id => `• \`${id}\``).join('\n');
        }
        
        response += `\n\n🔍 **Patterns de protection :**\n`;
        response += `• Salons commençant par \`admin-\`, \`bot-\`, \`system-\`\n`;
        response += `• Salons finissant par \`-logs\` ou \`-log\`\n`;
        response += `• Salons nommés \`mentions-logs\`, \`notifications\`, etc.\n\n`;
        
        response += `💡 **Ces salons ne seront JAMAIS supprimés par :**\n`;
        response += `• ❌ Auto-discovery\n• ❌ Nettoyage automatique\n• ❌ Suppression en masse\n• ❌ Systèmes de maintenance`;
        
        await interaction.editReply(response);
        break;

      case 'add_name':
        if (!value) {
          await interaction.editReply('❌ **Nom de salon requis !**\n\nUtilisez: `/protected-channels action:add_name value:nom-du-salon`');
          return;
        }
        
        const { addProtectedChannelName } = require('./utils/protectedChannels');
        addProtectedChannelName(value);
        
        await interaction.editReply(
          `✅ **Salon ajouté à la protection !**\n\n` +
          `📝 **Salon :** \`${value}\`\n` +
          `🛡️ **Protection :** Ce salon ne sera plus jamais supprimé automatiquement\n\n` +
          `💡 La protection est active immédiatement sur tous les systèmes automatiques.`
        );
        break;

      case 'add_id':
        if (!value) {
          await interaction.editReply('❌ **ID de salon requis !**\n\nUtilisez: `/protected-channels action:add_id value:123456789`');
          return;
        }
        
        // Vérifier que l'ID ressemble à un ID Discord
        if (!/^\d{15,20}$/.test(value)) {
          await interaction.editReply('❌ **ID de salon invalide !**\n\nL\'ID doit être un nombre de 15-20 chiffres.');
          return;
        }
        
        addProtectedChannelId(value);
        
        // Essayer de trouver le salon pour afficher son nom
        let channelName = 'Salon inconnu';
        const channel = interaction.guild.channels.cache.get(value);
        if (channel) {
          channelName = channel.name;
        }
        
        await interaction.editReply(
          `✅ **Salon ajouté à la protection par ID !**\n\n` +
          `🆔 **ID :** \`${value}\`\n` +
          `📝 **Nom :** \`${channelName}\`\n` +
          `🛡️ **Protection :** Ce salon ne sera plus jamais supprimé automatiquement\n\n` +
          `💡 La protection par ID est la plus forte et fonctionne même si le salon est renommé.`
        );
        break;

      case 'check':
        if (!value) {
          await interaction.editReply('❌ **Nom ou ID de salon requis !**\n\nUtilisez: `/protected-channels action:check value:nom-ou-id`');
          return;
        }
        
        const { getProtectionReason } = require('./utils/protectedChannels');
        let isId = /^\d{15,20}$/.test(value);
        let protectionReason;
        
        if (isId) {
          protectionReason = getProtectionReason(null, value);
        } else {
          protectionReason = getProtectionReason(value, null);
        }
        
        if (protectionReason) {
          await interaction.editReply(
            `✅ **Salon protégé !**\n\n` +
            `${isId ? '🆔' : '📝'} **${isId ? 'ID' : 'Nom'} :** \`${value}\`\n` +
            `🛡️ **Raison :** ${protectionReason}\n\n` +
            `💡 Ce salon ne sera jamais supprimé automatiquement.`
          );
        } else {
          await interaction.editReply(
            `⚠️ **Salon non protégé**\n\n` +
            `${isId ? '🆔' : '📝'} **${isId ? 'ID' : 'Nom'} :** \`${value}\`\n` +
            `❌ **Statut :** Peut être supprimé automatiquement\n\n` +
            `💡 **Pour le protéger :**\n` +
            `• \`/protected-channels action:add_${isId ? 'id' : 'name'} value:${value}\``
          );
        }
        break;

      default:
        await interaction.editReply('❌ Action non reconnue.');
    }

  } catch (error) {
    console.log('❌ Protected channels: Échec');
    console.error('Erreur protected channels:', error);
    await interaction.editReply(`❌ **Erreur lors de la gestion des salons protégés :** ${error.message}`);
  }
}

// 🚫 GESTION DE LA BLACKLIST DES SALONS POUR LES MENTIONS
async function handleMentionBlacklist(interaction) {
  const permissionCheck = checkAdminPermission(interaction);
  if (!permissionCheck.hasPermission) {
    await interaction.reply(permissionCheck.error);
    return;
  }

  await interaction.deferReply();

  try {
    const sourceGuild = client.services.userClient.getSourceGuild(interaction.guild.id);

    if (!sourceGuild) {
      await interaction.editReply('❌ Configuration serveur source manquante. Vérifiez SERVER_ID dans les variables d\'environnement Coolify.');
      return;
    }

    const action = interaction.options.getString('action');
    const channelName = interaction.options.getString('channel_name');
    const reason = interaction.options.getString('reason') || 'Blacklisté manuellement';
    const MentionBlacklist = require('./models/MentionBlacklist');

    switch (action) {
      case 'list':
        const blacklistedChannels = await MentionBlacklist.getBlacklistedChannels(sourceGuild.id);

        if (blacklistedChannels.length === 0) {
          await interaction.editReply('✅ **Aucun salon blacklisté !**\n\n🔔 Toutes les mentions de rôles sont actuellement loggées.');
          return;
        }

        let listResponse = `🚫 **Salons blacklistés pour les mentions (${blacklistedChannels.length}):**\n\n`;
        
        for (const entry of blacklistedChannels) {
          const addedDate = entry.addedAt.toLocaleDateString('fr-FR');
          listResponse += `📂 **#${entry.channelName}**\n`;
          listResponse += `   📅 Ajouté le: ${addedDate}\n`;
          listResponse += `   👤 Par: ${entry.addedBy}\n`;
          listResponse += `   📝 Raison: ${entry.reason}\n\n`;
        }

        listResponse += `💡 **Actions possibles:**\n`;
        listResponse += `• \`/mention-blacklist action:remove channel_name:SALON\` - Retirer un salon\n`;
        listResponse += `• \`/mention-blacklist action:clear\` - Nettoyer toute la blacklist\n`;
        listResponse += `• \`/mention-blacklist action:add channel_name:SALON\` - Ajouter un salon`;

        await sendLongResponse(interaction, listResponse);
        break;

      case 'add':
        if (!channelName) {
          await interaction.editReply('❌ **Nom du salon requis !**\n\nUtilisez: `/mention-blacklist action:add channel_name:nom-du-salon`');
          return;
        }

        // Vérifier si le salon existe sur la source
        const userData = client.services.userClient.getUserData(interaction.guild.id);
        const sourceChannels = await client.services.userClient.fetchGuildChannels(userData.token, sourceGuild.id);
        const sourceChannel = sourceChannels.find(ch => ch.name === channelName && ch.type === 0);

        if (!sourceChannel) {
          await interaction.editReply(`❌ **Salon non trouvé sur le serveur source !**\n\n🔍 Salon: \`${channelName}\`\n💡 Utilisez \`/listroom\` pour voir les salons disponibles.`);
          return;
        }

        // Vérifier si déjà blacklisté
        const isAlreadyBlacklisted = await MentionBlacklist.isChannelBlacklisted(sourceGuild.id, channelName);
        if (isAlreadyBlacklisted) {
          await interaction.editReply(`⚠️ **Salon déjà blacklisté !**\n\n📂 **#${channelName}** est déjà dans la blacklist des mentions.`);
          return;
        }

        // Ajouter à la blacklist
        await MentionBlacklist.addToBlacklist({
          sourceGuildId: sourceGuild.id,
          mirrorGuildId: interaction.guild.id,
          channelName: channelName,
          sourceChannelId: sourceChannel.id,
          reason: reason,
          addedBy: interaction.user.tag
        });

        await interaction.editReply(`🚫 **Salon blacklisté pour les mentions !**\n\n📂 **#${channelName}** ne générera plus de notifications de mentions\n📝 **Raison:** ${reason}\n👤 **Ajouté par:** ${interaction.user.tag}`);

        // Logger l'action
        await client.services.logger.logAdminAction(
          interaction.guild.id,
          `🚫 Salon blacklisté pour mentions: #${channelName} par ${interaction.user.tag}\nRaison: ${reason}`
        );
        break;

      case 'remove':
        if (!channelName) {
          await interaction.editReply('❌ **Nom du salon requis !**\n\nUtilisez: `/mention-blacklist action:remove channel_name:nom-du-salon`');
          return;
        }

        const wasBlacklisted = await MentionBlacklist.isChannelBlacklisted(sourceGuild.id, channelName);
        if (!wasBlacklisted) {
          await interaction.editReply(`❌ **Salon non trouvé dans la blacklist !**\n\n🔍 Salon: \`${channelName}\`\n💡 Utilisez \`/mention-blacklist action:list\` pour voir les salons blacklistés`);
          return;
        }

        // Supprimer de la blacklist
        await MentionBlacklist.removeFromBlacklist(sourceGuild.id, channelName);

        await interaction.editReply(`✅ **Salon retiré de la blacklist !**\n\n📂 **#${channelName}** génèrera à nouveau des notifications de mentions`);

        // Logger l'action
        await client.services.logger.logAdminAction(
          interaction.guild.id,
          `✅ Salon retiré de la blacklist mentions: #${channelName} par ${interaction.user.tag}`
        );
        break;

      case 'clear':
        const result = await MentionBlacklist.clearBlacklist(sourceGuild.id);

        if (result.deletedCount === 0) {
          await interaction.editReply('✅ **Blacklist déjà vide !**\n\n🔔 Aucun salon n\'était blacklisté pour les mentions');
          return;
        }

        await interaction.editReply(`✅ **Blacklist nettoyée !**\n\n🔔 **${result.deletedCount} salon(s)** retiré(s) de la blacklist\n⚡ Toutes les mentions seront à nouveau loggées`);

        // Logger l'action
        await client.services.logger.logAdminAction(
          interaction.guild.id,
          `🔄 Blacklist mentions complète nettoyée: ${result.deletedCount} salons réactivés par ${interaction.user.tag}`
        );
        break;

      default:
        await interaction.editReply('❌ Action non reconnue.');
    }

  } catch (error) {
    console.log('❌ Mention blacklist: Échec');
    console.error('Erreur mention blacklist:', error);
    await interaction.editReply(`❌ **Erreur:** ${error.message}`);
  }
}

// 📊 COMMANDE DE COUNT DES MEMBRES
async function handleMemberCount(interaction) {
  await interaction.deferReply();

  try {
    const sourceGuild = client.services.userClient.getSourceGuild(interaction.guild.id);

    if (!sourceGuild) {
      await interaction.editReply('❌ Configuration serveur source manquante. Vérifiez SERVER_ID dans les variables d\'environnement Coolify.');
      return;
    }

    await interaction.editReply('📊 **Récupération du nombre de membres...**\n\n⏳ Interrogation en cours...');

    // Obtenir le count instantané
    const result = await client.services.memberTracker.getInstantMemberCount(interaction.guild.id);

    if (!result.success) {
      await interaction.editReply('❌ **Erreur lors de la récupération du nombre de membres.**');
      return;
    }

    const { memberData, lastTracked, changesSinceLastTrack } = result;

    // Construire la réponse
    let response = `📊 **Nombre de Membres - ${memberData.guildName}**\n\n`;
    
    response += `👥 **Membres Total :** ${memberData.totalMembers.toLocaleString()}\n`;
    response += `🟢 **En Ligne :** ${memberData.onlineMembers.toLocaleString()}\n`;

    const onlinePercent = memberData.totalMembers > 0 ? 
      Math.round((memberData.onlineMembers / memberData.totalMembers) * 100) : 0;
    response += `📈 **Taux d'Activité :** ${onlinePercent}%\n`;

    // Comparaison avec le dernier tracking
    if (lastTracked && changesSinceLastTrack.members !== undefined) {
      const changeIcon = changesSinceLastTrack.members >= 0 ? '📈' : '📉';
      const changeSign = changesSinceLastTrack.members >= 0 ? '+' : '';
      const hoursAgo = Math.round((changesSinceLastTrack.timeSince) / (1000 * 60 * 60));
      
      response += `\n🔄 **Depuis le dernier tracking :**\n`;
      response += `${changeIcon} **${changeSign}${changesSinceLastTrack.members}** membres\n`;
      response += `⏰ Dernier tracking : il y a ${hoursAgo}h (${lastTracked.timestamp.toLocaleDateString('fr-FR')})\n`;
    }

    response += `\n⏰ **Données récupérées :** <t:${Math.floor(memberData.timestamp.getTime() / 1000)}:R>\n`;
    response += `📡 **Source :** API Discord officielle\n`;
    response += `🎯 **Précision :** Temps réel`;

    // Informations sur le tracking automatique
    response += `\n\n💡 **Tracking automatique :**\n`;
    response += `🕔 Tous les jours à **5h00** du matin\n`;
    response += `📋 Historique sauvegardé dans #members-log\n`;
    response += `📊 Comparaisons jour/semaine/mois automatiques`;

    await interaction.editReply(response);

    // Logger la consultation dans #admin-logs
    await client.services.logger.logAdminAction(
      interaction.guild.id,
      `📊 Consultation member count: ${memberData.guildName} (${memberData.totalMembers} membres) par ${interaction.user.tag}`
    );

  } catch (error) {
    console.log('❌ Member-count: Échec');
    console.error('Erreur member-count:', error);
    await interaction.editReply(`❌ **Erreur lors de la récupération :** ${error.message}`);
  }
}

// 🔐 GESTION DE L'AJOUT DU TOKEN UTILISATEUR ET SERVEUR SOURCE

// 📋 LISTER LES SERVEURS ACCESSIBLES AVEC UN TOKEN
async function handleListServor(interaction) {
  const permissionCheck = checkAdminPermission(interaction);
  if (!permissionCheck.hasPermission) {
    await interaction.reply(permissionCheck.error);
    return;
  }

  await interaction.deferReply();

  try {
    const userToken = interaction.options.getString('token');

    if (!userToken) {
      await interaction.editReply('❌ **Token utilisateur requis !**');
      return;
    }

    await interaction.editReply('🔍 **Récupération des serveurs...**\n\n⏳ Vérification du token et listage des serveurs accessibles...');

    // Tester le token et récupérer les informations
    let userData;
    let userGuilds;
    
    try {
      userData = await client.services.userClient.fetchUserProfile(userToken);
      userGuilds = await client.services.userClient.fetchUserGuilds(userToken);
    } catch (error) {
      await interaction.editReply(`❌ **Token invalide !**\n\n**Erreur :** ${error.message}\n\n💡 **Aide :**\n1. Vérifiez que votre token est correct\n2. Assurez-vous qu'il n'a pas expiré\n3. Essayez de générer un nouveau token`);
      return;
    }

    // Filtrer les serveurs accessibles
    const accessibleGuilds = userGuilds.filter(guild => guild.owner || guild.permissions);

    if (accessibleGuilds.length === 0) {
      await interaction.editReply(`❌ **Aucun serveur accessible !**\n\n👤 **Compte :** ${userData.username}#${userData.discriminator}\n🔒 **Problème :** Aucun serveur avec permissions suffisantes`);
      return;
    }

    // Construire la liste des serveurs
    let serverList = `📋 **Serveurs Discord accessibles**\n\n`;
    serverList += `👤 **Compte :** ${userData.username}#${userData.discriminator}\n`;
    serverList += `🔢 **Total :** ${accessibleGuilds.length} serveur(s) accessible(s)\n\n`;

    // Lister les serveurs (limiter à 15 pour éviter message trop long)
    const serversToShow = accessibleGuilds.slice(0, 15);
    
    for (let i = 0; i < serversToShow.length; i++) {
      const guild = serversToShow[i];
      const isOwner = guild.owner ? '👑' : '👤';
      serverList += `${i + 1}. ${isOwner} **${guild.name}**\n`;
      serverList += `   🆔 ID: \`${guild.id}\`\n\n`;
    }

    if (accessibleGuilds.length > 15) {
      serverList += `... et ${accessibleGuilds.length - 15} autres serveurs\n\n`;
    }

    serverList += `💡 **Pour configurer un serveur :**\n`;
    serverList += `\`/addservor token:votre_token server_id:ID_DU_SERVEUR\`\n\n`;
    
    if (accessibleGuilds.length === 1) {
      serverList += `🎯 **Configuration rapide** (serveur unique) :\n`;
      serverList += `\`/addservor token:votre_token\``;
    } else {
      serverList += `📝 **Exemple :**\n`;
      serverList += `\`/addservor token:votre_token server_id:${accessibleGuilds[0].id}\``;
    }

    await interaction.editReply(serverList);

  } catch (error) {
    console.error('❌ Erreur listservor:', error);
    await interaction.editReply(`❌ **Erreur lors du listage :** ${error.message}`);
  }
}

// 🔔 GESTION DES SALONS DE NOTIFICATIONS
async function handleNotificationChannels(interaction) {
  const permissionCheck = checkAdminPermission(interaction);
  if (!permissionCheck.hasPermission) {
    await interaction.reply(permissionCheck.error);
    return;
  }

  await interaction.deferReply();

  try {
    const action = interaction.options.getString('action');
    const channelId = interaction.options.getString('channel_id');

    const {
      getAllNotificationChannelIds,
      autoDetectNotificationChannel,
      getNotificationChannelIdFromDB,
      saveNotificationChannelToDB,
      getMentionLogsConfig
    } = require('./config/notificationChannels');

    switch (action) {
      case 'show':
        // 🆕 Lire config depuis DB
        const dbConfig = await getMentionLogsConfig(interaction.guild.id);
        const allIds = getAllNotificationChannelIds();

        let response = `🔔 **Configuration des salons de notifications**\n\n`;

        response += `📋 **Configuration actuelle (persistante) :**\n`;
        response += `• 🎯 **Salon principal :** ${dbConfig.channelId ? `<#${dbConfig.channelId}>` : '❌ Non configuré'}\n`;
        response += `• 🔄 **Salon backup :** ${dbConfig.backupChannelId ? `<#${dbConfig.backupChannelId}>` : '❌ Non configuré'}\n`;
        response += `• 📅 **Configuré le :** ${dbConfig.configuredAt ? dbConfig.configuredAt.toLocaleDateString('fr-FR') : 'Jamais'}\n\n`;

        response += `🔔 **Détections activées :**\n`;
        response += `• **@everyone/@here :** ${dbConfig.detectEveryone ? '✅ Activé' : '❌ Désactivé'}\n`;
        response += `• **Mentions de rôles :** ${dbConfig.detectRoles ? '✅ Activé' : '❌ Désactivé'}\n`;
        response += `• **Messages de bots :** ${dbConfig.allowBotMentions ? '✅ Inclus' : '❌ Ignorés'}\n`;
        response += `• **Fenêtre déduplication :** ${dbConfig.deduplicationWindow / 1000}s\n\n`;

        if (allIds.length > 0) {
          response += `🛡️ **Salons protégés (mémoire) :**\n`;
          for (const id of allIds.slice(0, 5)) {
            const channel = interaction.guild.channels.cache.get(id);
            response += `• \`${id}\` ${channel ? `(#${channel.name})` : '(externe/supprimé)'}\n`;
          }
          if (allIds.length > 5) response += `• ... et ${allIds.length - 5} autres\n`;
          response += `\n`;
        }

        response += `⚙️ **Actions disponibles :**\n`;
        response += `• \`/notification-channels action:set_main channel_id:ID\` - Modifier le salon principal\n`;
        response += `• \`/notification-channels action:auto_detect\` - Auto-détecter un salon\n`;
        response += `• \`/notification-channels action:test\` - Tester la configuration\n\n`;

        response += `💾 **Note :** Configuration persistante (survit aux redémarrages).`;

        await sendLongResponse(interaction, response);
        break;

      case 'set_main':
        if (!channelId) {
          await interaction.editReply('❌ **ID du salon requis !**\n\nUtilisez: `/notification-channels action:set_main channel_id:123456789`');
          return;
        }

        // Vérifier que le salon existe
        const targetChannel = interaction.guild.channels.cache.get(channelId);
        if (!targetChannel) {
          await interaction.editReply('❌ **Salon non trouvé !**\n\nVérifiez l\'ID du salon fourni.');
          return;
        }

        // Vérifier les permissions
        if (!targetChannel.permissionsFor(client.user).has(['SendMessages', 'EmbedLinks'])) {
          await interaction.editReply(`❌ **Permissions insuffisantes dans ${targetChannel}**\n\nJe dois pouvoir envoyer des messages et des embeds.`);
          return;
        }

        // 🆕 Sauvegarder en DB pour persistance
        await saveNotificationChannelToDB(interaction.guild.id, 'MENTIONS_LOG', channelId);

        // Ajouter automatiquement à la protection
        const { addProtectedChannelId } = require('./utils/protectedChannels');
        addProtectedChannelId(channelId);

        await interaction.editReply(
          `✅ **Salon principal mis à jour !**\n\n` +
          `🎯 **Nouveau salon :** ${targetChannel}\n` +
          `🆔 **ID :** \`${channelId}\`\n` +
          `🛡️ **Protection :** Automatiquement activée\n` +
          `💾 **Persistance :** Sauvegardé en base de données\n\n` +
          `💡 **Effet immédiat :** Ce salon sera utilisé pour toutes les nouvelles notifications de mentions.`
        );

        // Logger l'action
        await client.services.logger.logAdminAction(
          interaction.guild.id,
          `🔔 Salon de notifications principal modifié: ${targetChannel.name} (${channelId}) par ${interaction.user.tag}`
        );
        break;

      case 'set_backup':
        if (!channelId) {
          await interaction.editReply('❌ **ID du salon requis !**\n\nUtilisez: `/notification-channels action:set_backup channel_id:123456789`');
          return;
        }

        const backupChannel = interaction.guild.channels.cache.get(channelId);
        if (!backupChannel) {
          await interaction.editReply('❌ **Salon non trouvé !**\n\nVérifiez l\'ID du salon fourni.');
          return;
        }

        // 🆕 Sauvegarder en DB
        await saveNotificationChannelToDB(interaction.guild.id, 'MENTIONS_BACKUP', channelId);
        addProtectedChannelId(channelId);

        await interaction.editReply(
          `✅ **Salon de backup configuré !**\n\n` +
          `🔄 **Salon backup :** ${backupChannel}\n` +
          `🆔 **ID :** \`${channelId}\`\n` +
          `🛡️ **Protection :** Automatiquement activée\n\n` +
          `💡 Ce salon pourra être utilisé comme alternative au salon principal.`
        );
        break;

      case 'auto_detect':
        const detectedId = autoDetectNotificationChannel(interaction.guild);
        
        if (detectedId) {
          const detectedChannel = interaction.guild.channels.cache.get(detectedId);
          
          await interaction.editReply(
            `🔍 **Salon auto-détecté !**\n\n` +
            `📍 **Salon trouvé :** ${detectedChannel}\n` +
            `🆔 **ID :** \`${detectedId}\`\n\n` +
            `💡 **Actions possibles :**\n` +
            `• \`/notification-channels action:set_main channel_id:${detectedId}\` - Utiliser comme salon principal\n` +
            `• \`/notification-channels action:test\` - Tester ce salon`
          );
        } else {
          await interaction.editReply(
            `❌ **Aucun salon détecté automatiquement**\n\n` +
            `🔍 **Salons recherchés :**\n` +
            `• mentions-logs, mentions-log\n` +
            `• notifications, notification-logs\n` +
            `• mentions-log-test\n\n` +
            `💡 **Solution :** Créez un salon avec un de ces noms ou utilisez \`set_main\` avec un ID spécifique.`
          );
        }
        break;

      case 'test':
        // 🆕 Tester la configuration depuis DB
        const testChannelId = await getNotificationChannelIdFromDB(interaction.guild.id, 'MENTIONS_LOG');

        if (!testChannelId) {
          await interaction.editReply(
            `❌ **Aucune configuration trouvée !**\n\n` +
            `💡 **Solutions :**\n` +
            `• \`/notification-channels action:set_main channel_id:ID\` - Configurer un salon\n` +
            `• \`/notification-channels action:auto_detect\` - Auto-détecter un salon`
          );
          return;
        }

        const testChannel = interaction.guild.channels.cache.get(testChannelId);
        if (!testChannel) {
          await interaction.editReply(
            `❌ **Salon configuré non trouvé !**\n\n` +
            `🆔 **ID configuré :** \`${testChannelId}\`\n` +
            `❓ Le salon a peut-être été supprimé ou l'ID est incorrect.\n\n` +
            `💡 **Solution :** Reconfigurez avec \`set_main\`.`
          );
          return;
        }

        // Vérifier les permissions
        if (!testChannel.permissionsFor(client.user).has(['SendMessages', 'EmbedLinks'])) {
          await interaction.editReply(
            `❌ **Permissions insuffisantes !**\n\n` +
            `📍 **Salon configuré :** ${testChannel}\n` +
            `🚫 **Permissions manquantes :** Send Messages, Embed Links\n\n` +
            `💡 **Solution :** Donnez les permissions nécessaires au bot.`
          );
          return;
        }

        // Envoyer un test
        try {
          const testData = {
            channelName: 'salon-test-config',
            channelId: '123456789012345678',
            roleName: 'Test Config',
            userId: interaction.user.id,
            username: interaction.user.username,
            messageId: '987654321012345678'
          };

          const sentMessage = await client.services.mentionNotifier.sendMentionNotification(
            testData, 
            testChannelId, 
            interaction.guild.id
          );

          await interaction.editReply(
            `✅ **Test de configuration réussi !**\n\n` +
            `📍 **Salon configuré :** ${testChannel}\n` +
            `🆔 **ID :** \`${testChannelId}\`\n` +
            `📨 **Message de test :** [Voir ici](${sentMessage.url})\n` +
            `🛡️ **Protection :** Activée automatiquement\n\n` +
            `💡 **La configuration fonctionne parfaitement !**`
          );
        } catch (testError) {
          await interaction.editReply(
            `❌ **Échec du test !**\n\n` +
            `📍 **Salon configuré :** ${testChannel}\n` +
            `❌ **Erreur :** ${testError.message}\n\n` +
            `💡 **Vérifiez les permissions et la configuration.**`
          );
        }
        break;

      default:
        await interaction.editReply('❌ Action non reconnue.');
    }

  } catch (error) {
    console.log('❌ Notification channels: Échec');
    console.error('Erreur notification channels:', error);
    await interaction.editReply(`❌ **Erreur lors de la gestion des salons de notifications :** ${error.message}`);
  }
}

// 🔍 GESTION DU MONITORING D'ACTIVITÉ (DÉTECTION SYSTÈME DOWN)
async function handleActivityMonitor(interaction) {
  const permissionCheck = checkAdminPermission(interaction);
  if (!permissionCheck.hasPermission) {
    await interaction.reply(permissionCheck.error);
    return;
  }

  await interaction.deferReply();

  try {
    const action = interaction.options.getString('action');

    switch (action) {
      case 'stats':
        const stats = client.services.activityMonitor.getStats();
        
        let response = `🔍 **Statistiques du Monitoring d'Activité**\n\n`;
        
        response += `📊 **État actuel :**\n`;
        response += `• 🔄 **Monitoring actif :** ${stats.isMonitoring ? '✅ Oui' : '❌ Non'}\n`;
        response += `• 🚨 **Système down :** ${stats.isSystemDown ? '🔴 OUI' : '🟢 Non'}\n`;
        
        if (stats.lastActivityTime) {
          const timeSinceLastActivity = Date.now() - stats.lastActivityTime;
          const minutesAgo = Math.floor(timeSinceLastActivity / (1000 * 60));
          const hoursAgo = Math.floor(minutesAgo / 60);
          
          response += `• ⏰ **Dernière activité :** `;
          if (hoursAgo > 0) {
            response += `il y a ${hoursAgo}h ${minutesAgo % 60}min\n`;
          } else {
            response += `il y a ${minutesAgo}min\n`;
          }
        } else {
          response += `• ⏰ **Dernière activité :** Aucune donnée\n`;
        }
        
        if (stats.isSystemDown && stats.downSince) {
          const downDuration = Date.now() - stats.downSince;
          const downHours = Math.floor(downDuration / (1000 * 60 * 60));
          const downMinutes = Math.floor((downDuration % (1000 * 60 * 60)) / (1000 * 60));
          
          response += `• 🕒 **Down depuis :** ${downHours}h ${downMinutes}min\n`;
          response += `• 🚨 **Alertes envoyées :** ${stats.alertCount}\n`;
        }
        
        response += `\n⚙️ **Configuration :**\n`;
        response += `• ⏱️ **Seuil d'inactivité :** 45 minutes\n`;
        response += `• 🔔 **Fréquence d'alertes :** 45 minutes\n`;
        response += `• 📍 **Salon d'alertes :** `;
        
        // Import à la demande pour éviter les problèmes d'initialisation
        const { getNotificationChannelId } = require('./config/notificationChannels');
        const errorChannelId = getNotificationChannelId(interaction.guild.id, 'ERROR_ALERTS');
        
        if (errorChannelId) {
          const errorChannel = interaction.guild.channels.cache.get(errorChannelId);
          response += errorChannel ? `${errorChannel}` : `ID: \`${errorChannelId}\` (salon non trouvé)`;
        } else {
          response += `❌ Non configuré`;
        }
        
        response += `\n\n💡 **Actions disponibles :**\n`;
        response += `• \`/activity-monitor action:check\` - Forcer une vérification\n`;
        response += `• \`/activity-monitor action:test\` - Tester une alerte\n`;
        response += `• \`/notification-channels action:set_main\` - Configurer salon d'alertes`;
        
        await interaction.editReply(response);
        break;

      case 'check':
        await interaction.editReply('🔍 **Vérification forcée en cours...**\n\n⏳ Analyse de l\'activité récente...');
        
        // Forcer une vérification
        await client.services.activityMonitor.forceCheck();
        
        const checkStats = client.services.activityMonitor.getStats();
        let checkResponse = `✅ **Vérification forcée terminée**\n\n`;
        
        if (checkStats.isSystemDown) {
          checkResponse += `🚨 **Résultat :** Système DOWN détecté !\n`;
          checkResponse += `⏰ **Dernière activité :** il y a ${Math.floor(checkStats.timeSinceLastActivity / (1000 * 60))}min\n`;
          checkResponse += `🔔 **Action :** Alerte envoyée dans le salon d'erreur\n\n`;
          checkResponse += `💡 **Le système continuera à envoyer des alertes toutes les 45 minutes.**`;
        } else {
          const remainingTime = 45 - Math.floor(checkStats.timeSinceLastActivity / (1000 * 60));
          checkResponse += `🟢 **Résultat :** Système opérationnel\n`;
          checkResponse += `⏰ **Dernière activité :** il y a ${Math.floor(checkStats.timeSinceLastActivity / (1000 * 60))}min\n`;
          checkResponse += `⏳ **Prochaine vérification :** dans ${remainingTime}min\n\n`;
          checkResponse += `✅ **Tout fonctionne normalement !**`;
        }
        
        await interaction.editReply(checkResponse);
        break;

      case 'test':
        await interaction.editReply('🧪 **Test d\'alerte en cours...**\n\n⏳ Envoi d\'une alerte test...');
        
        // Import à la demande pour éviter les problèmes d'initialisation
        const { getNotificationChannelId: getTestChannelId } = require('./config/notificationChannels');
        
        // Vérifier la configuration du salon d'erreur
        const testErrorChannelId = getTestChannelId(interaction.guild.id, 'ERROR_ALERTS');
        
        if (!testErrorChannelId) {
          await interaction.editReply(
            `❌ **Impossible de tester : salon d'erreur non configuré**\n\n` +
            `💡 **Solution :**\n` +
            `\`/notification-channels action:set_main channel_id:ID_DU_SALON\`\n\n` +
            `📋 **Le salon doit permettre au bot d'envoyer des messages et des embeds.**`
          );
          return;
        }
        
        const testErrorChannel = interaction.guild.channels.cache.get(testErrorChannelId);
        if (!testErrorChannel) {
          await interaction.editReply(
            `❌ **Salon d'erreur configuré non trouvé**\n\n` +
            `🆔 **ID configuré :** \`${testErrorChannelId}\`\n` +
            `💡 **Le salon a peut-être été supprimé.**`
          );
          return;
        }
        
        // Vérifier les permissions
        if (!testErrorChannel.permissionsFor(client.user).has(['SendMessages', 'EmbedLinks'])) {
          await interaction.editReply(
            `❌ **Permissions insuffisantes dans ${testErrorChannel}**\n\n` +
            `🚫 **Permissions manquantes :** Send Messages, Embed Links\n` +
            `💡 **Donnez les permissions nécessaires au bot.**`
          );
          return;
        }
        
        // Envoyer une alerte test
        try {
          const testEmbed = {
            color: 0xFFA500, // Orange pour test
            title: '🧪 TEST D\'ALERTE SYSTÈME',
            description: `Test du système de monitoring d'activité`,
            fields: [
              {
                name: '⚠️ Ceci est un test',
                value: 'Le système fonctionne normalement, ceci est juste un test.',
                inline: false
              },
              {
                name: '👤 Déclenché par',
                value: `${interaction.user.tag}`,
                inline: true
              },
              {
                name: '⏰ Heure du test',
                value: `<t:${Math.floor(Date.now() / 1000)}:f>`,
                inline: true
              },
              {
                name: '🔧 Actions de test',
                value: `• Vérifier que cette alerte s'affiche correctement\n• Confirmer que @everyone fonctionne\n• Tester les liens vers les logs Coolify`,
                inline: false
              }
            ],
            footer: {
              text: `Test effectué depuis /activity-monitor`
            },
            timestamp: new Date().toISOString()
          };

          const testMessage = await testErrorChannel.send({
            content: '@everyone **🧪 TEST D\'ALERTE SYSTÈME**',
            embeds: [testEmbed]
          });

          await interaction.editReply(
            `✅ **Test d'alerte réussi !**\n\n` +
            `📍 **Salon testé :** ${testErrorChannel}\n` +
            `📨 **Message test :** [Voir ici](${testMessage.url})\n` +
            `🔔 **@everyone :** Fonctionnel\n` +
            `📋 **Embeds :** Fonctionnels\n\n` +
            `💡 **Le système d'alertes fonctionne parfaitement !**\n` +
            `🚨 **En cas de vrai problème, vous recevrez des alertes similaires toutes les 45 minutes.**`
          );
          
          // Logger le test
          await client.services.logger.logAdminAction(
            interaction.guild.id,
            `🧪 Test d'alerte système effectué par ${interaction.user.tag} dans ${testErrorChannel.name}`
          );
          
        } catch (testError) {
          await interaction.editReply(
            `❌ **Échec du test d'alerte**\n\n` +
            `📍 **Salon :** ${testErrorChannel}\n` +
            `❌ **Erreur :** ${testError.message}\n\n` +
            `💡 **Vérifiez les permissions et réessayez.**`
          );
        }
        break;

      default:
        await interaction.editReply('❌ Action non reconnue.');
    }

  } catch (error) {
    console.log('❌ Activity monitor: Échec');
    console.error('Erreur activity monitor:', error);
    await interaction.editReply(`❌ **Erreur lors de la gestion du monitoring :** ${error.message}`);
  }
}

// 🆕 NOUVELLES FONCTIONS POUR L'API D'INTERACTION (OPTION A)

// 🎯 GÉRER LES COMMANDES SHOPIFY AVEC API D'INTERACTION
async function handleShopifyCommand(interaction, commandName) {
  try {
    
    // ✅ UTILISER interaction.deferReply() POUR AVOIR 15 MINUTES DE TRAITEMENT
    await interaction.deferReply();
    
    // 🔍 SIMULER LE SCRAPING SHOPIFY (remplacer par vraie logique)
    await new Promise(resolve => setTimeout(resolve, 2000)); // Simulation 2s
    
    // 📋 CONSTRUIRE LA RÉPONSE AVEC EMBEDS
    const { EmbedBuilder } = require('discord.js');
    const embed = new EmbedBuilder()
      .setTitle(`🛍️ ${commandName.charAt(0).toUpperCase() + commandName.slice(1)} - Résultats`)
      .setDescription(`📦 Recherche terminée pour ${commandName}`)
      .setColor(0x00AE86)
      .setTimestamp()
      .addFields(
        {
          name: '💰 Offres trouvées',
          value: '2 commandes récupérées',
          inline: true
        },
        {
          name: '⏰ Dernière mise à jour',
          value: `<t:${Math.floor(Date.now() / 1000)}:R>`,
          inline: true
        },
        {
          name: '🔗 Source',
          value: 'Shopify API',
          inline: true
        }
      )
      .setFooter({ text: `Commande exécutée par ${interaction.user.username}` });
    
    // ✅ UTILISER interaction.followUp() POUR ENVOYER LA RÉPONSE
    const response = await interaction.followUp({
      embeds: [embed],
      fetchReply: true  // ✨ CRITIQUE: Récupère l'objet Message avec interaction.id
    });
    
    
    // 🎯 OPTIONNEL: Envoyer des mises à jour supplémentaires
    if (Math.random() > 0.5) { // 50% chance d'avoir des résultats supplémentaires
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      await interaction.followUp({
        content: `📬 **Mise à jour ${commandName}**\n\n✅ 1 nouvelle offre détectée !`,
        ephemeral: false
      });
      
    }
    
  } catch (error) {
    console.error(`❌ Erreur commande ${commandName}:`, error);
    
    const errorMessage = {
      content: `❌ Erreur lors de la recherche ${commandName}`,
      ephemeral: true
    };
    
    if (interaction.deferred) {
      await interaction.followUp(errorMessage);
    } else {
      await interaction.reply(errorMessage);
    }
  }
}

// 🎯 GESTIONNAIRE GÉNÉRIQUE POUR COMMANDES NON SPÉCIFIÉES
async function handleGenericSlashCommand(interaction) {
  try {
    const { commandName } = interaction;
    
    // ✅ TOUJOURS UTILISER L'API D'INTERACTION
    await interaction.deferReply();
    
    // 🔍 LOGIQUE GÉNÉRIQUE POUR NOUVELLES COMMANDES
    const response = await interaction.followUp({
      content: `🎯 **Commande ${commandName} exécutée**\n\n` +
              `✅ Traitement via API d'interaction Discord\n` +
              `🔑 ID: ${interaction.id}\n` +
              `👤 Par: ${interaction.user.username}`,
      fetchReply: true
    });
    
    
  } catch (error) {
    console.error(`❌ Erreur commande générique ${interaction.commandName}:`, error);
    
    if (interaction.deferred) {
      await interaction.followUp({
        content: `❌ Erreur lors de l'exécution de /${interaction.commandName}`,
        ephemeral: true
      });
    } else {
      await interaction.reply({
        content: `❌ Erreur lors de l'exécution de /${interaction.commandName}`,
        ephemeral: true
      });
    }
  }
}

// 🎯 FONCTION DE TEST POUR VÉRIFIER L'ASSOCIATION D'INTERACTIONS
async function handleTestInteraction(interaction) {
  try {
    
    // ✅ UTILISER OBLIGATOIREMENT interaction.reply() (PAS channel.send !)
    const testResponse = await interaction.reply({
      content: `🧪 **TEST INTERACTION RÉUSSI !**\n\n` +
        `🔑 **Interaction ID:** \`${interaction.id}\`\n` +
        `👤 **Utilisateur:** ${interaction.user.username}\n` +
        `⏰ **Timestamp:** <t:${Math.floor(Date.now() / 1000)}:F>\n\n` +
        `🎯 **IMPORTANT :** Ce message utilise \`interaction.reply()\`\n` +
        `✅ **Le scraper DEVRAIT voir ce message avec \`interaction.id\`**\n\n` +
        `💡 **Si tu vois ce message détaillé dans le mirror au lieu du générique,**\n` +
        `**c'est que l'API d'interaction fonctionne !**`,
      fetchReply: true
    });
    
    
    // 🎯 TEST CRUCIAL : Afficher si le message a bien l'interaction.id
    if (testResponse.interaction?.id === interaction.id) {
    } else {
    }
    
    // Marquer l'interaction comme répondue
    if (activeInteractions.has(interaction.id)) {
      const interactionData = activeInteractions.get(interaction.id);
      interactionData.responded = true;
      interactionData.responseMessageId = testResponse.id;
      activeInteractions.set(interaction.id, interactionData);
    }
    
    return testResponse;
    
  } catch (error) {
    console.error(`❌ Erreur test interaction:`, error);
    try {
      await interaction.reply(`❌ Erreur lors du test: ${error.message}`);
    } catch (replyError) {
      console.error(`❌ Impossible de répondre:`, replyError);
    }
  }
}

// 🔍 EXTRAIRE LES DÉTAILS D'UNE COMMANDE SLASH (adapté du scraper pour processMessageFromAPI)
function extractSlashCommandDetailsFromAPI(apiMessage) {
  try {
    let commandName = 'commande';
    let parameters = [];
    let fullCommand = '';
    
    // Méthode 1: Essayer d'extraire depuis le contenu
    if (apiMessage.content && apiMessage.content.trim()) {
      fullCommand = apiMessage.content;
      
      // Pattern pour les commandes slash affichées
      const slashPattern = /^\/(\w+)(.*)$/;
      const match = apiMessage.content.match(slashPattern);
      
      if (match) {
        commandName = match[1];
        const paramsString = match[2].trim();
        
        if (paramsString) {
          // Essayer de parser les paramètres (format basique)
          const paramMatches = paramsString.match(/(\w+):\s*([^\s]+(?:\s+[^\s]+)*?)(?=\s+\w+:|$)/g);
          if (paramMatches) {
            parameters = paramMatches.map(param => {
              const [name, ...valueParts] = param.split(':');
              return {
                name: name.trim(),
                value: valueParts.join(':').trim()
              };
            });
          }
        }
      }
    }
    
    // Méthode 2: Essayer d'extraire depuis les interactions (données Discord)
    if (apiMessage.interaction) {
      const interaction = apiMessage.interaction;
      commandName = interaction.commandName || commandName;
      
      if (interaction.options) {
        parameters = interaction.options.map(option => ({
          name: option.name,
          value: option.value,
          type: option.type
        }));
      }
    }
    
    // Méthode 3: Essayer d'extraire depuis les embeds si la commande est dans un embed
    if (apiMessage.embeds && apiMessage.embeds.length > 0) {
      for (const embed of apiMessage.embeds) {
        if (embed.description && embed.description.includes('/')) {
          const embedSlashMatch = embed.description.match(/^\/(\w+)/);
          if (embedSlashMatch) {
            commandName = embedSlashMatch[1];
            break;
          }
        }
      }
    }
    
    return {
      commandName: commandName,
      parameters: parameters,
      fullCommand: fullCommand || `/${commandName}`,
      extractedFrom: apiMessage.content ? 'content' : 
                     apiMessage.interaction ? 'interaction' : 'embed'
    };
    
  } catch (error) {
    console.error('❌ Erreur extraction détails commande slash:', error);
    return {
      commandName: 'commande',
      parameters: [],
      fullCommand: '/commande',
      extractedFrom: 'fallback'
    };
  }
}

// 🎨 FORMATER LE MESSAGE DE COMMANDE SLASH (adapté du scraper pour processMessageFromAPI)
function formatSlashCommandMessageFromAPI(slashDetails) {
  try {
    let message = `🎯 **Commande Slash Utilisée**\n\n`;
    
    // Nom de la commande
    message += `**📋 Commande :** \`${slashDetails.fullCommand}\`\n`;
    
    // Paramètres si présents
    if (slashDetails.parameters && slashDetails.parameters.length > 0) {
      message += `**⚙️ Paramètres :**\n`;
      for (const param of slashDetails.parameters.slice(0, 10)) { // Limiter à 10 paramètres
        const value = param.value ? param.value.toString().substring(0, 100) : 'vide';
        message += `• \`${param.name}\`: ${value}\n`;
      }
    } else {
      message += `**⚙️ Paramètres :** Aucun\n`;
    }
    
    // Métadonnées
    message += `\n**🔍 Détails :**\n`;
    message += `• Source: ${slashDetails.extractedFrom}\n`;
    message += `• ⏱️ En attente de la réponse du bot...`;
    
    return message;
    
  } catch (error) {
    console.error('❌ Erreur formatage commande slash:', error);
    return `🎯 **Commande Slash** : \`${slashDetails.commandName || 'commande'}\`\n⏱️ En attente de la réponse...`;
  }
}

client.login(process.env.DISCORD_TOKEN); 
