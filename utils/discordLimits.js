// Configuration centralisée des limites Discord
// Source: https://discord.com/developers/docs/resources/webhook#execute-webhook

const DISCORD_LIMITS = {
  // Limites de contenu texte
  MESSAGE_CONTENT_MAX: 2000,           // Caractères max dans content
  EMBED_TOTAL_MAX: 6000,               // Caractères max par embed (tous les champs)
  EMBED_TITLE_MAX: 256,                // Caractères max pour le titre d'un embed
  EMBED_DESCRIPTION_MAX: 4096,         // Caractères max pour la description d'un embed
  EMBED_FIELD_NAME_MAX: 256,           // Caractères max pour le nom d'un field
  EMBED_FIELD_VALUE_MAX: 1024,         // Caractères max pour la valeur d'un field
  EMBED_FOOTER_MAX: 2048,              // Caractères max pour le footer d'un embed
  EMBED_AUTHOR_NAME_MAX: 256,          // Caractères max pour le nom de l'auteur
  
  // Limites de quantité
  EMBEDS_PER_MESSAGE: 10,              // Nombre max d'embeds par message
  EMBED_FIELDS_MAX: 25,                // Nombre max de fields par embed
  FILES_PER_MESSAGE: 10,               // Nombre max de fichiers par message
  
  // Limites de taille (en bytes)
  WEBHOOK_TOTAL_SIZE: 8 * 1024 * 1024,           // 8MB total pour un webhook
  WEBHOOK_SAFE_SIZE: 7.5 * 1024 * 1024,          // 7.5MB limite de sécurité
  FILE_SIZE_MAX: 8 * 1024 * 1024,                // 8MB max par fichier (limite API Discord)
  FILE_SIZE_SAFE: 7 * 1024 * 1024,               // 7MB limite de sécurité par fichier
  
  // Limites spéciales pour éviter les erreurs
  FILES_PER_WEBHOOK_SAFE: 3,           // Nombre safe de fichiers par webhook
  TOTAL_FILES_SIZE_SAFE: 6 * 1024 * 1024, // 6MB total safe pour tous les fichiers
};

// Fonction pour calculer la taille d'un payload webhook
function calculateWebhookPayloadSize(webhookPayload) {
  let totalSize = 0;
  
  // Taille du contenu texte (approximation UTF-8)
  if (webhookPayload.content) {
    totalSize += Buffer.byteLength(webhookPayload.content, 'utf8');
  }
  
  // Taille du username et avatar URL
  if (webhookPayload.username) {
    totalSize += Buffer.byteLength(webhookPayload.username, 'utf8');
  }
  if (webhookPayload.avatarURL) {
    totalSize += Buffer.byteLength(webhookPayload.avatarURL, 'utf8');
  }
  
  // Taille des embeds (sérialisés en JSON)
  if (webhookPayload.embeds && webhookPayload.embeds.length > 0) {
    const embedsJson = JSON.stringify(webhookPayload.embeds);
    totalSize += Buffer.byteLength(embedsJson, 'utf8');
  }
  
  // Taille des fichiers attachés
  if (webhookPayload.files && webhookPayload.files.length > 0) {
    for (const file of webhookPayload.files) {
      if (file.attachment) {
        // Si c'est un Buffer ou des données binaires
        if (Buffer.isBuffer(file.attachment)) {
          totalSize += file.attachment.length;
        } else if (typeof file.attachment === 'string') {
          // Si c'est une string (base64 ou autre)
          totalSize += Buffer.byteLength(file.attachment, 'utf8');
        }
      }
      // Ajouter la taille du nom de fichier
      if (file.name) {
        totalSize += Buffer.byteLength(file.name, 'utf8');
      }
    }
  }
  
  // Ajouter un peu de marge pour les métadonnées JSON (~1KB)
  totalSize += 1024;
  
  return totalSize;
}

