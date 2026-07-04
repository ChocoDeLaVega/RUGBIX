// =========================================================
// LOGIQUE DU JEU - RUGBIX
// =========================================================

// xvUsed stocké en mémoire (chargé depuis Firestore au login)
let xvUsedInMemory = false;
// ⚙️ DEV_MODE — toggleable depuis le panneau admin
let DEV_MODE = false;


// dailyLast est stocké en mémoire (chargé depuis Firestore au login)
// localStorage n'est PAS utilisé pour éviter le contournement par refresh
let dailyLastUsed = null; // format "YYYY-MM-DD"

function getTodayStr() {
  return new Date().toISOString().slice(0, 10);
}

function isDailyAvailable() {
  if (DEV_MODE) return true;
  return dailyLastUsed !== getTodayStr();
}

function markDailyUsed() {
  if (!DEV_MODE) {
    dailyLastUsed = getTodayStr();
    // Sauvegarde immédiate dans Firestore (pas de debounce pour cette valeur critique)
    if (currentUser) {
      db.collection("users").doc(currentUser.uid).update({
        dailyLast: dailyLastUsed
      }).catch(e => console.error("Erreur save dailyLast:", e));
    }
  }
}

let collection = {};
let coins = 0;
let currentUser = null;
let saveTimeout = null;

// ---------------------------------------------------------
// FIREBASE — AUTH + SAUVEGARDE
// ---------------------------------------------------------

// Email admin — seul cet email voit le panneau admin
const ADMIN_EMAIL = "n.totaro31@gmail.com";

function isAdmin() {
  return currentUser && currentUser.email === ADMIN_EMAIL;
}

// Démarrage : attendre l'état d'authentification Firebase
firebase.auth().onAuthStateChanged(async user => {
  if (user) {
    currentUser = user;
    const username = user.displayName || user.email.split("@")[0];
    document.getElementById("header-username").textContent = "👤 " + username;
    document.getElementById("auth-screen").classList.add("hidden");
    document.getElementById("game-client").classList.remove("hidden");

    if (isAdmin()) {
      document.getElementById("admin-nav-btn").classList.remove("hidden");
    }

    await loadProgressFromFirebase();
    await loadPlayersOverrides();

    try {
      await db.collection("users").doc(currentUser.uid).set(
        { username, email: currentUser.email },
        { merge: true }
      );
    } catch(e) {}

    // Marquer le joueur comme connecté (présence temps réel)
    try {
      await db.collection("presence").doc(currentUser.uid).set({
        username,
        connectedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      // Supprimer la présence quand la fenêtre se ferme
      window.addEventListener("beforeunload", () => {
        db.collection("presence").doc(currentUser.uid).delete();
      });
    } catch(e) {}

    init();
  } else {
    // Supprimer la présence à la déconnexion
    if (currentUser) {
      try { await db.collection("presence").doc(currentUser.uid).delete(); } catch(e) {}
    }
    currentUser = null;
    document.getElementById("auth-screen").classList.remove("hidden");
    document.getElementById("game-client").classList.add("hidden");
    document.getElementById("admin-nav-btn").classList.add("hidden");
  }
});

// Charger la progression depuis Firestore
async function loadProgressFromFirebase() {
  try {
    const doc = await db.collection("users").doc(currentUser.uid).get();
    if (doc.exists) {
      const data = doc.data();
      collection = data.collection || {};
      coins = data.coins !== undefined ? data.coins : 200;
      if (data.xvUsed) xvUsedInMemory = true;
      if (data.dailyLast) dailyLastUsed = data.dailyLast;
      // Restaurer l'équipe : on stocke { slotId: "name|team" } et on retrouve le joueur
      if (data.equipe) {
        equipe = {};
        for (const [slotId, key] of Object.entries(data.equipe)) {
          const player = PLAYERS.find(p => getCardKey(p) === key);
          if (player) equipe[slotId] = player;
        }
      }
    } else {
      collection = {};
      coins = 900;
      equipe = {};
      await saveToFirebase();
    }
  } catch(e) {
    console.error("Erreur chargement:", e);
    collection = {};
    coins = 900;
    equipe = {};
  }
}

// Sauvegarder la progression (debounce 1.5s)
function saveData() {
  if (!currentUser) return;
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    try {
      // Sérialiser l'équipe en { slotId: "name|team" }
      const equipeSerialized = {};
      for (const [slotId, player] of Object.entries(equipe)) {
        if (player) equipeSerialized[slotId] = getCardKey(player);
      }
      await db.collection("users").doc(currentUser.uid).set({
        collection,
        coins,
        equipe: equipeSerialized,
        xvUsed: xvUsedInMemory,
        dailyLast: dailyLastUsed || null,
        lastSaved: firebase.firestore.FieldValue.serverTimestamp()
      });
    } catch(e) {
      console.error("Erreur sauvegarde:", e);
    }
  }, 1500);
}

