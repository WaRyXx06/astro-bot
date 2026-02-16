const { createLogger } = require('../config/logConfig');
const Channel = require('../models/Channel');
const ServerConfig = require('../models/ServerConfig');
const Log = require('../models/Log');

class AutoRecoveryService {
  constructor(client, correspondenceManager, channelSync, userClient) {
    this.client = client;
    this.correspondenceManager = correspondenceManager;
    this.channelSync = channelSync;
    this.userClient = userClient;
    this.logger = createLogger('AutoRecoveryService');

    // Queue de récupération avec retry
    this.recoveryQueue = new Map(); // channelId -> { attempts, sourceGuildId, targetGuildId, firstAttempt, errorMessageId }
    this.successMetrics = { total: 0, success: 0, failed: 0 };
    this.retryDelays = [1000, 3000, 10000]; // Backoff exponentiel: 1s, 3s, 10s

    // Track des salons en cours de récupération pour éviter les doublons
    this.recoveringChannels = new Set();

    // Map pour tracker les messages d'erreur envoyés
    this.errorMessages = new Map(); // errorKey -> { messageId, channelId, timestamp }

    // ✅ Cache des salons récemment récupérés pour éviter les notifications de succès en double
    // Expire après 5 minutes pour permettre une nouvelle tentative si nécessaire
    this.recentlyRecovered = new Map(); // recoveryKey -> { timestamp, channelName }
  }

  /**
   * Démarre la récupération automatique pour un salon
   * @param {string} sourceChannelId - ID du salon source
   * @param {string} sourceGuildId - ID du serveur source
   * @param {string} targetGuildId - ID du serveur cible
   * @param {string} errorMessageId - ID du message d'erreur dans #error (optionnel)
   */
  async startRecovery(sourceChannelId, sourceGuildId, targetGuildId, errorMessageId = null) {
    const recoveryKey = `${sourceChannelId}_${targetGuildId}`;

    // ✅ Vérifier si ce salon a été récemment récupéré (< 5 min)
    const recentRecovery = this.recentlyRecovered.get(recoveryKey);
    if (recentRecovery) {
      const timeSinceRecovery = Date.now() - recentRecovery.timestamp;
      if (timeSinceRecovery < 5 * 60 * 1000) { // 5 minutes
        this.logger.info('recovery', `⏭️ Salon ${recentRecovery.channelName || sourceChannelId} récemment récupéré (${Math.round(timeSinceRecovery / 1000)}s), skip`);
        return;
      }
      // Expiration passée, supprimer de la cache
      this.recentlyRecovered.delete(recoveryKey);
    }

    // Éviter les doublons de récupération
    if (this.recoveringChannels.has(recoveryKey)) {
      this.logger.info('recovery', `⏳ Récupération déjà en cours pour ${sourceChannelId}`);
      return;
    }

    this.recoveringChannels.add(recoveryKey);

    // Initialiser ou mettre à jour la queue
    if (!this.recoveryQueue.has(recoveryKey)) {
      this.recoveryQueue.set(recoveryKey, {
        attempts: 0,
        sourceGuildId,
        targetGuildId,
        firstAttempt: Date.now(),
        errorMessageId
      });
      this.successMetrics.total++;
    }

    // Lancer la récupération avec retry
    await this.attemptRecovery(sourceChannelId, sourceGuildId, targetGuildId);
  }

