// =========================================================
// LOGIQUE DU JEU - TOP 14 PACK OPENING
// =========================================================

const STORAGE_KEY_COLLECTION = "rugby_collection_v1";
const STORAGE_KEY_COINS = "rugby_coins_v1";
const STORAGE_KEY_XV_USED = "rugby_xv_used_v1";
const STORAGE_KEY_DAILY_LAST = "rugby_daily_last_v1";

// ⚙️ MODE DÉVELOPPEMENT : mettre false en production
const DEV_MODE = true;

function getTodayStr() {
  return new Date().toISOString().slice(0, 10);
}

function isDailyAvailable() {
  if (DEV_MODE) return true;
  const last = localStorage.getItem(STORAGE_KEY_DAILY_LAST);
  return last !== getTodayStr();
}

function markDailyUsed() {
  if (!DEV_MODE) localStorage.setItem(STORAGE_KEY_DAILY_LAST, getTodayStr());
}

let collection = {};
let coins = 0;

// ---------------------------------------------------------
// INITIALISATION (async — charge le Sheet en premier)
// ---------------------------------------------------------
function init() {
  loadData();
  renderPacks();
  renderCollection();
  updateCoinsDisplay();
  setupTabs();
  setupModal();
  setupCardDetailModal();
  setupSellConfirmModal();
  setupCoinsButton();
}

function loadData() {
  const savedCollection = localStorage.getItem(STORAGE_KEY_COLLECTION);
  const savedCoins = localStorage.getItem(STORAGE_KEY_COINS);

  collection = savedCollection ? JSON.parse(savedCollection) : {};
  coins = savedCoins ? parseInt(savedCoins, 10) : 200; // 200 pièces de départ
}

function saveData() {
  localStorage.setItem(STORAGE_KEY_COLLECTION, JSON.stringify(collection));
  localStorage.setItem(STORAGE_KEY_COINS, coins.toString());
}

// ---------------------------------------------------------
// PIÈCES
// ---------------------------------------------------------
function updateCoinsDisplay() {
  document.getElementById("coins-display").textContent = coins;
  // Met à jour l'état des boutons d'ouverture (assez de pièces ou non)
  document.querySelectorAll(".open-btn").forEach(btn => {
    const cost = parseInt(btn.dataset.cost, 10);
    btn.disabled = coins < cost;
  });
}

function setupCoinsButton() {
  document.getElementById("add-coins-btn").addEventListener("click", () => {
    coins += 100;
    saveData();
    updateCoinsDisplay();
  });
}

// ---------------------------------------------------------
// ONGLETS
// ---------------------------------------------------------
function setupTabs() {
  document.querySelectorAll(".nav-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));

      btn.classList.add("active");
      document.getElementById("tab-" + btn.dataset.tab).classList.add("active");

      if (btn.dataset.tab === "collection") renderCollection();
      if (btn.dataset.tab === "album") renderAlbum();
      if (btn.dataset.tab === "equipe") renderEquipe();
    });
  });

  // Tri Mon effectif
  document.getElementById("sort-select").addEventListener("change", () => {
    updatePositionFilterVisibility("collection");
    renderCollection();
  });
  document.getElementById("position-filter-select").addEventListener("change", renderCollection);

  // Tri Album
  document.getElementById("album-sort-select").addEventListener("change", () => {
    updatePositionFilterVisibility("album");
    renderAlbum();
  });
  document.getElementById("album-position-filter-select").addEventListener("change", renderAlbum);
}

