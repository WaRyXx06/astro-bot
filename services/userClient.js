const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const ServerConfig = require('../models/ServerConfig');

// Import du système de logging au niveau du module (fix crash loop)
let logConfig = null;
try {
  logConfig = require('../config/logConfig');
} catch (error) {
  console.warn('⚠️ Module logConfig non disponible, utilisation des logs par défaut');
  // Fallback si le module n'est pas disponible
  logConfig = {
    shouldLog: () => true,
    LOG_LEVELS: { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 },
    logCompressedMessage: (id, author, channel, status) => {
      console.log(`📨 MSG#${id.slice(-6)} | ${author} → #${channel} | ${status}`);
    }
  };
}

class UserClientService {
  constructor() {
    this.userTokens = new Map(); // Map<guildId, {token, userData, guilds, sourceGuildId}>
    this.apiBase = 'https://discord.com/api/v10';

    // Cache des channels inaccessibles (403/404) pour éviter le spam d'appels API
    // Map<channelId, { timestamp: Date, errorCode: number }>
    this.failedChannelCache = new Map();
    this.FAILED_CHANNEL_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

    // 🚀 NOUVEAUX : Gestion des selfbots événementiels
    this.selfbots = new Map(); // Map<targetGuildId, selfbot>
    this.eventHandlers = new Map(); // Map<targetGuildId, {scraper, targetGuild, sourceGuild}>
    this.heartbeatIntervals = new Map(); // Map<targetGuildId, intervalId>
    this.reconnecting = new Set(); // Set<targetGuildId> — empêche double reconnexion

    // Nettoyage périodique du failedChannelCache (toutes les 10 min)
    this._failedChannelCleanupInterval = setInterval(() => {
      const now = Date.now();
      let cleaned = 0;
      for (const [key, value] of this.failedChannelCache.entries()) {
        if (now - value.timestamp > this.FAILED_CHANNEL_CACHE_TTL) {
          this.failedChannelCache.delete(key);
          cleaned++;
        }
      }
      if (cleaned > 0) {
        console.log(`🧹 [UserClient] failedChannelCache: ${cleaned} entrées expirées supprimées, ${this.failedChannelCache.size} restantes`);
      }
    }, 10 * 60 * 1000);
    
    // 🚀 OPTIMISATIONS ANTI-DÉTECTION (headers variés)
    this.userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:122.0) Gecko/20100101 Firefox/122.0'
    ];
    
    this.languages = [
      'en-US,en;q=0.9',
      'en-GB,en;q=0.9',
      'fr-FR,fr;q=0.9,en;q=0.8',
      'en-US,en;q=0.9,fr;q=0.8',
      'en-CA,en;q=0.9',
      'de-DE,de;q=0.9,en;q=0.8'
    ];
    
    this.encodings = [
      'gzip, deflate, br',
      'gzip, deflate',
      'br, gzip, deflate'
    ];
  }

  
  // 🎯 GÉNÉRATEUR DE HEADERS ET OPTIONS OPTIMISÉS
  getRandomRequestOptions(userToken) {
    const randomUserAgent = this.userAgents[Math.floor(Math.random() * this.userAgents.length)];
    const randomLanguage = this.languages[Math.floor(Math.random() * this.languages.length)];
    const randomEncoding = this.encodings[Math.floor(Math.random() * this.encodings.length)];
    
    return {
      headers: {
        'Authorization': userToken,
        'User-Agent': randomUserAgent,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': randomLanguage,
        'Accept-Encoding': randomEncoding,
        'Cache-Control': Math.random() > 0.5 ? 'no-cache' : 'max-age=0',
        'DNT': Math.random() > 0.7 ? '1' : undefined,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site'
      },
      timeout: 15000 // Timeout 15s
    };
  }
  
  // 🎯 DÉLAI ANTI-DÉTECTION OPTIMISÉ
  async smartDelay(baseMs = 200) {
    // Jitter agressif entre 50% et 150% du délai de base
    const jitter = Math.random() * baseMs + (baseMs * 0.5);
    await new Promise(resolve => setTimeout(resolve, jitter));
  }
  
  // 🚀 REQUÊTE AVEC RETRY AUTOMATIQUE SIMPLE
  async fetchWithRetry(url, userToken, maxRetries = 2) {
    let lastError = null;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const options = this.getRandomRequestOptions(userToken);
        const response = await fetch(url, options);
        
        if (!response.ok) {
          const errorText = await response.text();
          const error = new Error(`API Error ${response.status}: ${errorText}`);
          throw error;
        }
        
        // Succès - retourner le résultat
        return await response.json();
        
      } catch (error) {
        lastError = error;
        
        // Erreurs qui justifient un retry
        const retryableErrors = [
          '503', '429', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED',
          'socket hang up', 'network timeout'
        ];
        
        const shouldRetry = retryableErrors.some(errorType => 
          error.message.toLowerCase().includes(errorType.toLowerCase())
        );
        
        if (shouldRetry && attempt < maxRetries) {
          
          // Pour les erreurs 429, délai plus long
          const delay = error.message.includes('429') ? 3000 : 1500;
          
          // Délai avant retry
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        // Erreur non-retryable ou tentatives épuisées
        break;
      }
    }
    
    // Si on arrive ici, toutes les tentatives ont échoué
    throw lastError;
  }

  // Restaurer la configuration au démarrage
  async restoreFromDatabase() {
    try {
      const configs = await ServerConfig.find({});
      
      for (const config of configs) {
        // Incrémenter le compteur de crash
        config.crashCount += 1;
        config.lastCrash = new Date();
        
        // Marquer comme nécessitant une reconfiguration de token
        config.needsTokenReconfig = true;
        
        await config.save();
      }
      
      return configs;
    } catch (error) {
      console.error('❌ Erreur restauration configuration:', error);
      return [];
    }
  }

  // Sauvegarder la configuration en base
  async saveConfiguration(targetGuildId, sourceGuildId, sourceGuildName, userAccount, scrapingActive = false) {
    try {
      const config = await ServerConfig.findOneAndUpdate(
        { guildId: targetGuildId },
        {
          guildId: targetGuildId,
          sourceGuildId: sourceGuildId,
          sourceGuildName: sourceGuildName,
          lastUserAccount: userAccount,
          scrapingActive: scrapingActive,
          needsTokenReconfig: false,
          configuredAt: new Date()
        },
        { upsert: true, new: true }
      );
      
      return config;
    } catch (error) {
      console.error('❌ Erreur sauvegarde configuration:', error);
      throw error;
    }
  }

  // Ajouter un token utilisateur pour une guilde
  async addUserToken(targetGuildId, userToken, sourceGuildId = null) {
    try {
      
      // Tester le token
      const userData = await this.fetchUserProfile(userToken);
      const userGuilds = await this.fetchUserGuilds(userToken);
      
      // Vérifier que le serveur source est accessible si spécifié
      if (sourceGuildId) {
        const sourceGuild = userGuilds.find(g => g.id === sourceGuildId);
        if (!sourceGuild) {
          throw new Error(`Serveur ${sourceGuildId} non accessible avec ce token utilisateur`);
        }
      }
      
      // Stocker le token avec les données
      this.userTokens.set(targetGuildId, {
        token: userToken,
        userData: userData,
        guilds: userGuilds,
        sourceGuildId: sourceGuildId,
        addedAt: new Date()
      });
      
      // Sauvegarder la configuration en base de données
      if (sourceGuildId) {
        const sourceGuild = userGuilds.find(g => g.id === sourceGuildId);
        await this.saveConfiguration(
          targetGuildId, 
          sourceGuildId, 
          sourceGuild.name,
          `${userData.username}#${userData.discriminator}`
        );
      }
      
      if (sourceGuildId) {
        const sourceGuild = userGuilds.find(g => g.id === sourceGuildId);
      }
      
      return {
        success: true,
        userData: userData,
        guildsCount: userGuilds.length,
        sourceGuildId: sourceGuildId
      };
      
    } catch (error) {
      console.error('❌ Erreur ajout token utilisateur:', error);
      throw new Error(`Token utilisateur invalide: ${error.message}`);
    }
  }

  // Marquer le scraping comme actif en base
  async markScrapingActive(targetGuildId) {
    try {
      await ServerConfig.updateOne(
        { guildId: targetGuildId },
        { 
          scrapingActive: true, 
          lastStarted: new Date(),
          needsTokenReconfig: false 
        }
      );
    } catch (error) {
      console.error('❌ Erreur marquage scraping actif:', error);
    }
  }

  // Marquer le scraping comme arrêté en base
  async markScrapingInactive(targetGuildId) {
    try {
      await ServerConfig.updateOne(
        { guildId: targetGuildId },
        { 
          scrapingActive: false, 
          lastStopped: new Date() 
        }
      );
    } catch (error) {
      console.error('❌ Erreur marquage scraping inactif:', error);
    }
  }

  // Obtenir la configuration sauvegardée
  async getSavedConfig(targetGuildId) {
    try {
      return await ServerConfig.findOne({ guildId: targetGuildId });
    } catch (error) {
      console.error('❌ Erreur récupération config:', error);
      return null;
    }
  }

  // Vérifier si une restauration automatique est possible
  async canAutoRestore(targetGuildId) {
    const config = await this.getSavedConfig(targetGuildId);
    return config && config.sourceGuildId && config.needsTokenReconfig;
  }

  // Restaurer automatiquement après reconfiguration du token
  async autoRestore(targetGuildId) {
    try {
      const config = await this.getSavedConfig(targetGuildId);
      if (!config) return null;
      
      // Marquer comme n'ayant plus besoin de reconfiguration
      config.needsTokenReconfig = false;
      await config.save();
      
      return {
        shouldRestore: config.scrapingActive,
        sourceGuildId: config.sourceGuildId,
        sourceGuildName: config.sourceGuildName,
        lastUserAccount: config.lastUserAccount,
        scrapingSettings: config.scrapingSettings
      };
    } catch (error) {
      console.error('❌ Erreur auto-restauration:', error);
      return null;
    }
  }

  // Récupérer le profil utilisateur
  async fetchUserProfile(userToken) {
    await this.smartDelay(150); // Délai préventif
    
    const options = this.getRandomRequestOptions(userToken);
    const response = await fetch(`${this.apiBase}/users/@me`, options);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API Error ${response.status}: ${errorText}`);
    }

    return await response.json();
  }

  // Récupérer les serveurs de l'utilisateur
  async fetchUserGuilds(userToken) {
    await this.smartDelay(180); // Délai préventif
    
    const options = this.getRandomRequestOptions(userToken);
    const response = await fetch(`${this.apiBase}/users/@me/guilds`, options);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API Error ${response.status}: ${errorText}`);
    }

    return await response.json();
  }

  // Récupérer les salons d'un serveur spécifique
  async fetchGuildChannels(userToken, guildId) {
    await this.smartDelay(200); // Délai préventif
    
    return await this.fetchWithRetry(`${this.apiBase}/guilds/${guildId}/channels`, userToken, 1);
  }

  // Récupérer les rôles d'un serveur
  async fetchGuildRoles(userToken, guildId) {
    await this.smartDelay(220); // Délai préventif
    
    return await this.fetchWithRetry(`${this.apiBase}/guilds/${guildId}/roles`, userToken, 1);
  }

  // 🧵 Récupérer un thread spécifique par son ID (compatible token utilisateur)
  async fetchThreadById(userToken, threadId) {
    // Vérifier le cache des channels inaccessibles avant l'appel API
    const cached = this.failedChannelCache.get(threadId);
    if (cached && (Date.now() - cached.timestamp) < this.FAILED_CHANNEL_CACHE_TTL) {
      throw new Error(`API Error ${cached.errorCode}: channel ${threadId} inaccessible (cached)`);
    }
    // Entrée expirée → nettoyer
    if (cached) {
      this.failedChannelCache.delete(threadId);
    }

    try {
      await this.smartDelay(200);

      const threadData = await this.fetchWithRetry(`${this.apiBase}/channels/${threadId}`, userToken, 1);

      return threadData;

    } catch (error) {
      // Cacher les erreurs 403 (Missing Access) et 404 (Not Found) pour éviter le spam
      const is403or404 = error.message.includes('403') || error.message.includes('404');
      if (is403or404) {
        const errorCode = error.message.includes('403') ? 403 : 404;
        this.failedChannelCache.set(threadId, { timestamp: Date.now(), errorCode });
        console.error(`❌ Erreur fetchThreadById pour ${threadId}: ${error.message} (mis en cache ${this.FAILED_CHANNEL_CACHE_TTL / 60000}min)`);
      } else {
        console.error(`❌ Erreur fetchThreadById pour ${threadId}:`, error.message);
      }
      throw error;
    }
  }

  // 🧵 Vérifier si un canal est un thread (types 11, 12)
  async isChannelThread(userToken, channelId) {
    try {
      const channelData = await this.fetchThreadById(userToken, channelId);
      return channelData.type === 11 || channelData.type === 12; // PUBLIC_THREAD ou PRIVATE_THREAD
    } catch (error) {
      return false;
    }
  }

  // 🧵 Méthode de fallback - retourne toujours un tableau vide (compatible avec l'ancien code)
  async fetchGuildThreads(userToken, guildId) {
    return []; // Retourner un tableau vide pour éviter les erreurs
  }

  // Récupérer les messages d'un salon (SUPPORT TEMPS RÉEL avec 'after')
  async fetchChannelMessages(userToken, channelId, limit = 50, before = null, after = null) {
    await this.smartDelay(100); // Délai réduit mais avec jitter
    
    let url = `${this.apiBase}/channels/${channelId}/messages?limit=${limit}`;
    if (before) {
      url += `&before=${before}`;
    }
    if (after) {
      url += `&after=${after}`;
    }

    return await this.fetchWithRetry(url, userToken, 2);
  }

  // Récupérer les détails d'un serveur
  async fetchGuildDetails(userToken, guildId) {
    try {
      await this.smartDelay();
      
      const guildData = await this.fetchWithRetry(
        `https://discord.com/api/v10/guilds/${guildId}`,
        userToken
      );
      
      return guildData;
    } catch (error) {
      console.error(`❌ Erreur fetchGuildDetails pour ${guildId}:`, error.message);
      throw error;
    }
  }

  // 📊 NOUVEAU : Récupérer le nombre de membres avec précision maximale
  async fetchGuildMemberCount(userToken, guildId) {
    try {
      await this.smartDelay();
      
      // Utiliser l'endpoint avec with_counts=true pour la précision maximale
      const guild = await this.fetchWithRetry(
        `https://discord.com/api/v10/guilds/${guildId}?with_counts=true`,
        userToken
      );
      
      return {
        totalMembers: guild.approximate_member_count || guild.member_count || 0,
        onlineMembers: guild.approximate_presence_count || 0,
        guildName: guild.name,
        guildId: guildId,
        timestamp: new Date()
      };
    } catch (error) {
      console.error(`❌ Erreur fetchGuildMemberCount pour ${guildId}:`, error.message);
      throw error;
    }
  }

  // 🔐 Vérifier si on a accès à la liste des membres
  async checkMemberListPermission(userToken, guildId) {
    try {

      // Test simple avec l'endpoint search
      const url = `https://discord.com/api/v9/guilds/${guildId}/members/search?query=&limit=1`;
      const response = await fetch(url, {
        headers: {
          'Authorization': userToken,
          'User-Agent': this.getRandomUserAgent()
        }
      });

      if (response.status === 403) {
        return false;
      }

      if (response.ok) {
        return true;
      }

      return false;

    } catch (error) {
      console.error(`❌ Erreur vérification permissions:`, error.message);
      return false;
    }
  }

  // 📦 Récupérer les membres depuis le cache du selfbot
  async fetchMembersFromCache(guildId, targetGuildId) {
    try {

      // Récupérer le selfbot pour ce serveur
      const selfbot = this.selfbots.get(targetGuildId);
      if (!selfbot) {
        return null;
      }

      // Récupérer le guild depuis le cache du selfbot
      const guild = selfbot.guilds.cache.get(guildId);
      if (!guild) {
        return null;
      }

      // Utiliser directement le cache des membres
      let cachedMembers = guild.members.cache;

      // Calculer le taux de cache
      let cacheRatio = (cachedMembers.size / guild.memberCount) * 100;

      // Si le cache est insuffisant (<50%), forcer le fetch
      if (cacheRatio < 50) {
        try {
          const startTime = Date.now();
          const members = await guild.members.fetch({ limit: 0, withPresences: false, force: true, time: 30000 });
          const fetchTime = ((Date.now() - startTime) / 1000).toFixed(2);

          // Mettre à jour les variables avec le nouveau cache
          cachedMembers = members;
          cacheRatio = (cachedMembers.size / guild.memberCount) * 100;
        } catch (fetchErr) {
          // Log silencieux - le cache existant sera utilisé en fallback
          console.warn(`⚠️ [getMembersFromCache] Fetch forcé échoué pour ${guild.name}: ${fetchErr.message}`);
        }
      }

      if (cachedMembers.size === 0) {
        return null;
      }

      // Convertir la Collection en array pour compatibilité
      const memberArray = Array.from(cachedMembers.values()).map(member => ({
        user: {
          id: member.user.id,
          username: member.user.username,
          discriminator: member.user.discriminator,
          avatar: member.user.avatar,
          bot: member.user.bot || false
        },
        nick: member.nickname,
        roles: member.roles.cache.map(role => role.id),
        joined_at: member.joinedTimestamp
      }));

      return memberArray;

    } catch (error) {
      console.error(`❌ Erreur cache fetch:`, error);
      return null;
    }
  }

  // 🚀 Récupérer les membres via WebSocket (opcode 8)
  async fetchMembersViaWebSocket(guildId, targetGuildId) {
    try {

      // Récupérer le selfbot pour ce serveur
      const selfbot = this.selfbots.get(targetGuildId);
      if (!selfbot) {
        return null;
      }

      // Récupérer le guild depuis le cache du selfbot
      const guild = selfbot.guilds.cache.get(guildId);
      if (!guild) {
        return null;
      }

      // Vérifier d'abord si le cache est suffisant
      const cachedMembers = guild.members.cache;
      const cacheRatio = (cachedMembers.size / guild.memberCount) * 100;

      // Si le cache est complet ou presque (>95%), pas besoin de fetch
      if (cacheRatio >= 95) {

        // Convertir la Collection en array pour compatibilité
        const memberArray = Array.from(cachedMembers.values()).map(member => ({
          user: {
            id: member.user.id,
            username: member.user.username,
            discriminator: member.user.discriminator,
            avatar: member.user.avatar,
            bot: member.user.bot || false
          },
          nick: member.nickname,
          roles: member.roles.cache.map(role => role.id),
          joined_at: member.joinedTimestamp
        }));

        return memberArray;
      }


      // Utiliser la méthode native de discord.js-selfbot-v13
      // Cette méthode envoie l'opcode 8 (REQUEST_GUILD_MEMBERS) via WebSocket
      const startTime = Date.now();
      const members = await guild.members.fetch({
        limit: 0,          // 0 = récupérer tous les membres
        withPresences: false,  // Pas besoin des présences (plus rapide)
        force: true,       // Forcer le fetch même si en cache
        time: 120000      // Timeout de 2 minutes pour les gros serveurs
      });

      const fetchTime = ((Date.now() - startTime) / 1000).toFixed(2);

      // Convertir la Collection en array pour compatibilité
      const memberArray = Array.from(members.values()).map(member => ({
        user: {
          id: member.user.id,
          username: member.user.username,
          discriminator: member.user.discriminator,
          avatar: member.user.avatar,
          bot: member.user.bot || false
        },
        nick: member.nickname,
        roles: member.roles.cache.map(role => role.id),
        joined_at: member.joinedTimestamp
      }));

      return memberArray;

    } catch (error) {
      console.error(`❌ Erreur WebSocket fetch:`, error);
      if (error.code === 'GUILD_MEMBERS_TIMEOUT') {
      }
      return null;
    }
  }

  // 📜 Récupérer les membres via simulation de scroll (opcode 14 - LAZY_REQUEST) avec retry
  async fetchMembersViaLazyRequestWithRetry(guildId, targetGuildId, maxAttempts = 3) {
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {

      try {
        const result = await this.fetchMembersViaLazyRequest(guildId, targetGuildId);

        if (result && result.length > 0) {
          return result;
        } else if (attempt < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      } catch (error) {
        lastError = error;
        console.error(`❌ Erreur tentative ${attempt}: ${error.message}`);

        if (attempt < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
    }

    console.error(`❌ Échec après ${maxAttempts} tentatives`);
    throw lastError || new Error('Lazy Request failed after all attempts');
  }

  // 📜 Méthode interne de récupération (sans retry)
  async fetchMembersViaLazyRequest(guildId, targetGuildId) {
    try {

      // Récupérer le selfbot pour ce serveur
      const selfbot = this.selfbots.get(targetGuildId);
      if (!selfbot) {
        return null;
      }


      // Attendre que le selfbot soit prêt si nécessaire
      if (!selfbot.isReady()) {
        await new Promise((resolve, reject) => {
          const readyTimeout = setTimeout(() => {
            console.error(`❌ Timeout: Selfbot n'est pas devenu prêt après 10 secondes`);
            reject(new Error('Timeout waiting for selfbot ready'));
          }, 10000);

          // Vérifier si déjà prêt
          if (selfbot.isReady()) {
            clearTimeout(readyTimeout);
            resolve();
          } else {
            // Attendre l'événement ready
            selfbot.once('ready', () => {
              clearTimeout(readyTimeout);
              resolve();
            });
          }
        }).catch(err => {
          console.error(`❌ Impossible d'attendre que le selfbot soit prêt: ${err.message}`);
          return null;
        });

        // Revérifier après l'attente
        if (!selfbot.isReady()) {
          console.error(`❌ Selfbot toujours pas prêt après attente`);
          return null;
        }

      }

      // Récupérer le guild depuis le cache du selfbot
      const guild = selfbot.guilds.cache.get(guildId);
      if (!guild) {
        return null;
      }

      // Récupérer les channels du serveur pour simuler le scroll
      const channels = guild.channels.cache;
      if (channels.size === 0) {
        return null;
      }

      // Utiliser le premier canal texte ou le canal @everyone
      let targetChannel = channels.find(ch => ch.type === 'GUILD_TEXT' || ch.type === 0);
      if (!targetChannel) {
        targetChannel = channels.first();
      }


      // Créer une Map pour stocker tous les membres uniques
      const allMembers = new Map();

      // Créer un Promise qui se résout quand on reçoit les membres
      return new Promise((resolve, reject) => {
        let receivedChunks = 0;
        let lastChunkSize = 100;
        let currentRange = 0;
        const maxRange = Math.min(guild.memberCount * 2, 10000); // Ajuster selon la taille du serveur
        const rangeStep = 100; // Nombre de membres par requête
        let noNewMembersCount = 0; // Compteur pour détecter quand on n'a plus de nouveaux membres

        // Timeout global de 30 secondes
        const timeout = setTimeout(() => {
          selfbot.removeListener('raw', handleRaw);
          resolve(this.formatMembersFromLazyRequest(allMembers));
        }, 30000);

        // Gestionnaire pour les événements GUILD_MEMBER_LIST_UPDATE
        const handleRaw = (packet) => {
          // Debug: Log all raw events to see what we're receiving
          if (packet.t) {
          }

          if (packet.t === 'GUILD_MEMBER_LIST_UPDATE') {
            const data = packet.d;

            if (data.guild_id !== guildId) {
              return;
            }

            // Traiter les opérations de mise à jour
            if (data.ops) {
              for (const op of data.ops) {
                if (op.op === 'SYNC' && op.items) {
                  for (const item of op.items) {
                    if (item.member) {
                      allMembers.set(item.member.user.id, item.member);
                    }
                  }
                  lastChunkSize = op.items.filter(i => i.member).length;
                } else if (op.op === 'UPDATE' && op.item?.member) {
                  allMembers.set(op.item.member.user.id, op.item.member);
                } else if (op.op === 'INSERT' && op.item?.member) {
                  allMembers.set(op.item.member.user.id, op.item.member);
                }
              }
            }

            receivedChunks++;
            const previousSize = allMembers.size;

            // Vérifier si on a reçu de nouveaux membres
            if (allMembers.size === previousSize) {
              noNewMembersCount++;
            } else {
              noNewMembersCount = 0; // Reset si on a de nouveaux membres
            }

            // Conditions d'arrêt améliorées
            const hasEnoughMembers = allMembers.size >= guild.memberCount * 0.90; // 90% des membres
            const noMoreMembers = noNewMembersCount >= 3; // 3 chunks sans nouveaux membres
            const reachedEnd = currentRange >= maxRange;

            if (!hasEnoughMembers && !noMoreMembers && !reachedEnd && lastChunkSize > 0) {
              // Continuer le scroll
              sendNextLazyRequest();
            } else {
              // Arrêter le scroll
              clearTimeout(timeout);
              selfbot.removeListener('raw', handleRaw);

              const percentage = ((allMembers.size / guild.memberCount) * 100).toFixed(1);
              if (hasEnoughMembers) {
              } else if (noMoreMembers) {
              } else {
              }

              resolve(this.formatMembersFromLazyRequest(allMembers));
            }
          }
        };

        // Fonction pour envoyer la prochaine requête LAZY_REQUEST
        const sendNextLazyRequest = () => {
          const ranges = [[currentRange, Math.min(currentRange + rangeStep - 1, maxRange)]];

          const payload = {
            op: 14, // LAZY_REQUEST
            d: {
              guild_id: guildId,
              typing: true,
              threads: true,
              activities: true,
              members: ranges,
              channels: {
                [targetChannel.id]: ranges
              },
              thread_member_lists: [],
              // Options supplémentaires pour forcer le chargement complet
              offline: true,  // Inclure les membres hors ligne
              presences: true // Inclure les présences
            }
          };


          // Envoyer via WebSocket - Essayer plusieurs méthodes

          let sent = false;
          let sendError = null;

          if (selfbot.ws && selfbot.ws.status === 0) { // 0 = READY dans discord.js-selfbot-v13
            // Méthode 1: Via shards (méthode préférée)
            if (selfbot.ws.shards && selfbot.ws.shards.size > 0) {
              try {
                selfbot.ws.shards.first().send(payload);
                sent = true;
              } catch (err) {
                sendError = err;
              }
            }

            // Méthode 2: Via broadcast si shards échoue
            if (!sent && selfbot.ws.broadcast) {
              try {
                selfbot.ws.broadcast(payload);
                sent = true;
              } catch (err) {
                sendError = err;
              }
            }

            // Méthode 3: Accès direct au socket (dernier recours)
            if (!sent) {
              // Chercher le socket sous-jacent
              const possibleSockets = [
                selfbot.ws._socket,
                selfbot.ws.connection,
                selfbot.ws.socket
              ];

              for (const socket of possibleSockets) {
                if (!sent && socket && socket.send) {
                  try {
                    socket.send(JSON.stringify(payload));
                    sent = true;
                    break;
                  } catch (err) {
                    sendError = err;
                  }
                }
              }
            }

            if (sent) {
              currentRange += rangeStep;
            } else {
              clearTimeout(timeout);
              console.error(`❌ Impossible d'envoyer via WebSocket - Toutes les méthodes ont échoué`);
              console.error(`Dernière erreur: ${sendError?.message || 'Unknown'}`);
              reject(new Error(`Impossible d'envoyer via WebSocket: ${sendError?.message || 'Aucune méthode disponible'}`));
            }
          } else {
            clearTimeout(timeout);
            console.error(`❌ WebSocket non disponible ou pas prêt (status: ${selfbot.ws?.status || 'undefined'})`);
            reject(new Error('WebSocket non disponible ou pas prêt'));
          }
        };

        // Écouter les événements raw
        selfbot.on('raw', handleRaw);

        // Démarrer le premier scroll
        sendNextLazyRequest();
      });

    } catch (error) {
      console.error(`❌ Erreur Lazy Request:`, error);
      return null;
    }
  }

  // Formater les membres récupérés via LAZY_REQUEST
  formatMembersFromLazyRequest(membersMap) {
    const memberArray = [];

    for (const member of membersMap.values()) {
      memberArray.push({
        user: {
          id: member.user.id,
          username: member.user.username,
          discriminator: member.user.discriminator || '0',
          avatar: member.user.avatar,
          bot: member.user.bot || false
        },
        nick: member.nick || null,
        roles: member.roles || [],
        joined_at: member.joined_at
      });
    }

    return memberArray;
  }

  // 🔍 Récupérer les membres via l'endpoint de recherche avec plusieurs queries
  async fetchGuildMembers(userToken, guildId, limit = 10000, targetGuildId = null) {
    const allMembers = new Map(); // Utiliser Map pour dédupliquer par ID
    let totalFetched = 0;

    try {

      // 🚀 PRIORITÉ 1: Essayer d'abord le CACHE si on a un targetGuildId
      if (targetGuildId) {
        const cacheMembers = await this.fetchMembersFromCache(guildId, targetGuildId);

        if (cacheMembers && cacheMembers.length > 0) {
          return cacheMembers;
        } else {
        }

        // PRIORITÉ 2: Simulation de scroll (LAZY_REQUEST) si le cache n'est pas suffisant - avec retry
        const lazyMembers = await this.fetchMembersViaLazyRequestWithRetry(guildId, targetGuildId, 2);

        if (lazyMembers && lazyMembers.length > 0) {
          return lazyMembers;
        } else {
        }

        // PRIORITÉ 3: WebSocket si la simulation de scroll échoue
        const wsMembers = await this.fetchMembersViaWebSocket(guildId, targetGuildId);

        if (wsMembers && wsMembers.length > 0) {
          return wsMembers;
        } else {
        }
      }

      // Vérifier d'abord si on a accès via API
      const hasAccess = await this.checkMemberListPermission(userToken, guildId);
      if (!hasAccess) {
        // Si on n'a pas tenté WebSocket, essayer maintenant
        if (!targetGuildId) {
          // Trouver le targetGuildId depuis nos données
          for (const [tGuildId, data] of this.userTokens.entries()) {
            if (data.sourceGuildId === guildId) {
              const wsMembers = await this.fetchMembersViaWebSocket(guildId, tGuildId);
              if (wsMembers && wsMembers.length > 0) {
                return wsMembers;
              }
              break;
            }
          }
        }
        return [];
      }

      // Liste de queries à essayer pour récupérer plus de membres
      // Stratégie: rechercher avec différents préfixes pour maximiser la couverture
      const searchQueries = [
        '',  // Query vide - récupère les 100 premiers
        'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
        'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
        '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
        '_', '-', '.', '[', '!', '@', '#', '$', '%', '^', '&', '*'
      ];


      // Parcourir chaque query
      for (let queryIndex = 0; queryIndex < searchQueries.length; queryIndex++) {
        const query = searchQueries[queryIndex];
        const queryDisplay = query === '' ? 'vide' : query;

        // Si on a déjà assez de membres, arrêter
        if (allMembers.size >= limit) {
          break;
        }

        // Délai aléatoire entre 3 et 6 secondes entre les queries
        if (queryIndex > 0) {
          const delay = Math.floor(Math.random() * 3000) + 3000;
          await new Promise(resolve => setTimeout(resolve, delay));
        }


        // Faire la requête pour cette query
        const membersForQuery = await this.searchMembersWithQuery(userToken, guildId, query);

        if (!membersForQuery || membersForQuery.length === 0) {
          continue;
        }

        // Ajouter les membres à la Map (déduplique automatiquement)
        let newMembers = 0;
        for (const member of membersForQuery) {
          if (!allMembers.has(member.user.id)) {
            allMembers.set(member.user.id, member);
            newMembers++;
          }
        }

        totalFetched += membersForQuery.length;

        // Si on obtient une erreur ou très peu de nouveaux membres, arrêter
        if (newMembers < 5 && queryIndex > 10) {
          break;
        }
      }

      // Convertir la Map en array
      const members = Array.from(allMembers.values());

      if (totalFetched > 0) {
      }

      return members;

    } catch (error) {
      console.error(`❌ Erreur lors de la récupération des membres:`, error);
      return Array.from(allMembers.values());
    }
  }

  // 🔍 Fonction helper pour faire une recherche avec une query spécifique
  async searchMembersWithQuery(userToken, guildId, query = '') {
    const batchSize = 100; // Discord limite à 100 pour la recherche
    let retryCount = 0;
    const maxRetries = 2;

    while (retryCount < maxRetries) {
      try {
        const url = `https://discord.com/api/v9/guilds/${guildId}/members/search?query=${encodeURIComponent(query)}&limit=${batchSize}`;

        // Headers spéciaux pour simuler un vrai client Discord
        const headers = {
          'Authorization': userToken,
          'User-Agent': this.getRandomUserAgent(),
          'Accept': '*/*',
          'Accept-Language': 'fr-FR,fr;q=0.9',
          'Cache-Control': 'no-cache',
          'Content-Type': 'application/json',
          'Origin': 'https://discord.com',
          'Pragma': 'no-cache',
          'Referer': `https://discord.com/channels/${guildId}`,
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
          'X-Debug-Options': 'bugReporterEnabled',
          'X-Discord-Locale': 'fr',
          'X-Discord-Timezone': 'Europe/Paris',
          'X-Super-Properties': this.getSuperProperties()
        };

        const response = await fetch(url, {
          method: 'GET',
          headers: headers
        });

        if (response.status === 429) {
          // Rate limit - attendre et réessayer
          const retryAfter = response.headers.get('retry-after');
          const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : 10000;
          await new Promise(resolve => setTimeout(resolve, waitTime));
          retryCount++;
          continue;
        }

        if (response.status === 403 || response.status === 401) {
          console.error(`   ❌ Token invalide ou accès refusé (${response.status})`);
          return [];
        }

        if (!response.ok) {
          return [];
        }

        const data = await response.json();
        return data || [];

      } catch (fetchError) {
        console.error(`   ❌ Erreur fetch pour query "${query}":`, fetchError.message);
        retryCount++;
        if (retryCount < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
    }

    return [];
  }

  // 🔐 Générer les Super Properties pour simuler un vrai client Discord
  getSuperProperties() {
    const props = {
      "os": "Windows",
      "browser": "Chrome",
      "device": "",
      "system_locale": "fr-FR",
      "browser_user_agent": this.getRandomUserAgent(),
      "browser_version": "120.0.0.0",
      "os_version": "10",
      "referrer": "",
      "referring_domain": "",
      "referrer_current": "",
      "referring_domain_current": "",
      "release_channel": "stable",
      "client_build_number": 270889,
      "client_event_source": null
    };
    return Buffer.from(JSON.stringify(props)).toString('base64');
  }

  // 🔐 Obtenir un User-Agent aléatoire
  getRandomUserAgent() {
    return this.userAgents[Math.floor(Math.random() * this.userAgents.length)];
  }

  // Obtenir les données utilisateur pour une guilde
  getUserData(targetGuildId) {
    const userData = this.userTokens.get(targetGuildId);
    if (!userData) {
      throw new Error('Aucun token utilisateur configuré pour cette guilde');
    }
    return userData;
  }

  // Obtenir un serveur spécifique accessible par l'utilisateur
  getUserGuild(targetGuildId, sourceGuildId) {
    const userData = this.getUserData(targetGuildId);
    const guild = userData.guilds.find(g => g.id === sourceGuildId);
    if (!guild) {
      throw new Error(`Serveur ${sourceGuildId} non accessible avec ce token utilisateur`);
    }
    return guild;
  }

  // Lister tous les serveurs accessibles
  listUserGuilds(targetGuildId) {
    const userData = this.getUserData(targetGuildId);
    return userData.guilds.map(guild => ({
      id: guild.id,
      name: guild.name,
      icon: guild.icon,
      owner: guild.owner,
      permissions: guild.permissions
    }));
  }

  // Supprimer le token utilisateur
  removeUserToken(targetGuildId) {
    const removed = this.userTokens.delete(targetGuildId);
    if (removed) {
    }
    return removed;
  }

  // Vérifier si un token utilisateur est configuré
  hasUserToken(targetGuildId) {
    return this.userTokens.has(targetGuildId);
  }

  // Service de scraping intelligent
  async scrapeChannelMessages(targetGuildId, sourceGuildId, channelId, sinceTimestamp = null) {
    try {
      const userData = this.getUserData(targetGuildId);
      const messages = [];
      let lastMessageId = null;
      let hasMore = true;

      while (hasMore && messages.length < 1000) { // Limite sécurité
        const batch = await this.fetchChannelMessages(
          userData.token, 
          channelId, 
          50, 
          lastMessageId
        );

        if (batch.length === 0) {
          hasMore = false;
          break;
        }

        // Filtrer par timestamp si fourni
        const filteredBatch = sinceTimestamp 
          ? batch.filter(msg => new Date(msg.timestamp) > sinceTimestamp)
          : batch;

        messages.push(...filteredBatch);
        lastMessageId = batch[batch.length - 1].id;

        // Si on a atteint le timestamp limite, arrêter
        if (sinceTimestamp && filteredBatch.length < batch.length) {
          hasMore = false;
        }

        // Délai pour rate limiting
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      return messages.reverse(); // Ordre chronologique
    } catch (error) {
      console.error(`❌ Erreur scraping salon ${channelId}:`, error);
      throw error;
    }
  }

  // Statistiques du service
  getStats() {
    const stats = {
      totalTokens: this.userTokens.size,
      guilds: []
    };

    for (const [guildId, userData] of this.userTokens) {
      stats.guilds.push({
        guildId: guildId,
        username: `${userData.userData.username}#${userData.userData.discriminator}`,
        serversAccessible: userData.guilds.length,
        addedAt: userData.addedAt
      });
    }

    return stats;
  }

  // Obtenir le serveur source configuré
  getSourceGuild(targetGuildId) {
    const userData = this.getUserData(targetGuildId);
    if (!userData.sourceGuildId) {
      throw new Error('Aucun serveur source configuré. Utilisez /start pour configurer automatiquement.');
    }
    
    const sourceGuild = userData.guilds.find(g => g.id === userData.sourceGuildId);
    if (!sourceGuild) {
      throw new Error(`Serveur source ${userData.sourceGuildId} non accessible`);
    }
    
    return sourceGuild;
  }

  // Vérifier si un serveur source est configuré
  hasSourceGuild(targetGuildId) {
    const userData = this.userTokens.get(targetGuildId);
    return userData && userData.sourceGuildId;
  }

  // 🆕 OBTENIR TOUTES LES CONFIGURATIONS POUR LA SURVEILLANCE EN TEMPS RÉEL
  getAllConfigurations() {
    return Array.from(this.userTokens.entries()).map(([guildId, data]) => ({
      targetGuildId: guildId,
      sourceGuildId: data.sourceGuildId,
      userData: data.userData,
      guildsCount: data.guilds?.length || 0,
      addedAt: data.addedAt
    }));
  }

  // 🚀 NOUVEAUX ÉVÉNEMENTIELS : Démarrer les événements WebSocket
  async setupEventListeners(targetGuildId, sourceGuildId, scraper, targetGuild, sourceGuild) {
    try {
      const discord = require('discord.js-selfbot-v13');
      const userToken = this.userTokens.get(targetGuildId)?.token;
      
      if (!userToken) {
        throw new Error('Token utilisateur non configuré');
      }

      // Arrêter l'ancien selfbot s'il existe
      await this.stopEventListeners(targetGuildId);
      
      
      // Créer client selfbot pour les événements
      const selfbot = new discord.Client({
        checkUpdate: false,
        presence: { status: 'invisible' },
        ws: {
          properties: {
            $browser: 'Discord iOS',
            $device: 'iPhone',
            $os: 'iOS'
          }
        },
        // 🧹 Cache management pour éviter la croissance mémoire
        makeCache: discord.Options.cacheWithLimits({
          ...discord.Options.defaultMakeCacheSettings, // Préserve thread sweeping
          MessageManager: 50,          // Compromis: embed detection fallback sans accumulation
          PresenceManager: 0,          // Jamais utilisé
          VoiceStateManager: 0,        // Jamais utilisé
          GuildEmojiManager: 0,        // Selfbot ne lit pas emojis.cache (bot v14 le gère)
          GuildMemberManager: {        // Hard cap FIFO, pas de sweeper (évite thrash)
            maxSize: 2000,
            keepOverLimit: (member) => member.user?.id === selfbot.user?.id
          },
          UserManager: {               // Hard cap FIFO, pas de sweeper
            maxSize: 2000,
            keepOverLimit: (user) => user.id === selfbot.user?.id
          },
          // ReactionManager: défaut (processReactions lit reactions.cache)
          // ChannelManager: défaut (20+ usages critiques)
          // RoleManager: défaut (9 usages critiques)
          // GuildManager: défaut (10 usages critiques)
        }),
        sweepers: {
          messages: {
            interval: 300,   // Sweep toutes les 5 min
            lifetime: 1800   // Messages > 30 min supprimés du cache
          },
          // Pas de sweeper guildMembers/users: hard cap suffit, évite thrash
        }
      });
      
      // Stocker les références pour les handlers
      this.eventHandlers.set(targetGuildId, {
        scraper,
        targetGuild,
        sourceGuild
      });
      
      // Écouter les nouveaux messages
      let messageCount = 0;
      // Utiliser le logConfig importé au niveau du module
      const { shouldLog, LOG_LEVELS, logCompressedMessage } = logConfig;

      selfbot.on('messageCreate', async (message) => {
        messageCount++;

        if (message.guild?.id === sourceGuildId) {
          // Log compact pour les messages du bon serveur
          if (shouldLog(LOG_LEVELS.INFO)) {
            logCompressedMessage(message.id, message.author.tag, message.channel.name, '✅ Processing');
          }
          await this.handleNewMessage(message, targetGuildId);
        } else if (shouldLog(LOG_LEVELS.DEBUG)) {
          // Ne logger les messages ignorés qu'en mode DEBUG
        }
      });
      
      // 🏛️ Écouter la création de nouveaux threads (incluant les posts de forums)
      selfbot.on('threadCreate', async (thread) => {
        if (thread.guild?.id === sourceGuildId) {
          await this.handleNewThread(thread, targetGuildId);
        }
      });

      // 🆕 Écouter la création de nouveaux salons pour auto-récupération
      selfbot.on('channelCreate', async (channel) => {
        if (channel.guild?.id === sourceGuildId) {
          await this.handleNewChannel(channel, targetGuildId);
        }
      });

      // Écouter les modifications de messages
      selfbot.on('messageUpdate', async (oldMsg, newMsg) => {
        if (newMsg.guild?.id === sourceGuildId) {
          await this.handleUpdatedMessage(oldMsg, newMsg, targetGuildId);
        }
      });
      
      // Initialiser rawEventCount en dehors du bloc conditionnel pour éviter ReferenceError
      let rawEventCount = 0;

      // Ajout du listener RAW pour voir TOUS les events (en mode DEBUG uniquement)
      if (logConfig.shouldLog(logConfig.LOG_LEVELS.DEBUG)) {
        selfbot.on('raw', (packet) => {
          rawEventCount++;
          if (rawEventCount % 500 === 0) { // Logger tous les 500 events pour réduire le spam
          }
        });
      }

      // Listener pour les warnings
      selfbot.on('warn', (info) => {
        console.warn(`⚠️ Warning selfbot ${targetGuildId}:`, info);
      });

      // Gestion des erreurs du selfbot
      selfbot.on('error', (error) => {
        console.error(`❌ Erreur selfbot ${targetGuildId}:`, error);

        // Gestion spécifique pour "other side closed" et erreurs de connexion
        if (error.message && (
            error.message.includes('other side closed') ||
            error.message.includes('Connection reset') ||
            error.message.includes('ECONNRESET') ||
            error.message.includes('socket hang up')
        )) {

          // Empêcher double reconnexion (race condition error + disconnect)
          if (this.reconnecting.has(targetGuildId)) return;
          this.reconnecting.add(targetGuildId);

          // Programmer une reconnexion automatique après 30 secondes
          setTimeout(async () => {
            try {
              if (!this.selfbots.has(targetGuildId)) return; // Stoppé manuellement

              // Sauver les handlers AVANT de détruire (stopEventListeners les supprime)
              const handlers = this.eventHandlers.get(targetGuildId);

              // Détruire la connexion existante
              await this.stopEventListeners(targetGuildId);

              if (!handlers) {
                console.error(`❌ Pas de handlers pour reconnexion ${targetGuildId}`);
                return;
              }

              // Attendre un peu puis reconnecter
              await new Promise(resolve => setTimeout(resolve, 5000));

              const { scraper, targetGuild } = handlers;
              const sourceGuildId = handlers.sourceGuild?.id;

              if (!sourceGuildId) {
                console.error(`❌ sourceGuild invalide lors de la reconnexion pour ${targetGuildId}`);
                return;
              }

              await this.setupEventListeners(targetGuildId, sourceGuildId, scraper, targetGuild, handlers.sourceGuild);

              // Rafraîchir sourceGuild depuis le nouveau cache selfbot
              const newSelfbot = this.selfbots.get(targetGuildId);
              const freshGuild = newSelfbot?.guilds?.cache?.get(sourceGuildId);
              if (freshGuild) {
                const newHandlers = this.eventHandlers.get(targetGuildId);
                if (newHandlers) newHandlers.sourceGuild = freshGuild;
              }

              console.log(`✅ Reconnexion automatique réussie pour ${targetGuildId}`);
            } catch (reconnectError) {
              console.error(`❌ Échec reconnexion automatique ${targetGuildId}:`, reconnectError.message);
            } finally {
              this.reconnecting.delete(targetGuildId);
            }
          }, 30000); // 30 secondes
        }
      });
      
      selfbot.on('ready', async () => {
        // Vérifier si le selfbot est dans le serveur source
        const isInSourceGuild = selfbot.guilds.cache.has(sourceGuildId);
        if (isInSourceGuild) {
          const guild = selfbot.guilds.cache.get(sourceGuildId);
          console.log(`📊 [Selfbot] ${guild.name} — members.cache: ${guild.members.cache.size}, users.cache: ${selfbot.users.cache.size}`);
        } else {
          console.error(`❌ ERREUR: Selfbot PAS dans le serveur source ${sourceGuildId}!`);
        }

        // 📊 Monitoring cache sizes toutes les 6h
        const cacheMonitorInterval = setInterval(() => {
          if (!selfbot || selfbot.destroyed) {
            clearInterval(cacheMonitorInterval);
            return;
          }
          const guild = selfbot.guilds.cache.get(sourceGuildId);
          let totalMessages = 0;
          selfbot.channels.cache.forEach(ch => {
            if (ch.messages?.cache) totalMessages += ch.messages.cache.size;
          });
          const mem = process.memoryUsage();
          console.log(`📊 [Selfbot Cache] members: ${guild?.members?.cache?.size ?? '?'}, users: ${selfbot.users.cache.size}, messages: ${totalMessages}, heap: ${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB`);
        }, 6 * 60 * 60 * 1000); // 6 heures
        cacheMonitorInterval.unref(); // Ne pas empêcher le process de s'arrêter
      });
      
      // Gestion des déconnexions WebSocket
      selfbot.on('disconnect', (event) => {

        // Programmer une reconnexion automatique si la déconnexion n'est pas intentionnelle
        if (this.selfbots.has(targetGuildId)) {
          // Empêcher double reconnexion (si error handler a déjà pris la main)
          if (this.reconnecting.has(targetGuildId)) return;
          this.reconnecting.add(targetGuildId);

          setTimeout(async () => {
            try {
              const handlers = this.eventHandlers.get(targetGuildId);
              if (handlers && !selfbot.destroyed) {
                await selfbot.login(this.userTokens.get(targetGuildId)?.token);
                console.log(`✅ Re-login après déconnexion réussi pour ${targetGuildId}`);
              }
            } catch (reconnectError) {
              console.error(`❌ Échec reconnexion après déconnexion ${targetGuildId}:`, reconnectError.message);
            } finally {
              this.reconnecting.delete(targetGuildId);
            }
          }, 15000); // 15 secondes
        }
      });
      
      // Heartbeat toutes les 30 secondes (stocker la ref pour cleanup)
      const heartbeatInterval = setInterval(() => {
        if (!selfbot || selfbot.destroyed) {
          clearInterval(heartbeatInterval);
          this.heartbeatIntervals.delete(targetGuildId);
          return;
        }
        if (selfbot.ws?.status !== 0) { // 0 = READY
          console.warn(`⚠️ [HEARTBEAT] WebSocket status: ${selfbot.ws?.status}`);
        }
      }, 30000);
      this.heartbeatIntervals.set(targetGuildId, heartbeatInterval);

      // Connexion du selfbot
      await selfbot.login(userToken);
      
      // Stocker la référence du selfbot
      this.selfbots.set(targetGuildId, selfbot);
      
      return true;
      
    } catch (error) {
      console.error('❌ Erreur setup événementiel:', error);
      throw error;
    }
  }

  // 🚀 Arrêter les événements WebSocket
  async stopEventListeners(targetGuildId) {
    try {
      // Clear reconnection pending si /stop appelé manuellement
      this.reconnecting.delete(targetGuildId);

      // Nettoyer le heartbeat interval
      const heartbeat = this.heartbeatIntervals.get(targetGuildId);
      if (heartbeat) {
        clearInterval(heartbeat);
        this.heartbeatIntervals.delete(targetGuildId);
      }

      const selfbot = this.selfbots.get(targetGuildId);
      if (selfbot) {
        // Retirer tous les listeners avant destroy pour éviter les fuites
        selfbot.removeAllListeners();
        await selfbot.destroy();
        this.selfbots.delete(targetGuildId);
      }

      this.eventHandlers.delete(targetGuildId);

    } catch (error) {
      console.error('❌ Erreur arrêt événementiel:', error);
    }
  }

  // 🚀 Gérer un nouveau message en temps réel
  async handleNewMessage(sourceMessage, targetGuildId) {
    try {
      const handlers = this.eventHandlers.get(targetGuildId);
      if (!handlers) {
        console.error(`❌ Pas de handlers pour guild ${targetGuildId}`);
        return;
      }

      const { scraper, targetGuild, sourceGuild } = handlers;

      // 🛡️ Validation null-safety pour sourceGuild (fix: erreur "Cannot read properties of null")
      if (!sourceGuild || !sourceGuild.id) {
        console.warn(`⚠️ [handleNewMessage] sourceGuild non disponible pour targetGuild ${targetGuildId}, skip`);
        return;
      }

      // Déléguer au scraper pour traitement
      await scraper.handleEventMessage(sourceMessage, targetGuild, sourceGuild);

    } catch (error) {
      console.error('❌ Erreur traitement nouveau message:', error);
    }
  }

  // 🆕 Gérer la création d'un nouveau salon sur le serveur source
  async handleNewChannel(sourceChannel, targetGuildId) {
    try {
      const handlers = this.eventHandlers.get(targetGuildId);
      if (!handlers) return;

      const { scraper, targetGuild, sourceGuild } = handlers;

      // 🛡️ Validation null-safety pour sourceGuild (fix: erreur "Cannot read properties of undefined")
      if (!sourceGuild || !sourceGuild.id) {
        console.warn(`⚠️ [handleNewChannel] sourceGuild non disponible pour targetGuild ${targetGuildId}, skip`);
        return;
      }

      if (!sourceGuild.channels?.cache) {
        console.warn(`⚠️ [handleNewChannel] sourceGuild.channels.cache non disponible pour ${sourceGuild.id}, skip`);
        return;
      }

      // Vérifier si le salon mirror existe déjà
      const Channel = require('../models/Channel');
      const existingChannel = await Channel.findOne({
        sourceChannelId: sourceChannel.id,
        serverId: sourceGuild.id
      });

      if (existingChannel && existingChannel.discordId && existingChannel.discordId !== 'pending' && !existingChannel.discordId.startsWith('pending_')) {
        // Vérifier que le discordId pointe vers un vrai salon sur le mirror
        const existsOnMirror = targetGuild.channels.cache.has(existingChannel.discordId);
        if (existsOnMirror) return;
        // sinon continuer pour recréer/réparer le mapping
      }

      // Trouver ou créer la catégorie correspondante
      let categoryId = null;
      if (sourceChannel.parentId) {
        const categoryMapping = await Channel.findOne({
          sourceChannelId: sourceChannel.parentId,
          serverId: sourceGuild.id
        });

        if (categoryMapping && categoryMapping.discordId) {
          // Mapping existe déjà
          categoryId = categoryMapping.discordId;
        } else {
          // 🆕 Mapping absent → Créer la catégorie mirror automatiquement
          const sourceCategory = sourceGuild.channels.cache.get(sourceChannel.parentId);

          if (sourceCategory && (sourceCategory.type === 'GUILD_CATEGORY' || sourceCategory.type === 4)) {

            try {
              // Vérifier si la catégorie existe déjà sur le mirror (par nom)
              let mirrorCategory = targetGuild.channels.cache.find(
                ch => (ch.type === 'GUILD_CATEGORY' || ch.type === 4) && ch.name === sourceCategory.name
              );

              if (!mirrorCategory) {
                // Créer la catégorie sur le serveur mirror
                mirrorCategory = await targetGuild.channels.create({
                  name: sourceCategory.name,
                  type: 4, // CategoryChannel
                  position: sourceCategory.position
                });
              } else {
              }

              // Sauvegarder le mapping en base de données
              await Channel.findOneAndUpdate(
                { sourceChannelId: sourceChannel.parentId, serverId: sourceGuild.id },
                {
                  name: sourceCategory.name,
                  discordId: mirrorCategory.id,
                  type: 4,
                  categoryId: null, // Les catégories n'ont pas de parent
                  lastActivity: new Date(),
                  isActive: true
                },
                { upsert: true, new: true }
              );

              categoryId = mirrorCategory.id;

            } catch (categoryError) {
              console.error(`❌ Erreur création catégorie ${sourceCategory.name}: ${categoryError.message}`);
              // Continuer sans catégorie si erreur
              categoryId = null;
            }
          } else {
          }
        }
      }

      // Créer le salon mirror
      try {
        const numericType = this.convertChannelType(sourceChannel.type);
        const channelData = {
          name: sourceChannel.name,
          type: numericType,
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

        let mirrorChannel;

        // Fallback news → text si le serveur mirror n'a pas Community
        if (numericType === 5) {
          try {
            mirrorChannel = await targetGuild.channels.create(channelData);
          } catch (newsError) {
            if (newsError.code === 50035 || newsError.message?.includes('COMMUNITY')) {
              channelData.type = 0;
              channelData.topic = `📢 [Salon d'annonces] ${sourceChannel.topic || ''}`;
              mirrorChannel = await targetGuild.channels.create(channelData);
            } else {
              throw newsError;
            }
          }
        } else {
          mirrorChannel = await targetGuild.channels.create(channelData);
        }

        // Sauvegarder le mapping en base de données
        await Channel.findOneAndUpdate(
          { sourceChannelId: sourceChannel.id, serverId: sourceGuild.id },
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

        // Invalider le cache de correspondance
        if (handlers.scraper && handlers.scraper.correspondenceManager) {
          const cacheKey = `${sourceChannel.id}_${targetGuild.id}`;
          handlers.scraper.correspondenceManager.channelCache.delete(cacheKey);
        }

        // Logger l'action avec mention cliquable
        await scraper.logger.logNewRoom(
          targetGuild.id,
          `🆕 **NOUVEAU SALON DÉTECTÉ**: <#${mirrorChannel.id}>\n` +
          `⚙️ Type: ${sourceChannel.type}\n` +
          `⚡ **Création automatique** via WebSocket\n` +
          `🎯 **Mapping réussi** en temps réel`,
          'Auto Channel Creation',
          mirrorChannel.id
        );

        // Notifier dans #error si des messages étaient en attente pour ce salon
        const errorChannel = targetGuild.channels.cache.find(ch => ch.name === 'error');
        if (errorChannel) {
          const successEmbed = {
            color: 0x00ff00,
            title: '✅ Salon créé automatiquement',
            description: `Le salon a été détecté et créé automatiquement lors de sa création sur le serveur source.`,
            fields: [
              {
                name: '📍 Salon source',
                value: `${sourceChannel.name} (\`${sourceChannel.id}\`)`,
                inline: true
              },
              {
                name: '🎯 Salon mirror',
                value: `<#${mirrorChannel.id}>`,
                inline: true
              }
            ],
            timestamp: new Date().toISOString(),
            footer: {
              text: 'Détection WebSocket en temps réel'
            }
          };

          await errorChannel.send({ embeds: [successEmbed] });
        }

        // 📥 BACKFILL: Synchroniser les 50 derniers messages du nouveau salon (texte/news uniquement)
        const channelTypeNum = this.convertChannelType(sourceChannel.type);
        if ([0, 5].includes(channelTypeNum)) {
          let backfillCount = 0;
          try {
            const userData = this.getUserData(targetGuildId);
            if (userData?.token && scraper?.fetchChannelMessages) {
              const messages = await scraper.fetchChannelMessages(userData.token, sourceChannel.id, 50);
              if (messages?.length > 0) {
                console.log(`📥 [Backfill NewChannel] ${messages.length} messages à synchroniser pour ${sourceChannel.name}`);
                const ProcessedMessage = require('../models/ProcessedMessage');

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
                      channel: { id: sourceChannel.id, name: sourceChannel.name }
                    };

                    await scraper.processMessage(msgObj, mirrorChannel, sourceGuild);
                    backfillCount++;

                    // Délai pour éviter rate limiting Discord
                    await new Promise(resolve => setTimeout(resolve, 300));
                  } catch (msgError) {
                    console.error(`❌ Backfill msg ${msg.id}:`, msgError.message);
                  }
                }

                if (backfillCount > 0) {
                  console.log(`✅ [Backfill NewChannel] ${backfillCount} messages synchronisés pour ${sourceChannel.name}`);
                }
              }
            }
          } catch (backfillError) {
            console.error(`⚠️ Erreur backfill handleNewChannel:`, backfillError.message);
            // Ne pas faire échouer la création si le backfill échoue
          }
        }

      } catch (createError) {
        console.error(`❌ Erreur création salon mirror: ${createError.message}`);

        // Sauvegarder le mapping avec discordId temporaire unique
        // Format pending_<sourceId> : évite E11000 (unique constraint) et ne passe pas les checks cache.has()
        await Channel.findOneAndUpdate(
          { sourceChannelId: sourceChannel.id, serverId: sourceGuild.id },
          {
            name: sourceChannel.name,
            discordId: `pending_${sourceChannel.id}`,
            lastActivity: new Date(),
            isActive: true
          },
          { upsert: true, new: true }
        );
      }

    } catch (error) {
      console.error('❌ Erreur handleNewChannel:', error);
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

  // 🏛️ Gérer la création d'un nouveau thread/post de forum en temps réel
  async handleNewThread(sourceThread, targetGuildId) {
    try {
      const handlers = this.eventHandlers.get(targetGuildId);
      if (!handlers) return;
      
      const { scraper, targetGuild, sourceGuild } = handlers;

      // 🛡️ Validation null-safety pour sourceGuild (fix: erreur "Cannot read properties of null")
      if (!sourceGuild || !sourceGuild.id) {
        console.warn(`⚠️ [handleNewThread] sourceGuild non disponible pour targetGuild ${targetGuildId}, skip`);
        return;
      }

      // Vérifier si le thread parent est un forum (type 15)
      const parentChannel = sourceThread.parent;
      if (!parentChannel) {
        return;
      }
      
      
      // Gérer spécifiquement les threads de forums
      if (parentChannel.type === 15) { // GuildForum
        await this.handleNewForumPost(sourceThread, parentChannel, targetGuildId);
      } else {
        // Pour les autres types de threads, utiliser la logique standard
        await this.handleStandardThread(sourceThread, parentChannel, targetGuildId);
      }
      
    } catch (error) {
      console.error('❌ Erreur traitement nouveau thread:', error);
    }
  }

  // 🏛️ Gérer spécifiquement un nouveau post de forum
  async handleNewForumPost(sourceThread, sourceForumChannel, targetGuildId) {
    try {
      const handlers = this.eventHandlers.get(targetGuildId);
      if (!handlers) return;
      
      const { scraper, targetGuild, sourceGuild } = handlers;

      // 🛡️ Validation null-safety pour sourceGuild (fix: erreur "Cannot read properties of null")
      if (!sourceGuild || !sourceGuild.id) {
        console.warn(`⚠️ [handleNewForumPost] sourceGuild non disponible pour targetGuild ${targetGuildId}, skip`);
        return;
      }

      // Trouver ou créer le forum correspondant sur le mirror
      let forumMirror = targetGuild.channels.cache.find(
        ch => ch.name === sourceForumChannel.name && ch.type === 15
      );

      if (!forumMirror) {
        // 🏛️ NOUVEAU: Créer le forum automatiquement s'il n'existe pas
        console.log(`🔧 Forum mirror ${sourceForumChannel.name} non trouvé, tentative de création automatique...`);

        if (scraper?.correspondenceManager?.autoCreateForumChannel) {
          const forumInfo = {
            id: sourceForumChannel.id,
            name: sourceForumChannel.name,
            type: 15,
            parentId: sourceForumChannel.parentId,
            topic: sourceForumChannel.topic
          };
          forumMirror = await scraper.correspondenceManager.autoCreateForumChannel(forumInfo, targetGuild, sourceGuild.id);

          if (forumMirror) {
            // Sauvegarder le mapping du forum
            const Channel = require('../models/Channel');
            await Channel.findOneAndUpdate(
              { sourceChannelId: sourceForumChannel.id, serverId: sourceGuild.id },
              {
                name: sourceForumChannel.name,
                discordId: forumMirror.id,
                sourceChannelId: sourceForumChannel.id,
                type: 15,
                lastSynced: new Date()
              },
              { upsert: true }
            );
            console.log(`✅ Forum ${sourceForumChannel.name} créé automatiquement: ${forumMirror.id}`);
          }
        }

        if (!forumMirror) {
          console.log(`❌ Impossible de créer le forum mirror ${sourceForumChannel.name} pour le thread ${sourceThread.name}`);
          return;
        }
      }

      // Vérifier si le thread existe déjà en base
      const Channel = require('../models/Channel');
      const existingThread = await Channel.findOne({
        name: sourceThread.name,
        serverId: sourceGuild.id
      });
      
      if (existingThread && existingThread.scraped) {
        return;
      }
      
      // Récupérer le premier message du thread source pour avoir le contenu initial
      let initialMessage = null;
      try {
        const messages = await sourceThread.messages.fetch({ limit: 1 });
        initialMessage = messages.first();
      } catch (fetchError) {
      }
      
      // Créer le thread/post dans le forum mirror
      let newForumThread;
      try {
        const forumThreadOptions = {
          name: sourceThread.name,
          message: {
            content: initialMessage ? 
              await scraper.processAdvancedMessageContent(initialMessage.content || '', sourceGuild) : 
              `🏛️ **Post synchronisé**: ${sourceThread.name}\n\n*Ce post a été automatiquement créé lors de sa détection sur le serveur source.*`
          },
          autoArchiveDuration: sourceThread.autoArchiveDuration || 1440,
          reason: `Synchronisation automatique post forum: ${sourceThread.name}`
        };

        newForumThread = await forumMirror.threads.create(forumThreadOptions);

      } catch (createError) {
        return;
      }
      
      // Sauvegarder en base de données
      try {
        if (existingThread) {
          existingThread.discordId = newForumThread.id;
          existingThread.sourceChannelId = sourceThread.id;
          existingThread.scraped = true;
          existingThread.manuallyDeleted = false;
          await existingThread.save();
        } else {
          const newChannelDB = new Channel({
            discordId: newForumThread.id,
            serverId: sourceGuild.id,
            sourceChannelId: sourceThread.id,
            name: sourceThread.name,
            category: forumMirror.parent?.name || null,
            scraped: true,
            failedAttempts: 0,
            isBlacklisted: false,
            manuallyDeleted: false
          });
          await newChannelDB.save();
        }


      } catch (dbError) {
      }
      
      // Logger l'action avec mention cliquable
      try {
        await scraper.logger.logNewRoom(
          targetGuild.id,
          `🏛️ **NOUVEAU POST FORUM DÉTECTÉ**: <#${newForumThread.id}>\n` +
          `📁 Forum: <#${forumMirror.id}>\n` +
          `⚡ **Synchronisation automatique** en temps réel\n` +
          `🎯 **Créé automatiquement** lors de la détection`,
          'Sync Forum Post',
          newForumThread.id
        );

        await scraper.logger.logAdminAction(
          targetGuild.id,
          `🏛️ Post forum synchronisé automatiquement: <#${newForumThread.id}>\n` +
          `📁 Forum: ${sourceForumChannel.name} → <#${forumMirror.id}>\n` +
          `⚡ Détection en temps réel activée`
        );

      } catch (logError) {
      }

      // 📥 BACKFILL: Synchroniser les 50 derniers messages du post forum
      let backfillCount = 0;
      try {
        const userData = this.getUserData(targetGuildId);
        if (userData?.token && scraper?.fetchChannelMessages) {
          const messages = await scraper.fetchChannelMessages(userData.token, sourceThread.id, 50);
          if (messages?.length > 0) {
            console.log(`📥 [Backfill NewForumPost] ${messages.length} messages à synchroniser pour ${sourceThread.name}`);
            const ProcessedMessage = require('../models/ProcessedMessage');

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
                  channel: { id: sourceThread.id, name: sourceThread.name }
                };

                await scraper.processMessage(msgObj, newForumThread, sourceGuild);
                backfillCount++;

                // Délai pour éviter rate limiting Discord
                await new Promise(resolve => setTimeout(resolve, 300));
              } catch (msgError) {
                console.error(`❌ Backfill msg ${msg.id}:`, msgError.message);
              }
            }

            if (backfillCount > 0) {
              console.log(`✅ [Backfill NewForumPost] ${backfillCount} messages synchronisés pour ${sourceThread.name}`);
            }
          }
        }
      } catch (backfillError) {
        console.error(`⚠️ Erreur backfill handleNewForumPost:`, backfillError.message);
        // Ne pas faire échouer la création si le backfill échoue
      }

    } catch (error) {
      console.error('❌ Erreur handleNewForumPost:', error);
    }
  }

  // 🧵 Gérer un thread classique (non-forum)
  async handleStandardThread(sourceThread, sourceParentChannel, targetGuildId) {
    try {
      // Pour l'instant, juste logger - la logique existante s'occupera du reste
      // via handleNewMessage quand des messages arriveront dans le thread
      
    } catch (error) {
      console.error('❌ Erreur handleStandardThread:', error);
    }
  }

  // 🚀 Gérer une modification de message
  async handleUpdatedMessage(oldMessage, newMessage, targetGuildId) {
    try {
      const handlers = this.eventHandlers.get(targetGuildId);
      if (!handlers) return;
      
      const { scraper, targetGuild, sourceGuild } = handlers;

      // 🛡️ Validation null-safety pour sourceGuild (fix: erreur "Cannot read properties of null")
      if (!sourceGuild || !sourceGuild.id) {
        console.warn(`⚠️ [handleUpdatedMessage] sourceGuild non disponible pour targetGuild ${targetGuildId}, skip`);
        return;
      }

      // Traiter la modification (à implémenter dans le scraper)
      await scraper.handleEventMessageUpdate(oldMessage, newMessage, targetGuild, sourceGuild);
      
    } catch (error) {
      console.error('❌ Erreur traitement modification message:', error);
    }
  }

  // 🚀 Vérifier si les événements sont actifs
  hasEventListeners(targetGuildId) {
    return this.selfbots.has(targetGuildId);
  }

  // 🚀 Obtenir les statistiques des événements
  getEventStats() {
    const activeEvents = Array.from(this.selfbots.entries()).map(([guildId, selfbot]) => ({
      targetGuildId: guildId,
      selfbotTag: selfbot.user?.tag || 'Non connecté',
      status: selfbot.ws?.status ?? 'Inconnu',
      ping: selfbot.ws?.ping ?? 0
    }));

    return {
      activeCount: this.selfbots.size,
      events: activeEvents
    };
  }

  // 🩺 Vérifie si au moins un selfbot a un WebSocket connecté (status 0 = READY)
  isSelfbotHealthy() {
    if (this.selfbots.size === 0) return false;
    for (const [, selfbot] of this.selfbots) {
      if (!selfbot.destroyed && selfbot.ws?.status === 0) return true;
    }
    return false;
  }
}

module.exports = UserClientService; 