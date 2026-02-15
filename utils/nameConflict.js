const resolveChannelNameConflict = async (guild, baseName) => {
  let finalName = baseName;
  let counter = 1;
  
  // Vérifier si le nom de base est disponible
  while (guild.channels.cache.find(channel => channel.name === finalName)) {
    if (counter === 1) {
      finalName = `${baseName}-`;
    } else {
      finalName = `${baseName}-${counter}`;
    }
    counter++;
    
    // Sécurité: éviter les boucles infinies
    if (counter > 100) {
      finalName = `${baseName}-${Date.now()}`;
      break;
    }
  }
  
  return finalName;
};

const resolveCategoryNameConflict = async (guild, baseName) => {
  let finalName = baseName;
  let counter = 1;
  
  // Vérifier si le nom de base est disponible
  while (guild.channels.cache.find(channel => 
    channel.type === 4 && channel.name === finalName // Type 4 = CategoryChannel
  )) {
    if (counter === 1) {
      finalName = `${baseName}-`;
    } else {
      finalName = `${baseName}-${counter}`;
    }
    counter++;
    
    // Sécurité: éviter les boucles infinies
    if (counter > 100) {
      finalName = `${baseName}-${Date.now()}`;
      break;
    }
  }
  
  return finalName;
};

const resolveRoleNameConflict = async (guild, baseName) => {
  let finalName = baseName;
  let counter = 1;
  
  // Vérifier si le nom de base est disponible
  while (guild.roles.cache.find(role => role.name === finalName)) {
    if (counter === 1) {
      finalName = `${baseName}-`;
    } else {
      finalName = `${baseName}-${counter}`;
    }
    counter++;
    
    // Sécurité: éviter les boucles infinies
    if (counter > 100) {
      finalName = `${baseName}-${Date.now()}`;
      break;
    }
  }
  
  return finalName;
};

const sanitizeChannelName = (name) => {
  // Discord autorise seulement certains caractères dans les noms de salons
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\-_]/g, '-') // Remplacer les caractères invalides par des tirets
    .replace(/-+/g, '-') // Réduire les tirets multiples à un seul
    .replace(/^-|-$/g, '') // Supprimer les tirets au début et à la fin
    .substring(0, 100); // Limiter à 100 caractères
};

const sanitizeCategoryName = (name) => {
  // Les catégories peuvent avoir des espaces et des caractères spéciaux
  return name
    .replace(/[^\w\s\-_&!?]/g, '') // Supprimer les caractères non autorisés
    .substring(0, 100); // Limiter à 100 caractères
};

module.exports = {
  resolveChannelNameConflict,
  resolveCategoryNameConflict,
  resolveRoleNameConflict,
  sanitizeChannelName,
  sanitizeCategoryName
}; 