// Affiche/masque et alimente le filtre secondaire par poste (commun aux deux onglets)
function updatePositionFilterVisibility(tab = "collection") {
  const isAlbum = tab === "album";
  const sortMode = document.getElementById(isAlbum ? "album-sort-select" : "sort-select").value;
  const posSelect = document.getElementById(isAlbum ? "album-position-filter-select" : "position-filter-select");

  const POSITION_ORDER = [
    "Pilier", "Talonneur", "Deuxième ligne", "Troisième ligne",
    "Demi de mêlée", "Demi d'ouverture", "Centre", "Ailier", "Arrière"
  ];

  if (sortMode === "position") {
    const allPositions = new Set();
    PLAYERS.forEach(p => {
      // Pour album : tous les joueurs. Pour collection : seulement possédés
      if (isAlbum || getEntry(getCardKey(p)).count > 0) {
        (p.positions || []).forEach(pos => allPositions.add(pos));
      }
    });

    const sortedPositions = Array.from(allPositions).sort((a, b) => {
      const ia = POSITION_ORDER.indexOf(a);
      const ib = POSITION_ORDER.indexOf(b);
      if (ia === -1 && ib === -1) return a.localeCompare(b);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
    const currentValue = posSelect.value;
    posSelect.innerHTML = `<option value="all">Tous les postes</option>` +
      sortedPositions.map(pos => `<option value="${pos}">${pos}</option>`).join("");
    if (sortedPositions.includes(currentValue)) posSelect.value = currentValue;
    posSelect.classList.remove("hidden");
  } else {
    posSelect.classList.add("hidden");
  }
}

// ---------------------------------------------------------
// AFFICHAGE DES PACKS
// ---------------------------------------------------------
function renderPacks() {
  const container = document.getElementById("packs-container");
  container.innerHTML = "";

  const xvUsed = !DEV_MODE && localStorage.getItem(STORAGE_KEY_XV_USED) === "true";
  const dailyAvailable = isDailyAvailable();

  PACKS.forEach(pack => {
    const div = document.createElement("div");
    const isXV = pack.id === "xv_demarrage";
    const isDaily = pack.id === "coup_envoi";

    let cardClass = "pack-card";
    if (isXV) cardClass += " pack-card-xv";
    if (isDaily) cardClass += " pack-card-daily";
    div.className = cardClass;

    // Coût affiché
    let costHtml;
    if (isXV || isDaily) {
      costHtml = `<div class="pack-cost pack-cost-free">GRATUIT</div>`;
    } else {
      costHtml = `<div class="pack-cost">${pack.cost} <span class="rubiz-symbol">R</span></div>`;
    }

    // Bouton
    let btnDisabled = false;
    let btnLabel = "Ouvrir";
    let btnClass = "open-btn";
    let extraHtml = "";

    if (isXV) {
      btnClass += " open-btn-xv";
      if (xvUsed) { btnDisabled = true; btnLabel = "Déjà obtenu"; }
      else btnLabel = "🏉 Ouvrir — GRATUIT";
    } else if (isDaily) {
      btnClass += " open-btn-daily";
      if (!dailyAvailable) {
        btnDisabled = true;
        btnLabel = "Revenir demain";
        extraHtml = `<div id="daily-countdown" class="daily-countdown"></div>`;
      } else {
        btnLabel = "⚡ Ouvrir — GRATUIT";
      }
    }

    let icon = "📦";
    if (isXV) icon = "🏉";
    if (isDaily) icon = "⚡";

    div.innerHTML = `
      <div class="pack-icon">${icon}</div>
      <h3>${pack.name}</h3>
      <p>${pack.description}</p>
      ${costHtml}
      ${extraHtml}
      <button class="${btnClass}" data-pack-id="${pack.id}" data-cost="${pack.cost}" ${btnDisabled ? "disabled" : ""}>
        ${btnLabel}
      </button>
    `;
    container.appendChild(div);
  });

  document.querySelectorAll(".open-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const packId = btn.dataset.packId;
      const cost = parseInt(btn.dataset.cost, 10);
      openPack(packId, cost);
    });
  });

  // Démarrer le compte à rebours si le daily est utilisé
  if (!dailyAvailable) startDailyCountdown();

  updateCoinsDisplay();
}

// ---------------------------------------------------------
// COMPTE À REBOURS PACK QUOTIDIEN
// ---------------------------------------------------------
let countdownInterval = null;

function startDailyCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);

  function update() {
    const el = document.getElementById("daily-countdown");
    if (!el) { clearInterval(countdownInterval); return; }

    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);

    const diff = tomorrow - now;
    if (diff <= 0) {
      clearInterval(countdownInterval);
      renderPacks();
      return;
    }

    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    el.textContent = `⏱ Disponible dans ${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
  }

  update();
  countdownInterval = setInterval(update, 1000);
}

// ---------------------------------------------------------
// LOGIQUE D'OUVERTURE DE PACK
// ---------------------------------------------------------
function openPack(packId, cost) {
  if (coins < cost) return;

  const pack = PACKS.find(p => p.id === packId);
  if (!pack) return;

  // Pack XV Démarrage : logique spéciale
  if (pack.id === "xv_demarrage") {
    if (!DEV_MODE && localStorage.getItem(STORAGE_KEY_XV_USED) === "true") return;
    const drawnCards = drawXVDemarrage();
    drawnCards.forEach(card => addCardToCollection(card, true));
    if (!DEV_MODE) localStorage.setItem(STORAGE_KEY_XV_USED, "true");
    saveData();
    updateCoinsDisplay();
    showOpeningModal(pack, drawnCards);
    renderPacks();
    return;
  }

  // Pack Coup d'Envoi (quotidien)
  if (pack.id === "coup_envoi") {
    if (!isDailyAvailable()) return;

    const result = drawCoupEnvoi();

    // Créditer les RUGBIZ bonus
    coins += result.bonus;
    result.cards.forEach(card => addCardToCollection(card, true)); // locked

    markDailyUsed();
    saveData();
    updateCoinsDisplay();
    showCoupEnvoiModal(pack, result);
    renderPacks();
    return;
  }

  coins -= cost;

  const drawnCards = [];
  for (let i = 0; i < pack.cardsCount; i++) {
    if (pack.forcedRarity) {
      drawnCards.push(drawCardOfRarity(pack.forcedRarity));
    } else {
      drawnCards.push(drawRandomCard(pack));
    }
  }

  // Garantie de rareté minimale (si configurée)
  if (pack.guaranteedRarity) {
    const order = ["commune", "rare", "epique", "international", "legendaire"];
    const minIndex = order.indexOf(pack.guaranteedRarity);
    const hasGuarantee = drawnCards.some(
      c => order.indexOf(c.rarity) >= minIndex
    );
    if (!hasGuarantee) {
      drawnCards[drawnCards.length - 1] = drawRandomCard(pack, pack.guaranteedRarity);
    }
  }

  drawnCards.forEach(card => addCardToCollection(card, false));

  saveData();
  updateCoinsDisplay();
  showOpeningModal(pack, drawnCards);
}

// ---------------------------------------------------------
// LOGIQUE XV DÉMARRAGE
// ---------------------------------------------------------
function drawXVDemarrage() {
  // Postes des avants (pour la rare avant)
  const POSTES_AVANTS = ["Pilier", "Talonneur", "Deuxième ligne", "Troisième ligne"];
  // Postes des arrières (pour la rare arrière)
  const POSTES_ARRIERES = ["Demi de mêlée", "Demi d'ouverture", "Centre", "Ailier", "Arrière"];

  // Composition exacte du XV : [poste, rareté, nb]
  const composition = [
    { poste: "Pilier",            count: 2, rarity: "commune" },
    { poste: "Talonneur",         count: 1, rarity: "commune" },
    { poste: "Deuxième ligne",    count: 2, rarity: "commune" },
    { poste: "Troisième ligne",   count: 3, rarity: "commune" },
    { poste: "Demi de mêlée",     count: 1, rarity: "commune" },
    { poste: "Demi d'ouverture",  count: 1, rarity: "commune" },
    { poste: "Centre",            count: 2, rarity: "commune" },
    { poste: "Ailier",            count: 2, rarity: "commune" },
    { poste: "Arrière",           count: 1, rarity: "commune" }
  ];
  // Total : 2+1+2+3+1+1+2+2+1 = 15 communes de base

  const drawnCards = [];

  // Tire les 13 communes selon la composition (hors les 2 emplacements rares)
  // On va remplacer 1 commune avant + 1 commune arrière par des rares
  const positionPool = [];
  composition.forEach(slot => {
    for (let i = 0; i < slot.count; i++) {
      positionPool.push(slot.poste);
    }
  });

  // On choisit aléatoirement 1 poste avant et 1 poste arrière pour les rares
  const indicesAvants = positionPool.map((p,i)=>i).filter(i => POSTES_AVANTS.includes(positionPool[i]));
  const indicesArrieres = positionPool.map((p,i)=>i).filter(i => POSTES_ARRIERES.includes(positionPool[i]));
  const rareAvantIdx = indicesAvants[Math.floor(Math.random() * indicesAvants.length)];
  const rareArriereIdx = indicesArrieres[Math.floor(Math.random() * indicesArrieres.length)];
  const rareIndices = new Set([rareAvantIdx, rareArriereIdx]);

  positionPool.forEach((poste, idx) => {
    const rarity = rareIndices.has(idx) ? "rare" : "commune";
    const card = drawCardByPoste(poste, rarity);
    if (card) drawnCards.push(card);
  });

  return drawnCards;
}

function drawCardByPoste(poste, rarity) {
  const pool = PLAYERS.filter(p =>
    p.rarity === rarity &&
    (p.positions || []).includes(poste)
  );
  if (!pool.length) {
    // Fallback si pas de joueur rare à ce poste : commune
    const fallback = PLAYERS.filter(p =>
      p.rarity === "commune" && (p.positions || []).includes(poste)
    );
    if (!fallback.length) return null;
    return fallback[Math.floor(Math.random() * fallback.length)];
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

// ---------------------------------------------------------
// PACK COUP D'ENVOI — Tirage quotidien
// ---------------------------------------------------------
function drawCoupEnvoi() {
  // 1. Bonus RUGBIZ aléatoire entre 10 et 50
  const bonus = Math.floor(Math.random() * 41) + 10; // 10-50

  // 2. Tirage de 3 cartes selon les probabilités
  const cards = [];
  for (let i = 0; i < 3; i++) {
    cards.push(drawDailyCard());
  }

  return { bonus, cards };
}

function drawDailyCard() {
  const roll = Math.random() * 100;
  let rarity;

  if (roll < 75)       rarity = "commune";      // 75%
  else if (roll < 95)  rarity = "rare";          // 20%
  else if (roll < 99.9) rarity = "epique";       // 4.9%
  else {
    // 0.1% : Légendaire ou International (50/50)
    rarity = Math.random() < 0.5 ? "legendaire" : "international";
  }

  const pool = PLAYERS.filter(p => p.rarity === rarity);
  if (!pool.length) {
    // Fallback commune
    const fallback = PLAYERS.filter(p => p.rarity === "commune");
    return fallback[Math.floor(Math.random() * fallback.length)];
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

function showCoupEnvoiModal(pack, result) {
  document.getElementById("opening-title").textContent = `${pack.name} — Résultats`;

  const container = document.getElementById("cards-reveal");
  container.innerHTML = "";

  // Bonus RUGBIZ affiché en premier comme une "carte bonus"
  const bonusEl = document.createElement("div");
  bonusEl.className = "daily-bonus-reveal";
  bonusEl.style.animationDelay = "0s";
  bonusEl.innerHTML = `
    <div class="daily-bonus-icon">💰</div>
    <div class="daily-bonus-amount">+${result.bonus}</div>
    <div class="daily-bonus-label"><span class="rubiz-symbol">R</span> RUGBIZ</div>
  `;
  container.appendChild(bonusEl);

  // Les 3 cartes avec la même animation que showOpeningModal
  result.cards.forEach((card, index) => {
    const el = buildCardElement(card, null, { lockedCount: 1 });
    el.style.animationDelay = `${0.2 + index * 0.15}s`;
    el.style.opacity = "0";
    el.style.transform = "scale(0.7)";
    el.style.animation = `revealCard 0.5s ease ${0.2 + index * 0.15}s forwards`;
    container.appendChild(el);
  });

  document.getElementById("opening-modal").classList.remove("hidden");
}

function drawCardOfRarity(rarity) {
  const pool = PLAYERS.filter(p => p.rarity === rarity);
  return pool[Math.floor(Math.random() * pool.length)];
}

// Tire une carte aléatoire selon les pondérations du pack
// Si "forceRarity" est fourni, on tire uniquement parmi cette rareté (ou supérieure)
function drawRandomCard(pack, forceMinRarity = null) {
  const order = ["commune", "rare", "epique", "international", "legendaire"];
  let pool = PLAYERS;

  if (forceMinRarity) {
    const minIndex = order.indexOf(forceMinRarity);
    pool = PLAYERS.filter(p => order.indexOf(p.rarity) >= minIndex);
  }

  // Calcul des poids combinés (rareté de base * modificateur du pack)
  const weighted = pool
    .filter(player => RARITIES[player.rarity])
    .map(player => {
      const baseWeight = RARITIES[player.rarity].weight;
      const modifier = pack.weightModifier[player.rarity] ?? 1;
      return { player, weight: baseWeight * modifier };
    });

  const totalWeight = weighted.reduce((sum, w) => sum + w.weight, 0);
  let roll = Math.random() * totalWeight;

  for (const w of weighted) {
    roll -= w.weight;
    if (roll <= 0) return w.player;
  }

  return weighted[weighted.length - 1].player; // fallback
}

// ---------------------------------------------------------
// COLLECTION
// ---------------------------------------------------------
function getCardKey(card) {
  return `${card.name}|${card.team}`;
}

// Normalise une entrée de collection vers { count, lockedCount }
function getEntry(key) {
  const raw = collection[key];
  if (!raw) return { count: 0, lockedCount: 0 };
  if (typeof raw === "number") return { count: raw, lockedCount: 0 };
  return raw;
}

function addCardToCollection(card, locked = false) {
  const key = getCardKey(card);
  const entry = getEntry(key);
  entry.count += 1;
  if (locked) entry.lockedCount = (entry.lockedCount || 0) + 1;
  collection[key] = entry;
}

function renderCollection() {
  const container = document.getElementById("collection-container");
  container.innerHTML = "";

  const totalPlayers = PLAYERS.length;
  const ownedPlayers0 = PLAYERS.filter(p => getEntry(getCardKey(p)).count > 0);
  const totalOwned = ownedPlayers0.length;

  document.getElementById("collection-stats").textContent =
    `${totalOwned} / ${totalPlayers} joueurs débloqués`;

  if (totalOwned === 0) {
    container.innerHTML = `<div class="empty-card">Aucune carte pour le moment.<br>Ouvre un pack pour commencer !</div>`;
    return;
  }

  const sortMode = document.getElementById("sort-select")?.value || "rarity";
  let ownedPlayers = PLAYERS.filter(p => getEntry(getCardKey(p)).count > 0);

  if (sortMode === "position") {
    const posFilter = document.getElementById("position-filter-select")?.value || "all";
    if (posFilter !== "all") {
      ownedPlayers = ownedPlayers.filter(p => (p.positions || []).includes(posFilter));
    }
  }

  sortPlayers(ownedPlayers, sortMode);

  ownedPlayers.forEach(player => {
    const entry = getEntry(getCardKey(player));
    container.appendChild(buildCardElement(player, entry.count, {
      clickable: true,
      lockedCount: entry.lockedCount || 0
    }));
  });
}

// ---------------------------------------------------------
// ALBUM — Toutes les cartes du jeu
// ---------------------------------------------------------
function renderAlbum() {
  const container = document.getElementById("album-container");
  container.innerHTML = "";

  const totalPlayers = PLAYERS.length;
  const ownedCount = PLAYERS.filter(p => getEntry(getCardKey(p)).count > 0).length;
  document.getElementById("album-stats").textContent =
    `${ownedCount} / ${totalPlayers} joueurs obtenus`;

  const sortMode = document.getElementById("album-sort-select")?.value || "rarity";
  let allPlayers = [...PLAYERS];

  if (sortMode === "position") {
    const posFilter = document.getElementById("album-position-filter-select")?.value || "all";
    if (posFilter !== "all") {
      allPlayers = allPlayers.filter(p => (p.positions || []).includes(posFilter));
    }
  }

  sortPlayers(allPlayers, sortMode, "album");

  allPlayers.forEach(player => {
    const entry = getEntry(getCardKey(player));
    const owned = entry.count > 0;
    const el = buildAlbumCard(player, owned);
    container.appendChild(el);
  });
}

function buildAlbumCard(player, owned) {
  const wrapper = document.createElement("div");
  wrapper.className = "album-card-wrapper" + (owned ? "" : " album-card-missing");

  const cardEl = buildCardElement(player, null, {});
  cardEl.classList.add("album-card");
  if (!owned) cardEl.classList.add("card-not-owned");

  if (owned) {
    const badge = document.createElement("span");
    badge.className = "album-owned-badge";
    badge.textContent = "Effectif";
    cardEl.appendChild(badge);
  }

  wrapper.appendChild(cardEl);

  // Clic → aperçu sans vente
  wrapper.addEventListener("click", () => openAlbumDetail(player, owned));

  return wrapper;
}

// ---------------------------------------------------------
// VENTE DE CARTES EN DOUBLON (quantité ajustable)
// ---------------------------------------------------------
function sellCard(key, quantity) {
  const entry = getEntry(key);
  if (entry.count <= 0) return;

  // Nb vendables = total - exemplaires verrouillés (on garde au moins les locked)
  const sellable = Math.max(0, entry.count - (entry.lockedCount || 0));
  if (sellable <= 0) return;

  const qty = Math.max(1, Math.min(quantity, sellable));

  const player = PLAYERS.find(p => getCardKey(p) === key);
  if (!player) return;

  entry.count -= qty;
  if (entry.count <= 0) {
    delete collection[key];
  } else {
    collection[key] = entry;
  }
  coins += RARITIES[player.rarity].sellValue * qty;

  saveData();
  updateCoinsDisplay();
  renderCollection();
}

// ---------------------------------------------------------
// TRI DE LA COLLECTION
// ---------------------------------------------------------
function sortPlayers(players, mode) {
  const rarityOrder = ["legendaire", "international", "epique", "rare", "commune"];

  switch (mode) {
    case "alpha":
      players.sort((a, b) => a.name.localeCompare(b.name));
      break;

    case "club":
      players.sort((a, b) => {
        const teamA = TEAMS[a.team].name;
        const teamB = TEAMS[b.team].name;
        return teamA.localeCompare(teamB) || a.name.localeCompare(b.name);
      });
      break;

    case "position":
      players.sort((a, b) =>
        a.positions[0].localeCompare(b.positions[0]) || a.name.localeCompare(b.name)
      );
      break;

    case "nationality":
      players.sort((a, b) =>
        (a.nat || "").localeCompare(b.nat || "") || a.name.localeCompare(b.name)
      );
      break;

    case "rarity":
    default:
      players.sort((a, b) =>
        rarityOrder.indexOf(a.rarity) - rarityOrder.indexOf(b.rarity) ||
        a.name.localeCompare(b.name)
      );
      break;
  }
}

// ---------------------------------------------------------
// DRAPEAUX
// ---------------------------------------------------------
/**
 * Retourne un <img> de drapeau via flagcdn.com (codes ISO 2 lettres)
 * Fiable sur tous les navigateurs/OS y compris Windows
 */
function getFlagEmoji(natCode) {
  if (!natCode) return "";

  // Correspondance code rugby 3 lettres → code ISO 2 lettres pour flagcdn.com
  const iso2 = {
    "FRA": "fr", "ITA": "it", "ANG": "gb-eng", "ECO": "gb-sct",
    "GAL": "gb-wls", "PDG": "gb-wls", "IRL": "ie", "ESP": "es",
    "POR": "pt", "ALL": "de", "MDA": "md", "ROU": "ro",
    "GEO": "ge", "RUS": "ru", "BEL": "be",
    "AFS": "za", "NZL": "nz", "AUS": "au", "ARG": "ar",
    "CHI": "cl", "URU": "uy", "USA": "us", "CAN": "ca",
    "SAM": "ws", "TGA": "to", "TON": "to", "FIJ": "fj", "JAP": "jp",
    "SEN": "sn", "CIV": "ci", "ZWE": "zw", "ZIM": "zw",
    "KEN": "ke", "CMR": "cm", "CAM": "cm", "COD": "cd", "NAM": "na"
  };

  const clean = natCode.toUpperCase().trim();
  const code = iso2[clean];
  if (!code) return `<span class="nat-flag-fallback">🏳</span>`;

  return `<img class="nat-flag-img" src="https://flagcdn.com/20x15/${code}.png" alt="${clean}" loading="lazy">`;
}

/**
 * Retourne l'abréviation affichée pour un code pays
 */
function getNatLabel(natCode) {
  const names = {
    FRA: "FRA", ITA: "ITA", ANG: "ENG", ECO: "SCO",
    GAL: "WAL", PDG: "WAL", IRL: "IRL", ESP: "ESP", POR: "POR",
    ALL: "ALL", MDA: "MDA", ROU: "ROU", GEO: "GEO",
    RUS: "RUS", BEL: "BEL",
    AFS: "RSA", NZL: "NZL", AUS: "AUS", ARG: "ARG",
    CHI: "CHI", URU: "URU", USA: "USA", CAN: "CAN",
    SAM: "SAM", TGA: "TGA", TON: "TGA", FIJ: "FIJ", JAP: "JPN",
    SEN: "SEN", CIV: "CIV", ZWE: "ZIM", ZIM: "ZIM",
    KEN: "KEN", CMR: "CMR", CAM: "CMR", COD: "COD", NAM: "NAM"
  };
  const clean = (natCode || "").toUpperCase().trim();
  return names[clean] || clean;
}

// ---------------------------------------------------------
// CRÉATION D'UN ÉLÉMENT "CARTE"
// ---------------------------------------------------------
function buildCardElement(player, count = null, options = {}) {
  const card = document.createElement("div");
  card.className = `card ${player.rarity}`;

  const team = TEAMS[player.team];
  const initials = player.name
    .split(" ")
    .map(w => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const customTeams = ["toulouse", "montpellier", "racing92", "lapelle", "clermont", "ubb", "bayonne", "perpignan", "montauban"];
  // Les légendes ont le design médaillon (pas de couleur club) ; les international gardent la couleur club
  const isCustom = player.rarity !== "legendaire" && customTeams.includes(player.team);
  const avatarClass = isCustom ? `avatar-${player.team}` : "";
  const avatarStyle = isCustom ? "" : `style="background:${team.color}"`;

  const positionText = (player.positions || []).join(" / ");
  const natCode = (player.nat || "FRA").toUpperCase().trim();

  const clubsText = player.clubs && player.clubs.length > 1
    ? player.clubs.map(c => TEAMS[c].name).join(" / ")
    : team.name;

  const isLocked = (options.lockedCount || 0) > 0;

  card.innerHTML = `
    <div class="card-avatar ${avatarClass}" ${avatarStyle}>
      <span class="avatar-initials">${initials}</span>
      ${isLocked ? `<span class="card-lock-badge" title="Non revendable — XV Démarrage">🔒</span>` : ""}
    </div>
    <div class="card-info">
      <p class="card-name">${player.name}</p>
      <p class="card-team">${clubsText}</p>
      <p class="card-position">${positionText}</p>
      <span class="card-rarity ${player.rarity}">${RARITIES[player.rarity].label}</span>
      ${count !== null ? `<div class="card-count">x${count}</div>` : ""}
      <p class="card-nationality"><span class="nat-flag">${getFlagEmoji(natCode)}</span><span class="nat-code">${getNatLabel(natCode)}</span></p>
    </div>
  `;

  if (options.clickable) {
    card.classList.add("clickable-card");
    card.addEventListener("click", () => openCardDetail(player, count));
  }

  return card;
}

// ---------------------------------------------------------
// MODALE D'OUVERTURE
// ---------------------------------------------------------
function setupModal() {
  document.getElementById("close-modal-btn").addEventListener("click", () => {
    document.getElementById("opening-modal").classList.add("hidden");
    renderCollection();
  });
}

function showOpeningModal(pack, cards) {
  document.getElementById("opening-title").textContent = `${pack.name} — Résultats`;

  const container = document.getElementById("cards-reveal");
  container.innerHTML = "";

  const isLocked = pack.locked === true;

  cards.forEach((card, index) => {
    const el = buildCardElement(card, null, { lockedCount: isLocked ? 1 : 0 });
    el.style.animationDelay = `${index * 0.15}s`;
    container.appendChild(el);
  });

  document.getElementById("opening-modal").classList.remove("hidden");
}

// ---------------------------------------------------------
// MODALE DETAIL CARTE (zoom + vente)
// ---------------------------------------------------------
let currentDetailKey = null;
let currentDetailQty = 1;

function setupCardDetailModal() {
  document.getElementById("close-detail-btn").addEventListener("click", closeCardDetail);

  document.getElementById("qty-minus").addEventListener("click", () => {
    if (currentDetailQty > 1) {
      currentDetailQty--;
      updateCardDetailControls();
    }
  });

  document.getElementById("qty-plus").addEventListener("click", () => {
    const entry = getEntry(currentDetailKey);
    const maxSellable = Math.max(0, entry.count - (entry.lockedCount || 0));
    if (currentDetailQty < maxSellable) {
      currentDetailQty++;
      updateCardDetailControls();
    }
  });

  document.getElementById("confirm-sell-btn").addEventListener("click", () => {
    if (!currentDetailKey) return;
    const entry = getEntry(currentDetailKey);
    const sellable = entry.count - (entry.lockedCount || 0);
    if (sellable <= 0) return;

    if (sellable === 1) {
      showSellConfirm();
    } else {
      sellCard(currentDetailKey, currentDetailQty);
      closeCardDetail();
    }
  });
}

function openCardDetail(player, count) {
  currentDetailKey = getCardKey(player);
  currentDetailQty = 1;

  const container = document.getElementById("card-detail-container");
  container.innerHTML = "";
  const entry = getEntry(currentDetailKey);
  const cardEl = buildCardElement(player, entry.count, { lockedCount: entry.lockedCount || 0 });
  cardEl.classList.add("zoomed-card");
  container.appendChild(cardEl);

  // Restaure les contrôles de vente (peut avoir été masqué par l'album)
  document.querySelector(".sell-controls").classList.remove("hidden");

  updateCardDetailControls();

  document.getElementById("card-detail-modal").classList.remove("hidden");
}

function updateCardDetailControls() {
  const entry = getEntry(currentDetailKey);
  const maxSellable = Math.max(0, entry.count - (entry.lockedCount || 0));
  const player = PLAYERS.find(p => getCardKey(p) === currentDetailKey);
  const sellValue = player ? RARITIES[player.rarity].sellValue : 0;

  document.getElementById("qty-value").textContent = currentDetailQty;

  const sellControls = document.querySelector(".sell-controls");
  const confirmBtn = document.getElementById("confirm-sell-btn");

  if (maxSellable <= 0 && (entry.lockedCount || 0) > 0) {
    // Cartes verrouillées uniquement
    sellControls.classList.remove("hidden");
    document.getElementById("qty-value").textContent = "🔒";
    document.getElementById("qty-minus").disabled = true;
    document.getElementById("qty-plus").disabled = true;
    confirmBtn.textContent = "Non revendable (XV Démarrage)";
    confirmBtn.disabled = true;
  } else if (maxSellable <= 0) {
    sellControls.classList.remove("hidden");
    document.getElementById("qty-value").textContent = "—";
    document.getElementById("qty-minus").disabled = true;
    document.getElementById("qty-plus").disabled = true;
    confirmBtn.textContent = "Aucune carte à vendre";
    confirmBtn.disabled = true;
  } else {
    sellControls.classList.remove("hidden");
    confirmBtn.disabled = false;
    confirmBtn.innerHTML = `Vendre ${currentDetailQty} (+${sellValue * currentDetailQty} <span class="rubiz-symbol">R</span>)`;
    document.getElementById("qty-minus").disabled = currentDetailQty <= 1;
    document.getElementById("qty-plus").disabled = currentDetailQty >= maxSellable;
  }
}

function closeCardDetail() {
  document.getElementById("card-detail-modal").classList.add("hidden");
  currentDetailKey = null;
}

// ---------------------------------------------------------
// CONFIRMATION DE VENTE (dernier exemplaire)
// ---------------------------------------------------------
function showSellConfirm() {
  document.getElementById("sell-confirm-modal").classList.remove("hidden");
}

function hideSellConfirm() {
  document.getElementById("sell-confirm-modal").classList.add("hidden");
}

function setupSellConfirmModal() {
  document.getElementById("sell-confirm-yes").addEventListener("click", () => {
    if (currentDetailKey) {
      sellCard(currentDetailKey, 1);
    }
    hideSellConfirm();
    closeCardDetail();
  });

  document.getElementById("sell-confirm-no").addEventListener("click", () => {
    hideSellConfirm();
  });
}

// ---------------------------------------------------------
// MON ÉQUIPE — Composition interactive
// ---------------------------------------------------------

// Mapping poste → slug utilisé dans l'interface
const EQUIPE_SLOTS = [
  { id: "pilier_g",   label: "Pilier",            poste: "Pilier",           num: 1  },
  { id: "talonneur",  label: "Talonneur",          poste: "Talonneur",        num: 2  },
  { id: "pilier_d",   label: "Pilier",             poste: "Pilier",           num: 3  },
  { id: "2l_g",       label: "2e Ligne",           poste: "Deuxième ligne",   num: 4  },
  { id: "2l_d",       label: "2e Ligne",           poste: "Deuxième ligne",   num: 5  },
  { id: "3l_g",       label: "3e Ligne",           poste: "Troisième ligne",  num: 6  },
  { id: "3l_d",       label: "3e Ligne",           poste: "Troisième ligne",  num: 7  },
  { id: "3l_c",       label: "3e Ligne",           poste: "Troisième ligne",  num: 8  },
  { id: "demi_m",     label: "Demi de Mêlée",      poste: "Demi de mêlée",   num: 9  },
  { id: "demi_o",     label: "Demi d'Ouverture",   poste: "Demi d'ouverture",num: 10 },
  { id: "centre_g",   label: "Centre",             poste: "Centre",           num: 12 },
  { id: "centre_d",   label: "Centre",             poste: "Centre",           num: 13 },
  { id: "ailier_g",   label: "Ailier",             poste: "Ailier",           num: 11 },
  { id: "ailier_d",   label: "Ailier",             poste: "Ailier",           num: 14 },
  { id: "arriere",    label: "Arrière",            poste: "Arrière",          num: 15 }
];

// Rareté order pour compo type
const RARITY_RANK = { legendaire: 5, international: 4, epique: 3, rare: 2, commune: 1 };

// Stockage de la compo en cours
let equipe = {}; // { slotId: player }
let currentSlotId = null;

function renderEquipe() {
  const container = document.getElementById("pitch-container");
  container.innerHTML = "";

  const pitch = document.createElement("div");
  pitch.className = "pitch";

  // Layout du terrain : rangées de joueurs (du bas vers le haut = des arrières vers avants)
  const rows = [
    ["arriere"],
    ["ailier_g", "centre_g", "centre_d", "ailier_d"],
    ["demi_o", "demi_m"],
    ["3l_g", "3l_c", "3l_d"],
    ["2l_g", "2l_d"],
    ["pilier_g", "talonneur", "pilier_d"]
  ];

  rows.forEach(rowIds => {
    const row = document.createElement("div");
    row.className = "pitch-row";
    rowIds.forEach(slotId => {
      const slot = EQUIPE_SLOTS.find(s => s.id === slotId);
      const player = equipe[slotId] || null;
      row.appendChild(buildPitchSlot(slot, player));
    });
    pitch.appendChild(row);
  });

  container.appendChild(pitch);

  // Boutons
  document.getElementById("compo-type-btn").onclick = doCompoType;
  document.getElementById("reset-equipe-btn").onclick = () => {
    equipe = {};
    renderEquipe();
  };

  setupPlayerSelectModal();
}

function buildPitchSlot(slot, player) {
  const el = document.createElement("div");
  el.className = "pitch-slot";
  el.dataset.slotId = slot.id;

  if (player) {
    el.classList.add("pitch-slot-filled");
    el.innerHTML = buildMiniCard(player, slot);
  } else {
    el.classList.add("pitch-slot-empty");
    el.innerHTML = `
      <div class="slot-num">${slot.num}</div>
      <div class="slot-label">${slot.label}</div>
      <div class="slot-add">＋</div>
    `;
  }

  el.addEventListener("click", () => openPlayerSelect(slot));
  return el;
}

function buildMiniCard(player, slot) {
  const team = TEAMS[player.team];
  const posText = (player.positions || []).join(" / ");
  const rarityClass = player.rarity;

  // Couleur de fond du mini-header
  let bgStyle = "";
  const customTeams = ["toulouse","montpellier","racing92","lapelle","clermont","ubb","bayonne","perpignan","montauban"];
  if (player.rarity === "legendaire") {
    bgStyle = "background: radial-gradient(circle at 50% 35%, #fff7d6 0%, #d4af37 35%, #9a9a9a 65%, #c0c0c0 85%, #707070 100%);";
  } else if (customTeams.includes(player.team)) {
    bgStyle = ""; // handled by CSS class
  } else {
    bgStyle = `background: ${team.color};`;
  }
  const avatarClass = (player.rarity !== "legendaire" && customTeams.includes(player.team))
    ? `avatar-${player.team}` : "";

  return `
    <div class="mini-card ${rarityClass}">
      <div class="mini-card-header ${avatarClass}" style="${bgStyle}">
        <span class="mini-num">${slot.num}</span>
      </div>
      <div class="mini-card-body">
        <div class="mini-name">${player.name}</div>
        <div class="mini-team">${team.name}</div>
        <div class="mini-pos">${posText}</div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------
