const { PermissionFlagsBits } = require('discord.js');

// 🔒 PERMISSIONS SÉCURISÉES POUR LES RÔLES MIRROR (utilisateurs normaux)
const SAFE_PERMISSIONS = [
  // Permissions de base lecture/écriture
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.UseExternalEmojis,
  PermissionFlagsBits.UseExternalStickers,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.UseApplicationCommands,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.CreatePrivateThreads,
  PermissionFlagsBits.SendMessagesInThreads,
  
  // Permissions vocales de base
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
  PermissionFlagsBits.UseVAD, // Voice Activity Detection
  PermissionFlagsBits.Stream,
  
  // Permissions médias
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
  
  // Permissions événements
  PermissionFlagsBits.RequestToSpeak, // Pour les stages
];

// 🚫 PERMISSIONS DANGEREUSES À SUPPRIMER (administratives)
const DANGEROUS_PERMISSIONS = [
  // Permissions administrateur absolues
  PermissionFlagsBits.Administrator,
  
  // Gestion serveur
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.ManageNicknames,
  PermissionFlagsBits.ManageEmojisAndStickers,
  PermissionFlagsBits.ManageGuildExpressions,
  PermissionFlagsBits.ViewAuditLog,
  PermissionFlagsBits.ViewGuildInsights,
  
  // Modération
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ModerateMembers, // Timeout
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.MentionEveryone,
  
  // Permissions vocales dangereuses
  PermissionFlagsBits.DeafenMembers,
  PermissionFlagsBits.MuteMembers,
  PermissionFlagsBits.MoveMembers,
  PermissionFlagsBits.PrioritySpeaker,
  
  // Événements
  PermissionFlagsBits.ManageEvents,
  PermissionFlagsBits.CreateInstantInvite,
  
  // Threads
  PermissionFlagsBits.ManageThreads,
  
  // Autres permissions sensibles
  PermissionFlagsBits.SendTTSMessages,
  PermissionFlagsBits.UseEmbeddedActivities,
];

/**
 * 🔒 Filtrer les permissions pour ne garder que les permissions sécurisées
 * Cette fonction supprime toutes les permissions administratives et ne garde
 * que les permissions de base nécessaires pour un utilisateur normal
 * 
 * @param {bigint|string} originalPermissions - Permissions du rôle source
 * @returns {bigint} - Permissions filtrées (sécurisées)
 */
function filterSafePermissions(originalPermissions) {
  try {
    // Convertir en BigInt si c'est une string
    const permissions = typeof originalPermissions === 'string' ? 
      BigInt(originalPermissions) : 
      BigInt(originalPermissions || 0);
    
    // 🚨 VÉRIFICATION CRITIQUE : Si le rôle a des permissions Administrator, 
    // on ne garde QUE les permissions de base
    if (permissions & PermissionFlagsBits.Administrator) {
      console.log(`🚫 Rôle avec permission Administrator détecté - Application du filtrage strict`);
      return getBasicUserPermissions();
    }
    
    // Calculer les permissions filtrées en gardant seulement les permissions sécurisées
    let filteredPermissions = 0n;
    
    for (const safePermission of SAFE_PERMISSIONS) {
      if (permissions & safePermission) {
        filteredPermissions |= safePermission;
      }
    }
    
    // 🔍 DEBUG : Afficher les permissions supprimées si des permissions dangereuses étaient présentes
    let removedDangerous = false;
    for (const dangerousPermission of DANGEROUS_PERMISSIONS) {
      if (permissions & dangerousPermission) {
        removedDangerous = true;
        console.log(`🚫 Permission dangereuse supprimée: ${getPermissionName(dangerousPermission)}`);
      }
    }
    
    if (removedDangerous) {
      console.log(`✅ Permissions filtrées appliquées - Rôle sécurisé pour utilisateur normal`);
    }
    
    return filteredPermissions;
    
  } catch (error) {
    console.error('❌ Erreur filtrage permissions:', error);
    // En cas d'erreur, retourner des permissions minimales sécurisées
    return getBasicUserPermissions();
  }
}

/**
 * 🔒 Obtenir des permissions de base pour un utilisateur normal
 * @returns {bigint} - Permissions minimales sécurisées
 */
function getBasicUserPermissions() {
  return PermissionFlagsBits.ViewChannel |
         PermissionFlagsBits.SendMessages |
         PermissionFlagsBits.ReadMessageHistory |
         PermissionFlagsBits.AddReactions |
         PermissionFlagsBits.UseExternalEmojis |
         PermissionFlagsBits.AttachFiles |
         PermissionFlagsBits.EmbedLinks |
         PermissionFlagsBits.Connect |
         PermissionFlagsBits.Speak |
         PermissionFlagsBits.UseVAD;
}

/**
 * 🔍 Obtenir le nom d'une permission pour debug
 * @param {bigint} permission - Flag de permission
 * @returns {string} - Nom de la permission
 */
