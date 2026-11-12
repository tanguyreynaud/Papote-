// Code d'installation d'une tablette de remplacement (audit 8, R2 ; décision de Tanguy du 12/11 à 14 h 24) :
// le code sert UNE fois et expire au bout de 7 jours. Avant, il restait valable sans fin et deux tablettes (ou
// deux comptes quelconques) pouvaient entrer avec lui et lire toute la famille.
//
//   invites/{code}             -> { fid, kind: 'tablette', createdBy, creeLe, expire,
//                                   usedBy?, callsUid?, usedAt? }  usedBy… : posés par la tablette qui entre
//   codesRemplacement/{fid}    -> { code, creeLe, expire, par }    dernier code préparé, serveur seulement
//
// Seul le serveur crée ces codes (gestionCodeRemplacement, depuis l'admin). La tablette prend le code dans la
// même écriture que sa fiche membre (firestore.rules : invites update + members create) : une deuxième tablette est
// refusée, la même tablette qui réessaie après une coupure repasse (même compte). Son compte des appels entre ensuite
// avec le même code (callsUid noté par la tablette au moment de le prendre).

const { Timestamp } = require('firebase-admin/firestore');

const DUREE_MS = 7 * 24 * 3600 * 1000;
// Double appui sur « Nouveau code » : dans la minute, le code tout juste créé (pas encore pris) est rendu tel quel.
const DOUBLE_APPUI_MS = 60 * 1000;

const ms = (v) => (v == null ? null : typeof v === 'number' ? v : v.toMillis ? v.toMillis() : null);

// État d'un code : 'utilise', 'expire', 'valable' ou 'absent'.
function etatCode(invite, maintenant) {
  if (!invite) return 'absent';
  if (invite.usedBy) return 'utilise';
  if (!(ms(invite.expire) > maintenant)) return 'expire';
  return 'valable';
}

function resume(code, invite, maintenant) {
  if (!code || !invite) return { code: null, etat: 'absent' };
  return {
    code, etat: etatCode(invite, maintenant),
    creeLe: ms(invite.creeLe), expire: ms(invite.expire), utiliseLe: ms(invite.usedAt),
  };
}

// db : Firestore (admin). codeAuHasard : 8 caractères sans lettres ambiguës (installation.js).
function brancher({ db, codeAuHasard }) {
  const suiviDe = (fid) => db().doc(`codesRemplacement/${fid}`);

  async function lire(fid, maintenant = Date.now()) {
    const suivi = await suiviDe(fid).get();
    const code = suivi.exists ? suivi.get('code') : null;
    const invite = code ? await db().doc(`invites/${code}`).get() : null;
    return resume(code, invite && invite.exists ? invite.data() : null, maintenant);
  }

  // Nouveau code : l'ancien, s'il n'a pas servi, ne marche plus (effacé), comme les codes de tablette d'avant le
  // 12/11 (sans échéance) restés libres. Un code déjà pris est gardé : il prouve le compte des appels de la tablette.
  async function nouveau(fid, { uid, qui }, maintenant = Date.now()) {
    const famille = await db().doc(`families/${fid}`).get();
    if (!famille.exists) return null;
    return db().runTransaction(async (tx) => {
      const suivi = await tx.get(suiviDe(fid));
      const ancien = suivi.exists ? suivi.get('code') : null;
      const inviteAncien = ancien ? await tx.get(db().doc(`invites/${ancien}`)) : null;
      const libres = await tx.get(db().collection('invites').where('fid', '==', fid).where('kind', '==', 'tablette'));
      const a = inviteAncien && inviteAncien.exists ? inviteAncien.data() : null;
      if (a && etatCode(a, maintenant) === 'valable' && ms(a.creeLe) > maintenant - DOUBLE_APPUI_MS) {
        return { ...resume(ancien, a, maintenant), deja: true };
      }
      let code = codeAuHasard();
      for (let i = 0; i < 5 && (await tx.get(db().doc(`invites/${code}`))).exists; i++) code = codeAuHasard();
      for (const d of libres.docs) if (!d.get('usedBy')) tx.delete(d.ref);
      const creeLe = Timestamp.fromMillis(maintenant);
      const expire = Timestamp.fromMillis(maintenant + DUREE_MS);
      tx.set(db().doc(`invites/${code}`), { fid, kind: 'tablette', createdBy: uid, creeLe, expire });
      tx.set(suiviDe(fid), { code, creeLe, expire, par: qui });
      return { code, etat: 'valable', creeLe: maintenant, expire: maintenant + DUREE_MS, utiliseLe: null, deja: false };
    });
  }

  // Famille effacée : ses codes de tablette et leur suivi partent avec elle.
  async function effacer(fid) {
    const codes = await db().collection('invites').where('fid', '==', fid).where('kind', '==', 'tablette').get();
    await Promise.all([...codes.docs.map((d) => d.ref.delete()), suiviDe(fid).delete()]);
  }

  return { lire, nouveau, effacer };
}

module.exports = { brancher, etatCode, DUREE_MS, DOUBLE_APPUI_MS };
