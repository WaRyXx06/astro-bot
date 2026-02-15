/**
 * SERVICE DE MONITORING D'ACTIVITÉ
 * 
 * Détecte quand le système de mirror est down en trackant l'activité des messages.
 * Si pas de message pendant 45 minutes → alerte @everyone dans le salon error.
 */

class ActivityMonitorService {
  constructor(client, logger) {
    this.client = client;
    this.logger = logger;
    
    // Timer de monitoring
    this.monitoringTimer = null;
    this.isSystemDown = false;
    this.lastActivityTime = Date.now();
    this.downSince = null;

    // Configuration avec seuils dynamiques
    this.DAY_THRESHOLD = 45 * 60 * 1000; // 45 minutes en journée
    this.NIGHT_THRESHOLD = 3 * 60 * 60 * 1000; // 3 heures la nuit
    this.WEEKEND_THRESHOLD = 90 * 60 * 1000; // 90 minutes le week-end
    this.ALERT_INTERVAL = 45 * 60 * 1000; // Alertes toutes les 45 minutes

    // Mode nuit intelligent
    this.NIGHT_MODE_ENABLED = true;
    this.NIGHT_START_HOUR = 23; // 23h
    this.NIGHT_END_HOUR = 7; // 7h
    
  }

  /**
   * Démarre le monitoring d'activité
   */
  startMonitoring() {
    this.resetActivityTimer();
    const threshold = this.getActivityThreshold();
    const period = this.getCurrentPeriod();
  }

  /**
   * Arrête le monitoring d'activité
   */
  stopMonitoring() {
    if (this.monitoringTimer) {
      clearTimeout(this.monitoringTimer);
      this.monitoringTimer = null;
    }
    this.isSystemDown = false;
    this.downSince = null;
    console.log('⏹️ Monitoring d\'activité arrêté');
  }

  /**
   * Enregistre une activité (message traité par le mirror)
   */
  recordActivity() {
    const now = Date.now();
    this.lastActivityTime = now;
    
    // Si le système était down, on le marque comme récupéré
    if (this.isSystemDown) {
      this.markSystemRecovered();
    }
    
    // Reset le timer
    this.resetActivityTimer();
  }

  /**
   * Reset le timer de monitoring
   */
  resetActivityTimer() {
    // Annuler l'ancien timer
    if (this.monitoringTimer) {
      clearTimeout(this.monitoringTimer);
    }

    // Obtenir le seuil adapté à l'heure actuelle
    const threshold = this.getActivityThreshold();

    // Créer un nouveau timer avec le seuil dynamique
    this.monitoringTimer = setTimeout(() => {
      this.handleInactivityDetected();
    }, threshold);
  }

  /**
   * Gère la détection d'inactivité
   */
  async handleInactivityDetected() {
    const now = Date.now();
    const period = this.getCurrentPeriod();
    const threshold = this.getActivityThreshold();

    // Si on est en mode nuit et que c'est désactivé, ne pas alerter
    if (period === 'Nuit' && this.NIGHT_MODE_ENABLED) {
    }

    if (!this.isSystemDown) {
      // Première détection de problème
      this.isSystemDown = true;
      this.downSince = now;
      const durationText = this.formatDuration(threshold);

      await this.sendDownAlert();
    } else {
      // Système toujours down, envoyer une nouvelle alerte
      await this.sendDownAlert();
    }

    // Programmer la prochaine vérification
    this.scheduleNextAlert();
  }

  /**
   * Programme la prochaine alerte si le système reste down
   */
  scheduleNextAlert() {
    this.monitoringTimer = setTimeout(() => {
      this.handleInactivityDetected();
    }, this.ALERT_INTERVAL);
  }

  /**
   * Marque le système comme récupéré
   */
  async markSystemRecovered() {
    if (!this.isSystemDown) return;

    const downDuration = this.formatDuration(Date.now() - this.downSince);
    
    this.isSystemDown = false;
    this.downSince = null;
    
    await this.sendRecoveryNotification(downDuration);
  }

  /**
   * Envoie l'alerte de système down
   */
  async sendDownAlert() {
    try {
      // Trouver tous les serveurs configurés pour envoyer les alertes
      const guilds = this.client.guilds.cache;
      
      for (const [guildId, guild] of guilds) {
        await this.sendAlertToGuild(guild);
      }
      
    } catch (error) {
      console.error('❌ Erreur envoi alerte système down:', error);
    }
  }

