/**
 * Convertit un code nationalité ISO 3 lettres en émoji drapeau.
 * @param {string} natCode - Le code pays à 3 lettres (ex: "FRA")
 * @return {string} L'émoji du drapeau ou le code d'origine si non trouvé
 */
function getFlagEmoji(natCode) {
  if (!natCode) return "";
  
  const flags = {
    // Équipes des 6 Nations & Europe
    "FRA": "🇫🇷", // France
    "ITA": "🇮🇹", // Italie
    "ANG": "🏴󠁧󠁢󠁥󠁮󠁧󠁿", // Angleterre
    "ECO": "🏴󠁧󠁢󠁳󠁣󠁴󠁿", // Écosse
    "IRL": "🇮🇪", // Irlande
    "GAL": "🏴󠁧󠁢󠁷󠁬󠁳󠁿", // Pays de Galles
    "ESP": "🇪🇸", // Espagne
    "POR": "🇵🇹", // Portugal
    "ALL": "🇩🇪", // Allemagne
    "MDA": "🇲🇩", // Moldavie
    "ROU": "🇷🇴", // Roumanie
    "GEO": "🇬🇪", // Géorgie
    "RUS": "🇷🇺", // Russie
    "BEL": "🇧🇪", // Belgique

    // Rugby Championship & Amériques
    "AFS": "🇿🇦", // Afrique du Sud
    "NZL": "🇳🇿", // Nouvelle-Zélande
    "AUS": "🇦🇺", // Australie
    "ARG": "🇦🇷", // Argentine
    "CHI": "🇨🇱", // Chili
    "URU": "🇺🇾", // Uruguay
    "USA": "🇺🇸", // États-Unis
    "CAN": "🇨🇦", // Canada

    // Îles du Pacifique & Asie
    "SAM": "🇼🇸", // Samoa
    "TGA": "🇹🇬", // Tonga (Note : "TO" ou "TGA" selon tes fichiers, l'émoji correspond bien aux Tonga)
    "TON": "🇹🇬", // Doublon de sécurité pour les Tonga
    "FIJ": "🇫🇯", // Fidji
    "JAP": "🇯🇵", // Japon

    // Afrique
    "SEN": "🇸🇳", // Sénégal
    "CIV": "🇨🇮", // Côte d'Ivoire
    "ZIM": "🇿🇼", // Zimbabwe
    "KEN": "🇰🇪", // Kenya
    "CAM": "🇨🇲"  // Cameroun
  };

  // On passe le code en majuscules pour éviter les erreurs de saisie
  const cleanCode = natCode.toUpperCase().trim();

  // Renvoie le drapeau si trouvé, sinon affiche le texte d'origine par sécurité
  return flags[cleanCode] || natCode;
}