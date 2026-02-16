const Channel = require('../models/Channel');
const Role = require('../models/Role');

class CorrespondenceManager {
  constructor(client, logger) {
    this.client = client;
    this.logger = logger;
    // Cache pour éviter les requêtes répétées (avec limites de taille)
    this.channelCache = new Map(); // sourceChannelId -> mirrorChannelId
    this.roleCache = new Map(); // sourceRoleId -> mirrorRoleId
    this.MAX_CHANNEL_CACHE_SIZE = 2000;
    this.MAX_ROLE_CACHE_SIZE = 500;

    // Cache pour éviter les notifications d'erreur en double
    this.notifiedErrors = new Set(); // sourceChannelId pour éviter le spam
    // Service de récupération automatique (sera injecté après initialisation)
    this.autoRecoveryService = null;

    // 🛡️ NOUVEAU: Set pour déduplication des créations en cours (évite race conditions)
    this.pendingCreations = new Set(); // creationKey -> en cours de création

    // 🧹 Cleanup périodique toutes les 30 minutes
    this.cleanupInterval = setInterval(() => {
      try {
        // Nettoyer notifiedErrors
        if (this.notifiedErrors.size > 0) {
          console.log(`🧹 CorrespondenceManager: Nettoyage de ${this.notifiedErrors.size} erreurs notifiées`);
          this.notifiedErrors.clear();
        }

        // Limiter la taille des caches (éviction FIFO si trop gros)
        if (this.channelCache.size > this.MAX_CHANNEL_CACHE_SIZE) {
          const toDelete = this.channelCache.size - this.MAX_CHANNEL_CACHE_SIZE;
          const keys = Array.from(this.channelCache.keys()).slice(0, toDelete);
          keys.forEach(k => this.channelCache.delete(k));
          console.log(`🧹 CorrespondenceManager: channelCache élagué de ${toDelete} entrées (reste ${this.channelCache.size})`);
        }
        if (this.roleCache.size > this.MAX_ROLE_CACHE_SIZE) {
          const toDelete = this.roleCache.size - this.MAX_ROLE_CACHE_SIZE;
          const keys = Array.from(this.roleCache.keys()).slice(0, toDelete);
          keys.forEach(k => this.roleCache.delete(k));
          console.log(`🧹 CorrespondenceManager: roleCache élagué de ${toDelete} entrées (reste ${this.roleCache.size})`);
        }

        // Nettoyer pendingCreations > 5 min (safety net si le finally a raté)
        // On ne peut pas tracker le timestamp dans un Set, donc on clear si trop gros
        if (this.pendingCreations.size > 50) {
          console.log(`🧹 CorrespondenceManager: pendingCreations anormal (${this.pendingCreations.size}), nettoyage forcé`);
          this.pendingCreations.clear();
        }
      } catch (error) {
        console.error('❌ Erreur dans cleanup CorrespondenceManager:', error.message);
      }
    }, 30 * 60 * 1000); // 30 minutes
  }

  /**
   * Injecter le service de récupération automatique
   * @param {AutoRecoveryService} autoRecoveryService
   */
  setAutoRecoveryService(autoRecoveryService) {
    this.autoRecoveryService = autoRecoveryService;
  }

