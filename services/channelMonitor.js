const Channel = require('../models/Channel');
const Category = require('../models/Category');
const { isChannelProtected, checkAndLogProtection } = require('../utils/protectedChannels');

/**
 * Fonction pour détecter les catégories et salons à ignorer (anti rate-limit)
 */
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

class ChannelMonitorService {
  constructor(client, logger) {
    this.client = client;
    this.logger = logger;
    this.monitoringInterval = null;
    this.isMonitoring = false;
    this.monitorFrequency = 10 * 60 * 1000; // 10 minutes en millisecondes
    this.lastCheckTime = null;
    this.nextCheckTime = null;

    // 🚀 OPTIMISATION: Cache des salons définitivement inaccessibles
    this.permanentlyFailedChannels = new Set();
    this.MAX_SILENT_RETRIES = 10; // Limite de re-tentatives silencieuses

    // Guard anti-chevauchement des checks périodiques
    this.isCheckInProgress = false;
  }

  /**
   * Démarrer la surveillance automatique des nouveaux salons
   */
  startMonitoring() {
    if (this.isMonitoring) {
      return;
    }

    this.isMonitoring = true;

    // Première vérification immédiate
    this.lastCheckTime = new Date();
    this.nextCheckTime = new Date(Date.now() + this.monitorFrequency);
    this.performChannelCheck();

    // Programmation des vérifications périodiques
    this.monitoringInterval = setInterval(async () => {
      this.lastCheckTime = new Date();
      this.nextCheckTime = new Date(Date.now() + this.monitorFrequency);
      await this.performChannelCheck();
    }, this.monitorFrequency);
  }

