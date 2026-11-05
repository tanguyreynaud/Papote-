// Audits du code Papote par l'API Message Batches (Claude Opus 5.5, -50 % en lot).
//
// Le code est LU en lecture seule depuis un clone git existant (git fetch + git show :
// rien n'est changé dans le dossier de travail). Les fichiers secrets ne sont jamais envoyés
// (.env, clés, keystores…), et toute ligne qui ressemble à une clé est remplacée.
//
//   node audit.mjs estimer [thème…]      coût estimé, AUCUN appel à l'API
//   node audit.mjs essai                  1 mini-lot (≤ 0,10 $) pour vérifier la facturation
//   node audit.mjs lancer <thème…>        montre l'estimation et s'arrête
//   node audit.mjs lancer <thème…> --oui  envoie le lot (refusé au-delà de --plafond, 5 $ par défaut)
//   node audit.mjs suivre                 état des lots ; récupère les rapports finis (rapports\*.md)
//   node audit.mjs annuler <id-du-lot>    annule un lot en cours
//
// Options : --depot <dossier du clone> (défaut C:\Users\tangu\papote-deploiement), --plafond <dollars>.
// Clé : variable d'environnement ANTHROPIC_API_KEY (jamais écrite dans un fichier).

import Anthropic from "@anthropic-ai/sdk";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ICI = path.dirname(fileURLToPath(import.meta.url));
const ETAT = path.join(ICI, "etat.json");
const RAPPORTS = path.join(ICI, "rapports");

const MODELE = "claude-opus-5-5";
// Prix Anthropic de Claude Opus 5.5 en lot (moitié du prix normal 4 $ / 20 $), en dollars par million de jetons.
// Vérifiés le 05/11/2026 ; si la page Pricing change, corriger ici.
const PRIX = { entree: 2.0, sortie: 10.0, ecritureCache: 2.5, lectureCache: 0.2 };
const MAX_SORTIE = 32000; // jetons de sortie maximum par rapport (réflexion comprise)
// Estimation locale prudente : ~3 caractères par jeton (code + français). L'essai mesure le vrai rapport.
const CARACTERES_PAR_JETON_DEFAUT = 3.0;

// ---------------------------------------------------------------- morceaux de code
const BRANCHES = {
  main: "origin/main",
  dlattc: "origin/claude/project-thread-dlattc",
  cmnwxy: "origin/claude/project-thread-cmnwxy",
};

const MORCEAUX = {
  serveur: {
    titre: "Serveur (Cloud Functions, branche main)",
    branche: "main",
    garder: [/^functions\/[^/]+\.(js|md)$/, /^firebase\.fonctions\.json$/],
    exclure: [/\.test\.js$/],
  },
  site: {
    titre: "Site vitrine et commande (branche main)",
    branche: "main",
    garder: [/^vitrine\/[^/]+\.(html|js|mjs)$/],
  },
  app: {
    titre: "App famille + admin web et règles Firestore/Storage (branche dlattc)",
    branche: "dlattc",
    garder: [/^web\/js\/[^/]+\.js$/, /^web\/[^/]+\.(html|json)$/, /^(firestore|storage)[^/]*\.rules$/, /^firestore\.indexes\.json$/],
    exclure: [/^web\/js\/validation/, /^web\/validation/], // galerie de validation (outil d'admin, données d'exemple)
  },
  "app-css": {
    titre: "Styles de l'app famille + admin (branche dlattc)",
    branche: "dlattc",
    garder: [/^web\/css\/[^/]+\.css$/],
  },
  tablette: {
    titre: "Tablette Android (branche cmnwxy)",
    branche: "cmnwxy",
    garder: [
      /^android\/app\/src\/main\/java\/.+\.(java|kt)$/,
      /^android\/app\/src\/main\/assets\/.+\.(js|html)$/,
      /^android\/app\/src\/main\/AndroidManifest\.xml$/,
      /^android\/app\/src\/main\/res\/xml\/[^/]+\.xml$/,
      /^android\/app\/build\.gradle(\.kts)?$/,
    ],
  },
  "tablette-css": {
    titre: "Styles de la tablette (branche cmnwxy)",
    branche: "cmnwxy",
    garder: [/^android\/app\/src\/main\/assets\/.+\.css$/],
  },
};