  /**
   * Envoyer une notification d'erreur dans le salon "error" de la catégorie maintenance
   * @param {string} targetGuildId - ID du serveur mirror
   * @param {string} sourceChannelId - ID du salon source introuvable
   * @param {string} channelName - Nom du salon (si connu)
   */
  async sendErrorNotification(targetGuildId, sourceChannelId, channelName = null, reason = 'not_found') {
    try {
      // Liste temporaire des IDs problématiques à ignorer
      const problematicIds = [
        '1409460784878325832',
        '1410959772156690553', 
        '1410958934369632317',
        '1409500366386757672',
        '1395704595367591946'
      ];
      
      // Skip temporairement ces IDs jusqu'à résolution complète
      if (problematicIds.includes(sourceChannelId)) {
        return;
      }
      
      // Éviter les notifications en double pour le même salon
      const errorKey = `${sourceChannelId}_${targetGuildId}`;
      if (this.notifiedErrors.has(errorKey)) {
        return; // Déjà notifié
      }

      const targetGuild = this.client.guilds.cache.get(targetGuildId);
      if (!targetGuild) return;

      // Chercher le salon "error" dans la catégorie Maintenance
      const maintenanceCategory = targetGuild.channels.cache.find(ch => 
        ch.type === 4 && ch.name.toLowerCase().includes('maintenance')
      );
      
      if (!maintenanceCategory) {
        return;
      }

      const errorChannel = targetGuild.channels.cache.find(ch => 
        ch.name === 'error' && ch.parent?.id === maintenanceCategory.id
      );
      
      if (!errorChannel) {
        return;
      }

      // Construire le message d'erreur
      const channelInfo = channelName ? `**#${channelName}** (${sourceChannelId})` : `ID \`${sourceChannelId}\``;

      let problemDescription;
      let solutionSuggestions;
      let skipAutoRecovery = false;

      if (reason === 'permission_denied') {
        problemDescription = `🚫 **Problème :** Accès refusé au salon source (permissions insuffisantes)`;
        solutionSuggestions = `💡 **Solutions possibles :**\n` +
          `• L'utilisateur n'a pas accès à ce salon sur le serveur source\n` +
          `• Le salon est privé ou restreint à certains rôles\n` +
          `• Vérifiez les permissions de l'utilisateur sur le serveur source\n` +
          `• Ce salon sera automatiquement blacklisté`;
        skipAutoRecovery = true; // Ne pas essayer de récupérer un salon inaccessible
      } else {
        problemDescription = `⚠️ **Problème :** Aucun salon mirror correspondant trouvé`;
        solutionSuggestions = `💡 **Solutions possibles :**\n` +
          `• Le salon n'a pas encore été créé sur le serveur mirror\n` +
          `• La correspondance n'est pas enregistrée en base de données\n` +
          `• Le salon mirror a été supprimé\n` +
          `• Utilisez \`/discovery\` pour détecter les nouveaux salons`;
      }

      const errorMessage = `🚨 **Correspondance salon introuvable**\n\n` +
        `📍 **Salon source :** ${channelInfo}\n` +
        `🔍 **ID source :** \`${sourceChannelId}\`\n` +
        problemDescription + `\n` +
        `🕐 **Timestamp :** <t:${Math.floor(Date.now() / 1000)}:f>\n\n` +
        solutionSuggestions;

      const sentMessage = await errorChannel.send(errorMessage);

      // ✅ Marquer comme notifié AVANT de lancer la recovery pour éviter les doublons
      // (Si startRecovery déclenche une erreur qui rappelle sendErrorNotification)
      this.notifiedErrors.add(errorKey);
      setTimeout(() => {
        this.notifiedErrors.delete(errorKey);
      }, 3600000); // 1 heure

      // Déclencher la récupération automatique si le service est disponible et si ce n'est pas un problème de permissions
      if (this.autoRecoveryService && !skipAutoRecovery) {
        // Vérifier si une recovery n'est pas déjà en cours pour ce salon
        if (this.autoRecoveryService.isRecovering?.(sourceChannelId, targetGuildId)) {
          // 🔍 LOG: Recovery déjà en cours (évite spam)
          console.log(`⏳ [AutoRecovery] Recovery déjà en cours pour ${sourceChannelId}, skip`);
        } else {
          // Récupérer le sourceGuildId depuis le ServerConfig
          const ServerConfig = require('../models/ServerConfig');
          const config = await ServerConfig.findOne({ guildId: targetGuildId });

          // 🔍 Récupérer sourceGuildId avec fallback depuis userClient si absent de DB
          let sourceGuildId = config?.sourceGuildId;

          if (!sourceGuildId) {
            // 🆕 FALLBACK: Récupérer depuis userClient (mémoire)
            const userClientData = this.client.services?.userClient?.getUserData?.(targetGuildId);
            if (userClientData?.sourceGuildId) {
              sourceGuildId = userClientData.sourceGuildId;
              console.log(`🔄 [AutoRecovery] sourceGuildId récupéré via fallback userClient: ${sourceGuildId}`);

              // Sauvegarder en DB pour les prochaines fois
              if (config) {
                await ServerConfig.updateOne(
                  { guildId: targetGuildId },
                  { sourceGuildId: sourceGuildId }
                );
                console.log(`💾 [AutoRecovery] sourceGuildId sauvegardé en DB pour ${targetGuildId}`);
              }
            } else {
              // 🔍 LOG: sourceGuildId introuvable (ni DB ni mémoire)
              console.warn(`⚠️ [AutoRecovery] Impossible de démarrer: sourceGuildId introuvable pour guild ${targetGuildId} (config=${!!config})`);
            }
          }

          if (sourceGuildId) {
            this.autoRecoveryService.startRecovery(
              sourceChannelId,
              sourceGuildId,
              targetGuildId,
              sentMessage.id
            );
          }
        }
      }

      
    } catch (error) {
      console.error('❌ Erreur envoi notification d\'erreur:', error);
    }
  }