  /**
   * Tente de récupérer un salon avec retry automatique
   */
  async attemptRecovery(sourceChannelId, sourceGuildId, targetGuildId) {
    const recoveryKey = `${sourceChannelId}_${targetGuildId}`;

    this.logger.info('recovery', `🎯 attemptRecovery appelée pour ${sourceChannelId}`);

    // ✅ NOUVEAU: Vérifier si la récupération a déjà été terminée (succès ou échec)
    if (!this.recoveryQueue.has(recoveryKey)) {
      this.logger.info('recovery', `⏭️ Récupération déjà terminée pour ${sourceChannelId}, skip (queue n'existe plus)`);
      return;
    }

    const queueData = this.recoveryQueue.get(recoveryKey);

    if (!queueData) {
      this.logger.warn('recovery', `⚠️ queueData est null/undefined pour ${sourceChannelId}, abandon`);
      return;
    }

    queueData.attempts++;

    this.logger.info('recovery', `📊 Queue state: attempts=${queueData.attempts}, firstAttempt=${new Date(queueData.firstAttempt).toISOString()}`);

    try {
      this.logger.info('recovery', `🔄 Tentative ${queueData.attempts}/3 pour récupérer ${sourceChannelId}`);

      // Notifier le début de la récupération dans #error si on a un message d'erreur
      if (queueData.errorMessageId && queueData.attempts === 1) {
        await this.updateErrorMessage(targetGuildId, queueData.errorMessageId, 'retry_started', sourceChannelId);
      }

      // Tentative 1: Forcer une sync immédiate
      if (queueData.attempts === 1) {
        this.logger.info('recovery', `🔄 [Attempt 1] Forçage sync serveur ${targetGuildId}...`);

        try {
          await this.channelSync.forceSyncServer(targetGuildId);
          this.logger.info('recovery', `✅ [Attempt 1] Sync terminée, vérification mapping...`);
        } catch (syncError) {
          this.logger.error('recovery', `❌ [Attempt 1] Erreur lors de forceSyncServer: ${syncError.message}`, syncError);
          // Ne pas throw, continuer pour vérifier le mapping quand même
        }

        // Vérifier si le mapping existe maintenant
        const mapping = await Channel.findOne({
          sourceChannelId,
          serverId: sourceGuildId
        });

        this.logger.info('recovery', `🔍 [Attempt 1] Mapping trouvé: ${mapping ? `${mapping.name} (${mapping.discordId})` : 'NON'}`);

        // Vérifier que le discordId pointe vers un vrai salon sur le mirror (pas pending, pas stale)
        if (mapping && mapping.discordId) {
          const verifyGuild = this.client.guilds.cache.get(targetGuildId);
          if (verifyGuild && verifyGuild.channels.cache.has(mapping.discordId)) {
            await this.handleRecoverySuccess(sourceChannelId, sourceGuildId, targetGuildId, mapping);
            return;
          }
        }

        this.logger.info('recovery', `⏭️ [Attempt 1] Mapping non trouvé ou invalide, passage à l'attempt 2...`);
      }

      // Tentative 2: Créer le salon manuellement
      if (queueData.attempts === 2) {
        const handlers = this.client.services?.userClient?.eventHandlers?.get(targetGuildId);
        const sourceGuild = handlers?.sourceGuild;
        if (!sourceGuild) throw new Error('Guild source introuvable');

        const sourceChannel = sourceGuild.channels?.cache?.get(sourceChannelId);
        if (!sourceChannel) throw new Error('Salon source introuvable');

        // Créer le salon mirror
        const targetGuild = this.client.guilds.cache.get(targetGuildId);
        if (!targetGuild) throw new Error('Guild cible introuvable');

        // Vérifier d'abord les permissions d'accès au salon source
        const userData = this.userClient.getUserData(targetGuildId);
        if (userData && userData.token) {
          try {
            // Utiliser testChannelAccess depuis channelMonitor si disponible
            if (this.client.services?.channelMonitor) {
              await this.client.services.channelMonitor.testChannelAccess(
                sourceChannelId,
                userData,
                sourceGuildId
              );
              console.log(`✅ [AutoRecovery] Permissions vérifiées pour ${sourceChannel.name}`);
            }
          } catch (error) {
            if (error.statusCode === 403) {
              console.log(`🚫 [AutoRecovery] Accès refusé au salon ${sourceChannel.name} - récupération annulée`);

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

              // Retirer de la queue de récupération
              this.recoveryQueue.delete(recoveryKey);

              // Logger l'erreur
              if (this.logger) {
                await this.logger.logError(
                  targetGuildId,
                  `❌ **Récupération automatique impossible**\n` +
                  `📍 Salon source: **${sourceChannel.name}** (${sourceChannelId})\n` +
                  `🚫 Raison: **Permissions insuffisantes**\n` +
                  `⚙️ Action: Salon blacklisté et retiré de la queue de récupération`
                );
              }

              return;
            }
            // Pour toute autre erreur, continuer mais logger
            console.warn(`⚠️ [AutoRecovery] Impossible de vérifier les permissions pour ${sourceChannel.name}: ${error.message}`);
          }
        }

        // Trouver ou créer la catégorie correspondante
        let categoryId = null;
        if (sourceChannel.parentId) {
          const categoryMapping = await Channel.findOne({
            sourceChannelId: sourceChannel.parentId,
            serverId: sourceGuildId
          });
          categoryId = categoryMapping?.discordId;
        }

        // Créer le salon
        const mirrorChannel = await this.createMirrorChannel(targetGuild, sourceChannel, categoryId);

        if (mirrorChannel) {
          // Notifier dans #newroom avec mention cliquable
          try {
            const categoryName = sourceChannel.parent?.name || 'Aucune';
            if (this.client.services?.logger) {
              await this.client.services.logger.logNewRoom(
                targetGuildId,
                `🔄 **RÉCUPÉRATION AUTOMATIQUE** - <#${mirrorChannel.id}>\n` +
                `📁 Catégorie: ${categoryName}\n` +
                `⚡ **Auto-recovery** - Salon synchronisé`,
                'Auto-Recovery',
                mirrorChannel.id
              );
            }
          } catch (logError) {
            this.logger.warn('recovery', `Erreur log newroom: ${logError.message}`);
          }

          // Sauvegarder le mapping
          await Channel.findOneAndUpdate(
            { sourceChannelId, serverId: sourceGuildId },
            {
              name: sourceChannel.name,
              discordId: mirrorChannel.id,
              type: sourceChannel.type,
              categoryId,
              lastActivity: new Date(),
              isActive: true
            },
            { upsert: true, new: true }
          );

          // Invalider le cache
          this.correspondenceManager.channelCache.delete(recoveryKey);

          // skipNewroomNotification = true car on a déjà notifié #newroom ci-dessus (ligne 217)
          await this.handleRecoverySuccess(sourceChannelId, sourceGuildId, targetGuildId, {
            name: sourceChannel.name,
            discordId: mirrorChannel.id
          }, true);
          return;
        }
      }

      // Tentative 3: Dernière sync forcée avec délai
      if (queueData.attempts === 3) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        await this.channelSync.forceSyncServer(targetGuildId);

        const mapping = await Channel.findOne({
          sourceChannelId,
          serverId: sourceGuildId
        });

        // Vérifier que le discordId pointe vers un vrai salon sur le mirror
        if (mapping && mapping.discordId) {
          const verifyGuild = this.client.guilds.cache.get(targetGuildId);
          if (verifyGuild && verifyGuild.channels.cache.has(mapping.discordId)) {
            await this.handleRecoverySuccess(sourceChannelId, sourceGuildId, targetGuildId, mapping);
            return;
          }
        }
      }

      // Si on arrive ici et qu'on a fait 3 tentatives, c'est un échec
      if (queueData.attempts >= 3) {
        this.logger.warn('recovery', `⚠️ Tentatives épuisées (${queueData.attempts}/3), appel handleRecoveryFailure...`);
        await this.handleRecoveryFailure(sourceChannelId, sourceGuildId, targetGuildId);
        return;
      }

      // Sinon, programmer la prochaine tentative avec backoff
      const delay = this.retryDelays[queueData.attempts - 1] || 10000;
      this.logger.info('recovery', `⏰ Planification attempt ${queueData.attempts + 1} dans ${delay}ms...`);
      setTimeout(() => {
        // Vérifier si pas déjà résolu avant de relancer
        if (this.recoveryQueue.has(recoveryKey)) {
          this.attemptRecovery(sourceChannelId, sourceGuildId, targetGuildId);
        }
      }, delay);

    } catch (error) {
      this.logger.error('recovery', `❌ Erreur lors de la tentative ${queueData.attempts}: ${error.message}`, error);

      if (queueData.attempts < 3) {
        const delay = this.retryDelays[queueData.attempts - 1] || 10000;
        setTimeout(() => {
          // Vérifier si pas déjà résolu avant de relancer
          if (this.recoveryQueue.has(recoveryKey)) {
            this.attemptRecovery(sourceChannelId, sourceGuildId, targetGuildId);
          }
        }, delay);
      } else {
        await this.handleRecoveryFailure(sourceChannelId, sourceGuildId, targetGuildId);
      }
    }
  }

  /**
   * Crée un salon mirror
   */
  async createMirrorChannel(targetGuild, sourceChannel, categoryId) {
    try {
      const channelData = {
        name: sourceChannel.name,
        type: this.convertChannelType(sourceChannel.type),
        parent: categoryId,
        topic: sourceChannel.topic,
        nsfw: sourceChannel.nsfw,
        rateLimitPerUser: sourceChannel.rateLimitPerUser
      };

      // Gérer les types spéciaux
      if (sourceChannel.type === 'GUILD_VOICE' || sourceChannel.type === 2) {
        channelData.bitrate = sourceChannel.bitrate || 64000;
        channelData.userLimit = sourceChannel.userLimit || 0;
      }

      if (sourceChannel.type === 'GUILD_NEWS' || sourceChannel.type === 5) {
        // Essayer de créer comme salon annonce
        try {
          channelData.type = 5; // GuildAnnouncement
          return await targetGuild.channels.create(channelData);
        } catch (newsError) {
          // Fallback vers salon texte avec préfixe
          this.logger.warn('recovery', `Impossible de créer salon annonce, fallback vers texte: ${newsError.message}`);
          channelData.type = 0; // GuildText
          channelData.name = `📢${channelData.name}`;
          return await targetGuild.channels.create(channelData);
        }
      }

      return await targetGuild.channels.create(channelData);

    } catch (error) {
      this.logger.error('recovery', `Échec création salon mirror: ${error.message}`, error);
      return null;
    }
  }

  /**
   * Convertit le type de salon string vers numérique
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

  /**
   * Gère le succès de la récupération
   * @param {string} sourceChannelId - ID du salon source
   * @param {string} sourceGuildId - ID du serveur source
   * @param {string} targetGuildId - ID du serveur cible
   * @param {Object} mapping - Mapping du salon {name, discordId}
   * @param {boolean} skipNewroomNotification - Si true, ne pas notifier #newroom (déjà fait par l'appelant)
   */
  async handleRecoverySuccess(sourceChannelId, sourceGuildId, targetGuildId, mapping, skipNewroomNotification = false) {
    const recoveryKey = `${sourceChannelId}_${targetGuildId}`;
    const queueData = this.recoveryQueue.get(recoveryKey);

    // ✅ Vérifier si on a déjà traité ce succès (évite les doublons)
    if (!queueData) {
      this.logger.info('recovery', `⏭️ Succès déjà traité pour ${mapping.name}, skip notification`);
      return;
    }

    this.successMetrics.success++;
    const recoveryTime = Date.now() - queueData.firstAttempt;

    this.logger.info('recovery',
      `✅ Récupération réussie pour ${mapping.name} après ${queueData.attempts} tentative(s) en ${recoveryTime}ms`
    );

    // ✅ Ajouter immédiatement au cache des récemments récupérés AVANT toute autre action
    this.recentlyRecovered.set(recoveryKey, {
      timestamp: Date.now(),
      channelName: mapping.name
    });

    // Auto-expiration après 5 minutes
    setTimeout(() => {
      this.recentlyRecovered.delete(recoveryKey);
    }, 5 * 60 * 1000);

    // ✅ Nettoyer la queue IMMÉDIATEMENT pour éviter les tentatives parallèles
    this.recoveryQueue.delete(recoveryKey);

    // ✅ Notifier dans #newroom si pas déjà fait (pour Tentatives 1 et 3 via forceSyncServer)
    if (!skipNewroomNotification && this.client.services?.logger) {
      try {
        const sourceGuild = await this.userClient.getSourceGuild(targetGuildId);
        const sourceChannel = sourceGuild?.channels?.cache?.get(sourceChannelId);
        const categoryName = sourceChannel?.parent?.name || 'Aucune';

        await this.client.services.logger.logNewRoom(
          targetGuildId,
          `🔄 **RÉCUPÉRATION AUTOMATIQUE** - <#${mapping.discordId}>\n` +
          `📁 Catégorie: ${categoryName}\n` +
          `⚡ **Auto-recovery** (Tentative ${queueData.attempts}/3) - Salon synchronisé`,
          'Auto-Recovery',
          mapping.discordId
        );
      } catch (logError) {
        this.logger.warn('recovery', `Erreur log newroom: ${logError.message}`);
      }
    }

    // Envoyer une notification de succès dans #error
    if (queueData.errorMessageId) {
      await this.sendSuccessNotification(targetGuildId, sourceChannelId, mapping, queueData);
    }

    // Logger le succès
    await Log.create({
      type: 'auto-recovery',
      message: `✅ Salon ${mapping.name} récupéré automatiquement après ${queueData.attempts} tentative(s)`,
      timestamp: new Date(),
      channelId: mapping.discordId,
      metadata: {
        sourceChannelId,
        attempts: queueData.attempts,
        recoveryTimeMs: recoveryTime
      }
    });

    // ✅ Délai avant de supprimer de recoveringChannels pour laisser le temps
    // aux autres processus de voir qu'on est "en cours" et éviter les race conditions
    setTimeout(() => {
      this.recoveringChannels.delete(recoveryKey);
    }, 3000); // 3 secondes

    // Invalider le cache de correspondance
    this.correspondenceManager.channelCache.delete(recoveryKey);

    // ✅ Lancer le backfill des messages manqués en arrière-plan (ne bloque pas)
    this.backfillMissedMessages(sourceChannelId, sourceGuildId, targetGuildId, mapping)
      .catch(err => this.logger.error('backfill', `Erreur backfill: ${err.message}`, err));
  }

  /**
   * Gère l'échec de la récupération
   */
  async handleRecoveryFailure(sourceChannelId, sourceGuildId, targetGuildId) {
    const recoveryKey = `${sourceChannelId}_${targetGuildId}`;

    // ✅ NOUVEAU: Vérifier si la queue existe encore (peut avoir été nettoyée après un succès)
    if (!this.recoveryQueue.has(recoveryKey)) {
      this.logger.warn('recovery', `⚠️ Tentative d'échec mais queue déjà nettoyée pour ${sourceChannelId}`);
      return;
    }

    const queueData = this.recoveryQueue.get(recoveryKey);

    this.successMetrics.failed++;

    this.logger.error('recovery',
      `❌ Échec définitif de récupération pour ${sourceChannelId} après ${queueData.attempts} tentatives`
    );

    // Mettre à jour le message d'erreur si présent
    if (queueData.errorMessageId) {
      await this.updateErrorMessage(targetGuildId, queueData.errorMessageId, 'failed', sourceChannelId);
    }

    // Logger l'échec
    await Log.create({
      type: 'error',
      message: `❌ Échec de récupération automatique pour le salon ${sourceChannelId} après 3 tentatives`,
      timestamp: new Date(),
      metadata: {
        sourceChannelId,
        attempts: queueData.attempts
      }
    });

    // Nettoyer la queue
    this.recoveryQueue.delete(recoveryKey);
    this.recoveringChannels.delete(recoveryKey);
  }

  /**
   * Envoie une notification de succès dans le canal #error
   */
  async sendSuccessNotification(targetGuildId, sourceChannelId, mapping, queueData) {
    try {
      const targetGuild = this.client.guilds.cache.get(targetGuildId);
      if (!targetGuild) return;

      // Trouver le canal #error
      const errorChannel = targetGuild.channels.cache.find(ch => ch.name === 'error');
      if (!errorChannel) return;

      // Créer le message de succès
      const successEmbed = {
        color: 0x00ff00,
        title: '✅ Correspondance récupérée avec succès',
        description: `Le salon a été automatiquement récupéré et mappé.`,
        fields: [
          {
            name: '📍 Salon source',
            value: `ID: \`${sourceChannelId}\``,
            inline: true
          },
          {
            name: '🎯 Salon mirror créé',
            value: `<#${mapping.discordId}> (${mapping.name})`,
            inline: true
          },
          {
            name: '📊 Statistiques',
            value: `• Tentatives: ${queueData.attempts}/3\n• Temps de récupération: ${Math.round((Date.now() - queueData.firstAttempt) / 1000)}s`,
            inline: false
          }
        ],
        timestamp: new Date().toISOString(),
        footer: {
          text: 'Système de récupération automatique'
        }
      };

      // Si on a un message d'erreur original, répondre à celui-ci
      if (queueData.errorMessageId) {
        try {
          const errorMessage = await errorChannel.messages.fetch(queueData.errorMessageId);
          if (errorMessage) {
            await errorMessage.reply({ embeds: [successEmbed] });
            return;
          }
        } catch (e) {
          // Message introuvable, envoyer normalement
        }
      }

      // Sinon envoyer un nouveau message
      await errorChannel.send({ embeds: [successEmbed] });

    } catch (error) {
      this.logger.error('recovery', `Erreur envoi notification succès: ${error.message}`, error);
    }
  }

  /**
   * Met à jour un message d'erreur existant avec le statut de récupération
   */
  async updateErrorMessage(targetGuildId, messageId, status, sourceChannelId) {
    try {
      const targetGuild = this.client.guilds.cache.get(targetGuildId);
      if (!targetGuild) return;

      const errorChannel = targetGuild.channels.cache.find(ch => ch.name === 'error');
      if (!errorChannel) return;

      const message = await errorChannel.messages.fetch(messageId);
      if (!message) return;

      let statusText = '';
      let color = 0xffff00; // Jaune par défaut

      switch (status) {
        case 'retry_started':
          statusText = '🔄 **Récupération automatique en cours...**\nTentative 1/3 - Synchronisation forcée';
          break;
        case 'retry_attempt_2':
          statusText = '🔄 **Récupération automatique en cours...**\nTentative 2/3 - Création manuelle du salon';
          break;
        case 'retry_attempt_3':
          statusText = '🔄 **Récupération automatique en cours...**\nTentative 3/3 - Dernière synchronisation';
          break;
        case 'failed':
          statusText = '❌ **Échec de la récupération automatique**\nUtilisez `/discovery` ou `/fix-correspondances` manuellement';
          color = 0xff0000; // Rouge
          break;
      }

      if (statusText) {
        const embed = {
          color,
          description: statusText,
          timestamp: new Date().toISOString()
        };

        await message.reply({ embeds: [embed] });
      }

    } catch (error) {
      this.logger.error('recovery', `Erreur mise à jour message: ${error.message}`, error);
    }
  }

  /**
   * Enregistre le message d'erreur pour tracking
   */
  registerErrorMessage(sourceChannelId, targetGuildId, messageId) {
    const errorKey = `${sourceChannelId}_${targetGuildId}`;
    this.errorMessages.set(errorKey, {
      messageId,
      timestamp: Date.now()
    });

    // Nettoyer les vieux messages après 1 heure
    setTimeout(() => {
      this.errorMessages.delete(errorKey);
    }, 3600000);
  }

  /**
   * Vérifie si une récupération est en cours pour un salon
   * @param {string} sourceChannelId - ID du salon source
   * @param {string} targetGuildId - ID du serveur cible
   * @returns {boolean}
   */
  isRecovering(sourceChannelId, targetGuildId) {
    const recoveryKey = `${sourceChannelId}_${targetGuildId}`;
    return this.recoveringChannels.has(recoveryKey);
  }

  /**
   * Obtient les métriques de récupération
   */
  getMetrics() {
    const successRate = this.successMetrics.total > 0
      ? (this.successMetrics.success / this.successMetrics.total * 100).toFixed(1)
      : 0;

    return {
      ...this.successMetrics,
      successRate: `${successRate}%`,
      queueSize: this.recoveryQueue.size,
      activeRecoveries: this.recoveringChannels.size
    };
  }

  /**
   * Récupère les messages manqués pendant que le salon n'existait pas
   * Appelé en arrière-plan après une récupération réussie
   * @param {string} sourceChannelId - ID du salon source
   * @param {string} sourceGuildId - ID du serveur source
   * @param {string} targetGuildId - ID du serveur cible
   * @param {Object} mapping - Mapping du salon (name, discordId)
   */
  async backfillMissedMessages(sourceChannelId, sourceGuildId, targetGuildId, mapping) {
    try {
      const ProcessedMessage = require('../models/ProcessedMessage');

      // Récupérer le dernier message traité pour ce salon
      const lastProcessed = await ProcessedMessage.findOne({
        channelId: sourceChannelId
      }).sort({ processedAt: -1 });

      // 🛡️ FIX: Toujours récupérer 50 messages pour cohérence avec les autres backfills
      // Avant: limit=20 pour initial backfill, maintenant: toujours 50
      const afterMessageId = lastProcessed?.discordId || null;
      const limit = 50; // Cohérent avec scraper.js, userClient.js, correspondenceManager.js

      this.logger.info('backfill',
        `🔄 Backfill pour ${mapping.name}: afterId=${afterMessageId || 'none'}, limit=${limit}`
      );

      // Récupérer les messages via l'API
      const userData = this.userClient.getUserData(targetGuildId);
      if (!userData?.token) {
        this.logger.warn('backfill', `❌ Pas de token utilisateur pour ${targetGuildId}`);
        return;
      }

      const messages = await this.userClient.fetchChannelMessages(
        userData.token,
        sourceChannelId,
        limit,
        null, // before
        afterMessageId // after
      );

      if (!messages || messages.length === 0) {
        this.logger.info('backfill', `✅ Aucun message manqué pour ${mapping.name}`);
        return;
      }

      this.logger.info('backfill',
        `📥 ${messages.length} message(s) à récupérer pour ${mapping.name}`
      );

      // Récupérer le scraper pour traiter les messages
      const scraper = this.client.services?.scraper;
      if (!scraper) {
        this.logger.warn('backfill', `❌ Scraper non disponible`);
        return;
      }

      // Récupérer les guilds pour handleEventMessage
      const targetGuild = this.client.guilds.cache.get(targetGuildId);
      const handlers = this.client.services?.userClient?.eventHandlers?.get(targetGuildId);
      const sourceGuild = handlers?.sourceGuild;

      if (!targetGuild || !sourceGuild) {
        this.logger.warn('backfill', `❌ Guilds non disponibles pour backfill`);
        return;
      }

      // Récupérer le canal source pour construire les messages
      const sourceChannel = sourceGuild.channels?.cache?.get(sourceChannelId);
      if (!sourceChannel) {
        this.logger.warn('backfill', `❌ Canal source non trouvé: ${sourceChannelId}`);
        return;
      }

      // Traiter les messages du plus ancien au plus récent
      const sortedMessages = messages.reverse();
      let processed = 0;
      let skipped = 0;

      for (const msg of sortedMessages) {
        // Vérifier si déjà traité
        const existing = await ProcessedMessage.findOne({ discordId: msg.id });
        if (existing) {
          skipped++;
          continue;
        }

        // Délai entre les messages pour éviter le rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));

        try {
          // Construire un objet message compatible avec handleEventMessage
          // Les messages de l'API REST ont une structure différente des messages WebSocket
          const messageObj = {
            id: msg.id,
            content: msg.content || '',
            author: msg.author,
            channel: sourceChannel,
            guild: sourceGuild,
            attachments: new Map(msg.attachments?.map(a => [a.id, a]) || []),
            embeds: msg.embeds || [],
            mentions: {
              users: new Map(msg.mentions?.map(u => [u.id, u]) || []),
              roles: new Map(),
              channels: new Map()
            },
            reference: msg.message_reference || null,
            stickers: new Map(msg.sticker_items?.map(s => [s.id, s]) || []),
            components: msg.components || [],
            createdTimestamp: new Date(msg.timestamp).getTime(),
            type: msg.type || 0
          };

          // Traiter le message via le scraper
          await scraper.handleEventMessage(messageObj, targetGuild, sourceGuild);
          processed++;
        } catch (msgError) {
          this.logger.warn('backfill',
            `⚠️ Erreur traitement message ${msg.id}: ${msgError.message}`
          );
        }
      }

      this.logger.info('backfill',
        `✅ Backfill terminé pour ${mapping.name}: ${processed} traités, ${skipped} ignorés`
      );

      // Logger le backfill
      if (processed > 0) {
        await Log.create({
          type: 'auto-recovery',
          message: `📥 Backfill ${mapping.name}: ${processed} messages récupérés`,
          timestamp: new Date(),
          channelId: mapping.discordId,
          metadata: {
            sourceChannelId,
            processed,
            skipped
          }
        });
      }

    } catch (error) {
      this.logger.error('backfill', `❌ Erreur backfill ${mapping.name}: ${error.message}`, error);
    }
  }

  /**
   * Nettoie les entrées expirées
   */
  cleanup() {
    const now = Date.now();
    const maxAge = 3600000; // 1 heure

    for (const [key, data] of this.recoveryQueue.entries()) {
      if (now - data.firstAttempt > maxAge) {
        this.recoveryQueue.delete(key);
        this.recoveringChannels.delete(key);
      }
    }

    // Nettoyer aussi le cache recentlyRecovered
    for (const [key, data] of this.recentlyRecovered.entries()) {
      if (now - data.timestamp > 5 * 60 * 1000) { // 5 minutes
        this.recentlyRecovered.delete(key);
      }
    }
  }
}

module.exports = AutoRecoveryService;