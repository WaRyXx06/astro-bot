const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getNotificationChannelId, autoDetectNotificationChannel } = require('../config/notificationChannels');

/**
 * Service pour gérer les notifications de mentions avec embeds et boutons "Y aller"
 * Ce système remplace la logique complexe dans scraper.js pour une approche plus simple
 */
class MentionNotifierService {
  constructor(client, logger) {
    this.client = client;
    this.logger = logger;
    this.correspondenceManager = null; // Sera initialisé plus tard

    // Cache pour éviter les notifications dupliquées
    this.recentNotifications = new Map();
    this.DEDUP_WINDOW_MS = 60000; // 60 secondes

    // 🧹 Cleanup des notifications expirées toutes les 5 minutes
    // Prévient l'accumulation mémoire sur longue durée
    this.cleanupInterval = setInterval(() => {
      try {
        const now = Date.now();
        let cleaned = 0;
        for (const [key, timestamp] of this.recentNotifications.entries()) {
          // Supprimer les entrées plus vieilles que 2x la fenêtre de déduplication
          if (now - timestamp > this.DEDUP_WINDOW_MS * 2) {
            this.recentNotifications.delete(key);
            cleaned++;
          }
        }
        if (cleaned > 0) {
          console.log(`🧹 MentionNotifier: ${cleaned} notifications expirées nettoyées`);
        }
      } catch (error) {
        console.error('❌ Erreur dans cleanup MentionNotifier:', error.message);
      }
    }, 5 * 60 * 1000); // 5 minutes
  }

  /**
   * Initialiser le service avec le gestionnaire de correspondances
   */
  initialize(correspondenceManager) {
    this.correspondenceManager = correspondenceManager;
  }

  /**
   * Obtenir l'ID du salon de notifications pour un serveur
   * @param {string} guildId - ID du serveur Discord
   * @param {string} channelType - Type de salon (MENTIONS_LOG par défaut)
   * @returns {string|null} - ID du salon de notifications
   */
  getNotificationChannelForGuild(guildId, channelType = 'MENTIONS_LOG') {
    try {
      // 1. Essayer la configuration centralisée
      const configuredId = getNotificationChannelId(guildId, channelType);
      if (configuredId) {
        return configuredId;
      }

      // 2. Auto-détection si pas configuré
      const guild = this.client.guilds.cache.get(guildId);
      if (guild) {
        const autoDetectedId = autoDetectNotificationChannel(guild);
        if (autoDetectedId) {
          return autoDetectedId;
        }
      }

      console.warn(`⚠️ Aucun salon de notifications trouvé pour le serveur ${guildId}`);
      return null;
    } catch (error) {
      console.error('❌ Erreur récupération salon de notifications:', error);
      return null;
    }
  }