  /**
   * Obtenir l'ID du salon mirror correspondant à un salon source
   * @param {string} sourceChannelId - ID du salon sur le serveur distant
   * @param {string} sourceGuildId - ID du serveur distant
   * @param {string} targetGuildId - ID du serveur mirror
   * @returns {Promise<string|null>} - ID du salon sur le serveur mirror ou null
   */
  async getMirrorChannelId(sourceChannelId, sourceGuildId, targetGuildId) {
    try {
      // Vérifier le cache d'abord
      const cacheKey = `${sourceChannelId}_${targetGuildId}`;
      if (this.channelCache.has(cacheKey)) {
        return this.channelCache.get(cacheKey);
      }

      // Chercher en base de données
      let channelMapping = await Channel.findOne({
        sourceChannelId: sourceChannelId,
        serverId: sourceGuildId
      });

      // AUTO-RECOVERY: Si pas trouvé, essayer de créer automatiquement le mapping
      if (!channelMapping) {
        channelMapping = await this.autoCreateChannelMapping(sourceChannelId, sourceGuildId, targetGuildId);
      }

      // 🛡️ FIX: Filtrer les mappings pending (salon en cours de création qui a échoué)
      if (channelMapping && channelMapping.discordId && channelMapping.discordId !== 'pending' && !channelMapping.discordId.startsWith('pending_')) {
        // Vérifier que le salon mirror existe toujours en utilisant l'ID stocké
        const targetGuild = this.client.guilds.cache.get(targetGuildId);
        if (targetGuild) {
          // Utiliser l'ID stocké au lieu de chercher par nom
          let mirrorChannel = targetGuild.channels.cache.get(channelMapping.discordId);

          // 🧵 FIX: Les threads ne sont PAS dans channels.cache, chercher dans threads.cache des parents
          if (!mirrorChannel) {
            for (const [, channel] of targetGuild.channels.cache) {
              if (channel.threads?.cache) {
                const thread = channel.threads.cache.get(channelMapping.discordId);
                if (thread) {
                  mirrorChannel = thread;
                  break;
                }
              }
            }
          }

          if (mirrorChannel) {
            // 🔄 DÉTECTION DE RENOMMAGE : Vérifier si le nom a changé sur le serveur source
            try {
              // Récupérer le salon source depuis Discord pour avoir son nom actuel
              const sourceGuild = this.client.guilds.cache.get(sourceGuildId);
              if (sourceGuild) {
                const sourceChannel = sourceGuild.channels.cache.get(sourceChannelId);
                if (sourceChannel && sourceChannel.name !== channelMapping.name) {
                  // Le salon a été renommé sur le serveur source
                  
                  // Mettre à jour le nom en base de données
                  await this.updateChannelName(sourceChannelId, sourceGuildId, sourceChannel.name);
                  
                  // Optionnel : Renommer aussi le salon mirror pour rester synchronisé
                  if (mirrorChannel.name !== sourceChannel.name) {
                    try {
                      await mirrorChannel.setName(sourceChannel.name);
                    } catch (renameError) {
                    }
                  }
                }
              }
            } catch (checkError) {
              // Pas critique, on continue
            }
            
            // Mettre en cache et retourner
            this.channelCache.set(cacheKey, mirrorChannel.id);
            return mirrorChannel.id;
          }
        }
      }

      // Si pas trouvé dans la DB, vérifier si c'est un thread
      if (!channelMapping) {
        // Chercher si c'est un thread dans les guilds en cache
        for (const [guildId, guild] of this.client.guilds.cache) {
          const thread = guild.channels.cache.get(sourceChannelId);
          if (thread && thread.isThread && thread.isThread()) {
            
            // Chercher le mapping du parent
            const parentMapping = await Channel.findOne({
              sourceChannelId: thread.parentId,
              serverId: sourceGuildId
            });
            
            if (parentMapping && parentMapping.discordId) {
              const targetGuild = this.client.guilds.cache.get(targetGuildId);
              if (targetGuild) {
                const mirrorParent = targetGuild.channels.cache.get(parentMapping.discordId);
                if (mirrorParent && mirrorParent.threads) {
                  // Chercher le thread mirror par nom
                  const mirrorThread = mirrorParent.threads.cache.find(t => t.name === thread.name);
                  if (mirrorThread) {
                    this.channelCache.set(cacheKey, mirrorThread.id);
                    return mirrorThread.id;
                  }
                }
              }
            }
          }
        }
      }
      
      // Dernière tentative : auto-discovery et création
      // Mais d'abord vérifier si pas blacklisté
      const blacklistedChannel = await Channel.findOne({
        sourceChannelId: sourceChannelId,
        serverId: sourceGuildId,
        blacklisted: true
      });

      if (blacklistedChannel) {
        return null;
      }

      const autoCreated = await this.autoDiscoverAndCreateMapping(sourceChannelId, sourceGuildId, targetGuildId);

      if (autoCreated) {
        this.channelCache.set(cacheKey, autoCreated);
        return autoCreated;
      }

      // Salon définitivement introuvable - Notification uniquement si vraiment impossible à résoudre
      // Essayer de récupérer le nom du salon pour une meilleure notification
      let channelName = channelMapping ? channelMapping.name : null;

      if (!channelName) {
        // Essayer de récupérer le nom depuis le client utilisateur
        try {
          const sourceInfo = await this.fetchSourceChannelInfo(sourceChannelId, sourceGuildId, targetGuildId);
          channelName = sourceInfo?.name;
        } catch (error) {
          if (error.statusCode === 403) {
            // Salon inaccessible - blacklist et notification spécifique
            await Channel.findOneAndUpdate(
              { sourceChannelId: sourceChannelId, serverId: sourceGuildId },
              {
                blacklisted: true,
                blacklistReason: 'Permission denied - final check',
                blacklistedAt: new Date(),
                name: `inaccessible-${sourceChannelId.slice(-6)}`
              },
              { upsert: true }
            );

            await this.sendErrorNotification(targetGuildId, sourceChannelId, channelName, 'permission_denied');
            return null;
          }
        }
      }


      // Notification seulement après échec de l'auto-recovery
      // Le service de récupération sera déclenché automatiquement lors de l'envoi de la notification
      await this.sendErrorNotification(targetGuildId, sourceChannelId, channelName);

      return null;
    } catch (error) {
      console.error('Erreur getMirrorChannelId:', error);
      return null;
    }
  }

  /**
   * Obtenir l'ID du rôle mirror correspondant à un rôle source
   * @param {string} sourceRoleId - ID du rôle sur le serveur distant
   * @param {string} sourceGuildId - ID du serveur distant
   * @param {string} targetGuildId - ID du serveur mirror
   * @returns {Promise<string|null>} - ID du rôle sur le serveur mirror ou null
   */
  async getMirrorRoleId(sourceRoleId, sourceGuildId, targetGuildId) {
    try {
      // Vérifier le cache d'abord
      const cacheKey = `${sourceRoleId}_${targetGuildId}`;
      if (this.roleCache.has(cacheKey)) {
        return this.roleCache.get(cacheKey);
      }

      // Chercher en base de données
      const roleMapping = await Role.findOne({
        sourceRoleId: sourceRoleId,
        serverId: sourceGuildId
      });

      if (roleMapping) {
        // Vérifier que le rôle mirror existe toujours
        const targetGuild = this.client.guilds.cache.get(targetGuildId);
        if (targetGuild) {
          const mirrorRole = targetGuild.roles.cache.find(role => role.name === roleMapping.name);
          if (mirrorRole) {
            // Mettre en cache et retourner
            this.roleCache.set(cacheKey, mirrorRole.id);
            return mirrorRole.id;
          }
        }
      }

      return null;
    } catch (error) {
      console.error('Erreur getMirrorRoleId:', error);
      return null;
    }
  }

  /**
   * Mettre à jour le nom d'un salon en base de données
   * @param {string} sourceChannelId - ID du salon source
   * @param {string} sourceGuildId - ID du serveur source
   * @param {string} newName - Nouveau nom du salon
   */
  async updateChannelName(sourceChannelId, sourceGuildId, newName) {
    try {
      const result = await Channel.findOneAndUpdate(
        { 
          sourceChannelId: sourceChannelId,
          serverId: sourceGuildId 
        },
        { 
          name: newName,
          lastNameUpdate: new Date()
        },
        { new: true }
      );

      if (result) {
        
        // Invalider le cache pour forcer une nouvelle vérification
        for (const [key] of this.channelCache) {
          if (key.startsWith(sourceChannelId)) {
            this.channelCache.delete(key);
          }
        }
      }

      return result;
    } catch (error) {
      console.error('Erreur updateChannelName:', error);
      return null;
    }
  }

