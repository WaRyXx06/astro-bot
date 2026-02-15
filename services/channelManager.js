const Channel = require('../models/Channel');
const { resolveChannelNameConflict, resolveCategoryNameConflict, sanitizeChannelName, sanitizeCategoryName } = require('../utils/nameConflict');
const { setupChannelPermissions } = require('../utils/permissions');
const CorrespondenceManager = require('./correspondenceManager');

class ChannelManager {
  constructor(client, logger) {
    this.client = client;
    this.logger = logger;
    this.sourceGuilds = new Map(); // Map<guildId, sourceGuild>
    this.correspondenceManager = new CorrespondenceManager(client, logger);
  }

  // Définir le serveur source pour le clonage
  setSourceGuild(targetGuildId, sourceGuild) {
    this.sourceGuilds.set(targetGuildId, sourceGuild);
  }

  // Cloner tous les salons d'un serveur source
  async cloneAllChannels(targetGuild, sourceGuild, options = {}) {
    try {
      const { filterInactive = true, excludeCategories = [] } = options;
      
      
      const sourceChannels = sourceGuild.channels.cache
        .filter(channel => channel.type === 0 || channel.type === 2) // Text et Voice channels
        .filter(channel => !excludeCategories.includes(channel.parent?.name));

      const clonedChannels = [];
      const errors = [];

      // Créer les catégories d'abord
      const categoryMap = await this.createCategories(targetGuild, sourceGuild, excludeCategories);

      for (const [channelId, sourceChannel] of sourceChannels) {
        try {
          // Vérifier si ce salon a été marqué comme supprimé manuellement
          const existingChannel = await Channel.findOne({
            serverId: sourceGuild.id,
            $or: [
              { sourceChannelId: channelId },
              { name: sourceChannel.name }
            ],
            manuallyDeleted: true
          });

          if (existingChannel) {
            continue;
          }

          // Vérifier si le salon est inactif (optionnel)
          if (filterInactive && await this.isChannelInactive(sourceChannel)) {
            continue;
          }

          const clonedChannel = await this.cloneChannel(targetGuild, sourceChannel, categoryMap);
          if (clonedChannel) {
            clonedChannels.push(clonedChannel);
            
            // Sauvegarder en base de données avec l'ID source
            await this.saveChannelToDatabase(clonedChannel, sourceGuild.id, sourceChannel.id);
            
            // Logger la création avec mention cliquable
            await this.logger.logNewRoom(
              targetGuild.id,
              `<#${clonedChannel.id}>`,
              clonedChannel.parent?.name || 'Aucune',
              clonedChannel.id
            );
          }
        } catch (error) {
          console.error(`Erreur lors du clonage du salon ${sourceChannel.name}:`, error);
          errors.push({ channel: sourceChannel.name, error: error.message });
          
          // Logger les erreurs d'accès
          if (error.code === 50001 || error.code === 50013) {
            await this.logger.logPrivateChannelError(targetGuild.id, sourceChannel.name);
          } else {
            await this.logger.logError(
        targetGuild.id, 
        `Erreur clonage ${sourceChannel.name}: ${error.message}`,
        sourceChannel.name,
        {
          error: error,
          sourceChannelId: sourceChannel.id,
          sourceChannelName: sourceChannel.name,
          sourceChannelType: sourceChannel.type,
          sourceCategoryId: sourceChannel.parent?.id,
          sourceCategoryName: sourceChannel.parent?.name,
          targetGuildId: targetGuild.id,
          hasPermissions: sourceChannel.permissionsFor(this.client.user)?.has('ViewChannel'),
          systemInfo: {
            operation: 'channelClone',
            sourceGuildName: sourceChannel.guild.name,
            targetGuildName: targetGuild.name,
            channelPosition: sourceChannel.position
          }
        }
      );
          }
        }
      }

      return { clonedChannels, errors };
    } catch (error) {
      console.error('Erreur lors du clonage complet:', error);
      throw error;
    }
  }

