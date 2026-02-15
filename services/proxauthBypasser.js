const puppeteer = require('puppeteer-core');
const ProxAuthCache = require('../models/ProxAuthCache');

/**
 * Service pour bypasser les liens ProxAuth via Browserless
 * Utilise une connexion WebSocket vers un service Browserless externe
 * MÉTHODE : Injection des cookies Discord exportés depuis le navigateur de l'admin
 */
class ProxAuthBypasser {
  constructor() {
    // Timeout pour le bypass (30 secondes max)
    this.bypassTimeout = 30000;
    // Cache des cookies parsés
    this._parsedCookies = null;
  }

  /**
   * Vérifie si une URL est valide (pas une erreur Chrome, about:blank, etc.)
   * @param {string} url - URL à valider
   * @returns {boolean} true si l'URL est valide
   */
  isValidFinalUrl(url) {
    if (!url || typeof url !== 'string') return false;

    // Doit commencer par http:// ou https://
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return false;
    }

    // URLs d'erreur Chrome/Chromium à rejeter
    const invalidPrefixes = [
      'chrome-error://',
      'chrome://',
      'about:',
      'data:',
      'javascript:',
      'blob:',
      'file://'
    ];

    for (const prefix of invalidPrefixes) {
      if (url.toLowerCase().startsWith(prefix)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Parse les cookies Discord depuis la variable d'environnement
   * Format attendu : JSON array de cookies
   * @returns {Array|null} Array de cookies ou null si non configuré
   */
  getDiscordCookies() {
    if (this._parsedCookies) {
      return this._parsedCookies;
    }

    const cookiesJson = process.env.DISCORD_COOKIES;
    if (!cookiesJson) {
      console.error('❌ ProxAuth: DISCORD_COOKIES non configuré');
      return null;
    }

    try {
      const cookies = JSON.parse(cookiesJson);

      // Normaliser les cookies pour Puppeteer
      this._parsedCookies = cookies.map(cookie => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain || '.discord.com',
        path: cookie.path || '/',
        httpOnly: cookie.httpOnly !== false,
        secure: cookie.secure !== false,
        sameSite: cookie.sameSite || 'Lax'
      }));

      console.log(`🍪 ProxAuth: ${this._parsedCookies.length} cookies Discord chargés`);
      return this._parsedCookies;
    } catch (error) {
      console.error('❌ ProxAuth: Erreur parsing DISCORD_COOKIES:', error.message);
      return null;
    }
  }