  /**
   * Enregistrer la correspondance d'un salon
   * @param {string} sourceChannelId - ID du salon source
   * @param {string} sourceGuildId - ID du serveur source
   * @param {string} channelName - Nom du salon
   * @param {string} mirrorChannelId - ID du salon mirror
   */
  async registerChannelMapping(sourceChannelId, sourceGuildId, channelName, mirrorChannelId) {
    try {
      await Channel.findOneAndUpdate(
        { name: channelName, serverId: sourceGuildId },
        {
          sourceChannelId: sourceChannelId,
          discordId: mirrorChannelId
        },
        { upsert: true }
      );

      // Mettre à jour le cache
      const cacheKey = `${sourceChannelId}_${this.getTargetGuildId(sourceGuildId)}`;
      this.channelCache.set(cacheKey, mirrorChannelId);

    } catch (error) {
      if (error.code === 11000) {
        // discordId déjà utilisé par un autre document → mettre à jour ce document
        await Channel.findOneAndUpdate(
          { discordId: mirrorChannelId },
          { $set: { sourceChannelId, name: channelName } }
        ).catch(() => {});
        const cacheKey = `${sourceChannelId}_${this.getTargetGuildId(sourceGuildId)}`;
        this.channelCache.set(cacheKey, mirrorChannelId);
      } else {
        console.error('Erreur registerChannelMapping:', error);
      }
    }
  }

  /**
   * Enregistrer silencieusement la correspondance d'un salon (sans log pour éviter les doublons)
   * @param {string} sourceChannelId - ID du salon source
   * @param {string} sourceGuildId - ID du serveur source
   * @param {string} channelName - Nom du salon
   * @param {string} mirrorChannelId - ID du salon mirror
   */
  async registerChannelMappingSilently(sourceChannelId, sourceGuildId, channelName, mirrorChannelId) {
    try {
      await Channel.findOneAndUpdate(
        { name: channelName, serverId: sourceGuildId },
        {
          sourceChannelId: sourceChannelId,
          discordId: mirrorChannelId
        },
        { upsert: true }
      );

      // Mettre à jour le cache
      const cacheKey = `${sourceChannelId}_${this.getTargetGuildId(sourceGuildId)}`;
      this.channelCache.set(cacheKey, mirrorChannelId);

      // Pas de log pour éviter les doublons
    } catch (error) {
      if (error.code === 11000) {
        await Channel.findOneAndUpdate(
          { discordId: mirrorChannelId },
          { $set: { sourceChannelId, name: channelName } }
        ).catch(() => {});
        const cacheKey = `${sourceChannelId}_${this.getTargetGuildId(sourceGuildId)}`;
        this.channelCache.set(cacheKey, mirrorChannelId);
      } else {
        console.error('Erreur registerChannelMappingSilently:', error);
      }
    }
  }

  /**
   * Enregistrer la correspondance d'un rôle
   * @param {string} sourceRoleId - ID du rôle source
   * @param {string} sourceGuildId - ID du serveur source
   * @param {string} roleName - Nom du rôle
   * @param {string} mirrorRoleId - ID du rôle mirror
   */
  async registerRoleMapping(sourceRoleId, sourceGuildId, roleName, mirrorRoleId) {
    try {
      await Role.findOneAndUpdate(
        { name: roleName, serverId: sourceGuildId },
        { 
          sourceRoleId: sourceRoleId,
          discordId: mirrorRoleId,
          synced: true
        },
        { upsert: true }
      );

      // Mettre à jour le cache
      const cacheKey = `${sourceRoleId}_${this.getTargetGuildId(sourceGuildId)}`;
      this.roleCache.set(cacheKey, mirrorRoleId);

    } catch (error) {
      console.error('Erreur registerRoleMapping:', error);
    }
  }

  /**
   * Synchroniser automatiquement les correspondances en analysant les serveurs
   * @param {string} sourceGuildId - ID du serveur source
   * @param {string} targetGuildId - ID du serveur mirror
   */
  async syncMappings(sourceGuildId, targetGuildId) {
    try {

      const sourceGuild = this.client.guilds.cache.get(sourceGuildId);
      const targetGuild = this.client.guilds.cache.get(targetGuildId);

      if (!sourceGuild || !targetGuild) {
        console.error('Serveur source ou mirror introuvable pour la synchronisation');
        return;
      }

      // Synchroniser les salons
      for (const [sourceChannelId, sourceChannel] of sourceGuild.channels.cache) {
        if (sourceChannel.type === 0 || sourceChannel.type === 2) { // Text et Voice
          const mirrorChannel = targetGuild.channels.cache.find(ch => ch.name === sourceChannel.name);
          if (mirrorChannel) {
            await this.registerChannelMapping(sourceChannelId, sourceGuildId, sourceChannel.name, mirrorChannel.id);
          }
        }
      }

      // Synchroniser les rôles
      for (const [sourceRoleId, sourceRole] of sourceGuild.roles.cache) {
        if (sourceRole.name !== '@everyone') {
          const mirrorRole = targetGuild.roles.cache.find(role => role.name === sourceRole.name);
          if (mirrorRole) {
            await this.registerRoleMapping(sourceRoleId, sourceGuildId, sourceRole.name, mirrorRole.id);
          }
        }
      }

    } catch (error) {
      console.error('Erreur syncMappings:', error);
    }
  }

  /**
   * Nettoyer le cache
   */
  clearCache() {
    this.channelCache.clear();
    this.roleCache.clear();
  }