  // Créer les catégories nécessaires
  async createCategories(targetGuild, sourceGuild, excludeCategories = []) {
    const categoryMap = new Map();
    const sourceCategories = sourceGuild.channels.cache
      .filter(channel => channel.type === 4) // CategoryChannel
      .filter(category => !excludeCategories.includes(category.name));

    for (const [categoryId, sourceCategory] of sourceCategories) {
      try {
        const sanitizedName = sanitizeCategoryName(sourceCategory.name);
        const finalName = await resolveCategoryNameConflict(targetGuild, sanitizedName);
        
        const newCategory = await targetGuild.channels.create({
          name: finalName,
          type: 4, // CategoryChannel
          position: sourceCategory.position
        });

        categoryMap.set(categoryId, newCategory);
      } catch (error) {
        console.error(`Erreur lors de la création de la catégorie ${sourceCategory.name}:`, error);
      }
    }

    return categoryMap;
  }

  // Cloner un salon individuel
  async cloneChannel(targetGuild, sourceChannel, categoryMap) {
    try {
      const sanitizedName = sanitizeChannelName(sourceChannel.name);
      const finalName = await resolveChannelNameConflict(targetGuild, sanitizedName);
      
      const channelOptions = {
        name: finalName,
        type: sourceChannel.type,
        topic: sourceChannel.topic,
        position: sourceChannel.position
      };

      // Assigner la catégorie si elle existe
      if (sourceChannel.parent && categoryMap.has(sourceChannel.parent.id)) {
        channelOptions.parent = categoryMap.get(sourceChannel.parent.id).id;
      }

      // Paramètres spécifiques aux salons vocaux
      if (sourceChannel.type === 2) {
        channelOptions.bitrate = sourceChannel.bitrate;
        channelOptions.userLimit = sourceChannel.userLimit;
      }

      const newChannel = await targetGuild.channels.create(channelOptions);
      
      return newChannel;
    } catch (error) {
      console.error(`Erreur lors du clonage du salon ${sourceChannel.name}:`, error);
      throw error;
    }
  }

  // Ajouter un salon manuellement
  async addChannel(targetGuild, sourceGuild, channelName) {
    try {
      const sourceChannel = sourceGuild.channels.cache.find(
        channel => channel.name === channelName || channel.id === channelName
      );

      if (!sourceChannel) {
        throw new Error(`Salon ${channelName} introuvable sur le serveur source`);
      }

      // Vérifier si ce salon a été marqué comme supprimé manuellement
      const existingChannel = await Channel.findOne({
        serverId: sourceGuild.id,
        $or: [
          { sourceChannelId: sourceChannel.id },
          { name: sourceChannel.name }
        ],
        manuallyDeleted: true
      });

      if (existingChannel) {
        throw new Error(`Salon ${sourceChannel.name} a été marqué comme supprimé manuellement et ne peut pas être recréé`);
      }

      // Créer la catégorie si nécessaire
      let targetCategory = null;
      if (sourceChannel.parent) {
        targetCategory = targetGuild.channels.cache.find(
          channel => channel.type === 4 && channel.name === sourceChannel.parent.name
        );

        if (!targetCategory) {
          const categoryName = await resolveCategoryNameConflict(targetGuild, sourceChannel.parent.name);
          targetCategory = await targetGuild.channels.create({
            name: categoryName,
            type: 4
          });
        }
      }

      const categoryMap = new Map();
      if (targetCategory && sourceChannel.parent) {
        categoryMap.set(sourceChannel.parent.id, targetCategory);
      }

      const clonedChannel = await this.cloneChannel(targetGuild, sourceChannel, categoryMap);
      
      // Sauvegarder en base de données avec l'ID source
      await this.saveChannelToDatabase(clonedChannel, sourceGuild.id, sourceChannel.id);
      
      // Logger la création avec mention cliquable
      await this.logger.logNewRoom(
        targetGuild.id,
        `<#${clonedChannel.id}>`,
        clonedChannel.parent?.name || 'Aucune',
        clonedChannel.id
      );

      return clonedChannel;
    } catch (error) {
      console.error(`Erreur lors de l'ajout du salon ${channelName}:`, error);
              await this.logger.logError(
          targetGuild.id, 
          `Erreur ajout salon ${channelName}: ${error.message}`,
          channelName,
          {
            error: error,
            channelName: channelName,
            targetGuildId: targetGuild.id,
            systemInfo: {
              operation: 'channelAdd',
              targetGuildName: targetGuild.name
            }
          }
        );
      throw error;
    }
  }