  /**
   * Bypass une URL ProxAuth et retourne le lien final
   * Utilise cookies (fingerprinting) + token (authentification)
   * @param {string} proxauthUrl - URL ProxAuth à bypasser
   * @returns {Promise<string|null>} Lien final ou null si échec
   */
  async bypassUrl(proxauthUrl) {
    if (!proxauthUrl || !proxauthUrl.includes('proxauth.fr/links/')) {
      console.error('❌ ProxAuth: URL invalide');
      return null;
    }

    // Vérifier que Browserless est configuré
    if (!process.env.BROWSER_WS_ENDPOINT) {
      console.error('❌ ProxAuth: BROWSER_WS_ENDPOINT non configuré');
      return null;
    }

    // Vérifier que le token est configuré
    const userToken = process.env.USER_TOKEN;
    if (!userToken) {
      console.error('❌ ProxAuth: USER_TOKEN non configuré');
      return null;
    }

    // Les cookies sont optionnels mais recommandés (fingerprinting)
    const cookies = this.getDiscordCookies();

    let browser = null;

    try {
      console.log(`🔓 ProxAuth: Déblocage de ${proxauthUrl}...`);
      console.log(`🌐 ProxAuth: Connexion à Browserless...`);

      // Connexion au service Browserless distant via WebSocket
      browser = await puppeteer.connect({
        browserWSEndpoint: process.env.BROWSER_WS_ENDPOINT
      });

      console.log(`✅ ProxAuth: Connecté à Browserless`);

      const page = await browser.newPage();

      // Configurer timeout
      page.setDefaultTimeout(this.bypassTimeout);

      // ÉTAPE 1 : Injecter les cookies Discord (fingerprinting Cloudflare)
      if (cookies && cookies.length > 0) {
        console.log('🍪 ProxAuth: Injection des cookies Discord...');
        await page.setCookie(...cookies);
        console.log(`✅ ProxAuth: ${cookies.length} cookies injectés`);
      }

      // ÉTAPE 2 : Aller sur la page de login Discord
      console.log('🔓 ProxAuth: Chargement page login Discord...');
      await page.goto('https://discord.com/login', { waitUntil: 'networkidle2' });

      // ÉTAPE 3 : Injecter le token via la technique iframe (contourne les protections Discord)
      console.log('🔑 ProxAuth: Injection du token via iframe...');
      await page.evaluate((token) => {
        // Technique iframe pour contourner les protections localStorage
        const iframe = document.body.appendChild(document.createElement('iframe'));
        iframe.contentWindow.localStorage.token = `"${token}"`;
        iframe.remove();
      }, userToken);

      // Attendre un peu puis recharger pour activer la session
      await new Promise(resolve => setTimeout(resolve, 500));
      console.log('🔄 ProxAuth: Rechargement pour activer la session...');
      await page.reload({ waitUntil: 'networkidle2' });

      // Attendre que Discord charge complètement
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Vérifier qu'on est bien connecté (pas sur la page de login)
      const currentUrl = page.url();
      console.log(`🔍 ProxAuth: URL après login → ${currentUrl}`);

      if (currentUrl.includes('/login')) {
        console.error('❌ ProxAuth: Échec connexion Discord - token invalide ou expiré');
        await page.close();
        return null;
      }
      console.log('✅ ProxAuth: Session Discord active');

      // Variable pour capturer l'URL finale via interception des redirections
      // Permet de récupérer le lien même si le site destination a des erreurs HTTP/2
      let capturedFinalUrl = null;

      // Intercepter les requêtes pour ajouter prompt=none à Discord OAuth2
      // Cela permet de skip la page d'autorisation si l'app a déjà été autorisée
      await page.setRequestInterception(true);
      page.on('request', request => {
        const url = request.url();
        if (url.includes('discord.com/oauth2/authorize') && !url.includes('prompt=')) {
          const newUrl = url + '&prompt=none';
          console.log('🔧 ProxAuth: Ajout prompt=none à l\'URL OAuth2');
          request.continue({ url: newUrl });
        } else {
          request.continue();
        }
      });

      // Intercepter les réponses pour capturer l'URL finale de redirection ProxAuth
      // CRUCIAL: Capture le lien AVANT que Chrome tente de charger le site destination
      page.on('response', response => {
        const url = response.url();
        const status = response.status();

        // Capturer les redirections 3xx depuis ProxAuth vers le lien final
        if (status >= 300 && status < 400 && url.includes('proxauth.fr/links/')) {
          const headers = response.headers();
          const location = headers['location'];
          if (location && !location.includes('proxauth.fr') && !location.includes('discord.com')) {
            capturedFinalUrl = location;
            console.log(`🎯 ProxAuth: URL finale capturée via redirect → ${location}`);
          }
        }
      });

      // Étape 4: Naviguer vers ProxAuth
      console.log('🔓 ProxAuth: Navigation vers ProxAuth...');
      await page.goto(proxauthUrl, { waitUntil: 'networkidle2' });

      // Étape 5: Attendre la redirection OAuth2 Discord (avec prompt=none, devrait être instantané)
      console.log('⏳ ProxAuth: Attente redirection OAuth2 (prompt=none)...');

      // Attendre jusqu'à 10 secondes que l'URL change (redirection auto si déjà autorisé)
      let needsManualAuth = false;
      try {
        await page.waitForFunction(
          () => !window.location.href.includes('discord.com/oauth2/authorize') &&
                !window.location.href.includes('proxauth.fr/links/'),
          { timeout: 10000 }
        );
        console.log('✅ ProxAuth: Redirection OAuth2 automatique réussie');
      } catch (waitError) {
        // Timeout = on est probablement sur la page d'autorisation
        const currentAuthUrl = page.url();
        if (currentAuthUrl.includes('oauth2/authorize')) {
          console.log('⚠️ ProxAuth: Page d\'autorisation détectée, tentative de clic auto...');
          needsManualAuth = true;
        }
      }

      // Si on doit cliquer sur "Authorize"
      if (needsManualAuth) {
        try {
          // Attendre que la page charge complètement
          await new Promise(resolve => setTimeout(resolve, 1000));

          // ========================================
          // ÉTAPE 1: SCROLLER LA LISTE DES PERMISSIONS
          // Discord exige de scroller avant de montrer "Autoriser"
          // ========================================
          console.log('📜 ProxAuth: Scroll des permissions Discord...');

          // Scroller plusieurs fois pour s'assurer d'atteindre le bas (optimisé: 3x au lieu de 5x)
          for (let scrollAttempt = 0; scrollAttempt < 3; scrollAttempt++) {
            await page.evaluate(() => {
              // Chercher tous les containers scrollables possibles
              const scrollSelectors = [
                '[class*="scroller"]',
                '[class*="scrollerBase"]',
                '[class*="content"]',
                '[class*="permissions"]',
                '[class*="oauthPermissions"]',
                '[class*="wrapper"]',
                'div[style*="overflow"]'
              ];

              for (const selector of scrollSelectors) {
                const containers = document.querySelectorAll(selector);
                containers.forEach(container => {
                  if (container.scrollHeight > container.clientHeight) {
                    container.scrollTop = container.scrollHeight;
                  }
                });
              }

              // Fallback: scroller window
              window.scrollTo(0, document.body.scrollHeight);
            });

            // Pause entre les scrolls (optimisé: 300ms au lieu de 500ms)
            await new Promise(resolve => setTimeout(resolve, 300));
          }

          console.log('✅ ProxAuth: Scroll terminé');

          // ========================================
          // ÉTAPE 2: ATTENDRE QUE LE BOUTON "AUTORISER" APPARAISSE
          // ========================================
          console.log('⏳ ProxAuth: Attente du bouton Autoriser...');

          try {
            await page.waitForFunction(() => {
              const buttons = Array.from(document.querySelectorAll('button'));
              return buttons.some(btn => {
                const text = btn.innerText.toLowerCase();
                // Le bouton doit contenir "autoriser" ou "authorize" et NE PAS être "continue"
                return (text.includes('autoriser') || text.includes('authorize')) &&
                       !text.includes('continue') && !text.includes('défiler');
              });
            }, { timeout: 8000 });
            console.log('✅ ProxAuth: Bouton Autoriser détecté');
          } catch (waitError) {
            console.log('⚠️ ProxAuth: Timeout attente bouton, tentative de clic quand même...');
          }

          // Petite pause pour s'assurer que le DOM est stable (optimisé: 500ms au lieu de 1000ms)
          await new Promise(resolve => setTimeout(resolve, 500));

          // Debug: Logger l'état actuel des boutons
          const buttonStates = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            return buttons.map(btn => btn.innerText.trim()).filter(t => t.length > 0);
          });
          console.log(`🔍 ProxAuth: Boutons disponibles: ${JSON.stringify(buttonStates)}`);

          // ========================================
          // ÉTAPE 3: CLIQUER SUR "AUTORISER"
          // ========================================

          // Stratégie 1: Chercher bouton "Autoriser" ou "Authorize" (texte exact)
          let clicked = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const authButton = buttons.find(btn => {
              const text = btn.innerText.toLowerCase().trim();
              // Doit contenir autoriser/authorize mais PAS continue/défiler/annuler
              return (text.includes('autoriser') || text.includes('authorize')) &&
                     !text.includes('continue') &&
                     !text.includes('défiler') &&
                     !text.includes('annuler') &&
                     !btn.disabled;
            });
            if (authButton) {
              authButton.click();
              return 'button-autoriser';
            }
            return null;
          });

