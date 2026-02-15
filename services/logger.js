const { EmbedBuilder } = require('discord.js');
const Log = require('../models/Log');

class LoggerService {
  constructor(client) {
    this.client = client;
    this.logChannels = new Map(); // Map<guildId, {newroom, error, roles}>
  }

  // Initialiser les salons de log pour une guilde
  async initializeLogChannels(guild) {
    try {
      const channels = {
        newroom: await this.findOrCreateChannel(guild, 'newroom', 'Logs de création/suppression des salons'),
        error: await this.findOrCreateChannel(guild, 'error', 'Logs d\'erreurs du bot'),
        roles: await this.findOrCreateChannel(guild, 'roles-logs', 'Gestion des rôles synchronisés'),
        admin: await this.findOrCreateChannel(guild, 'admin-logs', 'Logs des actions d\'administration et configuration'),
        commands: await this.findOrCreateChannel(guild, 'commands', 'Salon pour les commandes du bot et tests'),
        members: await this.findOrCreateChannel(guild, 'members-log', 'Surveillance des membres (arrivées/départs/modifications)')
      };

      // 🛡️ RESTAURER LES SALONS DE MAINTENANCE SPÉCIAUX (protégés contre suppression auto)
      await this.ensureMaintenanceChannels(guild);

      this.logChannels.set(guild.id, channels);
      return channels;
    } catch (error) {
      console.error('Erreur lors de l\'initialisation des salons de log:', error);
      throw error;
    }
  }

  async findOrCreateChannel(guild, name, topic) {
    let channel = guild.channels.cache.find(c => c.name === name);
    
    if (!channel) {
      // Créer une catégorie "Maintenance" si elle n'existe pas
      let maintenanceCategory = guild.channels.cache.find(c => 
        c.type === 4 && c.name.toLowerCase() === 'maintenance'
      );
      
      if (!maintenanceCategory) {
        maintenanceCategory = await guild.channels.create({
          name: 'Maintenance',
          type: 4 // CategoryChannel
        });
      }

      channel = await guild.channels.create({
        name: name,
        type: 0, // TextChannel
        topic: topic,
        parent: maintenanceCategory.id
      });
    }

    return channel;
  }

