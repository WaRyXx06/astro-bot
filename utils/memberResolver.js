/**
 * 🔍 UTILITAIRE DE RÉSOLUTION DES MEMBRES CROSS-SERVER
 *
 * Résout les membres depuis le serveur source (distant)
 * car Discord ne peut pas référencer des membres d'autres serveurs
 */

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

class MemberResolver {
  /**
   * 🔍 Résoudre un membre depuis différents formats d'entrée
   * @param {string} input - ID, username, @mention ou username#discriminator
   * @param {string} sourceGuildId - ID du serveur source
   * @param {object} userClient - Service userClient pour l'API Discord
   * @returns {object|null} Membre trouvé ou null
   */
  static async resolveMember(input, sourceGuildId, userClient, targetGuildId) {
    if (!input || !sourceGuildId) return null;

    try {
      // Nettoyer l'input
      const cleanInput = input.trim();

      // 1. Extraire l'ID si c'est une mention (@<123456789>)
      const mentionMatch = cleanInput.match(/^<@!?(\d{17,19})>$/);
      if (mentionMatch) {
        return await this.fetchMemberById(mentionMatch[1], sourceGuildId, userClient, targetGuildId);
      }

      // 2. Si c'est un ID Discord valide (17-19 chiffres)
      if (/^\d{17,19}$/.test(cleanInput)) {
        return await this.fetchMemberById(cleanInput, sourceGuildId, userClient, targetGuildId);
      }

      // 3. Chercher par username dans MongoDB d'abord
      const MemberDetail = require('../models/MemberDetail');

      // Chercher dans la base de données (plus rapide)
      const dbMember = await MemberDetail.findOne({
        guildId: sourceGuildId,
        $or: [
          { username: cleanInput },
          { username: cleanInput.split('#')[0] }, // Support username#0000
          { displayName: cleanInput }
        ]
      }).sort({ lastSeen: -1 });

      if (dbMember) {
        console.log(`✅ Membre trouvé dans DB: ${dbMember.username} (${dbMember.userId})`);
        return {
          id: dbMember.userId,
          userId: dbMember.userId,
          username: dbMember.username,
          discriminator: dbMember.discriminator,
          displayName: dbMember.displayName,
          fromDb: true
        };
      }

      // 4. Si pas trouvé en DB, chercher via l'API Discord
      console.log(`🔍 Recherche du membre "${cleanInput}" via l'API Discord...`);
      return await this.searchMemberByName(cleanInput, sourceGuildId, userClient, targetGuildId);

    } catch (error) {
      console.error(`❌ Erreur résolution membre "${input}":`, error);
      return null;
    }
  }

  /**
   * 🔍 Récupérer un membre par son ID
   */
  static async fetchMemberById(userId, sourceGuildId, userClient, targetGuildId) {
    try {
      const userData = userClient.getUserData(targetGuildId);
      const url = `https://discord.com/api/v9/guilds/${sourceGuildId}/members/${userId}`;

      const options = userClient.getRandomRequestOptions(userData.token);
      const response = await fetch(url, options);

      if (!response.ok) {
        if (response.status === 404) {
          console.log(`⚠️ Membre ${userId} non trouvé sur le serveur source`);
          return null;
        }
        throw new Error(`API Error ${response.status}`);
      }

      const member = await response.json();
      return {
        id: member.user.id,
        userId: member.user.id,
        username: member.user.username,
        discriminator: member.user.discriminator || '0',
        displayName: member.nick || member.user.username,
        avatar: member.user.avatar,
        joinedAt: member.joined_at,
        roles: member.roles,
        user: member.user
      };

    } catch (error) {
      console.error(`❌ Erreur fetch membre par ID ${userId}:`, error);
      return null;
    }
  }

  /**
   * 🔍 Rechercher un membre par nom (recherche dans la liste complète)
   */
  static async searchMemberByName(name, sourceGuildId, userClient, targetGuildId) {
    try {
      // Récupérer la liste des membres (avec pagination)
      console.log(`📋 Récupération de la liste des membres pour recherche...`);

      const userData = userClient.getUserData(targetGuildId);
      const members = await userClient.fetchGuildMembers(userData.token, sourceGuildId, 1000);

      // Chercher par username ou displayName
      const searchLower = name.toLowerCase();
      const foundMember = members.find(m => {
        const username = m.user.username.toLowerCase();
        const displayName = (m.nick || '').toLowerCase();
        const fullTag = `${m.user.username}#${m.user.discriminator || '0'}`.toLowerCase();

        return username === searchLower ||
               displayName === searchLower ||
               fullTag === searchLower ||
               username.includes(searchLower);
      });

      if (foundMember) {
        console.log(`✅ Membre trouvé via API: ${foundMember.user.username} (${foundMember.user.id})`);
        return {
          id: foundMember.user.id,
          userId: foundMember.user.id,
          username: foundMember.user.username,
          discriminator: foundMember.user.discriminator || '0',
          displayName: foundMember.nick || foundMember.user.username,
          avatar: foundMember.user.avatar,
          joinedAt: foundMember.joined_at,
          roles: foundMember.roles,
          user: foundMember.user
        };
      }

      console.log(`⚠️ Aucun membre trouvé pour "${name}" sur le serveur source`);
      return null;

    } catch (error) {
      console.error(`❌ Erreur recherche membre par nom:`, error);
      return null;
    }
  }

  /**
   * 🎯 Résoudre un rôle depuis le serveur source
   */
  static async resolveRole(input, sourceGuildId, userClient, targetGuildId) {
    if (!input || !sourceGuildId) return null;

    try {
      const cleanInput = input.trim().replace(/^@/, '');

      // Récupérer les rôles du serveur source
      const userData = userClient.getUserData(targetGuildId);
      const url = `https://discord.com/api/v9/guilds/${sourceGuildId}/roles`;

      const options = userClient.getRandomRequestOptions(userData.token);
      const response = await fetch(url, options);

      if (!response.ok) {
        throw new Error(`API Error ${response.status}`);
      }

      const roles = await response.json();

      // Chercher le rôle par nom ou ID
      const searchLower = cleanInput.toLowerCase();
      const foundRole = roles.find(r => {
        return r.id === cleanInput ||
               r.name.toLowerCase() === searchLower ||
               r.name.toLowerCase().includes(searchLower);
      });

      if (foundRole) {
        console.log(`✅ Rôle trouvé: ${foundRole.name} (${foundRole.id})`);
        return foundRole;
      }

      console.log(`⚠️ Aucun rôle trouvé pour "${input}" sur le serveur source`);
      return null;

    } catch (error) {
      console.error(`❌ Erreur résolution rôle "${input}":`, error);
      return null;
    }
  }
}

module.exports = MemberResolver;