  /**
   * Envoie l'alerte à un serveur spécifique
   */
  async sendAlertToGuild(guild) {
    try {
      // Import à la demande pour éviter les problèmes d'initialisation
      const { getNotificationChannelId } = require('../config/notificationChannels');
      
      // Récupérer le salon d'erreur configuré
      let errorChannelId = getNotificationChannelId(guild.id, 'ERROR_ALERTS');
      let errorChannel = null;
      
      // CAS SPÉCIAL : Auto-détection du salon "error" dans la catégorie Maintenance
      if (errorChannelId === 'auto-detect-error') {
        // Chercher le salon "error" dans la catégorie Maintenance
        const maintenanceCategory = guild.channels.cache.find(ch => 
          ch.type === 4 && ch.name.toLowerCase().includes('maintenance')
        );
        
        if (maintenanceCategory) {
          errorChannel = guild.channels.cache.find(ch => 
            ch.name === 'error' && ch.parent?.id === maintenanceCategory.id
          );
        }
        
        if (!errorChannel) {
          return;
        }
        
      } else {
        if (!errorChannelId) {
          return;
        }

        errorChannel = guild.channels.cache.get(errorChannelId);
        if (!errorChannel) {
          return;
        }
      }

      const downDuration = this.formatDuration(Date.now() - this.lastActivityTime);
      const alertCount = this.getAlertCount();
      const period = this.getCurrentPeriod();
      const threshold = this.getActivityThreshold();

      // Adapter le message selon la période
      const isNightTime = period === 'Nuit';
      const title = isNightTime ? '🌙 INACTIVITÉ NOCTURNE DÉTECTÉE' : '🚨 SYSTÈME DE MIRROR DOWN';
      const color = isNightTime ? 0xFFA500 : 0xFF0000; // Orange la nuit, Rouge le jour
      const description = isNightTime
        ? `Inactivité prolongée détectée (normal la nuit)`
        : `Le système de mirror ne fonctionne plus !`;

      const embed = {
        color: color,
        title: title,
        description: description,
        fields: [
          {
            name: '⏰ Dernière activité',
            value: `Il y a ${downDuration}`,
            inline: true
          },
          {
            name: '📅 Période',
            value: period,
            inline: true
          },
          {
            name: '🔄 Alertes envoyées',
            value: `${alertCount}`,
            inline: true
          },
          {
            name: '⚙️ Seuil configuré',
            value: this.formatDuration(threshold),
            inline: true
          },
          {
            name: '🔍 Actions à faire',
            value: isNightTime
              ? `• Vérification automatique\n• Activité normale attendue après 7h\n• Intervention manuelle si urgent`
              : `• Vérifier les logs Coolify du bot\n• Redémarrer le bot si nécessaire\n• Vérifier la connexion MongoDB`,
            inline: false
          }
        ],
        footer: {
          text: `Prochaine alerte dans 45 minutes si non résolu`
        },
        timestamp: new Date().toISOString()
      };

      // Ne pas faire @everyone la nuit pour éviter de réveiller les gens
      const mention = isNightTime ? '' : '@everyone';

      await errorChannel.send({
        content: mention,
        embeds: [embed]
      });

      
    } catch (error) {
      console.error(`❌ Erreur envoi alerte pour ${guild.name}:`, error);
    }
  }

  /**
   * Envoie la notification de récupération
   */
  async sendRecoveryNotification(downDuration) {
    try {
      const guilds = this.client.guilds.cache;
      
      for (const [guildId, guild] of guilds) {
        await this.sendRecoveryToGuild(guild, downDuration);
      }
      
    } catch (error) {
      console.error('❌ Erreur envoi notification récupération:', error);
    }
  }

