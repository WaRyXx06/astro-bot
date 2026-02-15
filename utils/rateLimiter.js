class RateLimiter {
  constructor() {
    this.requests = new Map(); // Map<channelId, Array<timestamp>>
    this.globalRequests = [];
    this.maxRequestsPerChannel = 5; // Par minute
    this.maxGlobalRequests = 50; // Par seconde
    this.channelWindow = 60 * 1000; // 1 minute
    this.globalWindow = 1000; // 1 seconde
  }

  canMakeRequest(channelId = null) {
    const now = Date.now();
    
    // Vérifier les limites globales
    this.globalRequests = this.globalRequests.filter(timestamp => 
      now - timestamp < this.globalWindow
    );
    
    if (this.globalRequests.length >= this.maxGlobalRequests) {
      return false;
    }

    // Si un channelId est fourni, vérifier les limites par canal
    if (channelId) {
      const channelRequests = this.requests.get(channelId) || [];
      const recentRequests = channelRequests.filter(timestamp => 
        now - timestamp < this.channelWindow
      );
      
      if (recentRequests.length >= this.maxRequestsPerChannel) {
        return false;
      }
      
      this.requests.set(channelId, recentRequests);
    }

    return true;
  }

  recordRequest(channelId = null) {
    const now = Date.now();
    
    // Enregistrer la requête globale
    this.globalRequests.push(now);
    
    // Enregistrer la requête par canal si applicable
    if (channelId) {
      const channelRequests = this.requests.get(channelId) || [];
      channelRequests.push(now);
      this.requests.set(channelId, channelRequests);
    }
  }

  getDelayUntilNextRequest(channelId = null) {
    const now = Date.now();
    
    // Vérifier le délai global
    const globalDelay = this.getGlobalDelay(now);
    
    // Vérifier le délai par canal
    let channelDelay = 0;
    if (channelId) {
      channelDelay = this.getChannelDelay(channelId, now);
    }
    
    return Math.max(globalDelay, channelDelay);
  }

  getGlobalDelay(now) {
    if (this.globalRequests.length < this.maxGlobalRequests) {
      return 0;
    }
    
    const oldestRequest = Math.min(...this.globalRequests);
    return Math.max(0, this.globalWindow - (now - oldestRequest));
  }

  getChannelDelay(channelId, now) {
    const channelRequests = this.requests.get(channelId) || [];
    const recentRequests = channelRequests.filter(timestamp => 
      now - timestamp < this.channelWindow
    );
    
    if (recentRequests.length < this.maxRequestsPerChannel) {
      return 0;
    }
    
    const oldestRequest = Math.min(...recentRequests);
    return Math.max(0, this.channelWindow - (now - oldestRequest));
  }

  async waitForRequest(channelId = null) {
    const delay = this.getDelayUntilNextRequest(channelId);
    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // Nettoyage périodique des anciens enregistrements
  cleanup() {
    const now = Date.now();
    
    // Nettoyer les requêtes globales
    this.globalRequests = this.globalRequests.filter(timestamp => 
      now - timestamp < this.globalWindow
    );
    
    // Nettoyer les requêtes par canal
    for (const [channelId, requests] of this.requests.entries()) {
      const recentRequests = requests.filter(timestamp => 
        now - timestamp < this.channelWindow
      );
      
      if (recentRequests.length === 0) {
        this.requests.delete(channelId);
      } else {
        this.requests.set(channelId, recentRequests);
      }
    }
  }
}

// Instance globale du rate limiter
const rateLimiter = new RateLimiter();

// Nettoyage automatique toutes les minutes
setInterval(() => {
  rateLimiter.cleanup();
}, 60 * 1000);

module.exports = rateLimiter; 