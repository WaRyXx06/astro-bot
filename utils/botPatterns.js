// 🤖 PATTERNS DE DÉTECTION POUR BOTS POPULAIRES
// Ce fichier contient les patterns pour identifier les commandes slash et réponses des bots Discord

class BotPatterns {
  constructor() {
    // 🎯 Patterns de bots populaires
    this.botPatterns = {
      // Dyno
      'Dyno': {
        id: '161660517914509312',
        commandPatterns: [
          /^🎯 Commande Slash Utilisée/,
          /^⚡ \*Commande slash utilisée\*/,
          /^\/\w+/
        ],
        responsePatterns: [
          { type: 'embed', titlePattern: /^Dyno$/, colorPattern: /^#2C2F33$/ },
          { type: 'content', pattern: /^✅|^❌|^⚠️/ }
        ],
        embedFormats: {
          commandExecuted: {
            title: 'Commande exécutée',
            color: 0x2C2F33
          }
        }
      },

      // MEE6
      'MEE6': {
        id: '159985870458322944',
        commandPatterns: [
          /^\/\w+/
        ],
        responsePatterns: [
          { type: 'embed', authorPattern: /MEE6/, colorPattern: /^#7289DA$/ },
          { type: 'content', pattern: /^✅|^❌|^🎉/ }
        ]
      },

      // Carl-bot
      'Carl-bot': {
        id: '235148962103951360',
        commandPatterns: [
          /^\/\w+/
        ],
        responsePatterns: [
          { type: 'embed', footerPattern: /Carl-bot/, colorPattern: /^#7289DA$/ },
          { type: 'content', pattern: /^✅|^Done!|^Success!/ }
        ]
      },

      // ProBot
      'ProBot': {
        id: '282859044593598464',
        commandPatterns: [
          /^\/\w+/
        ],
        responsePatterns: [
          { type: 'embed', authorPattern: /ProBot/, colorPattern: /^#36393F$/ }
        ]
      },

      // Ticket Tool
      'Ticket Tool': {
        id: '557628352828014614',
        commandPatterns: [
          /^\/ticket/,
          /^\/close/
        ],
        responsePatterns: [
          { type: 'embed', titlePattern: /Ticket|Support/ },
          { type: 'content', pattern: /ticket|created|closed/ }
        ]
      },

      // Generic patterns pour bots inconnus
      'Generic': {
        commandPatterns: [
          /^\/\w+/, // Commande slash standard
          /^!\w+/,  // Commande préfixe classique
          /^\.\w+/, // Autre préfixe commun
        ],
        responsePatterns: [
          { type: 'embed' }, // N'importe quel embed
          { type: 'components' }, // Messages avec boutons/menus
          { type: 'reply' } // Réponses directes
        ]
      }
    };

    // 🔍 Patterns de détection de commandes slash dans le contenu
    this.slashCommandPatterns = [
      /^\/(\w+)\s*(.*)?$/, // Format standard: /command params
      /^\`\/(\w+)\s*(.*)?`/, // Commande dans backticks
      /^Used command: \/(\w+)/, // Format "Used command"
      /^Command: \/(\w+)/, // Format "Command:"
      /^\*\*\/(\w+)\*\*/, // Commande en gras
      /^🎯.*\/(\w+)/, // Avec emoji indicateur
    ];

    // 📊 Patterns d'embeds de commande
    this.commandEmbedPatterns = [
      { field: 'Command', valuePattern: /^\/\w+/ },
      { field: 'Commande', valuePattern: /^\/\w+/ },
      { field: 'Used', valuePattern: /^\/\w+/ },
      { description: /^Command: \/\w+/ },
      { description: /^Slash command: \/\w+/ }
    ];

    // 🎮 Patterns de composants interactifs
    this.interactionComponentPatterns = {
      buttons: {
        indicators: ['customId', 'style', 'label'],
        types: [1, 2, 3, 4, 5] // Button styles
      },
      selectMenus: {
        indicators: ['customId', 'options', 'placeholder'],
        types: [3, 5, 6, 7, 8] // Select menu types
      },
      modals: {
        indicators: ['customId', 'title', 'components'],
        types: [9] // Modal type
      }
    };
  }

  // 🎯 Détecter si un message est une commande slash
  detectSlashCommand(message) {
    // Vérification type Discord natif
    if (message.type === 20 || message.type === 'APPLICATION_COMMAND') {
      return {
        isCommand: true,
        confidence: 'high',
        method: 'discord_type'
      };
    }

    // Vérification par interaction
    if (message.interaction && message.interaction.commandName) {
      return {
        isCommand: true,
        confidence: 'high',
        method: 'interaction_object',
        commandName: message.interaction.commandName
      };
    }

    // Vérification par contenu
    if (message.content) {
      for (const pattern of this.slashCommandPatterns) {
        const match = message.content.match(pattern);
        if (match) {
          return {
            isCommand: true,
            confidence: 'medium',
            method: 'content_pattern',
            commandName: match[1],
            parameters: match[2] || ''
          };
        }
      }
    }

    // Vérification par embeds
    if (message.embeds && message.embeds.length > 0) {
      for (const embed of message.embeds) {
        for (const pattern of this.commandEmbedPatterns) {
          if (this.matchEmbedPattern(embed, pattern)) {
            return {
              isCommand: true,
              confidence: 'medium',
              method: 'embed_pattern'
            };
          }
        }
      }
    }

    // Vérification par applicationId (commande d'application)
    if (message.applicationId && !message.webhookId) {
      return {
        isCommand: true,
        confidence: 'low',
        method: 'application_id'
      };
    }

    return {
      isCommand: false,
      confidence: 'none',
      method: null
    };
  }

  // 🤖 Identifier le bot par son ID ou nom
  identifyBot(author) {
    if (!author.bot) return null;

    // Recherche par ID exact
    for (const [name, config] of Object.entries(this.botPatterns)) {
      if (config.id && config.id === author.id) {
        return { name, config, method: 'id_match' };
      }
    }

    // Recherche par nom
    const authorName = author.username.toLowerCase();
    for (const [name, config] of Object.entries(this.botPatterns)) {
      if (name !== 'Generic' && authorName.includes(name.toLowerCase())) {
        return { name, config, method: 'name_match' };
      }
    }

    // Retour générique pour bots inconnus
    return {
      name: 'Unknown',
      config: this.botPatterns.Generic,
      method: 'generic'
    };
  }

  // 🔗 Détecter si un message de bot est une réponse à une commande
  isBotResponse(message, bot = null) {
    if (!message.author.bot) return false;

    const botInfo = bot || this.identifyBot(message.author);
    if (!botInfo || !botInfo.config.responsePatterns) return false;

    // Vérifier les patterns de réponse
    for (const pattern of botInfo.config.responsePatterns) {
      if (this.matchResponsePattern(message, pattern)) {
        return {
          isResponse: true,
          bot: botInfo.name,
          patternType: pattern.type,
          confidence: botInfo.method === 'id_match' ? 'high' : 'medium'
        };
      }
    }

    // Vérifications génériques
    if (message.reference) {
      return {
        isResponse: true,
        bot: botInfo.name,
        patternType: 'reply',
        confidence: 'medium'
      };
    }

    if (message.components && message.components.length > 0) {
      return {
        isResponse: true,
        bot: botInfo.name,
        patternType: 'interactive',
        confidence: 'low'
      };
    }

    return false;
  }

  // 📋 Extraire les détails d'une commande depuis le contenu
  extractCommandDetails(message) {
    const details = {
      commandName: null,
      parameters: [],
      fullCommand: null,
      source: null
    };

    // Extraction depuis interaction
    if (message.interaction) {
      details.commandName = message.interaction.commandName;
      details.parameters = message.interaction.options || [];
      details.fullCommand = `/${details.commandName}`;
      details.source = 'interaction';
      return details;
    }

    // Extraction depuis le contenu
    if (message.content) {
      for (const pattern of this.slashCommandPatterns) {
        const match = message.content.match(pattern);
        if (match) {
          details.commandName = match[1];
          details.fullCommand = match[0];
          details.source = 'content';
          
          // Parser les paramètres
          if (match[2]) {
            details.parameters = this.parseParameters(match[2]);
          }
          return details;
        }
      }
    }

    // Extraction depuis les embeds
    if (message.embeds && message.embeds.length > 0) {
      for (const embed of message.embeds) {
        const extracted = this.extractFromEmbed(embed);
        if (extracted.commandName) {
          return { ...details, ...extracted, source: 'embed' };
        }
      }
    }

    return details;
  }

  // 🔑 Créer une clé composite pour l'association
  createCompositeKey(message, windowMs = 5000) {
    const timestamp = message.createdTimestamp || Date.now();
    const window = Math.floor(timestamp / windowMs) * windowMs;
    
    return {
      primary: `${message.channel.id}-${message.author.id}-${window}`,
      secondary: `${message.channel.id}-${window}`,
      timestamp: timestamp,
      window: window,
      channelId: message.channel.id,
      authorId: message.author.id
    };
  }

  // 🔍 Vérifier si deux messages sont liés temporellement
  areMessagesRelated(command, response, maxDelayMs = 5000) {
    if (!command || !response) return false;
    
    // Même canal requis
    if (command.channel.id !== response.channel.id) return false;
    
    // Vérifier la fenêtre temporelle
    const timeDiff = Math.abs(response.createdTimestamp - command.createdTimestamp);
    if (timeDiff > maxDelayMs) return false;
    
    // Vérifier si la réponse mentionne l'auteur de la commande
    if (response.content && response.content.includes(`<@${command.author.id}>`)) {
      return { related: true, confidence: 'high', reason: 'user_mention' };
    }
    
    // Vérifier si c'est une réponse directe
    if (response.reference && response.reference.messageId === command.id) {
      return { related: true, confidence: 'high', reason: 'direct_reply' };
    }
    
    // Vérifier l'interaction ID
    if (command.interaction && response.interaction && 
        command.interaction.id === response.interaction.id) {
      return { related: true, confidence: 'high', reason: 'same_interaction' };
    }
    
    // Association par proximité temporelle seulement
    return { related: true, confidence: 'low', reason: 'temporal_proximity' };
  }

  // === MÉTHODES UTILITAIRES ===

  matchEmbedPattern(embed, pattern) {
    if (pattern.field && embed.fields) {
      return embed.fields.some(f => 
        f.name === pattern.field && 
        pattern.valuePattern.test(f.value)
      );
    }
    
    if (pattern.description && embed.description) {
      return pattern.description.test(embed.description);
    }
    
    return false;
  }

  matchResponsePattern(message, pattern) {
    switch (pattern.type) {
      case 'embed':
        if (!message.embeds || message.embeds.length === 0) return false;
        const embed = message.embeds[0];
        
        if (pattern.titlePattern && embed.title) {
          return pattern.titlePattern.test(embed.title);
        }
        if (pattern.authorPattern && embed.author) {
          return pattern.authorPattern.test(embed.author.name);
        }
        if (pattern.footerPattern && embed.footer) {
          return pattern.footerPattern.test(embed.footer.text);
        }
        return !pattern.titlePattern && !pattern.authorPattern && !pattern.footerPattern;
        
      case 'content':
        return pattern.pattern && message.content && 
               pattern.pattern.test(message.content);
        
      case 'components':
        return message.components && message.components.length > 0;
        
      case 'reply':
        return !!message.reference;
        
      default:
        return false;
    }
  }

  parseParameters(paramString) {
    if (!paramString) return [];
    
    const params = [];
    const parts = paramString.trim().split(/\s+/);
    
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].includes(':')) {
        const [name, ...valueParts] = parts[i].split(':');
        params.push({
          name: name,
          value: valueParts.join(':'),
          type: 'named'
        });
      } else {
        params.push({
          name: `param${params.length + 1}`,
          value: parts[i],
          type: 'positional'
        });
      }
    }
    
    return params;
  }

  extractFromEmbed(embed) {
    const details = {};
    
    // Chercher dans les champs
    if (embed.fields) {
      for (const field of embed.fields) {
        if (/command/i.test(field.name)) {
          const match = field.value.match(/^\/(\w+)/);
          if (match) {
            details.commandName = match[1];
            details.fullCommand = field.value;
          }
        }
      }
    }
    
    // Chercher dans la description
    if (embed.description) {
      const match = embed.description.match(/\/(\w+)/);
      if (match) {
        details.commandName = details.commandName || match[1];
        details.fullCommand = details.fullCommand || match[0];
      }
    }
    
    return details;
  }
}

module.exports = new BotPatterns();