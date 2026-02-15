/**
 * 📊 SERVICE DE TRACKING DES MEMBRES
 * 
 * Surveillance automatique de l'évolution du nombre de membres
 * sur les serveurs sources (concurrence)
 */

class MemberTrackerService {
  constructor(client, logger) {
    this.client = client;
    this.logger = logger;
  }

  /**
   * 📊 Tracker le nombre de membres d'un serveur et sauvegarder l'historique
   */
  async trackServerMembers(targetGuildId) {
    try {
      // Vérifier si le serveur a une configuration
      if (!this.client.services.userClient.hasUserToken(targetGuildId)) {
        return null;
      }

      const userData = this.client.services.userClient.getUserData(targetGuildId);
      const sourceGuild = this.client.services.userClient.getSourceGuild(targetGuildId);


      // Récupérer le count actuel
      const memberData = await this.client.services.userClient.fetchGuildMemberCount(
        userData.token, 
        sourceGuild.id
      );

      // Calculer les évolutions par rapport à l'historique
      const changes = await this.calculateChanges(sourceGuild.id, memberData);

      // Sauvegarder en base de données
      await this.saveMemberCount(sourceGuild.id, memberData, changes);

      // Logger dans #members-log
      await this.logger.logMemberCount(targetGuildId, memberData, changes);


      return {
        memberData,
        changes,
        success: true
      };

    } catch (error) {
      console.error(`❌ Erreur tracking membres pour ${targetGuildId}:`, error);

      // Logger l'erreur
      try {
        const sourceGuild = this.client.services.userClient.getSourceGuild(targetGuildId);
        const guildName = sourceGuild?.name || 'Serveur inconnu';

        // Détecter les erreurs de quota MongoDB (critiques)
        const isQuotaError = error.message?.includes('over your space quota') ||
                            error.message?.includes('quota exceeded') ||
                            error.message?.includes('disk quota');

        if (isQuotaError) {
          // Notification critique avec @everyone dans #error
          await this.logger.logCriticalError(targetGuildId,
            `**QUOTA MONGODB ATTEINT**\n\n` +
            `🎯 **Serveur:** ${guildName}\n` +
            `❌ **Erreur:** ${error.message}\n\n` +
            `🔧 **Actions immédiates requises:**\n` +
            `• Exécuter \`/purge-logs\` pour libérer de l'espace\n` +
            `• Vérifier la taille de la base de données\n` +
            `• Supprimer les données obsolètes si nécessaire\n\n` +
            `⏱️ Prochaine tentative dans 24h`
          );
        } else {
          // Erreur normale dans #members-log
          await this.logger.logMemberCountError(targetGuildId, guildName, error);
        }
      } catch (logError) {
        console.error('❌ Erreur lors du log d\'erreur:', logError);
      }

      return {
        error: error.message,
        success: false
      };
    }
  }

  /**
   * 📈 Calculer les évolutions par rapport aux counts précédents
   */
  async calculateChanges(sourceGuildId, currentData) {
    try {
      const MemberCount = require('../models/MemberCount');

      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      // Récupérer les counts de référence
      const [dailyRef, weeklyRef, monthlyRef] = await Promise.all([
        MemberCount.findOne({ 
          guildId: sourceGuildId, 
          timestamp: { $lte: yesterday } 
        }).sort({ timestamp: -1 }),
        
        MemberCount.findOne({ 
          guildId: sourceGuildId, 
          timestamp: { $lte: weekAgo } 
        }).sort({ timestamp: -1 }),
        
        MemberCount.findOne({ 
          guildId: sourceGuildId, 
          timestamp: { $lte: monthAgo } 
        }).sort({ timestamp: -1 })
      ]);

      const changes = {};

      // Calculer les différences
      if (dailyRef) {
        changes.daily = currentData.totalMembers - dailyRef.totalMembers;
      }

      if (weeklyRef) {
        changes.weekly = currentData.totalMembers - weeklyRef.totalMembers;
      }

      if (monthlyRef) {
        changes.monthly = currentData.totalMembers - monthlyRef.totalMembers;
      }

      return changes;

    } catch (error) {
      console.error('❌ Erreur calcul des changements:', error);
      return {};
    }
  }

  /**
   * 💾 Sauvegarder le count en base de données
   */
  async saveMemberCount(sourceGuildId, memberData, changes) {
    try {
      const MemberCount = require('../models/MemberCount');

      const memberCount = new MemberCount({
        guildId: sourceGuildId,
        guildName: memberData.guildName,
        totalMembers: memberData.totalMembers,
        onlineMembers: memberData.onlineMembers,
        timestamp: memberData.timestamp,
        dailyChange: changes.daily || 0,
        weeklyChange: changes.weekly || 0,
        monthlyChange: changes.monthly || 0
      });

      await memberCount.save();


    } catch (error) {
      console.error('❌ Erreur sauvegarde member count:', error);
      throw error;
    }
  }