// SÉLECTION DE JOUEUR
// ---------------------------------------------------------
function setupPlayerSelectModal() {
  document.getElementById("close-player-select-btn").onclick = closePlayerSelect;
}

function openPlayerSelect(slot) {
  currentSlotId = slot.id;
  document.getElementById("player-select-title").textContent =
    `Choisir — ${slot.label} (${slot.poste})`;

  // Joueurs de l'effectif correspondant au poste
  const eligible = PLAYERS.filter(p =>
    getEntry(getCardKey(p)).count > 0 &&
    (p.positions || []).includes(slot.poste)
  );

  // Tri par rareté décroissante puis nom
  const rarityOrder = ["legendaire","international","epique","rare","commune"];
  eligible.sort((a,b) =>
    rarityOrder.indexOf(a.rarity) - rarityOrder.indexOf(b.rarity) || a.name.localeCompare(b.name)
  );

  // Construire le filtre club à partir des joueurs éligibles
  const clubs = [...new Set(eligible.map(p => p.team))].sort((a,b) =>
    TEAMS[a].name.localeCompare(TEAMS[b].name)
  );

  const list = document.getElementById("player-select-list");
  list.innerHTML = "";

  // Bouton "retirer" si un joueur est déjà assigné
  const existing = equipe[slot.id];
  if (existing) {
    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-player-btn";
    removeBtn.textContent = `🗑️ Retirer ${existing.name}`;
    removeBtn.onclick = () => {
      delete equipe[currentSlotId];
      closePlayerSelect();
      renderEquipe();
    };
    list.appendChild(removeBtn);
  }

  // Filtre club
  if (clubs.length > 1) {
    const filterDiv = document.createElement("div");
    filterDiv.className = "psr-club-filter";
    const sel = document.createElement("select");
    sel.id = "psr-club-select";
    sel.innerHTML = `<option value="all">Tous les clubs</option>` +
      clubs.map(t => `<option value="${t}">${TEAMS[t].name}</option>`).join("");
    sel.addEventListener("change", () => renderPlayerSelectList(eligible, slot, sel.value));
    filterDiv.appendChild(sel);
    list.appendChild(filterDiv);
  }

  // Zone de résultats
  const resultsDiv = document.createElement("div");
  resultsDiv.id = "psr-results";
  list.appendChild(resultsDiv);

  renderPlayerSelectList(eligible, slot, "all");

  document.getElementById("player-select-modal").classList.remove("hidden");
}

