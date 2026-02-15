const Role = require('../models/Role');
const { resolveRoleNameConflict } = require('../utils/nameConflict');
const { filterSafePermissions, analyzeRolePermissions } = require('../utils/permissions');

class RoleManager {
  constructor(client, logger) {
    this.client = client;
    this.logger = logger;
  }

  // Synchroniser tous les rôles d'un serveur source
  async syncAllRoles(targetGuild, sourceGuild, options = {}) {
    try {
      const { excludeRoles = ['@everyone', 'ladmin', 'lmembres'], skipManaged = true } = options;
      
      console.log(`Début de la synchronisation des rôles de ${sourceGuild.name} vers ${targetGuild.name}`);
      
      const sourceRoles = sourceGuild.roles.cache
        .filter(role => !excludeRoles.includes(role.name))
        .filter(role => !skipManaged || !role.managed) // Ignorer les rôles managés par les bots
        .filter(role => role.name !== '@everyone');

      const syncedRoles = [];
      const errors = [];
      let securedRolesCount = 0;
      let adminRolesSecured = 0;

      for (const [roleId, sourceRole] of sourceRoles) {
        try {
          // 🔒 ANALYSER AVANT SYNCHRONISATION
          const permissionAnalysis = analyzeRolePermissions(sourceRole);
          if (permissionAnalysis.filteringRequired) {
            securedRolesCount++;
            if (permissionAnalysis.hasAdministrator) {
              adminRolesSecured++;
            }
          }
          
          const syncedRole = await this.syncRole(targetGuild, sourceRole);
          if (syncedRole) {
            syncedRoles.push(syncedRole);
            
            // Sauvegarder en base de données
            await this.saveRoleToDatabase(syncedRole, sourceGuild.id);
            
            // Logger la synchronisation
            await this.logger.logRoleAction(
              targetGuild.id,
              `Rôle synchronisé: ${syncedRole.name} (couleur: ${syncedRole.hexColor})`
            );
          }
        } catch (error) {
          console.error(`Erreur lors de la synchronisation du rôle ${sourceRole.name}:`, error);
          errors.push({ role: sourceRole.name, error: error.message });
          
          await this.logger.logRoleAction(
            targetGuild.id,
            `Erreur synchronisation rôle ${sourceRole.name}: ${error.message}`
          );
        }
      }

      console.log(`✅ Synchronisation terminée: ${syncedRoles.length} rôles synchronisés, ${errors.length} erreurs`);
      console.log(`🔒 SÉCURITÉ: ${securedRolesCount} rôles sécurisés, ${adminRolesSecured} admin neutralisés`);
      
      // 🔒 LOGGER LE RÉSUMÉ DE SÉCURISATION
      if (securedRolesCount > 0) {
        await this.logger.logRoleAction(
          targetGuild.id,
          `🔒 **RÉSUMÉ SÉCURISATION SYNC**\n` +
          `• ✅ **${syncedRoles.length} rôles** synchronisés au total\n` +
          `• 🔒 **${securedRolesCount} rôles** sécurisés (permissions filtrées)\n` +
          `• 🚫 **${adminRolesSecured} rôles admin** neutralisés\n` +
          `• 🛡️ **Serveur mirror PROTÉGÉ** contre élévation de privilèges\n` +
          `• 📊 Erreurs: ${errors.length}`
        );
      }
      return { syncedRoles, errors };
    } catch (error) {
      console.error('Erreur lors de la synchronisation complète des rôles:', error);
      throw error;
    }
  }

