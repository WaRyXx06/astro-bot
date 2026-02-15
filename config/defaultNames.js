// Configuration des noms par défaut pour remplacer "inconnu"
// Ces noms sont utilisés quand les éléments ne peuvent pas être résolus

module.exports = {
  // Noms pour les utilisateurs non trouvés
  defaultUser: 'Membre',
  
  // Noms pour les salons non trouvés
  defaultChannel: 'important',
  
  // Noms pour les rôles non trouvés  
  defaultRole: 'Members',
  
  // Nom pour les catégories non trouvées
  defaultCategory: 'Général',
  
  // Nom pour les stickers sans nom
  defaultSticker: 'Sticker personnalisé',
  
  // Nom pour les types de messages non reconnus
  defaultMessageType: 'Message spécial',
  
  // Noms hardcodés pour le serveur mirror
  mirrorDefaults: {
    channelName: 'important',
    roleName: 'Members', 
    userName: 'dr3am',
    categoryName: 'Général'
  }
}; 