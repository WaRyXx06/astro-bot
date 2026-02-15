const { ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const crypto = require('crypto');

/**
 * Utilitaires pour détecter et gérer les liens ProxAuth dans les messages
 * Le bypass automatique utilise les cookies Discord injectés depuis le navigateur de l'admin
 */
class ProxAuthDetector {
  /**
   * Regex pour détecter les URLs ProxAuth
   * Capture: https://proxauth.fr/links/[id]
   */
  static PROXAUTH_REGEX = /https?:\/\/proxauth\.fr\/links\/([\w-]+)/gi;

  /**
   * Détecte les URLs ProxAuth dans un texte
   * @param {string} text - Texte à analyser
   * @returns {Array<string>} Liste des URLs ProxAuth trouvées
   */
  static detectProxAuthUrls(text) {
    if (!text || typeof text !== 'string') {
      return [];
    }

    const matches = [];
    let match;

    // Reset regex pour éviter les problèmes de state
    const regex = new RegExp(this.PROXAUTH_REGEX.source, this.PROXAUTH_REGEX.flags);

    while ((match = regex.exec(text)) !== null) {
      matches.push(match[0]);
    }

    return matches;
  }

  /**
   * Masque les URLs ProxAuth dans un texte et retourne le texte modifié
   * @param {string} text - Texte original
   * @returns {Object} {maskedText: string, urls: Array<string>}
   */
  static maskProxAuthUrls(text) {
    if (!text || typeof text !== 'string') {
      return { maskedText: text, urls: [] };
    }

    const urls = this.detectProxAuthUrls(text);

    if (urls.length === 0) {
      return { maskedText: text, urls: [] };
    }

    // Remplacer chaque URL par un placeholder
    let maskedText = text;
    urls.forEach(url => {
      maskedText = maskedText.replace(url, '[🔓 Lien protégé - Cliquer sur le bouton]');
    });

    return { maskedText, urls };
  }

  /**
   * Génère un ID de bouton unique basé sur l'URL
   * Discord customId limité à 100 caractères, donc on utilise un hash
   * @param {string} url - URL ProxAuth
   * @returns {string} Custom ID pour le bouton
   */
  static generateButtonId(url) {
    // MD5 hash pour avoir un ID court et unique
    const hash = crypto.createHash('md5').update(url).digest('hex').substring(0, 16);
    return `proxauth_unlock_${hash}`;
  }

  /**
   * Crée un bouton Discord pour débloquer un lien ProxAuth
   * @param {string} proxauthUrl - URL ProxAuth à débloquer
   * @returns {ButtonBuilder} Bouton Discord configuré
   */
  static createUnlockButton(proxauthUrl) {
    const buttonId = this.generateButtonId(proxauthUrl);

    return new ButtonBuilder()
      .setCustomId(buttonId)
      .setLabel('Débloquer le lien')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🔓');
  }

  /**
   * Crée un ActionRow avec le bouton de déblocage
   * @param {string} proxauthUrl - URL ProxAuth
   * @returns {ActionRowBuilder} Row Discord avec le bouton
   */
  static createUnlockButtonRow(proxauthUrl) {
    const button = this.createUnlockButton(proxauthUrl);
    return new ActionRowBuilder().addComponents(button);
  }
}

module.exports = ProxAuthDetector;