  // Synchroniser un rôle individuel
  async syncRole(targetGuild, sourceRole) {
    try {
      const finalName = await resolveRoleNameConflict(targetGuild, sourceRole.name);
      
      // 🔒 ANALYSER ET FILTRER LES PERMISSIONS POUR LA SÉCURITÉ
      const permissionAnalysis = analyzeRolePermissions(sourceRole);
      const safePermissions = filterSafePermissions(sourceRole.permissions);
      
      // 🔍 LOG DÉTAILLÉ SI FILTRAGE NÉCESSAIRE
      if (permissionAnalysis.filteringRequired) {
        console.log(`🔒 FILTRAGE SÉCURITÉ pour rôle "${sourceRole.name}"`);
        console.log(`   • Admin: ${permissionAnalysis.hasAdministrator ? '❌ SUPPRIMÉ' : '✅ Non'}`);
        console.log(`   • Permissions dangereuses: ${permissionAnalysis.dangerousPermissionsCount} SUPPRIMÉES`);
        console.log(`   • Permissions sécurisées: ${permissionAnalysis.safePermissionsCount} conservées`);
        
        // Logger la sécurisation dans les logs de rôles
        await this.logger.logRoleAction(
          targetGuild.id,
          `🔒 **SÉCURISATION RÔLE** - ${sourceRole.name}\n` +
          `• 🚫 Admin: ${permissionAnalysis.hasAdministrator ? 'SUPPRIMÉ' : 'Non'}\n` +
          `• 🚫 Permissions dangereuses: ${permissionAnalysis.dangerousPermissionsCount} supprimées\n` +
          `• ✅ Permissions sécurisées: ${permissionAnalysis.safePermissionsCount} conservées\n` +
          `• 🛡️ **Utilisateurs du mirror: PROTÉGÉS contre élévation admin**`
        );
      }
      
      // Vérifier si le rôle existe déjà
      let existingRole = targetGuild.roles.cache.find(role => role.name === finalName);
      
      if (existingRole) {
        // Mettre à jour le rôle existant avec permissions filtrées
        await existingRole.edit({
          name: finalName,
          color: sourceRole.color,
          permissions: safePermissions, // 🔒 PERMISSIONS FILTRÉES
          hoist: sourceRole.hoist,
          mentionable: sourceRole.mentionable,
          position: sourceRole.position
        });
        
        console.log(`✅ Rôle mis à jour (sécurisé): ${finalName}`);
        return existingRole;
      } else {
        // Créer un nouveau rôle avec permissions filtrées
        const newRole = await targetGuild.roles.create({
          name: finalName,
          color: sourceRole.color,
          permissions: safePermissions, // 🔒 PERMISSIONS FILTRÉES
          hoist: sourceRole.hoist,
          mentionable: sourceRole.mentionable,
          position: sourceRole.position
        });
        
        console.log(`✅ Rôle créé (sécurisé): ${finalName}`);
        return newRole;
      }
    } catch (error) {
      console.error(`❌ Erreur lors de la synchronisation du rôle ${sourceRole.name}:`, error);
      throw error;
    }
  }

  // Ajouter un rôle manuellement
  async addRole(targetGuild, sourceGuild, roleName) {
    try {
      const sourceRole = sourceGuild.roles.cache.find(
        role => role.name === roleName || role.id === roleName
      );

      if (!sourceRole) {
        throw new Error(`Rôle ${roleName} introuvable sur le serveur source`);
      }

      const syncedRole = await this.syncRole(targetGuild, sourceRole);
      
      // Sauvegarder en base de données
      await this.saveRoleToDatabase(syncedRole, sourceGuild.id);
      
      // Logger l'ajout
      await this.logger.logRoleAction(
        targetGuild.id,
        `Rôle ajouté manuellement: ${syncedRole.name}`
      );

      return syncedRole;
    } catch (error) {
      console.error(`Erreur lors de l'ajout du rôle ${roleName}:`, error);
      await this.logger.logRoleAction(
        targetGuild.id,
        `Erreur ajout rôle ${roleName}: ${error.message}`
      );
      throw error;
    }
  }

  // Supprimer un rôle
  async removeRole(targetGuild, roleName) {
    try {
      const role = targetGuild.roles.cache.find(
        r => r.name === roleName || r.id === roleName
      );

      if (!role) {
        throw new Error(`Rôle ${roleName} introuvable`);
      }

      // Ne pas supprimer les rôles système
      if (['ladmin', 'lmembres', '@everyone'].includes(role.name)) {
        throw new Error(`Impossible de supprimer le rôle système ${role.name}`);
      }

      // Supprimer de la base de données
      await Role.deleteOne({ discordId: role.id });
      
      // Supprimer le rôle Discord
      await role.delete();
      
      // Logger la suppression
      await this.logger.logRoleAction(
        targetGuild.id,
        `Rôle supprimé: ${role.name}`
      );
      
      return true;
    } catch (error) {
      console.error(`Erreur lors de la suppression du rôle ${roleName}:`, error);
      await this.logger.logRoleAction(
        targetGuild.id,
        `Erreur suppression rôle ${roleName}: ${error.message}`
      );
      throw error;
    }
  }

  // Attribuer un rôle à un utilisateur
  async assignRole(guild, userId, roleName) {
    try {
      const member = await guild.members.fetch(userId);
      const role = guild.roles.cache.find(r => r.name === roleName || r.id === roleName);

      if (!role) {
        throw new Error(`Rôle ${roleName} introuvable`);
      }

      await member.roles.add(role);
      
      await this.logger.logRoleAction(
        guild.id,
        `Rôle ${role.name} attribué à ${member.user.tag}`
      );

      return true;
    } catch (error) {
      console.error(`Erreur lors de l'attribution du rôle ${roleName}:`, error);
      await this.logger.logRoleAction(
        guild.id,
        `Erreur attribution rôle ${roleName}: ${error.message}`
      );
      throw error;
    }
  }