  /**
   * 📋 Récupérer la liste détaillée des membres d'un serveur
   */
  async fetchDetailedMemberList(targetGuildId) {
    try {
      if (!this.client.services.userClient.hasUserToken(targetGuildId)) {
        return [];
      }

      const sourceGuild = this.client.services.userClient.getSourceGuild(targetGuildId);
      const userData = this.client.services.userClient.getUserData(targetGuildId);
      const MemberDetail = require('../models/MemberDetail');


      // Vérifier le cache (1 heure)
      const lastFetch = await MemberDetail.findOne({
        guildId: sourceGuild.id,
        lastFetched: { $gte: new Date(Date.now() - 60 * 60 * 1000) }
      });

      if (lastFetch) {
        const cachedMembers = await MemberDetail.find({
          guildId: sourceGuild.id,
          isPresent: true
        });
        return cachedMembers;
      }

      // Utiliser le nouvel endpoint search pour récupérer les membres
      const members = await this.client.services.userClient.fetchGuildMembers(
        userData.token,
        sourceGuild.id,
        10000,  // Limite de 10000 membres
        targetGuildId  // Passer le targetGuildId pour WebSocket
      );

      if (members.length === 0) {
        return [];
      }


      // Sauvegarder chaque membre en base
      const detailedMembers = [];
      const batchSize = 50;

      for (let i = 0; i < members.length; i += batchSize) {
        const batch = members.slice(i, Math.min(i + batchSize, members.length));

        const batchPromises = batch.map(async (member) => {
          const memberData = {
            userId: member.user.id,
            username: member.user.username,
            discriminator: member.user.discriminator || '0',
            displayName: member.nick || member.user.username,
            joinedAt: member.joined_at ? new Date(member.joined_at) : new Date(),
            roles: member.roles || [],
            avatar: member.user.avatar,
            guildId: sourceGuild.id
          };

          // Sauvegarder en base
          const saved = await this.updateMemberDetail(memberData, sourceGuild.id, sourceGuild.name);
          return saved || memberData;
        });

        const batchResults = await Promise.all(batchPromises);
        detailedMembers.push(...batchResults);

      }

      // Marquer tous les membres comme ayant été récupérés
      await MemberDetail.updateMany(
        { guildId: sourceGuild.id },
        { lastFetched: new Date() }
      );

      return detailedMembers;

    } catch (error) {
      console.error(`❌ Erreur récupération membres:`, error);
      return [];
    }
  }

  /**
   * 💾 Mettre à jour ou créer un membre en base
   */
  async updateMemberDetail(memberData, guildId, guildName) {
    try {
      const MemberDetail = require('../models/MemberDetail');

      // Chercher ou créer le membre
      let member = await MemberDetail.findOne({
        userId: memberData.userId,
        guildId: guildId
      });

      if (!member) {
        member = new MemberDetail({
          userId: memberData.userId,
          guildId: guildId,
          guildName: guildName,
          username: memberData.username,
          discriminator: memberData.discriminator,
          displayName: memberData.displayName,
          avatar: memberData.avatar,
          joinedAt: memberData.joinedAt,
          isPresent: true,
          lastSeen: new Date(),
          lastFetched: new Date()
        });
      } else {
        // Mettre à jour les infos
        member.username = memberData.username;
        member.discriminator = memberData.discriminator;
        member.displayName = memberData.displayName;
        member.avatar = memberData.avatar;
        member.isPresent = true;
        member.lastSeen = new Date();
        member.lastFetched = new Date();
      }

      // Mettre à jour la liste des serveurs
      const serverEntry = member.servers.find(s => s.guildId === guildId);
      if (!serverEntry) {
        member.servers.push({
          guildId: guildId,
          guildName: guildName,
          joinedAt: memberData.joinedAt || new Date(),
          isPresent: true
        });
      } else {
        serverEntry.isPresent = true;
        serverEntry.guildName = guildName;
      }

      // Calculer le niveau de danger (présent sur plusieurs serveurs)
      if (member.servers.filter(s => s.isPresent).length >= 2) {
        member.isDangerous = true;
        member.dangerLevel = Math.min(member.servers.length - 1, 3);
      }

      await member.save();
      return member;

    } catch (error) {
      console.error(`❌ Erreur sauvegarde membre ${memberData.userId}:`, error);
      return null;
    }
  }