  /**
   * Créer automatiquement un mapping de salon
   * @param {string} sourceChannelId - ID du salon source
   * @param {string} sourceGuildId - ID du serveur source
   * @param {string} targetGuildId - ID du serveur mirror
   * @returns {Promise<Object|null>} - Mapping créé ou null
   */
  async autoCreateChannelMapping(sourceChannelId, sourceGuildId, targetGuildId) {
    try {
      // Vérifier d'abord si le salon est déjà blacklisté
      const Channel = require('../models/Channel');
      const existingChannel = await Channel.findOne({
        sourceChannelId: sourceChannelId,
        serverId: sourceGuildId,
        blacklisted: true
      });

      if (existingChannel) {
        return null;
      }

      // Vérifier les permissions d'accès avant de continuer
      if (this.client.services?.channelMonitor) {
        const userData = this.client.services.userClient?.getUserData(targetGuildId);
        if (userData) {
          try {
            const hasAccess = await this.client.services.channelMonitor.testChannelAccess(
              sourceChannelId,
              userData,
              sourceGuildId
            );
          } catch (error) {
            if (error.statusCode === 403) {

              // Auto-blacklister ce salon
              await Channel.findOneAndUpdate(
                { sourceChannelId: sourceChannelId, serverId: sourceGuildId },
                {
                  blacklisted: true,
                  blacklistReason: 'Permission denied - user cannot view source channel',
                  blacklistedAt: new Date(),
                  name: `inaccessible-${sourceChannelId.slice(-6)}` // Nom par défaut
                },
                { upsert: true }
              );

              // Essayer de récupérer le nom du salon pour la notification
              let channelName = null;
              try {
                const sourceChannelInfo = await this.fetchSourceChannelInfo(sourceChannelId, sourceGuildId, targetGuildId);
                channelName = sourceChannelInfo?.name;
              } catch (fetchError) {
                // Ignorer l'erreur, on utilisera l'ID
              }

              // Envoyer une notification d'erreur spécifique
              await this.sendErrorNotification(
                targetGuildId,
                sourceChannelId,
                channelName,
                'permission_denied'
              );

              return null;
            }
            // Autre type d'erreur - continuer avec précaution
            console.warn(`⚠️ Impossible de vérifier l'accès au salon ${sourceChannelId}: ${error.message}`);
          }
        }
      }

      // Récupérer les infos du salon source
      let sourceChannelInfo;
      try {
        sourceChannelInfo = await this.fetchSourceChannelInfo(sourceChannelId, sourceGuildId, targetGuildId);
      } catch (error) {
        if (error.statusCode === 403) {
          console.log(`🚫 Accès refusé lors de la récupération des infos du salon ${sourceChannelId}`);

          // Auto-blacklister
          await Channel.findOneAndUpdate(
            { sourceChannelId: sourceChannelId, serverId: sourceGuildId },
            {
              blacklisted: true,
              blacklistReason: 'Permission denied - cannot fetch channel info',
              blacklistedAt: new Date(),
              name: `inaccessible-${sourceChannelId.slice(-6)}`
            },
            { upsert: true }
          );

          await this.sendErrorNotification(
            targetGuildId,
            sourceChannelId,
            null,
            'permission_denied'
          );

          return null;
        }
        throw error;
      }

      if (!sourceChannelInfo) {
        return null;
      }

      const targetGuild = this.client.guilds.cache.get(targetGuildId);
      if (!targetGuild) return null;

      // 🧵 NOUVEAU: Détecter si c'est un thread (type 10, 11, 12) et utiliser la logique spécifique
      const isThread = sourceChannelInfo.type >= 10 && sourceChannelInfo.type <= 12;
      if (isThread) {
        console.log(`🧵 Détection thread type ${sourceChannelInfo.type}: ${sourceChannelInfo.name} - utilisation autoCreateThreadMapping`);
        const threadId = await this.autoCreateThreadMapping(sourceChannelId, sourceChannelInfo, targetGuild, sourceGuildId);
        return threadId ? { discordId: threadId } : null;
      }

      // Chercher un salon mirror existant par nom
      let mirrorChannel = targetGuild.channels.cache.find(
        ch => ch.name === sourceChannelInfo.name &&
             (ch.type === sourceChannelInfo.type || this.areCompatibleTypes(ch.type, sourceChannelInfo.type))
      );

      if (mirrorChannel) {
        // Créer le mapping en base
        const Channel = require('../models/Channel');
        await Channel.findOneAndUpdate(
          {
            sourceChannelId: sourceChannelId,
            serverId: sourceGuildId
          },
          {
            name: sourceChannelInfo.name,
            discordId: mirrorChannel.id,
            type: sourceChannelInfo.type,
            categoryId: sourceChannelInfo.parentId,
            lastSynced: new Date()
          },
          { upsert: true }
        );

        return { discordId: mirrorChannel.id };
      }

      // Si le salon n'existe pas et qu'on a les permissions, le créer
      if (targetGuild.me.permissions.has('ManageChannels')) {
        // Vérifier d'abord les permissions d'accès au salon source
        const userData = this.client.services?.userClient?.getUserData(targetGuildId);
        if (userData && userData.token) {
          try {
            // Utiliser testChannelAccess depuis channelMonitor
            if (this.client.services?.channelMonitor) {
              await this.client.services.channelMonitor.testChannelAccess(
                sourceChannelId,
                userData,
                sourceGuildId
              );
            }
          } catch (error) {
            if (error.statusCode === 403) {

              // Auto-blacklister ce salon
              const Channel = require('../models/Channel');
              await Channel.findOneAndUpdate(
                { sourceChannelId: sourceChannelId, serverId: sourceGuildId },
                {
                  blacklisted: true,
                  blacklistReason: 'Permission denied - user cannot view source channel',
                  blacklistedAt: new Date(),
                  name: sourceChannelInfo.name || `inaccessible-${sourceChannelId.slice(-6)}`
                },
                { upsert: true }
              );

              // Logger l'erreur dans #error
              if (this.client.services?.logger) {
                await this.client.services.logger.logError(
                  targetGuildId,
                  `❌ **Création automatique impossible**\n` +
                  `📍 Salon source: **${sourceChannelInfo.name}** (${sourceChannelId})\n` +
                  `🚫 Raison: **Permissions insuffisantes** - L'utilisateur ne peut pas voir ce salon\n` +
                  `⚙️ Action: Salon auto-blacklisté pour éviter les tentatives répétées`
                );
              }

              return null;
            }
            // Pour toute autre erreur, continuer mais logger
            console.warn(`⚠️ Impossible de vérifier les permissions pour ${sourceChannelInfo.name}: ${error.message}`);
          }
        }

        mirrorChannel = await this.createMirrorChannel(targetGuild, sourceChannelInfo);

        if (mirrorChannel) {
          const Channel = require('../models/Channel');
          await Channel.create({
            name: sourceChannelInfo.name,
            discordId: mirrorChannel.id,
            sourceChannelId: sourceChannelId,
            serverId: sourceGuildId,
            type: sourceChannelInfo.type,
            categoryId: sourceChannelInfo.parentId,
            lastSynced: new Date()
          });

          return { discordId: mirrorChannel.id };
        }
      }

      return null;
    } catch (error) {
      console.error(`❌ Erreur auto-création mapping:`, error.message);
      return null;
    }
  }