  /**
   * Créer un embed de notification pour un ping de rôle
   * @param {Object} mentionData - Données de la mention
   * @param {string} mentionData.channelName - Nom du salon où a eu lieu le ping
   * @param {string} mentionData.channelId - ID du salon source
   * @param {string} mentionData.roleName - Nom du rôle mentionné
   * @param {string} mentionData.userId - ID de l'utilisateur qui a fait le ping
   * @param {string} mentionData.username - Nom de l'utilisateur qui a fait le ping
   * @param {string} mentionData.messageId - ID du message original
   * @param {string} targetGuildId - ID du serveur mirror
   * @returns {Object} - Embed et composants
   */
  async createMentionEmbed(mentionData, targetGuildId) {
    try {
      const { channelName, channelId, roleName, userId, username, messageId } = mentionData;

      // 🔍 RÉSOLUTION AMÉLIORÉE DU NOM DU SALON
      let resolvedChannelName = channelName || 'salon-inconnu';
      let mirrorChannelId = null;

      // Trouver le salon mirror correspondant et résoudre le nom
      mirrorChannelId = await this.findMirrorChannel(channelId, targetGuildId, channelName);
      
      if (mirrorChannelId) {
        // Utiliser le salon mirror pour afficher le nom
        const targetGuild = this.client.guilds.cache.get(targetGuildId);
        const mirrorChannel = targetGuild?.channels.cache.get(mirrorChannelId);
        if (mirrorChannel) {
          resolvedChannelName = mirrorChannel.name;
        }
      } else {
        // Fallback: Essayer de récupérer le nom du salon source via correspondanceManager
        if (this.correspondenceManager && channelId) {
          try {
            const sourceGuildId = this.getSourceGuildId(targetGuildId);
            if (sourceGuildId && this.client.services?.userClient?.hasUserToken?.(targetGuildId)) {
              const userData = this.client.services.userClient.getUserData(targetGuildId);
              if (userData?.token) {
                // Récupérer le nom du salon source via API
                const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
                const response = await fetch(`https://discord.com/api/v10/channels/${channelId}`, {
                  headers: {
                    'Authorization': userData.token,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                  }
                });
                
                if (response.ok) {
                  const channelData = await response.json();
                  if (channelData.name) {
                    resolvedChannelName = channelData.name;
                  }
                }
              }
            }
          } catch (resolveError) {
          }
        }
      }

      // Créer l'embed avec le nom résolu
      const embed = new EmbedBuilder()
        .setTitle('🔔 Mention de rôle détectée')
        .setColor(0xFF6B35)
        .addFields(
          {
            name: '📺 Channel',
            value: mirrorChannelId ? `<#${mirrorChannelId}>` : `⁠#${resolvedChannelName}`,
            inline: true
          },
          {
            name: '🎭 Rôle tagué',
            value: `@${roleName}`,
            inline: true
          },
          {
            name: '👤 De (utilisateur)',
            value: `${username}`,
            inline: true
          }
        )
        .setTimestamp()
        .setFooter({ text: 'Système de notification' });

      let components = [];
      if (mirrorChannelId) {
        // Créer le bouton "Y aller" avec lien direct vers le message
        const button = new ButtonBuilder()
          .setLabel('📍 Y aller')
          .setStyle(ButtonStyle.Link)
          .setURL(`https://discord.com/channels/${targetGuildId}/${mirrorChannelId}/${messageId}`);

        const row = new ActionRowBuilder().addComponents(button);
        components = [row];
      } else {
        // Si pas de salon mirror trouvé, ajouter une note dans l'embed
        embed.addFields({
          name: '⚠️ Information',
          value: 'Salon mirror non trouvé pour cette mention',
          inline: false
        });
      }

      return { embed, components };

    } catch (error) {
      console.error('❌ Erreur création embed mention:', error);
      throw error;
    }
  }

  /**
   * Envoyer une notification de mention dans un salon spécifique
   * @param {Object} mentionData - Données de la mention
   * @param {string} targetChannelId - ID du salon où envoyer la notification
   * @param {string} targetGuildId - ID du serveur mirror
   */
  async sendMentionNotification(mentionData, targetChannelId, targetGuildId) {
    try {
      // Vérifier les doublons avant d'envoyer
      const dedupKey = `${mentionData.channelId}-${mentionData.roleName}-${mentionData.userId}`;
      const now = Date.now();

      // Vérifier si cette notification a été envoyée récemment
      if (this.recentNotifications.has(dedupKey)) {
        const lastSent = this.recentNotifications.get(dedupKey);
        if (now - lastSent < this.DEDUP_WINDOW_MS) {
          return;
        }
      }

      // Enregistrer cette notification
      this.recentNotifications.set(dedupKey, now);

      // Nettoyer les anciennes entrées si le cache devient trop grand
      if (this.recentNotifications.size > 100) {
        for (const [key, timestamp] of this.recentNotifications) {
          if (now - timestamp > this.DEDUP_WINDOW_MS) {
            this.recentNotifications.delete(key);
          }
        }
      }

      const targetGuild = this.client.guilds.cache.get(targetGuildId);
      if (!targetGuild) {
        console.error(`❌ Serveur mirror non trouvé: ${targetGuildId}`);
        return;
      }

      const targetChannel = targetGuild.channels.cache.get(targetChannelId);
      if (!targetChannel) {
        console.error(`❌ Salon de notification non trouvé: ${targetChannelId}`);
        return;
      }

      // Créer l'embed et les composants
      const { embed, components } = await this.createMentionEmbed(mentionData, targetGuildId);

      // Envoyer le message (pas via webhook pour éviter les problèmes d'édition)
      const sentMessage = await targetChannel.send({
        embeds: [embed],
        components: components
      });

      return sentMessage;

    } catch (error) {
      console.error('❌ Erreur envoi notification mention:', error);
      throw error;
    }
  }