  /**
   * 🔄 Comparer les listes de membres entre deux périodes
   */
  async compareMembers(guildId, previousList, currentList) {
    const changes = {
      joined: [],
      left: [],
      total: 0
    };

    // Créer des maps pour comparaison rapide
    const previousMap = new Map(previousList.map(m => [m.userId, m]));
    const currentMap = new Map(currentList.map(m => [m.userId, m]));

    // Détecter les nouveaux membres
    for (const [userId, member] of currentMap) {
      if (!previousMap.has(userId)) {
        changes.joined.push(member);
      }
    }

    // Détecter les membres partis
    for (const [userId, member] of previousMap) {
      if (!currentMap.has(userId)) {
        changes.left.push(member);
      }
    }

    changes.total = currentList.length - previousList.length;

    return changes;
  }

  /**
   * ⚠️ Identifier les membres dangereux (présents sur plusieurs serveurs)
   */
  async findDangerousMembers() {
    try {
      const MemberDetail = require('../models/MemberDetail');

      // Agrégation MongoDB pour trouver les membres sur plusieurs serveurs
      const dangerousMembers = await MemberDetail.aggregate([
        {
          $match: {
            isPresent: true,
            'servers.1': { $exists: true } // Au moins 2 serveurs
          }
        },
        {
          $addFields: {
            serverCount: { $size: '$servers' }
          }
        },
        {
          $sort: { serverCount: -1, username: 1 }
        },
        {
          $limit: 100 // Top 100 membres dangereux
        }
      ]);

      return dangerousMembers;

    } catch (error) {
      console.error('❌ Erreur identification membres dangereux:', error);
      return [];
    }
  }

  /**
   * 📊 Générer le rapport quotidien
   */
  async generateDailyReport(targetGuildId) {
    try {
      const MemberDetail = require('../models/MemberDetail');
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      // Récupérer le sourceGuildId depuis la configuration
      const sourceGuild = this.client.services.userClient.getSourceGuild(targetGuildId);
      const sourceGuildId = sourceGuild.id;


      // Récupérer les données nécessaires en utilisant sourceGuildId
      const [dangerousMembers, recentDepartures, todayJoins, todayLeaves] = await Promise.all([
        // Membres dangereux
        MemberDetail.find({
          isDangerous: true,
          servers: { $elemMatch: { guildId: sourceGuildId, isPresent: true } }
        }).sort({ dangerLevel: -1 }).limit(20),

        // Opportunités (départs récents de concurrents)
        MemberDetail.find({
          isOpportunity: true,
          opportunityDate: { $gte: yesterday }
        }).sort({ opportunityDate: -1 }).limit(10),

        // Arrivées du jour
        MemberDetail.find({
          guildId: sourceGuildId,
          joinedAt: { $gte: yesterday }
        }).sort({ joinedAt: -1 }),

        // Départs du jour
        MemberDetail.find({
          guildId: sourceGuildId,
          leftAt: { $gte: yesterday }
        }).sort({ leftAt: -1 })
      ]);

      // Statistiques globales
      const stats = await MemberDetail.aggregate([
        {
          $match: { guildId: sourceGuildId }
        },
        {
          $group: {
            _id: null,
            totalMembers: { $sum: { $cond: ['$isPresent', 1, 0] } },
            totalDangerous: { $sum: { $cond: ['$isDangerous', 1, 0] } },
            totalOpportunities: { $sum: { $cond: ['$isOpportunity', 1, 0] } }
          }
        }
      ]);

      return {
        dangerousMembers,
        recentDepartures,
        todayJoins,
        todayLeaves,
        stats: stats[0] || { totalMembers: 0, totalDangerous: 0, totalOpportunities: 0 },
        generatedAt: now
      };

    } catch (error) {
      console.error('❌ Erreur génération rapport:', error);
      return null;
    }
  }