  /**
   * Arrêter la surveillance automatique
   */
  stopMonitoring() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    this.isMonitoring = false;
    this.lastCheckTime = null;
    this.nextCheckTime = null;
    this.permanentlyFailedChannels.clear();
  }

  /**
   * Vérifier s'il y a de nouveaux salons sur tous les serveurs configurés
   */
  async performChannelCheck() {
    if (this.isCheckInProgress) return;
    this.isCheckInProgress = true;

    try {
      const stats = this.client.services.userClient.getStats();
      let totalNewChannels = 0;

      for (const guildData of stats.guilds) {
        try {
          const targetGuild = this.client.guilds.cache.get(guildData.guildId);
          if (targetGuild && this.client.services.userClient.hasUserToken(guildData.guildId)) {
            const newChannelsCount = await this.checkServerForNewChannels(targetGuild, guildData.guildId);
            totalNewChannels += newChannelsCount;
          }
        } catch (error) {
          console.error(`❌ Erreur surveillance pour ${guildData.guildId}:`, error);
        }
      }

      if (totalNewChannels > 0) {
      }

    } catch (error) {
      console.error('❌ Erreur lors de la surveillance des salons:', error);
    } finally {
      this.isCheckInProgress = false;
    }
  }

  /**
   * Vérifier les nouveaux salons pour un serveur spécifique
   */
  async checkServerForNewChannels(targetGuild, guildId) {
    try {
      // Récupérer les données du token utilisateur
      const userData = this.client.services.userClient.getUserData(guildId);
      const sourceGuild = this.client.services.userClient.getSourceGuild(guildId);

      if (!userData || !sourceGuild) {
        return 0;
      }

      // Récupérer tous les salons du serveur source via API (pas de threads via fetchGuildThreads car endpoint bot-only)
      const sourceChannels = await this.client.services.userClient.fetchGuildChannels(userData.token, sourceGuild.id);
      
      // Filtrer les salons texte, vocaux et forums
      const sourceTextChannels = sourceChannels.filter(ch => 
        ch.type === 0 ||  // TEXT
        ch.type === 2 ||  // VOICE 
        ch.type === 15    // FORUM (qui créent des threads)
      );
      const sourceCategories = sourceChannels.filter(ch => ch.type === 4); // CATEGORY

      // Récupérer les salons actuels du serveur mirror
      const mirrorChannels = targetGuild.channels.cache.filter(ch => ch.type === 0 || ch.type === 2 || ch.type === 15);

      // 1. OPTIMISATION : Détecter d'abord quels salons seront créés
      const detectionResults = await this.detectAllNewChannels(
        targetGuild,
        sourceTextChannels,
        sourceChannels,
        sourceCategories,
        sourceGuild.id,
        userData,
        mirrorChannels
      );

      // 3. Notifier seulement les NOUVEAUX salons créés
      if (detectionResults.createdChannels > 0) {
        await this.notifyNewChannelsCreated(targetGuild, detectionResults, sourceGuild);
      }

      return detectionResults.createdChannels;

    } catch (error) {
      console.error(`❌ Erreur surveillance serveur ${targetGuild.name}:`, error);
      return 0;
    }
  }

  /**
   * Vérifier si on peut créer de nouveaux canaux (limite Discord: 500)
   * Note: Discord ne limite PAS les catégories (type 4) et threads (types 10, 11, 12)
   */
  async checkChannelLimit(targetGuild) {
    // Discord ne compte pas les catégories et threads dans la limite de 500
    const EXCLUDED_TYPES = [
      4,  // GUILD_CATEGORY
      10, // GUILD_NEWS_THREAD
      11, // GUILD_PUBLIC_THREAD
      12  // GUILD_PRIVATE_THREAD
    ];

    // Compter uniquement les canaux qui sont limités par Discord
    const currentChannelCount = targetGuild.channels.cache.filter(
      channel => !EXCLUDED_TYPES.includes(channel.type)
    ).size;

    // Stats détaillées pour debug
    const totalChannels = targetGuild.channels.cache.size;
    const categories = targetGuild.channels.cache.filter(c => c.type === 4).size;
    const threads = targetGuild.channels.cache.filter(c => [10, 11, 12].includes(c.type)).size;


    const DISCORD_CHANNEL_LIMIT = 500;
    const WARNING_THRESHOLD = 450;

    // Bloquer si limite atteinte
    if (currentChannelCount >= DISCORD_CHANNEL_LIMIT) {
      console.error(`❌ LIMITE DISCORD ATTEINTE: ${currentChannelCount}/${DISCORD_CHANNEL_LIMIT} canaux (hors catégories/threads)`);

      // Logger l'erreur dans admin-logs
      await this.logger.logAdminAction(
        targetGuild.id,
        `🚨 **LIMITE DISCORD ATTEINTE**\n` +
        `📊 Canaux actuels: **${currentChannelCount}/500** (hors catégories et threads)\n` +
        `📈 Total sur le serveur: ${totalChannels} (dont ${categories} catégories, ${threads} threads)\n` +
        `❌ Impossible de créer de nouveaux canaux\n` +
        `⚠️ **ACTION REQUISE:**\n` +
        `• Utiliser \`/autoclean\` pour supprimer les canaux inactifs\n` +
        `• Utiliser \`/delchannel\` pour supprimer manuellement\n` +
        `• Vérifier les canaux inutilisés`
      );

      return { canCreate: false, currentCount: currentChannelCount, limit: DISCORD_CHANNEL_LIMIT };
    }

    // Avertir si proche de la limite
    if (currentChannelCount >= WARNING_THRESHOLD && currentChannelCount < DISCORD_CHANNEL_LIMIT) {
      console.warn(`⚠️ ATTENTION: ${currentChannelCount}/${DISCORD_CHANNEL_LIMIT} canaux (${DISCORD_CHANNEL_LIMIT - currentChannelCount} restants)`);

      // Notifier une seule fois par session (éviter le spam)
      const warningKey = `${targetGuild.id}_channel_limit_warning`;
      if (!this[warningKey]) {
        this[warningKey] = true;

        await this.logger.logAdminAction(
          targetGuild.id,
          `⚠️ **ATTENTION: Proche de la limite Discord**\n` +
          `📊 Canaux actuels: **${currentChannelCount}/500** (hors catégories et threads)\n` +
          `📈 Total sur le serveur: ${totalChannels} éléments\n` +
          `📉 Canaux restants: **${DISCORD_CHANNEL_LIMIT - currentChannelCount}**\n` +
          `💡 **Recommandations:**\n` +
          `• Planifier un nettoyage avec \`/autoclean\`\n` +
          `• Vérifier les canaux peu utilisés\n` +
          `• Considérer l'archivage de vieux canaux`
        );
      }
    }

    return { canCreate: true, currentCount: currentChannelCount, limit: DISCORD_CHANNEL_LIMIT };
  }

  /**
   * Détecter TOUS les nouveaux salons et créer seulement les catégories nécessaires
   */
  async detectAllNewChannels(targetGuild, sourceTextChannels, sourceChannels, sourceCategories, sourceGuildId, userData, mirrorChannels) {
    const results = {
      totalNewChannels: 0,
      createdChannels: 0,
      accessibleChannels: [],
      inaccessibleChannels: [],
      filteredChannels: [],
      manuallyDeletedChannels: []
    };

    // 🆕 ÉTAPE 1 : Analyser quels salons seront créés pour identifier les catégories nécessaires
    const channelsToCreate = [];
    const categoriesNeeded = new Set();


    for (const sourceChannel of sourceTextChannels) {
      // Vérifier si le salon existe déjà sur le mirror
      const existingChannel = Array.from(mirrorChannels.values()).find(mc => mc.name === sourceChannel.name);
      
      if (!existingChannel) {
        results.totalNewChannels++;

        // Vérifier si le salon a été supprimé manuellement
        const manuallyDeletedChannel = await Channel.findOne({
          name: sourceChannel.name,
          serverId: sourceGuildId,
          manuallyDeleted: true
        });
        
        if (manuallyDeletedChannel) {
          results.manuallyDeletedChannels.push({
            name: sourceChannel.name,
            category: this.getCategoryName(sourceChannel, sourceChannels),
            reason: 'Supprimé manuellement'
          });
          continue;
        }

        // ÉTAPE 1.1 : Tester l'accès EN PREMIER
        let hasAccess = false;
        let accessError = null;

        try {
          await this.testChannelAccess(sourceChannel.id, userData, sourceGuildId);
          hasAccess = true;
        } catch (error) {
          hasAccess = false;
          accessError = error.message;
        }

        const categoryName = this.getCategoryName(sourceChannel, sourceChannels);

        if (!hasAccess) {
          // 🚀 OPTIMISATION: Vérifier le cache des salons définitivement inaccessibles
          const channelKey = `${sourceGuildId}:${sourceChannel.id}`;

          if (this.permanentlyFailedChannels.has(channelKey)) {
            // Skip silencieux total - aucun log, aucune action
            continue;
          }

          // Salon inaccessible : ignorer complètement
          results.inaccessibleChannels.push({
            name: sourceChannel.name,
            category: categoryName,
            id: sourceChannel.id,
            reason: accessError
          });

          // Blacklister automatiquement
          await this.autoBlacklistInaccessibleChannel(sourceChannel, sourceGuildId, targetGuild.id, accessError);
          continue;
        }

        // ÉTAPE 1.2 : Appliquer le filtrage sur les salons accessibles
        if (shouldIgnoreCategory(categoryName, sourceChannel.name)) {
          results.filteredChannels.push({
            name: sourceChannel.name,
            category: categoryName,
            reason: 'Salon accessible mais filtré pour éviter le rate limiting'
          });
          continue;
        }

        // 🎯 Salon sera créé : l'ajouter à la liste et marquer sa catégorie comme nécessaire
        channelsToCreate.push(sourceChannel);
        
        if (sourceChannel.parent_id) {
          categoriesNeeded.add(sourceChannel.parent_id);
        }
      }
    }


    // 🆕 VÉRIFICATION LIMITE DISCORD AVANT CRÉATION
    const limitCheck = await this.checkChannelLimit(targetGuild);
    if (!limitCheck.canCreate) {
      console.error(`❌ Création annulée: limite Discord de ${limitCheck.limit} canaux atteinte`);

      // Enregistrer l'erreur pour chaque canal qui aurait été créé
      for (const sourceChannel of channelsToCreate) {
        const categoryName = this.getCategoryName(sourceChannel, sourceChannels);

        await this.logger.logAdminAction(
          targetGuild.id,
          `❌ **Erreur auto-création salon** \`#${sourceChannel.name}\`\n` +
          `📁 Catégorie: ${categoryName || 'Aucune'}\n` +
          `⚠️ Raison: **Maximum number of server channels reached (${limitCheck.currentCount}/500)**`
        );
      }

      results.totalNewChannels = channelsToCreate.length;
      results.filteredChannels = channelsToCreate.map(ch => ({
        name: ch.name,
        category: this.getCategoryName(ch, sourceChannels),
        reason: `Limite Discord atteinte (${limitCheck.currentCount}/500 canaux)`
      }));

      return results;
    }

    // Vérifier si on a assez de place pour créer tous les canaux
    const spacesAvailable = limitCheck.limit - limitCheck.currentCount;
    if (channelsToCreate.length > spacesAvailable) {
      console.warn(`⚠️ Espace insuffisant: ${channelsToCreate.length} canaux à créer, ${spacesAvailable} places disponibles`);

      // Limiter le nombre de canaux à créer
      const channelsToCreateLimited = channelsToCreate.slice(0, spacesAvailable);
      const channelsSkipped = channelsToCreate.slice(spacesAvailable);

      // Logger les canaux qui ne seront pas créés
      for (const skippedChannel of channelsSkipped) {
        results.filteredChannels.push({
          name: skippedChannel.name,
          category: this.getCategoryName(skippedChannel, sourceChannels),
          reason: `Espace insuffisant (${spacesAvailable} places restantes)`
        });
      }

      // Continuer avec les canaux qu'on peut créer
      channelsToCreate.length = 0;
      channelsToCreate.push(...channelsToCreateLimited);

      await this.logger.logAdminAction(
        targetGuild.id,
        `⚠️ **Création partielle de canaux**\n` +
        `📊 Canaux à créer: ${channelsToCreateLimited.length}/${channelsToCreate.length + channelsSkipped.length}\n` +
        `🚫 Canaux ignorés: ${channelsSkipped.length}\n` +
        `📉 Places restantes: ${spacesAvailable}`
      );
    }

    // 🆕 ÉTAPE 2 : Créer SEULEMENT les catégories nécessaires
    const categoryMap = await this.ensureNecessaryCategories(targetGuild, sourceCategories, sourceGuildId, categoriesNeeded);

    // 🆕 ÉTAPE 3 : Créer les salons dans leurs catégories
    for (const sourceChannel of channelsToCreate) {
      try {
        const created = await this.createAccessibleChannel(
          targetGuild,
          sourceChannel,
          sourceChannels,
          categoryMap,
          sourceGuildId
        );
        
        if (created) {
          results.createdChannels++;
          const categoryName = this.getCategoryName(sourceChannel, sourceChannels);
          results.accessibleChannels.push({
            name: sourceChannel.name,
            category: categoryName,
            id: sourceChannel.id,
            created: true
          });
        }
      } catch (createError) {
        const categoryName = this.getCategoryName(sourceChannel, sourceChannels);
        results.accessibleChannels.push({
          name: sourceChannel.name,
          category: categoryName,
          id: sourceChannel.id,
          created: false,
          error: createError.message
        });
      }

      // Délai pour éviter le rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return results;
  }

  /**
   * Obtenir le nom de la catégorie parent d'un salon
   */
  getCategoryName(sourceChannel, sourceChannels) {
    if (!sourceChannel.parent_id) return null;
    
    const parentCategory = sourceChannels.find(c => c.id === sourceChannel.parent_id && c.type === 4);
    return parentCategory ? parentCategory.name : null;
  }

  /**
   * Créer un salon accessible
   */
  async createAccessibleChannel(targetGuild, sourceChannel, sourceChannels, categoryMap, sourceGuildId) {
    try {
      let channelOptions;
      
      // 🏛️ GESTION SPÉCIALE POUR LES SALONS FORUM (type 15)
      if (sourceChannel.type === 15) {
        const { ChannelType } = require('discord.js');
        
        channelOptions = {
          name: sourceChannel.name,
          type: ChannelType.GuildForum, // 15
          topic: sourceChannel.topic || undefined, // undefined plutôt que null
          // Propriétés OBLIGATOIRES pour les forums Discord.js v14
          defaultAutoArchiveDuration: 1440, // 24 heures (obligatoire)
          availableTags: [] // Tags disponibles (obligatoire, même vide)
        };
        
        // Ne pas définir position pour les forums, Discord le gère automatiquement
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
      }

      // Assigner la catégorie si elle existe (pour tous les types)
      if (sourceChannel.parent_id && categoryMap.has(sourceChannel.parent_id)) {
        channelOptions.parent = categoryMap.get(sourceChannel.parent_id);
      }

      let newChannel;
      try {
        newChannel = await targetGuild.channels.create(channelOptions);
        
        // ✅ SUCCÈS - Logger si c'était un forum avec mention cliquable
        if (sourceChannel.type === 15) {
          await this.logger.logNewRoom(
            targetGuild.id,
            `🏛️ Nouveau forum créé: <#${newChannel.id}>`,
            newChannel.parent?.name || 'Aucune',
            newChannel.id
          );
        }
        
      } catch (createError) {
        // 🏛️ GESTION SPÉCIFIQUE ERREUR FORUM avec diagnostic détaillé
        if (sourceChannel.type === 15) {
          console.error(`❌ ERREUR CRÉATION FORUM: ${sourceChannel.name}`);
          console.error(`   Code erreur: ${createError.code}`);
          console.error(`   Message: ${createError.message}`);
          console.error(`   Propriétés utilisées:`, JSON.stringify(channelOptions, null, 2));
          
          // Logger l'erreur détaillée pour investigation
          await this.logger.logAdminAction(
            targetGuild.id,
            `❌ **ÉCHEC CRÉATION FORUM**\n` +
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
      
      // Sauvegarder en base de données avec scraping activé automatiquement
      await this.client.services.channelManager.saveChannelToDatabase(newChannel, sourceGuildId, sourceChannel.id);
      
      // Délai pour éviter le rate limiting
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      return true;

    } catch (error) {
      console.error(`❌ Erreur création salon ${sourceChannel.name}:`, error);
      throw error;
    }
  }

  /**
   * Notifier seulement les nouveaux salons créés
   */
  async notifyNewChannelsCreated(targetGuild, results, sourceGuild) {
    try {
      // Collecter seulement les salons créés avec succès
      const createdChannels = results.accessibleChannels.filter(ch => ch.created);
      
      if (createdChannels.length === 0) {
        return; // Aucun salon créé, pas de notification
      }

      // Message simple avec mentions cliquables
      for (const channel of createdChannels) {
        await this.logger.logNewRoom(
          targetGuild.id,
          `<#${channel.id}>`,
          channel.category || 'Aucune',
          channel.id
        );
      }


    } catch (error) {
      console.error(`❌ Erreur notification nouveaux salons:`, error);
    }
  }

  /**
   * S'assurer que SEULEMENT les catégories nécessaires existent
   */
  async ensureNecessaryCategories(targetGuild, sourceCategories, sourceGuildId, categoriesNeeded) {
    const categoryMap = new Map();
    const mirrorCategories = targetGuild.channels.cache.filter(ch => ch.type === 4);

    // Mapper les catégories existantes
    for (const mirrorCat of mirrorCategories.values()) {
      const sourceCat = sourceCategories.find(sc => sc.name === mirrorCat.name);
      if (sourceCat) {
        categoryMap.set(sourceCat.id, mirrorCat);
      }
    }

    // 🎯 Créer SEULEMENT les catégories nécessaires (celles qui contiennent des salons à créer)
    for (const sourceCategoryId of categoriesNeeded) {
      if (!categoryMap.has(sourceCategoryId)) {
        const sourceCategory = sourceCategories.find(sc => sc.id === sourceCategoryId);
        
        if (!sourceCategory) {
          continue;
        }

        const existingCategory = Array.from(mirrorCategories.values()).find(mc => mc.name === sourceCategory.name);
        
        if (!existingCategory) {
          // Vérifier si la catégorie a été supprimée manuellement
          const manuallyDeletedCategory = await Category.findOne({
            name: sourceCategory.name,
            serverId: sourceGuildId,
            manuallyDeleted: true
          });
          
          if (manuallyDeletedCategory) {
            // Réactiver la catégorie
            manuallyDeletedCategory.manuallyDeleted = false;
            manuallyDeletedCategory.deletedAt = null;
            manuallyDeletedCategory.deletedReason = null;
            await manuallyDeletedCategory.save();
          }

          try {
            const newCategory = await targetGuild.channels.create({
              name: sourceCategory.name,
              type: 4, // CategoryChannel
              position: sourceCategory.position
            });
            
            categoryMap.set(sourceCategory.id, newCategory);
            
            
            await this.logger.logNewRoom(
              targetGuild.id,
              `Nouvelle catégorie: ${newCategory.name}`,
              'Surveillance automatique'
            );
            
            // Délai pour éviter le rate limiting
            await new Promise(resolve => setTimeout(resolve, 1000));
            
          } catch (error) {
            console.error(`❌ Erreur création catégorie nécessaire ${sourceCategory.name}:`, error);
          }
        } else {
          categoryMap.set(sourceCategory.id, existingCategory);
        }
      }
    }

    const createdCount = categoriesNeeded.size - Array.from(categoriesNeeded).filter(id => 
      mirrorCategories.find(mc => {
        const sourceCat = sourceCategories.find(sc => sc.id === id);
        return sourceCat && mc.name === sourceCat.name;
      })
    ).length;

    if (createdCount > 0) {
    } else {
    }

    return categoryMap;
  }

  /**
   * S'assurer que les catégories nécessaires existent (méthode legacy)
   */
  async ensureCategories(targetGuild, sourceCategories, sourceGuildId) {
    const categoryMap = new Map();
    const mirrorCategories = targetGuild.channels.cache.filter(ch => ch.type === 4);

    // Mapper les catégories existantes
    for (const mirrorCat of mirrorCategories.values()) {
      const sourceCat = sourceCategories.find(sc => sc.name === mirrorCat.name);
      if (sourceCat) {
        categoryMap.set(sourceCat.id, mirrorCat);
      }
    }

    // Créer les nouvelles catégories si nécessaire
    for (const sourceCategory of sourceCategories) {
      if (!categoryMap.has(sourceCategory.id)) {
        const existingCategory = Array.from(mirrorCategories.values()).find(mc => mc.name === sourceCategory.name);
        
        if (!existingCategory) {
          // Vérifier si la catégorie a été supprimée manuellement
          const manuallyDeletedCategory = await Category.findOne({
            name: sourceCategory.name,
            serverId: sourceGuildId,
            manuallyDeleted: true
          });
          
          if (manuallyDeletedCategory) {
            // Réactiver la catégorie
            manuallyDeletedCategory.manuallyDeleted = false;
            manuallyDeletedCategory.deletedAt = null;
            manuallyDeletedCategory.deletedReason = null;
            await manuallyDeletedCategory.save();
          }

          try {
            const newCategory = await targetGuild.channels.create({
              name: sourceCategory.name,
              type: 4, // CategoryChannel
              position: sourceCategory.position
            });
            
            categoryMap.set(sourceCategory.id, newCategory);
            
            
            await this.logger.logNewRoom(
              targetGuild.id,
              `Nouvelle catégorie: ${newCategory.name}`,
              'Surveillance automatique'
            );
            
            // Délai pour éviter le rate limiting
            await new Promise(resolve => setTimeout(resolve, 1000));
            
          } catch (error) {
            console.error(`❌ Erreur création catégorie ${sourceCategory.name}:`, error);
          }
        } else {
          categoryMap.set(sourceCategory.id, existingCategory);
        }
      }
    }

    return categoryMap;
  }



  /**
   * Tester l'accès à un salon avant de le créer
   */
  async testChannelAccess(channelId, userData, sourceGuildId) {
    try {
      const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
      const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=1`, {
        headers: {
          'Authorization': userData.token,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      
      if (response.status === 403) {
        const error = new Error(`Accès refusé au salon ${channelId} (403 Forbidden)`);
        error.isAccessError = true;
        error.statusCode = 403;
        throw error;
      } else if (response.status === 404) {
        const error = new Error(`Salon ${channelId} introuvable (404 Not Found)`);
        error.isAccessError = true;
        error.statusCode = 404;
        throw error;
      } else if (!response.ok) {
        const error = new Error(`Erreur d'accès au salon ${channelId} (${response.status})`);
        error.isAccessError = true;
        error.statusCode = response.status;
        throw error;
      }
      
      return true;
      
    } catch (error) {
      if (error.isAccessError) {
        throw error;
      }
      
      const accessError = new Error(`Impossible de tester l'accès au salon ${channelId}: ${error.message}`);
      accessError.isAccessError = true;
      accessError.originalError = error;
      throw accessError;
    }
  }

  /**
   * Blacklister automatiquement un salon inaccessible
   */
  async autoBlacklistInaccessibleChannel(sourceChannel, sourceGuildId, targetGuildId, reason) {
    try {
      const now = new Date();
      const next330AM = this.getNext330AM();
      
      // D'abord, essayer de récupérer le document existant par sourceChannelId
      const existingChannel = await Channel.findOne({ sourceChannelId: sourceChannel.id, serverId: sourceGuildId });
      
      let updatedChannel;
      let isFirstTimeBlacklist = false;
      
      if (existingChannel) {
        // Le salon existe déjà - vérifier s'il était déjà blacklisté
        isFirstTimeBlacklist = !existingChannel.isBlacklisted;
        
        // Mettre à jour le document existant
        existingChannel.isBlacklisted = true;
        existingChannel.blacklistedUntil = next330AM;
        existingChannel.lastFailedAt = now;
        existingChannel.scraped = false;
        existingChannel.failedAttempts = (existingChannel.failedAttempts || 0) + 1;
        
        // Mettre à jour le nom si il a changé (cas de renommage)
        if (existingChannel.name !== sourceChannel.name) {
          existingChannel.name = sourceChannel.name;
        }
        
        updatedChannel = await existingChannel.save();
        
      } else {
        // Le salon n'existe pas - le créer avec blacklist
        isFirstTimeBlacklist = true;
        
        try {
          // Utiliser findOneAndUpdate avec upsert — $setOnInsert protège discordId existant
          updatedChannel = await Channel.findOneAndUpdate(
            { sourceChannelId: sourceChannel.id, serverId: sourceGuildId },
            {
              $set: {
                name: sourceChannel.name,
                isBlacklisted: true,
                blacklistedUntil: next330AM,
                lastFailedAt: now,
                scraped: false
              },
              $setOnInsert: {
                discordId: sourceChannel.id,
                serverId: sourceGuildId,
                sourceChannelId: sourceChannel.id,
                category: null
              },
              $inc: { failedAttempts: 1 }
            },
            { upsert: true, new: true }
          );
        } catch (createError) {
          // Si erreur E11000 (conflit discordId), réessayer sans changer discordId
          if (createError.code === 11000) {
            updatedChannel = await Channel.findOneAndUpdate(
              { sourceChannelId: sourceChannel.id, serverId: sourceGuildId },
              {
                $set: {
                  isBlacklisted: true,
                  blacklistedUntil: next330AM,
                  lastFailedAt: now,
                  scraped: false,
                  name: sourceChannel.name
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
        // Utiliser logAdminAction au lieu de logNewRoom pour envoyer dans #admin-logs
        await this.logger.logAdminAction(
          targetGuildId,
          `🚫 **Auto-blacklist salon inaccessible**\n` +
          `📛 Salon : \`#${sourceChannel.name}\`\n` +
          `❌ Raison : ${reason}\n` +
          `⏰ Réactivation : ${this.getNext330AM().toLocaleString('fr-FR')}\n` +
          `🛡️ Auto-discovery ne tentera plus de créer ce salon`
        );

        console.log(`🚫 PREMIER blacklist (notification admin): #${sourceChannel.name}`);
      } else {
        // 🚀 OPTIMISATION: Limiter les logs de re-blacklist
        const channelKey = `${sourceGuildId}:${sourceChannel.id}`;
        const failedAttempts = updatedChannel.failedAttempts || 0;

        if (failedAttempts === this.MAX_SILENT_RETRIES) {
          // Marquer comme définitivement inaccessible cette session
          this.permanentlyFailedChannels.add(channelKey);
          console.log(`🛑 Salon définitivement inaccessible cette session: #${sourceChannel.name} (après ${this.MAX_SILENT_RETRIES} tentatives)`);
        } else if (failedAttempts < this.MAX_SILENT_RETRIES) {
          // Log normal pour les premières tentatives
          console.log(`🔕 Re-blacklist silencieux: #${sourceChannel.name} (tentative ${failedAttempts})`);
        }
        // Après MAX_SILENT_RETRIES : Plus aucun log
      }
      
    } catch (error) {
      console.error(`❌ Erreur blacklist automatique ${sourceChannel.name}:`, error);
    }
  }

  /**
   * Obtenir la prochaine heure de 3h30 du matin
   */
  getNext330AM() {
    const now = new Date();
    const next330 = new Date(now);
    next330.setHours(3, 30, 0, 0);
    
    // Si c'est déjà passé aujourd'hui, prendre demain
    if (next330 <= now) {
      next330.setDate(next330.getDate() + 1);
    }
    
    return next330;
  }

  /**
   * Obtenir les statistiques de surveillance
   */
  getMonitoringStats() {
    return {
      isMonitoring: this.isMonitoring,
      frequency: this.monitorFrequency,
      frequencyMinutes: this.monitorFrequency / (60 * 1000),
      lastCheck: this.lastCheckTime,
      nextCheck: this.nextCheckTime
    };
  }

  /**
   * Changer la fréquence de surveillance
   */
  setMonitoringFrequency(minutes) {
    if (minutes < 1) {
      throw new Error('La fréquence doit être d\'au moins 1 minute');
    }
    
    this.monitorFrequency = minutes * 60 * 1000;
    console.log(`🔧 Fréquence de surveillance changée: ${minutes} minutes`);
    
    // Redémarrer la surveillance avec la nouvelle fréquence si elle était active
    if (this.isMonitoring) {
      this.stopMonitoring();
      this.startMonitoring();
    }
  }

  /**
   * Effectuer une vérification manuelle immédiate
   */
  async performManualCheck() {
    await this.performChannelCheck();
  }
}

module.exports = ChannelMonitorService; 