  // 🛡️ S'assurer que les salons de maintenance spéciaux existent
  async ensureMaintenanceChannels(guild) {
    try {
      console.log(`🛡️ Vérification des salons de maintenance pour ${guild.name}...`);
      
      // Trouver ou créer la catégorie Maintenance
      let maintenanceCategory = guild.channels.cache.find(c => 
        c.type === 4 && c.name.toLowerCase().includes('maintenance')
      );
      
      if (!maintenanceCategory) {
        console.log(`📁 Catégorie Maintenance non trouvée, recréation...`);
        
        // Permissions strictes pour la catégorie Maintenance : accès limité au rôle ladmin
        const permissionOverwrites = [
          {
            id: guild.roles.everyone.id,
            deny: ['ViewChannel']
          }
        ];
        
        // Ajouter l'accès au rôle ladmin s'il existe
        const adminRole = guild.roles.cache.find(r => r.name === 'ladmin');
        if (adminRole) {
          permissionOverwrites.push({
            id: adminRole.id,
            allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'ManageChannels', 'ManageMessages']
          });
        }
        
        maintenanceCategory = await guild.channels.create({
          name: '🔧 Maintenance',
          type: 4, // CategoryChannel
          permissionOverwrites: permissionOverwrites
        });
        
        console.log(`✅ Catégorie Maintenance créée avec permissions restrictives (ladmin uniquement)`);
      } else {
        // Mettre à jour les permissions de la catégorie existante
        console.log(`📁 Mise à jour des permissions de la catégorie Maintenance...`);
        
        // Supprimer toutes les permissions existantes et les reconfigurer
        await maintenanceCategory.permissionOverwrites.set([
          {
            id: guild.roles.everyone.id,
            deny: ['ViewChannel']
          }
        ]);
        
        // Ajouter l'accès au rôle ladmin s'il existe
        const adminRole = guild.roles.cache.find(r => r.name === 'ladmin');
        if (adminRole) {
          await maintenanceCategory.permissionOverwrites.create(adminRole, {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
            ManageChannels: true,
            ManageMessages: true
          });
        }
        
        console.log(`✅ Permissions de la catégorie Maintenance mises à jour (ladmin uniquement)`);
      }
      
      // Créer le salon mentions-log s'il n'existe pas déjà (tout en haut du serveur)
      const { getNotificationChannelId, updateNotificationChannelId, autoDetectNotificationChannel } = require('../config/notificationChannels');
      const { addProtectedChannelId } = require('../utils/protectedChannels');
      
      let mentionLogsId = getNotificationChannelId(guild.id, 'MENTIONS_LOG');
      let mentionLogsChannel = null;
      
      if (mentionLogsId) {
        mentionLogsChannel = guild.channels.cache.get(mentionLogsId);
      }
      
      if (!mentionLogsChannel) {
        // Tenter l'auto-détection
        mentionLogsId = autoDetectNotificationChannel(guild);
        if (mentionLogsId) {
          mentionLogsChannel = guild.channels.cache.get(mentionLogsId);
        }
      }
      
      if (!mentionLogsChannel) {
        console.log(`🔔 Création du salon mentions-log...`);
        mentionLogsChannel = await guild.channels.create({
          name: 'mentions-log',
          type: 0, // Text channel
          position: 0, // Tout en haut du serveur
          topic: 'Notifications automatiques des mentions de rôles 🔔',
          permissionOverwrites: [
            {
              id: guild.roles.everyone.id,
              allow: ['ViewChannel', 'ReadMessageHistory'],
              deny: ['SendMessages', 'AddReactions']
            }
          ]
        });
        
        // Configurer automatiquement le salon
        updateNotificationChannelId('MENTIONS_LOG', mentionLogsChannel.id, guild.id);
        addProtectedChannelId(mentionLogsChannel.id);
        
        console.log(`✅ Salon mentions-log créé et configuré: #${mentionLogsChannel.name} (${mentionLogsChannel.id})`);
      }

      // Vérifier et recréer le salon chat-staff (EXCEPTION : accès en écriture pour tous)
      let chatStaffChannel = guild.channels.cache.find(c => c.name === 'chat-staff');
      if (!chatStaffChannel) {
        console.log(`🛡️ Salon chat-staff manquant, recréation...`);
        chatStaffChannel = await guild.channels.create({
          name: 'chat-staff',
          type: 0, // TextChannel
          topic: 'Salon de discussion pour le staff - Accès en écriture pour tous - PROTÉGÉ contre suppression automatique',
          parent: maintenanceCategory.id,
          permissionOverwrites: [
            {
              id: guild.roles.everyone.id,
              allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory']
            }
          ]
        });
        
        console.log(`✅ Salon chat-staff recréé avec accès en écriture pour tous`);
      } else {
        // Mettre à jour les permissions du salon existant
        console.log(`🛡️ Mise à jour permissions salon chat-staff...`);
        await chatStaffChannel.permissionOverwrites.set([
          {
            id: guild.roles.everyone.id,
            allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory']
          }
        ]);
        console.log(`✅ Salon chat-staff configuré avec accès en écriture pour tous`);
      }

      // Vérifier et recréer le salon roles (EXCEPTION : accès en lecture pour tous)
      let rolesChannel = guild.channels.cache.find(c => 
        c.name === 'roles' && c.parent?.id === maintenanceCategory.id
      );
      
      if (!rolesChannel) {
        console.log(`🛡️ Salon roles manquant, recréation...`);
        rolesChannel = await guild.channels.create({
          name: 'roles',
          type: 0, // TextChannel
          topic: 'Sélectionnez vos rôles automatiquement - Accès en lecture pour tous - PROTÉGÉ contre suppression automatique',
          parent: maintenanceCategory.id,
          permissionOverwrites: [
            {
              id: guild.roles.everyone.id,
              allow: ['ViewChannel', 'ReadMessageHistory'],
              deny: ['SendMessages', 'AddReactions']
            }
          ]
        });
        
        console.log(`✅ Salon roles recréé avec accès en lecture pour tous`);
      } else {
        // Mettre à jour les permissions du salon existant
        console.log(`🛡️ Mise à jour permissions salon roles...`);
        await rolesChannel.permissionOverwrites.set([
          {
            id: guild.roles.everyone.id,
            allow: ['ViewChannel', 'ReadMessageHistory'],
            deny: ['SendMessages', 'AddReactions']
          }
        ]);
        console.log(`✅ Salon roles configuré avec accès en lecture pour tous`);
      }

      console.log(`🛡️ Vérification des salons de maintenance terminée`);
      
    } catch (error) {
      console.error('❌ Erreur lors de la vérification des salons de maintenance:', error);
    }
  }

  // Logger un nouveau salon avec mention cliquable
  // mirrorChannelId: ID du salon mirror créé (pour mention <#id>)
  async logNewRoom(guildId, channelName, categoryName, mirrorChannelId = null) {
    try {
      // Détecter si channelName est un message riche (contient déjà <# ou des emojis)
      const isRichMessage = channelName.includes('<#') || /[\u{1F300}-\u{1F9FF}]|[\u2600-\u26FF]|[\u2700-\u27BF]|\*\*/u.test(channelName);

      // Si message riche, l'utiliser tel quel. Sinon, construire le message par défaut
      const message = isRichMessage ?
        channelName :
        (mirrorChannelId ?
          `Nouveau salon : <#${mirrorChannelId}> dans la catégorie : ${categoryName}` :
          `Nouveau salon : ${channelName} dans la catégorie : ${categoryName}`);

      await this.log('newroom', guildId, message, mirrorChannelId);
    } catch (error) {
      console.error('Erreur lors du log newroom:', error);
    }
  }

  // Logger une erreur d'accès à un salon privé
  async logPrivateChannelError(guildId, channelName) {
    try {
      const message = `Le compte n'a pas accès au salon distant ${channelName}. Vérifier les droits pour son ajout.`;
      await this.log('newroom', guildId, message);
    } catch (error) {
      console.error('Erreur lors du log salon privé:', error);
    }
  }

  // Logger la suppression d'un salon vers #admin-logs (pas #newroom)
  async logChannelDeleted(guildId, channelName) {
    try {
      const message = `🗑️ **Salon supprimé** (serveur distant) : ${channelName}`;
      await this.log('admin', guildId, message);
    } catch (error) {
      console.error('Erreur lors du log suppression salon:', error);
    }
  }

  // 🆕 Logger la suppression manuelle d'un salon
  async logManualChannelDeletion(guildId, channelName) {
    try {
      const message = `🗑️ **Salon supprimé manuellement :** ${channelName} (marqué pour éviter recréation auto)`;
      await this.log('admin', guildId, message);
    } catch (error) {
      console.error('Erreur lors du log suppression manuelle:', error);
    }
  }

  // 🆕 Logger le nettoyage automatique d'un salon
  async logChannelCleanup(guildId, channelName, reason, deletedMessagesCount = 0) {
    try {
      const message = `🧹 **Salon supprimé automatiquement :** ${channelName}\n` +
        `📊 **Cause :** ${reason}\n` +
        `🗑️ **Base de données :** Nettoyée automatiquement\n` +
        `📨 **Messages associés :** ${deletedMessagesCount} supprimés`;

      await this.logAdminAction(guildId, message);
    } catch (error) {
      console.error('Erreur lors du log nettoyage:', error);
    }
  }

  // 🆕 Logger la suppression d'une catégorie
  async logCategoryDeletion(guildId, categoryName, deletedChannels, deletedFromDB, stoppedIntervals, userTag) {
    try {
      const message = `🗑️ **Catégorie supprimée :** ${categoryName}\n` +
        `📊 **Salons supprimés :** ${deletedChannels}\n` +
        `🧹 **Entrées nettoyées :** ${deletedFromDB}\n` +
        `⏹️ **Intervals arrêtés :** ${stoppedIntervals}\n` +
        `👤 **Action par :** ${userTag}`;

      await this.logAdminAction(guildId, message);
    } catch (error) {
      console.error('Erreur lors du log suppression catégorie:', error);
    }
  }

  // Logger une erreur générale avec debug enrichi
  async logError(guildId, errorMessage, channelName = null, debugInfo = {}) {
    try {
      // 🔍 CONSTRUIRE UN MESSAGE D'ERREUR COMPLET AVEC TOUS LES DÉTAILS
      const timestamp = new Date().toISOString();
      const memoryUsage = process.memoryUsage();
      const uptime = Math.floor(process.uptime());
      
      let message = `🚨 **ERREUR DÉTAILLÉE**\n`;
      message += `⏰ **Timestamp:** ${timestamp}\n`;
      message += `📊 **Uptime:** ${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m\n`;
      message += `💾 **RAM:** ${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB\n\n`;
      
      if (channelName) {
        message += `📺 **Salon:** ${channelName}\n`;
      }
      
      message += `❌ **Erreur:** ${errorMessage}\n\n`;
      
      // 🔍 AJOUTER LES INFORMATIONS DE DEBUG FOURNIES
      if (debugInfo.error && debugInfo.error.stack) {
        message += `📋 **Stack Trace:**\n\`\`\`\n${debugInfo.error.stack.substring(0, 1000)}\n\`\`\`\n\n`;
      }
      
      if (debugInfo.error && debugInfo.error.code) {
        message += `🏷️ **Code erreur:** ${debugInfo.error.code}\n`;
      }
      
      if (debugInfo.error && debugInfo.error.status) {
        message += `📡 **Status HTTP:** ${debugInfo.error.status}\n`;
      }
      
      if (debugInfo.messageId) {
        message += `📨 **Message ID:** ${debugInfo.messageId}\n`;
      }
      
      if (debugInfo.userId) {
        message += `👤 **Utilisateur ID:** ${debugInfo.userId}\n`;
      }
      
      if (debugInfo.channelId) {
        message += `📺 **Channel ID:** ${debugInfo.channelId}\n`;
      }
      
      if (debugInfo.guildId) {
        message += `🏠 **Guild ID:** ${debugInfo.guildId}\n`;
      }
      
      if (debugInfo.requestData) {
        message += `📤 **Données requête:**\n\`\`\`json\n${JSON.stringify(debugInfo.requestData, null, 2).substring(0, 800)}\n\`\`\`\n`;
      }
      
      if (debugInfo.responseData) {
        message += `📥 **Réponse serveur:**\n\`\`\`json\n${JSON.stringify(debugInfo.responseData, null, 2).substring(0, 800)}\n\`\`\`\n`;
      }
      
      if (debugInfo.retryCount) {
        message += `🔄 **Tentatives:** ${debugInfo.retryCount}\n`;
      }
      
      if (debugInfo.lastError) {
        message += `📜 **Erreur précédente:** ${debugInfo.lastError}\n`;
      }
      
      if (debugInfo.systemInfo) {
        message += `⚙️ **Système:**\n`;
        Object.entries(debugInfo.systemInfo).forEach(([key, value]) => {
          message += `   • ${key}: ${value}\n`;
        });
      }
      
      if (debugInfo.configState) {
        message += `🔧 **Configuration:**\n`;
        Object.entries(debugInfo.configState).forEach(([key, value]) => {
          message += `   • ${key}: ${value}\n`;
        });
      }
      
      // 🌐 INFORMATIONS ENVIRONNEMENT (non sensibles)
      message += `\n🌐 **Environnement:**\n`;
      message += `   • Node.js: ${process.version}\n`;
      message += `   • Platform: ${process.platform}\n`;
      message += `   • Arch: ${process.arch}\n`;
      
      // 📊 INFORMATIONS PERFORMANCE
      message += `\n📊 **Performance:**\n`;
      message += `   • CPU Usage: ${Math.round(process.cpuUsage().user / 1000)}ms\n`;
      message += `   • Event Loop Lag: ${debugInfo.eventLoopLag || 'N/A'}\n`;
      
      // 🔍 CONTEXTE APPLICATIF
      if (this.client && this.client.services) {
        const scraperRunning = this.client.services.scraper?.isRunning || false;
        const userTokens = this.client.services.userClient?.getStats()?.totalTokens || 0;
        
        message += `\n🤖 **État Bot:**\n`;
        message += `   • Scraper actif: ${scraperRunning ? '✅' : '❌'}\n`;
        message += `   • Tokens configurés: ${userTokens}\n`;
        message += `   • Guilds connectées: ${this.client.guilds?.cache?.size || 0}\n`;
      }
      
      await this.log('error', guildId, message);
    } catch (error) {
      console.error('❌ Erreur lors du log erreur enrichi:', error);
      // Fallback vers l'ancien système
      try {
        const fallbackMessage = channelName ? 
          `Échec de la récupération des messages du canal ${channelName}. ${errorMessage}` :
          errorMessage;
        await this.log('error', guildId, fallbackMessage);
      } catch (fallbackError) {
        console.error('❌ Fallback log error failed:', fallbackError);
      }
    }
  }

  // 🆕 Logger une erreur critique avec mention @everyone
  async logCriticalError(guildId, errorMessage) {
    try {
      // Récupérer le salon d'erreur
      const channels = this.logChannels.get(guildId);
      if (channels && channels.error) {
        // Envoyer d'abord la mention @everyone séparément
        await channels.error.send(`@everyone`);

        // Puis l'erreur critique avec embed
        const embed = new EmbedBuilder()
          .setColor('#FF0000') // Rouge pour critique
          .setTitle('🚨 ERREUR CRITIQUE')
          .setDescription(errorMessage)
          .setTimestamp();

        await channels.error.send({ embeds: [embed] });
        console.log(`🚨 Erreur critique envoyée avec @everyone pour guild ${guildId}`);
      } else {
        console.error(`❌ Impossible d'envoyer erreur critique: salon error non trouvé pour guild ${guildId}`);
      }

      // Tenter de sauvegarder en base de données (peut échouer si quota atteint)
      try {
        const logEntry = new Log({
          type: 'error',
          message: `CRITIQUE: ${errorMessage}`
        });
        await logEntry.save();
      } catch (dbError) {
        // Si erreur DB (ex: quota), on log en console mais on ne crash pas
        console.error('⚠️ Impossible de sauvegarder erreur critique en DB:', dbError.message);
      }

    } catch (error) {
      console.error('Erreur lors du log erreur critique:', error);
    }
  }

  // Logger les actions de rôles
  async logRoleAction(guildId, message) {
    try {
      await this.log('roles', guildId, message);
    } catch (error) {
      console.error('Erreur lors du log rôle:', error);
    }
  }

  // 🆕 Logger les actions de membres
  async logMemberAction(guildId, message) {
    try {
      await this.log('members', guildId, message);
    } catch (error) {
      console.error('Erreur lors du log membre:', error);
    }
  }

  // 🚀 Logger les erreurs d'auto-start (success messages sont dans index.js)
  async logAutoStart(guild, status, details = {}) {
    try {
      // Ne logger que les erreurs et erreurs critiques
      if (status !== 'error' && status !== 'critical') {
        console.log(`🔕 logAutoStart ignoré pour status: ${status} (seuls error/critical sont logged)`);
        return;
      }

      const channels = this.logChannels.get(guild.id);
      if (!channels || !channels.commands) {
        // Initialiser si pas de channels
        await this.initializeLogChannels(guild);
      }

      const commandsChannel = channels?.commands || guild.channels.cache.find(ch =>
        ch.name === 'commands' || ch.name === 'command' || ch.name === 'commandes'
      );

      if (!commandsChannel) {
        console.error(`❌ Impossible de logger l'auto-start: salon commands introuvable pour ${guild.name}`);
        return;
      }

      let embed;

      switch(status) {
        case 'error':
          embed = new EmbedBuilder()
            .setColor('#FFA500')
            .setTitle('⚠️ Auto-Start Échoué')
            .setDescription(`Le démarrage automatique a échoué après ${details.attempts || 1} tentative(s).`)
            .addFields(
              { name: '❌ Erreur', value: details.error || 'Erreur inconnue', inline: false },
              { name: '🔄 Action requise', value: 'Veuillez exécuter `/start` manuellement', inline: false }
            )
            .setTimestamp();
          break;

        case 'critical':
          embed = new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('🚨 Erreur Critique Auto-Start')
            .setDescription(`Une erreur critique s'est produite lors de l'auto-start.`)
            .addFields(
              { name: '💥 Erreur', value: details.error || 'Erreur critique', inline: false },
              { name: '📜 Stack', value: `\`\`\`${(details.stack || 'N/A').substring(0, 500)}\`\`\``, inline: false }
            )
            .setTimestamp();
          break;

        default:
          console.warn(`⚠️ logAutoStart appelé avec status inconnu: ${status}`);
          return;
      }

      await commandsChannel.send({ embeds: [embed] });

      // Sauvegarder en base de données
      const logEntry = new Log({
        type: 'auto-start',
        message: `Auto-start [${status}] pour ${guild.name}: ${JSON.stringify(details)}`
      });
      await logEntry.save();

    } catch (error) {
      console.error(`❌ Erreur lors du log auto-start pour ${guild.name}:`, error);
    }
  }

  // 🆕 Logger l'arrivée d'un membre
  async logMemberJoin(guildId, member, serverName) {
    try {
      const message = `👋 **Nouveau membre arrivé**\n` +
        `👤 **Utilisateur :** ${member.user.tag} (${member.user.id})\n` +
        `📅 **Compte créé :** <t:${Math.floor(member.user.createdTimestamp / 1000)}:F>\n` +
        `🏠 **Serveur :** ${serverName}`;
      
      await this.logMemberAction(guildId, message);
    } catch (error) {
      console.error('Erreur lors du log arrivée membre:', error);
    }
  }

  // 🆕 Logger le départ d'un membre
  async logMemberLeave(guildId, member, serverName) {
    try {
      const message = `👋 **Membre parti**\n` +
        `👤 **Utilisateur :** ${member.user.tag} (${member.user.id})\n` +
        `⏰ **Temps sur le serveur :** <t:${Math.floor(member.joinedTimestamp / 1000)}:R>\n` +
        `🏠 **Serveur :** ${serverName}`;
      
      await this.logMemberAction(guildId, message);
    } catch (error) {
      console.error('Erreur lors du log départ membre:', error);
    }
  }

  // 🆕 Logger la modification d'un membre  
  async logMemberUpdate(guildId, oldMember, newMember, serverName) {
    try {
      const changes = [];
      
      // Changement de pseudo
      if (oldMember.nickname !== newMember.nickname) {
        const oldNick = oldMember.nickname || oldMember.user.username;
        const newNick = newMember.nickname || newMember.user.username;
        changes.push(`📝 **Pseudo :** ${oldNick} → ${newNick}`);
      }
      
      // Changement de rôles
      const oldRoles = oldMember.roles.cache;
      const newRoles = newMember.roles.cache;
      
      const addedRoles = newRoles.filter(role => !oldRoles.has(role.id) && role.name !== '@everyone');
      const removedRoles = oldRoles.filter(role => !newRoles.has(role.id) && role.name !== '@everyone');
      
      if (addedRoles.size > 0) {
        changes.push(`➕ **Rôles ajoutés :** ${addedRoles.map(r => r.name).join(', ')}`);
      }
      
      if (removedRoles.size > 0) {
        changes.push(`➖ **Rôles retirés :** ${removedRoles.map(r => r.name).join(', ')}`);
      }
      
      if (changes.length > 0) {
        const message = `🔄 **Membre modifié**\n` +
          `👤 **Utilisateur :** ${newMember.user.tag} (${newMember.user.id})\n` +
          `🏠 **Serveur :** ${serverName}\n\n` +
          `**Changements :**\n${changes.join('\n')}`;
        
        await this.logMemberAction(guildId, message);
      }
    } catch (error) {
      console.error('Erreur lors du log modification membre:', error);
    }
  }

  // Logger les actions d'administration
  async logAdminAction(guildId, message) {
    await this.log('admin', guildId, message);
  }

  // 📊 NOUVEAU : Logger le tracking des membres avec historique
  async logMemberCount(guildId, memberData, changes = {}) {
    try {
      const guild = this.client.guilds.cache.get(guildId);
      if (!guild) return;

      const membersChannel = await this.findOrCreateChannel(guild, 'members-log', 'Logs de surveillance des membres');
      if (!membersChannel) return;

      const { EmbedBuilder } = require('discord.js');
      
      // Construire l'embed avec les données
      const embed = new EmbedBuilder()
        .setTitle(`📊 Surveillance Membres - ${memberData.guildName}`)
        .setColor(0x3498db)
        .setTimestamp(memberData.timestamp)
        .setFooter({ text: 'Tracking automatique quotidien' });

      // Informations principales
      embed.addFields({
        name: '👥 Membres Total',
        value: `**${memberData.totalMembers.toLocaleString()}** membres`,
        inline: true
      });

      embed.addFields({
        name: '🟢 En Ligne',
        value: `**${memberData.onlineMembers.toLocaleString()}** membres`,
        inline: true
      });

      const onlinePercent = memberData.totalMembers > 0 ? 
        Math.round((memberData.onlineMembers / memberData.totalMembers) * 100) : 0;
      
      embed.addFields({
        name: '📈 Taux Activité',
        value: `**${onlinePercent}%** en ligne`,
        inline: true
      });

      // Évolutions (si disponibles)
      if (Object.keys(changes).length > 0) {
        let evolutionText = '';
        
        if (changes.daily !== undefined) {
          const dailyIcon = changes.daily >= 0 ? '📈' : '📉';
          const dailySign = changes.daily >= 0 ? '+' : '';
          evolutionText += `${dailyIcon} **${dailySign}${changes.daily}** depuis hier\n`;
        }
        
        if (changes.weekly !== undefined) {
          const weeklyIcon = changes.weekly >= 0 ? '📊' : '📉';
          const weeklySign = changes.weekly >= 0 ? '+' : '';
          evolutionText += `${weeklyIcon} **${weeklySign}${changes.weekly}** depuis 7 jours\n`;
        }
        
        if (changes.monthly !== undefined) {
          const monthlyIcon = changes.monthly >= 0 ? '🚀' : '📉';
          const monthlySign = changes.monthly >= 0 ? '+' : '';
          evolutionText += `${monthlyIcon} **${monthlySign}${changes.monthly}** depuis 30 jours`;
        }

        if (evolutionText) {
          embed.addFields({
            name: '📈 Évolution',
            value: evolutionText,
            inline: false
          });
        }
      }

      // Analyse rapide
      let analysisText = '';
      if (changes.daily !== undefined) {
        if (changes.daily > 10) {
          analysisText = '🔥 **Forte croissance** quotidienne !';
        } else if (changes.daily > 0) {
          analysisText = '✅ **Croissance positive** quotidienne';
        } else if (changes.daily === 0) {
          analysisText = '➖ **Stable** depuis hier';
        } else {
          analysisText = '⚠️ **Perte de membres** depuis hier';
        }
      }

      if (analysisText) {
        embed.addFields({
          name: '🎯 Analyse',
          value: analysisText,
          inline: false
        });
      }

      await membersChannel.send({ embeds: [embed] });
      console.log(`📊 Member count loggé pour ${memberData.guildName}: ${memberData.totalMembers} membres`);

    } catch (error) {
      console.error(`❌ Erreur log member count:`, error);
    }
  }

  // 📊 NOUVEAU : Logger les erreurs de tracking des membres
  async logMemberCountError(guildId, guildName, error) {
    try {
      const guild = this.client.guilds.cache.get(guildId);
      if (!guild) return;

      const membersChannel = await this.findOrCreateChannel(guild, 'members-log', 'Logs de surveillance des membres');
      if (!membersChannel) return;

      const { EmbedBuilder } = require('discord.js');
      
      const embed = new EmbedBuilder()
        .setTitle(`❌ Erreur Surveillance Membres`)
        .setColor(0xe74c3c)
        .setTimestamp()
        .addFields({
          name: '🎯 Serveur Cible',
          value: guildName || 'Serveur inconnu',
          inline: true
        })
        .addFields({
          name: '❌ Erreur',
          value: error.message || 'Erreur inconnue',
          inline: false
        })
        .setFooter({ text: 'Prochaine tentative dans 24h' });

      await membersChannel.send({ embeds: [embed] });
      console.log(`❌ Erreur member count loggée pour ${guildName}`);

    } catch (logError) {
      console.error(`❌ Erreur lors du log d'erreur member count:`, logError);
    }
  }

  // 🆕 Logger les mentions de rôles dans le salon dédié
  async logRoleMention(guildId, mentionData) {
    try {
      const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
      const { getNotificationChannelId } = require('../config/notificationChannels');
      
      // Récupérer le salon mentions-logs via la configuration centralisée
      const guild = this.client.guilds.cache.get(guildId);
      if (!guild) return;
      
      const notificationChannelId = getNotificationChannelId(guildId, 'MENTIONS_LOG');
      if (!notificationChannelId) {
        console.log('⚠️ Aucun salon de notifications configuré');
        return;
      }
      
      const mentionsChannel = guild.channels.cache.get(notificationChannelId);
      if (!mentionsChannel) {
        console.log(`⚠️ Salon mentions-logs (${notificationChannelId}) non trouvé`);
        return;
      }

      // Construire l'embed avec les informations de la mention
      const embed = new EmbedBuilder()
        .setColor('#FF6B6B')
        .setTitle('🔔 Mention de rôle détectée')
        .setDescription(`**Message dans #${mentionData.channelName}**\n\n${mentionData.messageContent}`)
        .addFields([
          {
            name: '👤 Auteur',
            value: `${mentionData.authorTag}`,
            inline: true
          },
          {
            name: '🎭 Rôles mentionnés',
            value: mentionData.mentionedRoles.map(role => `<@&${role.roleId}> (${role.roleName})`).join('\n'),
            inline: true
          },
          {
            name: '📺 Salon',
            value: `#${mentionData.channelName}`,
            inline: true
          }
        ])
        .setTimestamp(mentionData.messageTimestamp);

      // Créer le bouton "Y aller" avec le lien vers le message mirror
      const actionRow = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setLabel('Y aller')
            .setStyle(ButtonStyle.Link)
            .setURL(`https://discord.com/channels/${mentionData.mirrorGuildId}/${mentionData.mirrorChannelId}/${mentionData.mirrorMessageId}`)
            .setEmoji('🔗')
        );

      // Envoyer dans le salon mentions-logs
      await mentionsChannel.send({
        embeds: [embed],
        components: [actionRow]
      });

      console.log(`✅ Mention de rôle loggée dans #mentions-logs pour ${mentionData.authorTag}`);
      
    } catch (error) {
      console.error('❌ Erreur lors du log mention de rôle:', error);
    }
  }

  // Méthode générale de logging
  async log(type, guildId, message, channelId = null) {
    try {
      // Sauvegarder en base de données
      const logEntry = new Log({
        type,
        message,
        channelId
      });
      await logEntry.save();

      // Envoyer le message dans le salon Discord approprié
      const channels = this.logChannels.get(guildId);
      if (channels && channels[type]) {
        const embed = new EmbedBuilder()
          .setColor(this.getColorForType(type))
          .setDescription(message)
          .setTimestamp();

        await channels[type].send({ embeds: [embed] });
      }
    } catch (error) {
      console.error(`Erreur lors du logging ${type}:`, error);
    }
  }

  getColorForType(type) {
    switch (type) {
      case 'newroom': return '#00FF00'; // Vert
      case 'error': return '#FF0000'; // Rouge
      case 'roles': return '#0099FF'; // Bleu
      case 'admin': return '#FF9900'; // Orange
      case 'members': return '#9B59B6'; // Violet
      default: return '#FFFFFF'; // Blanc
    }
  }

  // Récupérer les logs depuis la base de données
  async getLogs(type = null, limit = 50) {
    try {
      const query = type ? { type } : {};
      return await Log.find(query)
        .sort({ timestamp: -1 })
        .limit(limit);
    } catch (error) {
      console.error('Erreur lors de la récupération des logs:', error);
      return [];
    }
  }

  // Nettoyer les anciens logs (plus de 30 jours)
  async cleanupOldLogs() {
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const result = await Log.deleteMany({ timestamp: { $lt: thirtyDaysAgo } });
      console.log(`${result.deletedCount} anciens logs supprimés`);
    } catch (error) {
      console.error('Erreur lors du nettoyage des logs:', error);
    }
  }

  // 🔍 FONCTION UTILITAIRE POUR COLLECTER AUTOMATIQUEMENT LES INFOS DE DEBUG
  static getStandardDebugInfo(context = {}) {
    const debugInfo = {
      timestamp: new Date().toISOString(),
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      uptime: Math.floor(process.uptime()),
      memory: {
        heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        external: Math.round(process.memoryUsage().external / 1024 / 1024),
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024)
      },
      cpu: {
        user: Math.round(process.cpuUsage().user / 1000),
        system: Math.round(process.cpuUsage().system / 1000)
      },
      pid: process.pid,
      ...context
    };

    return debugInfo;
  }

  // 🚨 FONCTION RAPIDE POUR LOG D'ERREUR ENRICHI (raccourci)
  async logErrorEnriched(guildId, errorMessage, channelName, error, extraInfo = {}) {
    const debugInfo = {
      error: error,
      ...LoggerService.getStandardDebugInfo(),
      ...extraInfo
    };

    await this.logError(guildId, errorMessage, channelName, debugInfo);
  }
}

module.exports = LoggerService; 