  // Supprimer un salon avec marquage intelligent
  async removeChannel(targetGuild, channelName) {
    try {
      const channel = targetGuild.channels.cache.find(
        ch => ch.name === channelName || ch.id === channelName
      );

      if (!channel) {
        throw new Error(`Salon ${channelName} introuvable`);
      }

      // 🏷️ MÉTHODE 2 : Marquer comme supprimé manuellement au lieu de supprimer
      const channelDB = await Channel.findOne({ discordId: channel.id });
      
      if (channelDB) {
        // Marquer comme supprimé manuellement plutôt que supprimer de la base
        channelDB.manuallyDeleted = true;
        channelDB.deletedAt = new Date();
        channelDB.deletedReason = 'Suppression manuelle via /delroom';
        channelDB.scraped = false; // Arrêter le scraping
        await channelDB.save();
        
      } else {
      }
      
      // Supprimer le salon Discord
      await channel.delete();
      
      // Logger la suppression avec mention du marquage
      await this.logger.logManualChannelDeletion(targetGuild.id, channel.name);
      
      return true;
    } catch (error) {
      console.error(`Erreur lors de la suppression du salon ${channelName}:`, error);
      await this.logger.logError(targetGuild.id, `Erreur suppression salon ${channelName}: ${error.message}`);
      throw error;
    }
  }

  // Vérifier si un salon est inactif
  async isChannelInactive(channel) {
    try {
      if (channel.type !== 0) return false; // Seulement les salons texte
      
      const thresholdDays = parseInt(process.env.INACTIVE_THRESHOLD_DAYS) || 30;
      const threshold = new Date(Date.now() - thresholdDays * 24 * 60 * 60 * 1000);
      
      // Récupérer les derniers messages
      const messages = await channel.messages.fetch({ limit: 1 });
      if (messages.size === 0) return true;
      
      const lastMessage = messages.first();
      return lastMessage.createdAt < threshold;
    } catch (error) {
      // Si on ne peut pas accéder aux messages, considérer comme inactif
      return true;
    }
  }

  // Sauvegarder les informations du salon en base de données
  async saveChannelToDatabase(channel, sourceServerId, sourceChannelId = null, autoScraped = true) {
    try {
      const result = await Channel.findOneAndUpdate(
        { discordId: channel.id },
        {
          $set: {
            serverId: sourceServerId,
            name: channel.name,
            category: channel.parent?.name || null,
            inactive: false
          },
          $setOnInsert: {
            sourceChannelId: sourceChannelId,
            scraped: autoScraped,
            delaySeconds: 5
          }
        },
        { upsert: true, new: true }
      );

      // Si le doc existait sans sourceChannelId et qu'on en a un maintenant
      if (sourceChannelId && typeof sourceChannelId === 'string' && !result.sourceChannelId) {
        result.sourceChannelId = sourceChannelId;
        await result.save();
      }

      // Enregistrer la correspondance si sourceChannelId valide
      if (sourceChannelId && typeof sourceChannelId === 'string') {
        await this.correspondenceManager.registerChannelMapping(
          sourceChannelId,
          sourceServerId,
          channel.name,
          channel.id
        );
      }
    } catch (error) {
      console.error('Erreur lors de la sauvegarde du salon:', error);
    }
  }