// Fonction pour vérifier si un embed dépasse les limites
function isEmbedValid(embed) {
  let totalChars = 0;
  
  if (embed.title) totalChars += embed.title.length;
  if (embed.description) totalChars += embed.description.length;
  if (embed.footer?.text) totalChars += embed.footer.text.length;
  if (embed.author?.name) totalChars += embed.author.name.length;
  
  if (embed.fields && Array.isArray(embed.fields)) {
    for (const field of embed.fields) {
      if (field.name) totalChars += field.name.length;
      if (field.value) totalChars += field.value.length;
    }
  }
  
  return totalChars <= DISCORD_LIMITS.EMBED_TOTAL_MAX;
}

// Fonction pour splitter les fichiers en groupes respectant les limites
function splitFilesIntoGroups(files, maxSizePerGroup = DISCORD_LIMITS.TOTAL_FILES_SIZE_SAFE, maxFilesPerGroup = DISCORD_LIMITS.FILES_PER_WEBHOOK_SAFE) {
  const groups = [];
  const oversizedFiles = [];
  let currentGroup = [];
  let currentGroupSize = 0;
  
  for (const file of files) {
    const fileSize = Buffer.isBuffer(file.attachment) 
      ? file.attachment.length 
      : Buffer.byteLength(file.attachment || '', 'utf8');
    
    // Si le fichier seul dépasse la limite de sécurité, l'ajouter aux fichiers oversized
    if (fileSize > DISCORD_LIMITS.FILE_SIZE_SAFE) {
      console.warn(`⚠️ Fichier ${file.name} trop volumineux (${Math.round(fileSize / 1024 / 1024)}MB), sera envoyé comme lien`);
      oversizedFiles.push(file);
      continue;
    }
    
    // Si ajouter ce fichier dépasse la limite ou le nombre max, créer un nouveau groupe
    if (currentGroupSize + fileSize > maxSizePerGroup || currentGroup.length >= maxFilesPerGroup) {
      if (currentGroup.length > 0) {
        groups.push([...currentGroup]);
        currentGroup = [];
        currentGroupSize = 0;
      }
    }
    
    currentGroup.push(file);
    currentGroupSize += fileSize;
  }
  
  // Ajouter le dernier groupe s'il n'est pas vide
  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }
  
  // Retourner les groupes ET les fichiers oversized
  return { groups, oversizedFiles };
}

// Fonction pour tronquer le contenu si nécessaire
function truncateContent(content, maxLength = DISCORD_LIMITS.MESSAGE_CONTENT_MAX) {
  if (!content || content.length <= maxLength) {
    return content;
  }
  
  const truncateMessage = '...\n*[Message tronqué - trop volumineux]*';
  const availableLength = maxLength - truncateMessage.length;
  
  return content.substring(0, availableLength) + truncateMessage;
}

// Fonction pour valider et ajuster un payload webhook complet
function validateAndAdjustWebhookPayload(webhookPayload) {
  const adjusted = { ...webhookPayload };
  
  // Ajuster le contenu texte
  if (adjusted.content) {
    adjusted.content = truncateContent(adjusted.content);
  }
  
  // Valider les embeds
  if (adjusted.embeds && adjusted.embeds.length > 0) {
    // Limiter le nombre d'embeds
    if (adjusted.embeds.length > DISCORD_LIMITS.EMBEDS_PER_MESSAGE) {
      console.warn(`⚠️ Trop d'embeds (${adjusted.embeds.length}), limité à ${DISCORD_LIMITS.EMBEDS_PER_MESSAGE}`);
      adjusted.embeds = adjusted.embeds.slice(0, DISCORD_LIMITS.EMBEDS_PER_MESSAGE);
    }
    
    // Filtrer les embeds invalides
    adjusted.embeds = adjusted.embeds.filter(embed => {
      if (!isEmbedValid(embed)) {
        console.warn('⚠️ Embed trop volumineux, sera ignoré');
        return false;
      }
      return true;
    });
  }
  
  return adjusted;
}

module.exports = {
  DISCORD_LIMITS,
  calculateWebhookPayloadSize,
  isEmbedValid,
  splitFilesIntoGroups,
  truncateContent,
  validateAndAdjustWebhookPayload
};