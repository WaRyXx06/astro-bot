const Channel = require('../models/Channel');
const ProcessedMessage = require('../models/ProcessedMessage');
const rateLimiter = require('../utils/rateLimiter');

class ChannelWorker {
  constructor(channelData, sourceChannel, targetChannel, logger, scraper) {
    this.channelData = channelData;
    this.sourceChannel = sourceChannel;
    this.targetChannel = targetChannel;
    this.logger = logger;
    this.scraper = scraper;
    this.isRunning = false;
    this.intervalId = null;
    this.errorCount = 0;
    this.maxErrors = parseInt(process.env.MAX_RETRIES) || 3;
    this.backoffDelay = 1000; // Délai initial en ms
  }

  // Démarrer le worker
  start() {
    if (this.isRunning) {
      console.log(`Worker déjà actif pour le salon ${this.channelData.name}`);
      return;
    }

    this.isRunning = true;
    const delayMs = (this.channelData.delayMinutes || 5) * 60 * 1000;
    
    console.log(`Démarrage du worker pour ${this.channelData.name} (délai: ${this.channelData.delayMinutes}min)`);
    
    // Exécuter immédiatement puis programmer les exécutions suivantes
    this.executeWork();
    
    this.intervalId = setInterval(() => {
      this.executeWork();
    }, delayMs);
  }

