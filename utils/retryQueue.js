const { createLogger } = require('../config/logConfig');

/**
 * Classe pour gérer une queue de retry avec priorités et backoff exponentiel
 */
class RetryQueue {
  constructor() {
    this.queue = new Map(); // taskId -> { task, priority, attempts, maxAttempts, delays, onSuccess, onFailure }
    this.processing = new Set(); // IDs en cours de traitement
    this.logger = createLogger('RetryQueue');
    this.metrics = {
      totalTasks: 0,
      successfulTasks: 0,
      failedTasks: 0,
      retriedTasks: 0
    };
  }

  /**
   * Ajoute une tâche à la queue
   * @param {string} taskId - Identifiant unique de la tâche
   * @param {Function} task - Fonction async à exécuter
   * @param {Object} options - Options de retry
   * @returns {Promise} - Promesse qui se résout quand la tâche est terminée
   */
  async add(taskId, task, options = {}) {
    const {
      priority = 0, // Plus haute priorité = exécution plus tôt
      maxAttempts = 3,
      delays = [1000, 3000, 10000], // Délais entre les tentatives
      onSuccess = null,
      onFailure = null,
      immediate = true
    } = options;

    // Éviter les doublons
    if (this.queue.has(taskId) || this.processing.has(taskId)) {
      this.logger.info('queue', `Tâche ${taskId} déjà dans la queue ou en traitement`);
      return this.queue.get(taskId)?.promise;
    }

    // Créer une promesse pour tracker l'achèvement
    let resolveTask, rejectTask;
    const promise = new Promise((resolve, reject) => {
      resolveTask = resolve;
      rejectTask = reject;
    });

    const taskData = {
      task,
      priority,
      attempts: 0,
      maxAttempts,
      delays,
      onSuccess,
      onFailure,
      addedAt: Date.now(),
      promise,
      resolve: resolveTask,
      reject: rejectTask
    };

    this.queue.set(taskId, taskData);
    this.metrics.totalTasks++;

    this.logger.info('queue', `📥 Tâche ajoutée: ${taskId} (priorité: ${priority})`);

    if (immediate) {
      this.processTask(taskId);
    }

    return promise;
  }

  /**
   * Traite une tâche avec retry automatique
   */
  async processTask(taskId) {
    if (!this.queue.has(taskId)) return;
    if (this.processing.has(taskId)) return;

    const taskData = this.queue.get(taskId);
    this.processing.add(taskId);

    taskData.attempts++;

    try {
      this.logger.info('queue', `🔄 Tentative ${taskData.attempts}/${taskData.maxAttempts} pour ${taskId}`);

      const result = await taskData.task();

      // Succès
      this.handleSuccess(taskId, result);

    } catch (error) {
      this.logger.error('queue', `❌ Échec tentative ${taskData.attempts} pour ${taskId}: ${error.message}`);

      if (taskData.attempts < taskData.maxAttempts) {
        // Programmer la prochaine tentative
        const delay = taskData.delays[taskData.attempts - 1] || taskData.delays[taskData.delays.length - 1];
        this.metrics.retriedTasks++;

        this.logger.info('queue', `⏱️ Nouvelle tentative dans ${delay}ms pour ${taskId}`);

        setTimeout(() => {
          this.processing.delete(taskId);
          this.processTask(taskId);
        }, delay);

      } else {
        // Échec définitif
        this.handleFailure(taskId, error);
      }
    }
  }

  /**
   * Gère le succès d'une tâche
   */
  handleSuccess(taskId, result) {
    const taskData = this.queue.get(taskId);
    if (!taskData) return;

    this.metrics.successfulTasks++;
    const duration = Date.now() - taskData.addedAt;

    this.logger.info('queue',
      `✅ Tâche ${taskId} réussie après ${taskData.attempts} tentative(s) en ${duration}ms`
    );

    // Callback de succès
    if (taskData.onSuccess) {
      try {
        taskData.onSuccess(result, { attempts: taskData.attempts, duration });
      } catch (error) {
        this.logger.error('queue', `Erreur dans onSuccess pour ${taskId}: ${error.message}`);
      }
    }

    // Résoudre la promesse
    taskData.resolve(result);

    // Nettoyer
    this.queue.delete(taskId);
    this.processing.delete(taskId);
  }

  /**
   * Gère l'échec définitif d'une tâche
   */
  handleFailure(taskId, error) {
    const taskData = this.queue.get(taskId);
    if (!taskData) return;

    this.metrics.failedTasks++;
    const duration = Date.now() - taskData.addedAt;

    this.logger.error('queue',
      `❌ Tâche ${taskId} échouée après ${taskData.attempts} tentatives en ${duration}ms`
    );

    // Callback d'échec
    if (taskData.onFailure) {
      try {
        taskData.onFailure(error, { attempts: taskData.attempts, duration });
      } catch (err) {
        this.logger.error('queue', `Erreur dans onFailure pour ${taskId}: ${err.message}`);
      }
    }

    // Rejeter la promesse
    taskData.reject(error);

    // Nettoyer
    this.queue.delete(taskId);
    this.processing.delete(taskId);
  }

  /**
   * Traite toutes les tâches en attente
   */
  async processAll() {
    // Trier par priorité (plus haute en premier)
    const sortedTasks = Array.from(this.queue.entries())
      .filter(([id]) => !this.processing.has(id))
      .sort((a, b) => b[1].priority - a[1].priority);

    for (const [taskId] of sortedTasks) {
      await this.processTask(taskId);
    }
  }

  /**
   * Annule une tâche
   */
  cancel(taskId) {
    if (this.queue.has(taskId)) {
      const taskData = this.queue.get(taskId);
      taskData.reject(new Error('Tâche annulée'));
      this.queue.delete(taskId);
      this.processing.delete(taskId);
      this.logger.info('queue', `🚫 Tâche ${taskId} annulée`);
      return true;
    }
    return false;
  }

  /**
   * Annule toutes les tâches
   */
  cancelAll() {
    for (const [taskId] of this.queue) {
      this.cancel(taskId);
    }
    this.logger.info('queue', `🚫 Toutes les tâches annulées (${this.queue.size} tâches)`);
  }

  /**
   * Obtient le statut de la queue
   */
  getStatus() {
    return {
      queueSize: this.queue.size,
      processingCount: this.processing.size,
      metrics: this.metrics,
      tasks: Array.from(this.queue.entries()).map(([id, data]) => ({
        id,
        priority: data.priority,
        attempts: data.attempts,
        maxAttempts: data.maxAttempts,
        age: Date.now() - data.addedAt
      }))
    };
  }

  /**
   * Nettoie les tâches expirées
   */
  cleanup(maxAge = 3600000) { // 1 heure par défaut
    const now = Date.now();
    let cleaned = 0;

    for (const [taskId, data] of this.queue) {
      if (now - data.addedAt > maxAge && !this.processing.has(taskId)) {
        this.cancel(taskId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.info('queue', `🧹 ${cleaned} tâches expirées nettoyées`);
    }
  }

  /**
   * Réinitialise les métriques
   */
  resetMetrics() {
    this.metrics = {
      totalTasks: 0,
      successfulTasks: 0,
      failedTasks: 0,
      retriedTasks: 0
    };
  }
}

module.exports = RetryQueue;