  /**
   * Auto-découverte et création de mapping en dernier recours
   * @param {string} sourceChannelId - ID du salon source
   * @param {string} sourceGuildId - ID du serveur source
   * @param {string} targetGuildId - ID du serveur mirror
   * @returns {Promise<string|null>} - ID du salon mirror ou null
   */
  async autoDiscoverAndCreateMapping(sourceChannelId, sourceGuildId, targetGuildId) {
    // 🛡️ FIX: Déduplication - éviter les créations parallèles pour le même salon
    const creationKey = `${sourceChannelId}_${targetGuildId}`;
    if (this.pendingCreations.has(creationKey)) {
      console.log(`⏳ [AutoDiscover] Création déjà en cours pour ${sourceChannelId}, skip`);
      return null; // Retourner null pour que l'appelant attende
    }

    this.pendingCreations.add(creationKey);

    try {
      // Forcer une synchronisation immédiate si le service est disponible
      if (this.client.services?.channelSync) {
        await this.client.services.channelSync.forceSyncServer(targetGuildId);

        // Vérifier si le mapping a été créé
        const newMapping = await Channel.findOne({
          sourceChannelId: sourceChannelId,
          serverId: sourceGuildId
        });

        // 🛡️ FIX: Vérifier que le discordId pointe vers un vrai salon sur le mirror
        // (couvre 'pending', 'pending_xxx', et les IDs de salons supprimés)
        if (newMapping && newMapping.discordId) {
          const verifyGuild = this.client.guilds.cache.get(targetGuildId);
          if (verifyGuild && verifyGuild.channels.cache.has(newMapping.discordId)) {
            return newMapping.discordId;
          }
        }
      }

      return null;
    } catch (error) {
      console.error(`❌ Erreur auto-discovery:`, error.message);
      return null;
    } finally {
      // 🛡️ Toujours nettoyer le Set de déduplication (succès ou échec)
      this.pendingCreations.delete(creationKey);
    }
  }