  // Arrêter le worker
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    console.log(`Worker arrêté pour ${this.channelData.name}`);
  }

  // Exécuter le travail de scraping
  async executeWork() {
    try {
      // Vérifier si le canal source existe toujours
      if (!this.sourceChannel || !this.targetChannel) {
        console.log(`Canaux introuvables pour ${this.channelData.name}, arrêt du worker`);
        this.stop();
        return;
      }

      // Attendre pour respecter le rate limiting
      await rateLimiter.waitForRequest(this.channelData.discordId);

      // Récupérer les nouveaux messages
      const messages = await this.fetchNewMessages();
      
      if (messages.length === 0) {
        this.resetErrorCount(); // Succès, réinitialiser le compteur d'erreurs
        return;
      }

      console.log(`${messages.length} nouveaux messages trouvés dans ${this.channelData.name}`);

      // Traiter chaque message
      for (const message of messages.reverse()) { // Ordre chronologique
        try {
          await this.processMessage(message);
          await this.markMessageAsProcessed(message.id);
          
          // Enregistrer la requête dans le rate limiter
          rateLimiter.recordRequest(this.channelData.discordId);
          
          // Délai entre les messages
          await this.sleep(1000);
        } catch (error) {
          console.error(`Erreur lors du traitement du message ${message.id}:`, error);
          await this.logger.logError(
            this.targetChannel.guild.id,
            `Erreur traitement message dans ${this.channelData.name}: ${error.message}`,
            this.channelData.name
          );
        }
      }

      // Mettre à jour la date de dernier scraping
      await this.updateLastScraped();
      this.resetErrorCount();

    } catch (error) {
      console.error(`Erreur dans le worker ${this.channelData.name}:`, error);
      await this.handleError(error);
    }
  }

  // Récupérer les nouveaux messages
  async fetchNewMessages() {
    try {
      const options = { limit: 50 };
      
      // Récupérer le dernier message traité
      const lastProcessed = await ProcessedMessage
        .findOne({ channelId: this.channelData.discordId })
        .sort({ processedAt: -1 });

      if (lastProcessed) {
        options.after = lastProcessed.discordId;
      }

      const messages = await this.sourceChannel.messages.fetch(options);
      return Array.from(messages.values());
    } catch (error) {
      throw new Error(`Erreur récupération messages: ${error.message}`);
    }
  }

  // Traiter un message
  async processMessage(message) {
    try {
      return await this.scraper.processMessage(
        message, 
        this.targetChannel, 
        this.sourceChannel.guild
      );
    } catch (error) {
      throw new Error(`Erreur traitement message: ${error.message}`);
    }
  }

  // Marquer un message comme traité
  async markMessageAsProcessed(messageId) {
    try {
      const processedMessage = new ProcessedMessage({
        discordId: messageId,
        channelId: this.channelData.discordId
      });
      
      await processedMessage.save();
    } catch (error) {
      // Ignorer les erreurs de doublons
      if (error.code !== 11000) {
        throw error;
      }
    }
  }

  // Mettre à jour la date de dernier scraping
  async updateLastScraped() {
    try {
      await Channel.updateOne(
        { discordId: this.channelData.discordId },
        { lastScraped: new Date() }
      );
    } catch (error) {
      console.error('Erreur mise à jour lastScraped:', error);
    }
  }

  // Gérer les erreurs avec backoff exponentiel
  async handleError(error) {
    this.errorCount++;
    
    await this.logger.logError(
      this.targetChannel.guild.id,
      `Erreur worker ${this.channelData.name} (${this.errorCount}/${this.maxErrors}): ${error.message}`,
      this.channelData.name
    );

    if (this.errorCount >= this.maxErrors) {
      console.error(`Nombre maximum d'erreurs atteint pour ${this.channelData.name}, arrêt du worker`);
      this.stop();
      
      // Marquer le canal comme inactif
      await Channel.updateOne(
        { discordId: this.channelData.discordId },
        { inactive: true, scraped: false }
      );
      
      await this.logger.logError(
        this.targetChannel.guild.id,
        `Worker ${this.channelData.name} arrêté définitivement après ${this.maxErrors} erreurs consécutives`
      );
      return;
    }

    // Backoff exponentiel
    const delay = this.backoffDelay * Math.pow(2, this.errorCount - 1);
    console.log(`Attente de ${delay}ms avant nouvelle tentative pour ${this.channelData.name}`);
    await this.sleep(delay);
  }

  // Réinitialiser le compteur d'erreurs après un succès
  resetErrorCount() {
    if (this.errorCount > 0) {
      console.log(`Worker ${this.channelData.name} récupéré après ${this.errorCount} erreurs`);
      this.errorCount = 0;
      this.backoffDelay = 1000; // Réinitialiser le délai de base
    }
  }

  // Health check du worker
  async healthCheck() {
    try {
      // Vérifier si les canaux existent toujours
      if (!this.sourceChannel || !this.targetChannel) {
        return { healthy: false, reason: 'Canaux introuvables' };
      }

      // Vérifier si le worker fonctionne
      if (!this.isRunning) {
        return { healthy: false, reason: 'Worker arrêté' };
      }

      // Vérifier le nombre d'erreurs
      if (this.errorCount >= this.maxErrors) {
        return { healthy: false, reason: 'Trop d\'erreurs' };
      }

      // Vérifier la dernière activité
      const lastScraped = await Channel.findOne({ discordId: this.channelData.discordId });
      if (lastScraped && lastScraped.lastScraped) {
        const timeSinceLastScrape = Date.now() - lastScraped.lastScraped.getTime();
        const expectedInterval = (this.channelData.delayMinutes || 5) * 60 * 1000;
        
        if (timeSinceLastScrape > expectedInterval * 2) {
          return { 
            healthy: false, 
            reason: `Pas d'activité depuis ${Math.round(timeSinceLastScrape / 60000)} minutes` 
          };
        }
      }

      return { 
        healthy: true, 
        stats: {
          errorCount: this.errorCount,
          isRunning: this.isRunning,
          delayMinutes: this.channelData.delayMinutes
        }
      };
    } catch (error) {
      return { healthy: false, reason: `Erreur health check: ${error.message}` };
    }
  }

  // Redémarrer le worker
  async restart(reason = 'Manual restart') {
    console.log(`Redémarrage du worker ${this.channelData.name}: ${reason}`);
    
    await this.logger.logError(
      this.targetChannel.guild.id,
      `Redémarrage du worker ${this.channelData.name}: ${reason}`
    );

    this.stop();
    this.resetErrorCount();
    
    // Attendre un peu avant de redémarrer
    await this.sleep(2000);
    this.start();
  }

  // Mettre à jour la configuration du worker
  async updateConfig(newDelayMinutes) {
    if (newDelayMinutes !== this.channelData.delayMinutes) {
      console.log(`Mise à jour délai pour ${this.channelData.name}: ${this.channelData.delayMinutes}min -> ${newDelayMinutes}min`);
      
      this.channelData.delayMinutes = newDelayMinutes;
      
      // Mettre à jour en base de données
      await Channel.updateOne(
        { discordId: this.channelData.discordId },
        { delayMinutes: newDelayMinutes }
      );
      
      // Redémarrer avec le nouveau délai
      await this.restart('Configuration mise à jour');
    }
  }

  // Utilitaire pour attendre
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Obtenir les statistiques du worker
  getStats() {
    return {
      channelName: this.channelData.name,
      isRunning: this.isRunning,
      errorCount: this.errorCount,
      delayMinutes: this.channelData.delayMinutes,
      maxErrors: this.maxErrors
    };
  }
}

module.exports = ChannelWorker; 