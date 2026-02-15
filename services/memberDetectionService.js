/**
 * 📊 SERVICE DE DÉTECTION DES MEMBRES
 *
 * Orchestre plusieurs méthodes de détection pour maximiser la couverture :
 * 1. Tracking via messages (temps réel, membres actifs)
 * 2. LAZY_REQUEST opcode 14 (sidebar scraping, membres online)
 * 3. Opcode 8 / guild.members.fetch() (100% si permissions)
 * 4. Search brute force alphabétique (80-95%, même offline)
 */

const MemberDetail = require('../models/MemberDetail');

class MemberDetectionService {
  constructor(userClientService) {
    this.userClient = userClientService;
    this.isRunning = false;
    this.lastScanResults = new Map(); // guildId -> { date, stats } (limité aux 20 derniers scans)
    this.MAX_SCAN_RESULTS = 20;
  }

  /**
   * 📊 Méthode principale : détecte tous les membres avec toutes les méthodes disponibles
   * @param {string} sourceGuildId - ID du serveur source à scanner
   * @param {string} targetGuildId - ID du serveur miroir (pour récupérer le selfbot)
   * @param {Object} options - Options de scan
   * @param {boolean} options.thorough - Si true, utilise brute force search (lent mais complet)
   * @param {boolean} options.saveToDb - Si true, sauvegarde vers MemberDetail (défaut: true)
   * @returns {Object} Résultats avec stats par méthode
   */
  async detectAllMembers(sourceGuildId, targetGuildId, options = {}) {
    const { thorough = false, saveToDb = true } = options;

    if (this.isRunning) {
      console.log('⚠️ [MemberDetection] Scan déjà en cours, skip');
      return null;
    }

    this.isRunning = true;
    const startTime = Date.now();

    const results = {
      sourceGuildId,
      startTime: new Date(),
      methods: [],
      members: new Map(), // userId -> memberData
      stats: {
        totalUnique: 0,
        byMethod: {}
      }
    };

    try {
      // Récupérer infos du guild
      const sourceGuild = await this.userClient.getSourceGuild(targetGuildId);
      if (!sourceGuild) {
        console.error('❌ [MemberDetection] Impossible de récupérer le guild source');
        return null;
      }

      const guildName = sourceGuild.name;

      // Récupérer memberCount depuis le selfbot (plus fiable que sourceGuild)
      let totalMembers = sourceGuild.memberCount || 0;
      if (totalMembers === 0) {
        const selfbot = this.userClient.selfbots?.get(targetGuildId);
        const guildFromCache = selfbot?.guilds?.cache?.get(sourceGuildId);
        totalMembers = guildFromCache?.memberCount || guildFromCache?.members?.cache?.size || 0;
      }

      console.log(`\n📊 [MemberDetection] Début scan: ${guildName} (${totalMembers > 0 ? totalMembers + ' membres' : 'membres inconnu'})`);

      // === MÉTHODE 1: Cache existant (instantané) ===
      const cacheMembers = await this.fetchFromCache(sourceGuildId, targetGuildId);
      if (cacheMembers && cacheMembers.length > 0) {
        this.mergeMembers(results.members, cacheMembers, 'cache');
        results.methods.push({ name: 'cache', count: cacheMembers.length });
        results.stats.byMethod.cache = cacheMembers.length;
        console.log(`  ✅ Cache: ${cacheMembers.length} membres`);
      } else {
        console.log(`  ⚪ Cache: 0 membres (cache vide)`);
      }

      // === MÉTHODE 2: LAZY_REQUEST opcode 14 (sidebar) ===
      try {
        const lazyMembers = await this.fetchViaLazyRequest(sourceGuildId, targetGuildId);
        if (lazyMembers && lazyMembers.length > 0) {
          const newCount = this.mergeMembers(results.members, lazyMembers, 'lazy_request');
          results.methods.push({ name: 'lazy_request', count: lazyMembers.length, new: newCount });
          results.stats.byMethod.lazy_request = lazyMembers.length;
          console.log(`  ✅ LAZY_REQUEST: ${lazyMembers.length} membres (+${newCount} nouveaux)`);
        } else {
          console.log(`  ⚪ LAZY_REQUEST: 0 membres (pas de résultat)`);
        }
      } catch (error) {
        console.log(`  ⚠️ LAZY_REQUEST: ${error.message}`);
      }

      // === MÉTHODE 3: Opcode 8 / guild.members.fetch() ===
      try {
        const fetchedMembers = await this.fetchViaWebSocket(sourceGuildId, targetGuildId);
        if (fetchedMembers && fetchedMembers.length > 0) {
          const newCount = this.mergeMembers(results.members, fetchedMembers, 'opcode_8');
          results.methods.push({ name: 'opcode_8', count: fetchedMembers.length, new: newCount });
          results.stats.byMethod.opcode_8 = fetchedMembers.length;
          console.log(`  ✅ Opcode 8: ${fetchedMembers.length} membres (+${newCount} nouveaux)`);
        } else {
          console.log(`  ⚪ Opcode 8: 0 membres (permissions insuffisantes ou timeout)`);
        }
      } catch (error) {
        console.log(`  ⚠️ Opcode 8: ${error.message}`);
      }

      // === MÉTHODE 4: Brute Force Search (si thorough) ===
      if (thorough) {
        console.log(`  🔍 Brute force search en cours...`);
        try {
          const searchMembers = await this.searchMembersBruteForce(sourceGuildId, targetGuildId);
          if (searchMembers && searchMembers.length > 0) {
            const newCount = this.mergeMembers(results.members, searchMembers, 'brute_force');
            results.methods.push({ name: 'brute_force', count: searchMembers.length, new: newCount });
            results.stats.byMethod.brute_force = searchMembers.length;
            console.log(`  ✅ Brute Force: ${searchMembers.length} membres (+${newCount} nouveaux)`);
          } else {
            console.log(`  ⚪ Brute Force: 0 membres (pas de résultat)`);
          }
        } catch (error) {
          console.log(`  ⚠️ Brute Force: ${error.message}`);
        }
      }

      // Calculer stats finales
      results.stats.totalUnique = results.members.size;
      results.stats.totalMembers = totalMembers;

      // Calculer coverage de manière lisible
      if (totalMembers > 0) {
        results.stats.coverage = ((results.members.size / totalMembers) * 100).toFixed(1) + '%';
      } else if (results.members.size > 0) {
        results.stats.coverage = `${results.members.size} membres (total inconnu)`;
      } else {
        results.stats.coverage = 'Aucun membre détecté';
      }

      results.endTime = new Date();
      results.duration = ((Date.now() - startTime) / 1000).toFixed(2);

      console.log(`\n📊 [MemberDetection] Résumé:`);
      console.log(`   Total unique: ${results.stats.totalUnique}${totalMembers > 0 ? `/${totalMembers}` : ''} (${results.stats.coverage})`);
      console.log(`   Durée: ${results.duration}s`);

      // Sauvegarder en DB si demandé
      if (saveToDb && results.members.size > 0) {
        const savedCount = await this.saveMembersBatch(
          Array.from(results.members.values()),
          sourceGuildId,
          guildName
        );
        results.stats.saved = savedCount;
        console.log(`   Sauvegardés: ${savedCount} membres`);
      }

      // Stocker résultats pour référence (avec limite de taille)
      if (this.lastScanResults.size >= this.MAX_SCAN_RESULTS) {
        const oldestKey = this.lastScanResults.keys().next().value;
        this.lastScanResults.delete(oldestKey);
      }
      this.lastScanResults.set(sourceGuildId, {
        date: new Date(),
        stats: results.stats
      });

      return results;

    } catch (error) {
      console.error(`❌ [MemberDetection] Erreur globale:`, error);
      return null;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * 📦 Récupérer membres depuis le cache Discord
   */
  async fetchFromCache(sourceGuildId, targetGuildId) {
    try {
      const members = await this.userClient.fetchMembersFromCache(sourceGuildId, targetGuildId);
      return members || [];
    } catch (error) {
      return [];
    }
  }

  /**
   * 📜 Récupérer via LAZY_REQUEST (opcode 14 - sidebar scrolling)
   */
  async fetchViaLazyRequest(sourceGuildId, targetGuildId) {
    try {
      const members = await this.userClient.fetchMembersViaLazyRequestWithRetry(
        sourceGuildId,
        targetGuildId,
        2 // 2 tentatives max
      );
      return members || [];
    } catch (error) {
      throw error;
    }
  }

  /**
   * 🔌 Récupérer via WebSocket opcode 8
   */
  async fetchViaWebSocket(sourceGuildId, targetGuildId) {
    try {
      const members = await this.userClient.fetchMembersViaWebSocket(sourceGuildId, targetGuildId);
      return members || [];
    } catch (error) {
      throw error;
    }
  }

  /**
   * 🔍 Recherche brute force alphabétique
   * Parcourt a-z, 0-9 et caractères spéciaux pour trouver tous les membres
   */
  async searchMembersBruteForce(sourceGuildId, targetGuildId) {
    const allFound = new Map();

    // Caractères à rechercher (lettres + chiffres + quelques spéciaux)
    const searchChars = 'abcdefghijklmnopqrstuvwxyz0123456789_'.split('');

    const selfbot = this.userClient.selfbots?.get(targetGuildId);
    if (!selfbot) {
      throw new Error('Selfbot non disponible');
    }

    const guild = selfbot.guilds.cache.get(sourceGuildId);
    if (!guild) {
      throw new Error('Guild non trouvé dans le cache');
    }

    let totalRequests = 0;

    for (const char of searchChars) {
      try {
        // Utiliser la méthode de recherche native
        const results = await guild.members.search({ query: char, limit: 100 });

        if (results && results.size > 0) {
          results.forEach(member => {
            if (!member.user.bot && !allFound.has(member.user.id)) {
              allFound.set(member.user.id, this.formatMember(member));
            }
          });
        }

        totalRequests++;

        // Rate limiting: 1.5 secondes entre requêtes
        if (totalRequests < searchChars.length) {
          await this.delay(1500);
        }

      } catch (error) {
        // Continuer même si une recherche échoue
        if (error.code !== 50001) { // Ignorer "Missing Access"
          console.log(`    ⚠️ Search '${char}': ${error.message}`);
        }
      }
    }

    return Array.from(allFound.values());
  }

  /**
   * 🔄 Fusionner des membres dans le résultat global
   * @returns {number} Nombre de nouveaux membres ajoutés
   */
  mergeMembers(targetMap, members, source) {
    let newCount = 0;

    for (const member of members) {
      const userId = member.user?.id || member.userId;
      if (!userId) continue;

      if (!targetMap.has(userId)) {
        targetMap.set(userId, {
          ...this.formatMember(member),
          sources: [source]
        });
        newCount++;
      } else {
        // Ajouter la source si pas déjà présente
        const existing = targetMap.get(userId);
        if (!existing.sources.includes(source)) {
          existing.sources.push(source);
        }
      }
    }

    return newCount;
  }

  /**
   * 📋 Formater un membre pour stockage uniforme
   */
  formatMember(member) {
    // Gérer les différents formats (GuildMember, raw data, etc.)
    if (member.user) {
      return {
        userId: member.user.id,
        username: member.user.username,
        discriminator: member.user.discriminator || '0',
        displayName: member.nickname || member.displayName || member.user.displayName || member.user.username,
        avatar: member.user.avatar,
        bot: member.user.bot || false,
        joinedAt: member.joinedTimestamp ? new Date(member.joinedTimestamp) : null,
        roles: member.roles?.cache?.map(r => r.id) || member.roles || []
      };
    }

    // Format déjà traité
    return {
      userId: member.userId || member.id,
      username: member.username,
      discriminator: member.discriminator || '0',
      displayName: member.displayName || member.nick || member.username,
      avatar: member.avatar,
      bot: member.bot || false,
      joinedAt: member.joined_at ? new Date(member.joined_at) : null,
      roles: member.roles || []
    };
  }

  /**
   * 💾 Sauvegarder un batch de membres vers MemberDetail
   * Utilise bulkWrite pour performance optimale
   */
  async saveMembersBatch(members, sourceGuildId, sourceGuildName) {
    if (!members || members.length === 0) return 0;

    try {
      const operations = members
        .filter(m => m && m.userId && !m.bot)
        .map(member => ({
          updateOne: {
            filter: {
              guildId: sourceGuildId,
              userId: member.userId
            },
            update: {
              $set: {
                username: member.username,
                displayName: member.displayName || member.username,
                lastSeen: new Date(),
                lastFetched: new Date(),
                isPresent: true,
                avatar: member.avatar
              },
              $setOnInsert: {
                guildId: sourceGuildId,
                guildName: sourceGuildName,
                userId: member.userId,
                discriminator: member.discriminator || '0',
                firstSeenAt: new Date(),
                joinedAt: member.joinedAt || new Date(),
                totalJoins: 1,
                isDangerous: false,
                dangerLevel: 0,
                servers: [{
                  guildId: sourceGuildId,
                  guildName: sourceGuildName,
                  joinedAt: member.joinedAt || new Date(),
                  isPresent: true
                }]
              }
            },
            upsert: true
          }
        }));

      if (operations.length === 0) return 0;

      const result = await MemberDetail.bulkWrite(operations, { ordered: false });

      return result.upsertedCount + result.modifiedCount;

    } catch (error) {
      // Ignorer les erreurs de duplicate key (attendues avec upsert)
      if (!error.message?.includes('E11000')) {
        console.error('❌ [MemberDetection] Erreur bulk save:', error.message);
      }
      return 0;
    }
  }

  /**
   * ⏱️ Utilitaire de délai
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 📈 Obtenir les statistiques du dernier scan
   */
  getLastScanStats(guildId) {
    return this.lastScanResults.get(guildId) || null;
  }

  /**
   * 🔄 Vérifier si un scan est en cours
   */
  isScanRunning() {
    return this.isRunning;
  }
}

module.exports = MemberDetectionService;