async function saveToFirebase() {
  if (!currentUser) return;
  try {
    const equipeSerialized = {};
    for (const [slotId, player] of Object.entries(equipe)) {
      if (player) equipeSerialized[slotId] = getCardKey(player);
    }
    await db.collection("users").doc(currentUser.uid).set({
      collection,
      coins,
      equipe: equipeSerialized,
      xvUsed: xvUsedInMemory,
      dailyLast: dailyLastUsed || null,
      lastSaved: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch(e) {
    console.error("Erreur sauvegarde:", e);
  }
}

// ---------------------------------------------------------
// AUTHENTIFICATION
// ---------------------------------------------------------

// Charger et appliquer les modifications de joueurs faites par l'admin
async function loadPlayersOverrides() {
  try {
    const doc = await db.collection("playersOverrides").doc("data").get();
    if (!doc.exists) return;
    const data = doc.data();

    // Helper local pour ne pas dépendre de getCardKey
    const makeKey = p => `${p.name}|${p.team}`;

    // Appliquer les suppressions
    if (data.removed && data.removed.length > 0) {
      const removedSet = new Set(data.removed);
      for (let i = PLAYERS.length - 1; i >= 0; i--) {
        if (removedSet.has(makeKey(PLAYERS[i]))) {
          PLAYERS.splice(i, 1);
        }
      }
    }

    // Appliquer les ajouts (en évitant les doublons)
    if (data.added && data.added.length > 0) {
      const existingKeys = new Set(PLAYERS.map(p => makeKey(p)));
      data.added.forEach(player => {
        if (!existingKeys.has(makeKey(player))) {
          PLAYERS.push(player);
        }
      });
    }

    console.log(`✓ Overrides : ${data.added?.length||0} ajouts, ${data.removed?.length||0} suppressions`);

    // Appliquer les modifications de joueurs existants
    if (data.edited && data.edited.length > 0) {
      data.edited.forEach(edit => {
        const idx = PLAYERS.findIndex(p => makeKey(p) === edit.key);
        if (idx >= 0) {
          if (edit.team) PLAYERS[idx].team = edit.team;
          if (edit.rarity) PLAYERS[idx].rarity = edit.rarity;
          if (edit.positions) PLAYERS[idx].positions = edit.positions;
        }
      });
      console.log(`✓ ${data.edited.length} modification(s) appliquée(s)`);
    }
  } catch(e) {
    console.warn("Overrides non chargés:", e.message);
  }
}

// Sauvegarder les overrides dans Firestore (admin seulement)
async function savePlayersOverrides(addedPlayers, removedKeys) {
  try {
    await db.collection("playersOverrides").doc("data").set({
      added: addedPlayers,
      removed: removedKeys,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy: "ChocoDeLaVega"
    });
    console.log("✓ Overrides sauvegardés");
  } catch(e) {
    console.error("Erreur sauvegarde overrides:", e);
    throw e;
  }
}

function setupAuth() {
  document.getElementById("tab-login-btn").addEventListener("click", () => {
    document.getElementById("tab-login-btn").classList.add("active");
    document.getElementById("tab-register-btn").classList.remove("active");
    document.getElementById("form-login").classList.remove("hidden");
    document.getElementById("form-register").classList.add("hidden");
    document.getElementById("login-error").textContent = "";
  });

  document.getElementById("tab-register-btn").addEventListener("click", () => {
    document.getElementById("tab-register-btn").classList.add("active");
    document.getElementById("tab-login-btn").classList.remove("active");
    document.getElementById("form-register").classList.remove("hidden");
    document.getElementById("form-login").classList.add("hidden");
    document.getElementById("register-error").textContent = "";
  });

  // Connexion
  document.getElementById("login-btn").addEventListener("click", async () => {
    const email = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-password").value;
    const errEl = document.getElementById("login-error");
    errEl.textContent = "";
    if (!email || !password) { errEl.textContent = "Remplis tous les champs."; return; }
    setAuthLoading(true);
    try {
      await firebase.auth().signInWithEmailAndPassword(email, password);
    } catch(e) {
      setAuthLoading(false);
      errEl.textContent = getAuthError(e.code);
    }
  });

  // Inscription
  document.getElementById("register-btn").addEventListener("click", async () => {
    const username = document.getElementById("register-username").value.trim();
    const email = document.getElementById("register-email").value.trim();
    const password = document.getElementById("register-password").value;
    const confirm = document.getElementById("register-confirm").value;
    const errEl = document.getElementById("register-error");
    errEl.textContent = "";

    if (!username) { errEl.textContent = "Choisis un nom d'utilisateur."; return; }
    if (!email) { errEl.textContent = "Entre ton adresse email."; return; }
    if (password.length < 6) { errEl.textContent = "Mot de passe : 6 caractères minimum."; return; }
    if (password !== confirm) { errEl.textContent = "Les mots de passe ne correspondent pas."; return; }

    setAuthLoading(true);
    try {
      const cred = await firebase.auth().createUserWithEmailAndPassword(email, password);
      await cred.user.updateProfile({ displayName: username });
    } catch(e) {
      setAuthLoading(false);
      errEl.textContent = getAuthError(e.code);
    }
  });

  // Touche Entrée dans les champs
  ["login-email","login-password"].forEach(id => {
    document.getElementById(id).addEventListener("keydown", e => {
      if (e.key === "Enter") document.getElementById("login-btn").click();
    });
  });

  // Mot de passe oublié
  document.getElementById("forgot-password-btn").addEventListener("click", async () => {
    const email = document.getElementById("login-email").value.trim();
    const statusEl = document.getElementById("forgot-status");
    const errEl = document.getElementById("login-error");
    errEl.textContent = "";
    statusEl.textContent = "";
    if (!email) {
      errEl.textContent = "Entre ton email ci-dessus pour réinitialiser ton mot de passe.";
      return;
    }
    try {
      await firebase.auth().sendPasswordResetEmail(email);
      statusEl.textContent = `✓ Email envoyé à ${email} — vérifie ta boîte de réception.`;
    } catch(e) {
      errEl.textContent = getAuthError(e.code);
    }
  });

  // Déconnexion
  document.getElementById("logout-btn").addEventListener("click", async () => {
    if (confirm("Se déconnecter de Rugbix ?")) {
      await saveToFirebase(); // Sauvegarde finale avant déco
      await firebase.auth().signOut();
      collection = {};
      coins = 0;
    }
  });
}

function setAuthLoading(show) {
  document.getElementById("auth-loading").classList.toggle("hidden", !show);
  const activeForm = document.getElementById("form-login").classList.contains("hidden")
    ? "form-register" : "form-login";
  document.getElementById(activeForm).style.opacity = show ? "0.4" : "1";
  document.getElementById(activeForm).style.pointerEvents = show ? "none" : "auto";
}

function getAuthError(code) {
  const msgs = {
    "auth/invalid-email":        "Adresse email invalide.",
    "auth/user-not-found":       "Aucun compte avec cet email.",
    "auth/wrong-password":       "Mot de passe incorrect.",
    "auth/invalid-credential":   "Email ou mot de passe incorrect.",
    "auth/email-already-in-use": "Cet email est déjà utilisé.",
    "auth/weak-password":        "Mot de passe trop faible.",
    "auth/too-many-requests":    "Trop de tentatives. Réessaie plus tard.",
    "auth/network-request-failed":"Erreur réseau. Vérifie ta connexion."
  };
  return msgs[code] || "Erreur : " + code;
}

// ---------------------------------------------------------
// INITIALISATION (après connexion Firebase)
// ---------------------------------------------------------
function init() {
  renderPacks();
  renderCollection();
  updateCoinsDisplay();
  setupTabs();
  setupModal();
  setupCardDetailModal();
  setupSellConfirmModal();
  setupCoinsButton();
  setupGiftListener();
  setupGiftModal();
}

// ---------------------------------------------------------
// SYSTÈME DE CADEAUX EN TEMPS RÉEL
// ---------------------------------------------------------
function setupGiftListener() {
  if (!currentUser) return;

  // Écoute la sous-collection "gifts" du joueur en temps réel
  db.collection("users").doc(currentUser.uid).collection("gifts")
    .where("seen", "==", false)
    .onSnapshot(async snapshot => {
      for (const change of snapshot.docChanges()) {
        if (change.type === "added") {
          const gift = change.doc.data();
          const giftId = change.doc.id;

          // Appliquer le cadeau à la progression locale
          await applyGift(gift);

          // Marquer comme vu
          await db.collection("users").doc(currentUser.uid)
            .collection("gifts").doc(giftId).update({ seen: true });

          // Afficher la modale
          showGiftModal(gift);
        }
      }
    });
}

async function applyGift(gift) {
  if (gift.type === "coins") {
    coins += gift.amount;
    updateCoinsDisplay();
    saveData();
    renderPacks();

  } else if (gift.type === "card") {
    const player = PLAYERS.find(p => getCardKey(p) === gift.cardKey);
    if (player) {
      // addCardToCollection horodate automatiquement si c'est une nouvelle carte
      addCardToCollection(player, false);
      saveData();
      renderCollection();
    }

  } else if (gift.type === "pack") {
    // Les cartes ont été ajoutées dans Firestore par l'admin
    // On recharge depuis Firebase puis on horodate les nouvelles cartes
    const keysBefore = new Set(Object.keys(collection));
    await loadProgressFromFirebase();

    // Horodater toutes les cartes qui n'existaient pas avant
    const now = Date.now();
    let changed = false;
    if (gift.cards && gift.cards.length > 0) {
      gift.cards.forEach(cardKey => {
        if (!keysBefore.has(cardKey) && collection[cardKey]) {
          if (!collection[cardKey].obtainedAt) {
            collection[cardKey].obtainedAt = now;
            changed = true;
          }
        }
      });
    } else {
      // Fallback : horodater toutes les nouvelles entrées
      Object.keys(collection).forEach(key => {
        if (!keysBefore.has(key) && collection[key] && !collection[key].obtainedAt) {
          collection[key].obtainedAt = now;
          changed = true;
        }
      });
    }
    if (changed) saveData();
    renderCollection();
    updateCoinsDisplay();
  }
}

function showGiftModal(gift) {
  const body = document.getElementById("gift-body");
  const modalContent = document.querySelector(".gift-modal-content");
  body.innerHTML = "";

  if (gift.type === "coins") {
    modalContent.style.width = "340px";
    body.innerHTML = `
      <div class="gift-coins">
        <div class="gift-coins-amount">+${gift.amount}</div>
        <div class="gift-coins-label"><span class="rubiz-symbol">R</span> RUGBIZ</div>
      </div>`;

  } else if (gift.type === "card") {
    modalContent.style.width = "220px";
    const player = PLAYERS.find(p => getCardKey(p) === gift.cardKey);
    if (player) {
      const cardEl = buildCardElement(player, null, {});
      cardEl.style.animation = "revealCard 0.4s ease forwards";
      cardEl.style.opacity = "0";
      body.appendChild(cardEl);
    } else {
      body.innerHTML = `<p style="color:#666">Une nouvelle carte a été ajoutée à ta collection !</p>`;
    }

  } else if (gift.type === "pack") {
    const pack = PACKS.find(p => p.id === gift.packId);
    const cardKeys = gift.cards || [];
    const count = cardKeys.length;

    // Largeur dynamique : max 5 cartes par ligne, chaque carte ~148px + gap
    const CARD_W = 148;
    const GAP = 12;
    const cols = Math.min(count, 5);
    const gridW = cols * CARD_W + (cols - 1) * GAP;
    const totalW = Math.min(gridW + 48, window.innerWidth * 0.94);
    modalContent.style.width = totalW + "px";

    body.innerHTML = `<div class="gift-pack-name">${pack?.name || "Un pack"} — ${count} carte${count>1?"s":""}</div>`;

    if (count > 0) {
      const grid = document.createElement("div");
      grid.className = "gift-cards-grid";
      grid.style.gridTemplateColumns = `repeat(${cols}, ${CARD_W}px)`;

      cardKeys.forEach((cardKey, index) => {
        const player = PLAYERS.find(p => getCardKey(p) === cardKey);
        if (player) {
          const el = buildCardElement(player, null, {});
          el.style.animation = `revealCard 0.4s ease ${index * 0.08}s forwards`;
          el.style.opacity = "0";
          grid.appendChild(el);
        }
      });
      body.appendChild(grid);
    }
  }

  document.getElementById("gift-modal").classList.remove("hidden");
}

function setupGiftModal() {
  document.getElementById("close-gift-btn").addEventListener("click", () => {
    document.getElementById("gift-modal").classList.add("hidden");
  });
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
  const btn = document.getElementById("add-coins-btn");
  // Visible uniquement pour l'admin en DEV_MODE
  function updateBtnVisibility() {
    btn.style.display = (isAdmin() && DEV_MODE) ? "inline-block" : "none";
  }
  updateBtnVisibility();
  window._updateCoinsBtnVisibility = updateBtnVisibility; // appelé au toggle DEV_MODE

  btn.addEventListener("click", () => {
    if (!isAdmin() || !DEV_MODE) return;
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
      if (btn.dataset.tab === "admin" && isAdmin()) renderAdmin();
    });
  });

  // Mon Club
  document.getElementById("sort-select").addEventListener("change", () => {
    updateSecondaryFilters("collection");
    renderCollection();
  });
  document.getElementById("position-filter-select").addEventListener("change", renderCollection);
  document.getElementById("club-filter-select").addEventListener("change", () => {
    updatePosteFilterForClub("collection");
    renderCollection();
  });
  document.getElementById("poste-filter-select").addEventListener("change", renderCollection);

  // Album
  document.getElementById("album-sort-select").addEventListener("change", () => {
    updateSecondaryFilters("album");
    renderAlbum();
  });
  document.getElementById("album-position-filter-select").addEventListener("change", renderAlbum);
  document.getElementById("album-club-filter-select").addEventListener("change", () => {
    updatePosteFilterForClub("album");
    renderAlbum();
  });
  document.getElementById("album-poste-filter-select").addEventListener("change", renderAlbum);
}

const POSITION_ORDER = [
  "Pilier", "Talonneur", "Deuxième ligne", "Troisième ligne",
  "Demi de mêlée", "Demi d'ouverture", "Centre", "Ailier", "Arrière"
];

function updateSecondaryFilters(tab) {
  const isAlbum = tab === "album";
  const sortMode = document.getElementById(isAlbum ? "album-sort-select" : "sort-select").value;

  // Sélecteurs
  const posSelect    = document.getElementById(isAlbum ? "album-position-filter-select" : "position-filter-select");
  const clubSelect   = document.getElementById(isAlbum ? "album-club-filter-select" : "club-filter-select");
  const posteSelect  = document.getElementById(isAlbum ? "album-poste-filter-select" : "poste-filter-select");

  // Tout masquer par défaut
  posSelect.classList.add("hidden");
  clubSelect.classList.add("hidden");
  posteSelect.classList.add("hidden");

  if (sortMode === "position") {
    // Filtre poste unique (mode poste)
    const allPositions = new Set();
    const pool = isAlbum ? PLAYERS : PLAYERS.filter(p => getEntry(getCardKey(p)).count > 0);
    pool.forEach(p => (p.positions||[]).forEach(pos => allPositions.add(pos)));
    const sorted = Array.from(allPositions).sort((a,b) => {
      const ia = POSITION_ORDER.indexOf(a), ib = POSITION_ORDER.indexOf(b);
      return (ia===-1?99:ia) - (ib===-1?99:ib);
    });
    posSelect.innerHTML = `<option value="all">Tous les postes</option>` +
      sorted.map(p => `<option value="${p}">${p}</option>`).join("");
    posSelect.classList.remove("hidden");

  } else if (sortMode === "club") {
    // Filtre club + filtre poste secondaire
    const pool = isAlbum ? PLAYERS : PLAYERS.filter(p => getEntry(getCardKey(p)).count > 0);
    const clubs = [...new Set(pool.map(p => p.team))].sort((a,b) =>
      (TEAMS[a]?.name||a).localeCompare(TEAMS[b]?.name||b));
    clubSelect.innerHTML = `<option value="all">Tous les clubs</option>` +
      clubs.map(t => `<option value="${t}">${TEAMS[t]?.name||t}</option>`).join("");
    clubSelect.classList.remove("hidden");
    // Filtre poste visible quand un club est sélectionné
    if (clubSelect.value !== "all") {
      updatePosteFilterForClub(tab);
    }
  }
}

function updatePosteFilterForClub(tab) {
  const isAlbum = tab === "album";
  const clubSelect  = document.getElementById(isAlbum ? "album-club-filter-select" : "club-filter-select");
  const posteSelect = document.getElementById(isAlbum ? "album-poste-filter-select" : "poste-filter-select");
  const clubVal = clubSelect.value;

  if (clubVal === "all") {
    posteSelect.classList.add("hidden");
    return;
  }

  // Joueurs du club sélectionné
  const pool = isAlbum ? PLAYERS : PLAYERS.filter(p => getEntry(getCardKey(p)).count > 0);
  const postes = new Set();
  pool.filter(p => p.team === clubVal).forEach(p => (p.positions||[]).forEach(pos => postes.add(pos)));
  const sorted = Array.from(postes).sort((a,b) => {
    const ia = POSITION_ORDER.indexOf(a), ib = POSITION_ORDER.indexOf(b);
    return (ia===-1?99:ia) - (ib===-1?99:ib);
  });
  posteSelect.innerHTML = `<option value="all">Tous les postes</option>` +
    sorted.map(p => `<option value="${p}">${p}</option>`).join("");
  posteSelect.classList.remove("hidden");
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

  const xvUsed = !DEV_MODE && xvUsedInMemory;
  const dailyAvailable = isDailyAvailable();

  PACKS.forEach(pack => {
    const isXV = pack.id === "xv_demarrage";
    const isDaily = pack.id === "coup_envoi";

    // Masquer le pack XV Démarrage s'il a déjà été utilisé (hors DEV_MODE)
    if (isXV && xvUsed) return;

    const div = document.createElement("div");

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
    if (!DEV_MODE && xvUsedInMemory) return;
    const drawnCards = drawXVDemarrage();
    drawnCards.forEach(card => addCardToCollection(card, true));
    if (!DEV_MODE) {
      xvUsedInMemory = true;
      if (currentUser) {
        db.collection("users").doc(currentUser.uid).update({ xvUsed: true })
          .catch(e => console.error("Erreur save xvUsed:", e));
      }
    }
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
  const isNew = entry.count === 0;
  entry.count += 1;
  if (locked) entry.lockedCount = (entry.lockedCount || 0) + 1;
  // Stocker la date de première acquisition
  if (isNew) entry.obtainedAt = Date.now();
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
  } else if (sortMode === "club") {
    const clubFilter = document.getElementById("club-filter-select")?.value || "all";
    if (clubFilter !== "all") ownedPlayers = ownedPlayers.filter(p => p.team === clubFilter);
    const posteFilter = document.getElementById("poste-filter-select")?.value || "all";
    if (posteFilter !== "all") ownedPlayers = ownedPlayers.filter(p => (p.positions||[]).includes(posteFilter));
  } else if (sortMode === "recent") {
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    ownedPlayers = ownedPlayers.filter(p => (getEntry(getCardKey(p)).obtainedAt||0) >= todayStart.getTime());
    if (ownedPlayers.length === 0) {
      container.innerHTML = `<div class="empty-card">Aucune carte obtenue aujourd'hui.<br>Ouvre un pack pour en avoir !</div>`;
      return;
    }
  }

  sortPlayers(ownedPlayers, sortMode, "collection");

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
      allPlayers = allPlayers.filter(p => (p.positions||[]).includes(posFilter));
    }
  } else if (sortMode === "club") {
    const clubFilter = document.getElementById("album-club-filter-select")?.value || "all";
    if (clubFilter !== "all") {
      allPlayers = allPlayers.filter(p => p.team === clubFilter);
    }
    const posteFilter = document.getElementById("album-poste-filter-select")?.value || "all";
    if (posteFilter !== "all") {
      allPlayers = allPlayers.filter(p => (p.positions||[]).includes(posteFilter));
    }
  } else if (sortMode === "recent") {
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    allPlayers = allPlayers.filter(p => (getEntry(getCardKey(p)).obtainedAt||0) >= todayStart.getTime());
    if (allPlayers.length === 0) {
      container.innerHTML = `<div class="empty-card">Aucune carte obtenue aujourd'hui.<br>Ouvre un pack pour en avoir !</div>`;
      return;
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
// VENTE DE CARTES (locked = 0 RUGBIZ, unlocked = valeur normale)
// ---------------------------------------------------------
function sellCard(key, quantity) {
  const entry = getEntry(key);
  if (entry.count <= 0) return;

  const qty = Math.max(1, Math.min(quantity, entry.count));
  const player = PLAYERS.find(p => getCardKey(p) === key);
  if (!player) return;

  // Cartes vendables normalement (non verrouillées)
  const unlocked = Math.max(0, entry.count - (entry.lockedCount || 0));
  const unlockedSold = Math.min(qty, unlocked);
  const lockedSold = qty - unlockedSold;

  // Déduire du lockedCount si on vend des cartes verrouillées
  entry.count -= qty;
  if (lockedSold > 0) {
    entry.lockedCount = Math.max(0, (entry.lockedCount || 0) - lockedSold);
  }

  if (entry.count <= 0) {
    delete collection[key];
  } else {
    collection[key] = entry;
  }

  // Cartes verrouillées = 0 RUGBIZ, non verrouillées = valeur normale
  coins += RARITIES[player.rarity].sellValue * unlockedSold;

  saveData();
  updateCoinsDisplay();
  renderCollection();
}

// ---------------------------------------------------------
// TRI DE LA COLLECTION
// ---------------------------------------------------------
function sortPlayers(players, mode, tab = "collection") {
  const rarityOrder = ["legendaire", "international", "epique", "rare", "commune"];

  // Tri secondaire par poste :
  // - Album et Équipe : tous les modes sauf alpha
  // - Mon Club (collection) : uniquement le mode rareté
  const applyPosteSecondary = (tab === "album" || tab === "equipe")
    ? (mode !== "alpha" && mode !== "position")
    : (tab === "collection" && mode === "rarity");

  const posteRank = p => {
    const pos = (p.positions || [])[0] || "";
    const i = POSITION_ORDER.indexOf(pos);
    return i === -1 ? 99 : i;
  };

  switch (mode) {
    case "alpha":
      players.sort((a, b) => a.name.localeCompare(b.name));
      break;

    case "club":
      players.sort((a, b) => {
        const teamA = TEAMS[a.team]?.name || a.team;
        const teamB = TEAMS[b.team]?.name || b.team;
        return teamA.localeCompare(teamB) ||
          (applyPosteSecondary ? posteRank(a) - posteRank(b) : 0) ||
          a.name.localeCompare(b.name);
      });
      break;

    case "position":
      players.sort((a, b) =>
        posteRank(a) - posteRank(b) || a.name.localeCompare(b.name)
      );
      break;

    case "nationality":
      players.sort((a, b) =>
        (a.nat || "").localeCompare(b.nat || "") ||
        (applyPosteSecondary ? posteRank(a) - posteRank(b) : 0) ||
        a.name.localeCompare(b.name)
      );
      break;

    case "recent":
      players.sort((a, b) => {
        const entryA = getEntry(getCardKey(a));
        const entryB = getEntry(getCardKey(b));
        return (entryB.obtainedAt || 0) - (entryA.obtainedAt || 0) ||
          (applyPosteSecondary ? posteRank(a) - posteRank(b) : 0);
      });
      break;

    case "rarity":
    default:
      players.sort((a, b) =>
        rarityOrder.indexOf(a.rarity) - rarityOrder.indexOf(b.rarity) ||
        (applyPosteSecondary ? posteRank(a) - posteRank(b) : 0) ||
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
    if (currentDetailQty < entry.count) {
      currentDetailQty++;
      updateCardDetailControls();
    }
  });

  document.getElementById("confirm-sell-btn").addEventListener("click", () => {
    if (!currentDetailKey) return;
    const entry = getEntry(currentDetailKey);
    if (entry.count <= 0) return;

    if (entry.count === 1) {
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
  const lockedCount = entry.lockedCount || 0;
  const maxSellable = Math.max(0, entry.count - lockedCount);
  const totalSellable = entry.count; // locked + unlocked, toutes vendables (locked = 0 RUGBIZ)
  const player = PLAYERS.find(p => getCardKey(p) === currentDetailKey);
  const sellValue = player ? RARITIES[player.rarity].sellValue : 0;

  const sellControls = document.querySelector(".sell-controls");
  const confirmBtn = document.getElementById("confirm-sell-btn");
  const qtyMinus = document.getElementById("qty-minus");
  const qtyPlus = document.getElementById("qty-plus");
  const qtyVal = document.getElementById("qty-value");

  sellControls.classList.remove("hidden");

  if (totalSellable <= 0) {
    // Aucune carte
    qtyVal.textContent = "—";
    qtyMinus.disabled = true;
    qtyPlus.disabled = true;
    confirmBtn.textContent = "Aucune carte à vendre";
    confirmBtn.disabled = true;
    return;
  }

  // Des cartes disponibles (verrouillées ou non)
  qtyVal.textContent = currentDetailQty;
  qtyMinus.disabled = currentDetailQty <= 1;
  qtyPlus.disabled = currentDetailQty >= totalSellable;
  confirmBtn.disabled = false;

  // Calculer la valeur : les cartes non-verrouillées valent sellValue, les verrouillées 0
  // On vend d'abord les non-verrouillées, puis les verrouillées
  const unlockedToSell = Math.min(currentDetailQty, maxSellable);
  const lockedToSell = currentDetailQty - unlockedToSell;
  const totalValue = unlockedToSell * sellValue; // locked = 0 RUGBIZ

  if (lockedCount > 0 && maxSellable <= 0) {
    // Toutes les cartes sont verrouillées
    confirmBtn.innerHTML = `Vendre ${currentDetailQty} 🔒 (+0 <span class="rubiz-symbol">R</span>)`;
  } else {
    confirmBtn.innerHTML = `Vendre ${currentDetailQty} (+${totalValue} <span class="rubiz-symbol">R</span>)`;
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
    saveData();
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
      saveData();
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
      saveData();
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
  saveData();
}


// ---------------------------------------------------------
// PANNEAU ADMIN (ChocoDeLaVega uniquement)
// ---------------------------------------------------------

// Enregistre une action admin dans Firestore
async function logAdminAction(type, details) {
  try {
    await db.collection("adminLogs").add({
      type,
      details,
      at: firebase.firestore.FieldValue.serverTimestamp(),
      by: "ChocoDeLaVega"
    });
  } catch(e) {
    console.warn("Log admin non enregistré (permissions):", e.message);
  }
}
let adminUsers = [];

async function renderAdmin() {
  if (!isAdmin()) return;
  const container = document.getElementById("admin-container");
  container.innerHTML = `<div class="admin-loading">⏳ Chargement...</div>`;

  try {
    const snapshot = await db.collection("users").get();
    adminUsers = [];
    snapshot.forEach(doc => adminUsers.push({ uid: doc.id, ...doc.data() }));
  } catch(e) {
    container.innerHTML = `<div class="admin-error">❌ Erreur : ${e.message}</div>`;
    return;
  }

  const totalCoins = adminUsers.reduce((s,u) => s+(u.coins||0), 0);
  const totalCards = adminUsers.reduce((s,u) => {
    if (!u.collection) return s;
    return s + Object.values(u.collection).reduce((a,e) => a + (typeof e==="object"?(e.count||1):e), 0);
  }, 0);

  const userOptions = adminUsers.map(u =>
    `<option value="${u.uid}">${u.uid===currentUser.uid?"👑":""} ${u.username||"?"} — ${u.coins||0} R</option>`
  ).join("");

  container.innerHTML = `
    <div class="admin-grid">

      <div class="admin-card">
        <h3>📊 Statistiques</h3>
        <div class="admin-stat"><span>Joueurs inscrits</span><strong>${adminUsers.length}</strong></div>
        <div class="admin-stat">
          <span>🟢 Joueurs connectés</span>
          <strong id="admin-online-count" style="color:#05DF72">—</strong>
        </div>
        <div class="admin-stat"><span>RUGBIZ en circulation</span><strong>${totalCoins}</strong></div>
        <div class="admin-stat"><span>Cartes obtenues</span><strong>${totalCards}</strong></div>
        <div class="admin-stat"><span>Joueurs en base</span><strong>${PLAYERS.length}</strong></div>
        <div class="admin-stat"><span>DEV_MODE</span>
          <div style="display:flex;align-items:center;gap:0.6rem">
            <strong id="devmode-label" style="color:${DEV_MODE?"#05DF72":"#ff6b6b"}">${DEV_MODE?"ON":"OFF"}</strong>
            <button id="devmode-toggle-btn" class="admin-btn" style="padding:0.25rem 0.7rem;font-size:0.75rem">${DEV_MODE?"Désactiver":"Activer"}</button>
          </div>
        </div>
      </div>

      <div class="admin-card">
        <h3>💰 Envoyer des RUGBIZ</h3>
        <div class="admin-form">
          <select id="admin-send-coins-user" class="admin-select"><option value="">-- Joueur --</option>${userOptions}</select>
          <div class="admin-row">
            <input type="number" id="admin-coins-amount" class="admin-input" placeholder="Montant" min="1" value="500">
            <button id="admin-send-coins-btn" class="admin-btn">Envoyer</button>
          </div>
          <div id="admin-coins-status" class="admin-status"></div>
        </div>
      </div>

      <div class="admin-card">
        <h3>📦 Envoyer un Pack</h3>
        <div class="admin-form">
          <select id="admin-send-pack-user" class="admin-select"><option value="">-- Joueur --</option>${userOptions}</select>
          <select id="admin-pack-select" class="admin-select">
            ${PACKS.map(p=>`<option value="${p.id}">${p.name}</option>`).join("")}
          </select>
          <button id="admin-send-pack-btn" class="admin-btn">Envoyer le pack</button>
          <div id="admin-pack-status" class="admin-status"></div>
        </div>
      </div>

      <div class="admin-card">
        <h3>🃏 Envoyer une carte</h3>
        <div class="admin-form">
          <select id="admin-send-card-user" class="admin-select"><option value="">-- Joueur --</option>${userOptions}</select>
          <input type="text" id="admin-card-search" class="admin-input" placeholder="🔍 Rechercher (ex: Dupont)">
          <select id="admin-card-select" class="admin-select" size="5" style="height:110px"></select>
          <button id="admin-send-card-btn" class="admin-btn">Envoyer la carte</button>
          <div id="admin-card-status" class="admin-status"></div>
        </div>
      </div>

      <div class="admin-card admin-card-full">
        <h3>⚽ Base de données joueurs</h3>
        <div class="admin-db-tabs">
          <button class="admin-db-tab active" id="admin-tab-add">➕ Ajouter</button>
          <button class="admin-db-tab" id="admin-tab-remove">🗑️ Supprimer</button>
          <button class="admin-db-tab" id="admin-tab-edit">✏️ Modifier</button>
        </div>
        <!-- Formulaire modification -->
        <div id="admin-form-edit" class="admin-db-form hidden">
          <input type="text" id="edit-player-search" class="admin-input" placeholder="🔍 Rechercher un joueur à modifier">
          <select id="edit-player-select" class="admin-select" size="5" style="height:120px"></select>
          <div id="edit-player-fields" class="hidden">
            <div class="admin-edit-sep">Modifier les champs :</div>
            <div class="admin-row">
              <select id="edit-player-team" class="admin-select">
                ${Object.entries(TEAMS).map(([k,v])=>`<option value="${k}">${v.name}</option>`).join("")}
              </select>
              <select id="edit-player-rarity" class="admin-select">
                ${Object.entries(RARITIES).map(([k,v])=>`<option value="${k}">${v.label}</option>`).join("")}
              </select>
            </div>
            <input type="text" id="edit-player-positions" class="admin-input" placeholder="Poste(s) — sépare par | (ex: Pilier|Talonneur)">
            <button id="admin-edit-player-btn" class="admin-btn">💾 Sauvegarder pour tous</button>
            <div id="admin-edit-player-status" class="admin-status"></div>
          </div>
          <p class="admin-note">⚠️ La modification s'applique définitivement pour tous les joueurs via Firestore.</p>
        </div>
        <div id="admin-form-add" class="admin-db-form">
          <div class="admin-row">
            <input type="text" id="new-player-firstname" class="admin-input" placeholder="Prénom">
            <input type="text" id="new-player-lastname" class="admin-input" placeholder="Nom">
          </div>
          <div class="admin-row">
            <select id="new-player-team" class="admin-select">
              ${Object.entries(TEAMS).map(([k,v])=>`<option value="${k}">${v.name}</option>`).join("")}
            </select>
            <select id="new-player-rarity" class="admin-select">
              ${Object.entries(RARITIES).map(([k,v])=>`<option value="${k}">${v.label}</option>`).join("")}
            </select>
          </div>
          <input type="text" id="new-player-positions" class="admin-input" placeholder="Poste(s) — sépare par | (ex: Pilier|Talonneur)">
          <div id="new-player-clubs-row" class="hidden">
            <input type="text" id="new-player-clubs" class="admin-input" placeholder="Club(s) de carrière — sépare par / (ex: toulouse/toulon)">
          </div>
          <div class="admin-row">
            <input type="text" id="new-player-nat" class="admin-input" placeholder="Nationalité (ex: FRA)">
            <button id="admin-add-player-btn" class="admin-btn">Ajouter</button>
          </div>
          <div id="admin-add-player-status" class="admin-status"></div>
          <p class="admin-note">⚠️ Ajout en mémoire uniquement. Ajoute aussi dans Google Sheets pour le rendre permanent.</p>
        </div>
        <div id="admin-form-remove" class="admin-db-form hidden">
          <input type="text" id="remove-player-search" class="admin-input" placeholder="🔍 Rechercher un joueur">
          <select id="remove-player-select" class="admin-select" size="6" style="height:140px"></select>
          <button id="admin-remove-player-btn" class="admin-btn" style="background:#cc0000;color:#fff">Supprimer</button>
          <div id="admin-remove-player-status" class="admin-status"></div>
          <p class="admin-note">⚠️ Suppression en mémoire uniquement. Supprime aussi dans Google Sheets pour le rendre permanent.</p>
        </div>
      </div>

      <div class="admin-card admin-card-full">
        <h3>📋 Historique des actions</h3>
        <div id="admin-history-list" class="admin-history-list">
          <div class="admin-loading">⏳ Chargement de l'historique...</div>
        </div>
      </div>

      <div class="admin-card admin-card-full">
        <h3>👥 Comptes joueurs</h3>
        <div class="admin-users-list">
          ${adminUsers.map(u => {
            const cardCount = u.collection
              ? Object.values(u.collection).reduce((a,e)=>a+(typeof e==="object"?(e.count||1):e),0)
              : 0;
            const isMe = u.uid === currentUser.uid;
            const last = u.lastSaved?.seconds
              ? new Date(u.lastSaved.seconds*1000).toLocaleDateString("fr-FR")
              : "jamais";
            return `<div class="admin-user-row ${isMe?"admin-user-me":""}">
              <span class="admin-user-pseudo">${isMe?"👑":"👤"} <strong>${u.username||"?"}</strong></span>
              <span class="admin-user-email">${u.email||"—"}</span>
              <span class="admin-user-stat">${u.coins||0} R</span>
              <span class="admin-user-stat">${cardCount} cartes</span>
              <span class="admin-user-stat">🕐 ${last}</span>
            </div>`;
          }).join("")}
        </div>
      </div>

    </div>
  `;

  // Pré-remplir la liste de cartes
  refreshAdminCardList("");
  refreshRemovePlayerList("");
  bindAdminEvents();

  // Listener temps réel pour les joueurs connectés
  db.collection("presence").onSnapshot(snap => {
    const el = document.getElementById("admin-online-count");
    if (el) el.textContent = snap.size;
  });
}

function refreshAdminCardList(q) {
  const sel = document.getElementById("admin-card-select");
  if (!sel) return;
  const filtered = PLAYERS.filter(p =>
    !q || p.name.toLowerCase().includes(q.toLowerCase()) ||
    (TEAMS[p.team]?.name||"").toLowerCase().includes(q.toLowerCase())
  ).slice(0, 60);
  sel.innerHTML = filtered.map(p =>
    `<option value="${getCardKey(p)}">${p.name} — ${TEAMS[p.team]?.name||p.team} [${RARITIES[p.rarity]?.label||p.rarity}]</option>`
  ).join("");
}

function refreshRemovePlayerList(q) {
  const sel = document.getElementById("remove-player-select");
  if (!sel) return;
  const filtered = PLAYERS.filter(p =>
    !q || p.name.toLowerCase().includes(q.toLowerCase()) ||
    (TEAMS[p.team]?.name||"").toLowerCase().includes(q.toLowerCase())
  ).slice(0, 60);
  sel.innerHTML = filtered.map(p =>
    `<option value="${getCardKey(p)}">${p.name} — ${TEAMS[p.team]?.name||p.team} [${RARITIES[p.rarity]?.label||p.rarity}]</option>`
  ).join("");
}

function refreshEditPlayerList(q) {
  const sel = document.getElementById("edit-player-select");
  if (!sel) return;
  const filtered = PLAYERS.filter(p =>
    !q || p.name.toLowerCase().includes(q.toLowerCase()) ||
    (TEAMS[p.team]?.name||"").toLowerCase().includes(q.toLowerCase())
  ).slice(0, 60);
  sel.innerHTML = filtered.map(p =>
    `<option value="${getCardKey(p)}">${p.name} — ${TEAMS[p.team]?.name||p.team} [${RARITIES[p.rarity]?.label||p.rarity}]</option>`
  ).join("");
  document.getElementById("edit-player-fields").classList.add("hidden");
}

async function loadAdminHistory() {
  const el = document.getElementById("admin-history-list");
  if (!el) return;

  try {
    const snap = await db.collection("adminLogs")
      .orderBy("at", "desc")
      .limit(50)
      .get();

    if (snap.empty) {
      el.innerHTML = `<div class="admin-history-empty">Aucune action enregistrée.</div>`;
      return;
    }

    const icons = {
      "rugbiz":           "💰",
      "pack":             "📦",
      "carte":            "🃏",
      "joueur_ajouté":    "➕",
      "joueur_supprimé":  "🗑️"
    };

    el.innerHTML = snap.docs.map(doc => {
      const d = doc.data();
      const date = d.at?.seconds
        ? new Date(d.at.seconds * 1000).toLocaleString("fr-FR")
        : "—";
      const icon = icons[d.type] || "📋";
      return `
        <div class="admin-history-row">
          <span class="admin-history-icon">${icon}</span>
          <span class="admin-history-detail">${d.details}</span>
          <span class="admin-history-date">${date}</span>
        </div>`;
    }).join("");
  } catch(e) {
    el.innerHTML = `<div class="admin-loading">❌ ${e.message}</div>`;
  }
}

function bindAdminEvents() {
  // Charger l'historique
  loadAdminHistory();

  // Envoyer RUGBIZ
  document.getElementById("admin-send-coins-btn").onclick = async () => {
    const uid = document.getElementById("admin-send-coins-user").value;
    const amount = parseInt(document.getElementById("admin-coins-amount").value, 10);
    const st = document.getElementById("admin-coins-status");
    if (!uid) { st.textContent = "⚠️ Sélectionne un joueur."; return; }
    if (!amount || amount <= 0) { st.textContent = "⚠️ Montant invalide."; return; }
    st.textContent = "Envoi...";
    try {
      const doc = await db.collection("users").doc(uid).get();
      const newCoins = (doc.data().coins||0) + amount;
      await db.collection("users").doc(uid).update({ coins: newCoins });
      if (uid === currentUser.uid) { coins = newCoins; updateCoinsDisplay(); }
      const pseudo = adminUsers.find(u=>u.uid===uid)?.username||"?";
      st.textContent = `✓ +${amount} RUGBIZ → ${pseudo}`;
      setTimeout(() => renderAdmin(), 2000);
      try { await db.collection("users").doc(uid).collection("gifts").add({ type: "coins", amount, seen: false, sentAt: firebase.firestore.FieldValue.serverTimestamp() }); } catch(_){}
      try { await logAdminAction("rugbiz", `+${amount} RUGBIZ → ${pseudo}`); } catch(_){}
    } catch(e) { st.textContent = "❌ " + e.message; }
  };

  // Envoyer un Pack
  document.getElementById("admin-send-pack-btn").onclick = async () => {
    const uid = document.getElementById("admin-send-pack-user").value;
    const packId = document.getElementById("admin-pack-select").value;
    const st = document.getElementById("admin-pack-status");
    if (!uid) { st.textContent = "⚠️ Sélectionne un joueur."; return; }
    const pack = PACKS.find(p=>p.id===packId);
    if (!pack) return;
    st.textContent = "Envoi...";
    try {
      const doc = await db.collection("users").doc(uid).get();
      const userCollection = doc.data()?.collection || {};
      const drawn = [];
      for (let i = 0; i < pack.cardsCount; i++) {
        drawn.push(pack.forcedRarity ? drawCardOfRarity(pack.forcedRarity) : drawRandomCard(pack));
      }
      const cardKeys = [];
      drawn.forEach(card => {
        const key = getCardKey(card);
        cardKeys.push(key);
        const ex = userCollection[key] || { count:0, lockedCount:0 };
        userCollection[key] = { count:(ex.count||0)+1, lockedCount:ex.lockedCount||0 };
      });
      await db.collection("users").doc(uid).update({ collection: userCollection });
      const pseudo = adminUsers.find(u=>u.uid===uid)?.username||"?";
      st.textContent = `✓ ${pack.name} (${drawn.length} cartes) → ${pseudo}`;
      try { await db.collection("users").doc(uid).collection("gifts").add({ type: "pack", packId, cards: cardKeys, seen: false, sentAt: firebase.firestore.FieldValue.serverTimestamp() }); } catch(_){}
      try { await logAdminAction("pack", `${pack.name} (${drawn.length} cartes) → ${pseudo}`); } catch(_){}
    } catch(e) { st.textContent = "❌ " + e.message; }
  };

  // Recherche carte
  document.getElementById("admin-card-search").oninput = (e) => refreshAdminCardList(e.target.value);

  // Envoyer une carte
  document.getElementById("admin-send-card-btn").onclick = async () => {
    const uid = document.getElementById("admin-send-card-user").value;
    const cardKey = document.getElementById("admin-card-select").value;
    const st = document.getElementById("admin-card-status");
    if (!uid) { st.textContent = "⚠️ Sélectionne un joueur."; return; }
    if (!cardKey) { st.textContent = "⚠️ Sélectionne une carte."; return; }
    st.textContent = "Envoi...";
    try {
      const doc = await db.collection("users").doc(uid).get();
      const userCollection = doc.data()?.collection || {};
      const ex = userCollection[cardKey] || { count:0, lockedCount:0 };
      userCollection[cardKey] = { count:(ex.count||0)+1, lockedCount:ex.lockedCount||0 };
      await db.collection("users").doc(uid).update({ collection: userCollection });
      const player = PLAYERS.find(p=>getCardKey(p)===cardKey);
      const pseudo = adminUsers.find(u=>u.uid===uid)?.username||"?";
      st.textContent = `✓ ${player?.name} → ${pseudo}`;
      try { await db.collection("users").doc(uid).collection("gifts").add({ type: "card", cardKey, seen: false, sentAt: firebase.firestore.FieldValue.serverTimestamp() }); } catch(_){}
      try { await logAdminAction("carte", `${player?.name} → ${pseudo}`); } catch(_){}
      await logAdminAction("carte", `${player?.name} \u2192 ${pseudo}`);
      st.textContent = `✓ ${player?.name} → ${pseudo}`;
    } catch(e) { st.textContent = "❌ " + e.message; }
  };

  // Toggle DEV_MODE
  document.getElementById("devmode-toggle-btn").onclick = () => {
    DEV_MODE = !DEV_MODE;
    document.getElementById("devmode-label").textContent = DEV_MODE ? "ON" : "OFF";
    document.getElementById("devmode-label").style.color = DEV_MODE ? "#05DF72" : "#ff6b6b";
    document.getElementById("devmode-toggle-btn").textContent = DEV_MODE ? "Désactiver" : "Activer";
    if (window._updateCoinsBtnVisibility) window._updateCoinsBtnVisibility();
  };

  // Tabs add/remove
  document.getElementById("admin-tab-add").onclick = () => {
    document.getElementById("admin-tab-add").classList.add("active");
    document.getElementById("admin-tab-remove").classList.remove("active");
    document.getElementById("admin-tab-edit").classList.remove("active");
    document.getElementById("admin-form-add").classList.remove("hidden");
    document.getElementById("admin-form-remove").classList.add("hidden");
    document.getElementById("admin-form-edit").classList.add("hidden");
  };
  document.getElementById("admin-tab-remove").onclick = () => {
    document.getElementById("admin-tab-remove").classList.add("active");
    document.getElementById("admin-tab-add").classList.remove("active");
    document.getElementById("admin-tab-edit").classList.remove("active");
    document.getElementById("admin-form-remove").classList.remove("hidden");
    document.getElementById("admin-form-add").classList.add("hidden");
    document.getElementById("admin-form-edit").classList.add("hidden");
  };
  document.getElementById("admin-tab-edit").onclick = () => {
    document.getElementById("admin-tab-edit").classList.add("active");
    document.getElementById("admin-tab-add").classList.remove("active");
    document.getElementById("admin-tab-remove").classList.remove("active");
    document.getElementById("admin-form-edit").classList.remove("hidden");
    document.getElementById("admin-form-add").classList.add("hidden");
    document.getElementById("admin-form-remove").classList.add("hidden");
    refreshEditPlayerList("");
  };

  // Afficher champ clubs si rareté = legendaire
  document.getElementById("new-player-rarity").onchange = (e) => {
    const clubsRow = document.getElementById("new-player-clubs-row");
    if (clubsRow) clubsRow.classList.toggle("hidden", e.target.value !== "legendaire");
  };

  // Ajouter joueur (prénom + nom + clubs)
  document.getElementById("admin-add-player-btn").onclick = async () => {
    const firstname = document.getElementById("new-player-firstname").value.trim();
    const lastname  = document.getElementById("new-player-lastname").value.trim();
    const name = [firstname, lastname].filter(Boolean).join(" ");
    const team = document.getElementById("new-player-team").value;
    const rarity = document.getElementById("new-player-rarity").value;
    const positions = document.getElementById("new-player-positions").value.split("|").map(p=>p.trim()).filter(Boolean);
    const nat = document.getElementById("new-player-nat").value.trim() || "FRA";
    const clubsInput = document.getElementById("new-player-clubs");
    const clubs = (rarity === "legendaire" && clubsInput?.value)
      ? clubsInput.value.split("/").map(c=>c.trim()).filter(Boolean)
      : undefined;
    const st = document.getElementById("admin-add-player-status");

    if (!name) { st.textContent = "⚠️ Entre un prénom ou un nom."; return; }
    if (!positions.length) { st.textContent = "⚠️ Entre au moins un poste."; return; }

    const newPlayer = { name, team, positions, rarity, nat };
    if (clubs?.length) newPlayer.clubs = clubs;

    st.textContent = "Sauvegarde en cours...";
    try {
      // Charger les overrides existants
      const doc = await db.collection("playersOverrides").doc("data").get();
      const existing = doc.exists ? doc.data() : { added: [], removed: [] };
      const added = existing.added || [];
      const removed = existing.removed || [];

      // Vérifier pas de doublon
      const newKey = getCardKey(newPlayer);
      if (added.some(p => getCardKey(p) === newKey)) {
        st.textContent = "⚠️ Ce joueur existe déjà dans les ajouts.";
        return;
      }

      added.push(newPlayer);
      await savePlayersOverrides(added, removed);

      // Appliquer localement
      PLAYERS.push(newPlayer);
      st.textContent = `✓ ${name} (${TEAMS[team]?.name||team}, ${rarity}) ajouté pour tous !`;
      try { await logAdminAction("joueur_ajouté", `${name} — ${TEAMS[team]?.name||team} [${rarity}]`); } catch(_) {}
    } catch(e) {
      st.textContent = `❌ Erreur : ${e.message}`;
    }

    // Reset form
    document.getElementById("new-player-firstname").value = "";
    document.getElementById("new-player-lastname").value = "";
    document.getElementById("new-player-positions").value = "";
    document.getElementById("new-player-nat").value = "";
    if (clubsInput) clubsInput.value = "";
  };

  // Recherche suppression
  document.getElementById("remove-player-search").oninput = (e) => refreshRemovePlayerList(e.target.value);

  // Supprimer joueur
  document.getElementById("admin-remove-player-btn").onclick = async () => {
    const key = document.getElementById("remove-player-select").value;
    const st = document.getElementById("admin-remove-player-status");
    if (!key) { st.textContent = "⚠️ Sélectionne un joueur."; return; }
    const idx = PLAYERS.findIndex(p => getCardKey(p) === key);
    if (idx === -1) { st.textContent = "⚠️ Introuvable."; return; }
    const name = PLAYERS[idx].name;

    st.textContent = "Sauvegarde en cours...";
    try {
      const doc = await db.collection("playersOverrides").doc("data").get();
      const existing = doc.exists ? doc.data() : { added: [], removed: [] };
      let added = existing.added || [];
      const removed = existing.removed || [];

      // Retirer des ajouts si c'était un joueur ajouté par l'admin
      added = added.filter(p => getCardKey(p) !== key);

      // Ajouter à la liste des suppressions (seulement si pas déjà dedans)
      if (!removed.includes(key)) removed.push(key);

      await savePlayersOverrides(added, removed);

      // Appliquer localement
      PLAYERS.splice(idx, 1);
      st.textContent = `✓ ${name} supprimé pour tous !`;
      try { await logAdminAction("joueur_supprimé", `${name}`); } catch(_) {}
      refreshRemovePlayerList("");
    } catch(e) {
      st.textContent = `❌ Erreur : ${e.message}`;
    }
  };

  // === Modifier joueur ===
  document.getElementById("edit-player-search").oninput = (e) => refreshEditPlayerList(e.target.value);

  document.getElementById("edit-player-select").onchange = () => {
    const key = document.getElementById("edit-player-select").value;
    if (!key) { document.getElementById("edit-player-fields").classList.add("hidden"); return; }
    const player = PLAYERS.find(p => `${p.name}|${p.team}` === key);
    if (!player) return;

    // Pré-remplir les champs avec les valeurs actuelles
    document.getElementById("edit-player-team").value = player.team;
    document.getElementById("edit-player-rarity").value = player.rarity;
    document.getElementById("edit-player-positions").value = (player.positions||[]).join("|");
    document.getElementById("edit-player-fields").classList.remove("hidden");
    document.getElementById("admin-edit-player-status").textContent = "";
  };

  document.getElementById("admin-edit-player-btn").onclick = async () => {
    const key = document.getElementById("edit-player-select").value;
    const st = document.getElementById("admin-edit-player-status");
    if (!key) { st.textContent = "⚠️ Sélectionne un joueur."; return; }

    const newTeam = document.getElementById("edit-player-team").value;
    const newRarity = document.getElementById("edit-player-rarity").value;
    const newPositions = document.getElementById("edit-player-positions").value
      .split("|").map(p=>p.trim()).filter(Boolean);

    if (!newPositions.length) { st.textContent = "⚠️ Entre au moins un poste."; return; }

    st.textContent = "Sauvegarde en cours...";
    try {
      // Charger les overrides existants
      const doc = await db.collection("playersOverrides").doc("data").get();
      const existing = doc.exists ? doc.data() : { added: [], removed: [] };
      const added = existing.added || [];
      const removed = existing.removed || [];

      // Stocker les modifications dans un champ "edited"
      const edited = existing.edited || [];
      const editIdx = edited.findIndex(e => e.key === key);
      const editEntry = { key, team: newTeam, rarity: newRarity, positions: newPositions };
      if (editIdx >= 0) edited[editIdx] = editEntry;
      else edited.push(editEntry);

      await db.collection("playersOverrides").doc("data").set(
        { added, removed, edited, updatedAt: firebase.firestore.FieldValue.serverTimestamp(), updatedBy: "ChocoDeLaVega" }
      );

      // Appliquer localement immédiatement
      const idx = PLAYERS.findIndex(p => `${p.name}|${p.team}` === key);
      if (idx >= 0) {
        PLAYERS[idx].team = newTeam;
        PLAYERS[idx].rarity = newRarity;
        PLAYERS[idx].positions = newPositions;
      }

      const playerName = key.split("|")[0];
      st.textContent = `✓ ${playerName} modifié pour tous !`;
      try { await logAdminAction("joueur_modifié", `${playerName} → club:${TEAMS[newTeam]?.name||newTeam}, rareté:${newRarity}`); } catch(_) {}
    } catch(e) {
      st.textContent = `❌ Erreur : ${e.message}`;
    }
  };
}

// ---------------------------------------------------------
// LANCEMENT
// ---------------------------------------------------------
setupAuth();
setupLegalModals();

function setupLegalModals() {
  // Mentions légales
  document.getElementById("footer-mentions-btn").addEventListener("click", () => {
    document.getElementById("mentions-modal").classList.remove("hidden");
  });
  document.getElementById("close-mentions-btn").addEventListener("click", () => {
    document.getElementById("mentions-modal").classList.add("hidden");
  });

  // Confidentialité
  document.getElementById("footer-privacy-btn").addEventListener("click", () => {
    document.getElementById("privacy-modal").classList.remove("hidden");
  });
  document.getElementById("close-privacy-btn").addEventListener("click", () => {
    document.getElementById("privacy-modal").classList.add("hidden");
  });

  // Contact
  document.getElementById("footer-contact-btn").addEventListener("click", () => {
    // Pré-remplir le pseudo si connecté
    if (currentUser) {
      const pseudo = currentUser.displayName || currentUser.email.split("@")[0];
      document.getElementById("contactName").value = pseudo;
      document.getElementById("contactEmail").value = currentUser.email;
    }
    document.getElementById("contactSuccess").classList.add("hidden");
    document.getElementById("contact-modal").classList.remove("hidden");
  });
  document.getElementById("close-contact-btn").addEventListener("click", () => {
    document.getElementById("contact-modal").classList.add("hidden");
  });

  // Soumission du formulaire contact via FormSubmit (AJAX)
  document.getElementById("contactForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = form.querySelector(".contact-submit-btn");
    btn.textContent = "Envoi en cours...";
    btn.disabled = true;

    try {
      await fetch(form.action, {
        method: "POST",
        body: new FormData(form),
        headers: { "Accept": "application/json" }
      });
      form.reset();
      document.getElementById("contactSuccess").classList.remove("hidden");
    } catch(err) {
      document.getElementById("contactSuccess").textContent = "❌ Erreur d'envoi. Réessaie plus tard.";
      document.getElementById("contactSuccess").classList.remove("hidden");
    }
    btn.textContent = "Envoyer";
    btn.disabled = false;
  });

  // Fermer en cliquant sur le fond
  ["mentions-modal", "privacy-modal", "contact-modal"].forEach(id => {
    document.getElementById(id).addEventListener("click", (e) => {
      if (e.target === e.currentTarget) e.currentTarget.classList.add("hidden");
    });
  });
}