  /**
   * Envoie la notification de récupération à un serveur
   */
  async sendRecoveryToGuild(guild, downDuration) {
    try {
      // Import à la demande pour éviter les problèmes d'initialisation
      const { getNotificationChannelId } = require('../config/notificationChannels');
      
      let errorChannelId = getNotificationChannelId(guild.id, 'ERROR_ALERTS');
      let errorChannel = null;
      
      // CAS SPÉCIAL : Auto-détection du salon "error" dans la catégorie Maintenance
      if (errorChannelId === 'auto-detect-error') {
        // Chercher le salon "error" dans la catégorie Maintenance
        const maintenanceCategory = guild.channels.cache.find(ch => 
          ch.type === 4 && ch.name.toLowerCase().includes('maintenance')
        );
        
        if (maintenanceCategory) {
          errorChannel = guild.channels.cache.find(ch => 
            ch.name === 'error' && ch.parent?.id === maintenanceCategory.id
          );
        }
        
        if (!errorChannel) return; // Pas de salon error trouvé
      } else {
        if (!errorChannelId) return;

        errorChannel = guild.channels.cache.get(errorChannelId);
        if (!errorChannel) return;
      }

      const embed = {
        color: 0x00FF00, // Vert
        title: '✅ SYSTÈME RÉCUPÉRÉ',
        description: `Le système de mirror fonctionne à nouveau !`,
        fields: [
          {
            name: '⏱️ Durée d\'arrêt',
            value: downDuration,
            inline: true
          },
          {
            name: '🔄 Statut',
            value: 'Opérationnel',
            inline: true
          }
        ],
        timestamp: new Date().toISOString()
      };

      await errorChannel.send({
        embeds: [embed]
      });

      
    } catch (error) {
      console.error(`❌ Erreur envoi récupération pour ${guild.name}:`, error);
    }
  }

  /**
   * Calcule le nombre d'alertes envoyées
   */
  getAlertCount() {
    if (!this.isSystemDown || !this.downSince) return 0;
    
    const timeSinceDown = Date.now() - this.downSince;
    return Math.floor(timeSinceDown / this.ALERT_INTERVAL) + 1;
  }

  /**
   * Formate une durée en texte lisible
   */
  formatDuration(ms) {
    const minutes = Math.floor(ms / (1000 * 60));
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days}j ${hours % 24}h ${minutes % 60}min`;
    } else if (hours > 0) {
      return `${hours}h ${minutes % 60}min`;
    } else {
      return `${minutes}min`;
    }
  }

  /**
   * Obtient la période actuelle (Jour/Nuit/Week-end)
   */
  getCurrentPeriod() {
    const now = new Date();
    // Utiliser l'heure locale (Europe/Paris approximé)
    const hours = now.getHours();
    const dayOfWeek = now.getDay(); // 0 = Dimanche, 6 = Samedi

    // Vérifier si c'est la nuit
    if (hours >= this.NIGHT_START_HOUR || hours < this.NIGHT_END_HOUR) {
      return 'Nuit';
    }

    // Vérifier si c'est le week-end
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      return 'Week-end';
    }

    return 'Jour';
  }

  /**
   * Obtient le seuil d'activité selon la période actuelle
   */
  getActivityThreshold() {
    const period = this.getCurrentPeriod();

    switch (period) {
      case 'Nuit':
        return this.NIGHT_THRESHOLD;
      case 'Week-end':
        return this.WEEKEND_THRESHOLD;
      default:
        return this.DAY_THRESHOLD;
    }
  }

  /**
   * Obtient les statistiques du monitoring
   */
  getStats() {
    const period = this.getCurrentPeriod();
    const threshold = this.getActivityThreshold();

    return {
      isMonitoring: !!this.monitoringTimer,
      isSystemDown: this.isSystemDown,
      lastActivityTime: this.lastActivityTime,
      downSince: this.downSince,
      timeSinceLastActivity: Date.now() - this.lastActivityTime,
      alertCount: this.getAlertCount(),
      currentPeriod: period,
      currentThreshold: threshold,
      currentThresholdFormatted: this.formatDuration(threshold)
    };
  }

  /**
   * Force une vérification manuelle
   */
  async forceCheck() {
    const timeSinceLastActivity = Date.now() - this.lastActivityTime;
    const threshold = this.getActivityThreshold();
    const period = this.getCurrentPeriod();

    if (timeSinceLastActivity >= threshold) {
      await this.handleInactivityDetected();
    } else {
      const remainingTime = threshold - timeSinceLastActivity;
    }
  }
}

module.exports = ActivityMonitorService; 