          // Stratégie 2: Chercher le bouton primary qui N'EST PAS "Annuler"
          if (!clicked) {
            clicked = await page.evaluate(() => {
              const buttons = Array.from(document.querySelectorAll('button'));
              const primaryBtn = buttons.find(btn => {
                const classes = btn.className.toLowerCase();
                const text = btn.innerText.toLowerCase();
                // Bouton primary mais pas "annuler" ou "continue"
                return classes.includes('primary') &&
                       !text.includes('annuler') &&
                       !text.includes('cancel') &&
                       !text.includes('continue') &&
                       !text.includes('défiler') &&
                       !btn.disabled;
              });
              if (primaryBtn) {
                primaryBtn.click();
                return 'button-primary';
              }
              return null;
            });
          }

          // Stratégie 3: Si "Continue à faire défiler" existe encore, cliquer dessus pour forcer
          if (!clicked) {
            clicked = await page.evaluate(() => {
              const buttons = Array.from(document.querySelectorAll('button'));
              const continueBtn = buttons.find(btn => {
                const text = btn.innerText.toLowerCase();
                return text.includes('continue') || text.includes('défiler');
              });
              if (continueBtn && !continueBtn.disabled) {
                continueBtn.click();
                return 'button-continue';
              }
              return null;
            });

            // Si on a cliqué sur Continue, attendre et réessayer Autoriser
            if (clicked === 'button-continue') {
              console.log('🔄 ProxAuth: Cliqué sur Continue, attente du vrai bouton...');
              await new Promise(resolve => setTimeout(resolve, 1000));

              // Réessayer de cliquer sur Autoriser
              const retryClick = await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                const authButton = buttons.find(btn => {
                  const text = btn.innerText.toLowerCase().trim();
                  return (text.includes('autoriser') || text.includes('authorize')) &&
                         !text.includes('continue') && !btn.disabled;
                });
                if (authButton) {
                  authButton.click();
                  return 'button-autoriser-retry';
                }
                return null;
              });
              if (retryClick) clicked = retryClick;
            }
          }

          // Stratégie 4: Dernier recours - cliquer sur n'importe quel bouton submit
          if (!clicked) {
            clicked = await page.evaluate(() => {
              const submitBtn = document.querySelector('button[type="submit"]');
              if (submitBtn && !submitBtn.disabled) {
                submitBtn.click();
                return 'button-submit';
              }
              return null;
            });
          }

          if (clicked) {
            console.log(`✅ ProxAuth: Bouton cliqué (méthode: ${clicked})`);
            // Attendre la redirection après le clic (optimisé: 3s au lieu de 5s)
            await new Promise(resolve => setTimeout(resolve, 3000));
          } else {
            console.error('❌ ProxAuth: Aucun bouton Authorize trouvé après scroll');
            await page.close();
            return null;
          }
        } catch (clickError) {
          console.error('❌ ProxAuth: Erreur lors du clic sur Authorize:', clickError.message);
          await page.close();
          return null;
        }
      }

      // Étape 4: Récupérer l'URL finale avec système de priorités
      const pageUrl = page.url();
      console.log(`🔍 ProxAuth: URL page → ${pageUrl}`);

      // PRIORITÉ 1: URL capturée via interception des redirections (plus fiable)
      // Cette méthode capture le lien AVANT que Chrome essaie de charger le site
      // Évite les erreurs HTTP/2, SSL, timeout du site destination
      if (capturedFinalUrl && this.isValidFinalUrl(capturedFinalUrl)) {
        console.log(`✅ ProxAuth: Lien final (via interception) → ${capturedFinalUrl}`);
        await page.close();
        return capturedFinalUrl;
      }

      // PRIORITÉ 2: URL de la page si valide et pas proxauth
      if (this.isValidFinalUrl(pageUrl) && !pageUrl.includes('proxauth.fr')) {
        console.log(`✅ ProxAuth: Lien final → ${pageUrl}`);
        await page.close();
        return pageUrl;
      }

      // PRIORITÉ 3: Extraire des liens de la page (fallback)
      if (pageUrl.includes('proxauth.fr') && pageUrl !== proxauthUrl) {
        // C'est le callback ProxAuth, extraire le vrai lien de la page
        const extractedLink = await page.evaluate(() => {
          const links = Array.from(document.querySelectorAll('a'));
          const finalLink = links.find(a =>
            !a.href.includes('proxauth.fr') &&
            !a.href.includes('discord.com') &&
            a.href.startsWith('http')
          );
          return finalLink ? finalLink.href : null;
        });

        if (extractedLink && this.isValidFinalUrl(extractedLink)) {
          console.log(`✅ ProxAuth: Lien final extrait → ${extractedLink}`);
          await page.close();
          return extractedLink;
        }
      }

      // Échec - URL invalide détectée (chrome-error://, about:blank, etc.)
      if (!this.isValidFinalUrl(pageUrl)) {
        console.error(`❌ ProxAuth: URL invalide détectée → ${pageUrl}`);
      } else {
        console.warn('⚠️ ProxAuth: Impossible d\'extraire le lien final');
      }
      await page.close();
      return null;

    } catch (error) {
      console.error('❌ ProxAuth: Erreur lors du bypass:', error.message);
      return null;
    } finally {
      // IMPORTANT: Ne pas fermer le browser avec Browserless
      // On ferme seulement la page, pas la connexion
      if (browser) {
        try {
          browser.disconnect();
        } catch (e) {
          // Ignorer erreur de déconnexion
        }
      }
    }
  }

  /**
   * Récupère un lien depuis le cache
   * @param {string} proxauthUrl - URL ProxAuth
   * @returns {Promise<Object|null>} Données du cache ou null
   */
  async getFromCache(proxauthUrl) {
    try {
      const cached = await ProxAuthCache.findOne({
        proxauthUrl,
        finalUrl: { $ne: null } // Seulement si déjà débloqué
      });

      if (cached) {
        console.log(`💾 ProxAuth: Lien trouvé en cache (utilisé ${cached.unlockCount} fois)`);
        return cached;
      }

      return null;
    } catch (error) {
      console.error('❌ ProxAuth: Erreur lecture cache:', error.message);
      return null;
    }
  }

  /**
   * Sauvegarde un lien dans le cache
   * @param {string} proxauthUrl - URL ProxAuth
   * @param {string} finalUrl - Lien final débloqué
   * @param {string} userId - ID Discord de l'utilisateur
   * @param {string} messageId - ID du message Discord
   * @param {string} webhookId - ID du webhook
   * @param {string} webhookToken - Token du webhook
   */
  async saveToCache(proxauthUrl, finalUrl, userId, messageId, webhookId, webhookToken) {
    try {
      await ProxAuthCache.findOneAndUpdate(
        { proxauthUrl },
        {
          finalUrl,
          unlockedBy: userId,
          unlockedAt: new Date(),
          unlockCount: 1,
          messageId,
          webhookId,
          webhookToken
        },
        { upsert: true, new: true }
      );

      console.log(`💾 ProxAuth: Lien sauvegardé en cache`);
    } catch (error) {
      console.error('❌ ProxAuth: Erreur sauvegarde cache:', error.message);
    }
  }
}

// Export singleton
module.exports = new ProxAuthBypasser();