  /**
   * 💾 Sauvegarder un membre détaillé
   */
  async saveMemberDetail(member, guildId, guildName, action = 'update') {
    try {
      const MemberDetail = require('../models/MemberDetail');

      // Chercher ou créer le membre
      let memberDetail = await MemberDetail.findOne({
        guildId: guildId,
        userId: member.id || member.userId
      });

      if (!memberDetail) {
        memberDetail = new MemberDetail({
          guildId,
          guildName,
          userId: member.id || member.userId,
          username: member.username || member.user?.username,
          discriminator: member.discriminator || member.user?.discriminator || '0',
          displayName: member.displayName || member.nickname
        });
      }

      // Mettre à jour les infos
      memberDetail.username = member.username || member.user?.username || memberDetail.username;
      memberDetail.displayName = member.displayName || member.nickname || memberDetail.displayName;
      memberDetail.lastSeen = new Date();

      if (action === 'join') {
        memberDetail.isPresent = true;
        memberDetail.joinedAt = new Date();
        memberDetail.totalJoins += 1;
        memberDetail.addHistory('join', `A rejoint ${guildName}`, guildId, guildName);
      } else if (action === 'leave') {
        memberDetail.isPresent = false;
        memberDetail.leftAt = new Date();
        memberDetail.totalLeaves += 1;
        memberDetail.addHistory('leave', `A quitté ${guildName}`, guildId, guildName);
      }

      // Mettre à jour la liste des serveurs
      await this.updateMemberServers(memberDetail);

      // Calculer le niveau de danger
      memberDetail.calculateDangerLevel();

      await memberDetail.save();
      return memberDetail;

    } catch (error) {
      console.error('❌ Erreur sauvegarde membre détaillé:', error);
      return null;
    }
  }

  /**
   * 🔄 Mettre à jour la liste des serveurs d'un membre
   */
  async updateMemberServers(memberDetail) {
    try {
      const MemberDetail = require('../models/MemberDetail');

      // Récupérer toutes les présences de ce membre
      const allPresences = await MemberDetail.find({
        userId: memberDetail.userId,
        isPresent: true
      }).select('guildId guildName joinedAt');

      // Reconstruire la liste des serveurs
      memberDetail.servers = allPresences.map(p => ({
        guildId: p.guildId,
        guildName: p.guildName,
        joinedAt: p.joinedAt,
        isPresent: true
      }));

      return memberDetail;

    } catch (error) {
      console.error('❌ Erreur mise à jour serveurs membre:', error);
      return memberDetail;
    }
  }

  /**
   * 📊 Tracker tous les serveurs configurés (pour la tâche cron quotidienne)
   */
  async trackAllServers() {
    try {
      const stats = this.client.services.userClient.getStats();
      const results = [];


      for (const guildData of stats.guilds) {
        try {
          const result = await this.trackServerMembers(guildData.guildId);
          results.push({
            guildId: guildData.guildId,
            result
          });

          // Délai entre chaque serveur pour éviter le rate limiting
          await new Promise(resolve => setTimeout(resolve, 2000));

        } catch (error) {
          console.error(`❌ Erreur tracking ${guildData.guildId}:`, error);
          results.push({
            guildId: guildData.guildId,
            result: { error: error.message, success: false }
          });
        }
      }

      const successCount = results.filter(r => r.result?.success).length;

      return results;

    } catch (error) {
      console.error('❌ Erreur tracking global:', error);
      throw error;
    }
  }

  /**
   * 📊 Obtenir le count instantané (pour la commande /member-count)
   */
  async getInstantMemberCount(targetGuildId) {
    try {
      if (!this.client.services.userClient.hasUserToken(targetGuildId)) {
        throw new Error('Aucun serveur source configuré');
      }

      const userData = this.client.services.userClient.getUserData(targetGuildId);
      const sourceGuild = this.client.services.userClient.getSourceGuild(targetGuildId);

      // Récupérer le count instantané
      const memberData = await this.client.services.userClient.fetchGuildMemberCount(
        userData.token, 
        sourceGuild.id
      );

      // Récupérer la dernière entrée sauvegardée pour comparaison
      const MemberCount = require('../models/MemberCount');
      const lastCount = await MemberCount.findOne({ 
        guildId: sourceGuild.id 
      }).sort({ timestamp: -1 });

      let changesSinceLastTrack = {};
      if (lastCount) {
        changesSinceLastTrack = {
          members: memberData.totalMembers - lastCount.totalMembers,
          timeSince: memberData.timestamp - lastCount.timestamp
        };
      }

      return {
        memberData,
        lastTracked: lastCount,
        changesSinceLastTrack,
        success: true
      };

    } catch (error) {
      console.error(`❌ Erreur get instant member count:`, error);
      throw error;
    }
  }

  /**
   * 📈 Obtenir l'historique des members count
   */
  async getMemberHistory(sourceGuildId, days = 30) {
    try {
      const MemberCount = require('../models/MemberCount');
      
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      
      const history = await MemberCount.find({
        guildId: sourceGuildId,
        timestamp: { $gte: since }
      }).sort({ timestamp: 1 });

      return history;

    } catch (error) {
      console.error('❌ Erreur récupération historique:', error);
      throw error;
    }
  }
}

module.exports = MemberTrackerService; 