  // Retirer un rôle d'un utilisateur
  async removeRoleFromUser(guild, userId, roleName) {
    try {
      const member = await guild.members.fetch(userId);
      const role = guild.roles.cache.find(r => r.name === roleName || r.id === roleName);

      if (!role) {
        throw new Error(`Rôle ${roleName} introuvable`);
      }

      await member.roles.remove(role);
      
      await this.logger.logRoleAction(
        guild.id,
        `Rôle ${role.name} retiré de ${member.user.tag}`
      );

      return true;
    } catch (error) {
      console.error(`Erreur lors du retrait du rôle ${roleName}:`, error);
      await this.logger.logRoleAction(
        guild.id,
        `Erreur retrait rôle ${roleName}: ${error.message}`
      );
      throw error;
    }
  }

  // Sauvegarder les informations du rôle en base de données
  async saveRoleToDatabase(role, sourceServerId) {
    try {
      await Role.findOneAndUpdate(
        { discordId: role.id },
        { $set: { serverId: sourceServerId, name: role.name, synced: true } },
        { upsert: true }
      );
    } catch (error) {
      console.error('Erreur lors de la sauvegarde du rôle:', error);
    }
  }

  // Auto-discovery: détecter les nouveaux rôles sur le serveur source
  async discoverNewRoles(targetGuild, sourceGuild) {
    try {
      const sourceRoles = sourceGuild.roles.cache
        .filter(role => role.name !== '@everyone' && !role.managed);
      
      const existingRoles = await Role.find({ serverId: sourceGuild.id });
      const existingRoleIds = new Set(existingRoles.map(r => r.discordId));
      
      const newRoles = [];
      
      for (const [roleId, sourceRole] of sourceRoles) {
        if (!existingRoleIds.has(roleId)) {
          try {
            const syncedRole = await this.addRole(targetGuild, sourceGuild, sourceRole.name);
            newRoles.push(syncedRole);
          } catch (error) {
            console.error(`Erreur lors de l'auto-discovery du rôle ${sourceRole.name}:`, error);
          }
        }
      }
      
      if (newRoles.length > 0) {
        console.log(`Auto-discovery: ${newRoles.length} nouveaux rôles détectés et ajoutés`);
      }
      
      return newRoles;
    } catch (error) {
      console.error('Erreur lors de l\'auto-discovery des rôles:', error);
      return [];
    }
  }

  // Nettoyer les rôles supprimés du serveur source
  async cleanupDeletedRoles(targetGuild, sourceGuild) {
    try {
      const sourceRoleIds = new Set(sourceGuild.roles.cache.keys());
      const trackedRoles = await Role.find({ serverId: sourceGuild.id });
      
      for (const trackedRole of trackedRoles) {
        if (!sourceRoleIds.has(trackedRole.discordId)) {
          // Le rôle a été supprimé du serveur source
          const targetRole = targetGuild.roles.cache.find(
            r => r.name === trackedRole.name
          );
          
          if (targetRole && !['ladmin', 'lmembres'].includes(targetRole.name)) {
            await targetRole.delete();
            await this.logger.logRoleAction(
              targetGuild.id,
              `Rôle ${trackedRole.name} supprimé (supprimé du serveur source)`
            );
          }
          
          // Supprimer de la base de données
          await Role.deleteOne({ _id: trackedRole._id });
        }
      }
    } catch (error) {
      console.error('Erreur lors du nettoyage des rôles supprimés:', error);
    }
  }

  // Obtenir la liste des rôles synchronisés
  async getRoleList(serverId) {
    try {
      return await Role.find({ serverId }).sort({ name: 1 });
    } catch (error) {
      console.error('Erreur lors de la récupération de la liste des rôles:', error);
      return [];
    }
  }

  // Configurer les permissions par défaut pour les rôles système
  async setupDefaultPermissions(targetGuild, sourceGuild) {
    try {
      const adminRole = targetGuild.roles.cache.find(role => role.name === 'ladmin');
      const memberRole = targetGuild.roles.cache.find(role => role.name === 'lmembres');
      
      if (!adminRole || !memberRole) {
        throw new Error('Rôles système introuvables');
      }

      // Configurer les permissions pour chaque salon
      const channels = targetGuild.channels.cache.filter(channel => 
        channel.type === 0 || channel.type === 2 // Text et Voice
      );

      for (const [channelId, channel] of channels) {
        try {
          // Permissions pour @lmembres
          await channel.permissionOverwrites.edit(memberRole, {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
            Connect: channel.type === 2, // Pour les salons vocaux
            Speak: channel.type === 2
          });

          // Permissions pour @ladmin (hérite de ADMINISTRATOR)
          // Pas besoin de configurer explicitement
        } catch (error) {
          console.error(`Erreur lors de la configuration des permissions pour ${channel.name}:`, error);
        }
      }

      await this.logger.logRoleAction(
        targetGuild.id,
        'Permissions par défaut configurées pour les rôles système'
      );
    } catch (error) {
      console.error('Erreur lors de la configuration des permissions par défaut:', error);
      throw error;
    }
  }
}

module.exports = RoleManager; 