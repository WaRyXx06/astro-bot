const Channel = require('../models/Channel');
const Role = require('../models/Role');
const ServerConfig = require('../models/ServerConfig');

class ChannelSyncService {
  constructor(client, logger, correspondenceManager) {
    this.client = client;
    this.logger = logger;
    this.correspondenceManager = correspondenceManager;
    this.syncInterval = null;
    this.syncIntervalTime = 30 * 60 * 1000; // 30 minutes par défaut
    this.isSyncing = false;
    this.lastSyncTime = new Map(); // guildId -> timestamp
    this.syncErrors = new Map(); // guildId -> error count
    this.maxRetries = 3;

    // 🆕 Synchronisation adaptative
    this.adaptiveSyncIntervals = new Map(); // guildId -> interval personnalisé
    this.recentErrors = new Map(); // guildId -> {count, lastError}
    this.fastSyncInterval = 5 * 60 * 1000; // 5 minutes pour serveurs avec erreurs
    this.normalSyncInterval = 30 * 60 * 1000; // 30 minutes normal
    this.slowSyncInterval = 60 * 60 * 1000; // 60 minutes pour serveurs stables
    this.individualSyncTimers = new Map(); // guildId -> timer
  }

  /**
   * Démarrer la synchronisation automatique
   */
  async start() {

    // Synchronisation initiale immédiate
    await this.syncAllServers();

    // Démarrer la synchronisation adaptative pour chaque serveur
    await this.setupAdaptiveSync();
  }

  /**
   * Configurer la synchronisation adaptative pour tous les serveurs
   */
  async setupAdaptiveSync() {
    try {
      const activeServers = await ServerConfig.find({
        scrapingActive: true,
        botInitialized: true
      });

      for (const serverConfig of activeServers) {
        this.setupServerAdaptiveSync(serverConfig.guildId, serverConfig.sourceGuildId);
      }
    } catch (error) {
      console.error('❌ Erreur setup sync adaptative:', error);
    }
  }

  /**
   * Configurer la synchronisation adaptative pour un serveur spécifique
   */
  setupServerAdaptiveSync(targetGuildId, sourceGuildId) {
    // Nettoyer le timer existant si présent
    if (this.individualSyncTimers.has(targetGuildId)) {
      clearInterval(this.individualSyncTimers.get(targetGuildId));
    }

    // Déterminer l'intervalle basé sur les erreurs récentes
    let interval = this.normalSyncInterval;
    const recentError = this.recentErrors.get(targetGuildId);

    if (recentError && recentError.count > 0) {
      // Erreurs récentes : sync rapide (5 min)
      interval = this.fastSyncInterval;
    } else if (!recentError || Date.now() - recentError.lastError > 2 * 60 * 60 * 1000) {
      // Aucune erreur depuis 2h : sync lente (60 min)
      interval = this.slowSyncInterval;
    }

    this.adaptiveSyncIntervals.set(targetGuildId, interval);

    // Créer le timer individuel
    const timer = setInterval(async () => {
      try {
        await this.syncServer(targetGuildId, sourceGuildId);

        // Ajuster l'intervalle si nécessaire
        const currentErrors = this.recentErrors.get(targetGuildId);
        if (!currentErrors || currentErrors.count === 0) {
          // Passer en sync normale après succès
          if (interval === this.fastSyncInterval) {
            this.setupServerAdaptiveSync(targetGuildId, sourceGuildId);
          }
        }
      } catch (error) {
        this.handleSyncError(targetGuildId, error);
      }
    }, interval);

    this.individualSyncTimers.set(targetGuildId, timer);
  }