  /**
   * Trouver le salon mirror correspondant à un salon source
   * @param {string} sourceChannelId - ID du salon source
   * @param {string} targetGuildId - ID du serveur mirror
   * @param {string} channelName - Nom du salon (fallback)
   * @returns {string|null} - ID du salon mirror ou null
   */
  async findMirrorChannel(sourceChannelId, targetGuildId, channelName) {
    try {
      const targetGuild = this.client.guilds.cache.get(targetGuildId);
      if (!targetGuild) {
        return null;
      }

      // Méthode 1: Chercher par correspondance en base de données via correspondenceManager
      if (this.correspondenceManager) {
        const sourceGuildId = this.getSourceGuildId(targetGuildId);
        if (sourceGuildId) {
          try {
            const mirrorChannelId = await this.correspondenceManager.getMirrorChannelId(
              sourceChannelId, 
              sourceGuildId,
              targetGuildId
            );
            if (mirrorChannelId) {
              // Vérifier que le salon existe encore
              const mirrorChannel = targetGuild.channels.cache.get(mirrorChannelId);
              if (mirrorChannel) {
                return mirrorChannelId;
              } else {
              }
            }
          } catch (cmError) {
          }
        }
      }

      // Méthode 2: Chercher par nom de salon si on a le nom
      if (channelName && channelName !== 'salon-inconnu') {
        const mirrorChannel = targetGuild.channels.cache.find(ch => 
          ch.name === channelName && (ch.type === 0 || ch.type === 2 || ch.type === 15) // TEXT, VOICE, FORUM
        );
        if (mirrorChannel) {
          
          // Enregistrer cette correspondance pour les prochaines fois
          if (this.correspondenceManager) {
            try {
              const sourceGuildId = this.getSourceGuildId(targetGuildId);
              if (sourceGuildId) {
                await this.correspondenceManager.registerChannelMapping(
                  sourceChannelId,
                  sourceGuildId,
                  channelName,
                  mirrorChannel.id
                );
              }
            } catch (registerError) {
            }
          }
          
          return mirrorChannel.id;
        }
      }

      // Méthode 3: Récupérer le nom du salon source via API et chercher par nom
      if (this.client.services?.userClient?.hasUserToken?.(targetGuildId)) {
        try {
          const userData = this.client.services.userClient.getUserData(targetGuildId);
          if (userData?.token) {
            const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
            const response = await fetch(`https://discord.com/api/v10/channels/${sourceChannelId}`, {
              headers: {
                'Authorization': userData.token,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
              }
            });
            
            if (response.ok) {
              const sourceChannelData = await response.json();
              if (sourceChannelData.name) {
                const mirrorChannel = targetGuild.channels.cache.find(ch => 
                  ch.name === sourceChannelData.name && (ch.type === 0 || ch.type === 2 || ch.type === 15)
                );
                if (mirrorChannel) {
                  
                  // Enregistrer cette correspondance
                  if (this.correspondenceManager) {
                    try {
                      const sourceGuildId = this.getSourceGuildId(targetGuildId);
                      if (sourceGuildId) {
                        await this.correspondenceManager.registerChannelMapping(
                          sourceChannelId,
                          sourceGuildId,
                          sourceChannelData.name,
                          mirrorChannel.id
                        );
                      }
                    } catch (registerError) {
                    }
                  }
                  
                  return mirrorChannel.id;
                }
              }
            }
          }
        } catch (apiError) {
        }
      }

      console.log(`❌ Aucun salon mirror trouvé pour ${sourceChannelId} (nom: ${channelName})`);
      return null;

    } catch (error) {
      console.error('❌ Erreur recherche salon mirror:', error);
      return null;
    }
  }

  /**
   * Obtenir l'ID du serveur source à partir du serveur mirror
   * @param {string} targetGuildId - ID du serveur mirror
   * @returns {string|null} - ID du serveur source
   */
  getSourceGuildId(targetGuildId) {
    try {
      if (this.client.services?.userClient?.hasUserToken?.(targetGuildId)) {
        const sourceGuild = this.client.services.userClient.getSourceGuild?.(targetGuildId);
        return sourceGuild ? sourceGuild.id : null;
      }
      return null;
    } catch (error) {
      console.error('❌ Erreur getSourceGuildId:', error);
      return null;
    }
  }

