/**
 * Configuration des commandes slash
 * Séparation entre commandes globales (admin) et commandes par serveur
 */

const { PermissionFlagsBits } = require('discord.js');

// Commandes globales disponibles sur TOUS les serveurs (administration)
const GLOBAL_COMMANDS = [
  {
    name: 'initialise',
    description: '🛠️ Initialiser le système mirror pour ce serveur',
    defaultMemberPermissions: PermissionFlagsBits.Administrator
  }
];

// Commandes spécifiques à chaque serveur mirror
const GUILD_COMMANDS = [
  // === GESTION DU SCRAPING ===
  {
    name: 'start',
    description: '▶️ Démarrer le scraping événementiel (temps réel)',
    defaultMemberPermissions: PermissionFlagsBits.Administrator
  },
  {
    name: 'stop',
    description: '⏸️ Arrêter le scraping',
    defaultMemberPermissions: PermissionFlagsBits.Administrator
  },

  // === SYNCHRONISATION ===
  {
    name: 'syncroles',
    description: '👥 Synchroniser les rôles du serveur source',
    defaultMemberPermissions: PermissionFlagsBits.Administrator
  },
  {
    name: 'clone',
    description: '📋 Cloner automatiquement tous les salons du serveur source',
    defaultMemberPermissions: PermissionFlagsBits.Administrator
  },
  {
    name: 'discovery',
    description: '🔍 Découvrir et ajouter les nouveaux salons du serveur source',
    defaultMemberPermissions: PermissionFlagsBits.Administrator
  },

  // === GESTION DES SALONS ===
  {
    name: 'delchannel',
    description: '🗑️ Supprimer un salon spécifique',
    defaultMemberPermissions: PermissionFlagsBits.Administrator,
    options: [{
      name: 'channel_name',
      type: 3, // STRING
      description: 'Nom du salon à supprimer',
      required: true
    }]
  },
  {
    name: 'delcategories',
    description: '🗑️ Supprimer une catégorie entière avec tous ses salons',
    defaultMemberPermissions: PermissionFlagsBits.Administrator,
    options: [{
      name: 'category_id',
      type: 3, // STRING
      description: 'ID de la catégorie à supprimer (avec tous ses salons)',
      required: true
    }]
  },

  // === GESTION DES RÔLES ===
  {
    name: 'setup-roles',
    description: '🎯 Configurer automatiquement les rôles de gestion',
    defaultMemberPermissions: PermissionFlagsBits.Administrator,
    options: [{
      name: 'mention_role',
      type: 3, // STRING (nom du rôle du serveur source)
      description: 'Nom du rôle à mentionner (serveur source)',
      required: false
    }]
  },


  // === MAINTENANCE ===
  {
    name: 'cleanup',
    description: '🧹 Nettoyer les salons supprimés et réactiver les salons blacklistés',
    defaultMemberPermissions: PermissionFlagsBits.Administrator,
    options: [{
      name: 'include_blacklisted',
      type: 5, // BOOLEAN
      description: 'Inclure la réactivation des salons blacklistés (par défaut: false)',
      required: false
    }]
  },
  {
    name: 'purge-logs',
    description: '🧹 Supprimer tous les logs système pour libérer l\'espace DB',
    defaultMemberPermissions: PermissionFlagsBits.Administrator
  },
  {
    name: 'emergency-purge',
    description: '🚨 EMERGENCY: Purger TOUTES les collections temporaires MongoDB',
    defaultMemberPermissions: PermissionFlagsBits.Administrator
  },
  {
    name: 'fix-correspondances',
    description: '🔧 Réparer les correspondances de salons (corrige #inconnu)',
    defaultMemberPermissions: PermissionFlagsBits.Administrator
  },
  {
    name: 'blacklist',
    description: '🚫 Gestion de la blacklist des salons (accès refusé)',
    defaultMemberPermissions: PermissionFlagsBits.Administrator,
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
    defaultMemberPermissions: PermissionFlagsBits.Administrator,
    options: [
      {
        name: 'name',
        type: 3, // STRING
        description: 'Nom du salon ou de la catégorie à réactiver',
        required: true
      }
    ]
  },
  {
    name: 'autoclean',
    description: '🧹 Nettoyer automatiquement les canaux inactifs pour libérer de l\'espace',
    defaultMemberPermissions: PermissionFlagsBits.Administrator,
    options: [
      {
        name: 'days',
        type: 4, // INTEGER
        description: 'Supprimer les canaux inactifs depuis X jours (défaut: 30)',
        required: false,
        minValue: 7,
        maxValue: 365
      },
      {
        name: 'dry_run',
        type: 5, // BOOLEAN
        description: 'Voir ce qui serait supprimé sans supprimer (défaut: false)',
        required: false
      },
      {
        name: 'limit',
        type: 4, // INTEGER
        description: 'Nombre maximum de canaux à supprimer (défaut: 10)',
        required: false,
        minValue: 1,
        maxValue: 50
      }
    ]
  },

  // === AUTO-REPAIR ===
  {
    name: 'auto-repair',
    description: '🔧 Activer/désactiver la correction automatique des correspondances manquantes',
    defaultMemberPermissions: PermissionFlagsBits.Administrator,
    options: [
      {
        name: 'action',
        type: 3, // STRING
        description: 'Action à effectuer',
        required: true,
        choices: [
          { name: '✅ Activer', value: 'enable' },
          { name: '❌ Désactiver', value: 'disable' },
          { name: '📊 Voir le statut', value: 'status' }
        ]
      }
    ]
  },

  // === ANALYSE DES MEMBRES ===
  {
    name: 'members-analysis',
    description: '📊 Analyser les mouvements et membres dangereux entre serveurs',
    defaultMemberPermissions: PermissionFlagsBits.Administrator,
    options: [
      {
        name: 'action',
        type: 3, // STRING
        description: 'Type d\'analyse à effectuer',
        required: true,
        choices: [
          { name: '🔍 Check immédiat', value: 'check' },
          { name: '⚠️ Membres dangereux', value: 'dangerous' },
          { name: '📊 Rapport quotidien', value: 'daily-report' },
          { name: '🎯 Opportunités', value: 'opportunities' }
        ]
      },
      {
        name: 'user',
        type: 3, // STRING (ID ou username du serveur source)
        description: 'ID ou nom du membre à analyser (serveur source)',
        required: false
      }
    ]
  },

  // === TEST TEMPORAIRE ===
  {
    name: 'test-access',
    description: '🧪 [TEMP] Tester les permissions d\'accès aux membres du serveur source',
    defaultMemberPermissions: PermissionFlagsBits.Administrator
  },

  // === TEST PROXAUTH ===
  {
    name: 'test-proxauth',
    description: '🧪 [TEST] Simuler un message ProxAuth pour tester le système de bypass',
    defaultMemberPermissions: PermissionFlagsBits.Administrator,
    options: [{
      name: 'url',
      type: 3, // STRING
      description: 'URL ProxAuth à tester (ex: https://proxauth.fr/links/c9a57a)',
      required: true
    }]
  },

  // === GESTION DES MENTIONS ===
  {
    name: 'mention-blacklist',
    description: '🚫 Gestion de la blacklist des salons pour les notifications de mentions',
    defaultMemberPermissions: PermissionFlagsBits.Administrator,
    options: [
      {
        name: 'action',
        type: 3, // STRING
        description: 'Action à effectuer',
        required: true,
        choices: [
          { name: 'Voir la liste', value: 'list' },
          { name: 'Ajouter un salon', value: 'add' },
          { name: 'Retirer un salon', value: 'remove' },
          { name: 'Nettoyer tout', value: 'clear' }
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
  },
  {
    name: 'notification-channels',
    description: '🔔 Gestion des salons de notifications de mentions',
    defaultMemberPermissions: PermissionFlagsBits.Administrator,
    options: [
      {
        name: 'action',
        type: 3, // STRING
        description: 'Action à effectuer',
        required: true,
        choices: [
          { name: 'Voir configuration', value: 'show' },
          { name: 'Définir salon principal', value: 'set_main' },
          { name: 'Définir salon backup', value: 'set_backup' },
          { name: 'Auto-détecter', value: 'auto_detect' },
          { name: 'Tester', value: 'test' }
        ]
      },
      {
        name: 'channel_id',
        type: 3, // STRING
        description: 'ID du salon (pour set_main/set_backup)',
        required: false
      }
    ]
  },

  // === SCAN DES MEMBRES ===
  {
    name: 'scan-members',
    description: '🔍 Lancer un scan complet des membres du serveur source',
    defaultMemberPermissions: PermissionFlagsBits.Administrator,
    options: [
      {
        name: 'thorough',
        type: 5, // BOOLEAN
        description: 'Scan approfondi avec recherche alphabétique (plus lent mais plus complet)',
        required: false
      }
    ]
  },

  // === BACKFILL MESSAGES ===
  {
    name: 'backfill',
    description: '📥 Récupérer les derniers messages d\'un salon source',
    defaultMemberPermissions: PermissionFlagsBits.Administrator,
    options: [
      {
        name: 'channel_name',
        type: 3, // STRING
        description: 'Nom du salon source à backfill',
        required: true
      },
      {
        name: 'count',
        type: 4, // INTEGER
        description: 'Nombre de messages à récupérer (défaut: 10, max: 10)',
        required: false,
        minValue: 1,
        maxValue: 10
      }
    ]
  }
];

module.exports = {
  GLOBAL_COMMANDS,
  GUILD_COMMANDS
};