  /**
   * Gérer les erreurs de synchronisation et ajuster l'intervalle
   */
  handleSyncError(targetGuildId, error) {
    const current = this.recentErrors.get(targetGuildId) || { count: 0, lastError: 0 };
    current.count++;
    current.lastError = Date.now();
    this.recentErrors.set(targetGuildId, current);

    console.error(`❌ Erreur sync ${targetGuildId}: ${error.message}`);

    // Si on n'était pas déjà en sync rapide, passer en mode rapide
    const currentInterval = this.adaptiveSyncIntervals.get(targetGuildId);
    if (currentInterval !== this.fastSyncInterval) {

      // Récupérer sourceGuildId depuis la config
      ServerConfig.findOne({ guildId: targetGuildId }).then(config => {
        if (config && config.sourceGuildId) {
          this.setupServerAdaptiveSync(targetGuildId, config.sourceGuildId);
        }
      }).catch(err => {
        console.error(`❌ [ChannelSyncService] Erreur récupération config pour ${targetGuildId}:`, err.message);
      });
    }
  }

  /**
   * Arrêter la synchronisation automatique
   */
  stop() {
    // Arrêter tous les timers individuels
    for (const [guildId, timer] of this.individualSyncTimers) {
      clearInterval(timer);
    }
    this.individualSyncTimers.clear();

    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }

  }

  /**
   * Synchroniser tous les serveurs actifs
   */
  async syncAllServers() {
    if (this.isSyncing) {
      return;
    }

    this.isSyncing = true;

    try {
      // Récupérer tous les serveurs avec scraping actif
      const activeServers = await ServerConfig.find({
        scrapingActive: true,
        botInitialized: true
      });

      for (const serverConfig of activeServers) {
        try {
          await this.syncServer(serverConfig.guildId, serverConfig.sourceGuildId);
          this.syncErrors.delete(serverConfig.guildId); // Reset error count on success
        } catch (error) {
          const errorCount = (this.syncErrors.get(serverConfig.guildId) || 0) + 1;
          this.syncErrors.set(serverConfig.guildId, errorCount);

          console.error(`❌ Erreur sync serveur ${serverConfig.guildId}:`, error.message);

          if (errorCount >= this.maxRetries) {
            await this.logger.logError(
              serverConfig.guildId,
              `Synchronisation échouée après ${this.maxRetries} tentatives: ${error.message}`,
              'channel-sync'
            );
          }
        }
      }
    } catch (error) {
      console.error('❌ Erreur synchronisation globale:', error);
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Synchroniser un serveur spécifique
   */
  async syncServer(targetGuildId, sourceGuildId) {
    const syncStart = Date.now();

    const targetGuild = this.client.guilds.cache.get(targetGuildId);
    if (!targetGuild) {
      throw new Error(`Serveur cible ${targetGuildId} introuvable`);
    }

    // Récupérer le client utilisateur pour accéder au serveur source
    let sourceChannels = new Map();
    let sourceRoles = new Map();

    // Essayer d'obtenir les données du serveur source via eventHandlers (selfbot actif)
    if (this.client.services?.userClient) {
      try {
        // Utiliser eventHandlers pour accéder au sourceGuild du selfbot actif
        const handlers = this.client.services.userClient.eventHandlers?.get(targetGuildId);
        if (handlers?.sourceGuild) {
          const sourceGuild = handlers.sourceGuild;
          if (sourceGuild.channels?.cache) {
            sourceChannels = sourceGuild.channels.cache;
          }
          if (sourceGuild.roles?.cache) {
            sourceRoles = sourceGuild.roles.cache;
          }
        }
      } catch (err) {
        // Silencieux - on utilisera l'API Discord en fallback
      }
    }

    // Si pas de données source via user client, utiliser l'API Discord
    if (sourceChannels.size === 0) {
      const sourceData = await this.fetchSourceDataViaAPI(sourceGuildId, targetGuildId);
      sourceChannels = sourceData.channels;
      sourceRoles = sourceData.roles;
    }

    // Synchroniser les salons
    const channelStats = await this.syncChannels(targetGuild, sourceGuildId, sourceChannels);

    // Synchroniser les rôles
    const roleStats = await this.syncRoles(targetGuild, sourceGuildId, sourceRoles);

    // Logger les statistiques
    const totalStats = {
      channelsAdded: channelStats.added,
      channelsUpdated: channelStats.updated,
      channelsFixed: channelStats.fixed,
      rolesAdded: roleStats.added,
      rolesUpdated: roleStats.updated
    };

    if (totalStats.channelsAdded > 0 || totalStats.channelsFixed > 0) {
      await this.logger.logAdminAction(
        targetGuildId,
        `✅ Sync: ${totalStats.channelsAdded} salons ajoutés, ${totalStats.channelsFixed} correspondances réparées`
      );
    }

    this.lastSyncTime.set(targetGuildId, Date.now());

    // Si la sync a réussi, réinitialiser le compteur d'erreurs
    if (totalStats.channelsAdded > 0 || totalStats.channelsFixed > 0) {
      this.recentErrors.delete(targetGuildId);
    }

    const syncDuration = Date.now() - syncStart;

    return totalStats;
  }

  /**
   * Synchroniser les salons
   */
  async syncChannels(targetGuild, sourceGuildId, sourceChannels) {
    const stats = { added: 0, updated: 0, fixed: 0 };

    for (const [sourceChannelId, sourceChannel] of sourceChannels) {
      try {
        // Ignorer les catégories, canaux vocaux et stage channels
        // Convertir le type selfbot (string) en numérique pour comparaison fiable
        const srcType = this.convertChannelType(sourceChannel.type);
        if (srcType === 4 || srcType === 2 || srcType === 13) continue;

        // Vérifier si le mapping existe
        const existingMapping = await Channel.findOne({
          sourceChannelId: sourceChannelId,
          serverId: sourceGuildId
        });

        if (!existingMapping) {
          // Créer un nouveau mapping (match par nom uniquement — le type peut différer après fallback news→text)
          const mirrorChannel = targetGuild.channels.cache.find(
            ch => ch.name === sourceChannel.name && [0, 5, 15].includes(ch.type) // text, news, forum uniquement
          );

          if (mirrorChannel) {
            try {
              await Channel.findOneAndUpdate(
                { sourceChannelId: sourceChannelId, serverId: sourceGuildId },
                {
                  name: sourceChannel.name,
                  discordId: mirrorChannel.id,
                  sourceChannelId: sourceChannelId,
                  serverId: sourceGuildId,
                  type: sourceChannel.type,
                  categoryId: sourceChannel.parentId,
                  lastActivity: new Date(),
                  isActive: true
                },
                { upsert: true, new: true }
              );
            } catch (upsertError) {
              if (upsertError.code === 11000) {
                // discordId déjà utilisé par un autre sourceChannelId → mettre à jour ce document
                await Channel.findOneAndUpdate(
                  { discordId: mirrorChannel.id },
                  { $set: { sourceChannelId: sourceChannelId, name: sourceChannel.name, lastActivity: new Date() } }
                );
              } else {
                throw upsertError;
              }
            }

            stats.added++;

            // Invalider le cache
            this.correspondenceManager.channelCache.delete(`${sourceChannelId}_${targetGuild.id}`);
          } else {
            // Le salon mirror n'existe pas encore, le créer si possible
            if (targetGuild.members.me?.permissions.has('ManageChannels')) {
              // Vérifier d'abord les permissions d'accès au salon source
              const userData = this.client.services?.userClient?.getUserData(targetGuild.id);
              let canCreate = true;

              if (userData && userData.token && this.client.services?.channelMonitor) {
                try {
                  await this.client.services.channelMonitor.testChannelAccess(
                    sourceChannelId,
                    userData,
                    sourceGuildId
                  );
                } catch (error) {
                  if (error.statusCode === 403) {
                    canCreate = false;

                    // Auto-blacklister ce salon
                    await Channel.findOneAndUpdate(
                      { sourceChannelId: sourceChannelId, serverId: sourceGuildId },
                      {
                        blacklisted: true,
                        blacklistReason: 'Permission denied - user cannot view source channel',
                        blacklistedAt: new Date(),
                        name: sourceChannel.name || `inaccessible-${sourceChannelId.slice(-6)}`
                      },
                      { upsert: true }
                    );

                    stats.skipped = (stats.skipped || 0) + 1;
                  } else {
                    console.warn(`⚠️ Impossible de vérifier les permissions pour ${sourceChannel.name}: ${error.message}`);
                  }
                }
              }

              if (canCreate) {
                const newChannel = await this.createMirrorChannel(targetGuild, sourceChannel, sourceGuildId);
                if (newChannel) {
                  try {
                    await Channel.findOneAndUpdate(
                      { sourceChannelId: sourceChannelId, serverId: sourceGuildId },
                      {
                        name: sourceChannel.name,
                        discordId: newChannel.id,
                        sourceChannelId: sourceChannelId,
                        serverId: sourceGuildId,
                        type: sourceChannel.type,
                        categoryId: sourceChannel.parentId,
                        lastActivity: new Date(),
                        isActive: true
                      },
                      { upsert: true, new: true }
                    );
                  } catch (upsertError) {
                    if (upsertError.code === 11000) {
                      await Channel.findOneAndUpdate(
                        { discordId: newChannel.id },
                        { $set: { sourceChannelId: sourceChannelId, name: sourceChannel.name, lastActivity: new Date() } }
                      );
                    } else {
                      throw upsertError;
                    }
                  }
                  stats.added++;
                }
              }
            }
          }
        } else if (!existingMapping.discordId || existingMapping.discordId === 'pending' || existingMapping.discordId.startsWith('pending_') || !targetGuild.channels.cache.has(existingMapping.discordId)) {
          // Réparer un mapping cassé ou pointant vers un salon supprimé (match par nom — le type peut différer après fallback news→text)
          const mirrorChannel = targetGuild.channels.cache.find(
            ch => ch.name === sourceChannel.name && [0, 5, 15].includes(ch.type) // text, news, forum uniquement
          );

          if (mirrorChannel) {
            existingMapping.discordId = mirrorChannel.id;
            existingMapping.lastSynced = new Date();
            await existingMapping.save();

            stats.fixed++;

            // Invalider le cache
            this.correspondenceManager.channelCache.delete(`${sourceChannelId}_${targetGuild.id}`);
          }
        } else if (existingMapping.name !== sourceChannel.name) {
          // Mettre à jour le nom si changé
          existingMapping.name = sourceChannel.name;
          existingMapping.lastSynced = new Date();
          await existingMapping.save();

          stats.updated++;
        }
      } catch (error) {
        console.error(`❌ Erreur sync salon ${sourceChannel?.name}:`, error.message);
      }
    }

    return stats;
  }

  /**
   * Synchroniser les rôles
   */
  async syncRoles(targetGuild, sourceGuildId, sourceRoles) {
    const stats = { added: 0, updated: 0 };

    for (const [sourceRoleId, sourceRole] of sourceRoles) {
      try {
        if (sourceRole.name === '@everyone') continue;

        const existingMapping = await Role.findOne({
          sourceRoleId: sourceRoleId,
          serverId: sourceGuildId
        });

        if (!existingMapping) {
          const mirrorRole = targetGuild.roles.cache.find(
            r => r.name === sourceRole.name
          );

          if (mirrorRole) {
            try {
              await Role.findOneAndUpdate(
                { sourceRoleId: sourceRoleId, serverId: sourceGuildId },
                {
                  name: sourceRole.name,
                  sourceRoleId: sourceRoleId,
                  discordId: mirrorRole.id,
                  serverId: sourceGuildId,
                  synced: true
                },
                { upsert: true, new: true }
              );
            } catch (upsertError) {
              if (upsertError.code === 11000) {
                await Role.findOneAndUpdate(
                  { discordId: mirrorRole.id },
                  { $set: { sourceRoleId: sourceRoleId, name: sourceRole.name, synced: true } }
                );
              } else {
                throw upsertError;
              }
            }

            stats.added++;

            // Invalider le cache
            this.correspondenceManager.roleCache.delete(`${sourceRoleId}_${targetGuild.id}`);
          }
        } else if (existingMapping.name !== sourceRole.name) {
          existingMapping.name = sourceRole.name;
          existingMapping.lastSynced = new Date();
          await existingMapping.save();

          stats.updated++;
        }
      } catch (error) {
        console.error(`❌ Erreur sync rôle ${sourceRole?.name}:`, error.message);
      }
    }

    return stats;
  }

  /**
   * Créer un salon mirror
   */
  async createMirrorChannel(targetGuild, sourceChannel, sourceGuildId) {
    try {
      // Trouver ou créer la catégorie correspondante
      let parentCategory = null;
      if (sourceChannel.parentId) {
        const categoryMapping = await Channel.findOne({
          sourceChannelId: sourceChannel.parentId,
          serverId: sourceGuildId
        });

        if (categoryMapping && categoryMapping.discordId) {
          // Mapping existe déjà
          parentCategory = targetGuild.channels.cache.get(categoryMapping.discordId);
        } else {
          // 🆕 Mapping absent → Créer la catégorie mirror automatiquement
          // Utiliser eventHandlers pour accéder au cache discord.js (sourceChannel peut être un objet plain JSON)
          const handlers = this.client.services?.userClient?.eventHandlers?.get(targetGuild.id);
          const sourceGuild = handlers?.sourceGuild;
          const sourceCategory = sourceGuild?.channels?.cache?.get(sourceChannel.parentId);

          if (sourceCategory && sourceCategory.type === 4) {

            try {
              // Vérifier si la catégorie existe déjà sur le mirror (par nom)
              let mirrorCategory = targetGuild.channels.cache.find(
                ch => ch.type === 4 && ch.name === sourceCategory.name
              );

              if (!mirrorCategory) {
                // Créer la catégorie sur le serveur mirror
                mirrorCategory = await targetGuild.channels.create({
                  name: sourceCategory.name,
                  type: 4, // CategoryChannel
                  position: sourceCategory.position
                });
                console.log(`✅ Catégorie mirror créée: ${mirrorCategory.name}`);
              } else {
                console.log(`✅ Catégorie mirror existe déjà: ${mirrorCategory.name}`);
              }

              // Sauvegarder le mapping en base de données
              await Channel.findOneAndUpdate(
                { sourceChannelId: sourceChannel.parentId, serverId: sourceGuildId },
                {
                  name: sourceCategory.name,
                  discordId: mirrorCategory.id,
                  type: 4,
                  categoryId: null, // Les catégories n'ont pas de parent
                  lastActivity: new Date(),
                  lastSynced: new Date(),
                  isActive: true
                },
                { upsert: true, new: true }
              );

              parentCategory = mirrorCategory;
              console.log(`✅ Mapping catégorie créé: ${sourceCategory.name} (${sourceChannel.parentId} → ${mirrorCategory.id})`);

            } catch (categoryError) {
              console.error(`❌ Erreur création catégorie ${sourceCategory.name}: ${categoryError.message}`);
              // Continuer sans catégorie si erreur
              parentCategory = null;
            }
          }
        }
      }

      const numericType = this.convertChannelType(sourceChannel.type);

      const channelData = {
        name: sourceChannel.name,
        type: numericType,
        parent: parentCategory,
        topic: sourceChannel.topic || null,
        nsfw: sourceChannel.nsfw || false,
        rateLimitPerUser: sourceChannel.rateLimitPerUser || 0
      };

      // Fallback news → text si le serveur n'a pas Community
      if (numericType === 5) {
        try {
          return await targetGuild.channels.create(channelData);
        } catch (newsError) {
          if (newsError.code === 50035 || newsError.message?.includes('COMMUNITY')) {
            channelData.type = 0;
            channelData.topic = `📢 [Salon d'annonces] ${channelData.topic || ''}`;
          } else {
            throw newsError;
          }
        }
      }

      const newChannel = await targetGuild.channels.create(channelData);
      console.log(`✅ Salon créé: ${newChannel.name} (type: ${newChannel.type})`);

      return newChannel;
    } catch (error) {
      console.error(`❌ Erreur création salon ${sourceChannel.name}:`, error);
      return null;
    }
  }

  /**
   * Récupérer les données source via l'API Discord
   */
  async fetchSourceDataViaAPI(sourceGuildId, targetGuildId) {
    const channels = new Map();
    const roles = new Map();

    try {
      // Récupérer le token utilisateur depuis la config DB ou userClient en mémoire
      let userToken = null;
      const serverConfig = await ServerConfig.findOne({ guildId: targetGuildId });
      if (serverConfig && serverConfig.userToken) {
        userToken = serverConfig.userToken;
      } else if (this.client.services?.userClient) {
        const userData = this.client.services.userClient.getUserData(targetGuildId);
        if (userData && userData.token) {
          userToken = userData.token;
        }
      }
      if (!userToken) {
        return { channels, roles };
      }

      // Récupérer les salons via l'API
      const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

      const channelsResponse = await fetch(`https://discord.com/api/v10/guilds/${sourceGuildId}/channels`, {
        headers: {
          'Authorization': userToken,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      if (channelsResponse.ok) {
        const channelsData = await channelsResponse.json();
        for (const channel of channelsData) {
          channels.set(channel.id, {
            id: channel.id,
            name: channel.name,
            type: channel.type,
            parentId: channel.parent_id,
            topic: channel.topic,
            nsfw: channel.nsfw,
            rateLimitPerUser: channel.rate_limit_per_user
          });
        }
      }

      // Récupérer les rôles via l'API
      const rolesResponse = await fetch(`https://discord.com/api/v10/guilds/${sourceGuildId}/roles`, {
        headers: {
          'Authorization': userToken,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      if (rolesResponse.ok) {
        const rolesData = await rolesResponse.json();
        for (const role of rolesData) {
          roles.set(role.id, {
            id: role.id,
            name: role.name,
            color: role.color,
            hoist: role.hoist,
            position: role.position
          });
        }
      }
    } catch (error) {
      console.error('❌ Erreur récupération données API:', error);
    }

    return { channels, roles };
  }

  /**
   * Forcer une synchronisation immédiate pour un serveur
   */
  async forceSyncServer(targetGuildId) {
    const serverConfig = await ServerConfig.findOne({ guildId: targetGuildId });
    if (!serverConfig) {
      throw new Error('Configuration serveur introuvable');
    }

    return await this.syncServer(targetGuildId, serverConfig.sourceGuildId);
  }

  /**
   * Récupérer les statistiques de synchronisation
   */
  getStats() {
    const stats = {
      isRunning: this.isSyncing,
      lastSync: {},
      errors: {}
    };

    for (const [guildId, timestamp] of this.lastSyncTime) {
      stats.lastSync[guildId] = new Date(timestamp).toISOString();
    }

    for (const [guildId, errorCount] of this.syncErrors) {
      stats.errors[guildId] = errorCount;
    }

    return stats;
  }

  /**
   * Convertit le type de salon string (selfbot) vers numérique (discord.js v14)
   */
  convertChannelType(type) {
    if (typeof type === 'number') return type;

    const typeMap = {
      'GUILD_TEXT': 0,
      'DM': 1,
      'GUILD_VOICE': 2,
      'GUILD_CATEGORY': 4,
      'GUILD_NEWS': 5,
      'GUILD_NEWS_THREAD': 10,
      'GUILD_PUBLIC_THREAD': 11,
      'GUILD_FORUM': 15
    };

    return typeMap[type] || 0;
  }
}

module.exports = ChannelSyncService;