  /**
   * Traiter un message pour détecter les mentions de rôles et créer des notifications
   * @param {Object} sourceMessage - Message source Discord
   * @param {Object} targetChannel - Salon mirror où le message a été envoyé
   * @param {string} targetGuildId - ID du serveur mirror
   * @param {string} notificationChannelId - ID du salon où envoyer les notifications (optionnel)
   */
  async processMessageForMentions(sourceMessage, targetChannel, targetGuildId, notificationChannelId = null) {
    try {
      // Vérifier s'il y a des mentions de rôles
      if (!sourceMessage.mentions || !sourceMessage.mentions.roles || sourceMessage.mentions.roles.size === 0) {
        return;
      }

      // Si pas de salon de notification spécifié, utiliser la configuration automatique
      if (!notificationChannelId) {
        notificationChannelId = this.getNotificationChannelForGuild(targetGuildId);
        if (!notificationChannelId) {
          console.warn('⚠️ Aucun salon de notifications configuré - mentions ignorées');
          return;
        }
      }

      const sourceGuild = sourceMessage.guild;
      
      // Traiter chaque rôle mentionné
      for (const [roleId, role] of sourceMessage.mentions.roles) {
        const mentionData = {
          channelName: sourceMessage.channel.name,
          channelId: sourceMessage.channel.id,
          roleName: role.name,
          userId: sourceMessage.author.id,
          username: sourceMessage.author.username,
          messageId: targetChannel.lastMessageId, // ID du message mirror
        };

        // Envoyer la notification
        await this.sendMentionNotification(mentionData, notificationChannelId, targetGuildId);
      }

    } catch (error) {
      console.error('❌ Erreur traitement mentions:', error);
    }
  }

  /**
   * Traitement automatique des mentions avec configuration centralisée
   * @param {Object} sourceMessage - Message source Discord
   * @param {Object} targetChannel - Salon mirror où le message a été envoyé
   * @param {string} targetGuildId - ID du serveur mirror
   * @param {string} mirrorMessageId - ID du message mirror envoyé
   */
  async processMessageMentionsAuto(sourceMessage, targetChannel, targetGuildId, mirrorMessageId) {
    try {
      // Vérifier s'il y a des mentions de rôles
      if (!sourceMessage.mentions || !sourceMessage.mentions.roles || sourceMessage.mentions.roles.size === 0) {
        return;
      }

      // Obtenir automatiquement le salon de notifications configuré
      const notificationChannelId = this.getNotificationChannelForGuild(targetGuildId);
      if (!notificationChannelId) {
        console.warn(`⚠️ Aucun salon de notifications configuré pour ${targetGuildId} - mentions ignorées`);
        return;
      }

      console.log(`🔔 ${sourceMessage.mentions.roles.size} mention(s) de rôle détectée(s) dans #${sourceMessage.channel.name}`);
      
      // Traiter chaque rôle mentionné
      for (const [roleId, role] of sourceMessage.mentions.roles) {
        const mentionData = {
          channelName: sourceMessage.channel.name,
          channelId: sourceMessage.channel.id,
          roleName: role.name,
          userId: sourceMessage.author.id,
          username: sourceMessage.author.username,
          messageId: mirrorMessageId, // ID du message mirror exact
        };

        // Envoyer la notification avec protection d'erreur
        try {
          await this.sendMentionNotification(mentionData, notificationChannelId, targetGuildId);
          console.log(`✅ Notification envoyée: @${role.name} par ${sourceMessage.author.username}`);
        } catch (notifError) {
          console.error(`❌ Erreur notification pour @${role.name}:`, notifError.message);
        }
      }

    } catch (error) {
      console.error('❌ Erreur traitement mentions automatique:', error);
    }
  }

  /**
   * Créer un embed de test pour vérifier le système
   * @param {string} targetChannelId - ID du salon de test
   * @param {string} targetGuildId - ID du serveur mirror
   */
  async sendTestNotification(targetChannelId, targetGuildId) {
    try {
      const testData = {
        channelName: 'test-channel',
        channelId: '123456789',
        roleName: 'Random Resell',
        userId: '987654321',
        username: 'TestUser',
        messageId: '111222333'
      };

      await this.sendMentionNotification(testData, targetChannelId, targetGuildId);
      console.log('✅ Notification de test envoyée');

    } catch (error) {
      console.error('❌ Erreur notification de test:', error);
      throw error;
    }
  }
}

module.exports = MentionNotifierService; 