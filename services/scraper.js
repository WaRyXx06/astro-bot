const { EmbedBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, WebhookClient } = require('discord.js');
const ProcessedMessage = require('../models/ProcessedMessage');
const Channel = require('../models/Channel');
const rateLimiter = require('../utils/rateLimiter');
const axios = require('axios');
const defaultNames = require('../config/defaultNames');
const { logErrorEnriched } = require('./logger');
const CorrespondenceManager = require('./correspondenceManager');
const botPatterns = require('../utils/botPatterns');
const {
  DISCORD_LIMITS,
  calculateWebhookPayloadSize,
  splitFilesIntoGroups,
  validateAndAdjustWebhookPayload
} = require('../utils/discordLimits');

// Import du système de logging au niveau du module (fix crash loop)
let logConfig = null;
try {
  logConfig = require('../config/logConfig');
} catch (error) {
  console.warn('⚠️ Module logConfig non disponible dans scraper, utilisation des logs par défaut');
  // Fallback si le module n'est pas disponible
  logConfig = {
    shouldLog: () => true,
    isDebugMode: () => true,
    LOG_LEVELS: { SILENT: -1, ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 },
    logCompressedMessage: (id, author, channel, status) => {
      console.log(`📨 MSG#${id.slice(-6)} | ${author} → #${channel} | ${status}`);
    },
    logMessageSuccess: (id, author, channel, sizeKB) => {
      const ts = new Date().toISOString().split('T')[1].split('.')[0];
      console.log(`[${ts}] ✅ ${id?.slice(-6) || '??????'} | ${author} → #${channel}${sizeKB ? ` | ${sizeKB}KB` : ''}`);
    },
    logMessageEdit: (author, channel) => {
      const ts = new Date().toISOString().split('T')[1].split('.')[0];
      console.log(`[${ts}] ✏️ EDIT | ${author} → #${channel}`);
    }
  };
}
const { shouldLog, LOG_LEVELS, logCompressedMessage, logMessageSuccess, logMessageEdit, isDebugMode } = logConfig;

// Types de canaux Discord qui supportent les webhooks
const WEBHOOK_SUPPORTED_TYPES = new Set([
  0,  // GUILD_TEXT
  5,  // GUILD_NEWS
  10, // GUILD_NEWS_THREAD
  11, // GUILD_PUBLIC_THREAD (forum posts, active threads)
  12, // GUILD_PRIVATE_THREAD
  15  // GUILD_FORUM
]);

// Mapping des types string vers numériques (pour discord.js-selfbot-v13)
const CHANNEL_TYPE_MAP = {
  'GUILD_TEXT': 0,
  'DM': 1,
  'GUILD_VOICE': 2,
  'GROUP_DM': 3,
  'GUILD_CATEGORY': 4,
  'GUILD_NEWS': 5,
  'GUILD_NEWS_THREAD': 10,
  'GUILD_PUBLIC_THREAD': 11,
  'GUILD_PRIVATE_THREAD': 12,
  'GUILD_STAGE_VOICE': 13,
  'GUILD_DIRECTORY': 14,
  'GUILD_FORUM': 15
};

class ScraperService {
  constructor(client, logger) {
    this.client = client;
    this.logger = logger;
    this.activeScrapers = new Map(); // Map<channelId, boolean>
    this.scrapingInterval = null;
    this.userClient = null; // Client utilisateur pour accéder au serveur source
    this.isRunning = false;
    this.correspondenceManager = new CorrespondenceManager(client, logger);
    
    // 🚀 NOUVEAUX : Support événementiel
    this.isEventBased = false; // Flag pour mode événementiel
    this.eventStats = {
      totalEventMessages: 0,
      lastEventTime: null
    };
    
    // 🎯 SYSTÈME DE COMMANDES SLASH + RÉPONSES BOTS
    this.pendingSlashCommands = new Map(); // Map<commandKey, {command, timestamp, targetChannel, responses}>
    this.pendingByComposite = new Map(); // Map<compositeKey, commandData> pour association robuste
    this.slashCommandTimeout = 60000; // 60 secondes max d'attente (était 30000)

    // 🛡️ NOUVEAU: Système de buffering pour les embeds différés
    this.messageBuffer = new Map(); // Map<messageId, {message, targetChannel, timestamp, processed}>
    this.bufferDelay = 3000; // 3 secondes de délai pour attendre les embeds
    this.maxBufferAge = 10000; // 10 secondes max avant nettoyage forcé

    // 🛡️ NOUVEAU: Système de throttling pour éviter le spam d'erreurs
    this.errorThrottle = new Map(); // Map<errorKey, timestamp>

    // 🔄 NOUVEAU: Création différée de salons manquants (post-then-update)
    this.pendingChannelCreations = new Set(); // Évite les créations en double

    // Nettoyage périodique des commandes expirées, du buffer et du throttle
    this.cleanupInterval = setInterval(() => {
      try {
        this.cleanupExpiredCommands();
      } catch (error) {
        console.error('❌ Erreur dans cleanupExpiredCommands:', error.message);
      }

      try {
        this.cleanupMessageBuffer();
      } catch (error) {
        console.error('❌ Erreur dans cleanupMessageBuffer:', error.message);
      }

      try {
        this.cleanupErrorThrottle();
      } catch (error) {
        console.error('❌ Erreur dans cleanupErrorThrottle:', error.message);
      }
    }, 5000); // Toutes les 5 secondes
  }