  // Auto-discovery: détecter les nouveaux salons sur le serveur source
  async discoverNewChannels(targetGuild, sourceGuild) {
    try {
      const sourceChannels = sourceGuild.channels.cache
        .filter(channel => channel.type === 0 || channel.type === 2 || channel.type === 5 || channel.type === 15); // Inclure les annonces et forums
      
      const existingChannels = await Channel.find({ serverId: sourceGuild.id });
      // FIX: Utiliser sourceChannelId au lieu de discordId pour la comparaison
      // ET exclure les salons marqués comme supprimés manuellement
      const existingSourceChannelIds = new Set(existingChannels
        .filter(ch => ch.sourceChannelId && !ch.manuallyDeleted) // Filtrer ceux qui ont un sourceChannelId ET ne sont pas supprimés manuellement
        .map(ch => ch.sourceChannelId));
      
      // Ajouter aussi les salons qui existent déjà sur mirror (par nom) mais sans sourceChannelId
      const existingMirrorNames = new Set(targetGuild.channels.cache
        .filter(ch => ch.type === 0 || ch.type === 2 || ch.type === 5 || ch.type === 15)
        .map(ch => ch.name));
      
      const newChannels = [];
      const updatedMappings = [];
      
      for (const [channelId, sourceChannel] of sourceChannels) {
        // Vérifier si ce salon a été marqué comme supprimé manuellement (par nom ou sourceChannelId)
        const manuallyDeletedEntry = existingChannels.find(ch =>
          ch.manuallyDeleted && (
            ch.sourceChannelId === channelId ||
            ch.name === sourceChannel.name
          )
        );

        if (manuallyDeletedEntry) {
          continue;
        }

        // Comparer avec les IDs source, pas les IDs mirror
        if (!existingSourceChannelIds.has(channelId)) {
          // Vérifier si le salon existe déjà sur mirror par nom
          const mirrorChannel = targetGuild.channels.cache.find(ch =>
            ch.name === sourceChannel.name && (ch.type === 0 || ch.type === 2 || ch.type === 15)
          );

          if (mirrorChannel) {
            // Le salon existe déjà, juste créer le mapping
            await this.correspondenceManager.registerChannelMapping(
              channelId,
              sourceGuild.id,
              sourceChannel.name,
              mirrorChannel.id
            );
            updatedMappings.push(sourceChannel.name);
          } else {
            // Le salon n'existe pas, le créer
            try {
              const clonedChannel = await this.addChannel(targetGuild, sourceGuild, sourceChannel.name);
              newChannels.push(clonedChannel);
            } catch (error) {
              console.error(`Erreur lors de l'auto-discovery du salon ${sourceChannel.name}:`, error);
            }
          }
        }
      }
      
      if (newChannels.length > 0 || updatedMappings.length > 0) {
      }
      
      return { newChannels, updatedMappings };
    } catch (error) {
      console.error('Erreur lors de l\'auto-discovery:', error);
      return { newChannels: [], updatedMappings: [] };
    }
  }

  // Nettoyer les salons supprimés du serveur source
  async cleanupDeletedChannels(targetGuild, sourceGuild) {
    try {
      const sourceChannelIds = new Set(sourceGuild.channels.cache.keys());
      const trackedChannels = await Channel.find({ serverId: sourceGuild.id });
      
      for (const trackedChannel of trackedChannels) {
        if (!sourceChannelIds.has(trackedChannel.discordId)) {
          // Le salon a été supprimé du serveur source
          const targetChannel = targetGuild.channels.cache.find(
            ch => ch.name === trackedChannel.name
          );
          
          if (targetChannel) {
            await targetChannel.delete();
            await this.logger.logChannelDeleted(targetGuild.id, trackedChannel.name);
          }
          
          // Supprimer de la base de données
          await Channel.deleteOne({ _id: trackedChannel._id });
        }
      }
    } catch (error) {
      console.error('Erreur lors du nettoyage des salons supprimés:', error);
    }
  }

  // Obtenir la liste des salons avec filtrage
  async getChannelList(serverId, filterInactive = false) {
    try {
      const query = { serverId };
      if (filterInactive) {
        query.inactive = { $ne: true };
      }
      
      return await Channel.find(query).sort({ name: 1 });
    } catch (error) {
      console.error('Erreur lors de la récupération de la liste des salons:', error);
      return [];
    }
  }
}

module.exports = ChannelManager; 