  /**
   * Récupérer les informations d'un salon source
   * @param {string} sourceChannelId - ID du salon source
   * @param {string} sourceGuildId - ID du serveur source
   * @param {string} targetGuildId - ID du serveur mirror
   * @returns {Promise<Object|null>} - Informations du salon ou null
   */
  async fetchSourceChannelInfo(sourceChannelId, sourceGuildId, targetGuildId) {
    try {
      // Essayer via le client utilisateur d'abord
      if (this.client.services?.userClient) {
        const userData = this.client.services.userClient.getUserData(targetGuildId);
        if (userData && userData.client) {
          const sourceGuild = userData.client.guilds.cache.get(sourceGuildId);
          if (sourceGuild) {
            const sourceChannel = sourceGuild.channels.cache.get(sourceChannelId);
            if (sourceChannel) {
              return {
                id: sourceChannel.id,
                name: sourceChannel.name,
                type: typeof sourceChannel.type === 'string' ?
                      this.convertChannelType(sourceChannel.type) : sourceChannel.type,
                parentId: sourceChannel.parentId,
                topic: sourceChannel.topic,
                nsfw: sourceChannel.nsfw
              };
            }
          }
        }
      }

      // Essayer via l'API Discord
      if (this.client.services?.userClient) {
        const userData = this.client.services.userClient.getUserData(targetGuildId);
        if (userData && userData.token) {
          const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
          const response = await fetch(`https://discord.com/api/v10/channels/${sourceChannelId}`, {
            headers: {
              'Authorization': userData.token,
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
          });

          if (response.status === 403) {
            // Accès refusé - l'utilisateur n'a pas les permissions
            const error = new Error('Permission denied');
            error.statusCode = 403;
            throw error;
          }

          if (response.ok) {
            const channelData = await response.json();
            return {
              id: channelData.id,
              name: channelData.name,
              type: channelData.type,
              parentId: channelData.parent_id,
              topic: channelData.topic,
              nsfw: channelData.nsfw
            };
          }
        }
      }

      return null;
    } catch (error) {
      if (error.statusCode === 403) {
        // Re-lancer l'erreur 403 pour qu'elle soit traitée par l'appelant
        throw error;
      }
      console.error(`❌ Erreur récupération info salon:`, error.message);
      return null;
    }
  }

  /**
   * Créer un salon mirror
   * @param {Object} targetGuild - Serveur cible
   * @param {Object} sourceChannelInfo - Informations du salon source
   * @returns {Promise<Object|null>} - Salon créé ou null
   */
  async createMirrorChannel(targetGuild, sourceChannelInfo) {
    try {
      const channelData = {
        name: sourceChannelInfo.name,
        type: sourceChannelInfo.type,
        topic: sourceChannelInfo.topic,
        nsfw: sourceChannelInfo.nsfw || false
      };

      // Trouver la catégorie parente si elle existe
      if (sourceChannelInfo.parentId) {
        const parentMapping = await Channel.findOne({
          sourceChannelId: sourceChannelInfo.parentId,
          serverId: targetGuild.id
        });

        if (parentMapping && parentMapping.discordId) {
          const parentCategory = targetGuild.channels.cache.get(parentMapping.discordId);
          if (parentCategory) {
            channelData.parent = parentCategory;
          }
        }
      }

      const newChannel = await targetGuild.channels.create(channelData);
      return newChannel;
    } catch (error) {
      console.error(`❌ Erreur création salon mirror:`, error.message);
      return null;
    }
  }

  /**
   * 🧵 Créer automatiquement un thread sur le serveur mirror
   * Gère les threads de forum (type 15 parent) et threads normaux (type 0 parent)
   * @param {string} sourceChannelId - ID du thread source
   * @param {Object} sourceChannelInfo - Informations du thread source
   * @param {Object} targetGuild - Serveur mirror
   * @param {string} sourceGuildId - ID du serveur source
   * @returns {Promise<string|null>} - ID du thread mirror créé ou null
   */
  async autoCreateThreadMapping(sourceChannelId, sourceChannelInfo, targetGuild, sourceGuildId) {
    try {
      const Channel = require('../models/Channel');

      // 1. Récupérer les infos du parent
      if (!sourceChannelInfo.parentId) {
        console.log(`⚠️ Thread ${sourceChannelInfo.name} n'a pas de parent, skip`);
        return null;
      }

      // 2. Chercher le parent sur le mirror
      let parentInfo = null;
      try {
        parentInfo = await this.fetchSourceChannelInfo(sourceChannelInfo.parentId, sourceGuildId, targetGuild.id);
      } catch (error) {
        console.log(`⚠️ Impossible de récupérer le parent du thread: ${error.message}`);
        return null;
      }

      if (!parentInfo) {
        console.log(`⚠️ Parent info non trouvée pour thread ${sourceChannelInfo.name}`);
        return null;
      }

      // 3. Trouver ou créer le parent mirror
      let parentMirror = targetGuild.channels.cache.find(
        ch => ch.name === parentInfo.name &&
             (ch.type === parentInfo.type || this.areCompatibleTypes(ch.type, parentInfo.type))
      );

      if (!parentMirror) {
        // Créer le parent (forum ou channel) s'il n'existe pas
        console.log(`🔧 Création automatique du parent ${parentInfo.name} (type ${parentInfo.type}) pour le thread ${sourceChannelInfo.name}`);

        if (parentInfo.type === 15) {
          // C'est un forum - le créer
          parentMirror = await this.autoCreateForumChannel(parentInfo, targetGuild, sourceGuildId);
        } else {
          // C'est un channel normal - le créer
          parentMirror = await this.createMirrorChannel(targetGuild, parentInfo);
        }

        if (parentMirror) {
          // Sauvegarder le mapping du parent
          await Channel.findOneAndUpdate(
            { sourceChannelId: parentInfo.id, serverId: sourceGuildId },
            {
              name: parentInfo.name,
              discordId: parentMirror.id,
              sourceChannelId: parentInfo.id,
              type: parentInfo.type,
              lastSynced: new Date()
            },
            { upsert: true }
          );
          console.log(`✅ Parent ${parentInfo.name} créé: ${parentMirror.id}`);
        } else {
          console.log(`❌ Impossible de créer le parent ${parentInfo.name}`);
          return null;
        }
      }

      // 4. Vérifier si le thread existe déjà sur le mirror (par nom)
      let threadMirror = null;
      if (parentMirror.threads?.cache) {
        threadMirror = parentMirror.threads.cache.find(t => t.name === sourceChannelInfo.name);
      }

      if (threadMirror) {
        // Thread existe déjà - juste enregistrer le mapping
        await Channel.findOneAndUpdate(
          { sourceChannelId: sourceChannelId, serverId: sourceGuildId },
          {
            name: sourceChannelInfo.name,
            discordId: threadMirror.id,
            sourceChannelId: sourceChannelId,
            type: sourceChannelInfo.type,
            lastSynced: new Date()
          },
          { upsert: true }
        );
        console.log(`✅ Thread existant mappé: ${sourceChannelInfo.name} → ${threadMirror.id}`);
        return threadMirror.id;
      }

      // 5. Créer le thread
      try {
        if (parentMirror.type === 15) {
          // Parent est un forum - utiliser threads.create avec message
          threadMirror = await parentMirror.threads.create({
            name: sourceChannelInfo.name,
            message: {
              content: `🧵 **Thread synchronisé**: ${sourceChannelInfo.name}\n\n*Ce thread a été automatiquement créé lors de sa détection sur le serveur source.*`
            },
            autoArchiveDuration: 1440,
            reason: `Auto-création thread forum: ${sourceChannelInfo.name}`
          });
        } else {
          // Parent est un channel normal - envoyer message puis startThread
          const startMessage = await parentMirror.send(
            `🧵 **Thread auto-créé**: ${sourceChannelInfo.name}\n\n*Synchronisation automatique.*`
          );
          threadMirror = await startMessage.startThread({
            name: sourceChannelInfo.name,
            autoArchiveDuration: 1440,
            reason: `Auto-création thread: ${sourceChannelInfo.name}`
          });
        }

        if (threadMirror) {
          // 6. Sauvegarder le mapping
          await Channel.findOneAndUpdate(
            { sourceChannelId: sourceChannelId, serverId: sourceGuildId },
            {
              name: sourceChannelInfo.name,
              discordId: threadMirror.id,
              sourceChannelId: sourceChannelId,
              type: sourceChannelInfo.type,
              categoryId: parentMirror.parentId,
              lastSynced: new Date()
            },
            { upsert: true }
          );

          // 7. Logger la création
          if (this.client.services?.logger) {
            await this.client.services.logger.logNewRoom(
              targetGuild.id,
              `🧵 **THREAD AUTO-CRÉÉ** - <#${threadMirror.id}>\n` +
              `📁 Parent: <#${parentMirror.id}>\n` +
              `⚡ Création automatique lors de mention`,
              'Auto-Create Thread',
              threadMirror.id
            );
          }

          console.log(`✅ Thread créé: ${sourceChannelInfo.name} → ${threadMirror.id}`);

          // 8. 📥 BACKFILL: Synchroniser les 50 derniers messages
          let backfillCount = 0;
          try {
            const scraper = this.client.services?.scraper;
            const userClient = this.client.services?.userClient;
            const userData = userClient?.getUserData(targetGuild.id);

            if (scraper?.fetchChannelMessages && userData?.token) {
              const messages = await scraper.fetchChannelMessages(userData.token, sourceChannelId, 50);
              if (messages?.length > 0) {
                console.log(`📥 [Backfill ThreadMapping] ${messages.length} messages à synchroniser pour ${sourceChannelInfo.name}`);
                const ProcessedMessage = require('../models/ProcessedMessage');

                // Récupérer sourceGuild pour processMessage
                const selfbotClient = userClient?.getSelfbotClient(targetGuild.id);
                const sourceGuild = selfbotClient?.guilds?.cache?.get(sourceGuildId);

                if (sourceGuild) {
                  // Traiter dans l'ordre chronologique (du plus ancien au plus récent)
                  for (const msg of messages.reverse()) {
                    try {
                      // Vérifier si déjà traité (éviter doublons)
                      const alreadyProcessed = await ProcessedMessage.findOne({ discordId: msg.id });
                      if (alreadyProcessed) continue;

                      const msgObj = {
                        id: msg.id,
                        content: msg.content,
                        author: msg.author,
                        attachments: msg.attachments ? new Map(msg.attachments.map(a => [a.id, a])) : new Map(),
                        embeds: msg.embeds || [],
                        createdTimestamp: new Date(msg.timestamp).getTime(),
                        reference: msg.message_reference || null,
                        type: msg.type,
                        channel: { id: sourceChannelId, name: sourceChannelInfo.name }
                      };

                      await scraper.processMessage(msgObj, threadMirror, sourceGuild);
                      backfillCount++;

                      // Délai pour éviter rate limiting Discord
                      await new Promise(resolve => setTimeout(resolve, 300));
                    } catch (msgError) {
                      console.error(`❌ Backfill msg ${msg.id}:`, msgError.message);
                    }
                  }

                  if (backfillCount > 0) {
                    console.log(`✅ [Backfill ThreadMapping] ${backfillCount} messages synchronisés pour ${sourceChannelInfo.name}`);
                  }
                }
              }
            }
          } catch (backfillError) {
            console.error(`⚠️ Erreur backfill autoCreateThreadMapping:`, backfillError.message);
            // Ne pas faire échouer la création si le backfill échoue
          }

          return threadMirror.id;
        }
      } catch (createError) {
        console.error(`❌ Erreur création thread ${sourceChannelInfo.name}: ${createError.message}`);
        return null;
      }

      return null;
    } catch (error) {
      console.error(`❌ Erreur autoCreateThreadMapping: ${error.message}`);
      return null;
    }
  }

  /**
   * 🏛️ Créer automatiquement un forum sur le serveur mirror
   * @param {Object} forumInfo - Informations du forum source
   * @param {Object} targetGuild - Serveur mirror
   * @param {string} sourceGuildId - ID du serveur source
   * @returns {Promise<Object|null>} - Forum créé ou null
   */
  async autoCreateForumChannel(forumInfo, targetGuild, sourceGuildId) {
    try {
      // Vérifier les permissions
      if (!targetGuild.members.me?.permissions.has('ManageChannels')) {
        console.log(`⚠️ Pas de permission ManageChannels pour créer le forum ${forumInfo.name}`);
        return null;
      }

      // Trouver la catégorie parente si elle existe
      let parent = null;
      if (forumInfo.parentId) {
        const Channel = require('../models/Channel');
        const parentMapping = await Channel.findOne({
          sourceChannelId: forumInfo.parentId,
          serverId: sourceGuildId
        });
        if (parentMapping?.discordId) {
          parent = targetGuild.channels.cache.get(parentMapping.discordId);
        }
      }

      // Créer le forum
      const forumData = {
        name: forumInfo.name,
        type: 15, // GuildForum
        topic: forumInfo.topic || `Forum synchronisé: ${forumInfo.name}`,
        reason: `Auto-création forum: ${forumInfo.name}`
      };

      if (parent) {
        forumData.parent = parent;
      }

      try {
        const newForum = await targetGuild.channels.create(forumData);
        console.log(`✅ Forum créé: ${forumInfo.name} → ${newForum.id}`);
        return newForum;
      } catch (forumError) {
        // Si le serveur ne supporte pas les forums (pas Community), fallback vers channel texte
        if (forumError.code === 50001 || forumError.message.includes('Community')) {
          console.log(`⚠️ Serveur ne supporte pas forums, fallback vers channel texte pour ${forumInfo.name}`);
          forumData.type = 0; // GuildText
          forumData.name = `📌│${forumInfo.name}`;
          const fallbackChannel = await targetGuild.channels.create(forumData);
          return fallbackChannel;
        }
        throw forumError;
      }
    } catch (error) {
      console.error(`❌ Erreur création forum ${forumInfo.name}: ${error.message}`);
      return null;
    }
  }

  /**
   * Convertir un type de canal string en numérique
   * @param {string} typeString - Type en string
   * @returns {number} - Type numérique
   */
  convertChannelType(typeString) {
    const CHANNEL_TYPE_MAP = {
      'GUILD_TEXT': 0,
      'DM': 1,
      'GUILD_VOICE': 2,
      'GROUP_DM': 3,
      'GUILD_CATEGORY': 4,
      'GUILD_NEWS': 5,
      'GUILD_NEWS_THREAD': 10,
      'GUILD_PUBLIC_THREAD': 11,
      'GUILD_PRIVATE_THREAD': 12,
      'GUILD_STAGE_VOICE': 13,
      'GUILD_FORUM': 15
    };
    return CHANNEL_TYPE_MAP[typeString] ?? 0;
  }

  /**
   * Vérifier si deux types de canaux sont compatibles
   * @param {number} type1 - Premier type
   * @param {number} type2 - Second type
   * @returns {boolean} - true si compatibles
   */
  areCompatibleTypes(type1, type2) {
    // Text et News sont compatibles
    if ((type1 === 0 || type1 === 5) && (type2 === 0 || type2 === 5)) return true;
    // Threads sont compatibles entre eux
    if ((type1 >= 10 && type1 <= 12) && (type2 >= 10 && type2 <= 12)) return true;
    return type1 === type2;
  }

  /**
   * Obtenir l'ID du serveur mirror à partir de l'ID du serveur source
   * @param {string} sourceGuildId - ID du serveur source
   * @returns {string|null} - ID du serveur mirror ou null
   */
  getTargetGuildId(sourceGuildId) {
    try {
      // Dans votre configuration, le serveur mirror est généralement le serveur où le bot est actif
      // et qui a une configuration userClient pointant vers le serveur source
      
      // Parcourir les serveurs du client pour trouver celui qui pointe vers ce serveur source
      for (const [guildId, guild] of this.client.guilds.cache) {
        if (this.client.services?.userClient?.hasUserToken?.(guildId)) {
          const sourceGuild = this.client.services.userClient.getSourceGuild?.(guildId);
          if (sourceGuild && sourceGuild.id === sourceGuildId) {
            return guildId;
          }
        }
      }
      return null;
      
    } catch (error) {
      console.error('❌ Erreur getTargetGuildId:', error);
      return null;
    }
  }
}

module.exports = CorrespondenceManager; 