// =========================================================
// LOGIQUE DU JEU - RUGBIX
// =========================================================

// Copie de la base d'origine (data.js) AVANT l'application des modifications Firestore.
// Sert, lors d'un import, à calculer ce qui doit être enregistré dans playersOverrides.
const BASE_PLAYERS = JSON.parse(JSON.stringify(PLAYERS));

// xvUsed stocké en mémoire (chargé depuis Firestore au login)
let xvUsedInMemory = false;
// ⚙️ DEV_MODE — toggleable depuis le panneau admin
let DEV_MODE = false;


// dailyLast est stocké en mémoire (chargé depuis Firestore au login)
// localStorage n'est PAS utilisé pour éviter le contournement par refresh
let dailyLastUsed = null;

// Date (jour local) du dernier achat du Pack Club — chargée depuis Firestore
let clubPackLast = null; // format "YYYY-MM-DD"

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

    // Marquer le joueur comme connecté (présence temps réel avec heartbeat)
    startPresenceHeartbeat(username);

    init();

    // Activer la synchronisation temps réel entre appareils (PC / mobile)
    setupProgressSync();
  } else {
    // Arrêter la synchronisation temps réel
    if (progressUnsubscribe) { progressUnsubscribe(); progressUnsubscribe = null; }
    // Arrêter le heartbeat et supprimer la présence à la déconnexion
    stopPresenceHeartbeat();
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
// Écouteur temps réel : synchronise la progression entre PC/mobile automatiquement
let progressUnsubscribe = null;
let isSavingLocally = false; // évite de re-déclencher un rendu pendant qu'on sauvegarde nous-même

// ---------------------------------------------------------
// PRÉSENCE EN TEMPS RÉEL (heartbeat)
// ---------------------------------------------------------
const PRESENCE_HEARTBEAT_MS = 25000;  // rafraîchit toutes les 25s
const PRESENCE_STALE_MS = 60000;      // considéré hors ligne après 60s sans heartbeat
let presenceInterval = null;
let presenceListenerUnsubscribe = null;

async function writePresence(username) {
  if (!currentUser) return;
  try {
    await db.collection("presence").doc(currentUser.uid).set({
      username,
      lastSeen: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch(e) {
    console.warn("Présence non écrite:", e.message);
  }
}

function startPresenceHeartbeat(username) {
  stopPresenceHeartbeat();
  writePresence(username); // écriture immédiate
  presenceInterval = setInterval(() => writePresence(username), PRESENCE_HEARTBEAT_MS);

  // Rafraîchir aussi quand l'onglet redevient visible (utile sur mobile après mise en veille)
  document.addEventListener("visibilitychange", handleVisibilityForPresence);
  window.addEventListener("beforeunload", handleUnloadForPresence);
}

function stopPresenceHeartbeat() {
  if (presenceInterval) {
    clearInterval(presenceInterval);
    presenceInterval = null;
  }
  document.removeEventListener("visibilitychange", handleVisibilityForPresence);
  window.removeEventListener("beforeunload", handleUnloadForPresence);
}

function handleVisibilityForPresence() {
  if (document.visibilityState === "visible" && currentUser) {
    const username = currentUser.displayName || currentUser.email.split("@")[0];
    writePresence(username);
  }
}

function handleUnloadForPresence() {
  if (currentUser) {
    // Best-effort : peu fiable sur mobile, mais le heartbeat stale-check compense déjà
    db.collection("presence").doc(currentUser.uid).delete().catch(() => {});
  }
}

function setupProgressSync() {
  if (!currentUser) return;
  if (progressUnsubscribe) progressUnsubscribe(); // éviter les doublons d'écoute

  progressUnsubscribe = db.collection("users").doc(currentUser.uid)
    .onSnapshot(doc => {
      if (!doc.exists) return;
      // Ignore les mises à jour qui viennent de notre propre sauvegarde en cours
      if (isSavingLocally) return;

      const data = doc.data();
      collection = data.collection || {};
      coins = data.coins !== undefined ? data.coins : coins;
      if (data.xvUsed) xvUsedInMemory = true;
      if (data.dailyLast) dailyLastUsed = data.dailyLast;
      if (data.clubPackLast) clubPackLast = data.clubPackLast;
      if (data.banc && BANC_CONFIGS[data.banc]) currentBanc = data.banc;

      if (data.equipe) {
        equipe = {};
        for (const [slotId, key] of Object.entries(data.equipe)) {
          const player = PLAYERS.find(p => getCardKey(p) === key);
          if (player) equipe[slotId] = player;
        }
      } else {
        equipe = {};
      }

      // Rafraîchir l'affichage si le jeu est déjà démarré
      if (document.getElementById("game-client") && !document.getElementById("game-client").classList.contains("hidden")) {
        updateCoinsDisplay();
        renderPacks();
        // Ne re-render que l'onglet actuellement visible pour éviter les à-coups
        const activeTab = document.querySelector(".nav-btn.active")?.dataset.tab;
        if (activeTab === "collection") renderCollection();
        if (activeTab === "album") renderAlbum();
        if (activeTab === "equipe") renderEquipe();
      }
    }, err => {
      console.warn("Sync temps réel indisponible:", err.message);
    });
}

async function loadProgressFromFirebase() {
  try {
    const doc = await db.collection("users").doc(currentUser.uid).get();
    if (doc.exists) {
      const data = doc.data();
      collection = data.collection || {};
      coins = data.coins !== undefined ? data.coins : 200;
      if (data.xvUsed) xvUsedInMemory = true;
      if (data.dailyLast) dailyLastUsed = data.dailyLast;
      clubPackLast = data.clubPackLast || null;
      if (data.banc && BANC_CONFIGS[data.banc]) currentBanc = data.banc;
      // Restaurer l'équipe : on stocke { slotId: "name|team" } et on retrouve le joueur
      if (data.equipe) {
        equipe = {};
        for (const [slotId, key] of Object.entries(data.equipe)) {
          const player = PLAYERS.find(p => getCardKey(p) === key);
          if (player) equipe[slotId] = player;
        }
      }
      // Historique des matchs (les 10 plus récents) et statistiques cumulées
      matchHistory = Array.isArray(data.matchHistory) ? data.matchHistory : [];
      matchStats = data.matchStats || { played: 0, wins: 0, draws: 0, losses: 0 };
    } else {
      collection = {};
      coins = 900;
      equipe = {};
      currentBanc = "5-3";
      matchHistory = [];
      matchStats = { played: 0, wins: 0, draws: 0, losses: 0 };
      await saveToFirebase();
    }
  } catch(e) {
    console.error("Erreur chargement:", e);
    collection = {};
    coins = 900;
    equipe = {};
    matchHistory = [];
    matchStats = { played: 0, wins: 0, draws: 0, losses: 0 };
  }
}

// Sauvegarder la progression (debounce 1.5s) — merge pour ne jamais écraser d'autres champs
function saveData() {
  if (!currentUser) return;
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    try {
      isSavingLocally = true;
      // Sérialiser l'équipe en { slotId: "name|team" }
      const equipeSerialized = {};
      for (const [slotId, player] of Object.entries(equipe)) {
        if (player) equipeSerialized[slotId] = getCardKey(player);
      }
      await db.collection("users").doc(currentUser.uid).set({
        collection,
        coins,
        equipe: equipeSerialized,
        banc: currentBanc,
        xvUsed: xvUsedInMemory,
        dailyLast: dailyLastUsed || null,
        clubPackLast: clubPackLast || null,
        matchHistory,
        matchStats,
        lastSaved: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } catch(e) {
      console.error("Erreur sauvegarde:", e);
    } finally {
      // Petit délai avant de réactiver l'écoute, pour laisser Firestore propager
      setTimeout(() => { isSavingLocally = false; }, 800);
    }
  }, 1500);
}

async function saveToFirebase() {
  if (!currentUser) return;
  try {
    isSavingLocally = true;
    const equipeSerialized = {};
    for (const [slotId, player] of Object.entries(equipe)) {
      if (player) equipeSerialized[slotId] = getCardKey(player);
    }
    await db.collection("users").doc(currentUser.uid).set({
      collection,
      coins,
      equipe: equipeSerialized,
      banc: currentBanc,
      xvUsed: xvUsedInMemory,
      dailyLast: dailyLastUsed || null,
        clubPackLast: clubPackLast || null,
      matchHistory,
      matchStats,
      lastSaved: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } catch(e) {
    console.error("Erreur sauvegarde:", e);
  } finally {
    setTimeout(() => { isSavingLocally = false; }, 800);
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

    // Appliquer les ajouts (en évitant les doublons, en validant rareté et club)
    if (data.added && data.added.length > 0) {
      const existingKeys = new Set(PLAYERS.map(p => makeKey(p)));
      data.added.forEach(player => {
        // Sécurité : rareté invalide ou manquante → commune par défaut
        if (!RARITIES[player.rarity]) {
          console.warn(`⚠ Joueur "${player.name}" avait une rareté invalide ("${player.rarity}") — corrigée en "commune"`);
          player.rarity = "commune";
        }
        // Sécurité : club invalide ou manquant → premier club disponible par défaut
        if (!player.team || !TEAMS[player.team]) {
          const fallbackTeam = Object.keys(TEAMS)[0];
          console.warn(`⚠ Joueur "${player.name}" avait un club invalide ("${player.team}") — corrigé en "${fallbackTeam}"`);
          player.team = fallbackTeam;
        }
        if (!existingKeys.has(makeKey(player))) {
          PLAYERS.push(player);
        }
      });
    }

    // Appliquer les notes générales personnalisées (forcées)
    if (data.notes && typeof data.notes === "object") {
      noteOverrides = { ...data.notes };
      console.log(`✓ ${Object.keys(data.notes).length} note(s) générale(s) personnalisée(s) chargée(s)`);
    }

    // Appliquer les sous-statistiques personnalisées
    if (data.stats && typeof data.stats === "object") {
      statsOverrides = { ...data.stats };
      console.log(`✓ ${Object.keys(data.stats).length} joueur(s) avec sous-stats personnalisées chargées`);
    }

    // Photos des joueurs
    if (data.photos && typeof data.photos === "object") {
      photoOverrides = { ...data.photos };
    }

    // Appliquer les modifications de joueurs existants (club, rareté, postes)
    // IMPORTANT : si le club change, la clé "nom|club" change aussi — il faut migrer
    // les notes et sous-stats personnalisées vers la nouvelle clé, sinon elles
    // deviennent orphelines et semblent "ne plus se sauvegarder".
    let keysMigrated = false;
    if (data.edited && data.edited.length > 0) {
      data.edited.forEach(edit => {
        const idx = PLAYERS.findIndex(p => makeKey(p) === edit.key);
        if (idx >= 0) {
          const oldKey = edit.key;
          if (edit.team && TEAMS[edit.team]) PLAYERS[idx].team = edit.team;
          if (edit.rarity && RARITIES[edit.rarity]) PLAYERS[idx].rarity = edit.rarity;
          if (edit.positions) PLAYERS[idx].positions = edit.positions;
          if (edit.nat) PLAYERS[idx].nat = edit.nat;
          if (edit.clubs !== undefined) {
            if (edit.clubs && edit.clubs.length) PLAYERS[idx].clubs = edit.clubs;
            else delete PLAYERS[idx].clubs;
          }
          const newKey = makeKey(PLAYERS[idx]);

          // Migrer les overrides de l'ancienne clé vers la nouvelle si le club a changé
          if (newKey !== oldKey) {
            if (noteOverrides[oldKey] !== undefined) {
              noteOverrides[newKey] = noteOverrides[oldKey];
              delete noteOverrides[oldKey];
              keysMigrated = true;
            }
            if (statsOverrides[oldKey] !== undefined) {
              statsOverrides[newKey] = statsOverrides[oldKey];
              delete statsOverrides[oldKey];
              keysMigrated = true;
            }
          }
        }
      });
      console.log(`✓ ${data.edited.length} modification(s) appliquée(s)`);

      // Répercuter la migration des clés dans Firestore pour que ce soit permanent
      if (keysMigrated) {
        try {
          await db.collection("playersOverrides").doc("data").set(
            { ...data, notes: noteOverrides, stats: statsOverrides },
            { merge: true }
          );
          console.log("✓ Clés de notes/stats migrées et sauvegardées");
        } catch(e) {
          console.warn("Migration des clés de notes non sauvegardée:", e.message);
        }
      }
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
    }, { merge: true });
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
  startClubPackTicker();
  setupTabs();
  updateSecondaryFilters("collection");
  renderCollection();
  updateCoinsDisplay();
  setupModal();
  setupCardDetailModal();
  setupSellConfirmModal();
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
  const now = Date.now();

  if (gift.type === "coins") {
    coins += gift.amount;
    updateCoinsDisplay();
    saveData();
    renderPacks();

  } else if (gift.type === "card") {
    const player = PLAYERS.find(p => getCardKey(p) === gift.cardKey);
    if (player) {
      addCardToCollection(player, false);
      // Toujours horodater la carte reçue en cadeau (même si doublon)
      if (collection[gift.cardKey]) {
        collection[gift.cardKey].obtainedAt = now;
      }
      saveData();
      renderCollection();
    }

  } else if (gift.type === "pack") {
    const keysBefore = new Set(Object.keys(collection));
    await loadProgressFromFirebase();

    // Horodater TOUTES les cartes du cadeau (nouvelles ou doublons)
    let changed = false;
    const cardKeys = gift.cards && gift.cards.length > 0
      ? gift.cards
      : Object.keys(collection).filter(k => !keysBefore.has(k));

    cardKeys.forEach(cardKey => {
      if (collection[cardKey]) {
        collection[cardKey].obtainedAt = now;
        changed = true;
      }
    });

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
        <div class="gift-coins-label"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAEEklEQVR4nI2US2wbVRSG/zPjR5y4jp1HRR5NSUUDOFVTREmqhqgRLHht6MJRKxAgwaYbkCqxKEKaDhJCCDYsEKqEWMDOLrBoJEAgGpdUgpI0tJAozYM4T8fO2OPEHj9mPPewyLMJoPyre3/pfvecc+85wH+IGcTXFcdOjwBc3+XtS4qiSJvrsKK4ON9/mI1rTduXMW3w9w9760yHX5v84kNt4rPpuZvvlWI33s0v31JHxn+8dAEAiAD+FyjthqmqKr786I3WZ559rD+rLQXTi4twuyWULQumUYCvugqagW9ff//m+cnJlyyQyuvsdW3Vg3kd7s29XNXd3XYtMTUWrPZ7zCd6jjuK+TwVjTz0dIZjE/NlJ/HZT948cYVIfS0cDsnoi9ibHGk7vrBEpIoXnj96yc4m20mGtWKwK6bZUtnbQI66Q1Th9Un+Op8rk7csMo1Xf7jyynN9fRE7HA7J90XIDJKkPvtu/wcBu6BdMHK6OPlkh+PG978hldAwuJzG/EwcB+ur0NP9CKoDRWl5foW9rsq3AfouNBrkXRGGJWbA57efIjNXU1vrZT2epOMdLWgPNqCUnMWxFieOtNajaJaRWzMkkiVaTevdw/0XD5Oqis3HlABgYGCUACCTjHeKksFOmXlVz8DIZqElUmjv6sSZc+fRevpFXI0MwrLKBIIti7JrdmL6BAC0t4/RVsq9K2MMAHpKb/K5SpTLOmFaAlUeCUaesZCSwONx/Bm9Cp9HhmUDpVKZK4ixtKA1AsDoaHIbuKmFRU0OtriRXTNQMm245ApM/RXD3dtTfK+ump8+3WauZV0V8VQOlmXDc8CJTDon72Ssp7xBjy2lk5ZlI53OYm01h7xRREbP4/HOh8lFKPma2+yapmbo6SzyBYsYwOKKkQAADOx45YGNzfh06k7XowHkciWUbUZ8MYX4cgZerxu1gUrPr4NDmJmcZXK5qd4vS5mcJYbGU2MAgN6oQHQDqEajAgB+vh3/qau9zmyocTsLRcGmaZPfXwkjb0LXC0gnF3HwgVqs5m27JlApzSYL479P6+PMTEQkdn5sEQ6F5LhenLszoX3tdkgEYdterwfeKjeYGT6fB4eONMLhclJrc5XweCtp4u/UpwDsy729W3Xc6pTRSIQZoMGRpXeGxrQ1B9uORGK1LARDCIYEBoQAi7LZ1Fjv/GMsMfzVwMLnigJJjUb3tp4KiMsK6F6iFBue1Ptiy4Xi4cZqhyQRA7DLgm1/4ACCxx50DY3GZ24NTYWIYG4c3+qUPeMnFIIcicDuCdZ0nmyr+7ilydcTqK4EEyG1WrLm5rRvfrk5dXEkhSUFkFRA7GbsUSiErZp0H/V3hLob+86dajh7qtn90Kav3DdY9iFFgbQ50vb4/zOt/wHHdP9RO0HAEwAAAABJRU5ErkJggg==" class="rubiz-coin" style="width:22px;height:22px;vertical-align:middle"> RUGBIZ</div>
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
    // un pack verrouillé (déjà obtenu, déjà acheté aujourd'hui...) reste désactivé même si les RUGBIZ suffisent
    btn.disabled = btn.dataset.locked === "1" || coins < cost;
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
      if (btn.dataset.tab === "collection") { updateSecondaryFilters("collection"); renderCollection(); }
      if (btn.dataset.tab === "album") { updateSecondaryFilters("album"); renderAlbum(); }
      if (btn.dataset.tab === "equipe") renderEquipe();
      if (btn.dataset.tab === "match") renderMatch();
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
  document.getElementById("rarity-filter-select").addEventListener("change", renderCollection);
  document.getElementById("note-order-select").addEventListener("change", renderCollection);

  // Barre de recherche Mon Club
  const searchInput = document.getElementById("collection-search");
  const searchClear = document.getElementById("collection-search-clear");
  searchInput.addEventListener("input", () => {
    searchClear.classList.toggle("hidden", searchInput.value === "");
    renderCollection();
  });
  searchClear.addEventListener("click", () => {
    searchInput.value = "";
    searchClear.classList.add("hidden");
    renderCollection();
    searchInput.focus();
  });

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
  document.getElementById("album-rarity-filter-select").addEventListener("change", renderAlbum);
  document.getElementById("album-note-order-select").addEventListener("change", renderAlbum);

  // Barre de recherche Album
  const albumSearch = document.getElementById("album-search");
  const albumClear = document.getElementById("album-search-clear");
  albumSearch.addEventListener("input", () => {
    albumClear.classList.toggle("hidden", albumSearch.value === "");
    renderAlbum();
  });
  albumClear.addEventListener("click", () => {
    albumSearch.value = "";
    albumClear.classList.add("hidden");
    renderAlbum();
    albumSearch.focus();
  });
}

const POSITION_ORDER = [
  "Pilier", "Talonneur", "Deuxième ligne", "Troisième ligne",
  "Demi de mêlée", "Demi d'ouverture", "Centre", "Ailier", "Arrière"
];

function updateSecondaryFilters(tab) {
  const isAlbum = tab === "album";
  const sortMode = document.getElementById(isAlbum ? "album-sort-select" : "sort-select").value;

  // Sélecteurs
  const posSelect     = document.getElementById(isAlbum ? "album-position-filter-select" : "position-filter-select");
  const clubSelect    = document.getElementById(isAlbum ? "album-club-filter-select" : "club-filter-select");
  const posteSelect   = document.getElementById(isAlbum ? "album-poste-filter-select" : "poste-filter-select");
  const raritySelect  = document.getElementById(isAlbum ? "album-rarity-filter-select" : "rarity-filter-select");
  const noteOrderSelect = document.getElementById(isAlbum ? "album-note-order-select" : "note-order-select");

  // Tout masquer par défaut
  posSelect.classList.add("hidden");
  clubSelect.classList.add("hidden");
  posteSelect.classList.add("hidden");
  raritySelect.classList.add("hidden");
  noteOrderSelect.classList.add("hidden");

  if (sortMode === "rarity") {
    // Filtre rareté — dans l'ordre décroissant (Légende → Commune)
    const rarityOrder = ["legendaire", "international", "epique", "rare", "commune"];
    const pool = isAlbum ? PLAYERS : PLAYERS.filter(p => getEntry(getCardKey(p)).count > 0);
    const presentRarities = new Set(pool.map(p => p.rarity));
    const sorted = rarityOrder.filter(r => presentRarities.has(r));
    raritySelect.innerHTML = `<option value="all">Toutes les raretés</option>` +
      sorted.map(r => `<option value="${r}">${RARITIES[r]?.label || r}</option>`).join("");
    raritySelect.classList.remove("hidden");

  } else if (sortMode === "position") {
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

  } else if (sortMode === "note") {
    // Sous-filtre ordre croissant/décroissant
    noteOrderSelect.classList.remove("hidden");
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

// (Ancienne fonction updatePositionFilterVisibility supprimée — remplacée par updateSecondaryFilters)

// ---------------------------------------------------------
// AFFICHAGE DES PACKS
// ---------------------------------------------------------
// ---------------------------------------------------------
// PACK CLUB (pack du jour : un seul club, sans légendes, achetable 1 fois par jour)
// ===== PACK CLUB : DEBUT =====
// Pour modifier le prix, le nombre de cartes ou les chances : changer l'objet CLUB_PACK ci-dessous.
// ---------------------------------------------------------
const CLUB_PACK_MIN_PLAYERS = 10; // un club doit avoir au moins 10 joueurs (hors légendes) pour être tiré
const CLUB_PACK = {
  id: "club",
  name: "Pack Club",
  description: "5 cartes du club du jour — sans légendes",
  cardsCount: 5,
  cost: 400,
  clubDaily: true,
  // mêmes chances que le Pack Pro D2
  weightModifier: { commune: 0.4, rare: 1.5, epique: 1.8, international: 1.5, legendaire: 0 }
};

// Ajouté à la liste des packs, juste après le Pack Pro D2 (par prix croissant)
if (!PACKS.some(p => p.id === CLUB_PACK.id)) {
  const afterIdx = PACKS.findIndex(p => p.id === "premium");
  PACKS.splice(afterIdx >= 0 ? afterIdx + 1 : PACKS.length, 0, { ...CLUB_PACK });
}

// Jour calendaire local (YYYY-MM-DD) : le club change et l'achat se débloque à minuit, heure de l'utilisateur
function getLocalDayStr(date = new Date()) {
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${m}-${d}`;
}

// Clubs pouvant alimenter le pack (dans l'ordre de TEAMS)
function getClubPackCandidates() {
  const counts = {};
  PLAYERS.forEach(p => {
    if (p.rarity !== "legendaire" && TEAMS[p.team]) counts[p.team] = (counts[p.team] || 0) + 1;
  });
  return Object.keys(TEAMS).filter(k => (counts[k] || 0) >= CLUB_PACK_MIN_PLAYERS);
}

// Générateur pseudo-aléatoire à graine : même graine = même suite
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clubCycleOrder(clubs, cycle) {
  const rng = mulberry32(cycle * 7919 + 104729);
  const order = [...clubs];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

// Club du jour : identique pour tous les joueurs un même jour, sans serveur.
// Les clubs défilent dans un ordre mélangé : chacun revient une fois par cycle,
// et jamais le même club deux jours de suite.
function getClubOfTheDay(dayStr = getLocalDayStr()) {
  const clubs = getClubPackCandidates();
  if (clubs.length === 0) return null;
  const [y, m, d] = dayStr.split("-").map(Number);
  const dayNumber = Math.floor(Date.UTC(y, m - 1, d) / 86400000);
  const n = clubs.length;
  const cycle = Math.floor(dayNumber / n);
  const order = clubCycleOrder(clubs, cycle);
  if (n >= 3 && cycle > 0) {
    const prev = clubCycleOrder(clubs, cycle - 1);
    if (order[0] === prev[n - 1]) [order[0], order[1]] = [order[1], order[0]];
  }
  return order[((dayNumber % n) + n) % n];
}

// Tire les cartes : joueurs du club uniquement, légendes exclues, sans doublon dans le pack,
// selon les chances de rareté du pack.
function drawClubPackCards(pack, clubKey) {
  const seen = new Set();
  const remaining = PLAYERS.filter(p => {
    if (p.team !== clubKey || p.rarity === "legendaire" || !RARITIES[p.rarity]) return false;
    const key = getCardKey(p);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const mods = pack.weightModifier || {};
  const cards = [];
  for (let i = 0; i < pack.cardsCount && remaining.length > 0; i++) {
    const weights = remaining.map(p => RARITIES[p.rarity].weight * (mods[p.rarity] ?? 1));
    let roll = Math.random() * weights.reduce((a, b) => a + b, 0);
    let idx = weights.findIndex(w => (roll -= w) <= 0);
    if (idx < 0) idx = remaining.length - 1;
    cards.push(remaining.splice(idx, 1)[0]);
  }
  return cards;
}

// Achat limité à 1 par jour — la date est conservée dans Firestore (pas de contournement par rafraîchissement)
function isClubPackAvailable() {
  if (DEV_MODE) return true;
  return clubPackLast !== getLocalDayStr();
}

function markClubPackUsed() {
  if (DEV_MODE) return;
  clubPackLast = getLocalDayStr();
  if (currentUser) {
    db.collection("users").doc(currentUser.uid).update({ clubPackLast })
      .catch(e => console.error("Erreur save clubPackLast:", e));
  }
}
// ===== PACK CLUB : FIN =====

// Horloge : met à jour le compte à rebours du pack et rafraîchit les packs quand le jour change
// (si l'onglet reste ouvert après minuit, le club affiché change tout seul)
let clubPackRenderedDay = null;
let clubPackTickerStarted = false;

function startClubPackTicker() {
  if (clubPackTickerStarted) return;
  clubPackTickerStarted = true;
  setInterval(() => {
    if (clubPackRenderedDay && getLocalDayStr() !== clubPackRenderedDay) {
      renderPacks();
      return;
    }
    const el = document.getElementById("club-pack-countdown");
    if (!el) return;
    const now = new Date();
    const next = new Date(now);
    next.setDate(next.getDate() + 1);
    next.setHours(0, 0, 0, 0);
    const diff = Math.max(0, next - now);
    const h = String(Math.floor(diff / 3600000)).padStart(2, "0");
    const m = String(Math.floor((diff % 3600000) / 60000)).padStart(2, "0");
    const s = String(Math.floor((diff % 60000) / 1000)).padStart(2, "0");
    el.textContent = `⏱ Nouveau club dans ${h}:${m}:${s}`;
  }, 1000);
}

function renderPacks() {
  const container = document.getElementById("packs-container");
  container.innerHTML = "";

  const xvUsed = !DEV_MODE && xvUsedInMemory;
  const dailyAvailable = isDailyAvailable();
  const clubAvailable = isClubPackAvailable();

  PACKS.forEach(pack => {
    const isXV = pack.id === "xv_demarrage";
    const isDaily = pack.id === "coup_envoi";
    const isClub = pack.id === "club";

    // Pack Club : club du jour (le pack n'est pas affiché si aucun club n'est éligible)
    const clubKey = isClub ? getClubOfTheDay() : null;
    if (isClub && !clubKey) return;

    // Masquer le pack XV Démarrage s'il a déjà été utilisé (hors DEV_MODE)
    if (isXV && xvUsed) return;

    const div = document.createElement("div");

    let cardClass = "pack-card";
    if (isXV) cardClass += " pack-card-xv";
    if (isDaily) cardClass += " pack-card-daily";
    if (isClub) cardClass += " pack-card-club";
    div.className = cardClass;
    if (isClub) div.style.setProperty("--club-color", TEAMS[clubKey].color);

    // Coût affiché
    let costHtml;
    if (isXV || isDaily) {
      costHtml = `<div class="pack-cost pack-cost-free">GRATUIT</div>`;
    } else {
      costHtml = `<div class="pack-cost">${pack.cost} <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAEEklEQVR4nI2US2wbVRSG/zPjR5y4jp1HRR5NSUUDOFVTREmqhqgRLHht6MJRKxAgwaYbkCqxKEKaDhJCCDYsEKqEWMDOLrBoJEAgGpdUgpI0tJAozYM4T8fO2OPEHj9mPPewyLMJoPyre3/pfvecc+85wH+IGcTXFcdOjwBc3+XtS4qiSJvrsKK4ON9/mI1rTduXMW3w9w9760yHX5v84kNt4rPpuZvvlWI33s0v31JHxn+8dAEAiAD+FyjthqmqKr786I3WZ559rD+rLQXTi4twuyWULQumUYCvugqagW9ff//m+cnJlyyQyuvsdW3Vg3kd7s29XNXd3XYtMTUWrPZ7zCd6jjuK+TwVjTz0dIZjE/NlJ/HZT948cYVIfS0cDsnoi9ibHGk7vrBEpIoXnj96yc4m20mGtWKwK6bZUtnbQI66Q1Th9Un+Op8rk7csMo1Xf7jyynN9fRE7HA7J90XIDJKkPvtu/wcBu6BdMHK6OPlkh+PG978hldAwuJzG/EwcB+ur0NP9CKoDRWl5foW9rsq3AfouNBrkXRGGJWbA57efIjNXU1vrZT2epOMdLWgPNqCUnMWxFieOtNajaJaRWzMkkiVaTevdw/0XD5Oqis3HlABgYGCUACCTjHeKksFOmXlVz8DIZqElUmjv6sSZc+fRevpFXI0MwrLKBIIti7JrdmL6BAC0t4/RVsq9K2MMAHpKb/K5SpTLOmFaAlUeCUaesZCSwONx/Bm9Cp9HhmUDpVKZK4ixtKA1AsDoaHIbuKmFRU0OtriRXTNQMm245ApM/RXD3dtTfK+ump8+3WauZV0V8VQOlmXDc8CJTDon72Ssp7xBjy2lk5ZlI53OYm01h7xRREbP4/HOh8lFKPma2+yapmbo6SzyBYsYwOKKkQAADOx45YGNzfh06k7XowHkciWUbUZ8MYX4cgZerxu1gUrPr4NDmJmcZXK5qd4vS5mcJYbGU2MAgN6oQHQDqEajAgB+vh3/qau9zmyocTsLRcGmaZPfXwkjb0LXC0gnF3HwgVqs5m27JlApzSYL479P6+PMTEQkdn5sEQ6F5LhenLszoX3tdkgEYdterwfeKjeYGT6fB4eONMLhclJrc5XweCtp4u/UpwDsy729W3Xc6pTRSIQZoMGRpXeGxrQ1B9uORGK1LARDCIYEBoQAi7LZ1Fjv/GMsMfzVwMLnigJJjUb3tp4KiMsK6F6iFBue1Ptiy4Xi4cZqhyQRA7DLgm1/4ACCxx50DY3GZ24NTYWIYG4c3+qUPeMnFIIcicDuCdZ0nmyr+7ilydcTqK4EEyG1WrLm5rRvfrk5dXEkhSUFkFRA7GbsUSiErZp0H/V3hLob+86dajh7qtn90Kav3DdY9iFFgbQ50vb4/zOt/wHHdP9RO0HAEwAAAABJRU5ErkJggg==" class="rubiz-coin" style="width:22px;height:22px;vertical-align:middle"></div>`;
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
    } else if (isClub) {
      if (!clubAvailable) {
        btnDisabled = true;
        btnLabel = "Déjà acheté — à demain";
        extraHtml = `<div id="club-pack-countdown" class="daily-countdown"></div>`;
      } else {
        btnLabel = "Acheter";
      }
    }

    let icon = "📦";
    if (isXV) icon = "🏉";
    if (isDaily) icon = "⚡";
    if (isClub) icon = "🏟️";

    // Le club du jour est écrit en toutes lettres sur le pack
    const clubHtml = isClub
      ? `<div class="pack-club-name">${TEAMS[clubKey].name}</div>`
      : "";

    div.innerHTML = `
      <div class="pack-icon">${icon}</div>
      <h3>${pack.name}</h3>
      ${clubHtml}
      <p>${pack.description}</p>
      ${costHtml}
      ${extraHtml}
      <button class="${btnClass}" data-pack-id="${pack.id}" data-cost="${pack.cost}" ${btnDisabled ? 'disabled data-locked="1"' : ""}>
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

  clubPackRenderedDay = getLocalDayStr();
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

  // Pack Club : club du jour, 1 achat par jour
  if (pack.id === "club") {
    if (!isClubPackAvailable()) return;
    const clubKey = getClubOfTheDay();
    if (!clubKey) return;
    coins -= cost;
    const clubCards = drawClubPackCards(pack, clubKey);
    clubCards.forEach(card => addCardToCollection(card, false));
    markClubPackUsed();
    saveData();
    updateCoinsDisplay();
    showOpeningModal({ ...pack, name: `${pack.name} — ${TEAMS[clubKey].name}` }, clubCards);
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
    <div class="daily-bonus-label"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAEEklEQVR4nI2US2wbVRSG/zPjR5y4jp1HRR5NSUUDOFVTREmqhqgRLHht6MJRKxAgwaYbkCqxKEKaDhJCCDYsEKqEWMDOLrBoJEAgGpdUgpI0tJAozYM4T8fO2OPEHj9mPPewyLMJoPyre3/pfvecc+85wH+IGcTXFcdOjwBc3+XtS4qiSJvrsKK4ON9/mI1rTduXMW3w9w9760yHX5v84kNt4rPpuZvvlWI33s0v31JHxn+8dAEAiAD+FyjthqmqKr786I3WZ559rD+rLQXTi4twuyWULQumUYCvugqagW9ff//m+cnJlyyQyuvsdW3Vg3kd7s29XNXd3XYtMTUWrPZ7zCd6jjuK+TwVjTz0dIZjE/NlJ/HZT948cYVIfS0cDsnoi9ibHGk7vrBEpIoXnj96yc4m20mGtWKwK6bZUtnbQI66Q1Th9Un+Op8rk7csMo1Xf7jyynN9fRE7HA7J90XIDJKkPvtu/wcBu6BdMHK6OPlkh+PG978hldAwuJzG/EwcB+ur0NP9CKoDRWl5foW9rsq3AfouNBrkXRGGJWbA57efIjNXU1vrZT2epOMdLWgPNqCUnMWxFieOtNajaJaRWzMkkiVaTevdw/0XD5Oqis3HlABgYGCUACCTjHeKksFOmXlVz8DIZqElUmjv6sSZc+fRevpFXI0MwrLKBIIti7JrdmL6BAC0t4/RVsq9K2MMAHpKb/K5SpTLOmFaAlUeCUaesZCSwONx/Bm9Cp9HhmUDpVKZK4ixtKA1AsDoaHIbuKmFRU0OtriRXTNQMm245ApM/RXD3dtTfK+ump8+3WauZV0V8VQOlmXDc8CJTDon72Ssp7xBjy2lk5ZlI53OYm01h7xRREbP4/HOh8lFKPma2+yapmbo6SzyBYsYwOKKkQAADOx45YGNzfh06k7XowHkciWUbUZ8MYX4cgZerxu1gUrPr4NDmJmcZXK5qd4vS5mcJYbGU2MAgN6oQHQDqEajAgB+vh3/qau9zmyocTsLRcGmaZPfXwkjb0LXC0gnF3HwgVqs5m27JlApzSYL479P6+PMTEQkdn5sEQ6F5LhenLszoX3tdkgEYdterwfeKjeYGT6fB4eONMLhclJrc5XweCtp4u/UpwDsy729W3Xc6pTRSIQZoMGRpXeGxrQ1B9uORGK1LARDCIYEBoQAi7LZ1Fjv/GMsMfzVwMLnigJJjUb3tp4KiMsK6F6iFBue1Ptiy4Xi4cZqhyQRA7DLgm1/4ACCxx50DY3GZ24NTYWIYG4c3+qUPeMnFIIcicDuCdZ0nmyr+7ilydcTqK4EEyG1WrLm5rRvfrk5dXEkhSUFkFRA7GbsUSiErZp0H/V3hLob+86dajh7qtn90Kav3DdY9iFFgbQ50vb4/zOt/wHHdP9RO0HAEwAAAABJRU5ErkJggg==" class="rubiz-coin" style="width:22px;height:22px;vertical-align:middle"> RUGBIZ</div>
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

// ---------------------------------------------------------
// SYSTÈME DE NOTES — Sous-statistiques pondérées par poste
// ---------------------------------------------------------

// Coefficients par poste (total = 1 par ligne)
const COEFFS_POSTES = {
  "Pilier":              { vitesse: 0.05, puissance: 0.50, defense: 0.25, passe: 0.10, technique: 0.10 },
  "Talonneur":           { vitesse: 0.10, puissance: 0.35, defense: 0.25, passe: 0.15, technique: 0.15 },
  "Deuxième ligne":      { vitesse: 0.05, puissance: 0.45, defense: 0.30, passe: 0.10, technique: 0.10 },
  "Troisième ligne":     { vitesse: 0.15, puissance: 0.30, defense: 0.35, passe: 0.10, technique: 0.10 },
  "Demi de mêlée":       { vitesse: 0.20, puissance: 0.05, defense: 0.15, passe: 0.40, technique: 0.20 },
  "Demi d'ouverture":    { vitesse: 0.20, puissance: 0.15, defense: 0.15, passe: 0.25, technique: 0.25 },
  "Centre":              { vitesse: 0.20, puissance: 0.15, defense: 0.15, passe: 0.25, technique: 0.25 },
  "Ailier":              { vitesse: 0.45, puissance: 0.10, defense: 0.15, passe: 0.10, technique: 0.20 },
  "Arrière":             { vitesse: 0.45, puissance: 0.10, defense: 0.15, passe: 0.10, technique: 0.20 }
};

const STAT_KEYS = ["vitesse", "puissance", "defense", "passe", "technique"];

// Cache des sous-notes modifiées par l'admin (chargé depuis Firestore via loadPlayersOverrides)
// Format : { "name|team": { vitesse, puissance, defense, passe, technique } }
let statsOverrides = {};
// Cache des notes générales forcées manuellement (prioritaire sur le calcul auto)
let noteOverrides = {}; // { "name|team": note }

// Génère des sous-stats déterministes (même valeurs à chaque fois pour un joueur donné)
// Spread constant et généreux pour garantir de vrais points forts/faibles même chez
// les hautes raretés — la note générale est ensuite recadrée dans la fourchette de la
// rareté pour éviter tout chevauchement entre paliers (voir calculerNoteGenerale).
function generateBaseStats(player) {
  const rarity = RARITIES[player.rarity];
  const noteMin = rarity?.noteMin ?? 40;
  const noteMax = rarity?.noteMax ?? 64;
  const center = (noteMin + noteMax) / 2;
  const spread = 14; // dispersion individuelle constante entre les sous-stats

  const str = player.name + player.team;
  const stats = {};
  STAT_KEYS.forEach((stat, idx) => {
    let hash = 0;
    const seed = str + stat + idx;
    for (let i = 0; i < seed.length; i++) {
      hash = (hash * 31 + seed.charCodeAt(i)) & 0xffff;
    }
    const offset = (hash % (spread * 2)) - spread; // -spread à +spread
    const val = Math.round(center + offset);
    stats[stat] = Math.max(20, Math.min(99, val));
  });
  return stats;
}

// Retourne les 5 sous-stats d'un joueur (priorité : overrides admin > data.js > généré)
function getPlayerStats(player) {
  const key = `${player.name}|${player.team}`;
  const base = generateBaseStats(player);
  if (statsOverrides[key]) return { ...base, ...statsOverrides[key] };
  if (player.stats) return { ...base, ...player.stats };
  return base;
}

// Calcule la note générale à partir des sous-stats et du poste principal
function calculerNoteGenerale(player, stats) {
  const postePrincipal = Array.isArray(player.positions) ? player.positions[0] : player.positions;
  const poids = COEFFS_POSTES[postePrincipal];

  let noteCalculee;
  if (!poids) {
    // Poste inconnu → moyenne simple des sous-stats
    const vals = STAT_KEYS.map(k => stats[k] || 0);
    noteCalculee = vals.reduce((a,b) => a+b, 0) / vals.length;
  } else {
    noteCalculee =
      (stats.vitesse   * poids.vitesse) +
      (stats.puissance * poids.puissance) +
      (stats.defense   * poids.defense) +
      (stats.passe     * poids.passe) +
      (stats.technique * poids.technique);
  }

  // Note générale purement issue du calcul pondéré des sous-stats,
  // sans plafond/plancher lié à la rareté de la carte.
  return Math.round(noteCalculee);
}

function getPlayerNote(player) {
  const key = `${player.name}|${player.team}`;
  // Priorité 1 : note générale forcée par l'admin (Firestore)
  if (noteOverrides[key] !== undefined) return noteOverrides[key];
  // Priorité 2 : note codée en dur dans data.js
  if (player.note !== undefined) return player.note;
  // Priorité 3 : calcul à partir des sous-stats
  const stats = getPlayerStats(player);
  return calculerNoteGenerale(player, stats);
}

// Retourne le label correspondant à une note
function getNoteLabel(note) {
  if (note >= 97) return "Légende";
  if (note >= 94) return "Meilleur Top 14";
  if (note >= 90) return "Star";
  if (note >= 85) return "Excellent";
  if (note >= 80) return "Très bon";
  if (note >= 75) return "Bon titulaire";
  if (note >= 70) return "Rotation";
  if (note >= 65) return "Remplaçant";
  return "Espoir";
}

function getNoteColor(note) {
  return "linear-gradient(135deg, #ffd700 0%, #b8860b 100%)";
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

  // Filtre par recherche textuelle
  const searchQuery = (document.getElementById("collection-search")?.value || "").trim().toLowerCase();
  if (searchQuery) {
    ownedPlayers = ownedPlayers.filter(p =>
      p.name.toLowerCase().includes(searchQuery)
    );
    if (ownedPlayers.length === 0) {
      container.innerHTML = `<div class="empty-card">Aucun joueur trouvé pour "<strong>${searchQuery}</strong>".</div>`;
      return;
    }
  }

  if (sortMode === "rarity") {
    const rarityFilter = document.getElementById("rarity-filter-select")?.value || "all";
    if (rarityFilter !== "all") {
      ownedPlayers = ownedPlayers.filter(p => p.rarity === rarityFilter);
      if (ownedPlayers.length === 0) {
        container.innerHTML = `<div class="empty-card">Aucune carte de cette rareté dans ton effectif.</div>`;
        return;
      }
    }
  } else if (sortMode === "position") {
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

  // Filtre par recherche textuelle
  const albumQuery = (document.getElementById("album-search")?.value || "").trim().toLowerCase();
  if (albumQuery) {
    allPlayers = allPlayers.filter(p => p.name.toLowerCase().includes(albumQuery));
    if (allPlayers.length === 0) {
      container.innerHTML = `<div class="empty-card">Aucun joueur trouvé pour "<strong>${albumQuery}</strong>".</div>`;
      return;
    }
  }

  if (sortMode === "rarity") {
    const rarityFilter = document.getElementById("album-rarity-filter-select")?.value || "all";
    if (rarityFilter !== "all") {
      allPlayers = allPlayers.filter(p => p.rarity === rarityFilter);
      if (allPlayers.length === 0) {
        container.innerHTML = `<div class="empty-card">Aucune carte de cette rareté dans le jeu.</div>`;
        return;
      }
    }
  } else if (sortMode === "position") {
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
  coins += (RARITIES[player.rarity]?.sellValue || 0) * unlockedSold;

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

    case "note": {
      const orderSelectId = tab === "album" ? "album-note-order-select" : "note-order-select";
      const order = document.getElementById(orderSelectId)?.value || "desc";
      players.sort((a, b) => {
        const diff = getPlayerNote(b) - getPlayerNote(a); // décroissant par défaut
        return (order === "asc" ? -diff : diff) || a.name.localeCompare(b.name);
      });
      break;
    }

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

// Liste des nationalités disponibles dans le jeu (code 3 lettres -> nom FR)
// Utilisée pour la liste déroulante de sélection dans le panneau Admin.
const NATIONALITIES = {
  FRA: "France", ANG: "Angleterre", ECO: "Écosse", IRL: "Irlande",
  ITA: "Italie", ESP: "Espagne", ALL: "Allemagne", POR: "Portugal",
  GEO: "Géorgie", RUS: "Russie", MDA: "Moldavie", BEL: "Belgique",
  POL: "Pologne",
  NZL: "Nouvelle-Zélande", AUS: "Australie", FIJ: "Fidji", TGA: "Tonga",
  SAM: "Samoa", ARG: "Argentine", CHI: "Chili", URU: "Uruguay",
  AFS: "Afrique du Sud", ZIM: "Zimbabwe", KEN: "Kenya", CMR: "Cameroun",
  SEN: "Sénégal", COD: "RD Congo", RDC: "RD Congo", NAM: "Namibie",
  PDG: "Madagascar", USA: "États-Unis", CAN: "Canada"
};

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
    "KEN": "ke", "CMR": "cm", "CAM": "cm", "COD": "cd", "NAM": "na",
    "POL": "pl"
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
    KEN: "KEN", CMR: "CMR", CAM: "CMR", COD: "COD", NAM: "NAM",
    POL: "POL"
  };
  const clean = (natCode || "").toUpperCase().trim();
  return names[clean] || clean;
}

// ---------------------------------------------------------
// CRÉATION D'UN ÉLÉMENT "CARTE"
// ---------------------------------------------------------
// ---------------------------------------------------------
// PHOTOS ET RAPPEL DU CLUB SUR LES CARTES
// ---------------------------------------------------------
// Photos des joueurs : { "nom|club": url }. Source : panneau Admin (à venir) ou champ « photo » dans data.js.
// Sans photo, la carte affiche les initiales du joueur sur le fond de sa rareté.
let photoOverrides = {};

function getPlayerPhoto(player) {
  return photoOverrides[getCardKey(player)] || player.photo || null;
}

function photoImgHtml(player, cls) {
  const url = getPlayerPhoto(player);
  if (!url) return "";
  const safe = String(url).replace(/"/g, "&quot;");
  // si l'image ne charge pas, on retombe sur les initiales
  return `<img class="${cls}" src="${safe}" alt="" loading="lazy" decoding="async" onerror="this.parentNode.classList.remove('has-photo');this.remove()">`;
}

const CLUB_SHORT_NAMES = {
  toulouse: "Toulouse", ubb: "UBB", racing92: "Racing 92", lapelle: "La Rochelle", toulon: "Toulon",
  clermont: "Clermont", bayonne: "Bayonne", pau: "Pau", lyon: "Lyon", castres: "Castres",
  montpellier: "Montpellier", stadefr: "Stade Français", perpignan: "Perpignan", montauban: "Montauban",
  biarritz: "Biarritz", vannes: "Vannes", bourgoinjallieu: "Bourgoin"
};

// Club(s) du joueur : un seul pour la plupart, plusieurs pour les légendes (clubs de carrière)
function getPlayerClubKeys(player) {
  return player.clubs && player.clubs.length > 1 ? player.clubs : [player.team];
}

// Petit rappel du ou des clubs : pastille aux couleurs du club + nom court
function clubChipsHtml(player, max = 3) {
  const keys = getPlayerClubKeys(player);
  const chips = keys.slice(0, max).map(k => {
    const t = TEAMS[k];
    return `<span class="club-chip" title="${t ? t.name : k}" style="--chip:${t ? t.color : "#888"}"><i></i>${CLUB_SHORT_NAMES[k] || (t ? t.name : k)}</span>`;
  }).join("");
  const more = keys.length > max ? `<span class="club-chip club-chip-more">+${keys.length - max}</span>` : "";
  return `<div class="card-clubs">${chips}${more}</div>`;
}

function buildCardElement(player, count = null, options = {}) {
  const card = document.createElement("div");
  card.className = `card card-v2 ${player.rarity}`;

  const team = TEAMS[player.team];
  const initials = player.name
    .split(" ")
    .map(w => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const photoHtml = photoImgHtml(player, "card-photo");

  const positionText = (player.positions || []).join(" / ");
  const natCode = (player.nat || "FRA").toUpperCase().trim();

  const isLocked = (options.lockedCount || 0) > 0;
  const note = getPlayerNote(player);
  const noteColor = getNoteColor(note);
  const stats = getPlayerStats(player);

  const statsHtml = `
    <div class="card-substats">
      <div class="card-substat"><span class="substat-label">VIT</span><span class="substat-value">${stats.vitesse}</span></div>
      <div class="card-substat"><span class="substat-label">PUI</span><span class="substat-value">${stats.puissance}</span></div>
      <div class="card-substat"><span class="substat-label">DEF</span><span class="substat-value">${stats.defense}</span></div>
      <div class="card-substat"><span class="substat-label">PAS</span><span class="substat-value">${stats.passe}</span></div>
      <div class="card-substat"><span class="substat-label">TEC</span><span class="substat-value">${stats.technique}</span></div>
    </div>
  `;

  card.innerHTML = `
    <div class="card-avatar${photoHtml ? " has-photo" : ""}">
      ${photoHtml}
      <span class="avatar-initials">${initials}</span>
      <span class="card-note" style="background:${noteColor}">${note}</span>
      ${isLocked ? `<span class="card-lock-badge" title="Non revendable">🔒</span>` : ""}
    </div>
    <div class="card-info">
      <p class="card-name">${player.name}</p>
      <p class="card-position">${positionText}</p>
      ${clubChipsHtml(player)}
      <span class="card-rarity ${player.rarity}">${RARITIES[player.rarity]?.label || "?"}</span>
      ${count !== null ? `<div class="card-count">x${count}</div>` : ""}
      <p class="card-nationality"><span class="nat-flag">${getFlagEmoji(natCode)}</span><span class="nat-code">${getNatLabel(natCode)}</span></p>
      ${statsHtml}
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

// Aperçu zoomé depuis l'Album — même modale que Mon Club, sans les contrôles de vente
function openAlbumDetail(player, owned) {
  currentDetailKey = getCardKey(player);
  currentDetailQty = 1;

  const container = document.getElementById("card-detail-container");
  container.innerHTML = "";

  const entry = getEntry(currentDetailKey);
  const cardEl = buildCardElement(player, owned ? entry.count : null, { lockedCount: entry.lockedCount || 0 });
  cardEl.classList.add("zoomed-card");

  if (owned) {
    const badge = document.createElement("span");
    badge.className = "album-owned-badge";
    badge.textContent = "Effectif";
    cardEl.appendChild(badge);
  }

  container.appendChild(cardEl);

  // Pas de vente possible depuis l'Album — masquer les contrôles
  document.querySelector(".sell-controls").classList.add("hidden");

  document.getElementById("card-detail-modal").classList.remove("hidden");
}

function updateCardDetailControls() {
  const entry = getEntry(currentDetailKey);
  const lockedCount = entry.lockedCount || 0;
  const maxSellable = Math.max(0, entry.count - lockedCount);
  const totalSellable = entry.count; // locked + unlocked, toutes vendables (locked = 0 RUGBIZ)
  const player = PLAYERS.find(p => getCardKey(p) === currentDetailKey);
  const sellValue = player ? (RARITIES[player.rarity]?.sellValue || 0) : 0;

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
    confirmBtn.innerHTML = `Vendre ${currentDetailQty} 🔒 (+0 <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAEEklEQVR4nI2US2wbVRSG/zPjR5y4jp1HRR5NSUUDOFVTREmqhqgRLHht6MJRKxAgwaYbkCqxKEKaDhJCCDYsEKqEWMDOLrBoJEAgGpdUgpI0tJAozYM4T8fO2OPEHj9mPPewyLMJoPyre3/pfvecc+85wH+IGcTXFcdOjwBc3+XtS4qiSJvrsKK4ON9/mI1rTduXMW3w9w9760yHX5v84kNt4rPpuZvvlWI33s0v31JHxn+8dAEAiAD+FyjthqmqKr786I3WZ559rD+rLQXTi4twuyWULQumUYCvugqagW9ff//m+cnJlyyQyuvsdW3Vg3kd7s29XNXd3XYtMTUWrPZ7zCd6jjuK+TwVjTz0dIZjE/NlJ/HZT948cYVIfS0cDsnoi9ibHGk7vrBEpIoXnj96yc4m20mGtWKwK6bZUtnbQI66Q1Th9Un+Op8rk7csMo1Xf7jyynN9fRE7HA7J90XIDJKkPvtu/wcBu6BdMHK6OPlkh+PG978hldAwuJzG/EwcB+ur0NP9CKoDRWl5foW9rsq3AfouNBrkXRGGJWbA57efIjNXU1vrZT2epOMdLWgPNqCUnMWxFieOtNajaJaRWzMkkiVaTevdw/0XD5Oqis3HlABgYGCUACCTjHeKksFOmXlVz8DIZqElUmjv6sSZc+fRevpFXI0MwrLKBIIti7JrdmL6BAC0t4/RVsq9K2MMAHpKb/K5SpTLOmFaAlUeCUaesZCSwONx/Bm9Cp9HhmUDpVKZK4ixtKA1AsDoaHIbuKmFRU0OtriRXTNQMm245ApM/RXD3dtTfK+ump8+3WauZV0V8VQOlmXDc8CJTDon72Ssp7xBjy2lk5ZlI53OYm01h7xRREbP4/HOh8lFKPma2+yapmbo6SzyBYsYwOKKkQAADOx45YGNzfh06k7XowHkciWUbUZ8MYX4cgZerxu1gUrPr4NDmJmcZXK5qd4vS5mcJYbGU2MAgN6oQHQDqEajAgB+vh3/qau9zmyocTsLRcGmaZPfXwkjb0LXC0gnF3HwgVqs5m27JlApzSYL479P6+PMTEQkdn5sEQ6F5LhenLszoX3tdkgEYdterwfeKjeYGT6fB4eONMLhclJrc5XweCtp4u/UpwDsy729W3Xc6pTRSIQZoMGRpXeGxrQ1B9uORGK1LARDCIYEBoQAi7LZ1Fjv/GMsMfzVwMLnigJJjUb3tp4KiMsK6F6iFBue1Ptiy4Xi4cZqhyQRA7DLgm1/4ACCxx50DY3GZ24NTYWIYG4c3+qUPeMnFIIcicDuCdZ0nmyr+7ilydcTqK4EEyG1WrLm5rRvfrk5dXEkhSUFkFRA7GbsUSiErZp0H/V3hLob+86dajh7qtn90Kav3DdY9iFFgbQ50vb4/zOt/wHHdP9RO0HAEwAAAABJRU5ErkJggg==" class="rubiz-coin" style="width:22px;height:22px;vertical-align:middle">)`;
  } else {
    confirmBtn.innerHTML = `Vendre ${currentDetailQty} (+${totalValue} <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAEEklEQVR4nI2US2wbVRSG/zPjR5y4jp1HRR5NSUUDOFVTREmqhqgRLHht6MJRKxAgwaYbkCqxKEKaDhJCCDYsEKqEWMDOLrBoJEAgGpdUgpI0tJAozYM4T8fO2OPEHj9mPPewyLMJoPyre3/pfvecc+85wH+IGcTXFcdOjwBc3+XtS4qiSJvrsKK4ON9/mI1rTduXMW3w9w9760yHX5v84kNt4rPpuZvvlWI33s0v31JHxn+8dAEAiAD+FyjthqmqKr786I3WZ559rD+rLQXTi4twuyWULQumUYCvugqagW9ff//m+cnJlyyQyuvsdW3Vg3kd7s29XNXd3XYtMTUWrPZ7zCd6jjuK+TwVjTz0dIZjE/NlJ/HZT948cYVIfS0cDsnoi9ibHGk7vrBEpIoXnj96yc4m20mGtWKwK6bZUtnbQI66Q1Th9Un+Op8rk7csMo1Xf7jyynN9fRE7HA7J90XIDJKkPvtu/wcBu6BdMHK6OPlkh+PG978hldAwuJzG/EwcB+ur0NP9CKoDRWl5foW9rsq3AfouNBrkXRGGJWbA57efIjNXU1vrZT2epOMdLWgPNqCUnMWxFieOtNajaJaRWzMkkiVaTevdw/0XD5Oqis3HlABgYGCUACCTjHeKksFOmXlVz8DIZqElUmjv6sSZc+fRevpFXI0MwrLKBIIti7JrdmL6BAC0t4/RVsq9K2MMAHpKb/K5SpTLOmFaAlUeCUaesZCSwONx/Bm9Cp9HhmUDpVKZK4ixtKA1AsDoaHIbuKmFRU0OtriRXTNQMm245ApM/RXD3dtTfK+ump8+3WauZV0V8VQOlmXDc8CJTDon72Ssp7xBjy2lk5ZlI53OYm01h7xRREbP4/HOh8lFKPma2+yapmbo6SzyBYsYwOKKkQAADOx45YGNzfh06k7XowHkciWUbUZ8MYX4cgZerxu1gUrPr4NDmJmcZXK5qd4vS5mcJYbGU2MAgN6oQHQDqEajAgB+vh3/qau9zmyocTsLRcGmaZPfXwkjb0LXC0gnF3HwgVqs5m27JlApzSYL479P6+PMTEQkdn5sEQ6F5LhenLszoX3tdkgEYdterwfeKjeYGT6fB4eONMLhclJrc5XweCtp4u/UpwDsy729W3Xc6pTRSIQZoMGRpXeGxrQ1B9uORGK1LARDCIYEBoQAi7LZ1Fjv/GMsMfzVwMLnigJJjUb3tp4KiMsK6F6iFBue1Ptiy4Xi4cZqhyQRA7DLgm1/4ACCxx50DY3GZ24NTYWIYG4c3+qUPeMnFIIcicDuCdZ0nmyr+7ilydcTqK4EEyG1WrLm5rRvfrk5dXEkhSUFkFRA7GbsUSiErZp0H/V3hLob+86dajh7qtn90Kav3DdY9iFFgbQ50vb4/zOt/wHHdP9RO0HAEwAAAABJRU5ErkJggg==" class="rubiz-coin" style="width:22px;height:22px;vertical-align:middle">)`;
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

// ---------------------------------------------------------
// CONFIGURATIONS DE BANC (5-3 / 6-2 / 7-1)
// Chaque config définit les 8 postes de remplaçants (num 16-23)
// Contrainte commune : au moins 2 Piliers + 1 Talonneur parmi les avants
// ---------------------------------------------------------
const BANC_CONFIGS = {
  "5-3": {
    label: "5-3",
    description: "5 avants / 3 trois-quarts",
    slots: [
      { id: "r16", label: "Pilier",           num: 16, postes: ["Pilier"] },
      { id: "r17", label: "Talonneur",        num: 17, postes: ["Talonneur"] },
      { id: "r18", label: "Pilier",           num: 18, postes: ["Pilier"] },
      { id: "r19", label: "2e/3e Ligne",      num: 19, postes: ["Deuxième ligne","Troisième ligne"] },
      { id: "r20", label: "2e/3e Ligne",      num: 20, postes: ["Deuxième ligne","Troisième ligne"] },
      { id: "r21", label: "Demi de Mêlée",    num: 21, postes: ["Demi de mêlée"] },
      { id: "r22", label: "Demi d'Ouverture", num: 22, postes: ["Demi d'ouverture"] },
      { id: "r23", label: "Trois-quarts",     num: 23, postes: ["Centre","Ailier","Arrière"] }
    ]
  },
  "6-2": {
    label: "6-2",
    description: "6 avants / 2 trois-quarts",
    slots: [
      { id: "r16", label: "Pilier",           num: 16, postes: ["Pilier"] },
      { id: "r17", label: "Talonneur",        num: 17, postes: ["Talonneur"] },
      { id: "r18", label: "Pilier",           num: 18, postes: ["Pilier"] },
      { id: "r19", label: "2e/3e Ligne",      num: 19, postes: ["Deuxième ligne","Troisième ligne"] },
      { id: "r20", label: "2e/3e Ligne",      num: 20, postes: ["Deuxième ligne","Troisième ligne"] },
      { id: "r21", label: "2e/3e Ligne",      num: 21, postes: ["Deuxième ligne","Troisième ligne"] },
      { id: "r22", label: "Demi (M/O)",       num: 22, postes: ["Demi de mêlée","Demi d'ouverture"] },
      { id: "r23", label: "Trois-quarts",     num: 23, postes: ["Centre","Ailier","Arrière"] }
    ]
  },
  "7-1": {
    label: "7-1",
    description: "7 avants / 1 trois-quarts",
    slots: [
      { id: "r16", label: "Pilier",           num: 16, postes: ["Pilier"] },
      { id: "r17", label: "Talonneur",        num: 17, postes: ["Talonneur"] },
      { id: "r18", label: "Pilier",           num: 18, postes: ["Pilier"] },
      { id: "r19", label: "2e/3e Ligne",      num: 19, postes: ["Deuxième ligne","Troisième ligne"] },
      { id: "r20", label: "2e/3e Ligne",      num: 20, postes: ["Deuxième ligne","Troisième ligne"] },
      { id: "r21", label: "2e/3e Ligne",      num: 21, postes: ["Deuxième ligne","Troisième ligne"] },
      { id: "r22", label: "Avant (libre)",    num: 22, postes: ["Pilier","Talonneur","Deuxième ligne","Troisième ligne"] },
      { id: "r23", label: "Trois-quarts",     num: 23, postes: ["Demi de mêlée","Demi d'ouverture","Centre","Ailier","Arrière"] }
    ]
  }
};

// Banc actuellement sélectionné (persisté avec l'équipe)
let currentBanc = "5-3";

// Historique des matchs (10 plus récents, le plus récent en premier) + stats cumulées
let matchHistory = []; // [{ result: "win"|"draw"|"loss", userScore, cpuScore }]
let matchStats = { played: 0, wins: 0, draws: 0, losses: 0 };

// Retourne les slots de remplaçants du banc actuel, au format EQUIPE_SLOTS
function getBancSlots() {
  const config = BANC_CONFIGS[currentBanc] || BANC_CONFIGS["5-3"];
  return config.slots.map(s => ({ ...s, remplacant: true }));
}

// Rareté order pour compo type
const RARITY_RANK = { legendaire: 5, international: 4, epique: 3, rare: 2, commune: 1 };

// Stockage de la compo en cours
let equipe = {}; // { slotId: player }
let lastClickedSlotId = null; // dernier poste cliqué, pour l'aperçu à droite
let currentSlotId = null;

function renderEquipe() {
  const container = document.getElementById("pitch-container");
  container.innerHTML = "";

  const wrapper = document.createElement("div");
  wrapper.className = "equipe-wrapper";

  // === COLONNE GAUCHE : TERRAIN + REMPLAÇANTS ===
  const leftCol = document.createElement("div");
  leftCol.className = "equipe-left-col";

  // Terrain
  const pitch = document.createElement("div");
  pitch.className = "pitch";

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

  leftCol.appendChild(pitch);

  // Remplaçants — 2 lignes de 4, horizontal, sous le terrain
  const remplPanel = document.createElement("div");
  remplPanel.className = "remplacants-panel";

  const remplTitle = document.createElement("div");
  remplTitle.className = "remplacants-title";
  remplTitle.textContent = `Remplaçants (${currentBanc})`;
  remplPanel.appendChild(remplTitle);

  const remplGrid = document.createElement("div");
  remplGrid.className = "remplacants-grid";
  const remplSlots = getBancSlots();
  remplSlots.forEach(slot => {
    const player = equipe[slot.id] || null;
    const slotEl = buildPitchSlot(slot, player);
    slotEl.classList.add("remplacant-slot");
    remplGrid.appendChild(slotEl);
  });
  remplPanel.appendChild(remplGrid);

  leftCol.appendChild(remplPanel);
  wrapper.appendChild(leftCol);

  // === COLONNE DROITE : APERÇU + SÉLECTION ===
  const rightCol = document.createElement("div");
  rightCol.className = "equipe-right-col";

  const previewPanel = document.createElement("div");
  previewPanel.className = "equipe-preview-panel";
  previewPanel.id = "equipe-preview-panel";
  previewPanel.innerHTML = `
    <div class="equipe-preview-title">Aperçu</div>
    <div id="equipe-preview-content" class="equipe-preview-content">
      <div class="equipe-preview-empty">Clique sur un poste pour voir la carte du joueur sélectionné</div>
    </div>
  `;
  rightCol.appendChild(previewPanel);

  const selectPanel = document.createElement("div");
  selectPanel.className = "equipe-select-panel hidden";
  selectPanel.id = "equipe-select-panel";
  selectPanel.innerHTML = `
    <div class="equipe-select-header">
      <span id="player-select-title" class="equipe-select-title"></span>
      <button id="close-player-select-btn" class="close-x-btn" aria-label="Fermer">✕</button>
    </div>
    <div id="player-select-list" class="player-select-list"></div>
  `;
  rightCol.appendChild(selectPanel);

  wrapper.appendChild(rightCol);

  container.appendChild(wrapper);

  // Afficher automatiquement l'aperçu du dernier slot cliqué s'il est rempli
  if (lastClickedSlotId && equipe[lastClickedSlotId]) {
    updateEquipePreview(equipe[lastClickedSlotId]);
  }

  // Boutons banc 5-3 / 6-2 / 7-1
  ["5-3", "6-2", "7-1"].forEach(bancKey => {
    const btn = document.getElementById(`banc-${bancKey}-btn`);
    if (!btn) return;
    btn.classList.toggle("active", currentBanc === bancKey);
    btn.onclick = () => {
      if (currentBanc === bancKey) return;
      currentBanc = bancKey;
      // Nettoyer les slots remplaçants (les postes changent selon le banc)
      Object.keys(equipe).forEach(id => {
        if (id.startsWith("r1") || id.startsWith("r2")) delete equipe[id];
      });
      renderEquipe();
      saveData();
    };
  });

  // Boutons Compo Type / Réinitialiser
  document.getElementById("compo-type-btn").onclick = doCompoType;
  document.getElementById("reset-equipe-btn").onclick = () => {
    equipe = {};
    lastClickedSlotId = null;
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

  el.addEventListener("click", () => {
    lastClickedSlotId = slot.id;
    if (player) updateEquipePreview(player);
    openPlayerSelect(slot);
  });
  return el;
}

// Met à jour le panneau d'aperçu à droite avec la carte complète (+ sous-stats) du joueur
function updateEquipePreview(player) {
  const content = document.getElementById("equipe-preview-content");
  if (!content) return;
  content.innerHTML = "";

  const entry = getEntry(getCardKey(player));
  const cardEl = buildCardElement(player, entry.count > 0 ? entry.count : null, {
    lockedCount: entry.lockedCount || 0
  });
  cardEl.classList.add("zoomed-card"); // révèle les sous-stats via le CSS existant
  content.appendChild(cardEl);
}

function buildMiniCard(player, slot) {
  const posText = (player.positions || []).join(" / ");
  const note = getPlayerNote(player);
  const noteColor = getNoteColor(note);
  const photoHtml = photoImgHtml(player, "mini-photo");

  // Rappel du club : pastille à ses couleurs + nom court (plusieurs pastilles pour une légende multi-clubs)
  const clubKeys = getPlayerClubKeys(player);
  const clubLabel = clubKeys.slice(0, 2).map(k => CLUB_SHORT_NAMES[k] || (TEAMS[k] ? TEAMS[k].name : k)).join(" / ");
  const firstTeam = TEAMS[clubKeys[0]];

  return `
    <div class="mini-card mini-v2 ${player.rarity}">
      <div class="mini-card-header${photoHtml ? " has-photo" : ""}">
        ${photoHtml}
        <span class="mini-initials">${player.name.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase()}</span>
        <span class="mini-num">${slot.num}</span>
        <span class="mini-note" style="background:${noteColor}">${note}</span>
      </div>
      <div class="mini-card-body">
        <div class="mini-name">${player.name}</div>
        <div class="mini-team"><i class="mini-dot" style="--chip:${firstTeam ? firstTeam.color : "#888"}"></i>${clubLabel}</div>
        <div class="mini-pos">${posText}</div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------
// SÉLECTION DE JOUEUR
// ---------------------------------------------------------
function setupPlayerSelectModal() {
  const closeBtn = document.getElementById("close-player-select-btn");
  if (closeBtn) closeBtn.onclick = closePlayerSelect;
}

function openPlayerSelect(slot) {
  currentSlotId = slot.id;

  // Label adapté selon remplaçant ou titulaire
  const titleLabel = slot.remplacant
    ? `Choisir — ${slot.label.replace("\n", " ")} (N°${slot.num})`
    : `Choisir — ${slot.label} (${slot.poste})`;
  document.getElementById("player-select-title").textContent = titleLabel;

  // Filtrer selon les postes du slot (remplaçant = plusieurs postes, titulaire = un seul)
  const slotPostes = slot.remplacant ? slot.postes : [slot.poste];

  const eligible = PLAYERS.filter(p =>
    getEntry(getCardKey(p)).count > 0 &&
    (p.positions || []).some(pos => slotPostes.includes(pos))
  );

  // Tri par rareté décroissante puis nom
  const rarityOrder = ["legendaire","international","epique","rare","commune"];
  eligible.sort((a,b) =>
    rarityOrder.indexOf(a.rarity) - rarityOrder.indexOf(b.rarity) || a.name.localeCompare(b.name)
  );

  // Construire le filtre club à partir des joueurs éligibles
  const clubs = [...new Set(eligible.map(p => p.team))].sort((a,b) =>
    (TEAMS[a]?.name||a).localeCompare(TEAMS[b]?.name||b)
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
      clubs.map(t => `<option value="${t}">${TEAMS[t]?.name || t}</option>`).join("");
    sel.addEventListener("change", () => renderPlayerSelectList(eligible, slot, sel.value));
    filterDiv.appendChild(sel);
    list.appendChild(filterDiv);
  }

  // Zone de résultats
  const resultsDiv = document.createElement("div");
  resultsDiv.id = "psr-results";
  list.appendChild(resultsDiv);

  renderPlayerSelectList(eligible, slot, "all");

  // Afficher le panneau de sélection (à droite de l'aperçu, pas de modale)
  const panel = document.getElementById("equipe-select-panel");
  if (panel) {
    panel.classList.remove("hidden");
    setupPlayerSelectModal();
  }
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
  const rarityConfig = RARITIES[player.rarity] || { color: "#888", label: player.rarity || "?" };
  const isSelected = Object.values(equipe).some(p => getCardKey(p) === getCardKey(player));

  const row = document.createElement("div");
  row.className = "player-select-row" + (isSelected ? " player-in-team" : "");

  row.innerHTML = `
    <div class="psr-rarity" style="background:${rarityConfig.color}; color:${player.rarity==='legendaire'?'#fff':'#fff'}">${rarityConfig.label}</div>
    <div class="psr-info">
      <div class="psr-name">${player.name}</div>
      <div class="psr-team">${team?.name || player.team || "?"}</div>
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
  const panel = document.getElementById("equipe-select-panel");
  if (panel) panel.classList.add("hidden");
  currentSlotId = null;
}

// ---------------------------------------------------------
// COMPO TYPE
// ---------------------------------------------------------
function doCompoType() {
  const newEquipe = {};

  // Titulaires (les 15 premiers slots, sans remplacant) + remplaçants du banc actuel
  const titulaires = EQUIPE_SLOTS.filter(s => !s.remplacant);
  const allSlots = [...titulaires, ...getBancSlots()];

  allSlots.forEach(slot => {
    const slotPostes = slot.remplacant ? slot.postes : [slot.poste];

    const eligible = PLAYERS.filter(p =>
      getEntry(getCardKey(p)).count > 0 &&
      (p.positions || []).some(pos => slotPostes.includes(pos)) &&
      !Object.values(newEquipe).some(assigned => getCardKey(assigned) === getCardKey(p))
    );

    if (eligible.length === 0) return;

    // Classement par note générale (sous-stats pondérées selon le poste),
    // pas par rareté — un joueur Commune bien noté à ce poste passe devant
    // une Légende moins adaptée.
    eligible.sort((a, b) => getPlayerNote(b) - getPlayerNote(a));
    newEquipe[slot.id] = eligible[0];
  });

  equipe = newEquipe;
  renderEquipe();
  saveData();
}

// =========================================================
// ONGLET MATCH — Simulation contre une équipe aléatoire
// =========================================================

let matchInProgress = false;

function renderMatch() {
  const container = document.getElementById("match-container");
  container.innerHTML = "";

  const titulaires = EQUIPE_SLOTS.filter(s => !s.remplacant);
  const filledTitulaires = titulaires.filter(s => equipe[s.id]);

  if (filledTitulaires.length < 15) {
    container.innerHTML = `
      <div class="match-empty">
        <div class="match-empty-icon">🏉</div>
        <p>Ton équipe n'est pas complète.</p>
        <p class="match-empty-sub">${filledTitulaires.length}/15 titulaires sélectionnés — complète ta composition dans l'onglet <strong>Mon Équipe</strong> avant de lancer un match.</p>
      </div>
    `;
    return;
  }

  const bancSlots = getBancSlots();
  const filledBanc = bancSlots.filter(s => equipe[s.id]);

  // Générer l'équipe CPU complète (titulaires + banc, type de banc aléatoire)
  // Adversaire : équipe RUGBIX aléatoire ou club choisi (légendes comprises)
  const playableClubs = Object.keys(TEAMS).filter(k => clubCanField(k));
  if (matchOpponent !== "rugbix" && !playableClubs.includes(matchOpponent)) matchOpponent = "rugbix";
  const isClubMatch = matchOpponent !== "rugbix";
  const cpuSquad = isClubMatch ? generateClubSquad(matchOpponent) : generateRandomCpuSquad();
  const cpuLabel = isClubMatch ? TEAMS[matchOpponent].name : RUGBIX_TEAM_NAME;

  container.innerHTML = `
    <div class="match-opponent-row">
      <label for="match-opponent-select">Adversaire :</label>
      <select id="match-opponent-select" ${matchInProgress ? "disabled" : ""}>
        <option value="rugbix">${RUGBIX_TEAM_NAME} (aléatoire)</option>
        ${playableClubs.map(k => `<option value="${k}">${TEAMS[k].name}</option>`).join("")}
      </select>
      <button id="match-reroll-btn" class="banc-btn" ${matchInProgress ? "disabled" : ""}>🎲 Autre composition</button>
    </div>
    <div class="match-top-row">
      <div class="match-main-col">
        <div class="match-setup">
          <div class="match-team-card match-team-user">
            <div class="match-team-label">Ton équipe</div>
            <div class="match-team-name" id="match-user-name">${(currentUser?.displayName || currentUser?.email?.split("@")[0] || "Toi")}</div>
            <div class="match-team-rating" id="match-user-rating">—</div>
          </div>
          <div class="match-vs">VS</div>
          <div class="match-team-card match-team-cpu">
            <div class="match-team-label">Adversaire</div>
            <div class="match-team-name" id="match-cpu-name">${cpuLabel}</div>
            <div class="match-team-rating" id="match-cpu-rating">—</div>
          </div>
        </div>
        <button id="start-match-btn" class="start-match-btn">🏉 Lancer le match</button>
        <div id="match-log" class="match-log"></div>
        <div id="match-result" class="match-result hidden"></div>
      </div>

      <!-- Panneau historique + stats -->
      <div class="match-history-panel">
        <div class="match-history-title">Statistiques</div>
        <div class="match-stats-grid" id="match-stats-grid"></div>
        <div class="match-history-title">Derniers matchs</div>
        <div class="match-history-list" id="match-history-list"></div>
      </div>
    </div>

    <!-- Compositions complètes des deux équipes -->
    <div class="match-lineups">
      <div class="match-lineup-col">
        <div class="match-lineup-title match-lineup-title-user">Ton équipe (${currentBanc})</div>
        <div class="match-lineup-subtitle">Titulaires</div>
        <div class="match-lineup-grid" id="match-user-titulaires"></div>
        <div class="match-lineup-subtitle">Remplaçants</div>
        <div class="match-lineup-grid" id="match-user-banc"></div>
      </div>
      <div class="match-lineup-col">
        <div class="match-lineup-title match-lineup-title-cpu">${cpuLabel} (${cpuSquad.bancType})</div>
        <div class="match-lineup-subtitle">Titulaires</div>
        <div class="match-lineup-grid" id="match-cpu-titulaires"></div>
        <div class="match-lineup-subtitle">Remplaçants</div>
        <div class="match-lineup-grid" id="match-cpu-banc"></div>
      </div>
    </div>
  `;

  renderMatchHistoryPanel();

  // Afficher les mini-cartes de chaque poste, titulaires + banc, pour les deux équipes
  fillLineupGrid("match-user-titulaires", titulaires, s => equipe[s.id]);
  fillLineupGrid("match-user-banc", bancSlots, s => equipe[s.id]);
  fillLineupGrid("match-cpu-titulaires", titulaires, s => cpuSquad.titulairesMap[s.id]);
  fillLineupGrid("match-cpu-banc", cpuSquad.bancSlots, s => cpuSquad.bancMap[s.id]);

  // Calculer et afficher la force de chaque équipe (titulaires uniquement, comme au coup d'envoi)
  const userRating = computeTeamRating(filledTitulaires.map(s => equipe[s.id]));
  document.getElementById("match-user-rating").textContent = `Collectif : ${userRating}`;

  const cpuRating = computeTeamRating(titulaires.map(s => cpuSquad.titulairesMap[s.id]).filter(Boolean));
  document.getElementById("match-cpu-rating").textContent = `Collectif : ${cpuRating}`;

  const opponentSelect = document.getElementById("match-opponent-select");
  opponentSelect.value = matchOpponent;
  opponentSelect.onchange = () => {
    if (matchInProgress) { opponentSelect.value = matchOpponent; return; }
    matchOpponent = opponentSelect.value;
    renderMatch();
  };
  document.getElementById("match-reroll-btn").onclick = () => {
    if (!matchInProgress) renderMatch();
  };

  document.getElementById("start-match-btn").onclick = () => {
    if (matchInProgress) return;
    const cpuTitulaires = titulaires.map(s => cpuSquad.titulairesMap[s.id]).filter(Boolean);
    const cpuBanc = cpuSquad.bancSlots.map(s => cpuSquad.bancMap[s.id]).filter(Boolean);
    const userTitulaires = filledTitulaires.map(s => equipe[s.id]);
    const userBancPlayers = bancSlots.map(s => equipe[s.id]).filter(Boolean);
    startMatchSimulation(userTitulaires, userBancPlayers, cpuTitulaires, cpuBanc, userRating, cpuRating, cpuLabel);
  };
}

// Affiche les compteurs et la liste des derniers matchs dans le panneau latéral
function renderMatchHistoryPanel() {
  const statsGrid = document.getElementById("match-stats-grid");
  const historyList = document.getElementById("match-history-list");
  if (!statsGrid || !historyList) return;

  statsGrid.innerHTML = `
    <div class="match-stat-box"><div class="match-stat-value">${matchStats.played}</div><div class="match-stat-label">Joués</div></div>
    <div class="match-stat-box match-stat-win"><div class="match-stat-value">${matchStats.wins}</div><div class="match-stat-label">Victoires</div></div>
    <div class="match-stat-box match-stat-draw"><div class="match-stat-value">${matchStats.draws}</div><div class="match-stat-label">Nuls</div></div>
    <div class="match-stat-box match-stat-loss"><div class="match-stat-value">${matchStats.losses}</div><div class="match-stat-label">Défaites</div></div>
  `;

  if (matchHistory.length === 0) {
    historyList.innerHTML = `<div class="match-history-empty">Aucun match joué pour l'instant.</div>`;
    return;
  }

  const resultIcons = { win: "🏆", draw: "🤝", loss: "❌" };
  const resultLabels = { win: "Victoire", draw: "Nul", loss: "Défaite" };
  const resultClasses = { win: "match-history-win", loss: "match-history-loss", draw: "match-history-draw" };

  historyList.innerHTML = matchHistory.map(m => `
    <div class="match-history-row ${resultClasses[m.result]}">
      <span class="match-history-icon">${resultIcons[m.result]}</span>
      <span class="match-history-label">${resultLabels[m.result]}${m.opponent ? ` <span class="match-history-opp">vs ${escapeHtml(m.opponent)}</span>` : ""}</span>
      <span class="match-history-score">${m.userScore} - ${m.cpuScore}</span>
    </div>
  `).join("");
}

// Remplit une grille de mini-cartes pour une liste de slots donnée
function fillLineupGrid(containerId, slots, getPlayerForSlot) {
  const grid = document.getElementById(containerId);
  if (!grid) return;
  grid.innerHTML = slots.map(slot => {
    const player = getPlayerForSlot(slot);
    if (!player) {
      return `<div class="match-lineup-slot-empty"><div class="slot-num">${slot.num}</div><div class="slot-label-mini">${slot.label.replace("\n"," ")}</div></div>`;
    }
    return `<div class="match-lineup-slot">${buildMiniCard(player, slot)}</div>`;
  }).join("");
}

function computeTeamRating(players) {
  if (!players.length) return 0;
  const total = players.reduce((sum, p) => sum + getPlayerNote(p), 0);
  return Math.round(total / players.length);
}

// ===== MATCH CLUB : DEBUT =====
// Adversaire choisi dans l'onglet Match : "rugbix" (équipe aléatoire) ou la clé d'un club de TEAMS.
let matchOpponent = "rugbix";
const RUGBIX_TEAM_NAME = "Équipe RUGBIX";

function shuffledCopy(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Joueurs d'un club : ceux de ce club + les légendes qui y ont joué (liste « clubs » de leur carrière)
function getClubPool(clubKey) {
  const seen = new Set(); // un joueur présent en double dans la base ne peut être aligné qu'une fois
  return PLAYERS.filter(p => {
    if (!(p.team === clubKey || (p.clubs || []).includes(clubKey))) return false;
    const key = getCardKey(p);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Place un joueur différent sur chaque poste (poste compatible), de façon aléatoire.
// Recherche par chemin augmentant : si une solution existe, elle est trouvée.
// Les postes impossibles à pourvoir restent vides.
function assignPlayersToSlots(pool, slots, usedKeys) {
  const players = shuffledCopy(pool).filter(p => !usedKeys.has(getCardKey(p)));
  const slotPostes = slots.map(s => (s.remplacant ? s.postes : [s.poste]));
  const slotOfPlayer = new Array(players.length).fill(-1);

  function tryAssign(si, seen) {
    for (let i = 0; i < players.length; i++) {
      if (seen[i]) continue;
      if (!(players[i].positions || []).some(pos => slotPostes[si].includes(pos))) continue;
      seen[i] = true;
      if (slotOfPlayer[i] < 0 || tryAssign(slotOfPlayer[i], seen)) {
        slotOfPlayer[i] = si;
        return true;
      }
    }
    return false;
  }

  slots.forEach((_, si) => tryAssign(si, []));

  const map = {};
  slotOfPlayer.forEach((si, i) => { if (si >= 0) map[slots[si].id] = players[i]; });
  return map;
}

// Un club est jouable s'il peut aligner un XV complet (un joueur par poste)
function clubCanField(clubKey) {
  const titulaires = EQUIPE_SLOTS.filter(s => !s.remplacant);
  const map = assignPlayersToSlots(getClubPool(clubKey), titulaires, new Set());
  return Object.keys(map).length === titulaires.length;
}

// Composition aléatoire d'un club : XV + banc (type 5-3, 6-2 ou 7-1 tiré au hasard)
function generateClubSquad(clubKey) {
  const pool = getClubPool(clubKey);
  const titulaires = EQUIPE_SLOTS.filter(s => !s.remplacant);
  const titulairesMap = assignPlayersToSlots(pool, titulaires, new Set());
  const used = new Set(Object.values(titulairesMap).map(getCardKey));

  const bancKeys = Object.keys(BANC_CONFIGS);
  const bancType = bancKeys[Math.floor(Math.random() * bancKeys.length)];
  const bancSlots = BANC_CONFIGS[bancType].slots.map(s => ({ ...s, remplacant: true }));
  const bancMap = assignPlayersToSlots(pool, bancSlots, used);

  return { titulairesMap, bancMap, bancSlots, bancType };
}
// ===== MATCH CLUB : FIN =====

function generateRandomCpuSquad() {
  const titulaires = EQUIPE_SLOTS.filter(s => !s.remplacant);
  const usedKeys = new Set();

  const titulairesMap = {};
  titulaires.forEach(slot => {
    const eligible = PLAYERS.filter(p =>
      (p.positions || []).includes(slot.poste) && !usedKeys.has(getCardKey(p))
    );
    if (eligible.length === 0) return;
    const pick = eligible[Math.floor(Math.random() * eligible.length)];
    usedKeys.add(getCardKey(pick));
    titulairesMap[slot.id] = pick;
  });

  // Banc de type aléatoire (5-3, 6-2 ou 7-1), indépendant du banc du joueur
  const bancKeys = Object.keys(BANC_CONFIGS);
  const randomBancKey = bancKeys[Math.floor(Math.random() * bancKeys.length)];
  const bancSlots = BANC_CONFIGS[randomBancKey].slots.map(s => ({ ...s, remplacant: true }));

  const bancMap = {};
  bancSlots.forEach(slot => {
    const slotPostes = slot.postes || [slot.poste];
    const eligible = PLAYERS.filter(p =>
      (p.positions || []).some(pos => slotPostes.includes(pos)) && !usedKeys.has(getCardKey(p))
    );
    if (eligible.length === 0) return;
    const pick = eligible[Math.floor(Math.random() * eligible.length)];
    usedKeys.add(getCardKey(pick));
    bancMap[slot.id] = pick;
  });

  return { titulairesMap, bancMap, bancSlots, bancType: randomBancKey };
}

// ---------------------------------------------------------
// SIMULATION DU MATCH — commentaire en direct + score
// ---------------------------------------------------------
function startMatchSimulation(userTitulaires, userBanc, cpuTitulaires, cpuBanc, userRating, cpuRating, cpuName = RUGBIX_TEAM_NAME) {
  matchInProgress = true;
  const startBtn = document.getElementById("start-match-btn");
  const logEl = document.getElementById("match-log");
  const resultEl = document.getElementById("match-result");

  startBtn.disabled = true;
  startBtn.textContent = "Match en cours...";
  logEl.innerHTML = "";
  resultEl.classList.add("hidden");
  resultEl.innerHTML = "";

  const userName = currentUser?.displayName || currentUser?.email?.split("@")[0] || "Toi";

  let userScore = 0;
  let cpuScore = 0;

  const ratingDiff = userRating - cpuRating;
  const userAdvantage = 0.5 + Math.max(-0.3, Math.min(0.3, ratingDiff / 100));

  const events = generateMatchEvents(userName, cpuName, userAdvantage, userTitulaires, userBanc, cpuTitulaires, cpuBanc);

  let idx = 0;
  const scoreEl = document.createElement("div");
  scoreEl.className = "match-live-score";
  logEl.appendChild(scoreEl);

  // Effectif sur le terrain (baisse avec les cartons jaunes et rouges)
  const fullUser = userTitulaires.length;
  const fullCpu = cpuTitulaires.length;
  let fieldUser = fullUser;
  let fieldCpu = fullCpu;

  function updateLiveScore() {
    const userField = fieldUser < fullUser ? ` <span class="match-live-field">(${fieldUser})</span>` : "";
    const cpuField = fieldCpu < fullCpu ? ` <span class="match-live-field">(${fieldCpu})</span>` : "";
    scoreEl.innerHTML = `
      <span class="match-live-team">${userName}${userField}</span>
      <span class="match-live-points">${userScore}</span>
      <span class="match-live-sep">-</span>
      <span class="match-live-points">${cpuScore}</span>
      <span class="match-live-team">${cpuName}${cpuField}</span>
    `;
  }
  updateLiveScore();

  function playNextEvent() {
    if (idx >= events.length) {
      finishMatch();
      return;
    }
    const ev = events[idx];
    idx++;

    if (ev.points) {
      if (ev.team === "user") userScore += ev.points;
      else cpuScore += ev.points;
    }
    if (ev.field) {
      fieldUser = ev.field.user;
      fieldCpu = ev.field.cpu;
    }
    if (ev.points || ev.field) updateLiveScore();

    const line = document.createElement("div");
    line.className = "match-log-line" + (ev.team ? ` match-log-${ev.team}` : "") + (ev.isSub ? " match-log-sub" : "");
    line.innerHTML = `<span class="match-log-minute">${ev.minute}'</span> ${ev.text}`;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;

    setTimeout(playNextEvent, ev.important ? 1100 : 550);
  }

  function finishMatch() {
    matchInProgress = false;
    startBtn.disabled = false;
    startBtn.textContent = "🏉 Relancer un match";

    // Après le match, le bouton régénère une toute nouvelle équipe Rugbix
    // (titulaires, remplaçants et type de banc aléatoires) via renderMatch()
    startBtn.onclick = () => renderMatch();

    const won = userScore > cpuScore;
    const draw = userScore === cpuScore;
    const result = won ? "win" : (draw ? "draw" : "loss");

    // Mettre à jour les statistiques cumulées
    matchStats.played += 1;
    if (result === "win") matchStats.wins += 1;
    else if (result === "draw") matchStats.draws += 1;
    else matchStats.losses += 1;

    // Ajouter le match en tête d'historique — le plus récent écrase le plus ancien (max 10)
    matchHistory.unshift({ result, userScore, cpuScore, opponent: cpuName });
    if (matchHistory.length > 10) matchHistory.length = 10;

    // Rafraîchir immédiatement le panneau historique/stats
    renderMatchHistoryPanel();

    resultEl.classList.remove("hidden");

    if (won) {
      const reward = 300;
      coins += reward;
      saveData();
      updateCoinsDisplay();
      resultEl.innerHTML = `
        <div class="match-result-title match-result-win">🏆 Victoire !</div>
        <div class="match-result-score">${userScore} - ${cpuScore}</div>
        <div class="match-result-reward">+${reward} <span class="rubiz-symbol"></span> RUGBIZ gagnés !</div>
      `;
    } else if (draw) {
      saveData();
      resultEl.innerHTML = `
        <div class="match-result-title match-result-draw">🤝 Match nul</div>
        <div class="match-result-score">${userScore} - ${cpuScore}</div>
        <div class="match-result-reward">Aucune récompense pour un match nul.</div>
      `;
    } else {
      saveData();
      resultEl.innerHTML = `
        <div class="match-result-title match-result-lose">❌ Défaite</div>
        <div class="match-result-score">${userScore} - ${cpuScore}</div>
        <div class="match-result-reward">Retente ta chance !</div>
      `;
    }
  }

  playNextEvent();
}

function generateMatchEvents(userName, cpuName, userAdvantage, userTitulaires, userBanc, cpuTitulaires, cpuBanc) {
  const events = [];

  // ---------------------------------------------------------
  // RÔLES : chaque phrase de commentaire est liée à un type de joueur,
  // pour que les avants soient cités en mêlée / touche / maul et que seuls
  // les joueurs de ligne arrière tapent pénalités et drops.
  // ---------------------------------------------------------
  const FORWARD_POS = ["Pilier", "Talonneur", "Deuxième ligne", "Troisième ligne"];
  const BACK_POS = ["Demi de mêlée", "Demi d'ouverture", "Centre", "Ailier", "Arrière"];
  const ROLES = {
    forward:   { pos: FORWARD_POS },
    talonneur: { pos: ["Talonneur"], fallback: "forward" },
    back:      { pos: BACK_POS },
    half:      { pos: ["Demi de mêlée", "Demi d'ouverture"], fallback: "back" },
    scrumhalf: { pos: ["Demi de mêlée"], fallback: "half" },
    kicker:    { pos: ["Demi d'ouverture", "Arrière", "Demi de mêlée"], fallback: "back" },
    dropper:   { pos: ["Demi d'ouverture", "Arrière"], fallback: "kicker" },
    finisher:  { pos: ["Ailier", "Arrière", "Centre"], fallback: "back" },
    any:       { pos: null }
  };

  // Choisit un joueur de l'effectif actif correspondant au rôle demandé
  function pickPlayerObj(active, role) {
    if (!active || active.length === 0) return null;
    let r = role;
    while (r) {
      const def = ROLES[r];
      if (!def || !def.pos) break;
      const pool = active.filter(p => (p.positions || []).some(pos => def.pos.includes(pos)));
      if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
      r = def.fallback;
    }
    return active[Math.floor(Math.random() * active.length)];
  }

  function pickPlayer(active, role, fallbackName) {
    const p = pickPlayerObj(active, role);
    return (p && p.name) || fallbackName;
  }

  function randomOf(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  // ---------------------------------------------------------
  // TEXTES : [rôle, phrase]. {p} = nom du joueur qui réalise l'action.
  // ---------------------------------------------------------
  const T = {
    essai_avant: [
      ["forward", "{p} conclut une séquence de pick-and-go par un essai en force !"],
      ["forward", "{p} termine un ballon porté parfaitement huilé par un essai !"],
      ["forward", "{p} s'écroule derrière la ligne au bout d'une poussée collective du pack : essai !"],
      ["forward", "Le maul progresse inexorablement et {p} aplatit ! Essai !"]
    ],
    essai_arriere: [
      ["finisher", "{p} perce la défense et aplatit en coin ! Essai !"],
      ["finisher", "{p} profite d'un relais parfait pour aplatir sous les poteaux ! Essai !"],
      ["finisher", "{p} termine une action collective magnifique par un essai !"],
      ["finisher", "{p} intercepte une passe et file marquer à 60 mètres ! Essai splendide !"],
      ["finisher", "{p} repique à l'intérieur... et c'est au bout ! Essai !"],
      ["finisher", "Quel crochet dévastateur de {p} ! La défense est totalement mystifiée. Essai !"],
      ["finisher", "Isolé à 50 mètres, {p} dépose tout le monde à la course ! Essai !"],
      ["finisher", "Percée plein champ ! Le ballon circule jusqu'à l'aile... {p} aplatit ! Essai !"],
      ["finisher", "{p} crochète, raffûte... et plonge entre les poteaux ! Essai magistral !"],
      ["finisher", "{p} aplatit en coin au terme d'un mouvement d'envergure ! Essai !"]
    ],
    penalite: [
      ["kicker", "{p} s'élance dans un silence assourdissant... La trajectoire est idéale, ça passe entre les perches !"],
      ["kicker", "{p} ajuste la pénalité sans trembler."],
      ["kicker", "{p} profite d'une faute adverse en touche pour tenter les poteaux... et c'est bon !"],
      ["kicker", "Le ballon de {p} heurte le poteau rentrant, trois points de plus au tableau d'affichage !"],
      ["kicker", "Pénalité obtenue en mêlée : {p} tente les poteaux... et ça passe !"]
    ],
    dropgoal: [
      ["dropper", "{p} tente un drop audacieux... et ça passe !"],
      ["dropper", "{p} lâche un drop de 40 mètres au milieu de la défense... Il est bon !"]
    ],
    conquete: [
      ["forward", "{p} et le pack font reculer leur vis-à-vis sur huit mètres ! Poussée collective dévastatrice !"],
      ["forward", "L'arbitre bras tendu : pénalité pour l'attelage dominant de {p} et de ses partenaires !"],
      ["scrumhalf", "Ballon introduit, extraction rapide de {p} pour amorcer le lancement."],
      ["forward", "Prise de balle parfaite de {p} en fond d'alignement !"],
      ["forward", "Le maul se structure autour de {p}... La cocotte s'enclenche et progresse rapidement !"],
      ["forward", "Contre tactique en l'air de {p}, ballon volé à l'alignement adverse !"],
      ["forward", "{p} et le pack enclenchent la marche avant... Mêlée enfoncée et ballon récupéré !"],
      ["forward", "Poussée en travers de {p} sanctionnée, le ballon change de camp !"],
      ["forward", "Pression énorme en mêlée, le ballon échappe à {p} !"],
      ["forward", "Contre acrobatique de {p} en l'air ! Le ballon est récupéré par la défense !"],
      ["talonneur", "Lancer trop long de {p} qui lobe tout l'alignement... Aubaine pour les défenseurs !"],
      ["forward", "Ballon porté de {p} totalement écroulé et étouffé, l'arbitre rend la possession à la défense !"],
      ["forward", "Ballon arraché des bras dans le maul par {p} ! Quel travail des avants !"],
      ["forward", "{p} domine la mêlée mais perd le ballon en sortie."],
      ["forward", "{p} perd le ballon en mêlée fermée."]
    ],
    main: [
      ["back", "{p} redouble à l'intérieur, la défense est prise à revers !"],
      ["back", "Passe après contact (offload) lumineuse de {p} dans l'intervalle !"],
      ["back", "Fixation plein champ de {p}, la passe sautée pour décaler l'ailier en bout de ligne !"],
      ["back", "{p} fait une passe décisive mais l'ailier échappe le ballon."],
      ["back", "{p} relance depuis son camp mais est repoussé en touche."],
      ["back", "{p} grappille quelques mètres sur un temps de jeu long."]
    ],
    pied: [
      ["kicker", "Une chandelle millimétrée de {p} sous la pression."],
      ["kicker", "Coup de pied par-dessus la défense de {p}... quelle inspiration !"],
      ["kicker", "Une trouvaille d'occupation parfaite de {p} dans le dos des ailiers."],
      ["kicker", "{p} dégage son camp avec une longueur impressionnante."],
      ["kicker", "Chandelle monumentale de {p} pour mettre l'adversaire sous pression."],
      ["half", "{p} tape en touche pour gagner du terrain."]
    ],
    defense: [
      ["any", "Plaquage cathédrale de {p} ! Le stade retient son souffle."],
      ["forward", "Énorme grattage de {p} dans le regroupement, ballon récupéré !"],
      ["any", "Le mur défensif de {p} et de ses partenaires ne cède pas d'un millimètre sur cette ligne de 5 mètres."],
      ["any", "Un arrêt buffet magistral de {p} qui stoppe net l'offensive."],
      ["forward", "{p} gratte le ballon comme un mort de faim dans le regroupement !"],
      ["any", "Un sauvetage héroïque de {p} à deux mètres de la ligne d'essai !"],
      ["forward", "Grattage chirurgical de {p} dans le regroupement ! Le ballon est libéré !"],
      ["forward", "Porteur de balle isolé ! {p} lui gratte le ballon en un éclair !"],
      ["back", "{p} gratte le cuir dans les pieds, contre-attaque éclair à suivre !"],
      ["any", "Cartouche magistrale de {p} au plaquage ! Le ballon gicle des bras !"],
      ["any", "{p} se montre solide en défense sur plusieurs temps de jeu."],
      ["back", "Interception supersonique de {p} ! Il a lu la passe sautée comme dans un livre !"]
    ],
    erreur: [
      ["any", "{p} est sanctionné pour ne pas s'être libéré au sol ! Le ballon change de mains."],
      ["any", "Sanctionné ! {p} ne s'est pas écarté de la zone de plaqueur-plaqué."],
      ["any", "Hors-jeu flagrant de {p} dans la ligne défensive, l'arbitre revient à la faute."],
      ["any", "{p} concède une pénalité pour un plaquage haut."],
      ["any", "Plaquage haut de {p} sans circonstance atténuante : la sanction tombe sans hésitation !"],
      ["any", "L'arbitre ne tolère aucun débat : pénalité pour contestation orale de {p} !"],
      ["any", "En-avant de {p} sous la pression défensive... Mêlée à suivre."],
      ["back", "En-avant de {p} sous la chandelle... Mêlée à suivre !"],
      ["back", "Mauvaise transmission de {p} dans l'intervalle, la passe termine directement en touche !"],
      ["scrumhalf", "{p} se fait chiper le ballon à la sortie du couloir !"],
      ["any", "{p} voit son essai refusé après visionnage vidéo."],
      ["kicker", "{p} manque sa tentative de pénalité, le ballon passe à côté."]
    ],
    arbitre: [
      "L'arbitre forme un rectangle avec ses mains... On fait appel à la vidéo !",
      "Arrêt du jeu, révision des images sous tous les angles pour vérifier s'il y a bien essai.",
      "Consultation du TMO pour analyser la hauteur du contact à l'impact.",
      "L'arbitre ne tolère aucun débat : pénalité pour contestation orale !",
      "Accumulation de fautes répétées, l'arbitre sort le premier avertissement capitaine.",
      "Avantage en cours signalé par le bras tendu de l'arbitre !",
      "L'avantage ne profitant pas, l'arbitre revient à la faute initiale.",
      "Passage à vide signalé sur la combinaison : balle rendue à l'adversaire.",
      "L'arbitre estime que le ballon est devenu injouable dans le regroupement : mêlée à refaire.",
      "Décision très litigieuse qui fait réagir vivement le banc de touche et les tribunes !",
      "Un coup de sifflet autoritaire pour ramener un peu de calme entre les deux capitaines.",
      "Décision logique et pédagogique de l'arbitre central pour tenir son match.",
      "Le public gronde, mais la décision du corps arbitral reste inébranlable."
    ],
    carton_jaune: [
      ["any", "🟨 Carton jaune pour {p} ! Plaquage haut sans circonstance atténuante : dix minutes dans le fond du couloir."],
      ["any", "🟨 Accumulation de fautes répétées : l'arbitre sort le carton jaune à {p} !"],
      ["any", "🟨 {p} écope d'un carton jaune pour avoir ralenti le ballon de façon délibérée."],
      ["forward", "🟨 Mêlée écroulée volontairement : carton jaune pour {p} !"],
      ["any", "🟨 Hors-jeu volontaire de {p} pour stopper l'action : carton jaune !"]
    ],
    carton_rouge: [
      ["any", "🟥 Carton rouge ! {p} est expulsé pour un plaquage dangereux, il ne reviendra pas."],
      ["any", "🟥 Carton rouge direct pour {p} après un geste dangereux : sortie définitive !"],
      ["any", "🟥 {p} voit rouge pour un geste d'antijeu : l'arbitre ne laisse aucune place au doute !"]
    ],
    avant_match: [
      "Les tribunes sont pleines à craquer et le stade explose de couleurs !",
      "La bandas chauffe le public : l'ambiance est électrique avant le coup d'envoi !",
      "Regards fixes dans le couloir des vestiaires, la tension est palpable avant le coup d'envoi.",
      "Des virages en feu qui chantent à s'en déchirer la voix pour l'entrée des joueurs."
    ],
    apres_match: [
      "Direction la buvette pour la troisième mi-temps, là où les rivalités du terrain s'effacent autour d'un verre.",
      "Les supporters raccompagnent leurs héros sous une haie d'honneur improvisée."
    ]
  };

  // ---------------------------------------------------------
  // PHASES DE JEU : pondération du tirage à chaque temps fort
  // ---------------------------------------------------------
  const PHASES = [
    ["essai", 25], ["penalite", 14], ["dropgoal", 4], ["essai_penalite", 2],
    ["conquete", 18], ["main", 9], ["pied", 8], ["defense", 10], ["erreur", 7], ["arbitre", 3],
    ["carton_jaune", 4], ["carton_rouge", 1]
  ];
  const PHASE_TOTAL = PHASES.reduce((s, p) => s + p[1], 0);
  function pickPhase() {
    let r = Math.random() * PHASE_TOTAL;
    for (const [key, w] of PHASES) {
      r -= w;
      if (r < 0) return key;
    }
    return "conquete";
  }

  function withName(template, name) {
    return template.split("{p}").join(`<strong>${name}</strong>`);
  }

  // Effectifs actifs, qui évoluent au fil des remplacements
  const activeUser = [...userTitulaires];
  const activeCpu = [...cpuTitulaires];
  const fullSize = { user: userTitulaires.length, cpu: cpuTitulaires.length };
  const yellowCarded = { user: new Set(), cpu: new Set() }; // joueurs déjà avertis d'un jaune
  const queue = []; // temps forts, remplacements et retours de carton jaune, triés par minute

  function fieldCounts() {
    return { user: activeUser.length, cpu: activeCpu.length };
  }

  // Chaque joueur en moins fait perdre ~10 points de probabilité de jouer le ballon :
  // l'équipe à 14 subit davantage d'actions adverses (jaune = 10 min, rouge = jusqu'à la fin).
  function currentAdvantage() {
    const missUser = fullSize.user - activeUser.length;
    const missCpu = fullSize.cpu - activeCpu.length;
    return Math.max(0.15, Math.min(0.85, userAdvantage + 0.10 * (missCpu - missUser)));
  }

  events.push({ minute: 0, text: `Coup d'envoi ! <strong>${userName}</strong> affronte <strong>${cpuName}</strong>.`, team: null, points: 0, important: true });
  events.push({ minute: 0, text: randomOf(T.avant_match), team: null, points: 0, important: false });

  // ---------------------------------------------------------
  // REMPLACEMENTS : un remplaçant n'entre que si un titulaire a au moins
  // un poste en commun avec lui. Un joueur entré en jeu ne ressort pas.
  // ---------------------------------------------------------
  const usedSubs = { user: new Set(), cpu: new Set() };
  const cameOn = { user: new Set(), cpu: new Set() };
  const sharesPosition = (a, b) => (a.positions || []).some(pos => (b.positions || []).includes(pos));

  function applySub(minute, side) {
    const bench = side === "user" ? userBanc : cpuBanc;
    const active = side === "user" ? activeUser : activeCpu;
    const label = side === "user" ? userName : cpuName;

    const candidates = (bench || [])
      .filter(p => !usedSubs[side].has(getCardKey(p)))
      .sort(() => Math.random() - 0.5);

    for (const incoming of candidates) {
      const outIdxs = [];
      active.forEach((p, i) => {
        if (!cameOn[side].has(getCardKey(p)) && sharesPosition(p, incoming)) outIdxs.push(i);
      });
      if (outIdxs.length === 0) continue; // aucun titulaire compatible : on essaie un autre remplaçant

      const outIdx = outIdxs[Math.floor(Math.random() * outIdxs.length)];
      const outgoing = active[outIdx];
      usedSubs[side].add(getCardKey(incoming));
      cameOn[side].add(getCardKey(incoming));
      active[outIdx] = incoming;

      events.push({
        minute,
        text: `🔄 Changement chez ${label} : <strong>${incoming.name}</strong> remplace <strong>${outgoing.name}</strong>.`,
        team: side, points: 0, important: false, isSub: true
      });
      return;
    }
  }

  function pickSubMinutes(banc) {
    if (!banc || banc.length === 0) return [];
    const maxSubs = Math.min(banc.length, 1 + Math.floor(Math.random() * 3));
    const used = new Set();
    while (used.size < maxSubs) {
      used.add(45 + Math.floor(Math.random() * 30));
    }
    return Array.from(used);
  }

  // ---------------------------------------------------------
  // CARTONS : jaune = le joueur sort 10 minutes puis revient ;
  // rouge (ou 2e jaune) = sortie définitive, l'équipe finit à 14.
  // ---------------------------------------------------------
  function giveCard(minute, side, kind) {
    const active = side === "user" ? activeUser : activeCpu;
    const label = side === "user" ? userName : cpuName;
    if (active.length <= 11) return; // sécurité : jamais moins de 11 joueurs

    const [role, tpl] = randomOf(T[kind]);
    const player = pickPlayerObj(active, role);
    if (!player) return;
    const key = getCardKey(player);

    let isRed = kind === "carton_rouge";
    let text;
    if (!isRed && yellowCarded[side].has(key)) {
      isRed = true; // deuxième jaune = rouge
      text = `🟥 Deuxième carton jaune pour <strong>${player.name}</strong> : c'est un carton rouge, sortie définitive !`;
    } else {
      text = withName(tpl, player.name);
    }

    active.splice(active.indexOf(player), 1);

    if (isRed) {
      text += ` ${label} terminera le match à ${active.length}.`;
    } else {
      yellowCarded[side].add(key);
      if (minute + 10 <= 79) {
        text += ` ${label} évolue à ${active.length} pendant 10 minutes.`;
        queue.push({ minute: minute + 10, order: 0, kind: "return", side, player });
      } else {
        text += ` ${label} évolue à ${active.length} jusqu'à la fin du match.`;
      }
    }

    events.push({ minute, text, team: side, points: 0, important: true, field: fieldCounts(), isCard: true });
  }

  function returnFromBin(minute, side, player) {
    const active = side === "user" ? activeUser : activeCpu;
    const label = side === "user" ? userName : cpuName;
    active.push(player);
    events.push({
      minute,
      text: `⏱️ Dix minutes écoulées : <strong>${player.name}</strong> revient sur le terrain. ${label} est de nouveau à ${active.length}.`,
      team: side, points: 0, important: false, field: fieldCounts()
    });
  }

  // ---------------------------------------------------------
  // UN TEMPS FORT DU MATCH
  // ---------------------------------------------------------
  function playMoment(minute) {
    const isUser = Math.random() < currentAdvantage();
    const team = isUser ? "user" : "cpu";
    const active = isUser ? activeUser : activeCpu;
    const teamName = isUser ? userName : cpuName;
    const phase = pickPhase();

    if (phase === "arbitre") {
      events.push({ minute, text: randomOf(T.arbitre), team: null, points: 0, important: false });
      return;
    }

    if (phase === "carton_jaune" || phase === "carton_rouge") {
      // le carton sanctionne l'équipe qui commet la faute : on tire l'équipe fautive au hasard
      giveCard(minute, Math.random() < 0.5 ? "user" : "cpu", phase);
      return;
    }

    if (phase === "essai_penalite") {
      events.push({
        minute,
        text: `Geste d'antijeu manifeste pour empêcher une action d'essai... Essai de pénalité accordé à <strong>${teamName}</strong> !`,
        team, points: 7, important: true
      });
      return;
    }

    if (phase === "essai") {
      const pool = Math.random() < 0.35 ? T.essai_avant : T.essai_arriere;
      const [role, tpl] = randomOf(pool);
      const points = Math.random() < 0.75 ? 7 : 5; // transformé ou non
      const text = withName(tpl, pickPlayer(active, role, teamName)) + (points === 7 ? "" : " (transformation manquée)");
      events.push({ minute, text, team, points, important: true });
      return;
    }

    if (phase === "penalite" || phase === "dropgoal") {
      const [role, tpl] = randomOf(T[phase]);
      events.push({
        minute,
        text: withName(tpl, pickPlayer(active, role, teamName)),
        team, points: 3, important: phase === "dropgoal"
      });
      return;
    }

    // Phases sans points : conquête, jeu courant, jeu au pied, défense, erreurs
    const [role, tpl] = randomOf(T[phase]);
    events.push({ minute, text: withName(tpl, pickPlayer(active, role, teamName)), team, points: 0, important: false });
  }

  // ---------------------------------------------------------
  // DÉROULÉ CHRONOLOGIQUE : temps forts + remplacements dans l'ordre,
  // pour que les remplaçants entrés en jeu puissent ensuite être cités.
  // ---------------------------------------------------------
  let m = 3;
  while (m < 80) {
    queue.push({ minute: m, order: 1, kind: "play" });
    m += 4 + Math.floor(Math.random() * 8);
  }
  pickSubMinutes(userBanc).forEach(min => queue.push({ minute: min, order: 0, kind: "sub-user" }));
  pickSubMinutes(cpuBanc).forEach(min => queue.push({ minute: min, order: 0, kind: "sub-cpu" }));

  while (queue.length > 0) {
    queue.sort((a, b) => a.minute - b.minute || a.order - b.order);
    const item = queue.shift();
    if (item.kind === "sub-user") applySub(item.minute, "user");
    else if (item.kind === "sub-cpu") applySub(item.minute, "cpu");
    else if (item.kind === "return") returnFromBin(item.minute, item.side, item.player);
    else playMoment(item.minute);
  }

  // ---------------------------------------------------------
  // COUP DE SIFFLET FINAL + ambiance de fin de match selon le résultat
  // ---------------------------------------------------------
  let userPts = 0, cpuPts = 0;
  events.forEach(e => {
    if (e.points) {
      if (e.team === "user") userPts += e.points;
      else cpuPts += e.points;
    }
  });

  events.push({ minute: 80, text: "Coup de sifflet final ! 🏉", team: null, points: 0, important: true });
  events.push({ minute: 80, text: randomOf(T.apres_match), team: null, points: 0, important: false });

  if (userPts !== cpuPts) {
    const winner = userPts > cpuPts ? userName : cpuName;
    const loser = userPts > cpuPts ? cpuName : userName;
    const text = Math.random() < 0.5
      ? `Une victoire fêtée comme il se doit dans le vestiaire de <strong>${winner}</strong> : les chants résonnent dans tout le stade !`
      : `Conférence de presse électrique chez <strong>${loser}</strong> : le coach n'a pas du tout apprécié la prestation de ses avants.`;
    events.push({ minute: 80, text, team: null, points: 0, important: false });
  }

  return events;
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
          <select id="admin-card-select" class="admin-select" size="8" style="height:200px"></select>
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
          <button class="admin-db-tab" id="admin-tab-note">⭐ Notes</button>
        </div>
        <!-- Filtres communs aux onglets Supprimer / Modifier / Notes -->
        <div id="admin-db-filters" class="admin-db-filters hidden">
          <select id="admin-filter-club" class="admin-select">
            <option value="all">Tous les clubs</option>
            ${Object.entries(TEAMS).map(([k,v])=>`<option value="${k}">${v.name}</option>`).join("")}
          </select>
          <select id="admin-filter-rarity" class="admin-select">
            <option value="all">Toutes les raretés</option>
            ${Object.entries(RARITIES).map(([k,v])=>`<option value="${k}">${v.label}</option>`).join("")}
          </select>
        </div>
        <!-- Formulaire notes -->
        <div id="admin-form-note" class="admin-db-form hidden">
          <input type="text" id="note-player-search" class="admin-input" placeholder="🔍 Rechercher un joueur">
          <select id="note-player-select" class="admin-select" size="8" style="height:200px"></select>
          <div id="note-player-fields" class="hidden">

            <div class="admin-edit-sep">Sous-statistiques (30-99) :</div>
            <div class="admin-stats-grid">
              <label class="admin-stat-field">
                <span>⚡ Vitesse</span>
                <input type="number" id="stat-vitesse-input" class="admin-input" min="30" max="99">
              </label>
              <label class="admin-stat-field">
                <span>💪 Puissance</span>
                <input type="number" id="stat-puissance-input" class="admin-input" min="30" max="99">
              </label>
              <label class="admin-stat-field">
                <span>🛡️ Défense</span>
                <input type="number" id="stat-defense-input" class="admin-input" min="30" max="99">
              </label>
              <label class="admin-stat-field">
                <span>🎯 Passe</span>
                <input type="number" id="stat-passe-input" class="admin-input" min="30" max="99">
              </label>
              <label class="admin-stat-field">
                <span>✨ Technique</span>
                <input type="number" id="stat-technique-input" class="admin-input" min="30" max="99">
              </label>
            </div>

            <div class="admin-edit-sep">Note générale :</div>
            <div class="admin-row" style="align-items:center;gap:1rem">
              <input type="number" id="note-value-input" class="admin-input" min="30" max="99" placeholder="Auto (calculée)" style="max-width:160px">
              <span id="note-label-preview" style="font-size:0.82rem;color:var(--text-muted)"></span>
            </div>
            <p class="admin-note" style="margin:0.2rem 0 0.6rem">La note générale est calculée automatiquement à partir des sous-statistiques et du poste principal. Tu peux aussi la forcer manuellement en la saisissant ci-dessus (elle prendra alors le pas sur le calcul).</p>

            <button id="admin-save-note-btn" class="admin-btn">💾 Sauvegarder pour tous</button>
            <button id="admin-reset-note-btn" class="admin-btn" style="background:rgba(255,255,255,0.08);color:var(--text-muted);margin-top:0.3rem">🔄 Réinitialiser (valeurs automatiques)</button>
            <div id="admin-note-status" class="admin-status"></div>
          </div>
          <p class="admin-note">⚠️ Les modifications s'appliquent définitivement pour tous les joueurs via Firestore.</p>
        </div>
        <!-- Formulaire modification -->
        <div id="admin-form-edit" class="admin-db-form hidden">
          <input type="text" id="edit-player-search" class="admin-input" placeholder="🔍 Rechercher un joueur à modifier">
          <select id="edit-player-select" class="admin-select" size="8" style="height:200px"></select>
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
            <select id="edit-player-nat" class="admin-select">
              ${Object.entries(NATIONALITIES).map(([k,v])=>`<option value="${k}">${v}</option>`).join("")}
            </select>
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
          <input type="text" id="new-player-nat" class="admin-input" placeholder="Nationalité (ex: FRA)">

          <div class="admin-edit-sep">Sous-statistiques (30-99, optionnel) :</div>
          <div class="admin-stats-grid">
            <label class="admin-stat-field">
              <span>⚡ Vitesse</span>
              <input type="number" id="new-player-stat-vitesse" class="admin-input" min="30" max="99" placeholder="Auto">
            </label>
            <label class="admin-stat-field">
              <span>💪 Puissance</span>
              <input type="number" id="new-player-stat-puissance" class="admin-input" min="30" max="99" placeholder="Auto">
            </label>
            <label class="admin-stat-field">
              <span>🛡️ Défense</span>
              <input type="number" id="new-player-stat-defense" class="admin-input" min="30" max="99" placeholder="Auto">
            </label>
            <label class="admin-stat-field">
              <span>🎯 Passe</span>
              <input type="number" id="new-player-stat-passe" class="admin-input" min="30" max="99" placeholder="Auto">
            </label>
            <label class="admin-stat-field">
              <span>✨ Technique</span>
              <input type="number" id="new-player-stat-technique" class="admin-input" min="30" max="99" placeholder="Auto">
            </label>
          </div>

          <div class="admin-edit-sep">Note générale (optionnel) :</div>
          <input type="number" id="new-player-note" class="admin-input" min="30" max="99" placeholder="Note générale — laisse vide pour calcul automatique">

          <button id="admin-add-player-btn" class="admin-btn">Ajouter</button>
          <div id="admin-add-player-status" class="admin-status"></div>
          <p class="admin-note">⚠️ Ajout en mémoire uniquement. Modification sauvegardée dans Firestore pour tous les joueurs. Si tu laisses les sous-stats vides, elles seront générées automatiquement ; la note générale sera alors calculée à partir d'elles selon le poste.</p>
        </div>
        <div id="admin-form-remove" class="admin-db-form hidden">
          <input type="text" id="remove-player-search" class="admin-input" placeholder="🔍 Rechercher un joueur">
          <select id="remove-player-select" class="admin-select" size="8" style="height:200px"></select>
          <button id="admin-remove-player-btn" class="admin-btn" style="background:#cc0000;color:#fff">Supprimer</button>
          <div id="admin-remove-player-status" class="admin-status"></div>
          <p class="admin-note">⚠️ Suppression en mémoire uniquement. Suppression sauvegardée dans Firestore pour tous les joueurs.</p>
        </div>
      </div>

      <div class="admin-card admin-card-full">
        <h3>💾 Exporter / importer la base de données</h3>
        <p class="admin-note" style="margin-top:0;margin-bottom:0.8rem">
          Génère un fichier <code>data.js</code> à jour incluant tous les ajouts, suppressions, modifications de postes/clubs/raretés et notes personnalisées effectués depuis ce panneau. Télécharge-le et remplace le fichier existant sur ton hébergement pour rendre les changements permanents dans le code source.
        </p>
        <button id="admin-export-data-btn" class="admin-btn">⬇️ Télécharger data.js à jour</button>
        <div id="admin-export-status" class="admin-status"></div>

        <div class="admin-edit-sep">Importer un fichier data.js</div>
        <p class="admin-note" style="margin-top:0;margin-bottom:0.8rem">
          Choisis un fichier <code>data.js</code> (par exemple un export que tu as retouché à la main). Un aperçu des changements s'affiche avant toute modification : ajouts et suppressions de joueurs, changements de club, de poste, de rareté ou de nationalité, notes et sous-notes. Le fichier est analysé sans être exécuté.
        </p>
        <input type="file" id="admin-import-file" class="admin-input" accept=".js,text/javascript,application/javascript">
        <div id="admin-import-preview" class="admin-import-preview hidden"></div>
        <div id="admin-import-status" class="admin-status"></div>
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

  // Listener temps réel pour les joueurs connectés (ne compte que les présences fraîches)
  if (presenceListenerUnsubscribe) presenceListenerUnsubscribe(); // éviter les doublons
  presenceListenerUnsubscribe = db.collection("presence").onSnapshot(snap => {
    const el = document.getElementById("admin-online-count");
    if (!el) return;
    const now = Date.now();
    let onlineCount = 0;
    snap.forEach(doc => {
      const data = doc.data();
      const lastSeenMs = data.lastSeen?.toMillis ? data.lastSeen.toMillis() : 0;
      if (now - lastSeenMs < PRESENCE_STALE_MS) onlineCount++;
    });
    el.textContent = onlineCount;
  }, err => {
    console.warn("Listener présence indisponible:", err.message);
    const el = document.getElementById("admin-online-count");
    if (el) el.textContent = "?";
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

// Récupère les filtres actifs dans l'admin DB
function getAdminFilters() {
  const club = document.getElementById("admin-filter-club")?.value || "all";
  const rarity = document.getElementById("admin-filter-rarity")?.value || "all";
  return { club, rarity };
}

// Filtre un tableau de joueurs selon les filtres admin + recherche texte
function applyAdminFilters(players, q) {
  const { club, rarity } = getAdminFilters();
  return players.filter(p => {
    if (club !== "all" && p.team !== club) return false;
    if (rarity !== "all" && p.rarity !== rarity) return false;
    if (q && !p.name.toLowerCase().includes(q.toLowerCase()) &&
        !(TEAMS[p.team]?.name||"").toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  }).slice(0, 100);
}

function refreshRemovePlayerList(q) {
  const sel = document.getElementById("remove-player-select");
  if (!sel) return;
  const filtered = applyAdminFilters(PLAYERS, q || "");
  sel.innerHTML = filtered.map(p =>
    `<option value="${getCardKey(p)}">${p.name} — ${TEAMS[p.team]?.name||p.team} [${RARITIES[p.rarity]?.label||p.rarity}]</option>`
  ).join("");
}

function refreshEditPlayerList(q) {
  const sel = document.getElementById("edit-player-select");
  if (!sel) return;
  const filtered = applyAdminFilters(PLAYERS, q || "");
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

  // Importer un data.js
  bindDataImport();

  // Exporter data.js à jour
  document.getElementById("admin-export-data-btn").onclick = () => {
    const st = document.getElementById("admin-export-status");
    try {
      const fileContent = generateDataJsFile();
      const blob = new Blob([fileContent], { type: "text/javascript;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "data.js";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      st.textContent = `✓ data.js téléchargé (${PLAYERS.length} joueurs).`;
    } catch(e) {
      st.textContent = `❌ Erreur export : ${e.message}`;
    }
  };

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

      // XV Démarrage : tirage positionnel spécial
      if (pack.id === "xv_demarrage") {
        const xvCards = drawXVDemarrage();
        drawn.push(...xvCards);
      }
      // Coup d'Envoi : tirage avec les probabilités du pack quotidien
      else if (pack.id === "coup_envoi") {
        const result = drawCoupEnvoi();
        drawn.push(...result.cards);
        // Bonus RUGBIZ aussi
        const userCoins = (doc.data()?.coins || 0) + result.bonus;
        await db.collection("users").doc(uid).update({ coins: userCoins });
      }
      // Pack Club : cartes du club du jour (sans légendes)
      else if (pack.id === "club") {
        const clubKey = getClubOfTheDay();
        if (clubKey) drawn.push(...drawClubPackCards(pack, clubKey));
      }
      // Autres packs : tirage normal
      else {
        for (let i = 0; i < pack.cardsCount; i++) {
          drawn.push(pack.forcedRarity ? drawCardOfRarity(pack.forcedRarity) : drawRandomCard(pack));
        }
      }

      const cardKeys = [];
      drawn.forEach(card => {
        const key = getCardKey(card);
        cardKeys.push(key);
        const ex = userCollection[key] || { count:0, lockedCount:0 };
        userCollection[key] = { count:(ex.count||0)+1, lockedCount: pack.locked ? (ex.lockedCount||0)+1 : ex.lockedCount||0 };
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
    // (bouton +100 supprimé définitivement)
  };

  // Tabs add/remove
  document.getElementById("admin-tab-add").onclick = () => {
    document.getElementById("admin-tab-add").classList.add("active");
    ["admin-tab-remove","admin-tab-edit","admin-tab-note"].forEach(id => document.getElementById(id).classList.remove("active"));
    document.getElementById("admin-form-add").classList.remove("hidden");
    ["admin-form-remove","admin-form-edit","admin-form-note"].forEach(id => document.getElementById(id).classList.add("hidden"));
    document.getElementById("admin-db-filters").classList.add("hidden");
  };
  document.getElementById("admin-tab-remove").onclick = () => {
    document.getElementById("admin-tab-remove").classList.add("active");
    ["admin-tab-add","admin-tab-edit","admin-tab-note"].forEach(id => document.getElementById(id).classList.remove("active"));
    document.getElementById("admin-form-remove").classList.remove("hidden");
    ["admin-form-add","admin-form-edit","admin-form-note"].forEach(id => document.getElementById(id).classList.add("hidden"));
    document.getElementById("admin-db-filters").classList.remove("hidden");
    refreshRemovePlayerList("");
  };
  document.getElementById("admin-tab-edit").onclick = () => {
    document.getElementById("admin-tab-edit").classList.add("active");
    ["admin-tab-add","admin-tab-remove","admin-tab-note"].forEach(id => document.getElementById(id).classList.remove("active"));
    document.getElementById("admin-form-edit").classList.remove("hidden");
    ["admin-form-add","admin-form-remove","admin-form-note"].forEach(id => document.getElementById(id).classList.add("hidden"));
    document.getElementById("admin-db-filters").classList.remove("hidden");
    refreshEditPlayerList("");
  };
  document.getElementById("admin-tab-note").onclick = () => {
    document.getElementById("admin-tab-note").classList.add("active");
    ["admin-tab-add","admin-tab-remove","admin-tab-edit"].forEach(id => document.getElementById(id).classList.remove("active"));
    document.getElementById("admin-form-note").classList.remove("hidden");
    ["admin-form-add","admin-form-remove","admin-form-edit"].forEach(id => document.getElementById(id).classList.add("hidden"));
    document.getElementById("admin-db-filters").classList.remove("hidden");
    refreshNotePlayerList("");
  };

  // Filtres club + rareté — rafraîchit la liste active
  const refreshActiveList = () => {
    if (!document.getElementById("admin-form-remove").classList.contains("hidden")) {
      refreshRemovePlayerList(document.getElementById("remove-player-search")?.value || "");
    } else if (!document.getElementById("admin-form-edit").classList.contains("hidden")) {
      refreshEditPlayerList(document.getElementById("edit-player-search")?.value || "");
    } else if (!document.getElementById("admin-form-note").classList.contains("hidden")) {
      refreshNotePlayerList(document.getElementById("note-player-search")?.value || "");
    }
  };
  document.getElementById("admin-filter-club").addEventListener("change", refreshActiveList);
  document.getElementById("admin-filter-rarity").addEventListener("change", refreshActiveList);

  // Afficher champ clubs si rareté = legendaire
  document.getElementById("new-player-rarity").onchange = (e) => {
    const clubsRow = document.getElementById("new-player-clubs-row");
    if (clubsRow) clubsRow.classList.toggle("hidden", e.target.value !== "legendaire");
  };

  // Ajouter joueur (prénom + nom + clubs + sous-stats)
  document.getElementById("admin-add-player-btn").onclick = async () => {
    const firstname = document.getElementById("new-player-firstname").value.trim();
    const lastname  = document.getElementById("new-player-lastname").value.trim();
    const name = [firstname, lastname].filter(Boolean).join(" ");
    const team = document.getElementById("new-player-team").value;
    const rarity = document.getElementById("new-player-rarity").value;
    const positions = document.getElementById("new-player-positions").value.split("|").map(p=>p.trim()).filter(Boolean);
    const nat = document.getElementById("new-player-nat").value.trim() || "FRA";
    const noteInput = parseInt(document.getElementById("new-player-note").value, 10);
    const customNote = !isNaN(noteInput) && noteInput >= 30 && noteInput <= 99 ? noteInput : null;
    const clubsInput = document.getElementById("new-player-clubs");
    const clubs = (rarity === "legendaire" && clubsInput?.value)
      ? clubsInput.value.split("/").map(c=>c.trim()).filter(Boolean)
      : undefined;
    const st = document.getElementById("admin-add-player-status");

    if (!name) { st.textContent = "⚠️ Entre un prénom ou un nom."; return; }
    if (!positions.length) { st.textContent = "⚠️ Entre au moins un poste."; return; }

    // Sous-stats saisies manuellement (si vides → génération auto plus tard)
    const statInputs = {
      vitesse:   document.getElementById("new-player-stat-vitesse").value,
      puissance: document.getElementById("new-player-stat-puissance").value,
      defense:   document.getElementById("new-player-stat-defense").value,
      passe:     document.getElementById("new-player-stat-passe").value,
      technique: document.getElementById("new-player-stat-technique").value
    };
    const customStats = {};
    let hasCustomStats = false;
    for (const [k, v] of Object.entries(statInputs)) {
      if (v !== "") {
        const n = parseInt(v, 10);
        if (isNaN(n) || n < 30 || n > 99) { st.textContent = `⚠️ ${k} doit être entre 30 et 99.`; return; }
        customStats[k] = n;
        hasCustomStats = true;
      }
    }

    const newPlayer = { name, team, positions, rarity, nat };
    if (clubs?.length) newPlayer.clubs = clubs;

    st.textContent = "Sauvegarde en cours...";
    try {
      const doc = await db.collection("playersOverrides").doc("data").get();
      const existing = doc.exists ? doc.data() : { added: [], removed: [] };
      const added = existing.added || [];
      const removed = existing.removed || [];
      const notes = existing.notes || {};
      const statsMap = existing.stats || {};

      const newKey = getCardKey(newPlayer);
      if (added.some(p => getCardKey(p) === newKey)) {
        st.textContent = "⚠️ Ce joueur existe déjà dans les ajouts.";
        return;
      }

      added.push(newPlayer);

      // Sous-stats personnalisées (fusionnées avec les valeurs auto pour les champs vides)
      if (hasCustomStats) {
        const autoStats = generateBaseStats(newPlayer);
        const finalStats = { ...autoStats, ...customStats };
        statsMap[newKey] = finalStats;
        statsOverrides[newKey] = finalStats;
      }

      // Note générale forcée si fournie
      if (customNote !== null) {
        notes[newKey] = customNote;
        noteOverrides[newKey] = customNote;
      }

      await db.collection("playersOverrides").doc("data").set(
        { ...existing, added, removed, notes, stats: statsMap, updatedAt: firebase.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );

      PLAYERS.push(newPlayer);
      const displayNote = customNote !== null
        ? customNote
        : calculerNoteGenerale(newPlayer, hasCustomStats ? statsOverrides[newKey] : generateBaseStats(newPlayer));
      st.textContent = `✓ ${name} (${TEAMS[team]?.name||team}, ${rarity}, note ${displayNote}) ajouté pour tous !`;
      try { await logAdminAction("joueur_ajouté", `${name} — ${TEAMS[team]?.name||team} [${rarity}, note ${displayNote}]`); } catch(_) {}
    } catch(e) {
      st.textContent = `❌ Erreur : ${e.message}`;
    }

    // Reset form
    document.getElementById("new-player-firstname").value = "";
    document.getElementById("new-player-lastname").value = "";
    document.getElementById("new-player-positions").value = "";
    document.getElementById("new-player-nat").value = "";
    document.getElementById("new-player-note").value = "";
    ["new-player-stat-vitesse","new-player-stat-puissance","new-player-stat-defense","new-player-stat-passe","new-player-stat-technique"]
      .forEach(id => document.getElementById(id).value = "");
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
    document.getElementById("edit-player-nat").value = (player.nat || "FRA").toUpperCase();
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
    const newNat = document.getElementById("edit-player-nat").value;

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
      const editEntry = { key, team: newTeam, rarity: newRarity, positions: newPositions, nat: newNat };
      if (editIdx >= 0) edited[editIdx] = editEntry;
      else edited.push(editEntry);

      await db.collection("playersOverrides").doc("data").set(
        { added, removed, edited, updatedAt: firebase.firestore.FieldValue.serverTimestamp(), updatedBy: "ChocoDeLaVega" },
        { merge: true }
      );

      // Appliquer localement immédiatement
      const idx = PLAYERS.findIndex(p => `${p.name}|${p.team}` === key);
      if (idx >= 0) {
        PLAYERS[idx].team = newTeam;
        PLAYERS[idx].rarity = newRarity;
        PLAYERS[idx].positions = newPositions;
        PLAYERS[idx].nat = newNat;
      }

      const playerName = key.split("|")[0];
      st.textContent = `✓ ${playerName} modifié pour tous !`;
      try { await logAdminAction("joueur_modifié", `${playerName} → club:${TEAMS[newTeam]?.name||newTeam}, rareté:${newRarity}, nat:${newNat}`); } catch(_) {}
    } catch(e) {
      st.textContent = `❌ Erreur : ${e.message}`;
    }
  };

  // === Notes joueurs (sous-stats + note générale) ===
  document.getElementById("note-player-search").oninput = (e) => refreshNotePlayerList(e.target.value);

  document.getElementById("note-player-select").onchange = () => {
    const key = document.getElementById("note-player-select").value;
    if (!key) { document.getElementById("note-player-fields").classList.add("hidden"); return; }
    const player = PLAYERS.find(p => `${p.name}|${p.team}` === key);
    if (!player) return;

    const stats = getPlayerStats(player);
    document.getElementById("stat-vitesse-input").value = stats.vitesse;
    document.getElementById("stat-puissance-input").value = stats.puissance;
    document.getElementById("stat-defense-input").value = stats.defense;
    document.getElementById("stat-passe-input").value = stats.passe;
    document.getElementById("stat-technique-input").value = stats.technique;

    // Note générale : si forcée manuellement, l'afficher ; sinon laisser vide (auto)
    const forcedNote = noteOverrides[key];
    document.getElementById("note-value-input").value = forcedNote !== undefined ? forcedNote : "";
    const displayedNote = forcedNote !== undefined ? forcedNote : calculerNoteGenerale(player, stats);
    updateNotePreview(displayedNote);

    document.getElementById("note-player-fields").classList.remove("hidden");
    document.getElementById("admin-note-status").textContent = "";
  };

  // Recalcule la note générale en direct quand une sous-stat change (si note pas forcée)
  const recomputeLiveNote = () => {
    const key = document.getElementById("note-player-select").value;
    const player = PLAYERS.find(p => `${p.name}|${p.team}` === key);
    if (!player) return;
    const forcedVal = document.getElementById("note-value-input").value;
    if (forcedVal !== "") { updateNotePreview(parseInt(forcedVal, 10)); return; }
    const stats = {
      vitesse:   parseInt(document.getElementById("stat-vitesse-input").value, 10) || 60,
      puissance: parseInt(document.getElementById("stat-puissance-input").value, 10) || 60,
      defense:   parseInt(document.getElementById("stat-defense-input").value, 10) || 60,
      passe:     parseInt(document.getElementById("stat-passe-input").value, 10) || 60,
      technique: parseInt(document.getElementById("stat-technique-input").value, 10) || 60
    };
    updateNotePreview(calculerNoteGenerale(player, stats));
  };
  ["stat-vitesse-input","stat-puissance-input","stat-defense-input","stat-passe-input","stat-technique-input"]
    .forEach(id => document.getElementById(id).oninput = recomputeLiveNote);

  document.getElementById("note-value-input").oninput = (e) => {
    const val = e.target.value;
    if (val === "") { recomputeLiveNote(); return; }
    updateNotePreview(parseInt(val, 10) || 0);
  };

  document.getElementById("admin-save-note-btn").onclick = async () => {
    const key = document.getElementById("note-player-select").value;
    const st = document.getElementById("admin-note-status");
    if (!key) { st.textContent = "⚠️ Sélectionne un joueur."; return; }

    const stats = {
      vitesse:   parseInt(document.getElementById("stat-vitesse-input").value, 10),
      puissance: parseInt(document.getElementById("stat-puissance-input").value, 10),
      defense:   parseInt(document.getElementById("stat-defense-input").value, 10),
      passe:     parseInt(document.getElementById("stat-passe-input").value, 10),
      technique: parseInt(document.getElementById("stat-technique-input").value, 10)
    };
    for (const [k, v] of Object.entries(stats)) {
      if (isNaN(v) || v < 30 || v > 99) { st.textContent = `⚠️ ${k} doit être entre 30 et 99.`; return; }
    }

    const forcedNoteVal = document.getElementById("note-value-input").value;
    const forcedNote = forcedNoteVal !== "" ? parseInt(forcedNoteVal, 10) : null;
    if (forcedNote !== null && (forcedNote < 30 || forcedNote > 99)) {
      st.textContent = "⚠️ Note générale doit être entre 30 et 99."; return;
    }

    st.textContent = "Sauvegarde...";
    try {
      const doc = await db.collection("playersOverrides").doc("data").get();
      const existing = doc.exists ? doc.data() : {};
      const notesMap = existing.notes || {};
      const statsMap = existing.stats || {};

      statsMap[key] = stats;
      statsOverrides[key] = stats;

      if (forcedNote !== null) {
        notesMap[key] = forcedNote;
        noteOverrides[key] = forcedNote;
      } else {
        delete notesMap[key];
        delete noteOverrides[key];
      }

      await db.collection("playersOverrides").doc("data").set(
        { ...existing, notes: notesMap, stats: statsMap, updatedAt: firebase.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );

      const playerName = key.split("|")[0];
      const player = PLAYERS.find(p => `${p.name}|${p.team}` === key);
      const finalNote = forcedNote !== null ? forcedNote : calculerNoteGenerale(player, stats);
      st.textContent = `✓ ${playerName} → note ${finalNote} (${getNoteLabel(finalNote)}) pour tous !`;
      try { await logAdminAction("note", `${playerName} → ${finalNote} (${getNoteLabel(finalNote)}) [V:${stats.vitesse} P:${stats.puissance} D:${stats.defense} Pa:${stats.passe} T:${stats.technique}]`); } catch(_) {}
    } catch(e) { st.textContent = `❌ ${e.message}`; }
  };

  document.getElementById("admin-reset-note-btn").onclick = async () => {
    const key = document.getElementById("note-player-select").value;
    const st = document.getElementById("admin-note-status");
    if (!key) { st.textContent = "⚠️ Sélectionne un joueur."; return; }
    st.textContent = "Réinitialisation...";
    try {
      const doc = await db.collection("playersOverrides").doc("data").get();
      const existing = doc.exists ? doc.data() : {};
      const notesMap = existing.notes || {};
      const statsMap = existing.stats || {};
      delete notesMap[key];
      delete statsMap[key];
      await db.collection("playersOverrides").doc("data").set(
        { ...existing, notes: notesMap, stats: statsMap, updatedAt: firebase.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
      delete noteOverrides[key];
      delete statsOverrides[key];
      const playerName = key.split("|")[0];
      st.textContent = `✓ ${playerName} → valeurs automatiques restaurées.`;
      // Recharger l'affichage avec les valeurs auto
      document.getElementById("note-player-select").dispatchEvent(new Event("change"));
    } catch(e) { st.textContent = `❌ ${e.message}`; }
  };
}

// ---------------------------------------------------------
// IMPORT data.js (panneau Admin)
// ===== IMPORT data.js : DEBUT =====
// Le fichier est ANALYSÉ (jamais exécuté) : aucun code du fichier ne tourne dans le navigateur.
// ---------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Analyse un littéral JavaScript (objets, tableaux, chaînes, nombres, commentaires)
function parseJsLiteral(text, start) {
  let i = start;
  const fail = msg => { throw new Error(`${msg} (position ${i})`); };

  function skip() {
    for (;;) {
      const c = text[i];
      if (c === " " || c === "\n" || c === "\r" || c === "\t" || c === "\ufeff") { i++; continue; }
      if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
      if (c === "/" && text[i + 1] === "*") {
        const end = text.indexOf("*/", i + 2);
        if (end < 0) fail("Commentaire non fermé");
        i = end + 2;
        continue;
      }
      break;
    }
  }

  function parseString() {
    const q = text[i];
    i++;
    let out = "";
    const esc = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0" };
    while (i < text.length) {
      const c = text[i];
      if (c === q) { i++; return out; }
      if (c === "\\") {
        const n = text[i + 1];
        if (n === "u") { out += String.fromCharCode(parseInt(text.substr(i + 2, 4), 16)); i += 6; continue; }
        out += Object.prototype.hasOwnProperty.call(esc, n) ? esc[n] : n;
        i += 2;
        continue;
      }
      if (c === "\n") fail("Chaîne non fermée");
      out += c;
      i++;
    }
    return fail("Chaîne non fermée");
  }

  function parseValue() {
    skip();
    const c = text[i];
    if (c === "[") {
      i++;
      const arr = [];
      for (;;) {
        skip();
        if (text[i] === "]") { i++; return arr; }
        arr.push(parseValue());
        skip();
        if (text[i] === ",") i++;
        else if (text[i] !== "]") fail("',' ou ']' attendu");
      }
    }
    if (c === "{") {
      i++;
      const obj = {};
      for (;;) {
        skip();
        if (text[i] === "}") { i++; return obj; }
        let key;
        if (text[i] === '"' || text[i] === "'") key = parseString();
        else {
          const m = /^[A-Za-z_$][\w$]*/.exec(text.slice(i, i + 80));
          if (!m) fail("Nom de champ attendu");
          key = m[0];
          i += key.length;
        }
        if (key === "__proto__") fail("Champ interdit");
        skip();
        if (text[i] !== ":") fail("':' attendu");
        i++;
        obj[key] = parseValue();
        skip();
        if (text[i] === ",") i++;
        else if (text[i] !== "}") fail("',' ou '}' attendu");
      }
    }
    if (c === '"' || c === "'") return parseString();
    const num = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 40));
    if (num) { i += num[0].length; return Number(num[0]); }
    for (const [word, val] of [["true", true], ["false", false], ["null", null], ["undefined", null]]) {
      if (text.startsWith(word, i)) { i += word.length; return val; }
    }
    return fail("Valeur inattendue");
  }

  return parseValue();
}

// Trouve "const|let|var NOM = ..." dans le fichier et analyse sa valeur
function extractJsAssignment(text, name) {
  const m = new RegExp("(?:const|let|var)\\s+" + name + "\\s*=\\s*").exec(text);
  if (!m) throw new Error(`« ${name} » est introuvable dans ce fichier`);
  return parseJsLiteral(text, m.index + m[0].length);
}

// Lit PLAYERS ainsi que les listes ajoutées par « PLAYERS.push(...LEGENDS) » (structure du data.js d'origine)
function extractAllPlayers(text) {
  const list = extractJsAssignment(text, "PLAYERS");
  if (!Array.isArray(list)) return list;
  const all = [...list];
  const re = /PLAYERS\s*\.\s*push\s*\(\s*\.\.\.\s*([A-Za-z_$][\w$]*)\s*\)/g;
  let m;
  while ((m = re.exec(text))) {
    const extra = extractJsAssignment(text, m[1]);
    if (!Array.isArray(extra)) throw new Error(`« ${m[1]} » n'est pas une liste de joueurs`);
    all.push(...extra);
  }
  return all;
}

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

// Poste mal orthographié (ex. « Trosième ligne ») : renvoie le poste connu le plus proche, s'il est unique
function closestKnownPosition(x) {
  if (typeof x !== "string") return null;
  let best = null, bestD = 3, tie = false;
  Object.keys(COEFFS_POSTES).forEach(k => {
    const d = editDistance(x.toLowerCase(), k.toLowerCase());
    if (d < bestD) { best = k; bestD = d; tie = false; }
    else if (d === bestD) tie = true;
  });
  return best && !tie ? best : null;
}

// Vérifie chaque joueur du fichier. Toute erreur bloque l'import :
// un joueur ignoré serait sinon considéré comme "supprimé".
function normalizeImportedPlayers(list) {
  const errors = [];
  const warnings = [];
  const players = [];
  const seen = new Map();
  const knownPos = Object.keys(COEFFS_POSTES);
  if (!Array.isArray(list)) return { errors: ["PLAYERS n'est pas une liste de joueurs"], players, warnings };

  list.forEach((raw, idx) => {
    const where = `Joueur n°${idx + 1}${raw && raw.name ? " (" + raw.name + ")" : ""}`;
    if (!raw || typeof raw !== "object") { errors.push(`${where} : entrée invalide`); return; }
    let ok = true;
    const bad = msg => { errors.push(`${where} : ${msg}`); ok = false; };

    const p = {
      name: String(raw.name || ""), // conservé tel quel : le nom fait partie de l'identifiant des cartes
      team: raw.team,
      positions: raw.positions,
      rarity: raw.rarity,
      nat: String(raw.nat || "FRA").toUpperCase().trim()
    };
    if (!p.name.trim()) bad("nom manquant");
    if (!TEAMS[p.team]) bad(`club inconnu « ${p.team} »`);
    if (!RARITIES[p.rarity]) bad(`rareté inconnue « ${p.rarity} »`);
    if (!Array.isArray(p.positions) || !p.positions.length) bad("postes manquants");
    else {
      p.positions = p.positions.map(x => {
        if (knownPos.includes(x)) return x;
        const fixed = closestKnownPosition(x);
        if (fixed) {
          warnings.push(`${p.name || "Joueur n°" + (idx + 1)} : poste « ${x} » corrigé en « ${fixed} »`);
          return fixed;
        }
        bad(`poste inconnu « ${x} »`);
        return x;
      });
    }

    if (raw.clubs !== undefined && raw.clubs !== null) {
      if (Array.isArray(raw.clubs) && raw.clubs.every(c => typeof c === "string")) p.clubs = raw.clubs;
      else bad("clubs de carrière invalides");
    }
    if (raw.stats !== undefined && raw.stats !== null) {
      const st = raw.stats;
      if (typeof st === "object" && STAT_KEYS.every(k => Number.isFinite(st[k]) && st[k] >= 20 && st[k] <= 99)) {
        p.stats = Object.fromEntries(STAT_KEYS.map(k => [k, Math.round(st[k])]));
      } else bad("sous-notes invalides (5 valeurs entre 20 et 99 attendues)");
    }
    if (raw.note !== undefined && raw.note !== null) {
      if (Number.isFinite(raw.note) && raw.note >= 30 && raw.note <= 99) p.note = Math.round(raw.note);
      else bad("note générale invalide (entre 30 et 99)");
    }

    const key = `${p.name}|${p.team}`;
    if (seen.has(key)) {
      const first = seen.get(key);
      if (sameJson(first, p)) { warnings.push(`${p.name} : doublon identique ignoré`); return; }
      bad(`« ${p.name} » apparaît deux fois pour ce club avec des valeurs différentes (${first.rarity}, ${first.positions.join("|")} / ${p.rarity}, ${p.positions.join("|")}) : garde une seule ligne dans le fichier`);
    } else if (ok) {
      seen.set(key, p);
    }
    if (ok) players.push(p);
  });
  return { errors, players, warnings };
}

const sameJson = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);

function fieldsDiffer(a, b) {
  return a.rarity !== b.rarity
    || !sameJson(a.positions, b.positions)
    || String(a.nat || "FRA").toUpperCase() !== String(b.nat || "FRA").toUpperCase()
    || !sameJson(a.clubs, b.clubs);
}

// Compare deux listes de joueurs (clé = « nom|club »)
function diffPlayerLists(fromList, toList) {
  const keyOf = p => `${p.name}|${p.team}`;
  const fromMap = new Map(fromList.map(p => [keyOf(p), p]));
  const toMap = new Map(toList.map(p => [keyOf(p), p]));
  const removed = [];
  const added = [];
  const edits = [];
  fromMap.forEach((p, k) => { if (!toMap.has(k)) removed.push(p); });
  toMap.forEach((p, k) => { if (!fromMap.has(k)) added.push(p); });
  toMap.forEach((p, k) => {
    const old = fromMap.get(k);
    if (old && fieldsDiffer(old, p)) edits.push({ from: old, to: p });
  });

  // Changement de club : même nom, un seul joueur retiré ET un seul ajouté.
  // On le traite comme une modification (les notes suivent le joueur) et non comme suppression + ajout.
  const group = list => {
    const m = new Map();
    list.forEach(p => { const n = p.name.toLowerCase(); m.set(n, [...(m.get(n) || []), p]); });
    return m;
  };
  const remBy = group(removed);
  const addBy = group(added);
  const transfers = [];
  const pairedRemoved = new Set();
  const pairedAdded = new Set();
  remBy.forEach((rems, n) => {
    const adds = addBy.get(n);
    if (adds && rems.length === 1 && adds.length === 1) {
      transfers.push({ from: rems[0], to: adds[0] });
      pairedRemoved.add(rems[0]);
      pairedAdded.add(adds[0]);
    }
  });

  return {
    removed: removed.filter(p => !pairedRemoved.has(p)),
    added: added.filter(p => !pairedAdded.has(p)),
    transfers, edits, fromMap, toMap
  };
}

// Ce qui doit être stocké dans Firestore pour que « base d'origine + modifications » = fichier importé
function buildImportOverrides(basePlayers, importedPlayers) {
  const d = diffPlayerLists(basePlayers, importedPlayers);
  const strip = p => {
    const o = { name: p.name, team: p.team, positions: [...p.positions], rarity: p.rarity, nat: p.nat };
    if (p.clubs) o.clubs = [...p.clubs];
    return o;
  };
  const editEntry = (from, to) => ({
    key: `${from.name}|${from.team}`,
    team: to.team, rarity: to.rarity, positions: [...to.positions], nat: to.nat,
    clubs: to.clubs ? [...to.clubs] : null
  });

  const added = d.added.map(strip);
  const removed = d.removed.map(p => `${p.name}|${p.team}`);
  const edited = [...d.transfers.map(t => editEntry(t.from, t.to)), ...d.edits.map(e => editEntry(e.from, e.to))];

  // Notes et sous-notes (rangées sous la clé finale « nom|club »)
  const baseOf = new Map();
  d.toMap.forEach((p, k) => { if (d.fromMap.has(k)) baseOf.set(k, d.fromMap.get(k)); });
  d.transfers.forEach(t => baseOf.set(`${t.to.name}|${t.to.team}`, t.from));
  const notes = {};
  const stats = {};
  d.toMap.forEach((p, k) => {
    const b = baseOf.get(k);
    if (p.note !== undefined && (!b || b.note !== p.note)) notes[k] = p.note;
    if (p.stats !== undefined && (!b || !sameJson(b.stats, p.stats))) stats[k] = p.stats;
  });
  return { added, removed, edited, notes, stats };
}

// Aperçu : ce qui va changer dans le jeu par rapport à l'état actuel
function buildImportPreview(currentPlayers, importedPlayers) {
  const d = diffPlayerLists(currentPlayers, importedPlayers);
  const clubName = t => (TEAMS[t] && TEAMS[t].name) || t;
  const label = p => `${p.name} (${clubName(p.team)})`;
  const baseByKey = new Map(BASE_PLAYERS.map(p => [`${p.name}|${p.team}`, p]));

  const describeEdit = (from, to) => {
    const parts = [];
    if (from.rarity !== to.rarity) parts.push(`rareté ${from.rarity} → ${to.rarity}`);
    if (!sameJson(from.positions, to.positions)) parts.push(`postes ${(from.positions || []).join("|")} → ${to.positions.join("|")}`);
    if (String(from.nat || "FRA").toUpperCase() !== String(to.nat || "FRA").toUpperCase()) parts.push(`nationalité ${from.nat || "FRA"} → ${to.nat}`);
    if (!sameJson(from.clubs, to.clubs)) parts.push("clubs de carrière");
    return `${to.name} : ${parts.join(", ")}`;
  };

  const lists = {
    added: d.added.map(label),
    removed: d.removed.map(label),
    transfers: d.transfers.map(t => `${t.from.name} : ${clubName(t.from.team)} → ${clubName(t.to.team)}`),
    edits: d.edits.map(e => describeEdit(e.from, e.to)),
    notes: [], stats: [], cleared: []
  };

  const pairs = [];
  d.toMap.forEach((imp, k) => { const cur = d.fromMap.get(k); if (cur) pairs.push([cur, imp]); });
  d.transfers.forEach(t => pairs.push([t.from, t.to]));
  pairs.forEach(([cur, imp]) => {
    const ck = `${cur.name}|${cur.team}`;
    const curNote = noteOverrides[ck] !== undefined ? noteOverrides[ck] : cur.note;
    const curStats = statsOverrides[ck] !== undefined ? statsOverrides[ck] : cur.stats;
    const base = baseByKey.get(ck);
    if (imp.note !== undefined && imp.note !== curNote) lists.notes.push(`${imp.name} : ${curNote === undefined ? "auto" : curNote} → ${imp.note}`);
    if (imp.note === undefined && noteOverrides[ck] !== undefined && !(base && base.note !== undefined)) lists.cleared.push(`${imp.name} : note personnalisée ${noteOverrides[ck]} retirée`);
    if (imp.stats !== undefined && !sameJson(imp.stats, curStats)) lists.stats.push(`${imp.name} : sous-notes modifiées`);
    if (imp.stats === undefined && statsOverrides[ck] !== undefined && !(base && base.stats !== undefined)) lists.cleared.push(`${imp.name} : sous-notes personnalisées retirées`);
  });
  return lists;
}

function planDataImport(text) {
  const rawList = extractAllPlayers(text);
  const { errors, players, warnings } = normalizeImportedPlayers(rawList);
  if (errors.length) return { errors };
  return {
    errors: [],
    warnings,
    count: players.length,
    preview: buildImportPreview(PLAYERS, players),
    overrides: buildImportOverrides(BASE_PLAYERS, players)
  };
}
// ===== IMPORT data.js : FIN =====

// ---------------------------------------------------------
// IMPORT data.js — interface (aperçu, confirmation, application)
// ---------------------------------------------------------
let pendingDataImport = null;

function renderImportPreview(plan) {
  const box = document.getElementById("admin-import-preview");
  if (!box) return;
  const L = plan.preview;
  const sections = [
    ["➕ Joueurs ajoutés", L.added],
    ["🗑️ Joueurs supprimés", L.removed],
    ["🔁 Changements de club", L.transfers],
    ["✏️ Modifications (poste, rareté, nationalité…)", L.edits],
    ["⭐ Notes générales modifiées", L.notes],
    ["📊 Sous-notes modifiées", L.stats],
    ["♻️ Notes / sous-notes personnalisées retirées", L.cleared]
  ];
  const total = sections.reduce((n, s) => n + s[1].length, 0);

  let html = `<div class="admin-import-summary">Fichier lu : <strong>${plan.count}</strong> joueurs.</div>`;
  if (plan.warnings && plan.warnings.length) {
    const w = plan.warnings.slice(0, 30).map(t => `<li>${escapeHtml(t)}</li>`).join("");
    html += `<details class="admin-import-section" open><summary>🛠️ Corrections automatiques <strong>(${plan.warnings.length})</strong></summary><ul>${w}</ul></details>`;
  }
  if (total === 0) {
    html += `<p class="admin-note">Aucune différence : la base du jeu est déjà identique à ce fichier.</p>
             <button id="admin-import-cancel-btn" class="admin-btn admin-btn-secondary">Fermer</button>`;
  } else {
    if (L.removed.length > 10) {
      html += `<p class="admin-import-warning">⚠️ ${L.removed.length} joueurs vont être supprimés. Vérifie que ce fichier est bien la version la plus récente.</p>`;
    }
    sections.forEach(([title, items]) => {
      if (!items.length) return;
      const shown = items.slice(0, 30).map(t => `<li>${escapeHtml(t)}</li>`).join("");
      const more = items.length > 30 ? `<li>… et ${items.length - 30} autres</li>` : "";
      html += `<details class="admin-import-section"><summary>${title} <strong>(${items.length})</strong></summary><ul>${shown}${more}</ul></details>`;
    });
    html += `<p class="admin-note">Les modifications remplaceront les ajouts, suppressions, changements et notes enregistrés jusqu'ici dans la base partagée. Une copie de sécurité de l'état actuel est conservée.</p>
             <div class="admin-import-actions">
               <button id="admin-import-apply-btn" class="admin-btn">✅ Appliquer pour tous</button>
               <button id="admin-import-cancel-btn" class="admin-btn admin-btn-secondary">Annuler</button>
             </div>`;
  }
  box.innerHTML = html;
  box.classList.remove("hidden");

  const cancel = document.getElementById("admin-import-cancel-btn");
  if (cancel) cancel.onclick = resetDataImport;
  const apply = document.getElementById("admin-import-apply-btn");
  if (apply) apply.onclick = () => applyDataImport(plan);
}

function resetDataImport() {
  pendingDataImport = null;
  const box = document.getElementById("admin-import-preview");
  if (box) { box.innerHTML = ""; box.classList.add("hidden"); }
  const input = document.getElementById("admin-import-file");
  if (input) input.value = "";
}

async function applyDataImport(plan) {
  const st = document.getElementById("admin-import-status");
  const apply = document.getElementById("admin-import-apply-btn");
  if (apply) apply.disabled = true;
  st.textContent = "Import en cours...";
  try {
    const ref = db.collection("playersOverrides").doc("data");
    const previous = await ref.get();
    if (previous.exists) {
      // Copie de sécurité de l'état d'avant import
      await db.collection("playersOverrides").doc("backup").set({
        ...previous.data(),
        backedUpAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    }
    const o = JSON.parse(JSON.stringify(plan.overrides)); // retire les valeurs « undefined »
    await ref.set({
      added: o.added, removed: o.removed, edited: o.edited, notes: o.notes, stats: o.stats,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy: "ChocoDeLaVega"
    });
    const L = plan.preview;
    try {
      await logAdminAction("import", `data.js importé : +${L.added.length} / -${L.removed.length} joueurs, ${L.transfers.length} clubs, ${L.edits.length} modifs, ${L.notes.length} notes, ${L.stats.length} sous-notes`);
    } catch (_) {}
    st.innerHTML = `✓ Import appliqué pour tous les joueurs (visible à leur prochaine connexion). <button id="admin-import-reload-btn" class="admin-btn">🔄 Recharger la page</button>`;
    document.getElementById("admin-import-reload-btn").onclick = () => location.reload();
    resetDataImport();
  } catch (e) {
    st.textContent = `❌ Erreur : ${e.message}`;
    if (apply) apply.disabled = false;
  }
}

function bindDataImport() {
  const input = document.getElementById("admin-import-file");
  const st = document.getElementById("admin-import-status");
  if (!input) return;
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    st.textContent = "Lecture du fichier...";
    const box = document.getElementById("admin-import-preview");
    box.classList.add("hidden");
    try {
      const plan = planDataImport(await file.text());
      if (plan.errors.length) {
        const list = plan.errors.slice(0, 20).map(e => `<li>${escapeHtml(e)}</li>`).join("");
        const more = plan.errors.length > 20 ? `<li>… et ${plan.errors.length - 20} autres erreurs</li>` : "";
        box.innerHTML = `<p class="admin-import-warning">❌ Import impossible : le fichier contient des erreurs. Rien n'a été modifié.</p><ul>${list}${more}</ul>`;
        box.classList.remove("hidden");
        st.textContent = "";
        return;
      }
      pendingDataImport = plan;
      st.textContent = "";
      renderImportPreview(plan);
    } catch (e) {
      st.textContent = `❌ Fichier illisible : ${e.message}`;
    }
  };
}

// ---------------------------------------------------------
// EXPORT data.js — génère le fichier complet à jour
// ---------------------------------------------------------
function generateDataJsFile() {
  // Sérialise un joueur en respectant le format existant du fichier data.js
  function serializePlayer(p) {
    const parts = [];
    parts.push(`name: ${JSON.stringify(p.name)}`);
    parts.push(`team: ${JSON.stringify(p.team)}`);
    if (p.clubs && p.clubs.length) {
      parts.push(`clubs: ${JSON.stringify(p.clubs)}`);
    }
    parts.push(`positions: ${JSON.stringify(p.positions || [])}`);
    parts.push(`rarity: ${JSON.stringify(p.rarity)}`);
    parts.push(`nat: ${JSON.stringify(p.nat || "FRA")}`);
    const key = `${p.name}|${p.team}`;
    // Sous-notes : modification admin en priorité, sinon celles déjà présentes dans data.js
    const exportStats = statsOverrides[key] || p.stats;
    if (exportStats) {
      parts.push(`stats: ${JSON.stringify(exportStats)}`);
    }
    // Note générale forcée : modification admin en priorité, sinon celle de data.js
    const exportNote = noteOverrides[key] !== undefined ? noteOverrides[key] : p.note;
    if (exportNote !== undefined) {
      parts.push(`note: ${exportNote}`);
    }
    return `  { ${parts.join(", ")} },`;
  }

  const playersLines = PLAYERS.map(serializePlayer).join("\n");

  // Sérialise TEAMS
  const teamsLines = Object.entries(TEAMS).map(([key, val]) =>
    `  ${JSON.stringify(key)}: { name: ${JSON.stringify(val.name)}, color: ${JSON.stringify(val.color)} },`
  ).join("\n");

  // Sérialise RARITIES
  const raritiesLines = Object.entries(RARITIES).map(([key, val]) => {
    const fields = [
      `label: ${JSON.stringify(val.label)}`,
      `color: ${JSON.stringify(val.color)}`,
      `weight: ${val.weight}`,
      `sellValue: ${val.sellValue}`,
      `noteMin: ${val.noteMin}`,
      `noteMax: ${val.noteMax}`
    ];
    return `  ${JSON.stringify(key)}: { ${fields.join(", ")} },`;
  }).join("\n");

  // Sérialise PACKS
  function serializePack(p) {
    const fields = [];
    for (const [k, v] of Object.entries(p)) {
      fields.push(`${k}: ${JSON.stringify(v)}`);
    }
    return `  { ${fields.join(", ")} },`;
  }
  const packsLines = PACKS.map(serializePack).join("\n");

  const now = new Date().toLocaleString("fr-FR");

  return `// =========================================================
// RUGBIX — BASE DE DONNÉES
// Fichier exporté automatiquement depuis le panneau Admin
// Généré le : ${now}
// Contient tous les ajouts, suppressions, modifications et notes
// personnalisées effectués depuis le jeu.
// =========================================================

const TEAMS = {
${teamsLines}
};

let PLAYERS = [
${playersLines}
];

const RARITIES = {
${raritiesLines}
};

const PACKS = [
${packsLines}
];
`;
}


function refreshNotePlayerList(q) {
  const sel = document.getElementById("note-player-select");
  if (!sel) return;
  const filtered = applyAdminFilters(PLAYERS, q || "");
  sel.innerHTML = filtered.map(p => {
    const note = getPlayerNote(p);
    return `<option value="${getCardKey(p)}">${p.name} — ${TEAMS[p.team]?.name||p.team} [${note}]</option>`;
  }).join("");
  document.getElementById("note-player-fields").classList.add("hidden");
}

function updateNotePreview(note) {
  const el = document.getElementById("note-label-preview");
  if (!el || !note) return;
  el.textContent = `${note} — ${getNoteLabel(note)}`;
  el.style.background = getNoteColor(note);
  el.style.webkitBackgroundClip = "text";
  el.style.webkitTextFillColor = "transparent";
  el.style.backgroundClip = "text";
  el.style.fontWeight = "900";
}
setupAuth();
setupLegalModals();

function setupLegalModals() {
  // Boutons du footer principal (jeu)
  const mentionsHandler = () => document.getElementById("mentions-modal").classList.remove("hidden");
  const privacyHandler  = () => document.getElementById("privacy-modal").classList.remove("hidden");
  const contactHandler  = () => {
    if (currentUser) {
      const pseudo = currentUser.displayName || currentUser.email.split("@")[0];
      document.getElementById("contactName").value = pseudo;
      document.getElementById("contactEmail").value = currentUser.email;
    }
    document.getElementById("contactSuccess").classList.add("hidden");
    document.getElementById("contact-modal").classList.remove("hidden");
  };

  // Footer du jeu
  document.getElementById("footer-mentions-btn").addEventListener("click", mentionsHandler);
  document.getElementById("footer-privacy-btn").addEventListener("click", privacyHandler);
  document.getElementById("footer-contact-btn").addEventListener("click", contactHandler);

  // Footer de la page de connexion (mêmes modales)
  document.getElementById("auth-footer-mentions-btn").addEventListener("click", mentionsHandler);
  document.getElementById("auth-footer-privacy-btn").addEventListener("click", privacyHandler);
  document.getElementById("auth-footer-contact-btn").addEventListener("click", () => {
    document.getElementById("contactSuccess").classList.add("hidden");
    document.getElementById("contact-modal").classList.remove("hidden");
  });
  document.getElementById("close-mentions-btn").addEventListener("click", () => {
    document.getElementById("mentions-modal").classList.add("hidden");
  });

  // Confidentialité
  document.getElementById("footer-privacy-btn").addEventListener("click", () => {
    document.getElementById("privacy-modal").classList.remove("hidden");
  });
  // Fermer les modales
  document.getElementById("close-mentions-btn").addEventListener("click", () => {
    document.getElementById("mentions-modal").classList.add("hidden");
  });
  document.getElementById("close-privacy-btn").addEventListener("click", () => {
    document.getElementById("privacy-modal").classList.add("hidden");
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