function getPermissionName(permission) {
  const permissionNames = {
    [PermissionFlagsBits.Administrator]: 'Administrator',
    [PermissionFlagsBits.ManageGuild]: 'ManageGuild',
    [PermissionFlagsBits.ManageRoles]: 'ManageRoles',
    [PermissionFlagsBits.ManageChannels]: 'ManageChannels',
    [PermissionFlagsBits.KickMembers]: 'KickMembers',
    [PermissionFlagsBits.BanMembers]: 'BanMembers',
    [PermissionFlagsBits.ManageMessages]: 'ManageMessages',
    [PermissionFlagsBits.MentionEveryone]: 'MentionEveryone',
    [PermissionFlagsBits.ViewAuditLog]: 'ViewAuditLog',
    [PermissionFlagsBits.ManageWebhooks]: 'ManageWebhooks',
    [PermissionFlagsBits.ManageNicknames]: 'ManageNicknames',
    [PermissionFlagsBits.ManageEmojisAndStickers]: 'ManageEmojisAndStickers',
    [PermissionFlagsBits.ModerateMembers]: 'ModerateMembers',
    [PermissionFlagsBits.DeafenMembers]: 'DeafenMembers',
    [PermissionFlagsBits.MuteMembers]: 'MuteMembers',
    [PermissionFlagsBits.MoveMembers]: 'MoveMembers',
  };
  
  return permissionNames[permission] || `Unknown(${permission})`;
}

/**
 * 📊 Analyser les permissions d'un rôle source
 * @param {object} sourceRole - Rôle source à analyser
 * @returns {object} - Rapport d'analyse des permissions
 */
function analyzeRolePermissions(sourceRole) {
  const originalPermissions = BigInt(sourceRole.permissions || 0);
  const filteredPermissions = filterSafePermissions(originalPermissions);
  
  const hasAdmin = originalPermissions & PermissionFlagsBits.Administrator;
  const dangerousCount = DANGEROUS_PERMISSIONS.filter(perm => originalPermissions & perm).length;
  const safeCount = SAFE_PERMISSIONS.filter(perm => originalPermissions & perm).length;
  
  return {
    roleName: sourceRole.name,
    hasAdministrator: !!hasAdmin,
    dangerousPermissionsCount: dangerousCount,
    safePermissionsCount: safeCount,
    originalPermissions: originalPermissions.toString(),
    filteredPermissions: filteredPermissions.toString(),
    isSecure: dangerousCount === 0,
    filteringRequired: dangerousCount > 0 || hasAdmin
  };
}

const isAdmin = (member) => {
  // Vérifier si l'utilisateur a le rôle @ladmin
  return member.roles.cache.some(role => role.name === 'ladmin');
};

const checkPermissions = (interaction, requireAdmin = false) => {
  if (requireAdmin && !isAdmin(interaction.member)) {
    return {
      hasPermission: false,
      error: '❌ Cette commande nécessite le rôle @ladmin.'
    };
  }
  
  return { hasPermission: true };
};

const ensureSystemRoles = async (guild) => {
  try {
    // Créer le rôle @ladmin s'il n'existe pas
    let adminRole = guild.roles.cache.find(role => role.name === 'ladmin');
    if (!adminRole) {
      adminRole = await guild.roles.create({
        name: 'ladmin',
        color: '#FF0000',
        permissions: [PermissionFlagsBits.Administrator],
        mentionable: true
      });
    }

    // Créer le rôle @lmembres s'il n'existe pas
    let memberRole = guild.roles.cache.find(role => role.name === 'lmembres');
    if (!memberRole) {
      memberRole = await guild.roles.create({
        name: 'lmembres',
        color: '#00FF00',
        permissions: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageRoles
        ],
        mentionable: true
      });
    } else {
      // Mettre à jour le rôle existant pour ajouter ManageRoles s'il ne l'a pas
      if (!memberRole.permissions.has(PermissionFlagsBits.ManageRoles)) {
        await memberRole.edit({
          permissions: memberRole.permissions.add(PermissionFlagsBits.ManageRoles)
        });
        console.log('✅ Permission ManageRoles ajoutée au rôle lmembres existant');
      }
    }

    return { adminRole, memberRole };
  } catch (error) {
    console.error('Erreur lors de la création des rôles système:', error);
    throw error;
  }
};

const setupChannelPermissions = async (channel, adminRole, memberRole) => {
  try {
    // Configuration des permissions pour les salons système
    if (['newroom', 'error', 'roles-logs'].includes(channel.name)) {
      await channel.permissionOverwrites.edit(adminRole, {
        [PermissionFlagsBits.ViewChannel]: true,
        [PermissionFlagsBits.SendMessages]: true,
        [PermissionFlagsBits.ReadMessageHistory]: true
      });
      
      await channel.permissionOverwrites.edit(memberRole, {
        [PermissionFlagsBits.ViewChannel]: channel.name === 'roles-logs',
        [PermissionFlagsBits.SendMessages]: false,
        [PermissionFlagsBits.ReadMessageHistory]: channel.name === 'roles-logs'
      });
      
      await channel.permissionOverwrites.edit(channel.guild.roles.everyone, {
        [PermissionFlagsBits.ViewChannel]: false
      });
    }
  } catch (error) {
    console.error('Erreur lors de la configuration des permissions:', error);
    throw error;
  }
};

module.exports = {
  isAdmin,
  checkPermissions,
  ensureSystemRoles,
  setupChannelPermissions,
  filterSafePermissions,
  getBasicUserPermissions,
  analyzeRolePermissions,
  SAFE_PERMISSIONS,
  DANGEROUS_PERMISSIONS
}; 