function renderPlayerSelectList(eligible, slot, clubFilter) {
  const resultsDiv = document.getElementById("psr-results");
  if (!resultsDiv) return;
  resultsDiv.innerHTML = "";

  const filtered = clubFilter === "all"
    ? eligible
    : eligible.filter(p => p.team === clubFilter);

  if (filtered.length === 0) {
    resultsDiv.innerHTML = `<p class="no-players">Aucun joueur pour ce club à ce poste.</p>`;
  } else {
    filtered.forEach(player => {
      resultsDiv.appendChild(buildPlayerSelectRow(player, slot));
    });
  }
}

function buildPlayerSelectRow(player, slot) {
  const team = TEAMS[player.team];
  const rarityConfig = RARITIES[player.rarity];
  const isSelected = Object.values(equipe).some(p => getCardKey(p) === getCardKey(player));

  const row = document.createElement("div");
  row.className = "player-select-row" + (isSelected ? " player-in-team" : "");

  row.innerHTML = `
    <div class="psr-rarity" style="background:${rarityConfig.color}; color:${player.rarity==='legendaire'?'#fff':'#fff'}">${rarityConfig.label}</div>
    <div class="psr-info">
      <div class="psr-name">${player.name}</div>
      <div class="psr-team">${team.name}</div>
    </div>
    <button class="psr-add-btn" ${isSelected ? "disabled title='Déjà dans l\\'équipe'" : ""}>
      ${isSelected ? "✓ En équipe" : "＋ Ajouter"}
    </button>
  `;

  if (!isSelected) {
    row.querySelector(".psr-add-btn").addEventListener("click", () => {
      equipe[currentSlotId] = player;
      closePlayerSelect();
      renderEquipe();
    });
  }

  return row;
}

function closePlayerSelect() {
  document.getElementById("player-select-modal").classList.add("hidden");
  currentSlotId = null;
}

// ---------------------------------------------------------
// COMPO TYPE
// ---------------------------------------------------------
function doCompoType() {
  const newEquipe = {};

  EQUIPE_SLOTS.forEach(slot => {
    const eligible = PLAYERS.filter(p =>
      getEntry(getCardKey(p)).count > 0 &&
      (p.positions || []).includes(slot.poste) &&
      !Object.values(newEquipe).some(assigned => getCardKey(assigned) === getCardKey(p))
    );

    if (eligible.length === 0) return;

    // Choisit le joueur de rareté la plus élevée (aléatoire si égalité)
    eligible.sort((a, b) => {
      const ra = RARITY_RANK[a.rarity] || 0;
      const rb = RARITY_RANK[b.rarity] || 0;
      return rb - ra;
    });

    // Prendre le meilleur disponible
    const best = eligible[0];
    newEquipe[slot.id] = best;
  });

  equipe = newEquipe;
  renderEquipe();
}

// ---------------------------------------------------------

// ---------------------------------------------------------
// LANCEMENT
// ---------------------------------------------------------
init();