// Jamais envoyés, quel que soit le morceau.
const CHEMINS_INTERDITS = [
  /(^|\/)\.env/i, /(^|\/)\.npmrc$/i, /cle|key|secret|credential|password|mot-de-passe|token|service-account|google-services/i,
  /\.(pem|p12|pfx|jks|keystore)$/i, /signing\.properties$/i, /local\.properties$/i,
];
// Lignes remplacées si elles contiennent quelque chose qui ressemble à un secret.
const MOTIFS_SECRETS = [
  /sk_(live|test)_[0-9A-Za-z]{8,}/, /rk_(live|test)_[0-9A-Za-z]{8,}/, /whsec_[0-9A-Za-z]{8,}/,
  /sk-ant-[0-9A-Za-z_-]{10,}/, /xkeysib-[0-9A-Za-z-]{10,}/, /xsmtpsib-[0-9A-Za-z-]{10,}/,
  /AIza[0-9A-Za-z_-]{30,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /"private_key"\s*:/,
  /(password|passwd|mot_?de_?passe|secret|api_?key)\s*[:=]\s*["'][^"'\s]{8,}["']/i,
];
const TAILLE_MAX_FICHIER = 300_000;

// ---------------------------------------------------------------- thèmes d'audit (pannes d'abord)
const THEMES = [
  {
    id: "pannes",
    titre: "Pannes et blocages",
    morceaux: ["tablette", "serveur", "app", "site"],
    consigne: `Cherche tout ce qui peut planter, bloquer, se figer ou ne jamais se relancer, surtout sur la tablette de Mamie qui doit tourner des mois sans personne : exceptions non attrapées, promesses non attendues, courses entre deux événements, double clic ou double appel, coupure réseau ou électrique en plein milieu, redémarrage de la tablette, heure inconnue au démarrage, mémoire qui grossit, minuteries jamais annulées, écouteurs Firestore jamais fermés, états incohérents entre tablette, serveur et app famille, données perdues, tâches planifiées qui échouent sans prévenir l'admin.`,
  },
  {
    id: "sos",
    titre: "SOS et urgences",
    morceaux: ["tablette", "serveur", "app"],
    consigne: `Suis le bouton SOS de bout en bout : appui sur la tablette (y compris en pause, la nuit, écran verrouillé, sans réseau, pendant un appel), décompte, SMS à tous, puis appels en chaîne, répondeur pris pour une réponse, proche qui ne répond pas, message « famille prévenue » affiché alors que personne ne l'a été, notifications à l'app famille, alerte admin. Toute situation où Mamie croit être secourue alors qu'elle ne l'est pas est GRAVE.`,
  },
  {
    id: "argent",
    titre: "Argent, paiements et coûts",
    morceaux: ["serveur", "site", "app"],
    consigne: `Vérifie tout ce qui touche à l'argent : Stripe (abonnement 25 €/mois, mise en service 60 €, carte et SEPA, webhooks, double paiement, paiement qui échoue, résiliation à la date de période, reprise d'abonnement, 140 € de tablette non rendue, remboursements), factures, montants arrondis, devises, fuseaux horaires des dates de fin, coûts cloud qui peuvent exploser (boucles de fonctions, lectures Firestore, appels IA sans plafond, e-mails), coupe-circuit de facture.`,
  },
  {
    id: "securite",
    titre: "Sécurité",
    morceaux: ["serveur", "app", "site", "tablette"],
    consigne: `Cherche les failles : règles Firestore/Storage trop larges, fonctions appelables sans vérifier qui appelle, une famille qui lit ou modifie les données d'une autre, liens piégés (paramètres d'URL, redirections ouvertes), injection HTML/XSS dans les messages, noms ou photos, webhooks non vérifiés, secrets exposés côté client, tablette détournable (kiosque, appareil propriétaire, mises à jour non signées), admin accessible sans les bons droits, données sensibles dans les journaux.`,
  },
  {
    id: "accessibilite",
    titre: "Accessibilité pour les seniors",
    morceaux: ["tablette", "tablette-css", "app", "app-css", "site"],
    consigne: `Le public de la tablette a 80-95 ans (vue faible, tremblements, audition faible, aucune habitude du numérique) ; « zéro clic pour Mamie ». Vérifie tailles de texte et de cibles tactiles, contrastes (le fond est crème #fdfaf5, la couleur principale indigo #4f46e5), messages qui disparaissent trop vite, sons, ce qui peut effrayer ou perdre la personne, lecteurs d'écran (TalkBack), mode nuit. Pour l'app famille et le site : public de 30-60 ans sur téléphone, mais boutons qui ne montrent pas qu'ils sont appuyés, double clic, absence de retour visible.`,
  },
  {
    id: "commande",
    titre: "Commande, envoi et retour de la tablette",
    morceaux: ["site", "serveur", "app"],
    consigne: `Suis le parcours complet : commande sur le site, paiement, préparation et envoi (stock, tablette reliée avant envoi, Mondial Relay), premier proche qui scanne et crée la famille, invitations, puis résiliation, retour de la tablette (Mondial Relay pour les familles, « main propre » seulement par l'admin), tablette reçue, remise en stock. Cherche les étapes où une commande peut rester bloquée, être comptée deux fois, ou créer une famille sans paiement.`,
  },
  {
    id: "emails",
    titre: "E-mails et notifications",
    morceaux: ["serveur", "site", "app"],
    consigne: `Vérifie chaque e-mail et notification : quand il part, s'il peut partir deux fois ou jamais, quotas du fournisseur (Brevo 300/jour), contenu (accents, liens, montants, dates, fuseau horaire), désinscription, adresse fausse, notifications push (jeton périmé, plusieurs téléphones), relevé des factures par e-mail. Cherche aussi ce qui pourrait finir en spam ou inquiéter le client.`,
  },
  {
    id: "appels",
    titre: "Appels vidéo",
    morceaux: ["tablette", "serveur", "app"],
    consigne: `Suis un appel vidéo dans les deux sens : sonnerie (45 s puis manqué), décrocher/raccrocher, double appel, deux proches qui appellent en même temps, appel pendant un SOS ou la nuit, coupure de plus de 8 s, retour du réseau, micro ou caméra refusés, appli famille en arrière-plan, appel manqué qui doit laisser une trace, consommation de données (SIM 1 Go par mois).`,
  },
  {
    id: "donnees-perso",
    titre: "Données personnelles (RGPD)",
    morceaux: ["serveur", "app", "site", "tablette"],
    consigne: `Vérifie les données personnelles : ce qui est collecté, où c'est stocké (région Europe), qui y a accès, purge 3 mois après la fin (12 mois pour le chat et les paniers), suppression d'un proche ou d'une famille (photos, vidéos, Storage compris), export, consentements, journaux qui contiennent des noms, numéros ou adresses, données envoyées à des tiers (IA, e-mails, Stripe).`,
  },
];

const SYSTEME = `Tu es un auditeur de code expérimenté, en lecture seule. Le produit s'appelle Papote : une tablette Android en mode kiosque donnée à une personne âgée (« Mamie »), qui affiche les photos et vidéos envoyées par sa famille, reçoit et passe des appels vidéo, et a un bouton SOS. La famille utilise une app web (et une app Android). Un site vitrine vend l'abonnement (25 €/mois tout compris avec SIM, 60 € de mise en service, sans engagement). Le serveur est sur Firebase (Cloud Functions, Firestore, Storage, région Europe). Une seule personne développe et gère tout, sans équipe ; les premières tablettes partent chez de vraies familles le 5 décembre.

Règles du rapport :
- Écris en français simple, compréhensible par quelqu'un qui n'est pas développeur, mais précis.
- Ne signale QUE ce que tu vois dans le code fourni. Cite chaque fois le fichier et la ligne sous la forme \`branche:chemin:ligne\`. Si une partie nécessaire n'est pas dans le code fourni, dis-le au lieu de supposer.
- Pour chaque problème : un titre court, la gravité (GRAVE / IMPORTANT / MINEUR), le scénario concret qui le déclenche (qui fait quoi, dans quel ordre, ce qui se passe), la correction proposée en une ou deux phrases, et ta confiance (sûr / probable / à vérifier).
- Classe du plus grave au moins grave. Pas de remarques de style ni de reformulations sans effet pour l'utilisateur.
- Termine par une courte liste « Ce que j'ai vérifié et qui va bien », pour qu'on sache ce qui a été couvert.
- Format Markdown, sans préambule.`;

// ---------------------------------------------------------------- utilitaires
function options(argv) {
  const o = { depot: "C:\\Users\\tangu\\papote-deploiement", plafond: 5, oui: false, reste: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--depot") o.depot = argv[++i];
    else if (a === "--plafond") o.plafond = Number(argv[++i]);
    else if (a === "--oui") o.oui = true;
    else o.reste.push(a);
  }
  return o;
}

function lireEtat() {
  try { return JSON.parse(fs.readFileSync(ETAT, "utf8")); } catch { return { lots: [], caracteresParJeton: null }; }
}
function ecrireEtat(e) { fs.writeFileSync(ETAT, JSON.stringify(e, null, 2)); }

function git(depot, args) {
  return execFileSync("git", ["-C", depot, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

let dejaRecupere = false;
function recupererBranches(depot) {
  if (dejaRecupere) return;
  if (!fs.existsSync(path.join(depot, ".git"))) throw new Error(`Pas de clone git ici : ${depot} (option --depot).`);
  console.log(`Lecture des branches depuis GitHub (git fetch, sans toucher au dossier ${depot})…`);
  git(depot, ["fetch", "--quiet", "origin", ...Object.values(BRANCHES).map((b) => b.replace("origin/", ""))]);
  dejaRecupere = true;
}

const cacheMorceaux = new Map();
function construireMorceau(depot, nom) {
  if (cacheMorceaux.has(nom)) return cacheMorceaux.get(nom);
  const m = MORCEAUX[nom];
  const ref = BRANCHES[m.branche];
  const sha = git(depot, ["rev-parse", "--short", ref]).trim();
  const liste = git(depot, ["ls-tree", "-r", "-l", ref]).split("\n").filter(Boolean).map((l) => {
    const [infos, chemin] = l.split("\t");
    return { chemin, taille: Number(infos.trim().split(/\s+/)[3]) };
  });
  const fichiers = [];
  const ecartes = [];
  let lignesMasquees = 0;
  for (const f of liste) {
    if (!m.garder.some((r) => r.test(f.chemin))) continue;
    if ((m.exclure || []).some((r) => r.test(f.chemin))) continue;
    if (CHEMINS_INTERDITS.some((r) => r.test(f.chemin))) { ecartes.push(`${f.chemin} (secret possible)`); continue; }
    if (f.taille > TAILLE_MAX_FICHIER) { ecartes.push(`${f.chemin} (trop gros : ${Math.round(f.taille / 1000)} ko)`); continue; }
    const texte = git(depot, ["show", `${ref}:${f.chemin}`]);
    const lignes = texte.split("\n").map((ligne, i) => {
      if (MOTIFS_SECRETS.some((r) => r.test(ligne))) { lignesMasquees++; return `${i + 1}| [LIGNE RETIRÉE : secret possible]`; }
      return `${i + 1}| ${ligne}`;
    });
    fichiers.push(`<fichier chemin="${m.branche}:${f.chemin}">\n${lignes.join("\n")}\n</fichier>`);
  }
  const contenu = `<morceau nom="${nom}" titre="${m.titre}" branche="${ref}" commit="${sha}">\n${fichiers.join("\n")}\n</morceau>`;
  const r = { nom, sha, ref, nbFichiers: fichiers.length, ecartes, lignesMasquees, contenu };
  cacheMorceaux.set(nom, r);
  return r;
}

function construireDemande(depot, theme, maxSortie = MAX_SORTIE, effort = "high") {
  const morceaux = theme.morceaux.map((n) => construireMorceau(depot, n));
  const code = morceaux.map((m) => m.contenu).join("\n\n");
  const texte = `Voici le code à auditer (lecture seule ; chaque ligne est précédée de son numéro).\n\n${code}\n\nTHÈME DE CET AUDIT : ${theme.titre}\n${theme.consigne}`;
  return {
    morceaux,
    caracteres: SYSTEME.length + texte.length,
    params: {
      model: MODELE,
      max_tokens: maxSortie,
      thinking: { type: "adaptive" },
      output_config: { effort },
      system: SYSTEME,
      messages: [{ role: "user", content: texte }],
    },
  };
}

function dollars(x) { return `${x.toFixed(2).replace(".", ",")} $`; }

function estimer(demande, ratio) {
  const entree = Math.ceil(demande.caracteres / ratio);
  const maxi = (entree * PRIX.entree + demande.params.max_tokens * PRIX.sortie) / 1e6;
  const probable = (entree * PRIX.entree + Math.min(demande.params.max_tokens, 15000) * PRIX.sortie) / 1e6;
  return { entree, maxi, probable };
}

function coutReel(u) {
  return ((u.input_tokens || 0) * PRIX.entree + (u.output_tokens || 0) * PRIX.sortie
    + (u.cache_creation_input_tokens || 0) * PRIX.ecritureCache + (u.cache_read_input_tokens || 0) * PRIX.lectureCache) / 1e6;
}

function client() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Clé manquante. Dans PowerShell : $env:ANTHROPIC_API_KEY=\"sk-ant-…\" (la clé n'est gardée que dans cette fenêtre).");
    process.exit(1);
  }
  return new Anthropic();
}

function choisirThemes(noms) {
  if (noms.length === 0 || noms.includes("tout")) return THEMES;
  const inconnus = noms.filter((n) => !THEMES.some((t) => t.id === n));
  if (inconnus.length) { console.error(`Thème inconnu : ${inconnus.join(", ")}. Thèmes : ${THEMES.map((t) => t.id).join(", ")}, tout.`); process.exit(1); }
  return THEMES.filter((t) => noms.includes(t.id));
}

function afficherEstimation(o, themes) {
  recupererBranches(o.depot);
  const etat = lireEtat();
  const ratio = etat.caracteresParJeton || CARACTERES_PAR_JETON_DEFAUT;
  console.log(`\nEstimation (${etat.caracteresParJeton ? `rapport mesuré par l'essai : ${ratio.toFixed(2)} caractères/jeton` : "rapport prudent 3 caractères/jeton, pas encore mesuré"}) :`);
  let totMax = 0, totProb = 0;
  const demandes = [];
  for (const t of themes) {
    const d = construireDemande(o.depot, t);
    const e = estimer(d, ratio);
    totMax += e.maxi; totProb += e.probable;
    demandes.push({ theme: t, demande: d });
    console.log(`  ${t.id.padEnd(14)} ~${Math.round(e.entree / 1000)} k jetons lus  ->  probable ${dollars(e.probable)}, maximum ${dollars(e.maxi)}`);
  }
  console.log(`  TOTAL : probable ${dollars(totProb)}, maximum ${dollars(totMax)}`);
  const vus = new Set();
  for (const { demande } of demandes) for (const m of demande.morceaux) {
    if (vus.has(m.nom)) continue; vus.add(m.nom);
    console.log(`  - ${m.nom} : ${m.nbFichiers} fichiers (${m.ref} ${m.sha})${m.lignesMasquees ? `, ${m.lignesMasquees} ligne(s) masquée(s)` : ""}${m.ecartes.length ? `, écartés : ${m.ecartes.join(" ; ")}` : ""}`);
  }
  return { demandes, totMax, totProb };
}

// ---------------------------------------------------------------- commandes
async function cmdEstimer(o) { afficherEstimation(o, choisirThemes(o.reste)); }

async function cmdEssai(o) {
  recupererBranches(o.depot);
  // Mini-audit des règles Firestore uniquement : quelques milliers de jetons, effort bas, sortie plafonnée.
  const theme = { id: "essai", titre: "Essai (règles Firestore seulement)", morceaux: [], consigne: "Donne au plus 3 problèmes, en 15 lignes maximum." };
  const ref = BRANCHES.dlattc;
  const texte = git(o.depot, ["show", `${ref}:firestore.rules`]);
  const contenu = `Voici le fichier dlattc:firestore.rules (lecture seule).\n\n${texte.split("\n").map((l, i) => `${i + 1}| ${MOTIFS_SECRETS.some((r) => r.test(l)) ? "[LIGNE RETIRÉE]" : l}`).join("\n")}\n\nTHÈME : ${theme.titre}\n${theme.consigne}`;
  const params = { model: MODELE, max_tokens: 3000, thinking: { type: "adaptive" }, output_config: { effort: "low" }, system: SYSTEME, messages: [{ role: "user", content: contenu }] };
  const caracteres = SYSTEME.length + contenu.length;
  const e = estimer({ caracteres, params }, CARACTERES_PAR_JETON_DEFAUT);
  console.log(`Essai : ~${Math.round(e.entree / 1000)} k jetons lus, 3 000 jetons écrits au maximum -> maximum ${dollars(e.maxi)}.`);
  if (e.maxi > 0.10) { console.error("Plus de 0,10 $ : essai annulé."); process.exit(1); }
  const lot = await client().messages.batches.create({ requests: [{ custom_id: "essai", params }] });
  const etat = lireEtat();
  etat.lots.push({ id: lot.id, cree: new Date().toISOString(), themes: ["essai"], essai: true, caracteres: { essai: caracteres }, shas: { dlattc: git(o.depot, ["rev-parse", "--short", ref]).trim() }, recupere: false });
  ecrireEtat(etat);
  console.log(`Lot envoyé : ${lot.id}. Dans quelques minutes : node audit.mjs suivre`);
}

async function cmdLancer(o) {
  const themes = choisirThemes(o.reste);
  if (o.reste.length === 0) { console.error("Donne au moins un thème (ou « tout »)."); process.exit(1); }
  const etat = lireEtat();
  if (!etat.lots.some((l) => l.essai && l.recupere)) { console.error("Fais d'abord l'essai (node audit.mjs essai puis suivre) et vérifie la facturation."); process.exit(1); }
  const { demandes, totMax } = afficherEstimation(o, themes);
  if (!o.oui) { console.log(`\nRien n'est envoyé. Pour lancer : node audit.mjs lancer ${o.reste.join(" ")} --oui`); return; }
  if (totMax > o.plafond) { console.error(`\nMaximum ${dollars(totMax)} au-dessus du plafond ${dollars(o.plafond)} : rien n'est envoyé (option --plafond pour le relever).`); process.exit(1); }
  const lot = await client().messages.batches.create({ requests: demandes.map(({ theme, demande }) => ({ custom_id: theme.id, params: demande.params })) });
  const shas = {};
  for (const { demande } of demandes) for (const m of demande.morceaux) shas[m.ref] = m.sha;
  etat.lots.push({ id: lot.id, cree: new Date().toISOString(), themes: themes.map((t) => t.id), caracteres: Object.fromEntries(demandes.map(({ theme, demande }) => [theme.id, demande.caracteres])), shas, maximum: totMax, recupere: false });
  ecrireEtat(etat);
  console.log(`\nLot envoyé : ${lot.id} (${themes.length} rapport(s)). En général moins d'une heure, 24 h au plus. Ensuite : node audit.mjs suivre`);
}

async function cmdSuivre() {
  const etat = lireEtat();
  const enCours = etat.lots.filter((l) => !l.recupere);
  if (!enCours.length) { console.log("Aucun lot en attente."); return; }
  const c = client();
  fs.mkdirSync(RAPPORTS, { recursive: true });
  for (const l of enCours) {
    const lot = await c.messages.batches.retrieve(l.id);
    const n = lot.request_counts;
    if (lot.processing_status !== "ended") {
      console.log(`${l.id} (${l.themes.join(", ")}) : en cours — ${n.processing} en traitement, ${n.succeeded} fini(s).`);
      continue;
    }
    let total = 0;
    const jour = l.cree.slice(0, 10);
    for await (const r of await c.messages.batches.results(l.id)) {
      const id = r.custom_id;
      if (r.result.type !== "succeeded") {
        console.log(`  ${id} : ${r.result.type}${r.result.error ? ` (${JSON.stringify(r.result.error)})` : ""} — non facturé, à relancer.`);
        continue;
      }
      const m = r.result.message;
      const u = m.usage;
      const cout = coutReel(u);
      total += cout;
      const texte = m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n\n");
      const alerte = m.stop_reason === "max_tokens" ? "\n\n> ⚠ Rapport coupé (limite de longueur atteinte).\n"
        : m.stop_reason === "refusal" ? `\n\n> ⚠ Le modèle a refusé de répondre (${JSON.stringify(m.stop_details)}).\n` : "";
      const entete = `# Audit ${id} — ${jour}\n\nModèle ${m.model}, lot ${l.id}. Code : ${Object.entries(l.shas).map(([b, s]) => `${b} ${s}`).join(", ")}.\nJetons : ${u.input_tokens} lus, ${u.output_tokens} écrits (réflexion comprise). Coût calculé : ${dollars(cout)}.${alerte}\n\n---\n\n`;
      const fichier = path.join(RAPPORTS, `${jour}-${id}.md`);
      fs.writeFileSync(fichier, entete + texte + "\n");
      console.log(`  ${id} : ${fichier} — ${u.input_tokens} jetons lus, ${u.output_tokens} écrits, ${dollars(cout)}`);
      if (l.caracteres && l.caracteres[id] && u.input_tokens) {
        const ratio = l.caracteres[id] / u.input_tokens;
        etat.caracteresParJeton = Math.min(ratio, etat.caracteresParJeton || Infinity);
      }
      fs.appendFileSync(path.join(RAPPORTS, "couts.csv"), `${new Date().toISOString()};${l.id};${id};${u.input_tokens};${u.output_tokens};${cout.toFixed(4)}\n`);
    }
    l.recupere = true;
    l.cout = total;
    console.log(`${l.id} terminé : coût calculé ${dollars(total)}.${l.essai ? "\n>>> Vérifie maintenant dans console.anthropic.com > Billing que c'est le CRÉDIT PROMO qui a baissé (pas ton solde payé). La mise à jour peut prendre quelques minutes." : ""}`);
  }
  ecrireEtat(etat);
}

async function cmdAnnuler(o) {
  const id = o.reste[0];
  if (!id) { console.error("Donne l'identifiant du lot (msgbatch_…)."); process.exit(1); }
  const r = await client().messages.batches.cancel(id);
  console.log(`${id} : ${r.processing_status}. Les demandes déjà finies restent facturées ; lance « suivre » pour les récupérer.`);
}

const [commande, ...reste] = process.argv.slice(2);
const o = options(reste);
const commandes = { estimer: cmdEstimer, essai: cmdEssai, lancer: cmdLancer, suivre: cmdSuivre, annuler: cmdAnnuler };
if (!commandes[commande]) {
  console.log("Commandes : estimer [thème…] | essai | lancer <thème…> [--oui] | suivre | annuler <id>\nThèmes : " + THEMES.map((t) => t.id).join(", ") + ", tout");
  process.exit(commande ? 1 : 0);
}
try { await commandes[commande](o); }
catch (err) {
  if (err instanceof Anthropic.AuthenticationError) console.error("Clé refusée (401) : vérifie ANTHROPIC_API_KEY.");
  else if (err instanceof Anthropic.PermissionDeniedError) console.error(`Accès refusé (403) : ${err.message}`);
  else if (err instanceof Anthropic.RateLimitError) console.error("Trop de demandes (429) : réessaie dans une minute.");
  else if (err instanceof Anthropic.APIError) console.error(`Erreur de l'API (${err.status}) : ${err.message}`);
  else console.error(err.message || err);
  process.exit(1);
}