  /**
   * Envoie un message webhook avec retry et gestion des timeouts
   * @param {WebhookClient} webhook - Le client webhook
   * @param {Object} payload - Le payload à envoyer
   * @param {Object} options - Options de retry
   * @returns {Promise} - Le message envoyé ou null
   */
  async sendWebhookWithRetry(webhook, payload, options = {}) {
    const maxRetries = options.maxRetries || 3;
    const baseDelay = 1000; // 1 seconde
    const timeout = options.timeout || 30000; // 30 secondes par défaut

    // Guard : éviter d'envoyer un payload vide à Discord
    if (!payload.content?.trim() && (!payload.embeds || payload.embeds.length === 0) && (!payload.files || payload.files.length === 0)) {
      return null;
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Créer une promesse avec timeout
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`Webhook timeout après ${timeout}ms`)), timeout);
        });

        // Course entre l'envoi et le timeout
        const sendPromise = webhook.send(payload);
        const result = await Promise.race([sendPromise, timeoutPromise]);

        // Si on arrive ici, l'envoi a réussi
        return result;

      } catch (error) {
        const isLastAttempt = attempt === maxRetries;
        const delay = baseDelay * Math.pow(2, attempt - 1); // Exponential backoff

        // Analyser le type d'erreur
        const errorMessage = error.message || error.toString();
        const isRateLimit = error.code === 429 || errorMessage.includes('rate limit');

        // Détecter erreurs réseau/socket/DB (récupérables avec retry)
        const isNetworkError = errorMessage.includes('ECONNRESET') ||
                               errorMessage.includes('ENOTFOUND') ||
                               errorMessage.includes('other side closed') ||
                               errorMessage.includes('UND_ERR_SOCKET') ||
                               errorMessage.includes('socket hang up') ||
                               errorMessage.includes('ETIMEDOUT') ||
                               errorMessage.includes('timed out');

        // Si c'est une rate limit, attendre le délai recommandé
        if (isRateLimit && error.retry_after) {
          await new Promise(resolve => setTimeout(resolve, error.retry_after * 1000));
          continue;
        }

        // Si c'est la dernière tentative, abandonner
        if (isLastAttempt) {
          // Log silencieux pour erreurs réseau (transitoires)
          if (!isNetworkError) {
            console.error(`❌ Webhook failed: ${errorMessage}`);
          }
          if (this.logger) {
            await this.logger.logError(webhook.id || 'unknown', `Webhook failed: ${errorMessage}`, 'webhook-error');
          }
          return null;
        }

        // Attendre avant de réessayer (exponential backoff, plus long pour erreurs réseau)
        const actualDelay = isNetworkError ? delay * 2 : delay;
        await new Promise(resolve => setTimeout(resolve, actualDelay));
      }
    }

    return null;
  }

  /**
   * Édite un message webhook avec retry et gestion des timeouts
   * @param {WebhookClient} webhook - Le client webhook
   * @param {string} messageId - L'ID du message à éditer
   * @param {Object} payload - Le payload d'édition
   * @param {Object} options - Options de retry
   * @returns {Promise} - Le message édité ou null
   */
  async editWebhookWithRetry(webhook, messageId, payload, options = {}) {
    const maxRetries = options.maxRetries || 3;
    const baseDelay = 1000; // 1 seconde
    const timeout = options.timeout || 30000; // 30 secondes par défaut

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Créer une promesse avec timeout
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`Webhook edit timeout après ${timeout}ms`)), timeout);
        });

        // Course entre l'édition et le timeout
        const editPromise = webhook.editMessage(messageId, payload);
        const result = await Promise.race([editPromise, timeoutPromise]);

        // Si on arrive ici, l'édition a réussi
        return result;

      } catch (error) {
        const isLastAttempt = attempt === maxRetries;
        const delay = baseDelay * Math.pow(2, attempt - 1);
        const errorMessage = error.message || error.toString();
        const isRateLimit = error.code === 429 || errorMessage.includes('rate limit');

        // Détecter erreurs réseau/socket/DB (récupérables avec retry)
        const isNetworkError = errorMessage.includes('ECONNRESET') ||
                               errorMessage.includes('ENOTFOUND') ||
                               errorMessage.includes('other side closed') ||
                               errorMessage.includes('UND_ERR_SOCKET') ||
                               errorMessage.includes('socket hang up') ||
                               errorMessage.includes('ETIMEDOUT') ||
                               errorMessage.includes('timed out');

        if (isRateLimit && error.retry_after) {
          await new Promise(resolve => setTimeout(resolve, error.retry_after * 1000));
          continue;
        }

        if (isLastAttempt) {
          // Log silencieux pour erreurs réseau (transitoires)
          if (!isNetworkError) {
            console.error(`❌ Webhook edit failed: ${errorMessage}`);
          }
          return null;
        }

        // Attendre avant de réessayer (exponential backoff, plus long pour erreurs réseau)
        const actualDelay = isNetworkError ? delay * 2 : delay;
        await new Promise(resolve => setTimeout(resolve, actualDelay));
      }
    }

    return null;
  }

  // Démarrer le scraping automatique avec client utilisateur
  startScrapingWithUserClient(targetGuild, sourceGuild, userClient) {
    this.userClient = userClient;
    this.isRunning = true;

    this.scrapingInterval = setInterval(async () => {
      try {
        await this.scrapeAllChannels(targetGuild, sourceGuild);
      } catch (error) {
        console.error('❌ Scraping error:', error.message);
        await this.logger.logError(targetGuild.id, `Erreur scraping: ${error.message}`);
      }
    }, parseInt(process.env.DEFAULT_SCRAPE_DELAY) || 300000);
  }

  // Démarrer le scraping automatique (méthode legacy)
  startScraping(targetGuild, sourceGuild) {
    this.isRunning = true;

    this.scrapingInterval = setInterval(async () => {
      try {
        await this.scrapeAllChannels(targetGuild, sourceGuild);
      } catch (error) {
        console.error('❌ Scraping error:', error.message);
        await this.logger.logError(targetGuild.id, `Erreur scraping: ${error.message}`);
      }
    }, parseInt(process.env.DEFAULT_SCRAPE_DELAY) || 300000);
  }

  // Arrêter le scraping automatique
  stopScraping() {
    if (this.scrapingInterval) {
      clearInterval(this.scrapingInterval);
      this.scrapingInterval = null;
      this.isRunning = false;
    }
    
    // Arrêter tous les scrapers actifs
    this.activeScrapers.clear();
    
    // Nettoyer la référence au client utilisateur
    this.userClient = null;
  }

  // Scraper tous les salons configurés
  async scrapeAllChannels(targetGuild, sourceGuild) {
    try {
      const channels = await Channel.find({ serverId: sourceGuild.id, scraped: true });
      
      // 🏛️ SÉPARER LES FORUMS ET LES SALONS NORMAUX
      const forumChannels = [];
      const regularChannels = [];
      
      for (const channelData of channels) {
        // Vérifier le type de salon si possible
        const sourceChannel = this.userClient 
          ? this.userClient.guilds.cache.get(sourceGuild.id)?.channels.cache.get(channelData.discordId)
          : sourceGuild.channels.cache.get(channelData.discordId);
        
        if (sourceChannel && sourceChannel.type === 15) {
          forumChannels.push(channelData);
        } else {
          regularChannels.push(channelData);
        }
      }
      
      // SCRAPER LES FORUMS EN PREMIER
      for (const forumData of forumChannels) {
        if (this.activeScrapers.get(forumData.discordId)) {
          continue;
        }
        
        try {
          await this.scrapeChannel(targetGuild, sourceGuild, forumData);
        } catch (error) {
          console.error(`Erreur lors du scraping du forum ${forumData.name}:`, error);
          await this.logger.logError(
            targetGuild.id, 
            `Erreur scraping forum ${forumData.name}: ${error.message}`,
            forumData.name
          );
        }
      }
      
      // SCRAPER LES THREADS DE FORUM CONFIGURÉS
      const forumThreads = await Channel.find({ 
        serverId: sourceGuild.id, 
        scraped: true,
        sourceChannelId: { $exists: true, $ne: null }
      });
      
      for (const threadData of forumThreads) {
        if (this.activeScrapers.get(threadData.discordId)) {
          continue;
        }

        try {
          // Vérifier si c'est un thread de forum en vérifiant son parent
          let userData = null;
          let userClientToUse = null;

          if (this.userClient && this.userClient.getUserData) {
            userData = this.userClient.getUserData(targetGuild.id);
            userClientToUse = this.userClient;
          } else if (this.client && this.client.services && this.client.services.userClient) {
            userData = this.client.services.userClient.getUserData(targetGuild.id);
            userClientToUse = this.client.services.userClient;
          }

          if (userData && userData.token && userClientToUse) {
            let threadDetails;
            try {
              threadDetails = await userClientToUse.fetchThreadById(userData.token, threadData.sourceChannelId);
            } catch (fetchError) {
              // Skip silencieusement les threads inaccessibles (403/404 déjà loggés et cachés dans userClient)
              continue;
            }
            if (threadDetails && threadDetails.parent_id) {
              let parentDetails;
              try {
                parentDetails = await userClientToUse.fetchThreadById(userData.token, threadDetails.parent_id);
              } catch (fetchError) {
                // Skip silencieusement si le parent est inaccessible (403/404 déjà loggés et cachés)
                continue;
              }
              if (parentDetails && parentDetails.type === 15) {
                // C'est un thread de forum, le scraper
                const targetForum = targetGuild.channels.cache.find(
                  ch => ch.name === parentDetails.name && ch.type === 15
                );
                if (targetForum) {
                  await this.scrapeForumThread(targetGuild, sourceGuild, threadData, targetForum);
                }
              }
            }
          }
        } catch (error) {
          console.error(`Erreur lors du scraping du thread forum ${threadData.name}:`, error);
        }
      }
      
      // SCRAPER LES SALONS RÉGULIERS
      for (const channelData of regularChannels) {
        if (this.activeScrapers.get(channelData.discordId)) {
          continue;
        }

        try {
          await this.scrapeChannel(targetGuild, sourceGuild, channelData);
        } catch (error) {
          console.error(`Erreur lors du scraping du salon ${channelData.name}:`, error);
          await this.logger.logError(
            targetGuild.id, 
            `Erreur scraping ${channelData.name}: ${error.message}`,
            channelData.name
          );
        }
      }
    } catch (error) {
      console.error('Erreur lors du scraping de tous les salons:', error);
      throw error;
    }
  }

  // Scraper un salon spécifique
  async scrapeChannel(targetGuild, sourceGuild, channelData) {
    this.activeScrapers.set(channelData.discordId, true);
    
    try {
      // Utiliser le client utilisateur si disponible, sinon le client principal
      const clientToUse = this.userClient || this.client;
      
      // Récupérer le salon source via le bon client
      let sourceChannel;
      if (this.userClient) {
        // Si on utilise un client utilisateur, récupérer le salon depuis le serveur source
        const userSourceGuild = this.userClient.guilds.cache.get(sourceGuild.id);
        sourceChannel = userSourceGuild ? userSourceGuild.channels.cache.get(channelData.discordId) : null;
      } else {
        sourceChannel = sourceGuild.channels.cache.get(channelData.discordId);
      }
      
      if (!sourceChannel) {
        return;
      }

      // 🏛️ VÉRIFIER SI C'EST UN FORUM (type 15)
      if (sourceChannel.type === 15) {
        
        // Trouver le forum mirror correspondant
        const targetForum = targetGuild.channels.cache.find(
          ch => ch.name === channelData.name && ch.type === 15
        );
        
        if (!targetForum) {
          return;
        }
        
        // Récupérer tous les threads du forum source
        const sourceThreads = sourceChannel.threads.cache;
        
        // Scraper chaque thread du forum
        for (const [threadId, thread] of sourceThreads) {
          try {
            // Chercher le thread en base
            const threadData = await Channel.findOne({
              sourceChannelId: threadId,
              serverId: sourceGuild.id
            });
            
            if (threadData && threadData.scraped) {
              // Scraper le thread existant
              await this.scrapeForumThread(targetGuild, sourceGuild, threadData, targetForum);
            }
          } catch (threadError) {
            console.error(`❌ Erreur scraping thread ${thread.name}:`, threadError);
          }
        }
        
        // Mettre à jour la date de dernier scraping et activité du forum
        await Channel.updateOne(
          { discordId: channelData.discordId },
          {
            lastScraped: new Date(),
            lastActivity: new Date(),
            isActive: true
          }
        );
        
        return; // Fin du traitement pour un forum
      }

      // TRAITEMENT NORMAL POUR LES SALONS NON-FORUM
      const targetChannel = targetGuild.channels.cache.find(
        ch => ch.name === channelData.name
      );
      if (!targetChannel) {
        return;
      }

      // Attendre si nécessaire pour respecter le rate limiting
      await rateLimiter.waitForRequest(channelData.discordId);
      
      // Récupérer les derniers messages
      const messages = await this.fetchNewMessages(sourceChannel, channelData);
      
      if (messages.length === 0) {
        return; // Pas de nouveaux messages
      }


      // Traiter chaque message
      for (const message of messages.reverse()) { // Ordre chronologique
        try {
          await this.processMessage(message, targetChannel, sourceGuild);
          
          // Enregistrer la requête dans le rate limiter
          rateLimiter.recordRequest(channelData.discordId);
          
          // Délai entre les messages pour éviter le spam
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          console.error(`Erreur lors du traitement du message ${message.id}:`, error);
          await this.logger.logError(
            targetGuild.id,
            `Erreur traitement message dans ${channelData.name}: ${error.message}`,
            channelData.name
          );
        }
      }

      // Mettre à jour la date de dernier scraping et activité
      await Channel.updateOne(
        { discordId: channelData.discordId },
        {
          lastScraped: new Date(),
          lastActivity: new Date(),
          lastMessageActivity: messages.length > 0 ? new Date() : undefined,  // Mettre à jour seulement si des messages
          isActive: true,
          $inc: { messageCount: messages.length }
        }
      );

    } catch (error) {
      console.error(`Erreur lors du scraping du salon ${channelData.name}:`, error);
      throw error;
    } finally {
      this.activeScrapers.delete(channelData.discordId);
    }
  }

  // Récupérer les nouveaux messages d'un salon
  async fetchNewMessages(sourceChannel, channelData) {
    try {
      const options = { limit: 50 };
      
      // Récupérer le dernier message traité
      const lastProcessed = await ProcessedMessage
        .findOne({ channelId: channelData.discordId })
        .sort({ processedAt: -1 });

      if (lastProcessed) {
        options.after = lastProcessed.discordId;
      }

      const messages = await sourceChannel.messages.fetch(options);
      return Array.from(messages.values());
    } catch (error) {
      console.error(`Erreur lors de la récupération des messages de ${sourceChannel.name}:`, error);
      throw error;
    }
  }

  // Traiter et reproduire un message
  async processMessage(sourceMessage, targetChannel, sourceGuild, isBuffered = false) {
    try {
      // Validation silencieuse - skip si sourceGuild invalide
      if (!sourceGuild?.id) return null;

      // Convertir le type string en numérique si nécessaire
      const channelType = typeof sourceMessage.channel?.type === 'string'
        ? CHANNEL_TYPE_MAP[sourceMessage.channel.type] ?? sourceMessage.channel.type
        : sourceMessage.channel?.type;

      // 🔇 NOUVEAU: Vérification supplémentaire pour les canaux vocaux
      // Protection double au cas où le message viendrait d'un autre point d'entrée
      if (channelType === 2) {
        return null; // Ignorer silencieusement les canaux vocaux
      }

      // 🚫 FILTRAGE : Ignorer le bot Blackjack qui génère des messages vides
      if (sourceMessage.author.username === 'Blackjack' && sourceMessage.author.discriminator === '0320') {
        return null; // Ignorer silencieusement
      }
      
      // Détection commandes slash
      const slashDetection = botPatterns.detectSlashCommand(sourceMessage);
      if (slashDetection.isCommand) {
        return await this.handleSlashCommand(sourceMessage, targetChannel, sourceGuild);
      }

      // Détecter réponse de bot APP
      if (this.isAppBot(sourceMessage.author)) {
        const associatedCommand = await this.tryAssociateWithSlashCommand(sourceMessage, targetChannel, sourceGuild);
        if (associatedCommand) return null;
      }
      
      // Vérifier si le canal cible supporte les webhooks
      if (!WEBHOOK_SUPPORTED_TYPES.has(targetChannel.type)) return null;

      // Obtenir webhook
      const webhook = await this.getOrCreateWebhook(targetChannel);
      if (!webhook) return null;

      // 🎨 PRÉPARER L'AVATAR DE L'UTILISATEUR
      const avatarURL = sourceMessage.author.avatar ? 
        `https://cdn.discordapp.com/avatars/${sourceMessage.author.id}/${sourceMessage.author.avatar}.png?size=256` :
        `https://cdn.discordapp.com/embed/avatars/${sourceMessage.author.discriminator % 5}.png`;
      
      // 📝 TRAITER LE CONTENU DU MESSAGE (utiliser les fonctions avancées d'index.js)
      // Passer sourceMessage.id pour activer la création différée des salons manquants
      let content = await this.processAdvancedMessageContent(sourceMessage.content || '', sourceGuild, {
        sourceMessageId: sourceMessage.id
      });
      
      // Traitement des réponses et transferts
      if (sourceMessage.reference?.messageId) {
        try {
          const reference = sourceMessage.reference;
          let messageTypePrefix = reference.channelId === sourceMessage.channel?.id ? 'Réponse'
            : reference.guildId === sourceGuild?.id ? 'Transfert' : 'Transfert externe';

          const originalProcessed = await ProcessedMessage.findOne({ discordId: reference.messageId });

          if (originalProcessed?.mirrorMessageId) {
            const messageLink = `https://discord.com/channels/${originalProcessed.mirrorGuildId}/${originalProcessed.mirrorChannelId}/${originalProcessed.mirrorMessageId}`;
            content = `**[${messageTypePrefix}](${messageLink})**\n\n` + (content || '');
          } else {
            const fallbackUrl = this.generateDiscordUrl(reference, sourceGuild?.id);
            if (fallbackUrl) {
              const emoji = messageTypePrefix === 'Réponse' ? '↪️' : messageTypePrefix === 'Transfert' ? '🔄' : '📨';
              content = `[${emoji} **${messageTypePrefix}**](${fallbackUrl})\n\n` + (content || '');
            } else if (messageTypePrefix !== 'Transfert externe') {
              content = `${messageTypePrefix === 'Réponse' ? '↪️' : '🔄'} **${messageTypePrefix}**\n\n` + (content || '');
            }
          }
        } catch (refError) {
          // Silently ignore reference errors
        }
      }
      
      // Traitement messages transférés (vide avec référence)
      if ((!content || content.trim() === '') && sourceMessage.reference) {
        const reference = sourceMessage.reference;
        const isFromExternalServer = reference.guildId && reference.guildId !== sourceGuild?.id;

        if (isFromExternalServer) {
          let transferredContent = '';
          let transferredEmbeds = [];

          try {
            if (sourceMessage.embeds?.length > 0) {
              const { embeds } = await this.processAdvancedEmbeds(sourceMessage.embeds, sourceGuild, sourceMessage);
              transferredEmbeds = embeds || [];
              transferredContent = this.extractContentFromEmbeds(sourceMessage.embeds);
            }

            if (!transferredContent && sourceMessage.content?.trim()) {
              transferredContent = await this.processAdvancedMessageContent(sourceMessage.content, sourceGuild);
            }

            if (transferredEmbeds.length > 0) {
              content = `🔄 **Message transféré** (serveur externe)`;
              sourceMessage.embeds = transferredEmbeds;
            } else if (transferredContent?.trim()) {
              content = `🔄 **Message transféré** (serveur externe):\n${transferredContent}`;
            } else {
              content = `🔄 **Message transféré** (serveur externe)\n⚠️ Contenu non récupérable`;
            }
          } catch (extractError) {
            content = `🔄 **Message transféré** (serveur externe)\n⚠️ Erreur de traitement`;
          }
        } else {
          try {
            const referencedMessage = await sourceMessage.fetchReference();
            if (referencedMessage) {
              const forwardedContent = await this.processAdvancedMessageContent(referencedMessage.content || '', sourceGuild);
              if (forwardedContent?.trim()) content = forwardedContent;
            }
          } catch (refError) {
            // Silently ignore
          }
        }
      }
      
      // 🆕 DÉTECTION AMÉLIORÉE DES MESSAGES TRANSFÉRÉS
      if ((!content || content.trim() === '') && this.isForwardedMessage(sourceMessage)) {
        content = await this.extractForwardedContent(sourceMessage, sourceGuild);
      }
      
      // 📋 TRAITER LES EMBEDS COMPLETS (utiliser la logique avancée)
      const { embeds } = await this.processAdvancedEmbeds(sourceMessage.embeds || [], sourceGuild, sourceMessage);
      
      // 📎 TRAITER LES ATTACHMENTS 
      const files = await this.processAttachments(sourceMessage.attachments);
      
      // 🛡️ VÉRIFICATION CRITIQUE : S'assurer qu'il y a au moins du contenu
      const hasContent = content && content.trim() !== '';
      const hasEmbeds = embeds && embeds.length > 0 && 
                      embeds.some(embed => 
                        embed.data.title || embed.data.description || embed.data.fields?.length > 0 || 
                        embed.data.image?.url || embed.data.thumbnail?.url
                      );
      const hasFiles = files && files.length > 0;
      
      // 🚨 PROTECTION ABSOLUE CONTRE LES MESSAGES VIDES
      if (!hasContent && !hasEmbeds && !hasFiles) {
        // Analyser le type de message pour créer un fallback approprié
        let fallbackContent = '';
        
        if (sourceMessage.stickers && sourceMessage.stickers.size > 0) {
          const stickerNames = Array.from(sourceMessage.stickers.values()).map(s => s.name).join(', ');
          fallbackContent = `🎨 *${sourceMessage.stickers.size} sticker(s): ${stickerNames}*`;
        } else if (sourceMessage.type === 20) {
          fallbackContent = `⚡ *Commande slash utilisée*`;
        } else if (sourceMessage.reference) {
          // ✅ VÉRIFIER SI LA RÉFÉRENCE VIENT D'UN SERVEUR EXTERNE
          const isExternalReference = sourceMessage.reference.guildId && sourceMessage.reference.guildId !== sourceGuild?.id;
          if (isExternalReference) {
            fallbackContent = `🔄 *Message transféré depuis un serveur externe*`;
          } else {
            fallbackContent = `↩️ *Message en réponse*`;
          }
        } else if (sourceMessage.attachments && sourceMessage.attachments.size > 0) {
          fallbackContent = `📎 *${sourceMessage.attachments.size} fichier(s) non transférable(s)*`;
        } else if (sourceMessage.embeds && sourceMessage.embeds.length > 0) {
          fallbackContent = `📋 *Contenu intégré vide*`;
        } else {
          fallbackContent = `📱 *Message ${sourceMessage.type ? `type ${sourceMessage.type}` : 'système'} Discord*`;
        }
        
        content = fallbackContent;
      }
      
      // 🔧 CONSTRUIRE LE MESSAGE FINAL AVEC VÉRIFICATIONS DE TAILLE
      const webhookPayload = {
        content: (hasEmbeds && !content?.includes('@')) ? undefined : (content && content.trim() !== '' ? content : undefined), // ✅ Éviter duplication: content seulement si mentions ou pas d'embeds
        embeds: hasEmbeds ? embeds.slice(0, 10) : undefined,
        files: hasFiles ? files.slice(0, 10) : undefined,
        username: `${sourceMessage.author.username}`, // Nom utilisateur natif
        avatarURL: avatarURL, // Avatar natif
        allowedMentions: { parse: ['roles'] } // Autoriser seulement les mentions de rôles
      };
      
      // 🛡️ VÉRIFICATIONS DE TAILLE POUR ÉVITER "Request entity too large"
      if (webhookPayload.content && webhookPayload.content.length > 2000) {
        webhookPayload.content = webhookPayload.content.substring(0, 1900) + '...\n*[Message tronqué - trop volumineux]*';
      }
      
      // Protection messages vides
      const finalContent = webhookPayload.content;
      const finalEmbeds = webhookPayload.embeds;
      const finalFiles = webhookPayload.files;

      if ((!finalContent || finalContent.trim() === '') && (!finalEmbeds || finalEmbeds.length === 0) && (!finalFiles || finalFiles.length === 0)) {
        webhookPayload.content = `⚠️ *Message vide évité de ${sourceMessage.author.username}*`;
      }

      // Thread de forum
      const isTargetForumThread = targetChannel.type === 11 && targetChannel.parentId && targetChannel.parent?.type === 15;
      if (isTargetForumThread) webhookPayload.threadId = targetChannel.id;

      const payloadSize = calculateWebhookPayloadSize(webhookPayload);
      let sentMessage = null;

      // Splitting si payload trop gros
      if (payloadSize > DISCORD_LIMITS.WEBHOOK_SAFE_SIZE) {
        const textPayload = {
          content: webhookPayload.content, embeds: webhookPayload.embeds,
          username: webhookPayload.username, avatarURL: webhookPayload.avatarURL,
          allowedMentions: webhookPayload.allowedMentions
        };
        if (isTargetForumThread) textPayload.threadId = targetChannel.id;

        try {
          sentMessage = await this.sendWebhookWithRetry(webhook, validateAndAdjustWebhookPayload(textPayload));
        } catch (textError) {
          const minimalPayload = { content: webhookPayload.content || '⚠️ Message volumineux', username: webhookPayload.username, avatarURL: webhookPayload.avatarURL };
          if (isTargetForumThread) minimalPayload.threadId = targetChannel.id;
          sentMessage = await this.sendWebhookWithRetry(webhook, minimalPayload);
        }

        // Fichiers par groupes
        if (webhookPayload.files?.length > 0) {
          const fileGroups = splitFilesIntoGroups(webhookPayload.files);
          for (let i = 0; i < fileGroups.length; i++) {
            const filePayload = { files: fileGroups[i], username: webhookPayload.username, avatarURL: webhookPayload.avatarURL, allowedMentions: { parse: [] } };
            if (isTargetForumThread) filePayload.threadId = targetChannel.id;
            try {
              await this.sendWebhookWithRetry(webhook, filePayload);
            } catch (fileError) {
              // Fallback liens
              if (sourceMessage.attachments?.size > 0) {
                let linksContent = `📎 **Fichiers** :\n`;
                for (const [, att] of sourceMessage.attachments) {
                  linksContent += `• [${att.name}](${att.url})\n`;
                  if (linksContent.length > 1800) break;
                }
                const linkPayload = { content: linksContent, username: webhookPayload.username, avatarURL: webhookPayload.avatarURL };
                if (isTargetForumThread) linkPayload.threadId = targetChannel.id;
                await this.sendWebhookWithRetry(webhook, linkPayload);
              }
            }
          }
        }
      } else {
        sentMessage = await this.sendWebhookWithRetry(webhook, validateAndAdjustWebhookPayload(webhookPayload));
      }

      // ProxAuth: bouton déblocage si URL détectée
      if (sentMessage && content) {
        try {
          const ProxAuthDetector = require('../utils/proxauthDetector');
          const ProxAuthCache = require('../models/ProxAuthCache');
          const detected = ProxAuthDetector.detectProxAuthUrls(content);
          if (detected.length > 0) {
            const proxauthUrl = detected[0];
            const { maskedText } = ProxAuthDetector.maskProxAuthUrls(content);
            const buttonRow = ProxAuthDetector.createUnlockButtonRow(proxauthUrl);
            await webhook.editMessage(sentMessage.id, { content: maskedText, components: [buttonRow] });
            await ProxAuthCache.findOneAndUpdate(
              { proxauthUrl },
              { $set: { messageId: sentMessage.id, webhookId: webhook.id, webhookToken: webhook.token, finalUrl: null, unlockedBy: null } },
              { upsert: true, new: true }
            );
          }
        } catch (proxauthError) {
          // Silently ignore ProxAuth errors
        }
      }

      // Réactions, mentions, threads (protégés si webhook a échoué)
      if (sentMessage) await this.processReactions(sourceMessage, sentMessage, targetChannel.guild);
      if (sentMessage) await this.processMessageMentions(sourceMessage, sentMessage, targetChannel, sourceGuild);
      if (sentMessage && sourceMessage.hasThread) await this.processThread(sourceMessage, sentMessage, sourceGuild);

      // Stocker infos message mirroiré (seulement si webhook a réussi)
      if (sentMessage && sourceMessage.channel?.id) {
        await this.markMessageAsProcessed(sourceMessage.id, sourceMessage.channel.id, sentMessage.id, targetChannel.id, targetChannel.guild.id, webhook.id, webhook.token, isBuffered, content);
      }

      // 🔄 Créer les salons manquants en arrière-plan et mettre à jour le message
      if (this._lastPendingChannels && this._lastPendingChannels.length > 0) {
        this.processDeferredChannelCreations(this._lastPendingChannels, sourceMessage.id);
        this._lastPendingChannels = null;
      }

      // Tracking activité
      if (this.client.services?.activityMonitor) this.client.services.activityMonitor.recordActivity();

      // LOG UNIQUE DE SUCCÈS (1 ligne par message)
      logMessageSuccess(sourceMessage.id, sourceMessage.author.username, targetChannel.name, Math.round(payloadSize / 1024));
      return sentMessage;

    } catch (error) {
      console.error(`❌ processMessage error: ${error.message}`);
      throw error;
    }
  }

  // Traiter les mentions de rôles et @everyone/@here pour notifications
  async processMessageMentions(sourceMessage, sentMessage, targetChannel, sourceGuild) {
    try {
      // Protection null-safety: skip si webhook a échoué
      if (!sentMessage) return;

      const hasRoleMentions = sourceMessage.mentions?.roles?.size > 0;
      const hasEveryoneMention = sourceMessage.mentions?.everyone === true;

      // Aucune mention à traiter
      if (!hasRoleMentions && !hasEveryoneMention) return;
      if (!this.client.services?.mentionNotifier) return;

      const { getNotificationChannelIdFromDB } = require('../config/notificationChannels');
      const targetGuildId = targetChannel.guild.id;

      // Récupérer config depuis DB en priorité
      let notificationChannelId = await getNotificationChannelIdFromDB(targetGuildId, 'MENTIONS_LOG');
      if (!notificationChannelId) return;

      // Charger config pour vérifier les options
      const ServerConfig = require('../models/ServerConfig');
      const config = await ServerConfig.findOne({ guildId: targetGuildId });
      const mentionConfig = config?.mentionLogsConfig || {};

      // Vérifier si les bots sont autorisés
      const allowBotMentions = mentionConfig.allowBotMentions || process.env.ALLOW_BOT_MENTIONS === 'true';
      if (sourceMessage.author?.bot && !allowBotMentions) return;

      // Vérifier blacklist du salon
      const MentionBlacklist = require('../models/MentionBlacklist');
      const channelName = sourceMessage.channel?.name;
      if (channelName && sourceGuild?.id) {
        const isBlacklisted = await MentionBlacklist.isChannelBlacklisted(sourceGuild.id, channelName);
        if (isBlacklisted) return;
      }

      // 🔔 Traiter @everyone/@here si activé
      if (hasEveryoneMention && (mentionConfig.detectEveryone !== false)) {
        const everyoneData = {
          channelName: channelName || 'canal-inconnu',
          channelId: sourceMessage.channel?.id || 'unknown-channel',
          roleName: '@everyone/@here',
          userId: sourceMessage.author?.id || 'unknown-author',
          username: sourceMessage.author?.username || 'unknown-user',
          messageId: sentMessage.id,
          isEveryone: true
        };
        await this.client.services.mentionNotifier.sendMentionNotification(everyoneData, notificationChannelId, targetGuildId);
      }

      // 🔔 Traiter les mentions de rôles si activé
      if (hasRoleMentions && (mentionConfig.detectRoles !== false)) {
        for (const [, role] of sourceMessage.mentions.roles) {
          const mentionData = {
            channelName: channelName || 'canal-inconnu',
            channelId: sourceMessage.channel?.id || 'unknown-channel',
            roleName: role.name,
            userId: sourceMessage.author?.id || 'unknown-author',
            username: sourceMessage.author?.username || 'unknown-user',
            messageId: sentMessage.id,
          };
          await this.client.services.mentionNotifier.sendMentionNotification(mentionData, notificationChannelId, targetGuildId);
        }
      }
    } catch (error) {
      // Silently ignore mention errors to not break scraping flow
    }
  }

  // Créer ou récupérer le webhook pour un salon
  async getOrCreateWebhook(channel) {
    try {
      if (!channel || typeof channel !== 'object') throw new Error('Canal invalide');

      let targetChannel = channel;
      let channelName = channel.name || 'unknown';

      // Threads: utiliser le parent
      if (channel.type >= 10 && channel.type <= 12) {
        if (channel.parent) targetChannel = channel.parent;
        else throw new Error(`Thread sans parent: ${channelName}`);
      }

      if (!targetChannel.fetchWebhooks) throw new Error('Canal invalide: fetchWebhooks manquant');
      
      if (!targetChannel.createWebhook) throw new Error('Canal invalide: createWebhook manquant');
      if (!targetChannel.id || !targetChannel.name || !targetChannel.guild) throw new Error('Canal invalide: propriétés manquantes');
      if (targetChannel.type !== 0 && targetChannel.type !== 5 && targetChannel.type !== 15) throw new Error(`Type non supporté: ${targetChannel.type}`);

      const webhooks = await targetChannel.fetchWebhooks();
      let webhook = webhooks.find(wh => wh.name === 'Mirror Bot Webhook');

      if (!webhook) {
        webhook = await targetChannel.createWebhook({ name: 'Mirror Bot Webhook', avatar: null, reason: 'Mirror webhook' });
      }

      return webhook;
    } catch (error) {
      console.error(`❌ Webhook error #${channel?.name || 'unknown'}: ${error.message}`);
      throw error;
    }
  }

  // 📝 TRAITER LE CONTENU AVEC MENTIONS INTELLIGENTES (version événementielle)
  // options.sourceMessageId: si fourni, collecte les salons manquants pour création différée
  async processAdvancedMessageContent(content, sourceGuild, options = {}) {
    if (!content) return '';

    let processedContent = content;
    // Réinitialiser le tableau des salons en attente pour ce traitement
    const pendingChannels = [];

    // Traiter les mentions d'utilisateurs
    if (processedContent.includes('<@')) {
      processedContent = await this.processUserMentions(processedContent, sourceGuild);
    }

    // Traiter les mentions de salons
    if (processedContent.includes('<#')) {
      processedContent = await this.processChannelMentions(processedContent, sourceGuild, {
        sourceMessageId: options.sourceMessageId,
        pendingChannels: pendingChannels
      });
    }

    // Traiter les mentions de rôles
    if (processedContent.includes('<@&')) {
      try {
        processedContent = await this.processRoleMentions(processedContent, sourceGuild);
      } catch (roleError) {
        console.error(`❌ Erreur traitement mentions rôles:`, roleError.message);
        const defaultNames = require('../config/defaultNames');
        processedContent = processedContent.replace(/<@&(\d+)>/g, `**@${defaultNames.mirrorDefaults.roleName}**`);
      }
    }

    // 🔗 NOUVEAU: Traiter les liens Discord vers des messages
    if (processedContent.includes('discord.com/channels/')) {
      try {
        processedContent = await this.processDiscordLinks(processedContent, sourceGuild);
      } catch (linkError) {
        console.error(`❌ Erreur traitement liens Discord:`, linkError.message);
      }
    }

    // Si on collecte les salons manquants, les stocker temporairement
    if (options.sourceMessageId && pendingChannels.length > 0) {
      this._lastPendingChannels = pendingChannels;
    } else {
      this._lastPendingChannels = null;
    }

    return processedContent;
  }

  // 📋 TRAITER LES EMBEDS COMPLETS (version événementielle)
  async processAdvancedEmbeds(sourceEmbeds, sourceGuild = null, sourceMessage = null) {
    const { EmbedBuilder } = require('discord.js');
    const processedEmbeds = [];
    
    // Limiter à 10 embeds maximum selon Discord
    const embargoEmbeds = sourceEmbeds.slice(0, DISCORD_LIMITS.EMBEDS_PER_MESSAGE);
    
    for (const sourceEmbed of embargoEmbeds) {
      try {
        const embed = new EmbedBuilder();
        
        // Détecter l'embed "Nouveau Ping Proxcop !" pour ajouter un bouton
        let isProxcopPingEmbed = false;
        let sourceChannelId = null;
        
        if (sourceEmbed.title && sourceEmbed.title.includes("Nouveau Ping Proxcop")) {
          isProxcopPingEmbed = true;
        } else if (sourceEmbed.title && (sourceEmbed.title.includes("Ping Proxcop") || sourceEmbed.title.includes("Proxcop"))) {
          // 🆕 DÉTECTION PLUS LARGE pour captures les variantes
          isProxcopPingEmbed = true;
        }
        
        // Propriétés de base
        if (sourceEmbed.title) {
          let processedTitle = sourceEmbed.title.substring(0, 256);
          
          // Traiter les mentions de rôles
          if (processedTitle.includes('<@&')) {
            try {
              processedTitle = await this.processRoleMentions(processedTitle, sourceGuild);
            } catch (titleRoleError) {
              console.error(`❌ Erreur rôles titre embed:`, titleRoleError.message);
              const defaultNames = require('../config/defaultNames');
              processedTitle = processedTitle.replace(/<@&(\d+)>/g, `**@${defaultNames.mirrorDefaults.roleName}**`);
            }
          }
          
          // Traiter les mentions de salons
          if (processedTitle.includes('<#')) {
            try {
              processedTitle = await this.processChannelMentions(processedTitle, sourceGuild);
            } catch (titleChannelError) {
              console.error(`❌ Erreur salons titre embed:`, titleChannelError.message);
              const defaultNames = require('../config/defaultNames');
              processedTitle = processedTitle.replace(/<#(\d+)>/g, `**#${defaultNames.mirrorDefaults.channelName}**`);
            }
          }
          
          embed.setTitle(processedTitle);
        }
        
        if (sourceEmbed.description) {
          let processedDescription = sourceEmbed.description.substring(0, 4096);
          
          // Traiter les mentions de rôles
          if (processedDescription.includes('<@&')) {
            try {
              processedDescription = await this.processRoleMentions(processedDescription, sourceGuild);
            } catch (descRoleError) {
              console.error(`❌ Erreur rôles description embed:`, descRoleError.message);
              const defaultNames = require('../config/defaultNames');
              processedDescription = processedDescription.replace(/<@&(\d+)>/g, `**@${defaultNames.mirrorDefaults.roleName}**`);
            }
          }
          
          // Traiter les mentions de salons
          if (processedDescription.includes('<#')) {
            try {
              processedDescription = await this.processChannelMentions(processedDescription, sourceGuild);
            } catch (descChannelError) {
              console.error(`❌ Erreur salons description embed:`, descChannelError.message);
              const defaultNames = require('../config/defaultNames');
              processedDescription = processedDescription.replace(/<#(\d+)>/g, `**#${defaultNames.mirrorDefaults.channelName}**`);
            }
          }
          
          embed.setDescription(processedDescription);
        }
        
        if (sourceEmbed.url) embed.setURL(sourceEmbed.url);
        if (sourceEmbed.color) embed.setColor(sourceEmbed.color);
        if (sourceEmbed.timestamp) embed.setTimestamp(new Date(sourceEmbed.timestamp));
        
        // Auteur
        if (sourceEmbed.author) {
          embed.setAuthor({
            name: sourceEmbed.author.name?.substring(0, 256) || '',
            iconURL: sourceEmbed.author.iconURL || sourceEmbed.author.icon_url || undefined,
            url: sourceEmbed.author.url || undefined
          });
        }
        
        // Footer
        if (sourceEmbed.footer) {
          embed.setFooter({
            text: sourceEmbed.footer.text?.substring(0, 2048) || '',
            iconURL: sourceEmbed.footer.iconURL || sourceEmbed.footer.icon_url || undefined
          });
        }
        
        // Images
        if (sourceEmbed.thumbnail?.url) {
          embed.setThumbnail(sourceEmbed.thumbnail.url);
        }
        
        if (sourceEmbed.image?.url) {
          embed.setImage(sourceEmbed.image.url);
        }
        
        // Fields avec traitement des mentions
        if (sourceEmbed.fields && sourceEmbed.fields.length > 0) {
          for (const field of sourceEmbed.fields.slice(0, 25)) {
            let fieldName = field.name?.substring(0, 256) || 'Champ';
            let fieldValue = field.value?.substring(0, 1024) || 'Valeur';
            
            // Extraire l'ID du salon pour le bouton "Y aller"
            if (isProxcopPingEmbed) {
              if (fieldName.includes("Channel") && fieldValue.includes("<#")) {
              const channelMatch = fieldValue.match(/<#(\d+)>/);
              if (channelMatch) {
                sourceChannelId = channelMatch[1];
                } else {
                }
              } else {
              }
            }
            
            // Traiter les mentions de rôles dans le nom du field
            if (fieldName.includes('<@&')) {
              try {
                fieldName = await this.processRoleMentions(fieldName, sourceGuild);
              } catch (roleNameError) {
                const defaultNames = require('../config/defaultNames');
                fieldName = fieldName.replace(/<@&(\d+)>/g, `**@${defaultNames.mirrorDefaults.roleName}**`);
              }
            }
            
            // Traiter les mentions d'utilisateurs dans le nom du field
            if (fieldName.includes('<@')) {
              fieldName = await this.processUserMentions(fieldName, sourceGuild);
            }
            
            // Traiter les mentions de salons dans le nom du field
            if (fieldName.includes('<#')) {
              try {
                fieldName = await this.processChannelMentions(fieldName, sourceGuild);
              } catch (channelError) {
                const defaultNames = require('../config/defaultNames');
                fieldName = fieldName.replace(/<#(\d+)>/g, `**#${defaultNames.mirrorDefaults.channelName}**`);
              }
            }
            
            // Traiter les mentions de rôles dans la valeur du field
            if (fieldValue.includes('<@&')) {
              try {
                fieldValue = await this.processRoleMentions(fieldValue, sourceGuild);
              } catch (correspondenceError) {
                try {
                  const defaultNames = require('../config/defaultNames');
                  fieldValue = fieldValue.replace(/<@&(\d+)>/g, `**@${defaultNames.mirrorDefaults.roleName}**`);
                } catch (fallbackError) {
                  fieldValue = fieldValue.replace(/<@&(\d+)>/g, `**@Members**`);
                }
              }
            }
            
            // Traiter les mentions de salons dans la valeur du field
            if (fieldValue.includes('<#')) {
              try {
                fieldValue = await this.processChannelMentions(fieldValue, sourceGuild);
              } catch (channelError) {
                try {
                  const defaultNames = require('../config/defaultNames');
                  fieldValue = fieldValue.replace(/<#(\d+)>/g, `**#${defaultNames.mirrorDefaults.channelName}**`);
                } catch (fallbackError) {
                  fieldValue = fieldValue.replace(/<#(\d+)>/g, `**#inconnu**`);
                }
              }
            }
            
            embed.addFields({
              name: fieldName,
              value: fieldValue,
              inline: field.inline || false
            });
          }
        }
        
        // Note : Ancienne logique des boutons "Y aller" supprimée
        // Les notifications sont maintenant gérées par le nouveau système
        
        // Validation : Vérifier que l'embed a au moins une propriété visible
        const embedData = embed.toJSON();
        const hasVisibleContent = 
          embedData.title ||
          embedData.description ||
          (embedData.fields && embedData.fields.length > 0) ||
          embedData.image?.url ||
          embedData.thumbnail?.url ||
          embedData.author?.name ||
          embedData.footer?.text;
        
        if (hasVisibleContent) {
          // Vérifier que l'embed ne dépasse pas les limites de taille
          const { isEmbedValid } = require('../utils/discordLimits');
          if (isEmbedValid(embedData)) {
            processedEmbeds.push(embed);
          } else {
            console.warn(`⚠️ Embed trop volumineux, ignoré (${JSON.stringify(embedData).length} caractères)`);
          }
        }
        
      } catch (error) {
        console.error('❌ Erreur traitement embed:', error);
      }
    }
    
    // 🎯 RETOURNER LES EMBEDS TRAITÉS
    return {
      embeds: processedEmbeds
    };
  }

  // Traiter le contenu du message (mentions, liens, etc.)
  async processMessageContent(sourceMessage, sourceGuild) {
    let content = sourceMessage.content;
    
    if (!content) return '';

    // Traiter les mentions d'utilisateurs
    content = await this.processMentions(content, sourceGuild);
    
    // Traiter les mentions de salons
    content = await this.processChannelMentions(content, sourceGuild);
    
    // Traiter les mentions de rôles
    content = await this.processRoleMentions(content, sourceGuild);
    
    // 🔗 NOUVEAU: Traiter les liens Discord vers des messages
    content = await this.processDiscordLinks(content, sourceGuild);
    
    return content;
  }

  // Traiter les mentions d'utilisateurs (UNIFORMISÉ AVEC INDEX.JS)
  async processMentions(content, sourceGuild) {
    const userMentionRegex = /<@!?(\d+)>/g;
    let processedContent = content;
    
    const matches = content.matchAll(userMentionRegex);
    for (const match of matches) {
      try {
        const userId = match[1];
        
        // 🔧 UTILISER LA MÊME LOGIQUE QUE processUserMentions dans index.js
        let userFound = false;
        
        // 🚨 PROTECTION CRITIQUE : Vérifier si le userClient est configuré AVANT d'appeler getUserData
        const hasUserToken = this.client && this.client.services && this.client.services.userClient && 
                            this.client.services.userClient.hasUserToken && 
                            this.client.services.userClient.hasUserToken(sourceGuild.id);
        
        // 1. Essayer avec le token utilisateur (API Discord) si disponible
        let userData = null;
        if (hasUserToken) {
          try {
            userData = this.client.services.userClient.getUserData(sourceGuild.id);
          } catch (userDataError) {
            // Continue
            userData = null;
          }
        }
        
        if (userData && userData.token) {
          try {
            const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
            const response = await fetch(`https://discord.com/api/v10/users/${userId}`, {
              headers: {
                'Authorization': userData.token,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
              }
            });
            
            if (response.ok) {
              const user = await response.json();
              processedContent = processedContent.replace(match[0], `**@${user.username}**`);
              userFound = true;
            }
          } catch (apiError) {
            // Fallback vers la méthode suivante
          }
        }
        
        // 2. Fallback : Utiliser le client Discord officiel
        if (!userFound) {
          try {
            const clientToUse = this.userClient || this.client;
            const user = await clientToUse.users.fetch(userId);
            processedContent = processedContent.replace(match[0], `**@${user.username}**`);
          } catch (clientError) {
            // 3. Fallback final : Nom par défaut
            const defaultNames = require('../config/defaultNames');
            processedContent = processedContent.replace(match[0], `**@${defaultNames.mirrorDefaults.userName}**`);
          }
        }
        
      } catch (error) {
        // Fallback complet en cas d'erreur
        try {
          const defaultNames = require('../config/defaultNames');
          processedContent = processedContent.replace(match[0], `**@${defaultNames.mirrorDefaults.userName}**`);
        } catch (fallbackError) {
          // Fallback ultime
          processedContent = processedContent.replace(match[0], `**@inconnu**`);
        }
      }
    }
    
    return processedContent;
  }

  // Traiter les mentions de salons
  // options.sourceMessageId: si fourni, les salons manquants seront créés en différé
  // options.pendingChannels: tableau où stocker les salons à créer (rempli par la fonction)
  async processChannelMentions(content, sourceGuild, options = {}) {
    const channelMentionRegex = /<#(\d+)>/g;
    let processedContent = content;
    const pendingChannels = options.pendingChannels || [];
    
    const matches = content.matchAll(channelMentionRegex);
    for (const match of matches) {
      try {
        const channelId = match[1];
        // Récupération du salon source
        let sourceChannel = null;
        let sourceChannelName = null;
        
        if (this.client && this.client.services && this.client.services.userClient) {
          const hasToken = this.client.services.userClient.hasUserToken(sourceGuild.id);
          
          if (hasToken) {
            try {
              const userData = this.client.services.userClient.getUserData(sourceGuild.id);
              
              if (userData && userData.token) {
                // Récupérer salons (pas de threads via fetchGuildThreads car endpoint bot-only)
                const sourceChannels = await this.client.services.userClient.fetchGuildChannels(userData.token, sourceGuild.id);
                const allSourceChannels = sourceChannels;
                
                sourceChannel = allSourceChannels.find(ch => ch.id === channelId);
                
                if (sourceChannel) {
                  sourceChannelName = sourceChannel.name;
                  const channelType = sourceChannel.type >= 11 ? '🧵 Thread' : 'Salon';
                }
              }
            } catch (apiError) {
              // Fallback vers autres méthodes
            }
          }
        }
        
        // Méthode alternative : client Discord.js
        if (!sourceChannel && this.client) {
          try {
            const discordChannel = await this.client.channels.fetch(channelId).catch(() => null);
            if (discordChannel && discordChannel.guild && discordChannel.guild.id === sourceGuild.id) {
              sourceChannelName = discordChannel.name;
            }
          } catch (discordError) {
            // Continuer vers la méthode suivante
          }
        }
        
        // Recherche dans les salons mis en cache
        if (!sourceChannelName) {
          try {
            // 🔧 FIX #inconnu: Chercher d'abord dans le cache du sourceGuild (selfbot)
            // C'est le cache le plus fiable car le selfbot reçoit les channels via WebSocket
            if (sourceGuild?.channels?.cache) {
              const selfbotChannel = sourceGuild.channels.cache.get(channelId);
              if (selfbotChannel) {
                sourceChannelName = selfbotChannel.name;
              }
            }

            // Si pas trouvé dans sourceGuild, chercher dans le cache du bot officiel
            if (!sourceChannelName) {
              for (const guild of this.client.guilds.cache.values()) {
                const cachedChannel = guild.channels.cache.get(channelId);
                if (cachedChannel) {
                  sourceChannelName = cachedChannel.name;
                  break;
                }
              }
            }
          } catch (cacheError) {
            // Continue
          }
        }
        
        // Recherche dans la base de données locale
        if (!sourceChannelName) {
          try {
            // Channel déjà importé ligne 3

            // Chercher par sourceChannelId (ID du salon sur le serveur source)
            const dbChannel = await Channel.findOne({ 
              sourceChannelId: channelId,
              serverId: sourceGuild.id 
            });
            
            if (dbChannel) {
              sourceChannelName = dbChannel.name;
            } else {
              // Chercher par discordId (au cas où ce serait l'ID du salon mirror)
              const dbChannelByMirrorId = await Channel.findOne({ 
                discordId: channelId
              });
              
              if (dbChannelByMirrorId) {
                sourceChannelName = dbChannelByMirrorId.name;
              }
            }
          } catch (dbError) {
            // Continue
          }
        }

        // 🆕 FIX #inconnu: Appel API direct comme DERNIER recours
        // Résout le problème de race condition: le message arrive avant que les caches soient à jour
        // L'API Discord répond immédiatement même si le channel vient d'être créé
        if (!sourceChannelName && this.client.services?.userClient) {
          try {
            // Trouver le targetGuild pour récupérer le token
            const targetGuildForApi = this.client.guilds.cache.find(guild =>
              this.client.services.userClient.hasUserToken?.(guild.id) &&
              this.client.services.userClient.getSourceGuild?.(guild.id)?.id === sourceGuild.id
            );

            if (targetGuildForApi) {
              const userData = this.client.services.userClient.getUserData(targetGuildForApi.id);
              if (userData?.token) {
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
                    sourceChannelName = channelData.name;
                    console.log(`✅ [API Direct] Channel récupéré via API: #${sourceChannelName} (${channelId})`);
                  }
                }
                // Si 403/404, on continue silencieusement vers le fallback
              }
            }
          } catch (apiDirectError) {
            // Silencieux - on continue vers le fallback standard
          }
        }

        // NOTE: Pattern matching supprimé - causait fallback incorrect vers "general-en"
        // Les salons manquants seront créés automatiquement via queueDeferredChannelCreation

        // Recherche du salon mirror correspondant
        let mirrorChannelId = null;
        let mirrorChannelName = sourceChannelName;

        // Récupérer le serveur mirror (où le message va être posté)
        const targetGuild = this.client.guilds.cache.find(guild =>
          this.client.services && this.client.services.userClient &&
          this.client.services.userClient.hasUserToken &&
          this.client.services.userClient.hasUserToken(guild.id) &&
          this.client.services.userClient.getSourceGuild &&
          this.client.services.userClient.getSourceGuild(guild.id) &&
          this.client.services.userClient.getSourceGuild(guild.id).id === sourceGuild.id
        );

        if (sourceChannelName && targetGuild) {
          // Vérifier d'abord le cache du correspondenceManager
          if (this.correspondenceManager && this.correspondenceManager.channelCache) {
            const cacheKey = `${channelId}_${targetGuild.id}`;
            if (this.correspondenceManager.channelCache.has(cacheKey)) {
              mirrorChannelId = this.correspondenceManager.channelCache.get(cacheKey);
            }
          }

          // Si pas dans le cache, utiliser getMirrorChannelId qui vérifie la DB
          if (!mirrorChannelId) {
            mirrorChannelId = await this.correspondenceManager.getMirrorChannelId(channelId, sourceGuild.id, targetGuild.id);
          }

          if (mirrorChannelId) {
            // Succès de correspondance
          } else {
            // Chercher par nom comme fallback
            const mirrorChannel = targetGuild.channels.cache.find(channel =>
              channel.name === sourceChannelName && (channel.type === 0 || channel.type === 2)
            );

            if (mirrorChannel) {
              // Enregistrer silencieusement pour éviter les doublons de logs
              if (this.correspondenceManager) {
                await this.correspondenceManager.registerChannelMappingSilently(
                  channelId,
                  sourceGuild.id,
                  sourceChannelName,
                  mirrorChannel.id
                );
              }
              mirrorChannelId = mirrorChannel.id;
            }

            // 🧵 FIX: Si pas trouvé, chercher dans threads.cache (threads type 11/12)
            if (!mirrorChannelId && sourceChannelName) {
              for (const [, channel] of targetGuild.channels.cache) {
                if (channel.threads?.cache) {
                  const thread = channel.threads.cache.find(t => t.name === sourceChannelName);
                  if (thread) {
                    mirrorChannelId = thread.id;
                    // Enregistrer pour éviter re-recherche
                    if (this.correspondenceManager) {
                      await this.correspondenceManager.registerChannelMappingSilently(
                        channelId,
                        sourceGuild.id,
                        sourceChannelName,
                        thread.id
                      );
                    }
                    break;
                  }
                }
              }
            }
          }
        }

        // Construire le résultat final
        let replacement;
        if (mirrorChannelId) {
          replacement = `<#${mirrorChannelId}>`;
        } else if (sourceChannelName) {
          replacement = `**#${sourceChannelName}**`;
          // 🔄 NOUVEAU: Collecter salon manquant pour création différée
          if (options.sourceMessageId && targetGuild) {
            pendingChannels.push({
              sourceChannelId: channelId,
              sourceChannelName: sourceChannelName,
              sourceGuildId: sourceGuild.id,
              targetGuildId: targetGuild.id
            });
          }
        } else {
          const defaultNames = require('../config/defaultNames');
          replacement = `**#${defaultNames.mirrorDefaults.channelName}**`;
        }
        
        processedContent = processedContent.replace(match[0], replacement);
        
      } catch (error) {
        console.error(`❌ Erreur mention salon:`, error.message);
        const defaultNames = require('../config/defaultNames');
        const fallback = `**#${defaultNames.mirrorDefaults.channelName}**`;
        processedContent = processedContent.replace(match[0], fallback);
      }
    }

    return processedContent;
  }

  /**
   * 🔄 Création différée de salons manquants puis mise à jour du message
   * Appelé après l'envoi du message pour créer les salons en arrière-plan
   * @param {Array} pendingChannels - Liste des salons à créer
   * @param {string} sourceMessageId - ID du message source
   */
  async processDeferredChannelCreations(pendingChannels, sourceMessageId) {
    if (!pendingChannels || pendingChannels.length === 0) return;

    // Dédupliquer par sourceChannelId
    const uniqueChannels = [];
    const seen = new Set();
    for (const ch of pendingChannels) {
      if (!seen.has(ch.sourceChannelId)) {
        seen.add(ch.sourceChannelId);
        uniqueChannels.push(ch);
      }
    }

    for (const channel of uniqueChannels) {
      // Éviter les créations en double si déjà en cours
      if (this.pendingChannelCreations.has(channel.sourceChannelId)) {
        continue;
      }
      this.pendingChannelCreations.add(channel.sourceChannelId);

      // Lancer la création en arrière-plan (non-bloquant)
      this.queueDeferredChannelCreation(
        channel.sourceChannelId,
        channel.sourceChannelName,
        sourceMessageId,
        channel.sourceGuildId,
        channel.targetGuildId
      );
    }
  }

  /**
   * 🔄 Crée un salon manquant en arrière-plan et met à jour le message
   */
  async queueDeferredChannelCreation(sourceChannelId, sourceChannelName, sourceMessageId, sourceGuildId, targetGuildId) {
    // Délai pour laisser markMessageAsProcessed() finir
    setTimeout(async () => {
      try {
        // 1. Créer le salon via correspondenceManager
        const mapping = await this.correspondenceManager.autoCreateChannelMapping(
          sourceChannelId, sourceGuildId, targetGuildId
        );

        if (mapping && mapping.discordId) {
          // 2. Éditer le message avec la nouvelle mention
          const updated = await this.editMessageWithNewChannelMention(
            sourceMessageId,
            sourceChannelName,
            mapping.discordId
          );
          if (updated) {
            console.log(`✅ Salon créé et message mis à jour: #${sourceChannelName}`);
          }
        } else {
          // Création échouée - le message reste avec **#nom**
          console.log(`⚠️ Création salon échouée: #${sourceChannelName} - message reste en texte`);
        }
      } catch (error) {
        console.error(`❌ Erreur création différée #${sourceChannelName}:`, error.message);
      } finally {
        this.pendingChannelCreations.delete(sourceChannelId);
      }
    }, 500); // 500ms délai pour que la DB ait le ProcessedMessage
  }

  /**
   * 🔄 Édite un message pour remplacer **#nom** par <#id> après création du salon
   * @param {string} sourceMessageId - ID du message source
   * @param {string} channelName - Nom du salon (pour trouver le placeholder)
   * @param {string} newChannelId - ID du nouveau salon créé
   * @returns {Promise<boolean>} - true si édition réussie
   */
  async editMessageWithNewChannelMention(sourceMessageId, channelName, newChannelId) {
    try {
      // 1. Récupérer le ProcessedMessage avec les infos webhook
      const processed = await ProcessedMessage.findOne({
        discordId: sourceMessageId
      });

      if (!processed || !processed.webhookToken) {
        console.warn(`⚠️ ProcessedMessage non trouvé pour édition: ${sourceMessageId}`);
        return false;
      }

      if (!processed.processedContent) {
        console.warn(`⚠️ processedContent vide pour: ${sourceMessageId}`);
        return false;
      }

      // 2. Remplacer le texte placeholder par la vraie mention
      const oldText = `**#${channelName}**`;
      const newText = `<#${newChannelId}>`;

      if (!processed.processedContent.includes(oldText)) {
        // Peut-être déjà mis à jour ou format différent
        return false;
      }

      // Remplacer TOUTES les occurrences
      const newContent = processed.processedContent.split(oldText).join(newText);

      // 3. Créer le WebhookClient et éditer
      const webhook = new WebhookClient({
        id: processed.webhookId,
        token: processed.webhookToken
      });

      await this.editWebhookWithRetry(webhook, processed.mirrorMessageId, {
        content: newContent
      });

      // 4. Mettre à jour processedContent en DB pour cohérence
      await ProcessedMessage.updateOne(
        { discordId: sourceMessageId },
        { processedContent: newContent }
      );

      return true;

    } catch (error) {
      // Ne pas spammer les logs pour les erreurs attendues (webhook expiré, etc.)
      if (error.code !== 10015 && error.code !== 50027) { // Unknown Webhook, Invalid Webhook Token
        console.error(`❌ Erreur édition message après création salon:`, error.message);
      }
      return false;
    }
  }

  // Traiter les mentions de rôles avec vraies notifications sur le serveur mirror
  async processRoleMentions(content, sourceGuild) {
    const roleMentionRegex = /<@&(\d+)>/g;
    let processedContent = content;
    
    if (!content || !content.includes('<@&')) {
      return content;
    }

    // 🛡️ Protection null-safety pour sourceGuild
    if (!sourceGuild?.id) {
      return content;
    }

    // Trouver le serveur mirror correspondant
    const targetGuild = this.correspondenceManager.getTargetGuildId(sourceGuild.id);
    const targetGuildObj = this.client.guilds.cache.get(targetGuild);
    
    if (!targetGuildObj) {
      const defaultNames = require('../config/defaultNames');
      return content.replace(roleMentionRegex, `**@${defaultNames.mirrorDefaults.roleName}**`);
    }
    
    const matches = content.matchAll(roleMentionRegex);
    for (const match of matches) {
      try {
        const sourceRoleId = match[1];
        
        // Utiliser le système de correspondance
        const mirrorRoleId = await this.correspondenceManager.getMirrorRoleId(
          sourceRoleId, 
          sourceGuild.id, 
          targetGuildObj.id
        );
        
        if (mirrorRoleId) {
          processedContent = processedContent.replace(match[0], `<@&${mirrorRoleId}>`);
          continue;
        }
        
        // Pas de correspondance, essayer de créer une
        let sourceRoleName = null;
        
        try {
          const userData = this.client.services.userClient.getUserData(sourceGuild.id);
          if (userData && userData.token) {
            const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
            const response = await fetch(`https://discord.com/api/v10/guilds/${sourceGuild.id}/roles`, {
              headers: {
                'Authorization': userData.token,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
              }
            });
            
            if (response.ok) {
              const roles = await response.json();
              const sourceRole = roles.find(role => role.id === sourceRoleId);
              if (sourceRole) {
                sourceRoleName = sourceRole.name;
              }
            }
          }
        } catch (apiError) {
          // Continuer sans nom
        }
        
        if (sourceRoleName) {
          const mirrorRole = targetGuildObj.roles.cache.find(role => role.name === sourceRoleName);
          
          if (mirrorRole) {
            await this.correspondenceManager.registerRoleMapping(
              sourceRoleId, 
              sourceGuild.id, 
              sourceRoleName, 
              mirrorRole.id
            );
            
            processedContent = processedContent.replace(match[0], `<@&${mirrorRole.id}>`);
            continue;
          } else {
            processedContent = processedContent.replace(match[0], `**@${sourceRoleName}**`);
            continue;
          }
        }
        
        // Fallback par défaut
        const defaultNames = require('../config/defaultNames');
        processedContent = processedContent.replace(match[0], `**@${defaultNames.mirrorDefaults.roleName}**`);
        
      } catch (error) {
        console.error(`❌ Erreur mention rôle:`, error.message);
        const defaultNames = require('../config/defaultNames');
        const fallback = `**@${defaultNames.mirrorDefaults.roleName}**`;
        processedContent = processedContent.replace(match[0], fallback);
      }
    }
    
    return processedContent;
  }

  // 🔗 Traiter les liens Discord vers des messages
  async processDiscordLinks(content, sourceGuild) {
    // Regex pour détecter les liens Discord vers des messages
    // Format: https://discord.com/channels/guildId/channelId/messageId
    const discordLinkRegex = /https:\/\/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)/g;
    let processedContent = content;
    
    const matches = content.matchAll(discordLinkRegex);
    for (const match of matches) {
      try {
        const [fullLink, guildId, channelId, messageId] = match;
        
        // Vérifier si c'est un lien vers le serveur source
        if (guildId !== sourceGuild.id) {
          // Lien vers un autre serveur, on ne le modifie pas
          continue;
        }
        
        // Chercher le message mirroré correspondant dans la base
        const ProcessedMessage = require('../models/ProcessedMessage');
        const mirroredMessage = await ProcessedMessage.findOne({
          discordId: messageId,
          sourceChannelId: channelId
        });
        
        if (mirroredMessage && mirroredMessage.mirrorMessageId) {
          // Message trouvé, créer le lien vers le message mirroré
          const mirrorLink = `https://discord.com/channels/${mirroredMessage.mirrorGuildId}/${mirroredMessage.mirrorChannelId}/${mirroredMessage.mirrorMessageId}`;
          processedContent = processedContent.replace(fullLink, mirrorLink);
        } else {
          // Message non trouvé, essayer de trouver au moins le canal (Channel déjà importé ligne 3)
          const mirrorChannel = await Channel.findOne({
            sourceChannelId: channelId,
            serverId: sourceGuild.id
          });
          
          if (mirrorChannel && mirrorChannel.discordId) {
            // Canal trouvé, créer un lien vers le canal (sans le message)
            const targetGuildId = this.correspondenceManager?.getTargetGuildId(sourceGuild.id) || 
                                 this.client.guilds.cache.first()?.id;
            
            if (targetGuildId) {
              // Remplacer par une mention du canal avec indication
              const channelMention = `<#${mirrorChannel.discordId}> *(message original non trouvé)*`;
              processedContent = processedContent.replace(fullLink, channelMention);
            }
          } else {
            // Ni message ni canal trouvé, utiliser un fallback
            const defaultNames = require('../config/defaultNames');
            const fallback = `**#${defaultNames.mirrorDefaults.channelName}** *(lien original inaccessible)*`;
            processedContent = processedContent.replace(fullLink, fallback);
          }
        }
      } catch (error) {
        console.error(`❌ Erreur traitement lien Discord:`, error.message);
        // En cas d'erreur, laisser le lien original
      }
    }
    
    return processedContent;
  }

  // Traiter les attachments avec retry et gestion améliorée
  async processAttachments(sourceAttachments) {
    const processedFiles = [];
    
    for (const attachment of sourceAttachments.values()) {
      // Vérifier la taille avant de télécharger
      if (attachment.size > 8 * 1024 * 1024) {
        console.warn(`⚠️ Fichier ${attachment.name} dépasse 8MB (${Math.round(attachment.size / 1024 / 1024)}MB), sera ignoré`);
        continue;
      }
      
      let retryCount = 0;
      const maxRetries = 3;
      let success = false;
      
      while (retryCount < maxRetries && !success) {
        try {
          // Télécharger le fichier avec timeout adapté à la taille
          const timeoutMs = Math.max(30000, attachment.size / 1024); // Min 30s, +1s par MB
          const response = await axios.get(attachment.url, {
            responseType: 'arraybuffer',
            timeout: timeoutMs,
            maxContentLength: 8 * 1024 * 1024, // 8MB max
            maxBodyLength: 8 * 1024 * 1024
          });
          
          const file = new AttachmentBuilder(Buffer.from(response.data), {
            name: attachment.name,
            description: attachment.description
          });
          
          processedFiles.push(file);
          success = true;
          
        } catch (error) {
          retryCount++;
          
          if (retryCount < maxRetries) {
            // Backoff exponentiel: 1s, 2s, 4s
            const waitTime = Math.pow(2, retryCount - 1) * 1000;
            console.warn(`⚠️ Erreur téléchargement ${attachment.name}, retry ${retryCount}/${maxRetries} dans ${waitTime}ms...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
          } else {
            console.error(`❌ Échec définitif du téléchargement de ${attachment.name} après ${maxRetries} essais:`, error.message);
          }
        }
      }
    }
    
    return processedFiles;
  }

  // Traiter les réactions avec vérification d'existence des emojis
  async processReactions(sourceMessage, targetMessage, targetGuild) {
    if (!sourceMessage.reactions || sourceMessage.reactions.cache.size === 0) {
      return; // Pas de réactions à traiter
    }
    
    try {
      for (const reaction of sourceMessage.reactions.cache.values()) {
        try {
          const emoji = reaction.emoji;
          
          // 🔍 VÉRIFIER SI L'EMOJI EXISTE SUR LE SERVEUR MIRROR
          let canAddReaction = false;
          
          if (emoji.id) {
            // Emoji personnalisé - vérifier s'il existe sur le serveur mirror
            const mirrorEmoji = targetGuild.emojis.cache.get(emoji.id);
            if (mirrorEmoji) {
              canAddReaction = true;
            } else {
            }
          } else {
            // Emoji Unicode standard - toujours disponible
            canAddReaction = true;
          }
          
          if (canAddReaction) {
            await targetMessage.react(emoji);
            await new Promise(resolve => setTimeout(resolve, 500)); // Délai entre réactions
          }
          
        } catch (error) {
          // Erreur 10014 = Unknown Emoji (emoji n'existe pas)
          if (error.code === 10014) {
          } else {
            console.error(`Erreur lors de l'ajout de la réaction ${reaction.emoji}:`, error);
          }
        }
      }
    } catch (error) {
      console.error('Erreur lors du traitement des réactions:', error);
    }
  }

  // Traiter les threads
  async processThread(sourceMessage, targetMessage, sourceGuild) {
    try {
      const sourceThread = sourceMessage.thread;
      if (!sourceThread) return;

      // Créer le thread sur le message cible
      const targetThread = await targetMessage.startThread({
        name: sourceThread.name,
        autoArchiveDuration: sourceThread.autoArchiveDuration
      });

      // Scraper les messages du thread
      const threadMessages = await sourceThread.messages.fetch({ limit: 50 });
      
      for (const threadMessage of Array.from(threadMessages.values()).reverse()) {
        try {
          await this.processMessage(threadMessage, targetThread, sourceGuild);
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          console.error(`Erreur lors du traitement du message de thread ${threadMessage.id}:`, error);
        }
      }
    } catch (error) {
      console.error('Erreur lors du traitement du thread:', error);
    }
  }

  // Marquer un message comme traité avec infos du message mirroiré
  async markMessageAsProcessed(messageId, channelId, mirrorMessageId = null, mirrorChannelId = null, mirrorGuildId = null, webhookId = null, webhookToken = null, awaitingEmbed = false, processedContent = null) {
    try {
      const processedMessage = new ProcessedMessage({
        discordId: messageId,
        channelId: channelId,
        mirrorMessageId: mirrorMessageId,
        mirrorChannelId: mirrorChannelId,
        mirrorGuildId: mirrorGuildId,
        webhookId: webhookId,
        webhookToken: webhookToken,
        awaitingEmbed: awaitingEmbed, // Utiliser le paramètre passé
        processedContent: processedContent // Sauvegarder le contenu traité
      });

      await processedMessage.save();

      if (mirrorMessageId) {
      }
    } catch (error) {
      // Ignorer les erreurs de doublons
      if (error.code !== 11000) {
        console.error('Erreur lors du marquage du message comme traité:', error);
      }
    }
  }

  // Formater la date
  formatDate(date) {
    return date.toLocaleString('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  // Obtenir les derniers messages d'un salon pour la commande /seeroom
  async getRecentMessages(sourceGuild, channelName, limit = 50) {
    try {
      // Utiliser le bon client selon la disponibilité
      let guild = sourceGuild;
      if (this.userClient) {
        guild = this.userClient.guilds.cache.get(sourceGuild.id) || sourceGuild;
      }
      
      const sourceChannel = guild.channels.cache.find(
        ch => ch.name === channelName || ch.id === channelName
      );

      if (!sourceChannel) {
        throw new Error(`Salon ${channelName} introuvable`);
      }

      const messages = await sourceChannel.messages.fetch({ limit });
      return Array.from(messages.values()).reverse(); // Ordre chronologique
    } catch (error) {
      console.error(`Erreur lors de la récupération des messages de ${channelName}:`, error);
      throw error;
    }
  }

  // Getter pour vérifier si le scraping est actif
  get isScrapingActive() {
    return this.isRunning;
  }

  // 📊 Obtenir les statistiques des proxies (pour le dashboard)
  async getProxyStats() {
    try {
      const fs = require('fs');
      const path = require('path');
      
      // Lire le fichier proxy.txt
      const proxyFilePath = path.join(__dirname, '..', 'proxy.txt');
      
      if (!fs.existsSync(proxyFilePath)) {
        return {
          total: 0,
          active: 0,
          blacklisted: 0
        };
      }
      
      const proxyContent = fs.readFileSync(proxyFilePath, 'utf-8');
      const proxies = proxyContent.split('\n').filter(line => line.trim() && !line.startsWith('#'));
      
      return {
        total: proxies.length,
        active: proxies.length, // Pour l'instant, on assume que tous sont actifs
        blacklisted: 0 // À implémenter plus tard si nécessaire
      };
    } catch (error) {
      console.error('❌ Erreur lecture stats proxies:', error);
      return {
        total: 0,
        active: 0,
        blacklisted: 0
      };
    }
  }
  // 🚀 NOUVEAUX ÉVÉNEMENTIELS : Démarrer le scraping en mode événementiel
  async startEventBasedScraping(targetGuild, sourceGuild, userClient) {

    this.userClient = userClient;
    this.isRunning = true;
    this.isEventBased = true;
    
    // Configurer les événements WebSocket
    await userClient.setupEventListeners(
      targetGuild.id, 
      sourceGuild.id, 
      this, 
      targetGuild, 
      sourceGuild
    );
    
  }



  // 🚀 Gérer un nouveau message en temps réel (appelé par UserClient)
  async handleEventMessage(sourceMessage, targetGuild, sourceGuild) {
    try {
      // Validation des paramètres critiques (silencieuse sauf erreur)
      if (!sourceMessage || !sourceMessage.channel || !targetGuild || !sourceGuild) return;

      const channelType = typeof sourceMessage.channel.type === 'string'
        ? CHANNEL_TYPE_MAP[sourceMessage.channel.type] ?? sourceMessage.channel.type
        : sourceMessage.channel.type;

      // Ignorer canaux vocaux (type 2)
      if (channelType === 2) return;

      const channelName = sourceMessage.channel?.name || 'unknown-channel';
      const guildId = sourceGuild?.id || 'unknown-guild';
      let channelData = await Channel.findOne({ name: channelName, serverId: guildId, scraped: true });

      if (!channelData) {
        let autoConfigResult = await this.tryAutoConfigureForumThread(sourceMessage, targetGuild, sourceGuild);
        if (!autoConfigResult) autoConfigResult = await this.tryAutoConfigureActiveThread(sourceMessage, targetGuild, sourceGuild);
        if (!autoConfigResult) return;
        channelData = await Channel.findOne({ name: channelName, serverId: guildId, scraped: true });
      }

      let targetChannel = targetGuild.channels.cache.find(ch => ch.name === channelName);

      // Recherche dans threads de forum si nécessaire
      if (!targetChannel && channelData?.sourceChannelId) {
        for (const [, channel] of targetGuild.channels.cache) {
          if (channel.type === 15) {
            const thread = channel.threads.cache.find(t => t.name === channelName);
            if (thread) { targetChannel = thread; break; }
          }
        }
      }

      if (!targetChannel) return;

      // Vérifier si déjà traité
      const alreadyProcessed = await ProcessedMessage.findOne({ discordId: sourceMessage.id });
      if (alreadyProcessed) return;

      // Vérifier type supporté
      if (!WEBHOOK_SUPPORTED_TYPES.has(channelType)) return;

      // Buffer ou traitement immédiat
      const shouldBuffer = sourceMessage.content &&
                          (!sourceMessage.embeds || sourceMessage.embeds.length === 0) &&
                          !sourceMessage.author.bot;

      if (shouldBuffer) {
        this.messageBuffer.set(sourceMessage.id, {
          message: sourceMessage, targetChannel, sourceGuild, targetGuild,
          timestamp: Date.now(), processed: false
        });
        setTimeout(async () => {
          const bufferData = this.messageBuffer.get(sourceMessage.id);
          if (bufferData && !bufferData.processed) {
            await this.processMessage(bufferData.message, bufferData.targetChannel, bufferData.sourceGuild, true);
            bufferData.processed = true;
          }
        }, this.bufferDelay);
      } else {
        await this.processMessage(sourceMessage, targetChannel, sourceGuild);
      }

      // Stats et activité
      this.eventStats.totalEventMessages++;
      this.eventStats.lastEventTime = new Date();

      if (sourceMessage.channel?.id && sourceGuild?.id) {
        await Channel.updateOne(
          { sourceChannelId: sourceMessage.channel.id, serverId: sourceGuild.id },
          { $set: { lastActivity: new Date(), lastMessageActivity: new Date(), isActive: true }, $inc: { messageCount: 1 } }
        );
      }

      // 📊 Tracker le membre qui a posté ce message (pour rapport membres-dangereux)
      await this.trackMemberFromMessage(sourceMessage, sourceGuild);

    } catch (error) {
      const errorMessage = error.message || '';

      // 🛡️ Filtrer erreurs transitoires MongoDB/réseau (ne pas spammer les logs)
      const isTransientError = errorMessage.includes('timed out') ||
                               errorMessage.includes('ECONNRESET') ||
                               errorMessage.includes('ENOTFOUND') ||
                               errorMessage.includes('socket hang up') ||
                               errorMessage.includes('other side closed') ||
                               (errorMessage.includes('connection') && errorMessage.includes('closed'));

      if (isTransientError) {
        // Erreur transitoire - log console uniquement (pas de spam dans #error)
        return;
      }

      console.error('❌ Event error:', error.message);
      const channelName = sourceMessage?.channel?.name || 'canal-inconnu';
      const errorKey = `${channelName}_${error.message}`;
      if (!this.errorThrottle.has(errorKey)) {
        await this.logger.logError(targetGuild?.id || 'unknown', `Event error: ${error.message}`, channelName);
        this.errorThrottle.set(errorKey, Date.now());
        setTimeout(() => this.errorThrottle.delete(errorKey), 60000);
      }
    }
  }

  // 🚀 Gérer la modification d'un message (ajout d'embed après coup)
  async handleEventMessageUpdate(oldMessage, newMessage, targetGuild, sourceGuild) {
    try {

      // Vérifier si c'est un ajout d'embed (message bufferisé qui reçoit son embed)
      const hasNewEmbed = newMessage.embeds && newMessage.embeds.length > 0;
      const hadNoEmbed = !oldMessage || !oldMessage.embeds || oldMessage.embeds.length === 0;

      if (!hasNewEmbed || !hadNoEmbed) {
        return;
      }


      // Récupérer le ProcessedMessage pour voir si on attendait un embed
      const ProcessedMessage = require('../models/ProcessedMessage');
      const processedEntry = await ProcessedMessage.findOne({
        discordId: newMessage.id,
        awaitingEmbed: true
      });

      if (!processedEntry) {
        return;
      }


      // Vérifier qu'on a les infos webhook
      if (!processedEntry.webhookId || !processedEntry.webhookToken || !processedEntry.mirrorMessageId) {
        console.error(`   ❌ Infos webhook manquantes pour éditer`);
        return;
      }

      // Récupérer le webhook
      const webhook = await this.client.fetchWebhook(processedEntry.webhookId, processedEntry.webhookToken).catch(err => {
        console.error(`   ❌ Webhook introuvable: ${err.message}`);
        return null;
      });

      if (!webhook) {
        console.error(`   ❌ Impossible de récupérer le webhook`);
        return;
      }

      // Traiter le contenu et les embeds
      let processedContent = newMessage.content || '';

      // Traiter les mentions de rôles dans le contenu
      if (processedContent.includes('<@&')) {
        try {
          processedContent = await this.processRoleMentions(processedContent, sourceGuild);
        } catch (roleError) {
          console.error(`   ❌ Erreur traitement mentions rôles:`, roleError.message);
        }
      }

      // Traiter les embeds
      const processedEmbeds = [];
      for (const sourceEmbed of newMessage.embeds) {
        try {
          const embedData = {};

          // Titre avec traitement des mentions
          if (sourceEmbed.title) {
            let processedTitle = sourceEmbed.title.substring(0, 256);

            // Traiter les mentions de rôles dans le titre
            if (processedTitle.includes('<@&')) {
              try {
                processedTitle = await this.processRoleMentions(processedTitle, sourceGuild);
              } catch (titleRoleError) {
                console.error(`   ❌ Erreur rôles titre embed:`, titleRoleError.message);
                const defaultNames = require('../config/defaultNames');
                processedTitle = processedTitle.replace(/<@&(\d+)>/g, `**@${defaultNames.mirrorDefaults.roleName}**`);
              }
            }

            embedData.title = processedTitle;
          }

          // Description avec traitement des mentions
          if (sourceEmbed.description) {
            let processedDescription = sourceEmbed.description.substring(0, 4096);

            // Traiter les mentions de rôles
            if (processedDescription.includes('<@&')) {
              try {
                processedDescription = await this.processRoleMentions(processedDescription, sourceGuild);
              } catch (descRoleError) {
                console.error(`   ❌ Erreur rôles description embed:`, descRoleError.message);
                const defaultNames = require('../config/defaultNames');
                processedDescription = processedDescription.replace(/<@&(\d+)>/g, `**@${defaultNames.mirrorDefaults.roleName}**`);
              }
            }

            embedData.description = processedDescription;
          }

          // Copier les autres propriétés
          if (sourceEmbed.url) embedData.url = sourceEmbed.url;
          if (sourceEmbed.color) embedData.color = sourceEmbed.color;
          if (sourceEmbed.footer) embedData.footer = sourceEmbed.footer;
          if (sourceEmbed.image) embedData.image = sourceEmbed.image;
          if (sourceEmbed.thumbnail) embedData.thumbnail = sourceEmbed.thumbnail;
          if (sourceEmbed.author) embedData.author = sourceEmbed.author;
          if (sourceEmbed.timestamp) embedData.timestamp = sourceEmbed.timestamp;

          // Traiter les fields
          if (sourceEmbed.fields && sourceEmbed.fields.length > 0) {
            embedData.fields = [];
            for (let field of sourceEmbed.fields) {
              let fieldName = field.name ? field.name.substring(0, 256) : 'Sans titre';
              let fieldValue = field.value ? field.value.substring(0, 1024) : 'Vide';

              // Traiter les mentions dans les fields
              if (fieldName.includes('<@&')) {
                try {
                  fieldName = await this.processRoleMentions(fieldName, sourceGuild);
                } catch (roleNameError) {
                  const defaultNames = require('../config/defaultNames');
                  fieldName = fieldName.replace(/<@&(\d+)>/g, `**@${defaultNames.mirrorDefaults.roleName}**`);
                }
              }

              if (fieldValue.includes('<@&')) {
                try {
                  fieldValue = await this.processRoleMentions(fieldValue, sourceGuild);
                } catch (roleValueError) {
                  const defaultNames = require('../config/defaultNames');
                  fieldValue = fieldValue.replace(/<@&(\d+)>/g, `**@${defaultNames.mirrorDefaults.roleName}**`);
                }
              }

              embedData.fields.push({
                name: fieldName,
                value: fieldValue,
                inline: field.inline || false
              });
            }
          }

          processedEmbeds.push(embedData);
        } catch (embedError) {
          console.error(`   ❌ Erreur traitement embed:`, embedError.message);
        }
      }

      // Éditer le message via webhook
      try {
        await this.editWebhookWithRetry(webhook, processedEntry.mirrorMessageId, {
          content: processedContent || undefined,
          embeds: processedEmbeds.length > 0 ? processedEmbeds : undefined
        });

        // Mettre à jour le flag awaitingEmbed
        await ProcessedMessage.updateOne(
          { _id: processedEntry._id },
          { $set: { awaitingEmbed: false } }
        );


      } catch (editError) {
        console.error(`   ❌ Erreur édition message mirror:`, editError.message);
      }

    } catch (error) {
      console.error('❌ Erreur handleEventMessageUpdate:', error);
    }
  }

  // 🚀 SOLUTION 2: AUTO-CONFIGURATION DES THREADS ACTIFS
  async tryAutoConfigureActiveThread(sourceMessage, targetGuild, sourceGuild) {
    try {
      // Convertir le type string en numérique si nécessaire
      const channelType = typeof sourceMessage.channel.type === 'string'
        ? CHANNEL_TYPE_MAP[sourceMessage.channel.type] ?? sourceMessage.channel.type
        : sourceMessage.channel.type;

      // 1️⃣ VÉRIFIER SI C'EST UN THREAD
      const isThread = channelType === 11 || channelType === 12;
      if (!isThread) {
        return false; // Pas un thread
      }


      // 2️⃣ VÉRIFIER SI LE THREAD EST DÉJÀ EN BASE (mais pas activé)
      const existingThread = await Channel.findOne({
        name: sourceMessage.channel.name,
        serverId: sourceGuild.id
      });

      if (existingThread && existingThread.scraped) {
        return false; // Thread déjà configuré et actif
      }

      // 3️⃣ RÉCUPÉRER LES DÉTAILS DU THREAD VIA API
      let userData = null;
      let userClientToUse = null;
      
      if (this.userClient && this.userClient.getUserData) {
        userData = this.userClient.getUserData(targetGuild.id);
        userClientToUse = this.userClient;
      } else if (this.client && this.client.services && this.client.services.userClient) {
        userData = this.client.services.userClient.getUserData(targetGuild.id);
        userClientToUse = this.client.services.userClient;
      }
      
      if (!userData || !userData.token || !userClientToUse) {
        console.log(`❌ Token utilisateur non disponible pour auto-config thread`);
        return false;
      }

      let threadDetails;
      try {
        threadDetails = await userClientToUse.fetchThreadById(userData.token, sourceMessage.channel.id);
      } catch (apiError) {
        if (!apiError.message.includes('(cached)')) {
          console.log(`❌ Impossible de récupérer les détails du thread ${sourceMessage.channel.name}: ${apiError.message}`);
        }
        return false;
      }

      // 4️⃣ TROUVER LE SALON PARENT SUR LE MIRROR
      const allSourceChannels = await userClientToUse.fetchGuildChannels(userData.token, sourceGuild.id);
      const sourceParent = allSourceChannels.find(ch => ch.id === threadDetails.parent_id);
      
      if (!sourceParent) {
        console.log(`❌ Salon parent du thread ${sourceMessage.channel.name} non trouvé`);
        return false;
      }

      let parentChannel = targetGuild.channels.cache.find(ch => ch.name === sourceParent.name);
      if (!parentChannel) {
        console.log(`🔧 Salon parent mirror ${sourceParent.name} non trouvé, tentative de création automatique...`);

        // Utiliser correspondenceManager pour créer le channel parent
        if (this.correspondenceManager?.createMirrorChannel) {
          const parentInfo = {
            id: sourceParent.id,
            name: sourceParent.name,
            type: sourceParent.type || 0,
            parentId: sourceParent.parent_id,
            topic: sourceParent.topic
          };
          parentChannel = await this.correspondenceManager.createMirrorChannel(targetGuild, parentInfo);

          if (parentChannel) {
            // Sauvegarder le mapping du parent
            await Channel.findOneAndUpdate(
              { sourceChannelId: sourceParent.id, serverId: sourceGuild.id },
              {
                name: sourceParent.name,
                discordId: parentChannel.id,
                sourceChannelId: sourceParent.id,
                type: sourceParent.type || 0,
                lastSynced: new Date()
              },
              { upsert: true }
            );
            console.log(`✅ Salon parent ${sourceParent.name} créé automatiquement: ${parentChannel.id}`);
          }
        }

        if (!parentChannel) {
          console.log(`❌ Impossible de créer le salon parent mirror ${sourceParent.name} pour le thread ${sourceMessage.channel.name}`);
          return false;
        }
      }

      // 5️⃣ CRÉER LE THREAD SUR LE MIRROR
      let newThread;
      try {
        // Créer un message de départ pour le thread
        const startMessage = await parentChannel.send(
          `🧵 **Thread auto-configuré**: ${threadDetails.name}\n\n` +
          `*Ce thread a été automatiquement configuré car des messages sont arrivés du serveur source.*\n` +
          `📊 **Détection en temps réel** - Powered by Solution 2`
        );

        // Créer le thread
        const threadOptions = {
          name: threadDetails.name,
          autoArchiveDuration: threadDetails.thread_metadata?.auto_archive_duration || 1440,
          type: threadDetails.type === 11 ? 'PUBLIC_THREAD' : 'PRIVATE_THREAD',
          reason: `Auto-configuration thread actif: ${threadDetails.name}`
        };

        newThread = await startMessage.startThread(threadOptions);

      } catch (createError) {
        console.log(`❌ Erreur création thread mirror ${threadDetails.name}: ${createError.message}`);
        return false;
      }

      // 6️⃣ SAUVEGARDER EN BASE DE DONNÉES
      try {
        if (existingThread) {
          // Mettre à jour l'entrée existante
          existingThread.discordId = newThread.id;
          existingThread.sourceChannelId = threadDetails.id;
          existingThread.scraped = true;
          existingThread.manuallyDeleted = false;
          await existingThread.save();
        } else {
          // Créer une nouvelle entrée
          const newChannelDB = new Channel({
            discordId: newThread.id,
            serverId: sourceGuild.id,
            sourceChannelId: threadDetails.id,
            name: threadDetails.name,
            category: parentChannel.parent?.name || null,
            scraped: true,
            failedAttempts: 0,
            isBlacklisted: false,
            manuallyDeleted: false
          });
          await newChannelDB.save();
        }


      } catch (dbError) {
        console.log(`❌ Erreur sauvegarde thread en base ${threadDetails.name}: ${dbError.message}`);
        // Continuer quand même, le thread est créé
      }

      // 7️⃣ LOGGER L'ACTION AUTOMATIQUE avec mention cliquable
      try {
        await this.logger.logNewRoom(
          targetGuild.id,
          `🧵 **THREAD AUTO-CONFIGURÉ**: <#${newThread.id}>\n` +
          `📁 Salon parent: <#${parentChannel.id}>\n` +
          `⚡ **Détection temps réel** - Solution 2 activée\n` +
          `🎯 **Raison**: Message reçu d'un thread non configuré`,
          'Auto-Config Thread',
          newThread.id
        );

        await this.logger.logAdminAction(
          targetGuild.id,
          `🧵 Thread auto-configuré: <#${newThread.id}> dans <#${parentChannel.id}>\n` +
          `⚡ Solution 2: Auto-configuration des threads actifs\n` +
          `📨 Trigger: Message de ${sourceMessage.author.username}`
        );

      } catch (logError) {
        console.log(`⚠️ Erreur log auto-config thread: ${logError.message}`);
        // Continuer quand même
      }

      // 8️⃣ SYNCHRONISER LES 50 DERNIERS MESSAGES DU THREAD SOURCE (BACKFILL)
      let backfillCount = 0;
      try {
        // Récupérer les 50 derniers messages du thread source via l'API Discord
        const messages = await this.fetchChannelMessages(userData.token, threadDetails.id, 50);

        if (messages && messages.length > 0) {
          console.log(`📥 [Backfill Thread] ${messages.length} messages à synchroniser pour ${threadDetails.name}`);

          // Traiter les messages dans l'ordre chronologique (du plus ancien au plus récent)
          for (const message of messages.reverse()) {
            try {
              // Vérifier si le message n'est pas déjà traité (éviter doublons)
              const alreadyProcessed = await ProcessedMessage.findOne({ discordId: message.id });
              if (alreadyProcessed) continue;

              // Créer un objet message compatible avec processMessage
              const messageToProcess = {
                id: message.id,
                content: message.content,
                author: message.author,
                attachments: message.attachments ? new Map(message.attachments.map(a => [a.id, a])) : new Map(),
                embeds: message.embeds || [],
                createdTimestamp: new Date(message.timestamp).getTime(),
                reference: message.message_reference || null,
                type: message.type,
                channel: {
                  id: threadDetails.id,
                  name: threadDetails.name
                }
              };

              // Traiter le message avec la méthode existante
              await this.processMessage(messageToProcess, newThread, sourceGuild);
              backfillCount++;

              // Délai pour éviter le rate limiting Discord (300ms)
              await new Promise(resolve => setTimeout(resolve, 300));

            } catch (msgError) {
              console.error(`❌ Erreur backfill message ${message.id}:`, msgError.message);
              // Continuer avec les autres messages
            }
          }

          if (backfillCount > 0) {
            console.log(`✅ [Backfill Thread] ${backfillCount} messages synchronisés pour ${threadDetails.name}`);
          }
        }

      } catch (syncError) {
        console.error(`⚠️ Erreur backfill messages thread:`, syncError.message);
        // Ne pas faire échouer l'auto-configuration pour autant
      }

      // 9️⃣ METTRE À JOUR LE LOG AVEC LE NOMBRE DE MESSAGES BACKFILL
      if (backfillCount > 0) {
        try {
          await this.logger.logNewRoom(
            targetGuild.id,
            `📥 **${backfillCount} messages historiques** synchronisés pour <#${newThread.id}>`,
            'Backfill Thread',
            newThread.id
          );
        } catch (logError) {
          // Ignorer erreur de log
        }
      }

      return true;

    } catch (error) {
      console.error(`❌ Erreur auto-configuration thread:`, error);
      return false;
    }
  }

  // 📥 Récupérer les messages d'un channel/thread via l'API Discord
  // Utilisée pour le backfill lors de l'auto-configuration de threads/forums
  async fetchChannelMessages(userToken, channelId, limit = 50) {
    try {
      const response = await axios.get(
        `https://discord.com/api/v10/channels/${channelId}/messages?limit=${limit}`,
        {
          headers: {
            'Authorization': userToken,
            'Content-Type': 'application/json'
          }
        }
      );

      return response.data || [];
    } catch (error) {
      console.error(`❌ Erreur récupération messages channel ${channelId}:`, error.message);
      return [];
    }
  }

  // 🏛️ Scraper un thread de forum spécifique
  async scrapeForumThread(targetGuild, sourceGuild, forumThreadData, parentForum) {
    try {
      
      // Trouver le thread mirror correspondant
      const mirrorThread = targetGuild.channels.cache.find(
        ch => ch.name === forumThreadData.name && ch.parentId === parentForum.id
      );
      
      if (!mirrorThread) {
        console.log(`⚠️ Thread mirror ${forumThreadData.name} introuvable dans le forum ${parentForum.name}`);
        return;
      }
      
      // Utiliser le client utilisateur pour récupérer les messages
      let userData = null;
      if (this.userClient && this.userClient.getUserData) {
        userData = this.userClient.getUserData(targetGuild.id);
      } else if (this.client && this.client.services && this.client.services.userClient) {
        userData = this.client.services.userClient.getUserData(targetGuild.id);
      }
      
      if (!userData || !userData.token) {
        console.log(`❌ Token utilisateur non disponible pour scraper le thread forum`);
        return;
      }
      
      // Récupérer les messages du thread source
      const messages = await this.fetchChannelMessages(userData.token, forumThreadData.sourceChannelId || forumThreadData.discordId);
      
      if (messages.length === 0) {
        return; // Pas de nouveaux messages
      }
      
      
      // Vérifier le dernier message traité
      const lastProcessed = await ProcessedMessage
        .findOne({ channelId: forumThreadData.sourceChannelId || forumThreadData.discordId })
        .sort({ processedAt: -1 });
      
      // Filtrer les nouveaux messages
      let newMessages = messages;
      if (lastProcessed) {
        const lastIndex = messages.findIndex(m => m.id === lastProcessed.discordId);
        if (lastIndex !== -1) {
          newMessages = messages.slice(0, lastIndex);
        }
      }
      
      if (newMessages.length === 0) {
        return; // Pas de nouveaux messages
      }
      
      
      // Traiter les messages dans l'ordre chronologique
      for (const message of newMessages.reverse()) {
        try {
          // Créer un objet message compatible avec processMessage
          const messageToProcess = {
            id: message.id,
            content: message.content,
            author: message.author,
            attachments: message.attachments ? new Map(message.attachments.map(a => [a.id, a])) : new Map(),
            embeds: message.embeds || [],
            createdTimestamp: new Date(message.timestamp).getTime(),
            reference: message.message_reference || null,
            type: message.type,
            channel: {
              id: forumThreadData.sourceChannelId || forumThreadData.discordId,
              name: forumThreadData.name
            }
          };
          
          // Traiter le message
          await this.processMessage(messageToProcess, mirrorThread, sourceGuild);
          
          // Rate limiting
          await rateLimiter.waitForRequest(forumThreadData.discordId);
          rateLimiter.recordRequest(forumThreadData.discordId);
          
          // Délai entre les messages
          await new Promise(resolve => setTimeout(resolve, 1000));
          
        } catch (error) {
          console.error(`❌ Erreur traitement message forum ${message.id}:`, error.message);
          await this.logger.logError(
            targetGuild.id,
            `Erreur traitement message dans thread forum ${forumThreadData.name}: ${error.message}`,
            forumThreadData.name
          );
        }
      }
      
      // Mettre à jour la date de dernier scraping et activité
      await Channel.updateOne(
        { discordId: forumThreadData.discordId },
        {
          lastScraped: new Date(),
          lastActivity: new Date(),
          lastMessageActivity: messages.length > 0 ? new Date() : undefined,  // Mettre à jour seulement si des messages
          isActive: true,
          $inc: { messageCount: messages.length }
        }
      );
      
      
    } catch (error) {
      console.error(`❌ Erreur scraping thread forum ${forumThreadData.name}:`, error);
      throw error;
    }
  }

  // 🏛️ NOUVEAU : AUTO-CONFIGURATION DES THREADS/POSTS DE FORUMS EN TEMPS RÉEL
  async tryAutoConfigureForumThread(sourceMessage, targetGuild, sourceGuild) {
    try {
      // 1️⃣ VÉRIFIER SI C'EST UN THREAD DANS UN FORUM  
      // Les threads de forums sont détectés par leur parent_id qui pointe vers un forum (type 15)
      let userData = null;
      let userClientToUse = null;
      
      if (this.userClient && this.userClient.getUserData) {
        userData = this.userClient.getUserData(targetGuild.id);
        userClientToUse = this.userClient;
      } else if (this.client && this.client.services && this.client.services.userClient) {
        userData = this.client.services.userClient.getUserData(targetGuild.id);
        userClientToUse = this.client.services.userClient;
      }
      
      if (!userData || !userData.token || !userClientToUse) {
        console.log(`❌ Token utilisateur non disponible pour auto-config forum thread`);
        return false;
      }

      // Récupérer les détails du canal source pour vérifier s'il est dans un forum
      let threadDetails;
      try {
        threadDetails = await userClientToUse.fetchThreadById(userData.token, sourceMessage.channel.id);
      } catch (apiError) {
        // Ne pas loguer si c'est un cache hit (déjà loggé lors de la mise en cache)
        if (!apiError.message.includes('(cached)')) {
          console.log(`❌ Impossible de récupérer les détails du thread ${sourceMessage.channel.name}: ${apiError.message}`);
        }
        return false;
      }

      // Vérifier si le thread a un parent_id (donc c'est un thread)
      if (!threadDetails.parent_id) {
        return false; // Pas un thread
      }

      // Récupérer les détails du salon parent pour vérifier si c'est un forum
      let parentDetails;
      try {
        parentDetails = await userClientToUse.fetchThreadById(userData.token, threadDetails.parent_id);
      } catch (apiError) {
        return false;
      }

      // Vérifier si le parent est un forum (type 15)
      if (parentDetails.type !== 15) {
        return false; // Le parent n'est pas un forum, utiliser l'autre fonction
      }


      // 2️⃣ VÉRIFIER SI LE THREAD EST DÉJÀ EN BASE
      const existingThread = await Channel.findOne({
        name: sourceMessage.channel.name,
        serverId: sourceGuild.id
      });

      if (existingThread && existingThread.scraped) {
        return false; // Thread déjà configuré et actif
      }

      // 3️⃣ TROUVER OU CRÉER LE FORUM PARENT SUR LE MIRROR
      let forumMirror = targetGuild.channels.cache.find(ch => ch.name === parentDetails.name && ch.type === 15);
      if (!forumMirror) {
        console.log(`🔧 Forum mirror ${parentDetails.name} non trouvé, tentative de création automatique...`);

        // Utiliser correspondenceManager pour créer le forum
        if (this.correspondenceManager?.autoCreateForumChannel) {
          const forumInfo = {
            id: parentDetails.id,
            name: parentDetails.name,
            type: 15,
            parentId: parentDetails.parent_id,
            topic: parentDetails.topic
          };
          forumMirror = await this.correspondenceManager.autoCreateForumChannel(forumInfo, targetGuild, sourceGuild.id);

          if (forumMirror) {
            // Sauvegarder le mapping du forum
            await Channel.findOneAndUpdate(
              { sourceChannelId: parentDetails.id, serverId: sourceGuild.id },
              {
                name: parentDetails.name,
                discordId: forumMirror.id,
                sourceChannelId: parentDetails.id,
                type: 15,
                lastSynced: new Date()
              },
              { upsert: true }
            );
            console.log(`✅ Forum ${parentDetails.name} créé automatiquement: ${forumMirror.id}`);
          }
        }

        if (!forumMirror) {
          console.log(`❌ Impossible de créer le forum mirror ${parentDetails.name} pour le thread ${sourceMessage.channel.name}`);
          return false;
        }
      }

      // 4️⃣ CRÉER LE THREAD/POST DANS LE FORUM MIRROR
      let newForumThread;
      try {
        // Pour les forums, on utilise threads.create() au lieu de startThread()
        const forumThreadOptions = {
          name: threadDetails.name,
          message: {
            content: `🏛️ **Post auto-configuré**: ${threadDetails.name}\n\n` +
                    `*Ce post a été automatiquement créé car des messages sont arrivés du forum source.*\n` +
                    `📊 **Synchronisation en temps réel** - Détection automatique`
          },
          autoArchiveDuration: threadDetails.thread_metadata?.auto_archive_duration || 1440,
          reason: `Auto-configuration post forum: ${threadDetails.name}`
        };

        newForumThread = await forumMirror.threads.create(forumThreadOptions);

      } catch (createError) {
        console.log(`❌ Erreur création post forum mirror ${threadDetails.name}: ${createError.message}`);
        return false;
      }

      // 5️⃣ SAUVEGARDER EN BASE DE DONNÉES
      try {
        if (existingThread) {
          // Mettre à jour l'entrée existante
          existingThread.discordId = newForumThread.id;
          existingThread.sourceChannelId = threadDetails.id;
          existingThread.scraped = true;
          existingThread.manuallyDeleted = false;
          await existingThread.save();
        } else {
          // Créer une nouvelle entrée
          const newChannelDB = new Channel({
            discordId: newForumThread.id,
            serverId: sourceGuild.id,
            sourceChannelId: threadDetails.id,
            name: threadDetails.name,
            category: forumMirror.parent?.name || null,
            scraped: true,
            failedAttempts: 0,
            isBlacklisted: false,
            manuallyDeleted: false
          });
          await newChannelDB.save();
        }


      } catch (dbError) {
        console.log(`❌ Erreur sauvegarde post forum en base ${threadDetails.name}: ${dbError.message}`);
        // Continuer quand même, le thread est créé
      }

      // 6️⃣ LOGGER L'ACTION AUTOMATIQUE avec mention cliquable
      try {
        await this.logger.logNewRoom(
          targetGuild.id,
          `🏛️ **POST FORUM AUTO-CONFIGURÉ**: <#${newForumThread.id}>\n` +
          `📁 Forum parent: <#${forumMirror.id}>\n` +
          `⚡ **Synchronisation temps réel** activée\n` +
          `🎯 **Raison**: Message reçu d'un post forum non configuré`,
          'Auto-Config Forum Post',
          newForumThread.id
        );

        await this.logger.logAdminAction(
          targetGuild.id,
          `🏛️ Post forum auto-configuré: <#${newForumThread.id}> dans le forum <#${forumMirror.id}>\n` +
          `⚡ Détection automatique des nouveaux posts\n` +
          `📨 Trigger: Message de ${sourceMessage.author.username}`
        );

      } catch (logError) {
        console.log(`⚠️ Erreur log auto-config post forum: ${logError.message}`);
        // Continuer quand même
      }

      // 7️⃣ SYNCHRONISER LES 50 DERNIERS MESSAGES DU THREAD SOURCE (BACKFILL)
      let backfillCount = 0;
      try {
        // Récupérer les 50 derniers messages du thread source via l'API Discord
        const messages = await this.fetchChannelMessages(userData.token, threadDetails.id, 50);

        if (messages && messages.length > 0) {
          console.log(`📥 [Backfill Forum] ${messages.length} messages à synchroniser pour ${threadDetails.name}`);

          // Traiter les messages dans l'ordre chronologique (du plus ancien au plus récent)
          for (const message of messages.reverse()) {
            try {
              // Vérifier si le message n'est pas déjà traité (éviter doublons)
              const alreadyProcessed = await ProcessedMessage.findOne({ discordId: message.id });
              if (alreadyProcessed) continue;

              // Créer un objet message compatible avec processMessage
              const messageToProcess = {
                id: message.id,
                content: message.content,
                author: message.author,
                attachments: message.attachments ? new Map(message.attachments.map(a => [a.id, a])) : new Map(),
                embeds: message.embeds || [],
                createdTimestamp: new Date(message.timestamp).getTime(),
                reference: message.message_reference || null,
                type: message.type,
                channel: {
                  id: threadDetails.id,
                  name: threadDetails.name
                }
              };

              // Traiter le message avec la méthode existante
              await this.processMessage(messageToProcess, newForumThread, sourceGuild);
              backfillCount++;

              // Délai pour éviter le rate limiting Discord (300ms)
              await new Promise(resolve => setTimeout(resolve, 300));

            } catch (msgError) {
              console.error(`❌ Erreur backfill message ${message.id}:`, msgError.message);
              // Continuer avec les autres messages
            }
          }

          if (backfillCount > 0) {
            console.log(`✅ [Backfill Forum] ${backfillCount} messages synchronisés pour ${threadDetails.name}`);
          }
        }

      } catch (syncError) {
        console.error(`⚠️ Erreur backfill messages forum:`, syncError.message);
        // Ne pas faire échouer l'auto-configuration pour autant
      }

      // 8️⃣ METTRE À JOUR LE LOG AVEC LE NOMBRE DE MESSAGES BACKFILL
      if (backfillCount > 0) {
        try {
          await this.logger.logNewRoom(
            targetGuild.id,
            `📥 **${backfillCount} messages historiques** synchronisés pour <#${newForumThread.id}>`,
            'Backfill Forum',
            newForumThread.id
          );
        } catch (logError) {
          // Ignorer erreur de log
        }
      }

      return true;

    } catch (error) {
      console.error(`❌ Erreur auto-configuration post forum:`, error);
      return false;
    }
  }

  // 🚀 Gérer une modification de message (appelé par UserClient)
  async handleEventMessageUpdate(oldMessage, newMessage, targetGuild, sourceGuild) {
    try {
      // 🔇 NOUVEAU: Ignorer les modifications dans les canaux vocaux
      if (newMessage.channel && newMessage.channel.type === 2) {
        return;
      }


      // 🛡️ NOUVEAU: Vérifier si c'est un message dans le buffer
      const bufferData = this.messageBuffer.get(newMessage.id);
      if (bufferData && !bufferData.processed) {

        // Mettre à jour le message dans le buffer avec la nouvelle version
        bufferData.message = newMessage;

        // 🛡️ FIX: Marquer processed=true APRÈS succès, pas avant
        // Cela permet au setTimeout de retry si processMessage échoue
        try {
          // Traiter immédiatement avec les embeds ajoutés
          await this.processMessage(newMessage, bufferData.targetChannel, bufferData.sourceGuild);

          // Marquer comme traité SEULEMENT après succès
          bufferData.processed = true;

          // Supprimer du buffer
          this.messageBuffer.delete(newMessage.id);
        } catch (processError) {
          console.error(`⚠️ [Buffer] Erreur processing message ${newMessage.id}:`, processError.message);
          // Ne PAS marquer processed=true, le setTimeout pourra retry
          // Ne PAS supprimer du buffer
        }
        return;
      }

      // 🎯 NOUVEAU: Détecter l'ajout d'embeds
      const hadEmbeds = oldMessage && oldMessage.embeds && oldMessage.embeds.length > 0;
      const hasEmbeds = newMessage.embeds && newMessage.embeds.length > 0;

      if (!hadEmbeds && hasEmbeds) {

        // Trouver le message mirroiré dans la base de données
        const processedMessage = await ProcessedMessage.findOne({
          discordId: newMessage.id
        });

        if (!processedMessage) {
          return;
        }

        // Vérifier qu'on a les infos webhook
        if (!processedMessage.webhookId || !processedMessage.webhookToken) {
          return;
        }

        // Trouver le canal cible
        const targetChannel = targetGuild.channels.cache.get(processedMessage.mirrorChannelId);
        if (!targetChannel) {
          return;
        }

        // Éditer le message via webhook
        try {
          const webhook = new WebhookClient({
            id: processedMessage.webhookId,
            token: processedMessage.webhookToken
          });

          // Utiliser le contenu traité sauvegardé plutôt que le contenu brut
          let contentToUse = processedMessage.processedContent || newMessage.content || undefined;

          // Si pas de contenu sauvegardé (ancien message), utiliser le contenu actuel
          if (!processedMessage.processedContent && newMessage.content) {
            contentToUse = newMessage.content;
          }

          // Préparer le contenu mis à jour avec les embeds
          // Sanitiser les embeds pour éviter "Invalid Form Body - BASE_TYPE_REQUIRED"
          // Discord API rejette les embeds avec des champs null (ex: description: null)
          const sanitizedEmbeds = newMessage.embeds.slice(0, 10)
            .map(embed => {
              const data = embed.toJSON ? embed.toJSON() : embed.data || embed;
              const clean = {};
              for (const [key, value] of Object.entries(data)) {
                if (value !== null && value !== undefined) {
                  clean[key] = value;
                }
              }
              return clean;
            })
            .filter(embed =>
              embed.title || embed.description || (embed.fields && embed.fields.length > 0) ||
              embed.image?.url || embed.thumbnail?.url || embed.author?.name || embed.footer?.text
            );
          const updatePayload = {
            content: contentToUse,
            embeds: sanitizedEmbeds.length > 0 ? sanitizedEmbeds : undefined
          };

          // Ne pas envoyer de payload vide
          if (!updatePayload.content && !updatePayload.embeds) {
            processedMessage.awaitingEmbed = false;
            await processedMessage.save();
            return;
          }

          // Éditer le message mirroiré
          await this.editWebhookWithRetry(webhook, processedMessage.mirrorMessageId, updatePayload);


          // Mettre à jour le flag dans la DB
          processedMessage.awaitingEmbed = false;
          await processedMessage.save();

        } catch (editError) {
          console.error(`   ❌ Erreur lors de l'édition du message mirroiré:`, editError);
        }
      }

    } catch (error) {
      console.error('❌ Erreur modification événement:', error);
    }
  }

  // 🚀 Arrêter le scraping événementiel
  async stopEventBasedScraping(targetGuildId) {
    try {

      // Arrêter les événements WebSocket
      if (this.userClient && this.userClient.hasEventListeners(targetGuildId)) {
        await this.userClient.stopEventListeners(targetGuildId);
      }

      // Arrêter le scraping classique si actif
      this.stopScraping();

      // FIX: Réinitialiser le flag isRunning pour le mode événementiel
      // Sans cette ligne, isRunning reste à true et bloque les futurs /start
      this.isRunning = false;
      this.isEventBased = false;


    } catch (error) {
      console.error('❌ Erreur arrêt événementiel:', error);
    }
  }

  // 🚀 Obtenir les statistiques du scraping événementiel
  getEventStats() {
    return {
      ...this.eventStats,
      isEventBased: this.isEventBased,
      isRunning: this.isRunning
    };
  }
  // 🧹 NETTOYAGE AUTOMATIQUE DES COMMANDES EXPIRÉES (VERSION SIMPLIFIÉE)
  cleanupExpiredCommands() {
    try {
      const now = Date.now();
      let expiredCount = 0;

      // Log supprimé pour éviter le spam - ne log que quand des commandes sont réellement nettoyées

      for (const [commandKey, data] of this.pendingSlashCommands.entries()) {
        const age = now - data.timestamp;
        const isExpired = age > this.slashCommandTimeout;
      
      if (isExpired) {
        expiredCount++;
        
        // 📝 FINALISER LA COMMANDE AVANT SUPPRESSION SI ELLE N'A PAS EU DE RÉPONSE
        if (data.responses.length === 0) {
          this.finalizeSlashCommandWithoutResponse(commandKey, data).catch(error => {
            console.error(`❌ Erreur finalisation ${commandKey}:`, error.message);
          });
        }
        
        // 🗑️ SUPPRIMER LA COMMANDE EXPIRÉE
        this.pendingSlashCommands.delete(commandKey);
      }
    }

    // 🧹 Nettoyer aussi pendingByComposite (même timeout)
    for (const [compositeKey, data] of this.pendingByComposite.entries()) {
      if (data.timestamp && (now - data.timestamp) > this.slashCommandTimeout) {
        this.pendingByComposite.delete(compositeKey);
        expiredCount++;
      }
    }

    if (expiredCount > 0) {
    }
    } catch (error) {
      console.error('❌ Erreur dans cleanupExpiredCommands (catch interne):', error);
      // Ne pas propager l'erreur pour éviter de casser le setInterval
    }
  }

  // 🧹 NOUVEAU: Nettoyage du buffer de messages
  cleanupMessageBuffer() {
    try {
      const now = Date.now();
      let cleanedCount = 0;

      for (const [messageId, bufferData] of this.messageBuffer.entries()) {
        const age = now - bufferData.timestamp;

        // Si le message est trop vieux ou a été traité, le nettoyer
        if (age > this.maxBufferAge || bufferData.processed) {
          this.messageBuffer.delete(messageId);
          cleanedCount++;
        }
      }

      if (cleanedCount > 0) {
      }
    } catch (error) {
      console.error('❌ Erreur dans cleanupMessageBuffer (catch interne):', error);
      // Ne pas propager l'erreur
    }
  }

  // 🧹 NOUVEAU: Nettoyage du throttle d'erreurs
  cleanupErrorThrottle() {
    try {
      const now = Date.now();
      let cleanedCount = 0;

      for (const [errorKey, timestamp] of this.errorThrottle.entries()) {
        // Supprimer les entrées de plus d'une minute
        if (now - timestamp > 60000) {
          this.errorThrottle.delete(errorKey);
          cleanedCount++;
        }
      }

      // Safety cap : si le throttle dépasse 5000 entrées, forcer un clear
      if (this.errorThrottle.size > 5000) {
        console.warn(`⚠️ [Scraper] errorThrottle anormal (${this.errorThrottle.size}), nettoyage forcé`);
        this.errorThrottle.clear();
      }

      if (cleanedCount > 0) {
      }
    } catch (error) {
      console.error('❌ Erreur dans cleanupErrorThrottle (catch interne):', error);
      // Ne pas propager l'erreur
    }
  }

  // 🛑 Méthode pour stopper proprement le service
  destroy() {
    try {
      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
        this.cleanupInterval = null;
      }

      // Nettoyer les collections
      this.pendingSlashCommands.clear();
      this.pendingByComposite.clear();
      this.messageBuffer.clear();
      this.errorThrottle.clear();
      this.activeScrapers.clear();

    } catch (error) {
      console.error('❌ Erreur lors de la destruction du ScraperService:', error);
    }
  }

  // 📝 FINALISER UNE COMMANDE SLASH QUI N'A PAS REÇU DE RÉPONSE
  async finalizeSlashCommandWithoutResponse(commandKey, commandData) {
    try {
      const webhook = await this.getOrCreateWebhook(commandData.targetChannel);
      
      // Message de finalisation
      const finalizationMessage = `⏱️ **Timeout de la commande** \`${commandData.slashDetails.commandName}\`\n\n` +
        `❌ Aucune réponse reçue après 30 secondes\n` +
        `💡 Possible que le bot soit lent ou que la commande ait échoué silencieusement`;
      
      const webhookPayload = {
        content: finalizationMessage,
        username: `${commandData.command.author.username} [Timeout]`,
        avatarURL: commandData.command.author.avatar ? 
          `https://cdn.discordapp.com/avatars/${commandData.command.author.id}/${commandData.command.author.avatar}.png?size=256` :
          `https://cdn.discordapp.com/embed/avatars/${commandData.command.author.discriminator % 5}.png`,
        allowedMentions: { parse: [] }
      };
      
      // 🏛️ Ajouter threadId si nécessaire
      const isCommandForumThread = commandData.targetChannel.type === 11 && 
                            commandData.targetChannel.parentId && 
                            commandData.targetChannel.parent?.type === 15;
      if (isCommandForumThread) {
        webhookPayload.threadId = commandData.targetChannel.id;
      }
      
      await this.sendWebhookWithRetry(webhook, webhookPayload);
      
    } catch (error) {
      console.error(`❌ Erreur finalisation timeout commande:`, error);
    }
  }

  // 🤖 DÉTECTER SI UN UTILISATEUR EST UN BOT APP
  isAppBot(author) {
    // Un bot APP a typiquement :
    // - bot: true
    // - system: false 
    // - discriminator défini (souvent "0000")
    // - Pas un webhook
    return author.bot && !author.system && author.discriminator !== undefined;
  }

  // 🎯 TRAITER UNE COMMANDE SLASH
  async handleSlashCommand(sourceMessage, targetChannel, sourceGuild) {
    try {
      // 🔍 EXTRAIRE LES DÉTAILS DE LA COMMANDE SLASH (AMÉLIORÉ)
      const slashDetails = this.extractSlashCommandDetails(sourceMessage);
      
      // 🆕 CRÉER LES CLÉS D'ASSOCIATION
      const interactionId = sourceMessage.interaction?.id;
      const compositeKey = botPatterns.createCompositeKey(sourceMessage);
      
      // Stocker les données de la commande
      const commandData = {
        command: sourceMessage,
        slashDetails: slashDetails,
        timestamp: Date.now(),
        targetChannel: targetChannel,
        sourceGuild: sourceGuild,
        responses: [],
        interactionId: interactionId,
        compositeKey: compositeKey
      };
      
      // Stocker avec plusieurs clés pour améliorer l'association
      if (interactionId) {
        this.pendingSlashCommands.set(interactionId, commandData);
      }
      
      // Toujours stocker avec la clé composite pour fallback robuste
      this.pendingByComposite.set(compositeKey.primary, commandData);
      this.pendingByComposite.set(compositeKey.secondary, commandData);
      
      // Fallback avec l'ancienne méthode
      const fallbackKey = `${sourceMessage.channel.id}-${sourceMessage.id}`;
      this.pendingSlashCommands.set(fallbackKey, commandData);
      
      
      // Envoyer immédiatement la commande avec les détails extraits
      const webhook = await this.getOrCreateWebhook(targetChannel);
      
      const avatarURL = sourceMessage.author.avatar ? 
        `https://cdn.discordapp.com/avatars/${sourceMessage.author.id}/${sourceMessage.author.avatar}.png?size=256` :
        `https://cdn.discordapp.com/embed/avatars/${sourceMessage.author.discriminator % 5}.png`;
      
      // 🎨 FORMATER LE MESSAGE DE COMMANDE SLASH
      let commandContent = this.formatSlashCommandMessage(slashDetails);
      
      const webhookPayload = {
        content: commandContent,
        username: `${sourceMessage.author.username}`,
        avatarURL: avatarURL,
        allowedMentions: { parse: [] } // Pas de mentions pour les commandes
      };
      
      // 🏛️ Ajouter threadId si nécessaire
      const isSlashForumThread = targetChannel.type === 11 && targetChannel.parentId && targetChannel.parent?.type === 15;
      if (isSlashForumThread) {
        webhookPayload.threadId = targetChannel.id;
      }
      
      const sentMessage = await this.sendWebhookWithRetry(webhook, webhookPayload);

      // Protection null-safety: skip si webhook a échoué
      if (!sentMessage) {
        return null;
      }

      // 💾 STOCKER LES INFOS DU MESSAGE MIRROIRÉ
      await this.markMessageAsProcessed(
        sourceMessage.id,
        sourceMessage.channel.id,
        sentMessage.id,
        targetChannel.id,
        targetChannel.guild.id,
        webhook.id,
        webhook.token,
        false, // Pas d'embed en attente pour les commandes slash
        commandContent // Sauvegarder le contenu de la commande
      );

      return sentMessage;
      
    } catch (error) {
      console.error(`❌ Erreur traitement commande slash ${sourceMessage.id}:`, error);
      throw error;
    }
  }

  // 🔍 EXTRAIRE LES DÉTAILS D'UNE COMMANDE SLASH (AMÉLIORÉ)
  extractSlashCommandDetails(sourceMessage) {
    try {
      // Utiliser botPatterns pour une extraction plus robuste
      const details = botPatterns.extractCommandDetails(sourceMessage);
      
      // Si botPatterns a trouvé quelque chose, l'utiliser
      if (details.commandName) {
        return details;
      }
      
      // Fallback vers l'ancienne méthode si nécessaire
      let commandName = 'commande';
      let parameters = [];
      let fullCommand = '';
      
      // Méthode 1: Essayer d'extraire depuis le contenu
      if (sourceMessage.content && sourceMessage.content.trim()) {
        fullCommand = sourceMessage.content;
        
        // Pattern pour les commandes slash affichées
        const slashPattern = /^\/(\w+)(.*)$/;
        const match = sourceMessage.content.match(slashPattern);
        
        if (match) {
          commandName = match[1];
          const paramsString = match[2].trim();
          
          if (paramsString) {
            // Essayer de parser les paramètres (format basique)
            const paramMatches = paramsString.match(/(\w+):\s*([^\s]+(?:\s+[^\s]+)*?)(?=\s+\w+:|$)/g);
            if (paramMatches) {
              parameters = paramMatches.map(param => {
                const [name, ...valueParts] = param.split(':');
                return {
                  name: name.trim(),
                  value: valueParts.join(':').trim()
                };
              });
            }
          }
        }
      }
      
      // Méthode 2: Essayer d'extraire depuis les interactions (données Discord)
      if (sourceMessage.interaction) {
        const interaction = sourceMessage.interaction;
        commandName = interaction.commandName || commandName;
        
        if (interaction.options) {
          parameters = interaction.options.map(option => ({
            name: option.name,
            value: option.value,
            type: option.type
          }));
        }
      }
      
      // Méthode 3: Essayer d'extraire depuis les embeds si la commande est dans un embed
      if (sourceMessage.embeds && sourceMessage.embeds.length > 0) {
        for (const embed of sourceMessage.embeds) {
          if (embed.description && embed.description.includes('/')) {
            const embedSlashMatch = embed.description.match(/^\/(\w+)/);
            if (embedSlashMatch) {
              commandName = embedSlashMatch[1];
              break;
            }
          }
        }
      }
      
      return {
        commandName: commandName,
        parameters: parameters,
        fullCommand: fullCommand || `/${commandName}`,
        extractedFrom: sourceMessage.content ? 'content' : 
                       sourceMessage.interaction ? 'interaction' : 'embed'
      };
      
    } catch (error) {
      console.error('❌ Erreur extraction détails commande slash:', error);
      return {
        commandName: 'commande',
        parameters: [],
        fullCommand: '/commande',
        extractedFrom: 'fallback'
      };
    }
  }

  // 🎨 FORMATER LE MESSAGE DE COMMANDE SLASH
  formatSlashCommandMessage(slashDetails) {
    try {
      let message = `🎯 **Commande Slash Utilisée**\n\n`;
      
      // Nom de la commande
      message += `**📋 Commande :** \`${slashDetails.fullCommand}\`\n`;
      
      // Paramètres si présents
      if (slashDetails.parameters && slashDetails.parameters.length > 0) {
        message += `**⚙️ Paramètres :**\n`;
        for (const param of slashDetails.parameters.slice(0, 10)) { // Limiter à 10 paramètres
          const value = param.value ? param.value.toString().substring(0, 100) : 'vide';
          message += `• \`${param.name}\`: ${value}\n`;
        }
      } else {
        message += `**⚙️ Paramètres :** Aucun\n`;
      }
      
      // Métadonnées
      message += `\n**🔍 Détails :**\n`;
      message += `• Source: ${slashDetails.extractedFrom}\n`;
      message += `• ⏱️ En attente de la réponse du bot...`;
      
      return message;
      
    } catch (error) {
      console.error('❌ Erreur formatage commande slash:', error);
      return `🎯 **Commande Slash** : \`${slashDetails.commandName || 'commande'}\`\n⏱️ En attente de la réponse...`;
    }
  }

  // 🔗 ESSAYER D'ASSOCIER UNE RÉPONSE DE BOT À UNE COMMANDE SLASH (AMÉLIORÉ)
  async tryAssociateWithSlashCommand(sourceMessage, targetChannel, sourceGuild) {
    try {

      // Ne logger qu'en mode DEBUG les tentatives d'association
      if (shouldLog(LOG_LEVELS.DEBUG)) {
      }
      
      // Identifier le bot pour un meilleur matching
      const botInfo = botPatterns.identifyBot(sourceMessage.author);
      const isResponse = botPatterns.isBotResponse(sourceMessage, botInfo);
      
      if (isResponse && shouldLog(LOG_LEVELS.DEBUG)) {
      }
      
      // 🎯 MÉTHODE 1: RECHERCHE DIRECTE PAR INTERACTION ID
      const responseInteractionId = sourceMessage.interaction?.id;
      
      if (responseInteractionId) {
        
        const commandData = this.pendingSlashCommands.get(responseInteractionId);
        if (commandData) {
          await this.finalizeCommandResponse(commandData, sourceMessage, targetChannel, sourceGuild, responseInteractionId);
          return { commandKey: responseInteractionId, commandData };
        }
      }
      
      // 🔑 MÉTHODE 2: RECHERCHE PAR CLÉ COMPOSITE
      const responseComposite = botPatterns.createCompositeKey(sourceMessage);
      
      // Chercher dans les 5 dernières secondes
      for (const [key, commandData] of this.pendingByComposite.entries()) {
        const relation = botPatterns.areMessagesRelated(commandData.command, sourceMessage, 5000);
        if (relation && relation.related) {
          await this.finalizeCommandResponse(commandData, sourceMessage, targetChannel, sourceGuild, key);
          
          // Nettoyer toutes les clés associées
          this.cleanupCommandKeys(commandData);
          return { commandKey: key, commandData };
        }
      }
      
      // 🕸️ MÉTHODE 3: DÉTECTION PAR WEBHOOK PERSONNALISÉ
      if (sourceMessage.webhookId) {
        
        // Chercher une commande qui a pu stocker ce webhook ID
        for (const [commandKey, commandData] of this.pendingSlashCommands.entries()) {
          if (commandData.webhookId === sourceMessage.webhookId && 
              commandData.command.channel.id === sourceMessage.channel.id) {
            
            
            commandData.responses.push(sourceMessage);
            await this.sendBotResponse(sourceMessage, targetChannel, sourceGuild, commandData);
            this.pendingSlashCommands.delete(commandKey);
            
            return { commandKey, commandData };
          }
        }
        
      }
      
      // 🧠 MÉTHODE 4: ASSOCIATION PAR TIMING PRÉCIS + CONTENU INTELLIGENT
      
      const sourceChannelId = sourceMessage.channel.id;
      const messageTime = sourceMessage.createdTimestamp;
      
      // Analyser le contenu pour détecter des indices de réponse à slash command
      const contentHints = this.analyzeContentForSlashResponse(sourceMessage);
      
      const candidateCommands = Array.from(this.pendingSlashCommands.entries())
        .filter(([key, data]) => {
          // 🔧 CORRECTION: Comparaison plus robuste des salons
          const isLegacyKey = key.includes('-');
          
          let channelMatch = false;
          
          if (isLegacyKey) {
            // Format legacy: channelId-messageId
            channelMatch = key.split('-')[0] === sourceChannelId;
          } else {
            // Format moderne: interactionId
            // Comparer l'ID du salon de la commande avec l'ID du salon de la réponse
            channelMatch = data.command.channel.id === sourceChannelId;
          }
          
          // 🆕 FALLBACK: Si pas de match exact, essayer par nom de salon
          if (!channelMatch && data.command.channel.name === sourceMessage.channel.name) {
            channelMatch = true;
          }
          
          const timeDiff = messageTime - data.timestamp;
          const isRecentEnough = timeDiff >= 0 && timeDiff <= 60000; // 🔧 ÉTENDU À 60 secondes max
          const isNotOwnCommand = data.command.author.id !== sourceMessage.author.id;

          // Vérification bot compatible
          const botMatch = this.isBotResponseCompatible(sourceMessage, data);
          return channelMatch && isRecentEnough && isNotOwnCommand && botMatch;
        })
        .sort((a, b) => {
          // Trier par pertinence: d'abord par compatibilité de contenu, puis par proximité temporelle
          const scoreA = this.calculateAssociationScore(sourceMessage, a[1]);
          const scoreB = this.calculateAssociationScore(sourceMessage, b[1]);
          return scoreB - scoreA;
        });
      
      
      if (candidateCommands.length > 0) {
        const [commandKey, commandData] = candidateCommands[0];
        const score = this.calculateAssociationScore(sourceMessage, commandData);
        
        
        commandData.responses.push(sourceMessage);
        await this.sendBotResponse(sourceMessage, targetChannel, sourceGuild, commandData);
        
        // Supprimer la commande terminée
        this.pendingSlashCommands.delete(commandKey);
        
        return { commandKey, commandData };
      }
      
      // 🔄 MÉTHODE 5: DERNIER RECOURS - ASSOCIATION PAR PROXIMITÉ PURE
      
      const recentCommands = Array.from(this.pendingSlashCommands.entries())
        .filter(([_, data]) => {
          const timeDiff = sourceMessage.createdTimestamp - data.timestamp;
          return timeDiff >= 0 && timeDiff <= 3000 && // 3 secondes max
                 data.command.channel.id === sourceMessage.channel.id;
        })
        .sort((a, b) => b[1].timestamp - a[1].timestamp); // Plus récent en premier
      
      if (recentCommands.length > 0) {
        const [commandKey, commandData] = recentCommands[0];
        await this.finalizeCommandResponse(commandData, sourceMessage, targetChannel, sourceGuild, commandKey);
        return { commandKey, commandData };
      }
      
      // N'afficher l'échec d'association qu'en mode DEBUG
      if (shouldLog(LOG_LEVELS.DEBUG)) {
      }
      return null;
      
    } catch (error) {
      console.error(`❌ Erreur association réponse bot:`, error);
      return null;
    }
  }

  // 🆕 ANALYSER LE CONTENU POUR DÉTECTER DES INDICES DE RÉPONSE À SLASH COMMAND
  analyzeContentForSlashResponse(sourceMessage) {
    const hints = {
      hasEmbeds: sourceMessage.embeds?.length > 0,
      hasButtons: sourceMessage.components?.some(row => row.components?.length > 0),
      hasImages: sourceMessage.embeds?.some(embed => embed.image || embed.thumbnail),
      contentLength: sourceMessage.content?.length || 0,
      mentionsUsers: sourceMessage.mentions?.users?.size > 0,
      hasFields: sourceMessage.embeds?.some(embed => embed.fields?.length > 0),
      isRichResponse: false
    };
    
    // Une réponse "riche" a généralement des embeds, images, ou boutons
    hints.isRichResponse = hints.hasEmbeds || hints.hasButtons || hints.hasImages;
    
    return hints;
  }

  // 🆕 VÉRIFIER SI UN BOT EST COMPATIBLE AVEC UNE COMMANDE
  isBotResponseCompatible(responseMessage, commandData) {
    try {
      // 1. Même bot qui a envoyé la commande = compatible
      if (responseMessage.author.id === commandData.command.author.id) {
        return false; // C'est la même personne, pas une réponse de bot
      }
      
      // 2. Bot connu pour répondre à des slash commands
      const knownSlashBots = [
        'Maltys\' Group', 'FeedL2.0', 'FeedL Scraper', 'Dyno', 'MEE6', 'Carl-bot',
        'Ticket Tool', 'Slash Commands', 'Apollo', 'Shoob', 'Pokétwo'
      ];
      
      const botName = responseMessage.author.username;
      const isKnownSlashBot = knownSlashBots.some(name => 
        botName.toLowerCase().includes(name.toLowerCase()) || 
        name.toLowerCase().includes(botName.toLowerCase())
      );
      
      if (isKnownSlashBot) {
        return true;
      }
      
      // 3. Bot avec discriminator #0000 (typique des bots APP)
      if (responseMessage.author.discriminator === '0000') {
        return true;
      }
      
      // 4. Bot avec application_id (bot officiel)
      if (responseMessage.applicationId) {
        return true;
      }
      
      // 5. Message riche (embeds, boutons) suggère une réponse de bot command
      const hints = this.analyzeContentForSlashResponse(responseMessage);
      if (hints.isRichResponse) {
        return true;
      }
      
      return false;
      
    } catch (error) {
      console.error('❌ Erreur vérification compatibilité bot:', error);
      return false;
    }
  }

  // 🆕 CALCULER UN SCORE D'ASSOCIATION INTELLIGENT
  calculateAssociationScore(responseMessage, commandData) {
    let score = 0;
    
    try {
      // Score temporel (plus récent = mieux)
      const timeDiff = responseMessage.createdTimestamp - commandData.timestamp;
      const timeScore = Math.max(0, 10 - (timeDiff / 1000)); // 10 points max si immédiat
      score += timeScore;
      
      // Score de compatibilité bot
      if (this.isBotResponseCompatible(responseMessage, commandData)) {
        score += 20;
      }
      
      // Score de richesse du contenu
      const hints = this.analyzeContentForSlashResponse(responseMessage);
      if (hints.hasEmbeds) score += 10;
      if (hints.hasButtons) score += 15;
      if (hints.hasImages) score += 5;
      if (hints.hasFields) score += 5;
      
      // Score de longueur de contenu approprié
      if (hints.contentLength > 10 && hints.contentLength < 2000) {
        score += 5;
      }
      
      // Pénalité si c'est le même auteur
      if (responseMessage.author.id === commandData.command.author.id) {
        score -= 100; // Gros malus
      }
      
      return Math.max(0, score);
      
    } catch (error) {
      console.error('❌ Erreur calcul score association:', error);
      return 0;
    }
  }

  // Envoyer une réponse de bot immédiatement
  async sendBotResponse(sourceMessage, targetChannel, sourceGuild, commandData = null) {
    try {
      // 🆕 OPTION A: UTILISER L'API D'INTERACTION SI DISPONIBLE
      let sentMessage = null;
      let usedInteraction = false;
      
      // 🔍 CHERCHER UNE INTERACTION ACTIVE POUR CETTE COMMANDE
      if (this.client.activeInteractions && commandData && commandData.interactionId) {
        const storedInteraction = this.client.activeInteractions.get(commandData.interactionId);
        
        if (storedInteraction && !storedInteraction.responded) {
          
          try {
            // Traiter le contenu et les embeds
            let content = await this.processAdvancedMessageContent(sourceMessage.content || '', sourceGuild);
            const { embeds } = await this.processAdvancedEmbeds(sourceMessage.embeds || [], sourceGuild, sourceMessage);
            const files = await this.processAttachments(sourceMessage.attachments);
            
            // 🎨 FORMATER LA RÉPONSE POUR UNE COMMANDE SLASH
            if (commandData && commandData.slashDetails) {
              content = this.formatBotResponseToSlashCommand(content, commandData, sourceMessage);
            }
            
            // Vérification contenu
            const hasContent = content && content.trim() !== '';
            const hasEmbeds = embeds && embeds.length > 0;
            const hasFiles = files && files.length > 0;
            
            const interactionPayload = {
              content: hasContent ? content : undefined,
              embeds: hasEmbeds ? embeds.slice(0, 10) : undefined,
              files: hasFiles ? files.slice(0, 10) : undefined,
              fetchReply: true  // ✨ CRITIQUE: Assure que le message aura interaction.id
            };
            
            // Si tout est vide, mettre un contenu minimal
            if (!hasContent && !hasEmbeds && !hasFiles) {
              interactionPayload.content = `✅ **Réponse à la commande** \`${commandData.slashDetails.commandName}\`\n\n🤖 *Réponse sans contenu visible*`;
            }
            
            // ✅ UTILISER L'API D'INTERACTION
            if (storedInteraction.interaction.deferred) {
              sentMessage = await storedInteraction.interaction.followUp(interactionPayload);
            } else {
              sentMessage = await storedInteraction.interaction.reply(interactionPayload);
            }
            
            // Marquer l'interaction comme utilisée
            storedInteraction.responded = true;
            usedInteraction = true;
            
            
          } catch (interactionError) {
            console.error(`❌ Erreur API d'interaction, fallback webhook:`, interactionError.message);
            // Fallback vers webhook si l'interaction échoue
          }
        }
      }
      
      // 🔄 FALLBACK: UTILISER WEBHOOK SI PAS D'INTERACTION DISPONIBLE
      if (!sentMessage) {
        
        const webhook = await this.getOrCreateWebhook(targetChannel);
        
        const avatarURL = sourceMessage.author.avatar ? 
          `https://cdn.discordapp.com/avatars/${sourceMessage.author.id}/${sourceMessage.author.avatar}.png?size=256` :
          `https://cdn.discordapp.com/embed/avatars/${sourceMessage.author.discriminator % 5}.png`;
        
        // Traiter le contenu et les embeds
        let content = await this.processAdvancedMessageContent(sourceMessage.content || '', sourceGuild);
        const { embeds } = await this.processAdvancedEmbeds(sourceMessage.embeds || [], sourceGuild, sourceMessage);
        const files = await this.processAttachments(sourceMessage.attachments);
        
        // 🎨 FORMATER LA RÉPONSE SI C'EST UNE RÉPONSE À UNE COMMANDE SLASH
        if (commandData && commandData.slashDetails) {
          content = this.formatBotResponseToSlashCommand(content, commandData, sourceMessage);
        }
        
        // Vérification contenu
        const hasContent = content && content.trim() !== '';
        const hasEmbeds = embeds && embeds.length > 0;
        const hasFiles = files && files.length > 0;
        
        const webhookPayload = {
          content: hasContent ? content : undefined,
          embeds: hasEmbeds ? embeds.slice(0, 10) : undefined,
          files: hasFiles ? files.slice(0, 10) : undefined,
          username: `${sourceMessage.author.username}`,
          avatarURL: avatarURL,
          allowedMentions: { parse: ['roles'] }
        };
        
        // Si tout est vide, mettre un contenu minimal
        if (!hasContent && !hasEmbeds && !hasFiles) {
          if (commandData && commandData.slashDetails) {
            webhookPayload.content = `✅ **Réponse à la commande** \`${commandData.slashDetails.commandName}\`\n\n🤖 *Réponse sans contenu visible*`;
          } else {
            webhookPayload.content = `🤖 *Réponse de bot*`;
          }
        }
        
        // 🏛️ Ajouter threadId si nécessaire
        const isEventForumThread = targetChannel.type === 11 && targetChannel.parentId && targetChannel.parent?.type === 15;
        if (isEventForumThread) {
          webhookPayload.threadId = targetChannel.id;
        }
        
        sentMessage = await this.sendWebhookWithRetry(webhook, webhookPayload);
      }

      // Protection null-safety: skip si webhook/interaction a échoué
      if (!sentMessage) {
        return null;
      }

      // Ajouter les réactions si présentes
      await this.processReactions(sourceMessage, sentMessage, targetChannel.guild);

      // 💾 STOCKER LES INFOS DU MESSAGE MIRROIRÉ
      await this.markMessageAsProcessed(
        sourceMessage.id,
        sourceMessage.channel.id,
        sentMessage.id,
        targetChannel.id,
        targetChannel.guild.id,
        webhook.id,
        webhook.token,
        false, // Pas d'embed en attente
        content // Sauvegarder le contenu traité
      );

      return sentMessage;
      
    } catch (error) {
      console.error(`❌ Erreur envoi réponse bot:`, error);
      throw error;
    }
  }

  // 🎨 FORMATER LA RÉPONSE D'UN BOT À UNE COMMANDE SLASH
  formatBotResponseToSlashCommand(content, commandData, sourceMessage) {
    try {
      const slashDetails = commandData.slashDetails;
      const responseNumber = commandData.responses.length;
      
      let formattedContent = `✅ **Réponse à la commande** \`${slashDetails.commandName}\``;
      
      // Ajouter le numéro de réponse si c'est la 2ème réponse ou plus
      if (responseNumber > 1) {
        formattedContent += ` *(réponse ${responseNumber})*`;
      }
      
      formattedContent += `\n\n`;
      
      // Ajouter le contenu de la réponse s'il existe
      if (content && content.trim()) {
        formattedContent += content;
      } else {
        // Vérifier s'il y a des embeds ou attachments
        const hasEmbeds = sourceMessage.embeds && sourceMessage.embeds.length > 0;
        const hasAttachments = sourceMessage.attachments && sourceMessage.attachments.size > 0;
        
        if (hasEmbeds) {
          formattedContent += `📋 *Réponse sous forme d'embed*`;
        } else if (hasAttachments) {
          formattedContent += `📎 *Réponse avec fichier(s) joint(s)*`;
        } else {
          formattedContent += `🤖 *Réponse du bot reçue*`;
        }
      }
      
      return formattedContent;
      
    } catch (error) {
      console.error('❌ Erreur formatage réponse bot:', error);
      return content || '🤖 *Réponse de bot*';
    }
  }

  // 🆕 NOUVELLE MÉTHODE: Finaliser l'association commande-réponse
  async finalizeCommandResponse(commandData, responseMessage, targetChannel, sourceGuild, commandKey) {
    try {
      // Ajouter la réponse à la commande
      commandData.responses.push(responseMessage);
      
      // Envoyer la réponse du bot
      await this.sendBotResponse(responseMessage, targetChannel, sourceGuild, commandData);
      
      // Nettoyer toutes les clés associées
      this.cleanupCommandKeys(commandData);
      
    } catch (error) {
      console.error(`❌ Erreur finalisation commande:`, error);
    }
  }
  
  // 🧹 NOUVELLE MÉTHODE: Nettoyer toutes les clés d'une commande
  cleanupCommandKeys(commandData) {
    // Supprimer par interaction ID
    if (commandData.interactionId) {
      this.pendingSlashCommands.delete(commandData.interactionId);
    }
    
    // Supprimer par clé composite
    if (commandData.compositeKey) {
      this.pendingByComposite.delete(commandData.compositeKey.primary);
      this.pendingByComposite.delete(commandData.compositeKey.secondary);
    }
    
    // Supprimer par clé fallback
    const fallbackKey = `${commandData.command.channel.id}-${commandData.command.id}`;
    this.pendingSlashCommands.delete(fallbackKey);
  }

  // Traiter les mentions d'utilisateurs
  async processUserMentions(content, sourceGuild) {
    const userMentionRegex = /<@!?(\d+)>/g;
    let processedContent = content;
    
    const matches = content.matchAll(userMentionRegex);
    for (const match of matches) {
      try {
        const userId = match[1];
        
        let sourceUser = null;
        
        // Essayer avec le userClient si disponible
        if (this.userClient && this.userClient.users) {
          sourceUser = this.userClient.users.cache.get(userId);
        }
        
        // Fallback : client officiel
        if (!sourceUser && this.client && this.client.users) {
          sourceUser = this.client.users.cache.get(userId);
        }
        
        // Essayer fetch si pas en cache
        if (!sourceUser) {
          try {
            if (this.userClient && this.userClient.users && this.userClient.users.fetch) {
              sourceUser = await this.userClient.users.fetch(userId);
            } else if (this.client && this.client.users && this.client.users.fetch) {
              sourceUser = await this.client.users.fetch(userId);
            }
          } catch (fetchError) {
            // Continuer
          }
        }
        
        // Recherche dans les membres du serveur source
        if (!sourceUser && sourceGuild && sourceGuild.members) {
          try {
            const member = sourceGuild.members.cache.get(userId);
            if (member && member.user) {
              sourceUser = member.user;
            }
          } catch (memberError) {
            // Continuer
          }
        }
        
        if (sourceUser) {
          const replacement = `**@${sourceUser.username}**`;
          processedContent = processedContent.replace(match[0], replacement);
        } else {
          const defaultNames = require('../config/defaultNames');
          const replacement = `**@${defaultNames.mirrorDefaults.userName}**`;
          processedContent = processedContent.replace(match[0], replacement);
        }
        
      } catch (error) {
        const defaultNames = require('../config/defaultNames');
        const replacement = `**@${defaultNames.mirrorDefaults.userName}**`;
        processedContent = processedContent.replace(match[0], replacement);
      }
    }
    
    return processedContent;
  }

  // 🆕 GESTION AVANCÉE DES MESSAGES TRANSFÉRÉS D'AUTRES SERVEURS
  async handleCrossServerForwardedMessage(sourceMessage, refError) {
    try {
      // Continue avec le traitement même si la référence ne peut pas être récupérée
    } catch (error) {
      console.error('Erreur traitement message transféré:', error.message);
    }
  }

  // 🆕 DÉTECTER SI UN MESSAGE EST TRANSFÉRÉ
  isForwardedMessage(sourceMessage) {
    const detectedReasons = [];
    
    // Raison 1: Message avec référence mais contenu vide
    if (sourceMessage.reference && (!sourceMessage.content || sourceMessage.content.trim() === '')) {
      detectedReasons.push(1);
    }
    
    // Raison 2: Embed avec contenu mais message principal vide  
    if ((!sourceMessage.content || sourceMessage.content.trim() === '') && 
        sourceMessage.embeds && sourceMessage.embeds.length > 0) {
      detectedReasons.push(2);
    }
    
    // Raison 3: Message avec uniquement embeds (pattern fréquent des transferts)
    if (sourceMessage.embeds && sourceMessage.embeds.length > 0 && 
        (!sourceMessage.content || sourceMessage.content.trim() === '')) {
      detectedReasons.push(3);
    }
    
    const isForwarded = detectedReasons.length > 0;
    
    if (isForwarded) {
    }
    
    return isForwarded;
  }

  // 🆕 EXTRAIRE LE CONTENU DES MESSAGES TRANSFÉRÉS
  async extractForwardedContent(sourceMessage, sourceGuild) {
    let extractedContent = '';
    
    try {
      // Méthode 1: Contenu direct du message (rare mais possible)
      if (sourceMessage.content && sourceMessage.content.trim() !== '') {
        extractedContent = sourceMessage.content;
      }
      
      // Méthode 2: Extraire depuis les embeds (très fréquent)
      else if (sourceMessage.embeds && sourceMessage.embeds.length > 0) {
        extractedContent = this.extractContentFromEmbeds(sourceMessage.embeds);
      }
      
      // Méthode 3: Utiliser les infos de référence si disponibles
      else if (sourceMessage.reference) {
        extractedContent = this.extractReferenceInfo(sourceMessage.reference);
      }
      
      // Méthode 4: Fallback avec infos du message
      else {
        extractedContent = this.generateForwardedFallback(sourceMessage);
      }
      
      // Traiter le préfixe selon la source
      let finalContent = extractedContent;
      
      // 🎯 ANALYSER LE TYPE DE RÉFÉRENCE ET ADAPTER LE PRÉFIXE
      if (sourceMessage.reference) {
        const reference = sourceMessage.reference;
        
        // Générer l'URL Discord pour rendre le lien cliquable
        const messageUrl = this.generateDiscordUrl(reference, sourceGuild.id);
        
        if (reference.guildId && reference.guildId !== sourceGuild.id) {
          // 📨 TRANSFERT EXTERNE : Serveur différent
          if (messageUrl) {
            finalContent = `[📨 **Transfert externe**](${messageUrl}):\n${extractedContent}`;
          } else {
            finalContent = `📨 **Transfert externe**:\n${extractedContent}`;
          }
        } else if (reference.channelId && reference.channelId !== sourceMessage.channel.id) {
          // 🔄 TRANSFERT INTERNE : Même serveur, salon différent
          if (messageUrl) {
            finalContent = `[🔄 **Transfert interne**](${messageUrl}):\n${extractedContent}`;
          } else {
            finalContent = `🔄 **Transfert interne**:\n${extractedContent}`;
          }
        } else if (reference.channelId === sourceMessage.channel.id) {
          // ↪️ RÉPONSE : Même salon
          if (messageUrl) {
            finalContent = `[↪️ **Réponse**](${messageUrl}):\n${extractedContent}`;
          } else {
            finalContent = `↪️ **Réponse**:\n${extractedContent}`;
          }
      } else {
          // 🔄 TRANSFERT PAR DÉFAUT : Si on ne peut pas déterminer
          if (messageUrl) {
            finalContent = `[🔄 **Transfert**](${messageUrl}):\n${extractedContent}`;
          } else {
            finalContent = `🔄 **Transfert**:\n${extractedContent}`;
          }
        }
      } else {
        // Message du serveur monitoré sans référence = affichage normal
        finalContent = extractedContent;
      }
      
      return finalContent;
      
    } catch (error) {
      console.error('Erreur extraction contenu transféré:', error.message);
      return `⚠️ *Message transféré non lisible*`;
    }
  }

  // 🆕 EXTRAIRE CONTENU DEPUIS LES EMBEDS
  extractContentFromEmbeds(embeds) {
    try {
      let content = '';
      
      for (const embed of embeds.slice(0, 3)) { // Limiter à 3 embeds
        if (embed.title) {
          content += embed.title + '\n';
        }
        if (embed.description) {
          content += embed.description + '\n';
        }
        if (embed.fields) {
          for (const field of embed.fields.slice(0, 5)) { // Limiter à 5 fields
            content += `**${field.name}:** ${field.value}\n`;
          }
        }
      }
      
      return content.trim();
    } catch (error) {
      console.error('❌ Erreur extraction embeds:', error);
      return '';
    }
  }

  // 🆕 GÉNÉRER URL DISCORD DEPUIS LA RÉFÉRENCE
  generateDiscordUrl(reference, sourceGuildId = null) {
    try {
      if (!reference || !reference.messageId || !reference.channelId) {
        return null;
      }
      
      // Utiliser l'ID du serveur depuis la référence ou le serveur source
      const guildId = reference.guildId || sourceGuildId;
      if (!guildId) {
        return null;
      }
      
      // Construire l'URL Discord standard
      return `https://discord.com/channels/${guildId}/${reference.channelId}/${reference.messageId}`;
    } catch (error) {
      console.error('❌ Erreur génération URL Discord:', error);
      return null;
    }
  }

  // 🆕 EXTRAIRE INFOS DE RÉFÉRENCE
  extractReferenceInfo(reference) {
    try {
      let info = '';
      
      if (reference.guildId) {
        info += `Serveur: ${reference.guildId}\n`;
      }
      if (reference.channelId) {
        info += `Salon: <#${reference.channelId}>\n`;
      }
      if (reference.messageId) {
        info += `Message: ${reference.messageId}`;
      }
      
      return info || null;
    } catch (error) {
      console.error('❌ Erreur extraction référence:', error);
      return null;
    }
  }

  // 🆕 GÉNÉRER FALLBACK POUR MESSAGES TRANSFÉRÉS
  generateForwardedFallback(sourceMessage) {
    try {
      const author = sourceMessage.author?.username || 'Utilisateur inconnu';
      const channel = sourceMessage.channel?.name || 'salon inconnu';
      const time = new Date(sourceMessage.createdTimestamp).toLocaleString('fr-FR');

      let fallback = `Posté par **${author}** dans **#${channel}** le ${time}`;

      // Ajouter infos supplémentaires si disponibles
      if (sourceMessage.attachments?.size > 0) {
        fallback += `\n📎 ${sourceMessage.attachments.size} fichier(s) joint(s)`;
      }

      if (sourceMessage.embeds?.length > 0) {
        fallback += `\n📋 ${sourceMessage.embeds.length} contenu(s) intégré(s)`;
      }

      return fallback;
    } catch (error) {
      console.error('❌ Erreur génération fallback:', error);
      return 'Contenu non disponible';
    }
  }

  /**
   * 📊 Tracker un membre qui a posté un message
   * Alimente MemberDetail pour le rapport membres-dangereux
   * Méthode non-bloquante et silencieuse en cas d'erreur
   */
  async trackMemberFromMessage(sourceMessage, sourceGuild) {
    try {
      // Validation stricte - skip silencieusement si données invalides
      if (!sourceMessage?.author?.id || !sourceGuild?.id) return;

      // Ignorer les bots
      if (sourceMessage.author.bot) return;

      const MemberDetail = require('../models/MemberDetail');

      // Upsert atomique : créer si n'existe pas, update lastSeen si existe
      await MemberDetail.findOneAndUpdate(
        {
          guildId: sourceGuild.id,
          userId: sourceMessage.author.id
        },
        {
          $set: {
            username: sourceMessage.author.username,
            displayName: sourceMessage.member?.displayName || sourceMessage.author.displayName || sourceMessage.author.username,
            lastSeen: new Date(),
            isPresent: true
          },
          $setOnInsert: {
            guildName: sourceGuild.name,
            firstSeenAt: new Date(),
            joinedAt: sourceMessage.member?.joinedAt || new Date(),
            totalJoins: 1,
            isDangerous: false,
            dangerLevel: 0,
            servers: [{
              guildId: sourceGuild.id,
              guildName: sourceGuild.name,
              joinedAt: new Date(),
              isPresent: true
            }]
          }
        },
        {
          upsert: true,
          new: false, // Ne pas retourner le doc (performance)
          runValidators: false // Skip validation (performance)
        }
      );
    } catch (error) {
      // Silencieux - ne pas spammer les logs pour chaque message
      // Seules les erreurs critiques (pas duplicate key qui est attendu parfois)
      if (!error.message?.includes('duplicate key') && !error.message?.includes('E11000')) {
        // Log uniquement en debug pour éviter le spam
        if (typeof isDebugMode === 'function' && isDebugMode()) {
          console.error('❌ Track member error:', error.message);
        }
      }
    }
  }
}

module.exports = ScraperService; 